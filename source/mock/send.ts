import { randomUUID } from "node:crypto";
import { HOST_TITLE_JOB_PREFIX } from "./constants.js";
import type { LocalTranscriptBody } from "./fixtures.js";
import type { MockGrokBotStore } from "./store.js";

const CURSOR_COMMENT = /<!--\s*cursor-[\s\S]*?-->/gi;

export function stripCursorComments(text: string): string {
  return text.replace(CURSOR_COMMENT, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function isHostTitleJob(text: string): boolean {
  return text.trim().toLowerCase().startsWith(HOST_TITLE_JOB_PREFIX.toLowerCase());
}

export function isDataUrl(value: string): boolean {
  return /^data:/i.test(value.trim());
}

export function decodeDataUrl(value: string): Uint8Array | undefined {
  const match = /^data:([^,]*),([\s\S]*)$/i.exec(value.trim());
  if (match == null) return undefined;
  const header = match[1] ?? "";
  const payload = match[2] ?? "";
  if (/(?:^|;)base64$/i.test(header) || /;base64;/i.test(header)) {
    return Uint8Array.from(Buffer.from(payload, "base64"));
  }
  try {
    return Uint8Array.from(Buffer.from(decodeURIComponent(payload), "utf8"));
  } catch {
    return Uint8Array.from(Buffer.from(payload, "utf8"));
  }
}

function attachmentFileName(path: string, name: string | undefined, index: number): string {
  if (name != null && name.length > 0) return name;
  if (isDataUrl(path)) return `attachment-${index + 1}`;
  const leaf = path.replaceAll("\\", "/").split("/").filter((segment) => segment.length > 0).at(-1);
  return leaf != null && leaf.length > 0 ? leaf : `attachment-${index + 1}`;
}

function extensionForUpload(path: string, name: string | undefined): string {
  const fromName = name?.trim().toLowerCase() ?? "";
  const nameDot = fromName.lastIndexOf(".");
  if (nameDot >= 0 && nameDot < fromName.length - 1) {
    return fromName.slice(nameDot);
  }
  const mime = /^data:([^;,]+)/i.exec(path.trim())?.[1]?.trim().toLowerCase() ?? "";
  if (mime === "image/png") return ".png";
  if (mime === "image/jpeg" || mime === "image/jpg") return ".jpg";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/webp") return ".webp";
  if (mime === "application/pdf") return ".pdf";
  if (mime.startsWith("text/")) return ".txt";
  return "";
}

/**
 * Decode composer `data:` URLs onto `attachments/<id>.<ext>` so List
 * stays small and ReadGrokBotAgentAttachmentChunk can serve a refresh.
 * The original data: string is kept as an alias key.
 */
export function persistSendAttachments(
  store: MockGrokBotStore,
  paths: readonly string[],
  names: readonly string[] = [],
): string[] {
  const stored: string[] = [];
  for (const [index, filePath] of paths.entries()) {
    if (filePath.length === 0) continue;
    if (!isDataUrl(filePath)) {
      stored.push(filePath);
      continue;
    }
    const bytes = decodeDataUrl(filePath);
    if (bytes == null) {
      stored.push(filePath);
      continue;
    }
    const path = `attachments/${randomUUID()}${extensionForUpload(filePath, names[index])}`;
    store.putAttachment(path, bytes);
    store.putAttachment(filePath, bytes);
    stored.push(path);
  }
  return stored;
}

export function userAttachmentBodies(
  userId: string,
  now: number,
  paths: readonly string[],
  names: readonly string[],
): LocalTranscriptBody[] {
  const bodies: LocalTranscriptBody[] = [];
  for (const [index, filePath] of paths.entries()) {
    if (filePath.length === 0) continue;
    bodies.push({
      id: `${userId}-att-${index}`,
      kind: "user-attachment",
      file_path: filePath,
      file_name: attachmentFileName(filePath, names[index], index),
      timestampMs: now,
    });
  }
  return bodies;
}
