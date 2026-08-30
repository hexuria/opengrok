import * as fs from "node:fs";
import * as path from "node:path";

export interface UnsafeAgentStorePathErrorOptions {
  readonly code: string;
  readonly message: string;
  readonly relPath?: unknown;
  readonly failedPath?: string | undefined;
}

export class UnsafeAgentStorePathError extends Error {
  readonly code: string;
  readonly relPath: unknown;
  readonly failedPath: string | undefined;

  constructor(options: UnsafeAgentStorePathErrorOptions) {
    super(options.message);
    this.name = "UnsafeAgentStorePathError";
    this.code = options.code;
    this.relPath = options.relPath;
    this.failedPath = options.failedPath;
  }
}

export interface SafeAgentStoreFileEntry {
  readonly relPath: string;
  readonly absPath: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly dev: number;
  readonly ino: number;
}

export interface SafeAgentStoreRefusal {
  readonly relPath: string;
  readonly reason: "not_regular_file" | "symlink_refused";
}

export interface SafeAgentStoreWalkResult {
  readonly files: SafeAgentStoreFileEntry[];
  readonly refusals: SafeAgentStoreRefusal[];
}

export interface SafeAgentStoreFileSystem {
  lstatSync(path: fs.PathLike): fs.Stats;
  readdirSync(path: fs.PathLike, options: { readonly withFileTypes: true }): fs.Dirent[];
}

const MAX_SEGMENT_LENGTH_BYTES = 255;
const WINDOWS_RESERVED = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);
const WINDOWS_FORBIDDEN_FILENAME_CHARS = /[<>:"|?*]/;

export function normalizeRelPath(relPath: unknown): string {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new UnsafeAgentStorePathError({
      code: "empty_path",
      message: "Agent store relative path must be a non-empty string",
      relPath,
    });
  }
  if (relPath.includes("\0")) {
    throw new UnsafeAgentStorePathError({
      code: "invalid_segment",
      message: "Agent store relative path must not contain NUL bytes",
      relPath,
    });
  }
  if (path.posix.isAbsolute(relPath) || path.win32.isAbsolute(relPath)) {
    throw new UnsafeAgentStorePathError({
      code: "invalid_segment",
      message: `Agent store relative path must not be absolute: ${relPath}`,
      relPath,
    });
  }
  const rawSegments = relPath.replaceAll("\\", "/").split("/");
  const segments: string[] = [];
  for (const raw of rawSegments) {
    if (raw.length === 0 || raw === ".") continue;
    if (raw === "..") {
      throw new UnsafeAgentStorePathError({
        code: "invalid_segment",
        message: `Agent store relative path must not contain '..': ${relPath}`,
        relPath,
      });
    }
    assertSafeSegment({ segment: raw, relPath });
    segments.push(raw);
  }
  if (segments.length === 0) {
    throw new UnsafeAgentStorePathError({
      code: "empty_path",
      message: `Agent store relative path resolved to empty: ${relPath}`,
      relPath,
    });
  }
  return segments.join("/");
}

function validateRawSegmentName(name: string): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new UnsafeAgentStorePathError({
      code: "empty_path",
      message: "Agent store segment name must be a non-empty string",
      relPath: name,
    });
  }
  if (name === "." || name === "..") {
    throw new UnsafeAgentStorePathError({
      code: "invalid_segment",
      message: `Agent store segment name must not be '.' or '..': ${name}`,
      relPath: name,
    });
  }
  if (name.includes("/")) {
    throw new UnsafeAgentStorePathError({
      code: "invalid_segment",
      message: `Agent store segment name must not contain '/': ${name}`,
      relPath: name,
    });
  }
  if (name.includes("\\")) {
    throw new UnsafeAgentStorePathError({
      code: "invalid_segment",
      message: `Agent store segment name must not contain '\\\\': ${name}`,
      relPath: name,
    });
  }
  assertSafeSegment({ segment: name, relPath: name });
  return name;
}

function assertSafeSegment({ segment, relPath }: { segment: string; relPath: unknown }): void {
  if (Buffer.byteLength(segment, "utf8") > MAX_SEGMENT_LENGTH_BYTES) {
    throw new UnsafeAgentStorePathError({
      code: "invalid_segment",
      message: `Agent store path segment exceeds ${MAX_SEGMENT_LENGTH_BYTES} bytes: ${segment}`,
      relPath,
    });
  }
  for (let i = 0; i < segment.length; i += 1) {
    const code = segment.charCodeAt(i);
    if (code < 32 || code === 127) {
      throw new UnsafeAgentStorePathError({
        code: "invalid_segment",
        message: `Agent store path segment contains control character (0x${code.toString(16)}): ${segment}`,
        relPath,
      });
    }
  }
  const lastChar = segment.charAt(segment.length - 1);
  if (lastChar === "." || lastChar === " ") {
    throw new UnsafeAgentStorePathError({
      code: "invalid_segment",
      message: `Agent store path segment must not end with '.' or space (Windows trims these): ${segment}`,
      relPath,
    });
  }
  const stem = segment.toLowerCase().split(".")[0];
  if (stem !== undefined && WINDOWS_RESERVED.has(stem)) {
    throw new UnsafeAgentStorePathError({
      code: "reserved_name",
      message: `Agent store path segment uses a reserved device name: ${segment}`,
      relPath,
    });
  }
}

function hasWindowsIncompatibleFilenameChars(relPath: string): boolean {
  for (const segment of relPath.split("/")) {
    if (segment.length > 0 && WINDOWS_FORBIDDEN_FILENAME_CHARS.test(segment)) return true;
  }
  return false;
}

export function assertWindowsMaterializableRelPath({
  relPath,
  platform: platformName = process.platform,
}: {
  readonly relPath: string;
  readonly platform?: NodeJS.Platform | undefined;
}): void {
  if (platformName !== "win32" || !hasWindowsIncompatibleFilenameChars(relPath)) return;
  throw new UnsafeAgentStorePathError({
    code: "windows_incompatible",
    message: `Agent store path is not materializable on Windows (illegal filename character < > : " | ? *): ${relPath}`,
    relPath,
  });
}

export function resolveSafeChildPath({ base, relPath }: { readonly base: string; readonly relPath: unknown }): string {
  if (!path.isAbsolute(base)) {
    throw new UnsafeAgentStorePathError({
      code: "outside_base",
      message: `Agent store base must be absolute: ${base}`,
      relPath,
    });
  }
  const normalized = normalizeRelPath(relPath);
  const resolvedBase = path.resolve(base);
  const resolved = path.resolve(resolvedBase, normalized);
  if (!isEqualOrParent({ parent: resolvedBase, candidate: resolved })) {
    throw new UnsafeAgentStorePathError({
      code: "outside_base",
      message: `Agent store relative path resolves outside the base: ${relPath}`,
      relPath,
      failedPath: resolved,
    });
  }
  return resolved;
}

function isEqualOrParent({ parent, candidate }: { parent: string; candidate: string }): boolean {
  if (candidate === parent) return true;
  const withSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return candidate.startsWith(withSep);
}

export function safeWalk(
  base: string,
  options: { readonly fs?: SafeAgentStoreFileSystem | undefined } = {},
): SafeAgentStoreWalkResult {
  const fsModule = options.fs ?? fs;
  if (!path.isAbsolute(base)) {
    throw new UnsafeAgentStorePathError({
      code: "outside_base",
      message: `safeWalk base must be absolute: ${base}`,
      failedPath: base,
    });
  }
  const resolvedBase = path.resolve(base);
  assertAncestorChainNoSymlinks(resolvedBase, fsModule);
  const baseStat = fsModule.lstatSync(resolvedBase);
  if (baseStat.isSymbolicLink()) {
    throw new UnsafeAgentStorePathError({
      code: "symlink_refused",
      message: `Refusing to walk symlinked agent store base: ${resolvedBase}`,
      failedPath: resolvedBase,
    });
  }
  if (!baseStat.isDirectory()) {
    throw new UnsafeAgentStorePathError({
      code: "not_regular_file",
      message: `safeWalk base is not a directory: ${resolvedBase}`,
      failedPath: resolvedBase,
    });
  }
  const result: SafeAgentStoreWalkResult = { files: [], refusals: [] };
  walkDirectory({
    fsModule,
    absDir: resolvedBase,
    relDir: "",
    base: resolvedBase,
    result,
    expectedDev: baseStat.dev,
    expectedIno: baseStat.ino,
  });
  return result;
}

export type SafeStatChildResult =
  | { readonly kind: "absent" }
  | { readonly kind: "refused"; readonly refusal: SafeAgentStoreRefusal }
  | { readonly kind: "file"; readonly entry: SafeAgentStoreFileEntry };

export function safeStatChild({
  base,
  relPath,
  fs: fsOverride,
}: {
  readonly base: string;
  readonly relPath: unknown;
  readonly fs?: SafeAgentStoreFileSystem | undefined;
}): SafeStatChildResult {
  const fsModule = fsOverride ?? fs;
  const absPath = resolveSafeChildPath({ base, relPath });
  const resolvedBase = path.resolve(base);
  assertAncestorChainNoSymlinks(resolvedBase, fsModule);
  const baseStat = fsModule.lstatSync(resolvedBase);
  if (baseStat.isSymbolicLink()) {
    throw new UnsafeAgentStorePathError({
      code: "symlink_refused",
      message: `Refusing to stat under symlinked agent store base: ${resolvedBase}`,
      failedPath: resolvedBase,
    });
  }
  if (!baseStat.isDirectory()) {
    throw new UnsafeAgentStorePathError({
      code: "not_regular_file",
      message: `Agent store base is not a directory: ${resolvedBase}`,
      failedPath: resolvedBase,
    });
  }
  const normalized = normalizeRelPath(relPath);
  const segments = normalized.split("/");
  let currentAbs = resolvedBase;
  let currentRel = "";
  const intermediates: Array<{ abs: string; rel: string; dev: number; ino: number }> = [];
  for (const segment of segments.slice(0, -1)) {
    currentAbs = path.join(currentAbs, segment);
    currentRel = currentRel.length === 0 ? segment : `${currentRel}/${segment}`;
    let stat: fs.Stats;
    try {
      stat = fsModule.lstatSync(currentAbs);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return { kind: "absent" };
      throw error;
    }
    if (stat.isSymbolicLink()) return { kind: "refused", refusal: { relPath: currentRel, reason: "symlink_refused" } };
    if (!stat.isDirectory()) return { kind: "refused", refusal: { relPath: currentRel, reason: "not_regular_file" } };
    intermediates.push({ abs: currentAbs, rel: currentRel, dev: stat.dev, ino: stat.ino });
  }
  for (const intermediate of intermediates) {
    let postStat: fs.Stats;
    try {
      postStat = fsModule.lstatSync(intermediate.abs);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return { kind: "absent" };
      throw error;
    }
    if (postStat.isSymbolicLink() || !postStat.isDirectory() || postStat.dev !== intermediate.dev || postStat.ino !== intermediate.ino) {
      return {
        kind: "refused",
        refusal: {
          relPath: intermediate.rel,
          reason: postStat.isSymbolicLink() ? "symlink_refused" : "not_regular_file",
        },
      };
    }
  }
  let leafStat: fs.Stats;
  try {
    leafStat = fsModule.lstatSync(absPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { kind: "absent" };
    throw error;
  }
  if (leafStat.isSymbolicLink()) return { kind: "refused", refusal: { relPath: normalized, reason: "symlink_refused" } };
  if (!leafStat.isFile()) return { kind: "refused", refusal: { relPath: normalized, reason: "not_regular_file" } };
  return {
    kind: "file",
    entry: {
      relPath: normalized,
      absPath,
      size: leafStat.size,
      mtimeMs: leafStat.mtimeMs,
      dev: leafStat.dev,
      ino: leafStat.ino,
    },
  };
}

function walkDirectory({
  fsModule,
  absDir,
  relDir,
  base,
  result,
  expectedDev,
  expectedIno,
}: {
  readonly fsModule: SafeAgentStoreFileSystem;
  readonly absDir: string;
  readonly relDir: string;
  readonly base: string;
  readonly result: SafeAgentStoreWalkResult;
  readonly expectedDev: number;
  readonly expectedIno: number;
}): void {
  let entries: fs.Dirent[];
  try {
    entries = fsModule.readdirSync(absDir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      result.refusals.push({ relPath: relDir.length === 0 ? "." : relDir, reason: "not_regular_file" });
      return;
    }
    throw error;
  }
  let postStat: fs.Stats;
  try {
    postStat = fsModule.lstatSync(absDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      result.refusals.push({ relPath: relDir.length === 0 ? "." : relDir, reason: "not_regular_file" });
      return;
    }
    throw error;
  }
  if (postStat.isSymbolicLink() || !postStat.isDirectory() || postStat.dev !== expectedDev || postStat.ino !== expectedIno) {
    result.refusals.push({
      relPath: relDir.length === 0 ? "." : relDir,
      reason: postStat.isSymbolicLink() ? "symlink_refused" : "not_regular_file",
    });
    return;
  }
  for (const entry of entries) {
    if (entry.name === "." || entry.name === "..") continue;
    let segment: string;
    try {
      segment = validateRawSegmentName(entry.name);
    } catch (_error) {
      result.refusals.push({ relPath: posixJoin({ dir: relDir, segment: entry.name }), reason: "not_regular_file" });
      continue;
    }
    const childRel = posixJoin({ dir: relDir, segment });
    const childAbs = path.join(absDir, segment);
    if (!isEqualOrParent({ parent: base, candidate: childAbs })) {
      result.refusals.push({ relPath: childRel, reason: "not_regular_file" });
      continue;
    }
    let childStat: fs.Stats;
    try {
      childStat = fsModule.lstatSync(childAbs);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw error;
    }
    if (childStat.isSymbolicLink()) {
      result.refusals.push({ relPath: childRel, reason: "symlink_refused" });
      continue;
    }
    if (childStat.isDirectory()) {
      walkDirectory({
        fsModule,
        absDir: childAbs,
        relDir: childRel,
        base,
        result,
        expectedDev: childStat.dev,
        expectedIno: childStat.ino,
      });
      continue;
    }
    if (!childStat.isFile()) {
      result.refusals.push({ relPath: childRel, reason: "not_regular_file" });
      continue;
    }
    result.files.push({
      relPath: childRel,
      absPath: childAbs,
      size: childStat.size,
      mtimeMs: childStat.mtimeMs,
      dev: childStat.dev,
      ino: childStat.ino,
    });
  }
}

function posixJoin({ dir, segment }: { readonly dir: string; readonly segment: string }): string {
  return dir.length === 0 ? segment : `${dir}/${segment}`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
}

function assertAncestorChainNoSymlinks(absPath: string, fsModule: SafeAgentStoreFileSystem): void {
  const parsed = path.parse(absPath);
  const tail = absPath.slice(parsed.root.length);
  const segments = tail.split(path.sep).filter(segment => segment.length > 0);
  let current = parsed.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fsModule.lstatSync(current);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new UnsafeAgentStorePathError({
        code: "symlink_refused",
        message: `Refusing to walk agent store path whose ancestor is a symlink: ${current}`,
        failedPath: current,
      });
    }
  }
}
