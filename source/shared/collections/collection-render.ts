import katex from "katex";
import MarkdownIt from "markdown-it";

/**
 * Pure HTML rendering for saved collection messages.
 *
 * The same builder serves the Collections page (which resolves media through
 * sand-media:// URLs) and the standalone HTML exporter (which resolves media
 * to data: URIs, or to a placeholder chip when a file is too large). Nothing
 * here touches the DOM or Node, so it bundles for both surfaces.
 *
 * Everything that reaches the output is escaped exactly once, at the moment it
 * is interpolated. A collection can hold text an agent never authored, so a
 * "<script>" in a message body must stay inert text in both surfaces.
 */

export interface CollectionRenderMedia {
  readonly srcPath: string;
  readonly mime?: string | undefined;
}

export interface CollectionRenderMessage {
  readonly key: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly entryId: string;
  readonly addedAtMs: number;
  readonly entry: Readonly<Record<string, unknown>>;
  readonly media: readonly CollectionRenderMedia[];
}

export interface CollectionRenderOptions {
  /** Resolves one media reference to a src attribute value, or null for a placeholder chip. */
  readonly mediaSrc: (media: CollectionRenderMedia) => string | null;
  readonly formatTimestamp: (timestampMs: number | undefined) => string;
  /** Emits the per-message hover actions; the exporter leaves this out. */
  readonly withActions?: boolean;
  /** Adds the "copy into Bookmarks" action; the Bookmarks view itself omits it. */
  readonly withPromote?: boolean;
}

const IMAGE_EXTENSIONS = ["avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"];
const VIDEO_EXTENSIONS = ["mov", "mp4", "m4v", "webm", "mkv", "avi"];
const MAX_MEDIA_WIDTH_PX = 360;

export function escapeCollectionHtml(value: string): string {
  let escaped = "";
  for (const character of value) {
    escaped += character === "&" ? "&amp;"
      : character === "<" ? "&lt;"
        : character === ">" ? "&gt;"
          : character === '"' ? "&quot;"
            : character === "'" ? "&#39;"
              : character;
  }
  return escaped;
}

function extensionOf(path: string): string {
  const leaf = path.split("?")[0]?.split("#")[0] ?? path;
  const dot = leaf.lastIndexOf(".");
  return dot < 0 ? "" : leaf.slice(dot + 1).toLowerCase();
}

export function collectionMediaKind(media: CollectionRenderMedia): "image" | "video" | "file" {
  const mime = media.mime?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  const extension = extensionOf(media.srcPath);
  if (IMAGE_EXTENSIONS.includes(extension)) return "image";
  if (VIDEO_EXTENSIONS.includes(extension)) return "video";
  return "file";
}

export function collectionMediaName(srcPath: string): string {
  const leaf = srcPath.replaceAll("\\", "/").split("/").filter((segment) => segment.length > 0).at(-1);
  return leaf != null && leaf.length > 0 ? leaf : "Attachment";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** User-authored rows go right/accent; everything else reads as the agent side. */
export function collectionMessageRole(entry: Readonly<Record<string, unknown>>): "user" | "agent" {
  const kind = readString(entry.kind);
  if (kind === "user-attachment") return "user";
  if (kind === "message") return entry.role === "user" ? "user" : "agent";
  return "agent";
}

export function collectionMessageText(entry: Readonly<Record<string, unknown>>): string {
  const kind = readString(entry.kind);
  if (kind === "message") return readString(entry.content);
  if (kind === "send-message") {
    const message = entry.message;
    if (isRecord(message) && message.type === "text") return readString(message.content);
    return "";
  }
  if (kind === "user-attachment") return "";
  return readString(entry.content);
}

export function collectionMessageTimestampMs(entry: Readonly<Record<string, unknown>>): number | undefined {
  return typeof entry.timestampMs === "number" && Number.isFinite(entry.timestampMs) ? entry.timestampMs : undefined;
}

/**
 * Markdown and math, rendered the way the chat renders them.
 *
 * The archive used to print its source: `**bold**`, `1.` markers and `$$\\frac12$$` all reached
 * the page as text, while the same entry in the chat came out set. Same text, so the renderer
 * was the only difference. This is that renderer, for both the window and the export.
 *
 * `html: false` means a message body can never introduce markup: a "<script>" an agent was
 * asked to write stays visible text in the window, in the HTML export and in the PDF.
 *
 * Math follows the chat's rules exactly (scripts/lib/vendor/sand-math-kit.js): `\\(…\\)` and
 * `\\[…\\]` are rewritten to `$$…$$` outside code, a single `$` is never math (so "$5 and $6"
 * stays money), and KaTeX renders MathML — no stylesheet, no font files, nothing to load.
 */
const DISPLAY_TEX = /\\\[([\s\S]+?)\\\]/g;
const INLINE_TEX = /\\\((.+?)\\\)/g;
const CODE_SPANS = /(```[\s\S]*?```|`[^`\n]*`)/;

/** Rewrites the LLM's bracket forms to `$$` forms, leaving fenced and inline code alone. */
export function normalizeCollectionMath(text: string): string {
  const parts = text.split(CODE_SPANS);
  for (let index = 0; index < parts.length; index += 2) {
    const part = parts[index];
    if (part == null) continue;
    parts[index] = part.replace(DISPLAY_TEX, (_match, tex: string) => `$$${tex}$$`).replace(INLINE_TEX, (_match, tex: string) => `$$${tex}$$`);
  }
  return parts.join("");
}

function renderTex(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex.trim(), { output: "mathml", displayMode: display, throwOnError: false, strict: false });
  } catch {
    // Unrenderable math is shown as what it was, never as an empty gap.
    return `<code>${escapeCollectionHtml(display ? `$$${tex}$$` : tex)}</code>`;
  }
}

/** `$$…$$` as a block of its own, and inline inside a paragraph. */
function mathPlugin(md: MarkdownIt): void {
  md.block.ruler.before("fence", "sand_math_block", (state, startLine, endLine, silent) => {
    const start = state.bMarks[startLine]! + state.tShift[startLine]!;
    const max = state.eMarks[startLine]!;
    if (state.src.slice(start, start + 2) !== "$$") return false;
    let line = startLine;
    let body = state.src.slice(start + 2, max);
    if (!body.trimEnd().endsWith("$$") || body.trim() === "$$") {
      for (line = startLine + 1; line <= endLine; line += 1) {
        const from = state.bMarks[line]! + state.tShift[line]!;
        const to = state.eMarks[line]!;
        body += `\n${state.src.slice(from, to)}`;
        if (state.src.slice(from, to).trimEnd().endsWith("$$")) break;
      }
      if (line > endLine) return false;
    }
    if (silent) return true;
    const tex = body.trimEnd().replace(/\$\$$/, "");
    const token = state.push("sand_math_block", "", 0);
    token.content = tex;
    token.map = [startLine, line + 1];
    state.line = line + 1;
    return true;
  });
  md.inline.ruler.before("escape", "sand_math_inline", (state, silent) => {
    if (state.src.slice(state.pos, state.pos + 2) !== "$$") return false;
    const close = state.src.indexOf("$$", state.pos + 2);
    if (close < 0) return false;
    const tex = state.src.slice(state.pos + 2, close);
    if (tex.trim().length === 0) return false;
    if (!silent) {
      const token = state.push("sand_math_inline", "", 0);
      token.content = tex;
    }
    state.pos = close + 2;
    return true;
  });
  md.renderer.rules.sand_math_block = (tokens, index) => `<div class="sand-col-math">${renderTex(tokens[index]!.content, true)}</div>`;
  md.renderer.rules.sand_math_inline = (tokens, index) => renderTex(tokens[index]!.content, false);
}

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });
mathPlugin(markdown);
markdown.renderer.rules.fence = (tokens, index) => `<pre class="sand-col-code"><code>${escapeCollectionHtml(tokens[index]!.content.replace(/\n$/, ""))}</code></pre>`;
markdown.renderer.rules.code_block = markdown.renderer.rules.fence;
const defaultLink = markdown.renderer.rules.link_open ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  // Anything a message links to is somebody else's; it opens with no referrer and no opener.
  tokens[index]!.attrSet("rel", "noreferrer noopener");
  return defaultLink(tokens, index, options, env, self);
};

/** The whole message body, set as the chat sets it. */
export function renderCollectionText(text: string): string {
  if (text.length === 0) return "";
  return markdown.render(normalizeCollectionMath(text)).trim();
}

function renderMedia(media: readonly CollectionRenderMedia[], options: CollectionRenderOptions): string {
  if (media.length === 0) return "";
  let html = "";
  for (const item of media) {
    const kind = collectionMediaKind(item);
    const src = options.mediaSrc(item);
    const name = escapeCollectionHtml(collectionMediaName(item.srcPath));
    if (src == null) {
      html += `<span class="sand-col-chip sand-col-chip-media">${name}</span>`;
      continue;
    }
    const escapedSrc = escapeCollectionHtml(src);
    if (kind === "image") {
      html += `<img class="sand-col-image" src="${escapedSrc}" alt="${name}" loading="lazy">`;
      continue;
    }
    if (kind === "video") {
      // v1 never plays video: a poster-style block keeps the export inert and
      // the page free of a media pipeline.
      html += `<div class="sand-col-video"><span class="sand-col-video-glyph" aria-hidden="true"></span><span class="sand-col-video-name">${name}</span></div>`;
      continue;
    }
    html += `<span class="sand-col-chip sand-col-chip-media">${name}</span>`;
  }
  return `<div class="sand-col-media" style="max-width:${MAX_MEDIA_WIDTH_PX}px">${html}</div>`;
}

function renderUnknownKind(entry: Readonly<Record<string, unknown>>): string {
  const kind = readString(entry.kind);
  return `<span class="sand-col-chip">${escapeCollectionHtml(kind.length > 0 ? kind : "entry")}</span>`;
}

export function renderCollectionMessage(message: CollectionRenderMessage, options: CollectionRenderOptions): string {
  const role = collectionMessageRole(message.entry);
  const text = collectionMessageText(message.entry);
  const media = renderMedia(message.media, options);
  const body = renderCollectionText(text) + media;
  const kind = readString(message.entry.kind);
  const known = kind === "message" || kind === "send-message" || kind === "user-attachment";
  const content = body.length > 0 ? body : known ? "" : renderUnknownKind(message.entry);
  const stamp = options.formatTimestamp(collectionMessageTimestampMs(message.entry) ?? message.addedAtMs);
  const actions = options.withActions === true
    ? "<div class=\"sand-col-actions\">"
      + "<button type=\"button\" data-collection-action=\"open\">Open original</button>"
      + (options.withPromote === true
        ? "<button type=\"button\" data-collection-action=\"bookmark\" title=\"Copy into Bookmarks\">☆ Bookmark</button>"
        : "")
      + "<button type=\"button\" data-collection-action=\"remove\">Remove</button>"
      + "</div>"
    : "";
  return `<article class="sand-col-msg sand-col-${role}" data-collection-key="${escapeCollectionHtml(message.key)}">`
    + `<header class="sand-col-head"><span class="sand-col-who">${escapeCollectionHtml(message.agentName)}</span>`
    + `<span class="sand-col-when">${escapeCollectionHtml(stamp)}</span></header>`
    + `<div class="sand-col-bubble">${content}</div>${actions}</article>`;
}

export function renderCollectionMessages(
  messages: readonly CollectionRenderMessage[],
  options: CollectionRenderOptions,
): string {
  return messages.map((message) => renderCollectionMessage(message, options)).join("");
}

/**
 * Bubble styling lives beside the renderer so the page and the self-contained
 * export cannot drift apart.
 */
export const COLLECTION_BUBBLE_CSS = `
.sand-col-thread{display:flex;flex-direction:column;gap:14px;padding:18px 20px 40px}
.sand-col-msg{display:flex;flex-direction:column;gap:4px;max-width:min(640px,86%);position:relative}
.sand-col-msg.sand-col-user{align-self:flex-end;align-items:flex-end}
.sand-col-msg.sand-col-agent{align-self:flex-start;align-items:flex-start}
.sand-col-head{display:flex;gap:8px;align-items:baseline;font-size:11px;opacity:.62;padding:0 4px}
.sand-col-who{font-weight:600}
.sand-col-bubble{border-radius:18px;padding:8px 12px;background:var(--sand-col-agent-bg);color:var(--sand-col-agent-fg);overflow-wrap:anywhere;line-height:1.45;font-size:14px}
.sand-col-user .sand-col-bubble{background:var(--sand-col-user-bg);color:var(--sand-col-user-fg)}
.sand-col-bubble:empty{display:none}
.sand-col-bubble p{margin:0 0 8px}
.sand-col-bubble>*:last-child{margin-bottom:0}
.sand-col-bubble a{color:inherit}
.sand-col-bubble h1,.sand-col-bubble h2,.sand-col-bubble h3,.sand-col-bubble h4{margin:10px 0 6px;font-size:1.05em;line-height:1.25}
.sand-col-bubble h1:first-child,.sand-col-bubble h2:first-child,.sand-col-bubble h3:first-child{margin-top:0}
.sand-col-bubble ul,.sand-col-bubble ol{margin:0 0 8px;padding-left:1.35em}
.sand-col-bubble li{margin:2px 0}
.sand-col-bubble li>p{margin:0}
.sand-col-bubble code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em;background:var(--sand-col-code-bg);padding:.1em .35em;border-radius:5px}
.sand-col-bubble pre code{background:none;padding:0;font-size:1em}
.sand-col-bubble blockquote{margin:0 0 8px;padding-left:.8em;border-left:2px solid var(--sand-col-chip-border);opacity:.85}
.sand-col-bubble hr{border:0;border-top:1px solid var(--sand-col-chip-border);margin:10px 0}
.sand-col-table-wrap,.sand-col-bubble table{display:block;max-width:100%;overflow-x:auto}
.sand-col-bubble table{border-collapse:collapse;margin:0 0 8px;font-size:.95em}
.sand-col-bubble th,.sand-col-bubble td{border:1px solid var(--sand-col-chip-border);padding:4px 8px;text-align:left}
.sand-col-bubble th{font-weight:600}
.sand-col-math{margin:6px 0;overflow-x:auto}
.sand-col-bubble .katex{font-size:1.05em;line-height:normal}
.sand-col-bubble .katex .katex-html{display:none}
.sand-col-code{margin:0 0 8px;padding:10px 12px;border-radius:10px;background:var(--sand-col-code-bg);overflow-x:auto;font-size:12.5px;line-height:1.45}
.sand-col-code:last-child{margin-bottom:0}
.sand-col-code code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre}
.sand-col-media{display:flex;flex-wrap:wrap;gap:8px;margin-top:2px}
.sand-col-image{display:block;max-width:${MAX_MEDIA_WIDTH_PX}px;width:auto;height:auto;border-radius:10px}
.sand-col-video{display:flex;align-items:center;gap:8px;padding:14px 16px;border-radius:10px;background:var(--sand-col-code-bg);font-size:12.5px}
.sand-col-video-glyph{width:0;height:0;border-style:solid;border-width:7px 0 7px 12px;border-color:transparent transparent transparent currentColor;opacity:.75}
.sand-col-chip{display:inline-block;padding:3px 9px;border-radius:999px;border:1px solid var(--sand-col-chip-border);font-size:11.5px;opacity:.8}
.sand-col-actions{display:none;gap:6px;padding:0 4px}
.sand-col-msg:hover .sand-col-actions{display:flex}
.sand-col-actions button{font:600 11px system-ui,-apple-system,"Segoe UI",sans-serif;color:inherit;background:transparent;border:1px solid var(--sand-col-chip-border);border-radius:7px;padding:3px 8px;cursor:pointer;opacity:.75}
.sand-col-actions button:hover{opacity:1}
.sand-col-empty{opacity:.6;font-size:13px;padding:24px 20px}
`;

/**
 * One theme per file, chosen when you export — not `prefers-color-scheme`.
 *
 * The export used to ship both palettes and let the reader's machine pick, so a collection
 * exported from the dark app opened as dark bubbles on a white page. A saved file should look
 * like what it was saved from, on any machine, and the PDF has no reader to ask.
 */
export type CollectionExportTheme = "dark" | "light";

const EXPORT_THEME_CSS: Record<CollectionExportTheme, string> = {
  light: ":root{color-scheme:light;--sand-col-agent-bg:#ededed;--sand-col-agent-fg:#0d0d0d;--sand-col-user-bg:#d6d6d6;--sand-col-user-fg:#0d0d0d;--sand-col-code-bg:rgba(0,0,0,.06);--sand-col-chip-border:rgba(0,0,0,.2)}\nbody{background:#fff;color:#0d0d0d}",
  dark: ":root{color-scheme:dark;--sand-col-agent-bg:#262626;--sand-col-agent-fg:#fcfcfc;--sand-col-user-bg:#5a5a5a;--sand-col-user-fg:#fcfcfc;--sand-col-code-bg:rgba(255,255,255,.08);--sand-col-chip-border:rgba(255,255,255,.22)}\nbody{background:#070707;color:#fcfcfc}",
};

const EXPORT_PAGE_CSS = `
body{margin:0;font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
@media print{body{background:none}.sand-col-msg{break-inside:avoid;page-break-inside:avoid}.sand-col-export-head{break-after:avoid}}
.sand-col-export{max-width:860px;margin:0 auto}
.sand-col-export-head{padding:28px 20px 10px;border-bottom:1px solid var(--sand-col-chip-border)}
.sand-col-export-head h1{margin:0 0 6px;font-size:20px}
.sand-col-export-head p{margin:0;font-size:12px;opacity:.62}
.sand-col-export-foot{padding:18px 20px 36px;font-size:12px;opacity:.62;border-top:1px solid var(--sand-col-chip-border)}
.sand-col-export-foot a{color:inherit}
`;

export interface CollectionExportHtmlInput {
  readonly name: string;
  /** The app's theme at the moment of export; the file carries that one and no other. */
  readonly theme?: CollectionExportTheme;
  readonly messages: readonly CollectionRenderMessage[];
  readonly exportedAt: string;
  readonly permalink: string;
  readonly mediaSrc: (media: CollectionRenderMedia) => string | null;
  readonly formatTimestamp: (timestampMs: number | undefined) => string;
}

/** One self-contained file: inline CSS, zero scripts, media already inlined. */
export function buildCollectionExportHtml(input: CollectionExportHtmlInput): string {
  const name = escapeCollectionHtml(input.name);
  const count = input.messages.length;
  const thread = renderCollectionMessages(input.messages, {
    mediaSrc: input.mediaSrc,
    formatTimestamp: input.formatTimestamp,
  });
  const link = escapeCollectionHtml(input.permalink);
  return "<!doctype html>\n"
    + "<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
    + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
    + `<title>${name}</title>\n`
    + `<style>${EXPORT_THEME_CSS[input.theme ?? "light"]}${EXPORT_PAGE_CSS}${COLLECTION_BUBBLE_CSS}</style>\n`
    + "</head>\n<body>\n<div class=\"sand-col-export\">\n"
    + `<header class="sand-col-export-head"><h1>${name}</h1>`
    + `<p>${count} message${count === 1 ? "" : "s"} · exported ${escapeCollectionHtml(input.exportedAt)}</p></header>\n`
    + `<main class="sand-col-thread">${thread}</main>\n`
    + `<footer class="sand-col-export-foot">Exported from OpenGrok · <a href="${link}">${link}</a></footer>\n`
    + "</div>\n</body>\n</html>\n";
}
