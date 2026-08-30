import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const VIDEO_TOOL_TIMEOUT_MS = 2 * 60 * 1_000;
export const MAX_CACHED_RENDITIONS = 8;
export const FAILED_RESOLUTION_RETRY_MS = 30_000;
const renditionCacheDir = join(tmpdir(), `sand-video-playback-${process.pid}`);
interface Resolution { readonly renditionPath: string; readonly promise: Promise<string | null>; activeReaders: number; evicted: boolean; retryAfter?: number }
const playbackResolutionBySourceVersion = new Map<string, Resolution>();
let activeTranscodes = 0; const waiting: Array<() => void> = [];
async function withTranscodeSlot<T>(run: () => Promise<T>): Promise<T> { if (activeTranscodes >= 2) await new Promise<void>((resolve) => waiting.push(resolve)); activeTranscodes += 1; try { return await run(); } finally { activeTranscodes -= 1; waiting.shift()?.(); } }
function removeEvictedRendition(resolution: Resolution): void { if (!resolution.evicted || resolution.activeReaders > 0) return; void resolution.promise.then(async () => { await Promise.allSettled([fs.rm(resolution.renditionPath, { force: true })]); }); }
export async function runVideoTool(command: string, args: readonly string[]): Promise<string> { return await new Promise((resolve, reject) => execFile(command, [...args], { encoding: "utf8", maxBuffer: 64 * 1024, timeout: VIDEO_TOOL_TIMEOUT_MS }, (error, stdout) => error == null ? resolve(stdout) : reject(error))); }
async function hasPlaybackRendition(path: string): Promise<boolean> { try { const info = await fs.stat(path); return info.isFile() && info.size > 0; } catch { return false; } }
export async function createVideoPlaybackSource(sourcePath: string, renditionPath: string): Promise<string | null> {
  let codec: string; try { codec = (await runVideoTool("ffprobe", ["-v","error","-select_streams","v:0","-show_entries","stream=codec_name","-of","default=noprint_wrappers=1:nokey=1","-protocol_whitelist","file",sourcePath])).trim().toLowerCase(); } catch { return null; }
  if (codec !== "hevc") return sourcePath; if (await hasPlaybackRendition(renditionPath)) return renditionPath;
  return await withTranscodeSlot(async () => {
    if (await hasPlaybackRendition(renditionPath)) return renditionPath; await fs.mkdir(renditionCacheDir, { recursive: true }); const tempPath = `${renditionPath}.${randomUUID()}.tmp.mp4`;
    try { await runVideoTool("ffmpeg", ["-v","error","-nostdin","-y","-protocol_whitelist","file","-i",sourcePath,"-map","0:v:0","-map","0:a:0?","-c:v","libx264","-threads","2","-preset","veryfast","-crf","23","-pix_fmt","yuv420p","-c:a","aac","-b:a","128k","-movflags","+faststart",tempPath]); const info = await fs.stat(tempPath); if (!info.isFile() || info.size <= 0) return null; await fs.rename(tempPath, renditionPath); return renditionPath; }
    catch { return null; } finally { await Promise.allSettled([fs.rm(tempPath, { force: true })]); }
  });
}
export async function withVideoPlaybackSource<T>(sourcePath: string, read: (resolvedPath: string) => Promise<T>): Promise<T> {
  let sourceVersion: string; try { const info = await fs.stat(sourcePath); if (!info.isFile()) return await read(sourcePath); sourceVersion = createHash("sha256").update(sourcePath).update("\0").update(String(info.size)).update("\0").update(String(info.mtimeMs)).digest("hex"); } catch { return await read(sourcePath); }
  let resolution = playbackResolutionBySourceVersion.get(sourceVersion);
  if (resolution != null) { if (resolution.retryAfter == null || resolution.retryAfter > Date.now()) { playbackResolutionBySourceVersion.delete(sourceVersion); playbackResolutionBySourceVersion.set(sourceVersion, resolution); } else { playbackResolutionBySourceVersion.delete(sourceVersion); resolution.evicted = true; removeEvictedRendition(resolution); resolution = undefined; } }
  if (resolution == null) { const renditionPath = join(renditionCacheDir, `${sourceVersion}.${randomUUID()}.mp4`); const created: Resolution = { renditionPath, promise: createVideoPlaybackSource(sourcePath, renditionPath), activeReaders: 0, evicted: false }; resolution = created; playbackResolutionBySourceVersion.set(sourceVersion, created); void created.promise.then((value) => { if (value == null) created.retryAfter = Date.now() + FAILED_RESOLUTION_RETRY_MS; }); while (playbackResolutionBySourceVersion.size > MAX_CACHED_RENDITIONS) { const oldestKey = playbackResolutionBySourceVersion.keys().next().value as string | undefined; if (oldestKey == null) break; const oldest = playbackResolutionBySourceVersion.get(oldestKey); playbackResolutionBySourceVersion.delete(oldestKey); if (oldest != null) { oldest.evicted = true; removeEvictedRendition(oldest); } } }
  resolution.activeReaders += 1; try { return await read(await resolution.promise ?? sourcePath); } finally { resolution.activeReaders -= 1; removeEvictedRendition(resolution); }
}
