import { attachmentExtension } from "./attachment-open-policy.js";
import { getFilePreviewKind } from "./file-preview-kind.js";
import type { SandAttachmentKind } from "./attachments.js";

const JSON_EXTENSIONS = new Set(["json", "jsonc", "json5", "ndjson"]);
const ARCHIVE_EXTENSIONS = new Set(["zip", "tar", "gz", "tgz", "bz2", "tbz2", "xz", "txz", "zst", "7z", "rar"]);
const TABLE_MIME_TYPES = new Set([
  "text/csv",
  "text/tab-separated-values",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
const DOCUMENT_MIME_TYPES = new Set([
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const ARCHIVE_MIME_TYPES = new Set([
  "application/zip", "application/x-zip-compressed", "application/gzip", "application/x-tar",
  "application/x-bzip2", "application/x-xz", "application/zstd", "application/x-7z-compressed",
  "application/x-rar-compressed", "application/vnd.rar",
]);

export function classifyMimeType(rawMimeType: string): Exclude<SandAttachmentKind, "file"> | null {
  const mime = (rawMimeType.split(";")[0] ?? "").trim().toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  if (mime === "text/markdown") return "markdown";
  if (TABLE_MIME_TYPES.has(mime)) return "table";
  if (mime === "application/json" || mime.endsWith("+json")) return "json";
  if (DOCUMENT_MIME_TYPES.has(mime)) return "document";
  if (ARCHIVE_MIME_TYPES.has(mime)) return "archive";
  if (mime.startsWith("text/")) return "text";
  return null;
}

export function extensionSubject(source: string): string {
  let pathname: string;
  try {
    pathname = new URL(source).pathname;
  } catch {
    return source;
  }
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

export function classifyPathLike(source: string): Exclude<SandAttachmentKind, "file"> | null {
  const subject = extensionSubject(source);
  const previewKind = getFilePreviewKind(subject);
  switch (previewKind) {
    case "image":
    case "video":
    case "audio":
    case "pdf":
    case "markdown":
    case "table":
      return previewKind;
    case "docx":
      return "document";
    case "json":
      return "json";
    case "text": {
      const extension = attachmentExtension(subject);
      return extension != null && JSON_EXTENSIONS.has(extension) ? "json" : "text";
    }
    case "unknown": {
      const extension = attachmentExtension(subject);
      return extension != null && ARCHIVE_EXTENSIONS.has(extension) ? "archive" : null;
    }
  }
}

export interface AttachmentClassificationSource {
  readonly mimeType?: string | null;
  readonly fileName?: string | null;
  readonly urlOrPath?: string | null;
}

export function classifyAttachment(source: AttachmentClassificationSource): SandAttachmentKind {
  if (source.mimeType != null && source.mimeType.length > 0) {
    const byMime = classifyMimeType(source.mimeType);
    if (byMime != null) return byMime;
  }
  if (source.fileName != null && source.fileName.length > 0) {
    const byName = classifyPathLike(source.fileName);
    if (byName != null) return byName;
  }
  if (source.urlOrPath != null && source.urlOrPath.length > 0) {
    const byPath = classifyPathLike(source.urlOrPath);
    if (byPath != null) return byPath;
  }
  return "file";
}

export function countAttachmentKinds(kinds: readonly SandAttachmentKind[]): Array<{ kind: SandAttachmentKind; count: number }> {
  const counts = new Map<SandAttachmentKind, number>();
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return [...counts].map(([kind, count]) => ({ kind, count }));
}
