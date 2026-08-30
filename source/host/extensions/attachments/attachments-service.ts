import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { ATTACHMENTS_DIRNAME, ASSETS_DIRNAME, getAgentAssetsDir, getAgentAttachmentsDir } from "../../attachment-paths.js";
import { resolveChannelAttachment } from "../../connectors/channel-attachment.js";
import { uploadBoxFiles } from "../../box/box-transfer.js";
import { getSandRootDir, reanchorSandPath } from "../../host-paths.js";
import { resolveSandAgentDir } from "../../storage/agent-paths.js";
import { isSafeFolderId } from "../../storage/folder-id.js";
import { AttachmentTooLargeError, VIDEO_BYTE_LIMIT, attachmentByteLimitForName } from "../../../shared/media/attachment-limits.js";
import { audioMimeFromPath, extensionFromImageMime, imageMimeFromPath, servableImageMimeFromPath, videoMimeFromPath } from "../../../shared/media/image-mime.js";
import { Mp4Dimensions } from "../../../shared/media/video-dimensions.js";
import { isPathWithin } from "../../../shared/node/paths.js";
import { createSandGenerateImageResourceAccessor } from "./generate-image-resource-accessor.js";
import { createSandGenerateImageService, type GenerateImageAuth } from "./generate-image-service.js";
import { stageAttachmentsIntoBox, type BoxStagingDependencies } from "./box-staging.js";
import { readEncodedImageSize, type ImageSize } from "./link-preview-image-bounds.js";
import { fetchSafeLinkPreviewResource, parseSafeLinkPreviewUrl, SandLinkPreviewError } from "./safe-link-preview-fetch.js";
import { withVideoPlaybackSource } from "./video-playback-rendition.js";

export const LINK_CACHE_DIRNAME = "link-cache";
export const LINK_CACHE_VERSION = 3;
export const LINK_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
export const LINK_HTML_BYTE_LIMIT = 512 * 1024;
export const LINK_IMAGE_BYTE_LIMIT = 2 * 1024 * 1024;
export const LINK_TITLE_CHAR_LIMIT = 512;
export const LINK_DESCRIPTION_CHAR_LIMIT = 2_048;
export const LINK_SITE_NAME_CHAR_LIMIT = 256;
export const LINK_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif", "image/x-icon", "image/vnd.microsoft.icon"]);
export const LINK_IMAGE_ACCEPT = [...LINK_IMAGE_MIME_TYPES].join(",");
export const ATTACHMENT_CHUNK_MAX_BYTES = 8 * 1024 * 1024;
export const ATTACHMENT_TEXT_PREVIEW_BYTE_CAP = 64 * 1024;
export class SandAttachmentError extends Error {}
export interface IngestedAttachment { readonly absolutePath: string; readonly hash: string; readonly bytes: number }
export interface LinkMetadata extends Record<string, unknown> {
  readonly url: string;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly description: string;
  readonly siteName: string;
  readonly hostname: string;
  readonly imageDataUrl: string | null;
  readonly faviconDataUrl: string | null;
  readonly fetchedAt: number;
}
function sha256(input: string | Uint8Array): string { return createHash("sha256").update(input).digest("hex"); }
async function ensureDir(dir: string): Promise<void> { await fs.mkdir(dir, { recursive: true }); }
async function writeContentAddressedFile(dir: string, targetPath: string, buffer: Buffer): Promise<void> { await ensureDir(dir); try { await fs.access(targetPath); } catch { await fs.writeFile(targetPath, buffer); } }

function getLinkCachePath(agentDir: string, url: string): string { return join(agentDir, LINK_CACHE_DIRNAME, `${sha256(url)}.json`); }
async function readCachedLinkMetadata(agentDir: string, url: string): Promise<LinkMetadata | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(getLinkCachePath(agentDir, url), "utf8")) as LinkMetadata & { cacheVersion?: number };
    if (parsed.cacheVersion !== LINK_CACHE_VERSION) return null;
    if (Date.now() - parsed.fetchedAt > LINK_CACHE_TTL_MS) return null;
    return parsed;
  } catch { return null; }
}
async function writeCachedLinkMetadata(agentDir: string, url: string, metadata: LinkMetadata): Promise<void> {
  const entry = { ...metadata, cacheVersion: LINK_CACHE_VERSION };
  const cachePath = getLinkCachePath(agentDir, url);
  await ensureDir(dirname(cachePath));
  await fs.writeFile(cachePath, JSON.stringify(entry, null, 2));
}
async function fetchText(url: string, byteLimit: number): Promise<{ body: string; finalUrl: URL; redirectUrls: URL[]; contentType: string }> {
  const response = await fetchSafeLinkPreviewResource(url, {
    maxBytes: byteLimit,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9",
    truncateAtByteLimit: true,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) throw new SandLinkPreviewError(`HTTP ${response.statusCode} while fetching link preview.`);
  return {
    body: response.body.toString("utf8"),
    finalUrl: parseSafeLinkPreviewUrl(response.finalUrl),
    redirectUrls: response.redirectUrls.map((redirect) => parseSafeLinkPreviewUrl(redirect)),
    contentType: (response.headers["content-type"] ?? "") as string,
  };
}
async function fetchImageAsDataUrl(url: string): Promise<string | null> {
  let response;
  try {
    response = await fetchSafeLinkPreviewResource(url, { maxBytes: LINK_IMAGE_BYTE_LIMIT, accept: LINK_IMAGE_ACCEPT });
  } catch { return null; }
  if (response.statusCode < 200 || response.statusCode >= 300) return null;
  const contentTypeHeader = (response.headers["content-type"] ?? "") as string;
  const mime = contentTypeHeader.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!LINK_IMAGE_MIME_TYPES.has(mime)) return null;
  if (response.body.byteLength === 0 || response.body.byteLength > LINK_IMAGE_BYTE_LIMIT) return null;
  return `data:${mime};base64,${response.body.toString("base64")}`;
}
function decodeHtmlEntities(text: string): string {
  return text.replace(/&(amp|#38);/gi, "&").replace(/&(lt|#60);/gi, "<").replace(/&(gt|#62);/gi, ">").replace(/&(quot|#34);/gi, '"').replace(/&(apos|#39);/gi, "'").replace(/&nbsp;/gi, " ").replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10))).replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}
function cleanLinkMetadataText(text: string, charLimit: number): string { return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, charLimit); }
function matchAttr(tag: string, attr: string): string | undefined {
  const match = new RegExp(`${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  if (match == null) return undefined;
  return match[2] ?? match[3] ?? match[4];
}
function findMeta(html: string, attr: string, value: string): string | undefined {
  const tagPattern = /<meta\b[^>]*>/gi;
  let tag: RegExpExecArray | null;
  while ((tag = tagPattern.exec(html)) != null) {
    const candidate = matchAttr(tag[0], attr);
    if (candidate == null || candidate.toLowerCase() !== value.toLowerCase()) continue;
    const content = matchAttr(tag[0], "content");
    if (content != null) return decodeHtmlEntities(content).trim();
  }
  return undefined;
}
function findFirstLinkHref(html: string, relValues: readonly string[]): string | undefined {
  const tagPattern = /<link\b[^>]*>/gi;
  let tag: RegExpExecArray | null;
  while ((tag = tagPattern.exec(html)) != null) {
    const rel = matchAttr(tag[0], "rel");
    if (rel == null) continue;
    const tokens = rel.toLowerCase().split(/\s+/);
    if (!relValues.some((value) => tokens.includes(value))) continue;
    const href = matchAttr(tag[0], "href");
    if (href != null) return decodeHtmlEntities(href).trim();
  }
  return undefined;
}
function findTitle(html: string): string | undefined { const match = /<title>([^<]*)<\/title>/i.exec(html); return match == null ? undefined : decodeHtmlEntities(match[1] ?? "").trim(); }
function toAbsoluteUrl(href: string, base: string): string | null { try { return parseSafeLinkPreviewUrl(new URL(href, base).toString()).toString(); } catch { return null; } }
function scrapeOpenGraph(html: string, finalUrl: string) {
  const title = findMeta(html, "property", "og:title") ?? findMeta(html, "name", "twitter:title") ?? findTitle(html) ?? "";
  const description = findMeta(html, "property", "og:description") ?? findMeta(html, "name", "description") ?? findMeta(html, "name", "twitter:description") ?? "";
  const siteName = findMeta(html, "property", "og:site_name") ?? findMeta(html, "name", "application-name") ?? "";
  const canonical = findFirstLinkHref(html, ["canonical"]) ?? findMeta(html, "property", "og:url") ?? finalUrl;
  const image = findMeta(html, "property", "og:image") ?? findMeta(html, "property", "og:image:url") ?? findMeta(html, "name", "twitter:image") ?? findMeta(html, "name", "twitter:image:src") ?? null;
  const favicon = findFirstLinkHref(html, ["icon", "shortcut", "apple-touch-icon", "apple-touch-icon-precomposed", "mask-icon"]) ?? null;
  return {
    title: cleanLinkMetadataText(title, LINK_TITLE_CHAR_LIMIT),
    description: cleanLinkMetadataText(description, LINK_DESCRIPTION_CHAR_LIMIT),
    siteName: cleanLinkMetadataText(siteName, LINK_SITE_NAME_CHAR_LIMIT),
    canonicalUrl: toAbsoluteUrl(canonical, finalUrl) ?? finalUrl,
    imageUrl: image == null ? null : toAbsoluteUrl(image, finalUrl),
    faviconUrl: favicon == null ? null : toAbsoluteUrl(favicon, finalUrl),
  };
}
function googleFaviconUrl(hostname: string): string { return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=64`; }
function normalizeUrl(raw: string): URL | null { try { return parseSafeLinkPreviewUrl(raw.trim()); } catch { return null; } }
const AUTHENTICATION_HOSTNAMES = new Set(["accounts.google.com"]);
const AUTHENTICATION_HOST_LABELS = new Set(["auth", "authenticate", "authentication", "authenticator", "idp", "identity", "login", "oauth", "signin", "sso"]);
const AUTHENTICATION_PATH_SEGMENTS = new Set(["auth", "authenticate", "authorize", "login", "saml", "sign-in", "sign_in", "signin", "sso"]);
const NESTED_AUTHENTICATION_PATHS = new Set(["sign-in/identifier", "sign_in/identifier", "signin/identifier"]);
function hasAuthenticationPathSegment(url: URL): boolean {
  try {
    const segments = url.pathname.split("/").filter((segment) => segment.length > 0).map((segment) => decodeURIComponent(segment).toLowerCase());
    const finalSegment = segments.at(-1);
    if (finalSegment != null && AUTHENTICATION_PATH_SEGMENTS.has(finalSegment)) return true;
    return segments.some((segment, index) => NESTED_AUTHENTICATION_PATHS.has(`${segment}/${segments[index + 1] ?? ""}`));
  } catch { return false; }
}
function isAuthenticationDestination(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  if (AUTHENTICATION_HOSTNAMES.has(hostname) || hostname.split(".").some((label) => AUTHENTICATION_HOST_LABELS.has(label))) return true;
  return hasAuthenticationPathSegment(url);
}
export async function fetchLinkMetadata(agentDir: string, rawUrl: string): Promise<LinkMetadata | null> {
  const url = normalizeUrl(rawUrl);
  if (url == null) return null;
  const cached = await readCachedLinkMetadata(agentDir, url.toString());
  if (cached != null) return cached;
  let fetched: Awaited<ReturnType<typeof fetchText>>;
  try { fetched = await fetchText(url.toString(), LINK_HTML_BYTE_LIMIT); } catch { return null; }
  if (fetched.redirectUrls.some(isAuthenticationDestination)) return null;
  const lowerType = fetched.contentType.toLowerCase();
  if (fetched.contentType.length > 0 && !lowerType.includes("html") && !lowerType.includes("xml")) return null;
  const scraped = scrapeOpenGraph(fetched.body, fetched.finalUrl.toString());
  const hostname = fetched.finalUrl.hostname;
  const [imageDataUrl, faviconDataUrl] = await Promise.all([
    scraped.imageUrl == null ? null : fetchImageAsDataUrl(scraped.imageUrl),
    (async () => {
      const direct = scraped.faviconUrl == null ? null : await fetchImageAsDataUrl(scraped.faviconUrl);
      if (direct != null) return direct;
      return await fetchImageAsDataUrl(googleFaviconUrl(hostname));
    })(),
  ]);
  const metadata: LinkMetadata = { url: url.toString(), canonicalUrl: scraped.canonicalUrl, title: scraped.title, description: scraped.description, siteName: scraped.siteName, hostname, imageDataUrl, faviconDataUrl, fetchedAt: Date.now() };
  try { await writeCachedLinkMetadata(agentDir, url.toString(), metadata); } catch {}
  return metadata;
}

export async function ingestAttachment(agentDir: string, sourcePath: string): Promise<IngestedAttachment> {
  if (typeof sourcePath !== "string" || sourcePath.trim().length === 0) throw new SandAttachmentError("Attachment file path is empty.");
  if (!isAbsolute(sourcePath)) throw new SandAttachmentError(`Attachment path must be absolute: ${sourcePath}`);
  const attachmentsDir = getAgentAttachmentsDir(agentDir);
  if (isPathWithin(attachmentsDir, sourcePath, { isInclusive: true })) { const info = await fs.stat(sourcePath); return { absolutePath: sourcePath, hash: "preserved", bytes: info.size }; }
  const info = await fs.stat(sourcePath); if (!info.isFile()) throw new SandAttachmentError(`Attachment source is not a file: ${sourcePath}`);
  const byteLimit = attachmentByteLimitForName(sourcePath); if (info.size > byteLimit) throw new AttachmentTooLargeError(byteLimit);
  return await ingestAttachmentBytes(agentDir, sourcePath, await fs.readFile(sourcePath));
}
export async function ingestAttachmentBytes(agentDir: string, filename: string, data: Uint8Array): Promise<IngestedAttachment> {
  if (typeof filename !== "string" || filename.trim().length === 0) throw new SandAttachmentError("Attachment filename is empty.");
  if (data.byteLength === 0) throw new SandAttachmentError("Attachment is empty.");
  const byteLimit = attachmentByteLimitForName(filename); if (data.byteLength > byteLimit) throw new AttachmentTooLargeError(byteLimit);
  const buffer = Buffer.from(data), hash = sha256(buffer), sourceExt = extname(filename).toLowerCase(), targetPath = join(getAgentAttachmentsDir(agentDir), `${hash}${sourceExt.length > 0 ? sourceExt : ".bin"}`);
  await writeContentAddressedFile(getAgentAttachmentsDir(agentDir), targetPath, buffer); return { absolutePath: targetPath, hash, bytes: buffer.byteLength };
}
function imageSize(buffer: Buffer, mime: string): ImageSize | null { return readEncodedImageSize(`data:${mime};base64,${buffer.toString("base64")}`); }
export async function readHostAttachmentImage(filePath: string) { const resolved = reanchorSandPath(filePath); if (!filePath || !isPathWithin(getSandRootDir(), resolved)) return null; const mime = servableImageMimeFromPath(resolved); if (mime == null) return null; try { const data = await fs.readFile(resolved), size = imageSize(data, mime); return { dataUrl: `data:${mime};base64,${data.toString("base64")}`, width: size?.width ?? null, height: size?.height ?? null }; } catch { return null; } }
export async function readHostAttachmentVideoBytes(filePath: string): Promise<Uint8Array | null> { const resolved = reanchorSandPath(filePath); if (!filePath || !isPathWithin(getSandRootDir(), resolved) || videoMimeFromPath(resolved) === undefined) return null; try { const info = await fs.stat(resolved); return !info.isFile() || info.size > VIDEO_BYTE_LIMIT ? null : new Uint8Array(await fs.readFile(resolved)); } catch { return null; } }
export async function readHostAttachmentChunk(agentDir: string, filePath: string, offset: number, length: number, videoPlayback = false) {
  if (!filePath) return null; const source = reanchorSandPath(filePath);
  if (!isPathWithin(getAgentAttachmentsDir(agentDir), source) && !isPathWithin(getAgentAssetsDir(agentDir), source)) return null;
  if (videoPlayback && videoMimeFromPath(source) == null) return null;
  const read = async (resolved: string) => { const info = await fs.stat(resolved); if (!info.isFile()) return null; const totalSize = info.size, mime = imageMimeFromPath(resolved) ?? videoMimeFromPath(resolved) ?? audioMimeFromPath(resolved) ?? null, start = Math.min(Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0, totalSize), safeLength = Number.isFinite(length) ? Math.max(0, Math.floor(length)) : 0, len = Math.min(safeLength, ATTACHMENT_CHUNK_MAX_BYTES, totalSize - start); if (len <= 0) return { bytesBase64: "", totalSize, mime }; const handle = await fs.open(resolved, "r"); try { const buffer = Buffer.alloc(len), { bytesRead } = await handle.read(buffer, 0, len, start); return { bytesBase64: buffer.subarray(0, bytesRead).toString("base64"), totalSize, mime }; } finally { await handle.close(); } };
  try { return videoPlayback ? await withVideoPlaybackSource(source, read) : await read(source); } catch { return null; }
}
export function resolveAttachmentOwnerDir(filePath: string): string | null { if (!filePath) return null; const resolved = reanchorSandPath(filePath), agentsRoot = join(getSandRootDir(), "agents"); if (!isPathWithin(agentsRoot, resolved)) return null; const segments = relative(agentsRoot, resolved).split(sep), agentId = segments[0], bucket = segments[1]; return segments.length >= 3 && isSafeFolderId(agentId) && (bucket === ATTACHMENTS_DIRNAME || bucket === ASSETS_DIRNAME) ? join(agentsRoot, agentId) : null; }
const TEXT_PREVIEWABLE_EXTENSIONS = new Set(["txt","text","log","md","markdown","mdx","rst","adoc","tex","json","jsonc","json5","ndjson","csv","tsv","xml","yaml","yml","toml","ini","cfg","conf","env","properties","plist","gradle","html","htm","css","scss","sass","less","svg","js","jsx","mjs","cjs","ts","tsx","mts","cts","py","pyi","rb","go","rs","java","kt","kts","c","h","cc","cpp","cxx","hpp","hh","cs","php","swift","scala","dart","lua","pl","pm","r","sql","graphql","gql","proto","vue","svelte","astro","sh","bash","zsh","fish","bat","ps1","tf","tfvars","dockerfile","diff","patch"]);
function isTextPreviewableName(path: string): boolean { const extension = extname(path).slice(1).toLowerCase(); return extension.length > 0 && TEXT_PREVIEWABLE_EXTENSIONS.has(extension); }
function looksLikeBinary(bytes: Uint8Array): boolean { const sample = bytes.subarray(0, 8 * 1024); if (sample.byteLength === 0) return false; let controls = 0; for (const byte of sample) { if (byte === 0) return true; if (byte < 32 && !(byte >= 9 && byte <= 13)) controls += 1; } return controls / sample.byteLength > 0.3; }
export async function readAttachmentText(agentDir: string, filePath: string) { const resolved = reanchorSandPath(filePath); if (!filePath || !isPathWithin(getAgentAttachmentsDir(agentDir), resolved)) return null; try { const info = await fs.stat(resolved); if (!info.isFile()) return null; if (!isTextPreviewableName(resolved)) return { kind: "binary" as const, bytes: info.size }; const handle = await fs.open(resolved, "r"); let head: Buffer; try { head = Buffer.alloc(ATTACHMENT_TEXT_PREVIEW_BYTE_CAP); const result = await handle.read(head, 0, head.length, 0); head = head.subarray(0, result.bytesRead); } finally { await handle.close(); } return looksLikeBinary(head) ? { kind: "binary" as const, bytes: info.size } : { kind: "text" as const, text: head.toString("utf8"), truncated: info.size > ATTACHMENT_TEXT_PREVIEW_BYTE_CAP, bytes: info.size }; } catch { return null; } }
export async function readImageDimensions(filePath: string): Promise<ImageSize | null> { const resolved = reanchorSandPath(filePath), mime = servableImageMimeFromPath(resolved); if (mime == null) return null; try { return imageSize(await fs.readFile(resolved), mime); } catch { return null; } }
export { Mp4Dimensions };
export const VIDEO_DIMENSIONS_HEAD_BYTES = 1024 * 1024, VIDEO_DIMENSIONS_TAIL_BYTES = 8 * 1024 * 1024;
export async function readVideoDimensions(filePath: string): Promise<ImageSize | null> { const resolved = reanchorSandPath(filePath); if (!isPathWithin(getSandRootDir(), resolved) || videoMimeFromPath(resolved) === undefined) return null; try { const handle = await fs.open(resolved, "r"); try { const { size } = await handle.stat(), headLength = Math.min(size, VIDEO_DIMENSIONS_HEAD_BYTES), head = Buffer.alloc(headLength); await handle.read(head, 0, headLength, 0); const fromHead = Mp4Dimensions.read(head); if (fromHead != null || size <= headLength) return fromHead; const tailLength = Math.min(size, VIDEO_DIMENSIONS_TAIL_BYTES), tail = Buffer.alloc(tailLength); await handle.read(tail, 0, tailLength, size - tailLength); return Mp4Dimensions.read(tail); } finally { await handle.close(); } } catch { return null; } }
export async function readMediaDimensions(filePath: string): Promise<ImageSize | null> { const resolved = reanchorSandPath(filePath); if (!isPathWithin(getSandRootDir(), resolved)) return null; if (servableImageMimeFromPath(resolved) != null) return readImageDimensions(resolved); if (videoMimeFromPath(resolved) !== undefined) return readVideoDimensions(resolved); return null; }
export async function persistImageBytes(targetDir: string, data: Uint8Array, mimeType: string) { const buffer = Buffer.from(data), hash = sha256(buffer), targetPath = join(targetDir, `${hash}${extensionFromImageMime(mimeType) ?? ".png"}`); await writeContentAddressedFile(targetDir, targetPath, buffer); const size = imageSize(buffer, mimeType); return { absolutePath: targetPath, fileUrl: pathToFileURL(targetPath).href, bytes: buffer.byteLength, width: size?.width ?? null, height: size?.height ?? null }; }

export interface AttachmentsServiceDependencies<Context> { readonly auth: GenerateImageAuth; readonly ctx: Context; readonly box: BoxStagingDependencies<Context>["box"]; readonly report?: (diagnostic: Record<string, unknown>) => void }
export function createAttachmentsService<Context>(deps: AttachmentsServiceDependencies<Context>) {
  let fallbackAgentId: string | null = null;
  const resolveDir = (agentId?: string | null) => { const id = agentId ?? fallbackAgentId; if (!id) throw new SandAttachmentError("No active agent to attach to."); return resolveSandAgentDir(id); };
  const readDir = (path: string, agentId?: string | null) => resolveAttachmentOwnerDir(path) ?? (() => { try { return resolveDir(agentId); } catch { return null; } })();
  const stageIntoBox = (agentId: string, paths: readonly string[]) => stageAttachmentsIntoBox({ ctx: deps.ctx, box: deps.box, resolveOwnerDir: resolveAttachmentOwnerDir, upload: async (ctx, box, id, files) => { await uploadBoxFiles(ctx, box, id, files); } }, agentId, paths);
  return { setFallbackAgentId(agentId: string | null) { fallbackAgentId = agentId; }, async upload(args: { filename: string; bytesBase64?: string; agentId?: string | null }) { const result = await ingestAttachmentBytes(resolveDir(args.agentId), args.filename, Buffer.from(typeof args.bytesBase64 === "string" ? args.bytesBase64 : "", "base64")); const agentId = args.agentId ?? fallbackAgentId; if (agentId != null) { try { const mapped = await stageIntoBox(agentId, [result.absolutePath]); const boxPath = mapped.get(result.absolutePath); if (typeof boxPath === "string" && boxPath.startsWith("/")) return { path: boxPath }; } catch {} } return { path: result.absolutePath }; }, readImage: (args: { path: string }) => readHostAttachmentImage(args.path), async readText(args: { path: string; agentId?: string | null }) { const dir = readDir(args.path, args.agentId); if (dir == null) { deps.report?.({ extension: "attachments", kind: "read_text_miss", hasActive: args.agentId != null }); return null; } return await readAttachmentText(dir, args.path); }, async readChunk(args: { path: string; agentId?: string | null; offset: number; length: number; videoPlayback?: boolean }) { const dir = readDir(args.path, args.agentId); if (dir == null) { deps.report?.({ extension: "attachments", kind: "read_chunk_miss", hasActive: args.agentId != null }); return null; } return await readHostAttachmentChunk(dir, args.path, args.offset, args.length, args.videoPlayback); }, ingest: ingestAttachment, ingestBytes: ingestAttachmentBytes, persistImageBytes, readImageDimensions, readMediaDimensions, readVideoBytes: readHostAttachmentVideoBytes, resolveChannelAttachment, resolveOwnerDir: resolveAttachmentOwnerDir, createGenerateImageResourceAccessor: createSandGenerateImageResourceAccessor, stageIntoBox, createGenerateImageService: <C>(options: Parameters<typeof createSandGenerateImageService<C>>[1]) => createSandGenerateImageService(deps.auth, options) };
}
