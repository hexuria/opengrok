/**
 * Host-leak comment splitter for user attachments.
 *
 * Official 0.27/0.29 Grok Bot paints first-class transcript entries
 * `kind: "user-attachment"`. Official renderer JS has zero hits for
 * `cursor-user-attachment` or `cursor-timestamp`; those HTML comments are a
 * host leak. Parse them into attachments, persist the structured entries,
 * and strip the comment strings before any text paint or sidebar preview.
 *
 * Official send grouping (0.29):
 * - batchId = `optimistic:${nonce}:batch` when attachments.length > 0
 * - item id = `optimistic:${nonce}:a${i}`
 * - virtualizer group key = `ua:${batchId}` (or `ua:legacy` / `ua:${batchId}:${replyTo}`)
 *
 * Official gallery (Uriah 0.29 visual): first 3 tiles; leftover `+N` on the
 * last cell. Composer file cap is 6 (`COMPOSER_ATTACHMENT_LIMIT` / g5e=lqt).
 * Toast key YVRNzB is not present in this tree; do not invent a toast.
 */

export const USER_ATTACHMENT_KIND = "user-attachment" as const;
export const USER_ATTACHMENT_FILE_CAP = 6;
export const USER_ATTACHMENT_VISIBLE_TILES = 3;

const USER_ATTACHMENT_COMMENT = /<!--\s*cursor-user-attachment:([\s\S]*?)-->/gi;
const HOST_LEAK_COMMENT = /<!--\s*cursor-(?:user-attachment|timestamp):[\s\S]*?-->/gi;

export interface ParsedUserAttachment {
  readonly kind: typeof USER_ATTACHMENT_KIND;
  readonly id: string;
  readonly file_path: string;
  readonly file_name?: string;
  readonly byteSize?: number;
  readonly width?: number;
  readonly height?: number;
  readonly timestampMs?: number;
  readonly batchId?: string;
  readonly replyTo?: string;
  readonly clientNonce?: string;
}

export type UserAttachmentPaintKind = "image" | "file";

export interface UserAttachmentClassificationSource {
  readonly mimeType?: string | null;
  readonly fileName?: string | null;
  readonly urlOrPath?: string | null;
}

export interface SplitUserAttachmentBody {
  readonly text: string;
  readonly attachments: readonly ParsedUserAttachment[];
}

export interface CollectedUserAttachmentSend {
  readonly text: string;
  readonly richText?: string;
  readonly attachments: readonly ParsedUserAttachment[];
  readonly batchId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function mimeFromDataUrl(value: string): string | undefined {
  const match = /^data:([^;,]+)[;,]/i.exec(value.trim());
  const mime = match?.[1]?.trim().toLowerCase();
  return mime != null && mime.length > 0 ? mime : undefined;
}

export function isDataUrl(value: string): boolean {
  return /^data:/i.test(value.trim());
}

export function isRemoteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function basename(filePath: string): string {
  if (isDataUrl(filePath)) return "Attachment";
  let path = filePath;
  try {
    const url = new URL(filePath);
    path = url.protocol === "file:" ? decodeURIComponent(url.pathname) : url.pathname;
  } catch {
    // Already a local path.
  }
  const leaf = path.replaceAll("\\", "/").split("/").filter((segment) => segment.length > 0).at(-1);
  return leaf != null && leaf.length > 0 ? leaf : "Attachment";
}

function looksLikeImageName(value: string): boolean {
  const subject = value.split("?")[0]?.split("#")[0] ?? value;
  return /\.(avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i.test(subject);
}

/** Official KV: mimeType, then fileName, then urlOrPath. Default file. */
export function classifyUserAttachmentKind(source: UserAttachmentClassificationSource): UserAttachmentPaintKind {
  const mime = source.mimeType?.split(";")[0]?.trim().toLowerCase();
  if (mime != null && mime.startsWith("image/")) return "image";
  if (source.fileName != null && source.fileName.length > 0 && looksLikeImageName(source.fileName)) return "image";
  if (source.urlOrPath != null && source.urlOrPath.length > 0) {
    const dataMime = mimeFromDataUrl(source.urlOrPath);
    if (dataMime != null && dataMime.startsWith("image/")) return "image";
    if (looksLikeImageName(source.urlOrPath)) return "image";
  }
  return "file";
}

export function parseUserAttachmentCommentPayload(raw: string): ParsedUserAttachment | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const filePath = optionalNonEmptyString(parsed.file_path ?? parsed.filePath ?? parsed.path);
  if (filePath == null) return null;
  const kind = parsed.kind;
  if (kind !== undefined && kind !== USER_ATTACHMENT_KIND) return null;
  const id = optionalNonEmptyString(parsed.id) ?? "";
  const fileName = optionalNonEmptyString(parsed.file_name ?? parsed.fileName ?? parsed.name);
  const byteSize = optionalFiniteNumber(parsed.byteSize ?? parsed.size);
  const width = optionalFiniteNumber(parsed.width);
  const height = optionalFiniteNumber(parsed.height);
  const timestampMs = optionalFiniteNumber(parsed.timestampMs);
  const batchId = optionalNonEmptyString(parsed.batchId);
  const replyTo = optionalNonEmptyString(parsed.replyTo ?? parsed.replyToId);
  const clientNonce = optionalNonEmptyString(parsed.clientNonce);
  return {
    kind: USER_ATTACHMENT_KIND,
    id,
    file_path: filePath,
    ...(fileName == null ? {} : { file_name: fileName }),
    ...(byteSize == null ? {} : { byteSize }),
    ...(width == null ? {} : { width }),
    ...(height == null ? {} : { height }),
    ...(timestampMs == null ? {} : { timestampMs }),
    ...(batchId == null ? {} : { batchId }),
    ...(replyTo == null ? {} : { replyTo }),
    ...(clientNonce == null ? {} : { clientNonce }),
  };
}

export function parseUserAttachmentComments(text: string): ParsedUserAttachment[] {
  const attachments: ParsedUserAttachment[] = [];
  const seen = new Set<string>();
  USER_ATTACHMENT_COMMENT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = USER_ATTACHMENT_COMMENT.exec(text)) != null) {
    const parsed = parseUserAttachmentCommentPayload(match[1] ?? "");
    if (parsed == null) continue;
    const key = `${parsed.id}\0${parsed.file_path}\0${parsed.file_name ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    attachments.push(parsed);
  }
  return attachments;
}

export function stripHostLeakComments(text: string): string {
  return text.replace(HOST_LEAK_COMMENT, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function splitUserAttachmentBody(text: string): SplitUserAttachmentBody {
  return {
    text: stripHostLeakComments(text),
    attachments: parseUserAttachmentComments(text),
  };
}

export function stripHostLeakCommentsFromRichText(richText: string | undefined): string | undefined {
  if (richText == null || richText.length === 0) return richText;
  const stripped = stripHostLeakComments(richText);
  return stripped.length === 0 ? undefined : stripped;
}

export function optimisticUserAttachmentBatchId(nonce: string): string {
  return `optimistic:${nonce}:batch`;
}

export function optimisticUserAttachmentId(nonce: string, index: number): string {
  return `optimistic:${nonce}:a${index}`;
}

export function userAttachmentGroupKey(input: {
  readonly batchId?: string | null;
  readonly replyTo?: string | null;
}): string {
  const batchId = input.batchId?.trim() ?? "";
  if (batchId.length === 0) return "ua:legacy";
  const replyTo = input.replyTo?.trim() ?? "";
  return replyTo.length > 0 ? `ua:${batchId}:${replyTo}` : `ua:${batchId}`;
}

export function visibleUserAttachmentTiles<T>(attachments: readonly T[]): {
  readonly visible: readonly T[];
  readonly leftover: number;
} {
  if (attachments.length <= USER_ATTACHMENT_VISIBLE_TILES) {
    return { visible: attachments, leftover: 0 };
  }
  return {
    visible: attachments.slice(0, USER_ATTACHMENT_VISIBLE_TILES),
    leftover: attachments.length - USER_ATTACHMENT_VISIBLE_TILES,
  };
}

function attachmentIdentity(attachment: ParsedUserAttachment): string {
  return `${attachment.file_path}\0${attachment.file_name ?? basename(attachment.file_path)}`;
}

function structuredAttachments(value: unknown): ParsedUserAttachment[] {
  if (!Array.isArray(value)) return [];
  const attachments: ParsedUserAttachment[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim().length > 0) {
      attachments.push({ kind: USER_ATTACHMENT_KIND, id: "", file_path: item });
      continue;
    }
    if (!isRecord(item)) continue;
    const parsed = parseUserAttachmentCommentPayload(JSON.stringify(item));
    if (parsed != null) attachments.push(parsed);
  }
  return attachments;
}

export function collectUserAttachmentsForSend(input: {
  readonly prompt: string;
  readonly richText?: string;
  readonly attachmentPaths?: readonly string[];
  readonly attachmentNames?: readonly string[];
  readonly attachments?: unknown;
  readonly clientNonce?: string;
  readonly replyTo?: string;
  readonly timestampMs?: number;
  readonly cap?: number;
}): CollectedUserAttachmentSend {
  const split = splitUserAttachmentBody(input.prompt);
  const richText = stripHostLeakCommentsFromRichText(input.richText);
  const collected: ParsedUserAttachment[] = [];
  const push = (attachment: ParsedUserAttachment) => {
    const key = attachmentIdentity(attachment);
    const existingIndex = collected.findIndex((item) => attachmentIdentity(item) === key);
    if (existingIndex >= 0) {
      const existing = collected[existingIndex]!;
      const fileName = existing.file_name ?? attachment.file_name;
      const byteSize = existing.byteSize ?? attachment.byteSize;
      const width = existing.width ?? attachment.width;
      const height = existing.height ?? attachment.height;
      const timestampMs = existing.timestampMs ?? attachment.timestampMs;
      const batchId = existing.batchId ?? attachment.batchId;
      const replyTo = existing.replyTo ?? attachment.replyTo;
      const clientNonce = existing.clientNonce ?? attachment.clientNonce;
      collected[existingIndex] = {
        kind: USER_ATTACHMENT_KIND,
        id: existing.id || attachment.id,
        file_path: existing.file_path,
        ...(fileName == null ? {} : { file_name: fileName }),
        ...(byteSize == null ? {} : { byteSize }),
        ...(width == null ? {} : { width }),
        ...(height == null ? {} : { height }),
        ...(timestampMs == null ? {} : { timestampMs }),
        ...(batchId == null ? {} : { batchId }),
        ...(replyTo == null ? {} : { replyTo }),
        ...(clientNonce == null ? {} : { clientNonce }),
      };
      return;
    }
    collected.push(attachment);
  };
  const paths = input.attachmentPaths ?? [];
  const names = input.attachmentNames ?? [];
  for (const [index, path] of paths.entries()) {
    if (typeof path !== "string" || path.trim().length === 0) continue;
    const name = optionalNonEmptyString(names[index]);
    push({
      kind: USER_ATTACHMENT_KIND,
      id: "",
      file_path: path,
      ...(name == null ? {} : { file_name: name }),
    });
  }
  for (const attachment of structuredAttachments(input.attachments)) push(attachment);
  for (const attachment of split.attachments) push(attachment);

  const cap = input.cap ?? USER_ATTACHMENT_FILE_CAP;
  const limited = collected.slice(0, Math.max(0, cap));
  const nonce = optionalNonEmptyString(input.clientNonce);
  const batchId = limited.length > 0 && nonce != null ? optimisticUserAttachmentBatchId(nonce) : undefined;
  const timestampMs = input.timestampMs;
  const replyTo = optionalNonEmptyString(input.replyTo);
  const attachments = limited.map((attachment, index) => ({
    ...attachment,
    id: nonce != null ? optimisticUserAttachmentId(nonce, index) : attachment.id,
    ...(batchId == null ? {} : { batchId: attachment.batchId ?? batchId }),
    ...(nonce == null ? {} : { clientNonce: attachment.clientNonce ?? nonce }),
    ...(replyTo == null ? {} : { replyTo: attachment.replyTo ?? replyTo }),
    ...(timestampMs == null ? {} : { timestampMs: attachment.timestampMs ?? timestampMs }),
    file_name: attachment.file_name ?? (isDataUrl(attachment.file_path) ? "Attachment" : basename(attachment.file_path)),
  }));
  return {
    text: split.text,
    ...(richText == null ? {} : { richText }),
    attachments,
    ...(batchId == null ? {} : { batchId }),
  };
}

export function previewUserAttachmentBody(text: string): string {
  const split = splitUserAttachmentBody(text);
  const visible = split.text.replace(/\s+/g, " ").trim();
  if (visible.length > 0) return visible.slice(0, 280);
  return userAttachmentPreviewLabel(split.attachments);
}

export function userAttachmentPreviewLabel(attachments: readonly ParsedUserAttachment[]): string {
  if (attachments.length === 0) return "";
  const kinds = new Map<UserAttachmentPaintKind, number>();
  for (const attachment of attachments) {
    const kind = classifyUserAttachmentKind({
      ...(attachment.file_name == null ? {} : { fileName: attachment.file_name }),
      urlOrPath: attachment.file_path,
    });
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  const count = attachments.length;
  if (kinds.size === 1 && kinds.has("image")) {
    return count === 1 ? "Sent 1 image" : `Sent ${count} images`;
  }
  if (kinds.size === 1 && kinds.has("file")) {
    return count === 1 ? "Sent 1 file" : `Sent ${count} files`;
  }
  const images = kinds.get("image") ?? 0;
  const files = kinds.get("file") ?? 0;
  return `Sent ${count} files · ${images} ${images === 1 ? "image" : "images"}, ${files} ${files === 1 ? "file" : "files"}`;
}

export function lastEntryFromUserAttachmentBody(text: string):
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "attachment"; readonly count: number; readonly kinds: Readonly<Record<string, number>> } {
  const split = splitUserAttachmentBody(text);
  const visible = split.text.replace(/\s+/g, " ").trim();
  if (visible.length > 0) return { kind: "text", text: visible };
  if (split.attachments.length === 0) return { kind: "text", text: "" };
  const kinds: Record<string, number> = {};
  for (const attachment of split.attachments) {
    const kind = classifyUserAttachmentKind({
      ...(attachment.file_name == null ? {} : { fileName: attachment.file_name }),
      urlOrPath: attachment.file_path,
    });
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  return { kind: "attachment", count: split.attachments.length, kinds };
}

export interface GroupableUserAttachmentRow {
  readonly kind?: string;
  readonly role?: string;
  readonly text?: string;
  readonly richText?: string;
  readonly attachments?: readonly unknown[];
  readonly batchId?: string;
  readonly replyToId?: string;
}

/**
 * Official virtualizer groups `user-attachment` rows by `ua:${batchId}`.
 * Collapse consecutive same-batch attachment rows + the following user text
 * into one gallery-above-bubble message.
 */
export function groupUserAttachmentMessages<T extends GroupableUserAttachmentRow>(entries: readonly T[]): T[] {
  const out: T[] = [];
  let index = 0;
  while (index < entries.length) {
    const entry = entries[index]!;
    const isUserMessage = (entry.kind == null || entry.kind === "message") && entry.role === "user";
    const attachments = entry.attachments ?? [];
    if (!isUserMessage || (attachments.length === 0 && (entry.batchId == null || entry.batchId.length === 0))) {
      out.push(entry);
      index += 1;
      continue;
    }
    const key = userAttachmentGroupKey({
      ...(entry.batchId == null ? {} : { batchId: entry.batchId }),
      ...(entry.replyToId == null ? {} : { replyTo: entry.replyToId }),
    });
    const mergedAttachments = [...attachments];
    let text = entry.text ?? "";
    let richText = entry.richText;
    let last = entry;
    let cursor = index + 1;
    while (cursor < entries.length) {
      const next = entries[cursor]!;
      const nextIsUser = (next.kind == null || next.kind === "message") && next.role === "user";
      if (!nextIsUser) break;
      const nextAttachments = next.attachments ?? [];
      if (nextAttachments.length === 0 && (next.batchId == null || next.batchId.length === 0)) break;
      if (userAttachmentGroupKey({
        ...(next.batchId == null ? {} : { batchId: next.batchId }),
        ...(next.replyToId == null ? {} : { replyTo: next.replyToId }),
      }) !== key) break;
      mergedAttachments.push(...nextAttachments);
      if ((next.text ?? "").length > 0) {
        text = text.length > 0 ? `${text}\n${next.text}` : (next.text ?? "");
        richText = next.richText ?? richText;
      }
      last = next;
      cursor += 1;
    }
    if (cursor === index + 1) {
      out.push(entry);
      index += 1;
      continue;
    }
    out.push({
      ...last,
      text,
      ...(richText == null ? {} : { richText }),
      attachments: mergedAttachments,
      ...(entry.batchId == null ? {} : { batchId: entry.batchId }),
    });
    index = cursor;
  }
  return out;
}

export function persistableUserAttachmentEntry(attachment: ParsedUserAttachment, fallbackId: string): Record<string, unknown> {
  return {
    kind: USER_ATTACHMENT_KIND,
    id: attachment.id.trim().length > 0 ? attachment.id : fallbackId,
    file_path: attachment.file_path,
    ...(attachment.file_name == null ? {} : { file_name: attachment.file_name }),
    ...(attachment.byteSize == null ? {} : { byteSize: attachment.byteSize }),
    ...(attachment.width == null ? {} : { width: attachment.width }),
    ...(attachment.height == null ? {} : { height: attachment.height }),
    ...(attachment.timestampMs == null ? {} : { timestampMs: attachment.timestampMs }),
    ...(attachment.batchId == null ? {} : { batchId: attachment.batchId }),
    ...(attachment.replyTo == null ? {} : { replyTo: attachment.replyTo }),
    ...(attachment.clientNonce == null ? {} : { clientNonce: attachment.clientNonce }),
  };
}
