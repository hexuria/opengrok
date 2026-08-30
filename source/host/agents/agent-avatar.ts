import { createHash } from "node:crypto";
import { constants, copyFileSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { reanchorSandPath } from "../host-paths.js";

export const CANONICAL_AVATAR_FILENAME = "avatar.png";
export const CONVENTIONAL_AVATAR_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "svg"] as const;
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const CONVENTIONAL_AVATAR_RE = new RegExp(`^avatar\\.(${CONVENTIONAL_AVATAR_EXTENSIONS.join("|")})$`, "i");

export function isConventionalAvatarFilename(name: string): boolean { return CONVENTIONAL_AVATAR_RE.test(name); }
export function conventionalAvatarRank(name: string): number { if (name === CANONICAL_AVATAR_FILENAME) return -1; const rank = CONVENTIONAL_AVATAR_EXTENSIONS.indexOf(extname(name).slice(1).toLowerCase() as typeof CONVENTIONAL_AVATAR_EXTENSIONS[number]); return rank === -1 ? CONVENTIONAL_AVATAR_EXTENSIONS.length : rank; }
export function listConventionalAvatarFilenames(agentDir: string): string[] { try { return readdirSync(agentDir).filter(isConventionalAvatarFilename).sort((a, b) => conventionalAvatarRank(a) - conventionalAvatarRank(b) || a.localeCompare(b)); } catch { return []; } }

export function sniffAvatarMimeType(bytes: Uint8Array): string | null {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((value, index) => bytes[index] === value)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.toString("latin1", 0, 6))) return "image/gif";
  if (bytes.length >= 12 && buffer.toString("latin1", 0, 4) === "RIFF" && buffer.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  const head = buffer.toString("utf8", 0, Math.min(bytes.length, 1024)).replace(/^\uFEFF/, "").trimStart().toLowerCase();
  return head.startsWith("<") && head.includes("<svg") ? "image/svg+xml" : null;
}

function isPathWithin(dir: string, target: string): boolean { const rel = relative(dir, target); return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); }
export function resolveAvatarPathWithinDir(agentDir: string, candidate: string | null | undefined): string | null {
  const trimmed = candidate?.trim(); if (!trimmed) return null;
  const anchored = isAbsolute(trimmed) ? reanchorSandPath(trimmed) : trimmed;
  const absolute = isAbsolute(anchored) ? anchored : resolve(agentDir, anchored);
  if (!isPathWithin(agentDir, absolute)) return null;
  try { const file = realpathSync(absolute); return isPathWithin(realpathSync(agentDir), file) ? file : null; } catch { return null; }
}

export function resolveDerivedAvatarFilename(agentDir: string, legacyFieldValue: string | null): string | null {
  const conventional = listConventionalAvatarFilenames(agentDir); if (conventional[0] != null) return conventional[0];
  const source = resolveAvatarPathWithinDir(agentDir, legacyFieldValue); if (source == null) return null;
  try {
    if (!statSync(source).isFile()) return null;
    const sourceExt = extname(source).slice(1).toLowerCase();
    const mimeExt: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg" };
    const extension = CONVENTIONAL_AVATAR_EXTENSIONS.includes(sourceExt as never) ? sourceExt : mimeExt[sniffAvatarMimeType(readFileSync(source)) ?? ""];
    if (extension == null) return legacyFieldValue;
    const name = `avatar.${extension}`; copyFileSync(source, join(agentDir, name), constants.COPYFILE_EXCL); return name;
  } catch { return legacyFieldValue; }
}

async function resolveAndStatAvatar(agentDir: string, candidate: string): Promise<{ path: string; mtimeMs: number; size: number } | null> { const path = resolveAvatarPathWithinDir(agentDir, candidate); if (path == null) return null; try { const info = await stat(path); return info.isFile() && info.size > 0 && info.size <= AVATAR_MAX_BYTES ? { path, mtimeMs: info.mtimeMs, size: info.size } : null; } catch { return null; } }
export async function readValidatedAvatar(agentDir: string, candidate: string): Promise<{ bytes: Buffer; mime: string } | null> { const meta = await resolveAndStatAvatar(agentDir, candidate); if (meta == null) return null; try { const bytes = await readFile(meta.path); const mime = sniffAvatarMimeType(bytes); return mime == null ? null : { bytes, mime }; } catch { return null; } }
export async function readAvatarBytesWithinDir(agentDir: string, candidate: string): Promise<Buffer | null> { return (await readValidatedAvatar(agentDir, candidate))?.bytes ?? null; }

const avatarDataUrlCache = new Map<string, { fingerprint: string; dataUrl: string; version: string }>();
export async function readAvatarWithinDir(agentDir: string, candidate: string): Promise<{ dataUrl: string; version: string } | null> {
  const meta = await resolveAndStatAvatar(agentDir, candidate); if (meta == null) return null;
  const key = `${agentDir}\0${meta.path}`; const fingerprint = `${meta.mtimeMs}:${meta.size}`; const cached = avatarDataUrlCache.get(key);
  if (cached?.fingerprint === fingerprint) { avatarDataUrlCache.delete(key); avatarDataUrlCache.set(key, cached); return { dataUrl: cached.dataUrl, version: cached.version }; }
  try { const bytes = await readFile(meta.path); const mime = sniffAvatarMimeType(bytes); if (mime == null) return null; const value = { fingerprint, dataUrl: `data:${mime};base64,${bytes.toString("base64")}`, version: createHash("sha256").update(bytes).digest("hex").slice(0, 16) }; avatarDataUrlCache.set(key, value); if (avatarDataUrlCache.size > 128) { const oldest = avatarDataUrlCache.keys().next().value; if (oldest != null && oldest !== key) avatarDataUrlCache.delete(oldest); } return { dataUrl: value.dataUrl, version: value.version }; } catch { return null; }
}
export function invalidateAvatarDataUrlCache(agentDir: string): void { const prefix = `${agentDir}\0`; for (const key of avatarDataUrlCache.keys()) if (key.startsWith(prefix)) avatarDataUrlCache.delete(key); }
