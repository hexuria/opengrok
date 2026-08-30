import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEP = "/";
export const WORKTREE_GUARD_ERROR = "You cannot search other worktrees for this repository, stay within your workspace paths.";

function untildify(value: string): string {
  return value.replace(/^~(?=$|\/|\\)/, homedir());
}

function stripFileUrlIfPresent(value: string): string {
  if (!value.startsWith("file://")) return value;
  try {
    return fileURLToPath(value);
  } catch {
    return value;
  }
}

export function resolvePath(value: string, basePath?: string): string {
  const untildified = untildify(stripFileUrlIfPresent(value));
  if (basePath && !path.isAbsolute(untildified)) return path.resolve(basePath, untildified);
  return path.resolve(untildified);
}

export async function resolveRealPathStrict(value: string, basePath?: string): Promise<string | null> {
  const normalized = resolvePath(value, basePath);
  let current = normalized;
  while (true) {
    try {
      const resolvedCurrent = await realpath(current);
      return path.resolve(resolvedCurrent, path.relative(current, normalized));
    } catch (error) {
      if ((error as { code?: unknown }).code !== "ENOENT") return null;
      const parent = path.dirname(current);
      if (parent === current) return normalized;
      current = parent;
    }
  }
}

export function isPathWithin({ basePath, targetPath }: { basePath: string; targetPath: string }): boolean {
  const resolvedBase = path.resolve(basePath);
  const resolvedTarget = path.resolve(basePath, targetPath);
  if (resolvedBase === path.parse(resolvedBase).root) {
    return path.parse(resolvedTarget).root === resolvedBase && (resolvedTarget === resolvedBase || resolvedTarget.length > resolvedBase.length);
  }
  return resolvedTarget === resolvedBase || resolvedTarget.startsWith(resolvedBase + path.sep);
}

function isPathWithinAnyRoot(targetPath: string, roots: readonly string[]): boolean {
  for (const root of roots) if (isPathWithin({ basePath: root, targetPath })) return true;
  return false;
}

export function normalizeToUnixPath(value: string): string {
  return value.replace(/\\/g, SEP);
}

export function isWorktreesPath(value: string): boolean {
  return normalizeToUnixPath(value).includes(".cursor/worktrees");
}

function getWorktreesRepoRoot(worktreePath: string): string | undefined {
  const normalizedPath = normalizeToUnixPath(worktreePath);
  const marker = "/.cursor/worktrees/";
  const markerIndex = normalizedPath.indexOf(marker);
  if (markerIndex === -1) return undefined;
  const afterMarker = normalizedPath.slice(markerIndex + marker.length);
  const parts = afterMarker.split("/");
  if (parts.length < 2) return undefined;
  const repoName = parts[0] ?? "";
  if (repoName.length === 0) return undefined;
  return normalizedPath.slice(0, markerIndex + marker.length + repoName.length);
}

export function shouldBlockWorktreePath(params: { targetPath?: string | undefined; workspacePaths: readonly string[]; mainWorktreePath?: string | undefined }): boolean {
  const { targetPath, workspacePaths, mainWorktreePath } = params;
  if (targetPath === undefined) return false;
  if (workspacePaths.length === 0) return false;
  if (!workspacePaths.every((workspacePath) => isWorktreesPath(workspacePath))) return false;
  if (isPathWithinAnyRoot(targetPath, workspacePaths)) return false;
  const resolvedTargets = path.isAbsolute(targetPath) ? [path.resolve(targetPath)] : workspacePaths.map((workspacePath) => path.resolve(workspacePath, targetPath));
  const worktreeRepoRoots = workspacePaths.map((root) => getWorktreesRepoRoot(root)).filter((root): root is string => root !== undefined);
  if (worktreeRepoRoots.length > 0 && resolvedTargets.some((target) => isPathWithinAnyRoot(target, worktreeRepoRoots))) return true;
  if (mainWorktreePath !== undefined && resolvedTargets.some((target) => isPathWithinAnyRoot(target, [mainWorktreePath]))) return true;
  return false;
}
