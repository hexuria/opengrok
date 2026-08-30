import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionFromImageMime } from "../../../shared/media/image-mime.js";
import { mimeFromDataUrl } from "../../../shared/media/user-attachment-comment.js";
export interface InlineImage {
  base64: string;
  mediaType: string;
  alt?: string;
}
export async function materializeInlineImages(
  session: { dbPath: string },
  images: readonly InlineImage[],
): Promise<Array<{ url: string; alt?: string }>> {
  if (images.length === 0) return [];
  const dir = join(dirname(session.dbPath), "xuser-attachments"),
    materialized: Array<{ url: string; alt?: string }> = [];
  for (const image of images.slice(0, 4))
    try {
      const bytes = Buffer.from(image.base64, "base64");
      if (bytes.byteLength === 0) continue;
      const hash = createHash("sha256").update(bytes).digest("hex"),
        extension = extensionFromImageMime(image.mediaType) ?? ".png",
        filePath = join(dir, `${hash}${extension}`);
      if (!existsSync(filePath)) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(filePath, bytes);
      }
      materialized.push({
        url: pathToFileURL(filePath).toString(),
        ...(image.alt != null ? { alt: image.alt } : {}),
      });
    } catch {}
  return materialized;
}

export function parseDataUrlBytes(dataUrl: string): { mediaType: string; bytes: Buffer } | null {
  const trimmed = dataUrl.trim();
  const comma = trimmed.indexOf(",");
  if (!trimmed.startsWith("data:") || comma < 0) return null;
  const header = trimmed.slice(5, comma);
  const payload = trimmed.slice(comma + 1);
  const mediaType = mimeFromDataUrl(trimmed) ?? header.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mediaType.length === 0 || payload.length === 0) return null;
  try {
    const bytes = Buffer.from(payload, /;base64/i.test(header) ? "base64" : "utf8");
    return bytes.byteLength === 0 ? null : { mediaType, bytes };
  } catch {
    return null;
  }
}

export function materializeDataUrlAttachment(
  session: { dbPath: string },
  dataUrl: string,
  fileName?: string,
): { path: string; byteSize: number; fileName: string } | null {
  const parsed = parseDataUrlBytes(dataUrl);
  if (parsed == null) return null;
  try {
    const dir = join(dirname(session.dbPath), "xuser-attachments");
    const hash = createHash("sha256").update(parsed.bytes).digest("hex");
    const suggested = fileName?.trim();
    const extension = suggested != null && extname(suggested).length > 0
      ? extname(suggested)
      : extensionFromImageMime(parsed.mediaType) ?? ".bin";
    const leaf = `${hash}${extension}`;
    const filePath = join(dir, leaf);
    if (!existsSync(filePath)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, parsed.bytes);
    }
    return {
      path: filePath,
      byteSize: parsed.bytes.byteLength,
      fileName: suggested != null && suggested.length > 0 ? suggested : `Attachment${extension}`,
    };
  } catch {
    return null;
  }
}
