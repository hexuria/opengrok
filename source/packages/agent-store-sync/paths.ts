import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AGENT_STORE_RESERVED_CURSOR_PATH_PREFIX,
  isAgentStoreId,
  isAgentStoreShareMountKey,
  isCloudAgentStoreId,
  isValidBareUuid,
  parseTeamAgentStoreSourceId,
  parseUserAgentStoreSourceId,
} from "../constants/agent-store-ids.js";

export const AGENT_STORE_SYNC_DIR_NAME = ".sync";

export function isReservedRelPath(relPath: string): boolean {
  return relPath.split("/").some(isReservedRelPathSegment);
}

export function isReservedRelPathSegment(segment: string): boolean {
  return segment.slice(0, AGENT_STORE_RESERVED_CURSOR_PATH_PREFIX.length).toLowerCase()
    === AGENT_STORE_RESERVED_CURSOR_PATH_PREFIX;
}

export const AGENT_STORE_CONFLICT_EVENTS_FILE_NAME = "conflict-events.jsonl";
export const AGENT_STORE_CONFLICT_PENDING_FILE_NAME = "conflict-events.pending.jsonl";
const PRIVATE_DIR_MODE = 0o700;

export type AgentStoreSourceKind = "user" | "team" | "cloud" | "local" | "store" | "unknown";

export function classifyAgentStoreSourceId(sourceId: string): AgentStoreSourceKind {
  if (parseUserAgentStoreSourceId(sourceId) !== undefined) return "user";
  if (parseTeamAgentStoreSourceId(sourceId) !== undefined) return "team";
  if (isCloudAgentStoreId(sourceId)) return "cloud";
  if (isValidBareUuid(sourceId)) return "local";
  if (isAgentStoreId(sourceId) || isAgentStoreShareMountKey(sourceId)) return "store";
  return "unknown";
}

export type AgentStorePathErrorCode = "symlink_refused" | "invalid_store_base" | "not_directory";

export class AgentStorePathError extends Error {
  readonly code: AgentStorePathErrorCode;
  readonly failedPath: string;

  constructor(options: { code: AgentStorePathErrorCode; message: string; failedPath: string }) {
    super(options.message);
    this.name = "AgentStorePathError";
    this.code = options.code;
    this.failedPath = options.failedPath;
  }
}

type PathFs = Pick<typeof fs, "lstatSync" | "mkdirSync">;

export interface AgentStorePathOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly fs?: PathFs;
  readonly geteuid?: (() => number) | undefined;
  readonly osTmpdir?: () => string;
  readonly path?: typeof path;
  readonly platform?: NodeJS.Platform;
  readonly windowsAcl?: Record<string, unknown>;
  readonly trustedBase?: string;
}

interface ResolvedPathDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly fs: PathFs;
  readonly geteuid: (() => number) | undefined;
  readonly osTmpdir: () => string;
  readonly path: typeof path;
  readonly platform: NodeJS.Platform;
  readonly windowsAcl: Record<string, unknown>;
}

export function assertNoSymlinkInPath(targetPath: string, options: AgentStorePathOptions = {}): void {
  const deps = getDeps(options);
  const resolved = deps.path.resolve(targetPath);
  const segments = getPathSegments(resolved, deps.path);
  for (const segment of segments) {
    const stat = tryLstat(segment, deps.fs);
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      throw new AgentStorePathError({
        code: "symlink_refused",
        message: `Refusing to use symlinked agent store path: ${segment}`,
        failedPath: segment,
      });
    }
  }
}

export function ensureSecureDirectoryChain(targetDir: string, options: AgentStorePathOptions = {}): void {
  const deps = getDeps(options);
  const resolvedTarget = deps.path.resolve(targetDir);
  const trustedBase = options.trustedBase !== undefined
    ? deps.path.resolve(options.trustedBase)
    : findTrustedDirectoryAncestor(resolvedTarget, deps);
  if (resolvedTarget === trustedBase) {
    assertRealDirectorySegment(trustedBase, deps);
    return;
  }
  const relative = deps.path.relative(trustedBase, resolvedTarget);
  if (relative.length === 0 || relative.startsWith("..") || deps.path.isAbsolute(relative)) {
    throw new AgentStorePathError({
      code: "invalid_store_base",
      message: `Refusing to create ${resolvedTarget} outside trusted base ${trustedBase}`,
      failedPath: resolvedTarget,
    });
  }
  const segments = relative.split(deps.path.sep).filter((segment) => segment.length > 0);
  let current = trustedBase;
  for (const segment of segments) {
    assertRealDirectorySegment(current, deps);
    current = deps.path.join(current, segment);
    ensureRealDirectorySegment(current, deps);
  }
}

function getDeps(options: AgentStorePathOptions): ResolvedPathDeps {
  return {
    env: options.env ?? process.env,
    fs: options.fs ?? fs,
    geteuid: options.geteuid ?? process.geteuid?.bind(process),
    osTmpdir: options.osTmpdir ?? os.tmpdir,
    path: options.path ?? path,
    platform: options.platform ?? process.platform,
    windowsAcl: options.windowsAcl ?? {},
  };
}

function assertDirectoryStat(targetPath: string, stat: fs.Stats): void {
  if (stat.isSymbolicLink()) {
    throw new AgentStorePathError({
      code: "symlink_refused",
      message: `Refusing to use symlinked agent store path: ${targetPath}`,
      failedPath: targetPath,
    });
  }
  if (!stat.isDirectory()) {
    throw new AgentStorePathError({
      code: "not_directory",
      message: `Agent store path is not a directory: ${targetPath}`,
      failedPath: targetPath,
    });
  }
}

function findTrustedDirectoryAncestor(targetPath: string, deps: ResolvedPathDeps): string {
  const segments = getPathSegments(deps.path.resolve(targetPath), deps.path);
  let trusted = segments[0] ?? deps.path.resolve(targetPath);
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) continue;
    const stat = tryLstat(segment, deps.fs);
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      throw new AgentStorePathError({
        code: "symlink_refused",
        message: `Refusing to use symlinked agent store path: ${segment}`,
        failedPath: segment,
      });
    }
    if (!stat.isDirectory()) {
      throw new AgentStorePathError({
        code: "not_directory",
        message: `Agent store path is not a directory: ${segment}`,
        failedPath: segment,
      });
    }
    trusted = segment;
  }
  return trusted;
}

function assertRealDirectorySegment(targetPath: string, deps: ResolvedPathDeps): void {
  const stat = tryLstat(targetPath, deps.fs);
  if (!stat) {
    throw new AgentStorePathError({
      code: "not_directory",
      message: `Trusted directory does not exist: ${targetPath}`,
      failedPath: targetPath,
    });
  }
  assertDirectoryStat(targetPath, stat);
}

function ensureRealDirectorySegment(targetPath: string, deps: ResolvedPathDeps): void {
  let stat = tryLstat(targetPath, deps.fs);
  if (!stat) {
    try {
      deps.fs.mkdirSync(targetPath, { mode: PRIVATE_DIR_MODE });
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }
    stat = tryLstat(targetPath, deps.fs);
    if (!stat) {
      throw new AgentStorePathError({
        code: "not_directory",
        message: `Failed to create directory: ${targetPath}`,
        failedPath: targetPath,
      });
    }
  }
  assertDirectoryStat(targetPath, stat);
}

function getPathSegments(targetPath: string, pathModule: typeof path): string[] {
  const root = pathModule.parse(targetPath).root;
  const rest = targetPath.slice(root.length);
  const parts = rest.split(/[\\/]+/).filter(Boolean);
  const segments: string[] = [];
  let current = root;
  if (root) segments.push(root);
  for (const part of parts) {
    current = current === root ? pathModule.join(root, part) : pathModule.join(current, part);
    segments.push(current);
  }
  return segments;
}

function tryLstat(targetPath: string, fsModule: PathFs): fs.Stats | undefined {
  try {
    return fsModule.lstatSync(targetPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
}
