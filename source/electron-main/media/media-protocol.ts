import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { getSandRootDir, reanchorSandPath } from "../../host/host-paths.js";
import { audioMimeFromPath, imageMimeFromPath, videoMimeFromPath } from "../../shared/media/image-mime.js";

export const SAND_MEDIA_SCHEME = "sand-media";
export const MEDIA_HOST = "attachment";
export const REMOTE_MEDIA_CHUNK_BYTES = 4 * 1024 * 1024;

export interface SandMediaRemoteReader { readChunk(path: string, offset: number, length: number, videoPlayback: boolean): Promise<{ data: Uint8Array; totalSize: number; mime?: string | null } | null> }
interface SandMediaProtocol {
  registerSchemesAsPrivileged(schemes: unknown[]): void;
  handle(scheme: string, handler: (request: Request) => Promise<Response>): void;
}
let remoteReader: SandMediaRemoteReader | null = null;
const remoteMetaCache = new Map<string, { size: number; mime: string }>();
export function setSandMediaRemoteReader(reader: SandMediaRemoteReader | null): void { remoteReader = reader; }

export function buildSandMediaUrl(filePath: string): string { return `${SAND_MEDIA_SCHEME}://${MEDIA_HOST}/${encodeURIComponent(filePath)}`; }
export function parseSandMediaUrl(rawUrl: string): string | null {
  let url: URL; try { url = new URL(rawUrl); } catch { return null; }
  if (url.protocol !== `${SAND_MEDIA_SCHEME}:`) return null;
  const segment = url.pathname.replace(/^\/+/, ""); if (segment.length === 0) return null;
  try { return decodeURIComponent(segment); } catch { return null; }
}
export function parseRangeHeader(header: string | null, size: number): { start: number; end: number } | null {
  if (header == null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim()); if (match == null) return null;
  const startRaw = match[1] ?? ""; const endRaw = match[2] ?? ""; if (startRaw.length === 0 && endRaw.length === 0) return null;
  let start: number; let end: number;
  if (startRaw.length === 0) { const suffix = Number.parseInt(endRaw, 10); if (!Number.isFinite(suffix) || suffix <= 0) return null; start = Math.max(0, size - suffix); end = size - 1; }
  else { start = Number.parseInt(startRaw, 10); end = endRaw.length > 0 ? Number.parseInt(endRaw, 10) : size - 1; }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}
const notFound = (): Response => new Response(null, { status: 404 });

/** Downscaled tile variants: ?w=<px> on an image URL serves a resized copy so 200px tiles stop decoding and uploading full-resolution screenshots. GIFs are excluded (resizing flattens animation); alpha-capable sources resize to PNG, opaque JPEG sources to JPEG. */
const RESIZE_CACHE_CAP_BYTES = 48 * 1024 * 1024;
const resizedCache = new Map<string, { bytes: Buffer; mime: string }>();
let resizedCacheBytes = 0;

export function parseSandMediaResizeWidth(rawUrl: string): number | null {
  try {
    const value = new URL(rawUrl).searchParams.get("w");
    if (value == null) return null;
    const width = Number.parseInt(value, 10);
    return Number.isFinite(width) && width >= 32 && width <= 2048 ? width : null;
  } catch { return null; }
}

function rememberResized(key: string, entry: { bytes: Buffer; mime: string }): void {
  if (entry.bytes.byteLength > RESIZE_CACHE_CAP_BYTES) return;
  while (resizedCacheBytes + entry.bytes.byteLength > RESIZE_CACHE_CAP_BYTES) {
    const oldest = resizedCache.keys().next().value;
    if (oldest == null) break;
    resizedCacheBytes -= resizedCache.get(oldest)!.bytes.byteLength;
    resizedCache.delete(oldest);
  }
  resizedCache.set(key, entry);
  resizedCacheBytes += entry.bytes.byteLength;
}

/** PNG/WebP sources keep PNG only when transparency is actually present; opaque screenshots get the far smaller JPEG. */
export function chooseVariantMime(sourceMime: string, hasAlpha: boolean): string {
  return sourceMime !== "image/jpeg" && hasAlpha ? "image/png" : "image/jpeg";
}

interface ScaledImage { isEmpty(): boolean; toJPEG(q: number): Buffer; toPNG(): Buffer; toBitmap(): Buffer }

function bitmapHasAlpha(scaled: ScaledImage): boolean {
  try {
    const bitmap = scaled.toBitmap();
    for (let i = 3; i < bitmap.length; i += 4 * 64) if (bitmap[i] !== 255) return true;
    return false;
  } catch { return true; }
}

function resizeImageBytes(bytes: Buffer, width: number, sourceMime: string): { bytes: Buffer; mime: string } | null {
  try {
    const { nativeImage } = require("electron") as { nativeImage: { createFromBuffer(b: Buffer): { isEmpty(): boolean; getSize(): { width: number }; resize(o: { width: number; quality: string }): ScaledImage } } };
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty() || image.getSize().width <= width) return null;
    const scaled = image.resize({ width, quality: "good" });
    if (scaled.isEmpty()) return null;
    const mime = chooseVariantMime(sourceMime, sourceMime !== "image/jpeg" && bitmapHasAlpha(scaled));
    return { bytes: mime === "image/jpeg" ? scaled.toJPEG(82) : scaled.toPNG(), mime };
  } catch { return null; }
}

/**
 * Variants persist to disk so each image is decoded and resized once ever;
 * later loads (including after app restart) stream the small file instead of
 * re-computing. Names are content-addressed (attachment filenames are content
 * hashes), so entries never go stale; a size sweep bounds the directory.
 */
const VARIANT_DIR_CAP_BYTES = 256 * 1024 * 1024;
let variantDirPromise: Promise<string | null> | null = null;
function variantDir(): Promise<string | null> {
  variantDirPromise ??= (async () => {
    try {
      const dir = join(getSandRootDir(), "media-variants");
      await fs.mkdir(dir, { recursive: true });
      void sweepVariantDir(dir);
      return dir;
    } catch { return null; }
  })();
  return variantDirPromise;
}

async function sweepVariantDir(dir: string): Promise<void> {
  try {
    const entries = await Promise.all((await fs.readdir(dir)).map(async (name) => {
      const stat = await fs.stat(join(dir, name)).catch(() => null);
      return stat?.isFile() ? { name, size: stat.size, mtime: stat.mtimeMs } : null;
    }));
    const files = entries.filter((entry): entry is NonNullable<typeof entry> => entry != null).sort((a, b) => a.mtime - b.mtime);
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files) {
      if (total <= VARIANT_DIR_CAP_BYTES) break;
      await fs.rm(join(dir, file.name), { force: true });
      total -= file.size;
    }
  } catch { /* a failed sweep never blocks serving */ }
}

function variantBasename(rawPath: string, width: number): string {
  return createHash("sha1").update(rawPath).update(`|w=${width}`).digest("hex");
}

/** A fast scroll must not fan out into unbounded concurrent decodes; two at a time keeps first-view latency low without saturating the CPU. */
let resizeSlots = 0;
const resizeWaiters: Array<() => void> = [];
async function withResizeSlot<T>(work: () => Promise<T>): Promise<T> {
  if (resizeSlots >= 2) await new Promise<void>((resolve) => resizeWaiters.push(resolve));
  resizeSlots += 1;
  try { return await work(); } finally { resizeSlots -= 1; resizeWaiters.shift()?.(); }
}

function resizedResponse(bytes: Buffer, mime: string): Response {
  return new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": mime, "content-length": String(bytes.byteLength), "cache-control": "public, max-age=31536000, immutable" } });
}

async function serveResizedImage(rawPath: string, width: number, sourceMime: string, loadFull: () => Promise<Buffer | null>): Promise<Response | null> {
  const key = `${rawPath}#w=${width}`;
  const cached = resizedCache.get(key);
  if (cached != null) {
    // Refresh recency so hot tiles survive cache pressure (true LRU, not FIFO).
    resizedCache.delete(key);
    resizedCache.set(key, cached);
    return resizedResponse(cached.bytes, cached.mime);
  }
  const dir = await variantDir();
  const base = dir == null ? null : join(dir, variantBasename(rawPath, width));
  if (base != null) {
    for (const [extension, mime] of [[".jpg", "image/jpeg"], [".png", "image/png"]] as const) {
      const fromDisk = await fs.readFile(base + extension).catch(() => null);
      if (fromDisk != null) {
        rememberResized(key, { bytes: fromDisk, mime });
        return resizedResponse(fromDisk, mime);
      }
    }
  }
  const resized = await withResizeSlot(async () => {
    const full = await loadFull();
    return full == null ? null : resizeImageBytes(full, width, sourceMime);
  });
  if (resized == null) return null;
  rememberResized(key, resized);
  if (base != null) void fs.writeFile(base + (resized.mime === "image/png" ? ".png" : ".jpg"), resized.bytes).catch(() => undefined);
  return resizedResponse(resized.bytes, resized.mime);
}

async function resolveRemoteMeta(reader: SandMediaRemoteReader, rawPath: string, videoPlayback: boolean) {
  const cached = videoPlayback ? undefined : remoteMetaCache.get(rawPath); if (cached != null) return cached;
  const probe = await reader.readChunk(rawPath, 0, 0, videoPlayback); if (probe?.mime == null || probe.totalSize <= 0) return null;
  const meta = { size: probe.totalSize, mime: probe.mime }; if (!videoPlayback) remoteMetaCache.set(rawPath, meta); return meta;
}
export async function handleRemoteMediaRequest(reader: SandMediaRemoteReader, rawPath: string, request: Request): Promise<Response> {
  const videoPlayback = videoMimeFromPath(rawPath) != null;
  const meta = await resolveRemoteMeta(reader, rawPath, videoPlayback); if (meta == null) return notFound();
  const range = parseRangeHeader(request.headers.get("range"), meta.size); const start = range?.start ?? 0; const requestedEnd = range?.end ?? meta.size - 1;
  const chunk = await reader.readChunk(rawPath, start, Math.min(requestedEnd - start + 1, REMOTE_MEDIA_CHUNK_BYTES), videoPlayback); if (chunk == null) return notFound();
  if (chunk.totalSize <= 0 || start >= chunk.totalSize || chunk.data.length === 0) return new Response(null, { status: 416, headers: { "accept-ranges": "bytes", "content-range": `bytes */${Math.max(0, chunk.totalSize)}` } });
  const end = start + chunk.data.length - 1; const partial = range != null || end < chunk.totalSize - 1 || start > 0;
  const contentType = chunk.mime ?? meta.mime;
  const headers = new Headers({ "content-type": contentType, "content-length": String(chunk.data.length), "accept-ranges": "bytes", "cache-control": contentType.startsWith("image/") ? "public, max-age=31536000, immutable" : "no-cache" });
  if (partial) headers.set("content-range", `bytes ${start}-${end}/${chunk.totalSize}`);
  return new Response(new Uint8Array(chunk.data), { status: partial ? 206 : 200, headers });
}
export async function serveLocalMedia(rawPath: string, request: Request, reanchor: (path: string) => string = reanchorSandPath): Promise<Response | null> {
  const filePath = reanchor(rawPath); const mime = videoMimeFromPath(filePath) ?? audioMimeFromPath(filePath) ?? imageMimeFromPath(filePath); if (mime == null) return null;
  let size: number; try { const stat = await fs.stat(filePath); if (!stat.isFile()) return null; size = stat.size; } catch { return null; }
  const range = parseRangeHeader(request.headers.get("range"), size); const start = range?.start ?? 0; const end = range?.end ?? size - 1;
  const headers = new Headers({ "content-type": mime, "content-length": String(end - start + 1), "accept-ranges": "bytes", "cache-control": mime.startsWith("image/") ? "public, max-age=31536000, immutable" : "no-cache" });
  if (range != null) headers.set("content-range", `bytes ${start}-${end}/${size}`);
  return new Response(Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream, { status: range != null ? 206 : 200, headers });
}
export async function handleSandMediaRequest(request: Request): Promise<Response> {
  const rawPath = parseSandMediaUrl(request.url); if (rawPath == null) return new Response(null, { status: 400 });
  const resizeWidth = parseSandMediaResizeWidth(request.url);
  const sourceImageMime = imageMimeFromPath(rawPath);
  // GIFs skip resizing: a nativeImage resize would flatten animation to one frame.
  if (resizeWidth != null && sourceImageMime != null && sourceImageMime !== "image/gif") {
    const resized = await serveResizedImage(rawPath, resizeWidth, sourceImageMime, async () => {
      const filePath = reanchorSandPath(rawPath);
      try { const stat = await fs.stat(filePath); if (stat.isFile()) return Buffer.from(await fs.readFile(filePath)); } catch { /* fall through to remote */ }
      if (remoteReader == null) return null;
      const probe = await remoteReader.readChunk(rawPath, 0, 0, false); if (probe == null || probe.totalSize <= 0) return null;
      const chunks: Buffer[] = []; let offset = 0;
      while (offset < probe.totalSize) {
        const chunk = await remoteReader.readChunk(rawPath, offset, REMOTE_MEDIA_CHUNK_BYTES, false);
        if (chunk == null || chunk.data.length === 0) return null;
        chunks.push(Buffer.from(chunk.data)); offset += chunk.data.length;
      }
      return Buffer.concat(chunks);
    });
    if (resized != null) return resized;
  }
  const local = await serveLocalMedia(rawPath, request); if (local != null) return local;
  return remoteReader == null ? notFound() : await handleRemoteMediaRequest(remoteReader, rawPath, request);
}
function electronMediaProtocol(): SandMediaProtocol {
  return (require("electron") as { readonly protocol: SandMediaProtocol }).protocol;
}
// corsEnabled is required: transcript img/video request sand-media in CORS
// mode (crossOrigin="anonymous" for canvas capture); without it Electron
// blocks those requests outright and every image falls back to the broken
// widget.
export function registerSandMediaScheme(protocol: SandMediaProtocol = electronMediaProtocol()): void { protocol.registerSchemesAsPrivileged([{ scheme: SAND_MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]); }
export function registerSandMediaProtocol(protocol: SandMediaProtocol = electronMediaProtocol()): void {
  protocol.handle(SAND_MEDIA_SCHEME, async (request) => {
    const response = await handleSandMediaRequest(request);
    // The renderer requests sand-media images/videos in CORS mode so canvas
    // capture (blur-up previews) is allowed; without this header those
    // requests would fail outright.
    try { response.headers.set("access-control-allow-origin", "*"); } catch { /* a guarded header set must not break serving */ }
    return response;
  });
}
