import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertNoSymlinkInPath, ensureSecureDirectoryChain } from "./paths.js";
import { writeLockFileExclusive } from "./secure-open.js";

export const STORE_LOCK_MTIME_UPDATE_MS = 1_000;
export const STORE_LOCK_STALE_MS = 10 * 60 * 1_000;
const PRIVATE_LOCKFILE_MODE = 0o600;

export type StoreLockErrorCode = "missing_identity" | "invalid_lockfile" | "foreign_identity_lock";

export class StoreLockError extends Error {
  readonly code: StoreLockErrorCode;
  readonly lockPath: string;

  constructor(options: { code: StoreLockErrorCode; message: string; lockPath: string }) {
    super(options.message);
    this.code = options.code;
    this.lockPath = options.lockPath;
    this.name = "StoreLockError";
  }
}

export interface StoreLockIdentity {
  readonly uid?: number;
  readonly sid?: string;
}

export interface StoreLockOwner {
  readonly uid: number | undefined;
  readonly sid: string | undefined;
  readonly pid: number;
  readonly hostname: string;
  readonly windowId: string;
  readonly acquiredAt: number;
}

export interface StoreLockFs {
  readFile(targetPath: string, encoding: "utf8"): Promise<string>;
  stat(targetPath: string): Promise<{ mtimeMs: number }>;
  unlink(targetPath: string): Promise<void>;
  utimes(targetPath: string, atime: Date, mtime: Date): Promise<void>;
  writeLockExclusive(targetPath: string, data: string, mode: number): Promise<void>;
}

export interface TryAcquireStoreLockOptions {
  readonly lockPath: string;
  readonly windowId: string;
  readonly hostname?: string;
  readonly identity?: StoreLockIdentity;
  readonly now?: () => number;
  readonly pid?: number;
  readonly processExists?: (pid: number) => boolean;
  readonly staleLockMs?: number;
  readonly staleRecheckDelayMs?: number;
  readonly mtimeUpdateMs?: number;
  readonly fs?: StoreLockFs;
}

interface ResolvedStoreLockOptions {
  readonly lockPath: string;
  readonly windowId: string;
  readonly hostname: string;
  readonly identity: { readonly uid: number | undefined; readonly sid: string | undefined };
  readonly now: () => number;
  readonly pid: number;
  readonly processExists: (pid: number) => boolean;
  readonly staleLockMs: number;
  readonly staleRecheckDelayMs: number;
  readonly mtimeUpdateMs: number;
  readonly fs: StoreLockFs;
}

export class StoreLock {
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;
  private unhealthy = false;

  constructor(
    private readonly options: ResolvedStoreLockOptions,
    private readonly owner: StoreLockOwner,
  ) {
    if (options.mtimeUpdateMs > 0) {
      this.timer = setInterval(() => {
        void this.refreshMtime().catch(() => this.clearTimer());
      }, options.mtimeUpdateMs);
      this.timer.unref?.();
    }
  }

  async verifyStillOwned(): Promise<boolean> {
    if (this.disposed) return false;
    const contents = await readLockfileContents(this.options.lockPath, {
      fs: this.options.fs,
      throwOnInvalid: false,
    });
    return contents !== undefined && isSameOwner(contents, this.owner);
  }

  markUnhealthy(): void {
    this.unhealthy = true;
    this.clearTimer();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer();
    const contents = await readLockfileContents(this.options.lockPath, {
      fs: this.options.fs,
      throwOnInvalid: false,
    });
    if (contents !== undefined && isSameOwner(contents, this.owner)) {
      await ignoreNotFound(() => this.options.fs.unlink(this.options.lockPath));
    }
  }

  async refreshMtime(): Promise<void> {
    if (this.disposed || this.unhealthy) return;
    const contents = await readLockfileContents(this.options.lockPath, this.options);
    if (this.disposed || this.unhealthy) return;
    if (contents === undefined || !isSameOwner(contents, this.owner)) {
      this.clearTimer();
      return;
    }
    const now = new Date(this.options.now());
    await ignoreNotFound(() => this.options.fs.utimes(this.options.lockPath, now, now));
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }
}

export type TryAcquireStoreLockResult =
  | { readonly kind: "acquired"; readonly lock: StoreLock }
  | { readonly kind: "held"; readonly owner: StoreLockOwner | undefined };

export async function tryAcquireStoreLock(options: TryAcquireStoreLockOptions): Promise<TryAcquireStoreLockResult> {
  const resolved = resolveOptions(options);
  ensureSecureDirectoryChain(path.dirname(resolved.lockPath));
  assertNoSymlinkInPath(resolved.lockPath);
  return tryAcquire(resolved, false);
}

export async function readActiveStoreLockOwner(
  options: Omit<TryAcquireStoreLockOptions, "windowId">,
): Promise<StoreLockOwner | undefined> {
  const resolved = resolveOptions({ ...options, windowId: "read-active-owner", mtimeUpdateMs: 0 });
  assertNoSymlinkInPath(resolved.lockPath);
  const owner = await readLockfileContents(resolved.lockPath, { fs: resolved.fs, throwOnInvalid: false });
  if (owner === undefined) return undefined;
  assertSameOsUser(owner, resolved);
  if (!resolved.processExists(owner.pid)) return undefined;
  const elapsed = resolved.now() - await readMtime(resolved);
  if (elapsed > resolved.staleLockMs) return undefined;
  const verifiedOwner = await readLockfileContents(resolved.lockPath, {
    fs: resolved.fs,
    throwOnInvalid: false,
  });
  return verifiedOwner !== undefined && isSameOwner(owner, verifiedOwner) ? owner : undefined;
}

export function getCurrentStoreLockIdentity(platform: NodeJS.Platform = process.platform): StoreLockIdentity {
  if (platform === "win32") return { sid: readCurrentWindowsUserSid() };
  const uid = process.geteuid?.();
  if (uid === undefined) {
    throw new StoreLockError({
      code: "missing_identity",
      message: "Could not determine current uid for store lock",
      lockPath: "",
    });
  }
  return { uid };
}

async function tryAcquire(options: ResolvedStoreLockOptions, isSecondAttempt: boolean): Promise<TryAcquireStoreLockResult> {
  const owner = createOwner(options);
  try {
    await options.fs.writeLockExclusive(options.lockPath, JSON.stringify(owner), PRIVATE_LOCKFILE_MODE);
    return { kind: "acquired", lock: new StoreLock(options, owner) };
  } catch (error) {
    if (!(error instanceof Error) || getErrorCode(error) !== "EEXIST") throw error;
  }
  const contents = await readLockfileContents(options.lockPath, { fs: options.fs, throwOnInvalid: false });
  if (contents === undefined) {
    if (isSecondAttempt) return { kind: "held", owner: undefined };
    return stealLock(options);
  }
  assertSameOsUser(contents, options);
  if (isSecondAttempt) return { kind: "held", owner: contents };
  if (!options.processExists(contents.pid)) return stealLock(options);
  const elapsed = options.now() - await readMtime(options);
  if (elapsed <= options.staleLockMs) return { kind: "held", owner: contents };
  await delay(options.staleRecheckDelayMs);
  const elapsedAfterRecheck = options.now() - await readMtime(options);
  if (elapsedAfterRecheck <= options.staleLockMs) return { kind: "held", owner: contents };
  return stealLock(options);
}

async function stealLock(options: ResolvedStoreLockOptions): Promise<TryAcquireStoreLockResult> {
  await ignoreNotFound(() => options.fs.unlink(options.lockPath));
  return tryAcquire(options, true);
}

function createOwner(options: ResolvedStoreLockOptions): StoreLockOwner {
  return {
    uid: options.identity.uid,
    sid: options.identity.sid,
    pid: options.pid,
    hostname: options.hostname,
    windowId: options.windowId,
    acquiredAt: options.now(),
  };
}

async function readLockfileContents(
  lockPath: string,
  options: { readonly fs: StoreLockFs; readonly throwOnInvalid?: boolean },
): Promise<StoreLockOwner | undefined> {
  let raw: string;
  try {
    raw = await options.fs.readFile(lockPath, "utf8");
  } catch (error) {
    if (error instanceof Error && getErrorCode(error) === "ENOENT") return undefined;
    if (error instanceof Error && (getErrorCode(error) === "EACCES" || getErrorCode(error) === "EPERM")) {
      if (options.throwOnInvalid === false) return undefined;
      throw new StoreLockError({
        code: "invalid_lockfile",
        message: `Unreadable agent store lockfile: ${lockPath}`,
        lockPath,
      });
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    if (options.throwOnInvalid === false) return undefined;
    throw new StoreLockError({
      code: "invalid_lockfile",
      message: `Invalid agent store lockfile JSON: ${lockPath}`,
      lockPath,
    });
  }
  const owner = storeLockOwnerFromJson(parsed);
  if (owner === undefined) {
    if (options.throwOnInvalid === false) return undefined;
    throw new StoreLockError({
      code: "invalid_lockfile",
      message: `Invalid agent store lockfile contents: ${lockPath}`,
      lockPath,
    });
  }
  return owner;
}

async function readMtime(options: ResolvedStoreLockOptions): Promise<number> {
  try {
    return (await options.fs.stat(options.lockPath)).mtimeMs;
  } catch (error) {
    if (error instanceof Error && getErrorCode(error) === "ENOENT") return 0;
    throw error;
  }
}

function assertSameOsUser(owner: StoreLockOwner, options: ResolvedStoreLockOptions): void {
  if (owner.uid !== options.identity.uid) {
    throw new StoreLockError({
      code: "foreign_identity_lock",
      message: `Agent store lock is held by uid ${owner.uid}, expected ${options.identity.uid}`,
      lockPath: options.lockPath,
    });
  }
  if (owner.sid !== options.identity.sid) {
    throw new StoreLockError({
      code: "foreign_identity_lock",
      message: `Agent store lock is held by sid ${owner.sid}, expected ${options.identity.sid}`,
      lockPath: options.lockPath,
    });
  }
}

function isSameOwner(left: StoreLockOwner, right: StoreLockOwner): boolean {
  return left.pid === right.pid
    && left.hostname === right.hostname
    && left.windowId === right.windowId
    && left.acquiredAt === right.acquiredAt;
}

function resolveOptions(options: TryAcquireStoreLockOptions): ResolvedStoreLockOptions {
  const identity = options.identity ?? getCurrentStoreLockIdentity();
  return {
    lockPath: path.resolve(options.lockPath),
    windowId: options.windowId,
    hostname: options.hostname ?? os.hostname(),
    identity: { uid: identity.uid, sid: identity.sid },
    now: options.now ?? Date.now,
    pid: options.pid ?? process.pid,
    processExists: options.processExists ?? defaultProcessExists,
    staleLockMs: options.staleLockMs ?? STORE_LOCK_STALE_MS,
    staleRecheckDelayMs: options.staleRecheckDelayMs ?? 2_000,
    mtimeUpdateMs: options.mtimeUpdateMs ?? STORE_LOCK_MTIME_UPDATE_MS,
    fs: options.fs ?? defaultStoreLockFs(),
  };
}

function defaultStoreLockFs(): StoreLockFs {
  return {
    readFile: (targetPath, encoding) => fs.promises.readFile(targetPath, encoding),
    stat: (targetPath) => fs.promises.stat(targetPath),
    unlink: (targetPath) => fs.promises.unlink(targetPath),
    utimes: (targetPath, atime, mtime) => fs.promises.utimes(targetPath, atime, mtime),
    writeLockExclusive: (targetPath, data, mode) => writeLockFileExclusive(targetPath, data, mode),
  };
}

function readCurrentWindowsUserSid(): string {
  const output = String(execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
  })).trim();
  const sid = output.split(",").map((field) => field.replace(/^"|"$/g, "")).at(-1);
  if (sid === undefined || sid.length === 0) {
    throw new StoreLockError({
      code: "missing_identity",
      message: "Could not determine current Windows lock identity",
      lockPath: "",
    });
  }
  return sid;
}

function defaultProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && getErrorCode(error) === "EPERM";
  }
}

async function ignoreNotFound(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (!(error instanceof Error) || getErrorCode(error) !== "ENOENT") throw error;
  }
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function storeLockOwnerFromJson(value: unknown): StoreLockOwner | undefined {
  if (!isJsonObject(value)) return undefined;
  const { pid, hostname, windowId, acquiredAt, uid, sid } = value;
  if (
    typeof pid !== "number"
    || typeof hostname !== "string"
    || typeof windowId !== "string"
    || typeof acquiredAt !== "number"
    || (uid !== undefined && typeof uid !== "number")
    || (sid !== undefined && typeof sid !== "string")
  ) return undefined;
  return { pid, hostname, windowId, acquiredAt, uid, sid };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorCode(error: Error): string | undefined {
  if ("code" in error && typeof error.code === "string") return error.code;
  return undefined;
}
