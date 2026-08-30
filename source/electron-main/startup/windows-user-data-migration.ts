import { lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { findSystemErrno } from "../../shared/system-errno.js";

export const LEGACY_PROFILE_NAME = "Sand";
export const CANONICAL_PROFILE_NAME = "Grok Bot";
export const PROFILE_MARKER_FILENAME = ".grokbot-user-data-v1";

export type WindowsUserDataSettlement =
  | { readonly route: "unchanged"; readonly reason: "nonwindows" | "unpackaged" | "lab" | "isolated-user-data" | "nondefault-user-data" }
  | { readonly route: "legacy"; readonly reason: "legacy-unsafe" | "canonical-unsafe" | "awaiting-update" | "migration-failed"; readonly root: string }
  | { readonly route: "canonical"; readonly reason: "canonical-fresh" | "canonical-existing" | "canonical-marked" | "conflict-preserved" | "migrated" | "migrated-by-peer"; readonly root: string };

type Attempt<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
function attemptSync<T>(work: () => T): Attempt<T> { try { return { ok: true, value: work() }; } catch (error) { return { ok: false, error }; } }

export function isWindowsUpdatedLaunch(argv: readonly string[]): boolean { return argv.includes("--updated"); }
export function resolveWindowsUserDataPaths(appDataDir: string, joinPath = join): { legacy: string; canonical: string } {
  return { legacy: joinPath(appDataDir, LEGACY_PROFILE_NAME), canonical: joinPath(appDataDir, CANONICAL_PROFILE_NAME) };
}

export function inspectWindowsProfileDirectory(path: string): "absent" | "directory" | "unsafe" {
  const inspected = attemptSync(() => lstatSync(path));
  if (!inspected.ok) return findSystemErrno(inspected.error) === "ENOENT" ? "absent" : "unsafe";
  return inspected.value.isDirectory() && !inspected.value.isSymbolicLink() ? "directory" : "unsafe";
}

export function hasWindowsProfileMarker(root: string): boolean {
  const inspected = attemptSync(() => lstatSync(join(root, PROFILE_MARKER_FILENAME)));
  return inspected.ok && inspected.value.isFile();
}

export function markWindowsProfileRoot(root: string): boolean {
  const marked = attemptSync(() => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(join(root, PROFILE_MARKER_FILENAME), '{"version":1}\n', { flag: "wx", mode: 0o600 });
  });
  return marked.ok || (findSystemErrno(marked.error) === "EEXIST" && hasWindowsProfileMarker(root));
}

function removeIfEmpty(root: string): boolean {
  const result = attemptSync(() => { if (readdirSync(root).length !== 0) return false; rmdirSync(root); return true; });
  return result.ok && result.value;
}

function isDirectoryEmpty(root: string): boolean | null {
  const entries = attemptSync(() => readdirSync(root));
  return entries.ok ? entries.value.length === 0 : null;
}

export function sameWindowsPath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function migrateLegacyProfile(options: { legacy: string; canonical: string; rename: (oldPath: string, newPath: string) => void }): WindowsUserDataSettlement {
  if (!markWindowsProfileRoot(options.legacy)) return { route: "legacy", reason: "migration-failed", root: options.legacy };
  const moved = attemptSync(() => options.rename(options.legacy, options.canonical));
  if (moved.ok) return { route: "canonical", reason: "migrated", root: options.canonical };
  if (inspectWindowsProfileDirectory(options.legacy) === "absent"
    && inspectWindowsProfileDirectory(options.canonical) === "directory"
    && hasWindowsProfileMarker(options.canonical)) {
    return { route: "canonical", reason: "migrated-by-peer", root: options.canonical };
  }
  return { route: "legacy", reason: "migration-failed", root: options.legacy };
}

export interface WindowsUserDataMigrationOptions {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly isLabBuild: boolean;
  readonly hasIsolatedUserData: boolean;
  readonly isUpdatedLaunch: boolean;
  readonly appDataDir: string;
  readonly canonicalUserDataDir: string;
  readonly removeEmpty?: (path: string) => boolean;
  readonly rename?: (oldPath: string, newPath: string) => void;
}

export function settleWindowsUserDataMigration(options: WindowsUserDataMigrationOptions): WindowsUserDataSettlement {
  if (options.platform !== "win32") return { route: "unchanged", reason: "nonwindows" };
  if (!options.isPackaged) return { route: "unchanged", reason: "unpackaged" };
  if (options.isLabBuild) return { route: "unchanged", reason: "lab" };
  if (options.hasIsolatedUserData) return { route: "unchanged", reason: "isolated-user-data" };
  const paths = resolveWindowsUserDataPaths(options.appDataDir);
  if (!sameWindowsPath(paths.canonical, options.canonicalUserDataDir)) return { route: "unchanged", reason: "nondefault-user-data" };
  const legacyState = inspectWindowsProfileDirectory(paths.legacy);
  const canonicalState = inspectWindowsProfileDirectory(paths.canonical);
  if (legacyState === "absent") {
    if (canonicalState === "absent" && markWindowsProfileRoot(paths.canonical)) {
      return { route: "canonical", reason: "canonical-fresh", root: paths.canonical };
    }
    return { route: "canonical", reason: "canonical-existing", root: paths.canonical };
  }
  if (legacyState === "unsafe") return { route: "legacy", reason: "legacy-unsafe", root: paths.legacy };
  if (canonicalState === "directory" && hasWindowsProfileMarker(paths.canonical)) {
    return { route: "canonical", reason: "canonical-marked", root: paths.canonical };
  }
  if (canonicalState === "unsafe") return { route: "legacy", reason: "canonical-unsafe", root: paths.legacy };
  if (canonicalState === "directory") {
    const isEmpty = isDirectoryEmpty(paths.canonical);
    if (isEmpty == null) return { route: "legacy", reason: "canonical-unsafe", root: paths.legacy };
    if (!isEmpty) return { route: "canonical", reason: "conflict-preserved", root: paths.canonical };
    if (!options.isUpdatedLaunch) return { route: "legacy", reason: "awaiting-update", root: paths.legacy };
    if (!(options.removeEmpty ?? removeIfEmpty)(paths.canonical)) {
      return { route: "legacy", reason: "canonical-unsafe", root: paths.legacy };
    }
  }
  if (!options.isUpdatedLaunch) return { route: "legacy", reason: "awaiting-update", root: paths.legacy };
  return migrateLegacyProfile({ legacy: paths.legacy, canonical: paths.canonical, rename: options.rename ?? renameSync });
}

export function applyWindowsUserDataMigration(options: WindowsUserDataMigrationOptions & {
  setPath(name: "userData" | "sessionData", path: string): void;
}): WindowsUserDataSettlement {
  const settlement = settleWindowsUserDataMigration(options);
  if (settlement.route !== "unchanged") {
    options.setPath("userData", settlement.root);
    options.setPath("sessionData", settlement.root);
  }
  return settlement;
}
