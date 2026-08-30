import { open, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

import { asAttachmentBytes } from "../../shared/media/bytes-base64.js";
import { imageMimeFromPath } from "../../shared/media/image-mime.js";
import { posixPathFromFileUrl } from "../../shared/node/paths.js";

export const GATEWAY_READ_CHUNK_BYTES = 4 * 1024 * 1024;
export const LINK_PREVIEW_PHOTO_MAX_DIMENSION = 1280;
export const LINK_PREVIEW_ICON_MAX_DIMENSION = 128;

export interface AttachmentChunk { readonly totalSize: number; readonly bytesBase64: string }
export interface AttachmentLegs {
  readAttachmentImage(request: { path: string }): Promise<ImageAttachment | null>;
  readAttachmentText(request: { path: string }): Promise<string | null>;
  readAttachmentChunk(request: { path: string; offset: number; length: number }): Promise<AttachmentChunk | null>;
  uploadAttachment(request: { filename: string; bytesBase64: string }): Promise<{ path: string }>;
}
export interface ImageAttachment { readonly dataUrl: string; readonly width: number | null; readonly height: number | null }
export interface PreviewImagePort {
  createFromDataURL(dataUrl: string): { isEmpty(): boolean; resize(target: ({ width: number } | { height: number }) & { quality: "good" }): { isEmpty(): boolean; toJPEG(quality: number): Buffer; toPNG(): Buffer } };
}
export interface AttachmentEdgeDeps {
  readonly legs: AttachmentLegs;
  readonly getMainWindow: () => unknown | null;
  readonly onEdgeFailure: (failure: { leg: string; errorClass: string }) => void;
  readonly videoMimeFromPath: (path: string) => string | null;
  readonly audioMimeFromPath: (path: string) => string | null;
  readonly displayableImageMimeFromPath: (path: string) => string | null;
  readonly buildMediaUrl: (path: string) => string;
  readonly resolveImage: (path: string, readRemote: (path: string) => Promise<ImageAttachment | null>) => Promise<ImageAttachment | null>;
  readonly fetchLinkMetadata: (request: { cacheDir: string; url: string }) => Promise<Record<string, unknown> & { imageDataUrl?: string | null; faviconDataUrl?: string | null } | null>;
  readonly boundPreviewImage: (dataUrl: string | null | undefined, target: { maxDimension: number; encoding: "jpeg" | "png" }, resize: (dataUrl: string, target: { width: number } | { height: number }, encoding: "jpeg" | "png") => string | null) => string | null;
  readonly nativeImage: PreviewImagePort & {
    createFromBuffer?(bytes: Buffer): {
      isEmpty(): boolean;
      getSize(): { width: number; height: number };
      resize(options: { width?: number; height?: number; quality: string }): { isEmpty(): boolean; toJPEG(quality: number): Buffer; toPNG(): Buffer };
    };
  };
  readonly getUserDataDir: () => string;
  readonly downloadsDir: string;
  readonly previewKindNeedsBytes: (kind: unknown) => boolean;
  readonly getFilePreviewKind: (path: string) => unknown;
  readonly previewByteCap: number;
  readonly byteLimitForName: (filename: string) => number;
  readonly getStagingDir: () => string;
  readonly isWithinStagingDir: (path: string) => boolean;
  readonly resolveSuggestedDownloadName: (request: { suggestedName: unknown; sourcePath: string }) => string;
  readonly resolveDefaultDownloadPath: (request: { fileName: string; configuredDir: null; osDownloadsDir: string }) => string;
  readonly showSaveDialog: (window: unknown | null, options: { defaultPath: string }) => Promise<{ canceled: boolean; filePath?: string }>;
  readonly createHiddenWindow: (options: { readonly show: false }) => unknown;
  readonly showErrorMessage: (window: unknown | null, options: { type: "error"; title: string; message: string }) => Promise<void>;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}

export function errorClassOf(error: unknown): string { return error instanceof Error ? error.name || "Error" : typeof error; }
export function isSafeFilename(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 255 && !value.includes("/") && !value.includes("\\") && !value.includes("\0"); }

/** Electron File.name for a macOS screenshot drop is often a full TemporaryItems path. isSafeFilename rejects slashes, so stageBytes takes the leaf first. */
export function safeAttachmentFilename(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return null;
  let path = value.trim();
  try {
    const url = new URL(path);
    if (url.protocol === "file:") {
      const fromFile = posixPathFromFileUrl(path);
      if (fromFile != null && fromFile.length > 0) path = fromFile;
    }
  } catch {
    // Already a local path or a bare filename.
  }
  const segments = path.split(/[/\\]/).filter((segment) => segment.length > 0);
  const base = segments.at(-1) ?? "";
  if (base.length === 0) return null;
  return base.length <= 255 ? base : base.slice(0, 255);
}

export { asAttachmentBytes } from "../../shared/media/bytes-base64.js";

export function isReadableDropPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || !value.startsWith("/") || value.includes("\0")) return false;
  if (value.includes("/../") || value.endsWith("/..")) return false;
  return value.startsWith("/Users/")
    || value.startsWith("/Volumes/")
    || value.startsWith("/home/")
    || value.startsWith("/private/var/folders/")
    || value.startsWith("/var/folders/")
    || value.startsWith("/tmp/")
    || value.startsWith("/private/tmp/");
}

/**
 * Cursor box uploadAttachment returns `{ path }`. A string path, a file: URL,
 * or a coordinator `{ result: { path } }` wrapper all have to become the box
 * persist key — otherwise sendPrompt stores a Mac staging path / data: URL and
 * official Grok Bot paints the failed-MediaShell icon.
 */
export function boxPathFromUploadResult(value: unknown): string | null {
  if (typeof value === "string") return boxPathFromUploadResult({ path: value });
  if (typeof value !== "object" || value == null) return null;
  const record = value as Record<string, unknown>;
  if ("result" in record) return boxPathFromUploadResult(record.result);
  const raw = record.path;
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const trimmed = raw.trim();
  if (trimmed.toLowerCase().startsWith("file:")) return posixPathFromFileUrl(trimmed);
  if (!trimmed.startsWith("/") || trimmed.includes("\0") || trimmed.includes("..")) return null;
  return trimmed;
}

export function normalizeAttachmentSource(source: unknown): string | null {
  if (typeof source !== "string" || source.length === 0) return null;
  try { const url = new URL(source); return url.protocol === "file:" ? posixPathFromFileUrl(source) : null; } catch { return source; }
}
export function resizePreviewImage(dataUrl: string, target: { width: number } | { height: number }, encoding: "jpeg" | "png", nativeImage: PreviewImagePort): string | null {
  const source = nativeImage.createFromDataURL(dataUrl); if (source.isEmpty()) return null;
  const scaled = source.resize({ ...target, quality: "good" }); if (scaled.isEmpty()) return null;
  const encoded = encoding === "jpeg" ? scaled.toJPEG(82) : scaled.toPNG();
  return `data:image/${encoding};base64,${encoded.toString("base64")}`;
}

export const STAGE_IMAGE_MAX_EDGE_PX = 2048;
export const STAGE_IMAGE_MIN_BYTES = 1024 * 1024;

/**
 * Uploaded screenshots are routinely 4K/5MB+, and every consumer — the box
 * upload, vision requests, transcript tiles — either downscales anyway or is
 * capped well below that. Cap staged images at a 2048px long edge: JPEG/WebP
 * sources re-encode as JPEG q85, PNG stays PNG (transparency preserved), GIFs
 * and small files pass through untouched.
 */
export function downscaleStagedImage(
  fileName: string,
  payload: Uint8Array,
  nativeImage: AttachmentEdgeDeps["nativeImage"] | undefined,
): { bytes: Uint8Array; extensionOverride?: string } {
  const createFromBuffer = nativeImage?.createFromBuffer;
  if (createFromBuffer == null || payload.byteLength < STAGE_IMAGE_MIN_BYTES) return { bytes: payload };
  const mime = imageMimeFromPath(fileName);
  if (mime == null || mime === "image/gif") return { bytes: payload };
  try {
    const image = createFromBuffer.call(nativeImage, Buffer.from(payload));
    if (image.isEmpty()) return { bytes: payload };
    const { width, height } = image.getSize();
    const longest = Math.max(width, height);
    if (longest <= STAGE_IMAGE_MAX_EDGE_PX) return { bytes: payload };
    const scaled = width >= height
      ? image.resize({ width: STAGE_IMAGE_MAX_EDGE_PX, quality: "good" })
      : image.resize({ height: STAGE_IMAGE_MAX_EDGE_PX, quality: "good" });
    if (scaled.isEmpty()) return { bytes: payload };
    if (mime === "image/png") {
      const png = scaled.toPNG();
      return png.byteLength > 0 && png.byteLength < payload.byteLength ? { bytes: new Uint8Array(png) } : { bytes: payload };
    }
    const jpeg = scaled.toJPEG(85);
    return jpeg.byteLength > 0 && jpeg.byteLength < payload.byteLength ? { bytes: new Uint8Array(jpeg), extensionOverride: ".jpg" } : { bytes: payload };
  } catch { return { bytes: payload }; }
}

export function createAttachmentEdgePort(deps: AttachmentEdgeDeps) {
  const report = (leg: string, error: unknown): void => deps.onEdgeFailure({ leg, errorClass: errorClassOf(error) });
  const readBoxBytes = async (filePath: string, maxBytes: number): Promise<{ kind: "too-large"; size: number } | { kind: "bytes"; bytes: Uint8Array } | null> => {
    let totalSize: number;
    try { const probe = await deps.legs.readAttachmentChunk({ path: filePath, offset: 0, length: 0 }); if (probe == null) return null; totalSize = probe.totalSize; } catch (error) { report("read-bytes", error); return null; }
    if (totalSize > maxBytes) return { kind: "too-large", size: totalSize };
    const buffer = Buffer.alloc(totalSize); let offset = 0;
    try {
      while (offset < totalSize) { const chunk = await deps.legs.readAttachmentChunk({ path: filePath, offset, length: GATEWAY_READ_CHUNK_BYTES }); if (chunk == null) return null; const bytes = Buffer.from(chunk.bytesBase64, "base64"); if (bytes.length === 0) break; bytes.copy(buffer, offset); offset += bytes.length; }
    } catch (error) { report("read-bytes", error); return null; }
    return offset < totalSize ? null : { kind: "bytes", bytes: new Uint8Array(buffer) };
  };
  const failDownload = async (reason: string): Promise<false> => { deps.onEdgeFailure({ leg: "download", errorClass: reason }); try { await deps.showErrorMessage(deps.getMainWindow(), { type: "error", title: "Save File", message: "Couldn't save this file" }); } catch (error) { report("download", error); } return false; };

  return {
    async resolveMedia(source: unknown) {
      const path = normalizeAttachmentSource(source); if (path == null) return null;
      if (deps.videoMimeFromPath(path) != null) return { kind: "video" as const, src: deps.buildMediaUrl(path), width: null, height: null };
      if (deps.audioMimeFromPath(path) != null) return { kind: "audio" as const, src: deps.buildMediaUrl(path) };
      if (deps.displayableImageMimeFromPath(path) == null) return null;
      // Stream displayable images through the media protocol instead of
      // materializing base64 data URLs over IPC: Chromium decodes the file
      // incrementally and caches by URL (content-hash names never mutate).
      // The renderer measures unknown dimensions itself, and transcript rows
      // now persist width/height for exact reservation.
      return { kind: "image" as const, dataUrl: deps.buildMediaUrl(path), width: null, height: null };
    },
    async readText(source: unknown): Promise<string | null> { const path = normalizeAttachmentSource(source); if (path == null) return null; try { return await deps.legs.readAttachmentText({ path }); } catch (error) { report("read-text", error); return null; } },
    async readBytes(source: unknown, maxBytes?: unknown) { const path = normalizeAttachmentSource(source); if (path == null || !deps.previewKindNeedsBytes(deps.getFilePreviewKind(path))) return null; const cap = typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0 ? Math.min(Math.floor(maxBytes), deps.previewByteCap) : deps.previewByteCap; return await readBoxBytes(path, cap); },
    async stageBytes(request: unknown) {
      const record = typeof request === "object" && request != null ? request as Record<string, unknown> : {};
      const safeName = safeAttachmentFilename(record.filename);
      let payload = asAttachmentBytes(record.bytes) ?? asAttachmentBytes(record.bytesBase64);
      if ((payload == null || payload.byteLength === 0) && isReadableDropPath(record.sourcePath)) {
        try { payload = new Uint8Array(await readFile(record.sourcePath)); }
        catch (error) { report("stage-read", error); }
      }
      if (safeName == null || payload == null) return { ok: false as const, reason: "failed" as const };
      if (payload.byteLength === 0) return { ok: false as const, reason: "empty" as const };
      const downscaled = downscaleStagedImage(safeName, payload, deps.nativeImage);
      payload = downscaled.bytes;
      const stagedExtension = downscaled.extensionOverride ?? extname(safeName);
      if (payload.byteLength > deps.byteLimitForName(safeName)) return { ok: false as const, reason: "too-large" as const };
      // crypto.randomUUID brand-checks `this`; detaching it via ?? throws ERR_INVALID_THIS and fails every stage.
      try { const dir = deps.getStagingDir(); await mkdir(dir, { recursive: true }); const path = join(dir, `${(deps.now ?? Date.now)()}-${deps.randomUUID != null ? deps.randomUUID() : crypto.randomUUID()}${stagedExtension}`); await writeFile(path, payload); return { ok: true as const, path }; } catch (error) { report("stage", error); return { ok: false as const, reason: "failed" as const }; }
    },
    async commitStaged(rawPaths: unknown, rawFilenames: unknown): Promise<string[] | null> {
      const paths = Array.isArray(rawPaths) ? rawPaths : []; const filenames = Array.isArray(rawFilenames) ? rawFilenames : []; const committed: string[] = [];
      for (let index = 0; index < paths.length; index += 1) {
        const stagedPath = paths[index];
        const filename = safeAttachmentFilename(filenames[index]);
        if (typeof stagedPath !== "string" || stagedPath.length === 0 || filename == null || !deps.isWithinStagingDir(stagedPath)) return null;
        let bytes: Buffer;
        try { bytes = await readFile(stagedPath); } catch (error) { report("commit", error); return null; }
        if (bytes.byteLength === 0) return null;
        try {
          const uploaded = boxPathFromUploadResult(await deps.legs.uploadAttachment({ filename, bytesBase64: bytes.toString("base64") }));
          if (uploaded == null) { report("commit", new Error("uploadAttachment did not return a box path")); return null; }
          committed.push(uploaded);
        } catch (error) { report("commit", error); return null; }
      }
      return committed;
    },
    async discardStaged(stagedPath: unknown): Promise<void> { if (typeof stagedPath !== "string" || stagedPath.length === 0 || !deps.isWithinStagingDir(stagedPath)) return; await rm(stagedPath, { force: true }).catch((error: unknown) => report("discard", error)); },
    async getLinkMetadata(url: unknown) { if (typeof url !== "string") return null; const metadata = await deps.fetchLinkMetadata({ cacheDir: join(deps.getUserDataDir(), "link-preview-cache"), url }); if (metadata == null) return null; return { ...metadata, imageDataUrl: deps.boundPreviewImage(metadata.imageDataUrl, { maxDimension: LINK_PREVIEW_PHOTO_MAX_DIMENSION, encoding: "jpeg" }, (value, target, encoding) => resizePreviewImage(value, target, encoding, deps.nativeImage)), faviconDataUrl: deps.boundPreviewImage(metadata.faviconDataUrl, { maxDimension: LINK_PREVIEW_ICON_MAX_DIMENSION, encoding: "png" }, (value, target, encoding) => resizePreviewImage(value, target, encoding, deps.nativeImage)) }; },
    async download(source: unknown, suggestedName: unknown): Promise<boolean> {
      const path = normalizeAttachmentSource(source); if (path == null) return await failDownload("invalid-source");
      let probe: AttachmentChunk | null; try { probe = await deps.legs.readAttachmentChunk({ path, offset: 0, length: 0 }); } catch (error) { return await failDownload(errorClassOf(error)); } if (probe == null) return await failDownload("unavailable");
      try {
        const defaultPath = deps.resolveDefaultDownloadPath({ fileName: deps.resolveSuggestedDownloadName({ suggestedName, sourcePath: path }), configuredDir: null, osDownloadsDir: deps.downloadsDir }); const prompt = await deps.showSaveDialog(deps.getMainWindow() ?? deps.createHiddenWindow({ show: false }), { defaultPath }); if (prompt.canceled || prompt.filePath == null || prompt.filePath.length === 0) return false;
        let handle; try { handle = await open(prompt.filePath, "w"); } catch (error) { return await failDownload(errorClassOf(error)); }
        let offset = 0; let failure = "transfer-failed"; try { while (offset < probe.totalSize) { const chunk = await deps.legs.readAttachmentChunk({ path, offset, length: GATEWAY_READ_CHUNK_BYTES }); if (chunk == null) break; const bytes = Buffer.from(chunk.bytesBase64, "base64"); if (bytes.length === 0) break; await handle.write(bytes, 0, bytes.length, offset); offset += bytes.length; } } catch (error) { failure = errorClassOf(error); } finally { await handle.close(); }
        if (offset >= probe.totalSize) return true; try { await rm(prompt.filePath, { force: true }); } catch (error) { if (failure === "transfer-failed") failure = errorClassOf(error); } return await failDownload(failure);
      } catch (error) { return await failDownload(errorClassOf(error)); }
    },
  };
}
