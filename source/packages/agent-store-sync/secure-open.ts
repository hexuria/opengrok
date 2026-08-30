import * as fs from "node:fs";
import * as path from "node:path";
import { AgentStorePathError } from "./paths.js";

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface SecureSqlitePath {
  readonly sqlitePath: string;
  readonly verifyOpenedInode: () => void;
  readonly close: () => void;
}

export function openSecureSqlitePath(resolvedPath: string, mode: number): SecureSqlitePath {
  const parentDir = path.dirname(resolvedPath);
  const parentDirFd = openParentDirectoryNoFollow(parentDir);
  let cleanupParentFd = true;
  try {
    const parentStat = fs.fstatSync(parentDirFd);
    if (!parentStat.isDirectory()) {
      throw new AgentStorePathError({
        code: "symlink_refused",
        message: `Refusing to open sqlite under non-directory parent: ${parentDir}`,
        failedPath: parentDir,
      });
    }
    const parentIdentity = { dev: parentStat.dev, ino: parentStat.ino };
    assertParentDirInodeMatchesPath(parentIdentity, parentDir);
    const leafFd = openRegularFileNoFollowCreate(resolvedPath, mode);
    let leafIdentity: FileIdentity;
    try {
      const leafStat = fs.fstatSync(leafFd);
      if (!leafStat.isFile()) {
        throw new AgentStorePathError({
          code: "symlink_refused",
          message: `Refusing to open non-regular sqlite path: ${resolvedPath}`,
          failedPath: resolvedPath,
        });
      }
      assertResolvedPathStillCanonical(resolvedPath);
      leafIdentity = { dev: leafStat.dev, ino: leafStat.ino };
    } finally {
      fs.closeSync(leafFd);
    }
    let verified = false;
    let closed = false;
    const closeParent = () => {
      if (closed) return;
      closed = true;
      fs.closeSync(parentDirFd);
    };
    const verifyOpenedInode = () => {
      if (verified) return;
      assertParentDirInodeMatchesPath(parentIdentity, parentDir);
      assertLeafInodeUnchanged(resolvedPath, leafIdentity);
      verified = true;
    };
    cleanupParentFd = false;
    return { sqlitePath: resolvedPath, verifyOpenedInode, close: closeParent };
  } finally {
    if (cleanupParentFd) fs.closeSync(parentDirFd);
  }
}

export async function writeLockFileExclusive(lockPath: string, contents: string, mode: number): Promise<void> {
  const flags = symlinkSafeExclusiveWriteFlags();
  let fd: fs.promises.FileHandle | undefined;
  try {
    fd = await fs.promises.open(lockPath, flags, mode);
    assertResolvedPathStillCanonical(lockPath);
    await fd.writeFile(contents, { encoding: "utf8" });
  } catch (error) {
    if (isNofollowSymlinkRefusal(error)) {
      throw new AgentStorePathError({
        code: "symlink_refused",
        message: `Refusing to create lockfile at symlinked path: ${lockPath}`,
        failedPath: lockPath,
      });
    }
    throw error;
  } finally {
    await fd?.close();
  }
}

function openRegularFileNoFollowCreate(filePath: string, mode: number): number {
  const flags = symlinkSafeOpenCreateFlags();
  try {
    return fs.openSync(filePath, flags, mode);
  } catch (error) {
    if (isNofollowSymlinkRefusal(error)) {
      throw new AgentStorePathError({
        code: "symlink_refused",
        message: `Refusing to open symlinked path: ${filePath}`,
        failedPath: filePath,
      });
    }
    throw error;
  }
}

function openParentDirectoryNoFollow(parentDir: string): number {
  const flags = symlinkSafeDirectoryOpenFlags();
  try {
    return fs.openSync(parentDir, flags);
  } catch (error) {
    if (isNofollowSymlinkRefusal(error) || (isNodeError(error) && error.code === "ENOTDIR" && isSymlink(parentDir))) {
      throw new AgentStorePathError({
        code: "symlink_refused",
        message: `Refusing to open sqlite under symlinked parent: ${parentDir}`,
        failedPath: parentDir,
      });
    }
    throw error;
  }
}

function isSymlink(targetPath: string): boolean {
  try {
    return fs.lstatSync(targetPath).isSymbolicLink();
  } catch {
    return false;
  }
}

function assertResolvedPathStillCanonical(resolvedPath: string): void {
  let realpath: string;
  try {
    realpath = fs.realpathSync.native(resolvedPath);
  } catch (error) {
    throw new AgentStorePathError({
      code: "symlink_refused",
      message: `Unable to resolve realpath for ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`,
      failedPath: resolvedPath,
    });
  }
  if (realpath !== resolvedPath) {
    throw new AgentStorePathError({
      code: "symlink_refused",
      message: `Refusing path with symlinked parent: ${resolvedPath} -> ${realpath}`,
      failedPath: resolvedPath,
    });
  }
}

function assertLeafInodeUnchanged(resolvedPath: string, expected: FileIdentity): void {
  const flags = symlinkSafeReopenFlags();
  let fd: number;
  try {
    fd = fs.openSync(resolvedPath, flags);
  } catch (error) {
    if (isNofollowSymlinkRefusal(error)) {
      throw new AgentStorePathError({
        code: "symlink_refused",
        message: `Sqlite path became symlinked between open and verification: ${resolvedPath}`,
        failedPath: resolvedPath,
      });
    }
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    assertResolvedPathStillCanonical(resolvedPath);
    if (stat.dev !== expected.dev || stat.ino !== expected.ino) {
      throw new AgentStorePathError({
        code: "symlink_refused",
        message: `Sqlite path inode drifted between open and verification (expected dev=${expected.dev} ino=${expected.ino}, got dev=${stat.dev} ino=${stat.ino}): ${resolvedPath}`,
        failedPath: resolvedPath,
      });
    }
  } finally {
    fs.closeSync(fd);
  }
}

function assertParentDirInodeMatchesPath(expected: FileIdentity, parentDir: string): void {
  let pathStat: fs.Stats;
  try {
    pathStat = fs.lstatSync(parentDir);
  } catch (error) {
    throw new AgentStorePathError({
      code: "symlink_refused",
      message: `Unable to lstat parent directory ${parentDir}: ${error instanceof Error ? error.message : String(error)}`,
      failedPath: parentDir,
    });
  }
  if (pathStat.isSymbolicLink()) {
    throw new AgentStorePathError({
      code: "symlink_refused",
      message: `Parent directory became symlinked between open and verification: ${parentDir}`,
      failedPath: parentDir,
    });
  }
  if (pathStat.dev !== expected.dev || pathStat.ino !== expected.ino) {
    throw new AgentStorePathError({
      code: "symlink_refused",
      message: `Parent directory inode drifted between open and verification (expected dev=${expected.dev} ino=${expected.ino}, got dev=${pathStat.dev} ino=${pathStat.ino}): ${parentDir}`,
      failedPath: parentDir,
    });
  }
}

function symlinkSafeOpenCreateFlags(): number {
  const constants = fs.constants as typeof fs.constants & { O_CLOEXEC?: number };
  let flags = constants.O_RDWR ?? 0;
  if (typeof constants.O_CREAT === "number") flags |= constants.O_CREAT;
  if (typeof constants.O_NOFOLLOW === "number") flags |= constants.O_NOFOLLOW;
  if (typeof constants.O_CLOEXEC === "number") flags |= constants.O_CLOEXEC;
  return flags;
}

function symlinkSafeReopenFlags(): number {
  const constants = fs.constants as typeof fs.constants & { O_CLOEXEC?: number };
  let flags = constants.O_RDONLY ?? 0;
  if (typeof constants.O_NOFOLLOW === "number") flags |= constants.O_NOFOLLOW;
  if (typeof constants.O_CLOEXEC === "number") flags |= constants.O_CLOEXEC;
  return flags;
}

function symlinkSafeDirectoryOpenFlags(): number {
  const constants = fs.constants as typeof fs.constants & { O_CLOEXEC?: number };
  let flags = constants.O_RDONLY ?? 0;
  if (typeof constants.O_DIRECTORY === "number") flags |= constants.O_DIRECTORY;
  if (typeof constants.O_NOFOLLOW === "number") flags |= constants.O_NOFOLLOW;
  if (typeof constants.O_CLOEXEC === "number") flags |= constants.O_CLOEXEC;
  return flags;
}

export function symlinkSafeExclusiveWriteFlags(): number {
  const constants = fs.constants as typeof fs.constants & { O_CLOEXEC?: number };
  let flags = constants.O_WRONLY ?? 0;
  if (typeof constants.O_CREAT === "number") flags |= constants.O_CREAT;
  if (typeof constants.O_EXCL === "number") flags |= constants.O_EXCL;
  if (typeof constants.O_NOFOLLOW === "number") flags |= constants.O_NOFOLLOW;
  if (typeof constants.O_CLOEXEC === "number") flags |= constants.O_CLOEXEC;
  return flags;
}

function isNofollowSymlinkRefusal(error: unknown): boolean {
  if (!isNodeError(error)) return false;
  if (error.code === "ELOOP" || error.code === "EMLINK") return true;
  return error.code === "EPERM" && hasNofollowConstant();
}

function hasNofollowConstant(): boolean {
  return typeof fs.constants.O_NOFOLLOW === "number";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
}
