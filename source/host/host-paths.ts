import { lstat, readlink, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { getSandVariant } from "../shared/node/sand-variant.js";
import { isPathWithin } from "../shared/node/paths.js";
import { findSystemErrno } from "../shared/system-errno.js";

export const SAND_DATA_ROOT_ENV = "SAND_DATA_ROOT";
export const SAND_PRODUCTION_DATA_DIRNAME = ".grokbot";
export const SAND_USER_DATA_DIR_ENV = "SAND_USER_DATA_DIR";
export const SAND_DATA_DIRNAME = "sand-data";
export const USER_DATA_DIR_FLAG = "--user-data-dir";
export const SAND_BOX_HOME_DIR = "/home/box";
export const SAND_BOX_DATA_ROOT = `${SAND_BOX_HOME_DIR}/${SAND_DATA_DIRNAME}`;
export const SAND_BOX_MODEL_VISIBLE_DATA_ROOT = `${SAND_BOX_HOME_DIR}/agent-data`;

export function toModelVisiblePath(path: string): string {
  if (!isPathWithin(SAND_BOX_DATA_ROOT, path, { isInclusive: true })) return path;
  return join(SAND_BOX_MODEL_VISIBLE_DATA_ROOT, relative(SAND_BOX_DATA_ROOT, path));
}

async function lstatIfExists(path: string) {
  try { return await lstat(path); }
  catch (error) { if (findSystemErrno(error) !== "ENOENT") throw error; return null; }
}

export async function ensureDataRootAlias(args: { readonly dataRoot: string; readonly aliasPath: string }): Promise<void> {
  const existing = await lstatIfExists(args.aliasPath);
  if (existing != null) {
    if (!existing.isSymbolicLink()) return;
    if (await readlink(args.aliasPath) === args.dataRoot) return;
    await rm(args.aliasPath);
  }
  await symlink(args.dataRoot, args.aliasPath);
}

export function readUserDataDirArg(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === USER_DATA_DIR_FLAG) {
      const next = argv[i + 1];
      return next != null && !next.startsWith("--") ? next : null;
    }
    const prefix = `${USER_DATA_DIR_FLAG}=`;
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return null;
}

export function resolveSandUserDataDir(argv: readonly string[] = [], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string | null {
  const raw = readUserDataDirArg(argv) ?? env[SAND_USER_DATA_DIR_ENV];
  const trimmed = raw?.trim();
  if (trimmed == null || trimmed.length === 0) return null;
  return isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
}

export function getSandProductionRootDir(homeDir = homedir()): string { return join(homeDir, SAND_PRODUCTION_DATA_DIRNAME); }

export function resolveSandDataRootOverride(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env[SAND_DATA_ROOT_ENV]?.trim();
  return override != null && override.length > 0 && isAbsolute(override) ? override : null;
}

export function getSandRootDir(homeDir = homedir()): string {
  const override = resolveSandDataRootOverride();
  if (override != null) return override;
  const userDataDir = resolveSandUserDataDir([], process.env);
  if (userDataDir != null) return join(userDataDir, SAND_DATA_DIRNAME);
  const variant = getSandVariant();
  return variant === "sand" ? getSandProductionRootDir(homeDir) : join(homeDir, ".cursor", variant);
}

export function reanchorSandPath(storedPath: string): string {
  const root = getSandRootDir();
  if (isPathWithin(root, storedPath, { isInclusive: true })) return storedPath;
  const match = /(?:[/\\]\.cursor[/\\]sand(?:-[^/\\]+)?|[/\\]\.grokbot)[/\\](.+)$/.exec(storedPath);
  if (match?.[1] == null) return storedPath;
  const segments = match[1].split(/[/\\]+/);
  if (segments.some((segment) => segment === "." || segment === "..")) return storedPath;
  return join(root, ...segments);
}

export function getGatewayDiscoveryPath(homeDir = homedir()): string { return join(getSandRootDir(homeDir), "gateway.json"); }
export function getHostLockPath(homeDir = homedir()): string { return join(getSandRootDir(homeDir), "host.lock"); }
export function getHostSecretsPath(homeDir = homedir()): string { return join(getSandRootDir(homeDir), "host-secrets.json"); }
export function getHostUpgradeMarkerPath(homeDir = homedir()): string { return join(getSandRootDir(homeDir), ".sand-host-upgrade.json"); }
export function getHostCrashMarkerPath(homeDir = homedir()): string { return join(getSandRootDir(homeDir), ".sand-host-crash.json"); }
