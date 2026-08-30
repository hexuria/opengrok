import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getSandRootDir, reanchorSandPath } from "../../host/host-paths.js";
import { isPathWithin } from "../../shared/node/paths.js";

export const STAGING_DIRNAME = "attachment-staging";
export const ATTACHMENT_PREVIEW_BYTE_CAP = 25 * 1024 * 1024;

export interface ImageSize { readonly width: number; readonly height: number }
export interface DesktopImageAttachment { readonly dataUrl: string; readonly width: number | null; readonly height: number | null }
export interface NativeImageBufferPort {
  createFromBuffer(buffer: Buffer): { isEmpty(): boolean; getSize(): ImageSize };
}
export interface AttachmentManagerDeps {
  readonly nativeImage: NativeImageBufferPort;
  readonly readPortableDimensions: (buffer: Buffer) => ImageSize | null;
  readonly servableImageMimeFromPath: (path: string) => string | null;
  readonly readFile?: (path: string) => Promise<Buffer>;
  readonly reanchorPath?: (path: string) => string;
}

export function getDesktopAttachmentStagingDir(): string { return join(getSandRootDir(), STAGING_DIRNAME); }

export function isWithinDesktopAttachmentStaging(filePath: unknown): boolean {
  return typeof filePath === "string" && filePath.length > 0 && isPathWithin(getDesktopAttachmentStagingDir(), reanchorSandPath(filePath));
}

export function readDesktopImageSize(buffer: Buffer, deps: Pick<AttachmentManagerDeps, "nativeImage" | "readPortableDimensions">): ImageSize | null {
  const portable = deps.readPortableDimensions(buffer);
  if (portable != null) return portable;
  try {
    const image = deps.nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) return null;
    const { width, height } = image.getSize();
    return width > 0 && height > 0 ? { width, height } : null;
  } catch { return null; }
}

export async function readDesktopImageAttachment(filePath: string, deps: AttachmentManagerDeps): Promise<DesktopImageAttachment | null> {
  const resolved = (deps.reanchorPath ?? reanchorSandPath)(filePath);
  const mime = deps.servableImageMimeFromPath(resolved);
  if (mime == null) return null;
  try {
    const data = await (deps.readFile ?? readFile)(resolved);
    const size = readDesktopImageSize(data, deps);
    return { dataUrl: `data:${mime};base64,${data.toString("base64")}`, width: size?.width ?? null, height: size?.height ?? null };
  } catch { return null; }
}

export async function resolveImageAttachment(
  filePath: string,
  readRemote: (path: string) => Promise<DesktopImageAttachment | null>,
  deps: AttachmentManagerDeps,
): Promise<DesktopImageAttachment | null> {
  return await readDesktopImageAttachment(filePath, deps) ?? await readRemote(filePath);
}
