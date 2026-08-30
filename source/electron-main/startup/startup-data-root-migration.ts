import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  getSandProductionRootDir,
  resolveSandDataRootOverride,
  SAND_DATA_ROOT_ENV,
} from "../../host/host-paths.js";
import { isSandHostProcess } from "../../host/host-lock.js";
import { findSystemErrno } from "../../shared/system-errno.js";

export const DATA_ROOT_MARKER_FILENAME = ".grokbot-data-root-v1";
export const LOCAL_EXEC_DAEMON_DISCOVERY_FILENAME = "local-exec-daemon.json";
export const HOST_LOCK_FILENAME = "host.lock";
export const SAND_ROOT_SIGNATURE_ENTRIES = new Set([
  DATA_ROOT_MARKER_FILENAME,
  LOCAL_EXEC_DAEMON_DISCOVERY_FILENAME,
  HOST_LOCK_FILENAME,
  "agents",
  "gateway.json",
  "host-secrets.json",
  "settings.json",
]);

export type DataRootSettlement =
  | { readonly route: "unchanged"; readonly reason: "unpackaged" | "lab" | "data-root-override" | "isolated-user-data" }
  | {
      readonly route: "legacy";
      readonly reason:
        | "legacy-unsafe"
        | "live-legacy-host"
        | "unknown-legacy-writer"
        | "idle-legacy-writer"
        | "busy-legacy-writer"
        | "canonical-conflict"
        | "migration-failed";
      readonly root: string;
      readonly pid?: number;
    }
  | {
      readonly route: "canonical";
      readonly reason: "canonical-existing" | "canonical-fresh" | "canonical-marked" | "migrated" | "migrated-by-peer";
      readonly root: string;
    };

type Attempt<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
function attemptSync<T>(work: () => T): Attempt<T> {
  try { return { ok: true, value: work() }; }
  catch (error) { return { ok: false, error }; }
}

export function getLegacySandProductionRootDir(homeDir = homedir()): string {
  return join(homeDir, ".cursor", "sand");
}

export function inspectDataRootDirectory(path: string): "absent" | "directory" | "unsafe" {
  const inspected = attemptSync(() => lstatSync(path));
  if (!inspected.ok) return findSystemErrno(inspected.error) === "ENOENT" ? "absent" : "unsafe";
  return inspected.value.isDirectory() && !inspected.value.isSymbolicLink() ? "directory" : "unsafe";
}

export function defaultIsProcessAlive(pid: number): boolean {
  const signaled = attemptSync(() => process.kill(pid, 0));
  return signaled.ok || findSystemErrno(signaled.error) === "EPERM";
}

export function hasDataRootMarker(root: string): boolean {
  const inspected = attemptSync(() => lstatSync(join(root, DATA_ROOT_MARKER_FILENAME)));
  return inspected.ok && inspected.value.isFile();
}

export function markDataRoot(root: string): boolean {
  const marked = attemptSync(() => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(join(root, DATA_ROOT_MARKER_FILENAME), '{"version":1}\n', { flag: "wx", mode: 0o600 });
  });
  return marked.ok || (findSystemErrno(marked.error) === "EEXIST" && hasDataRootMarker(root));
}

function removeIfEmpty(root: string): boolean {
  const removed = attemptSync(() => {
    if (readdirSync(root).length !== 0) return false;
    rmdirSync(root);
    return true;
  });
  return removed.ok && removed.value;
}

interface DiscoveryRecord { readonly pid: number; readonly startedAt: number; readonly inflightCount?: number }
function isDiscoveryRecord(value: unknown): value is DiscoveryRecord {
  if (typeof value !== "object" || value === null || !("pid" in value) || !("startedAt" in value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.pid === "number" && Number.isInteger(record.pid) && record.pid > 0
    && typeof record.startedAt === "number"
    && (record.inflightCount === undefined
      || (typeof record.inflightCount === "number" && Number.isInteger(record.inflightCount) && record.inflightCount >= 0));
}

export type LegacyWriterProbe =
  | { readonly kind: "absent" | "unknown" }
  | { readonly kind: "live"; readonly pid: number; readonly inflightCount: number };

export function probeLegacyWriter(legacyRoot: string, isProcessAlive: (pid: number) => boolean): LegacyWriterProbe {
  const read = attemptSync(() => readFileSync(join(legacyRoot, LOCAL_EXEC_DAEMON_DISCOVERY_FILENAME), "utf8"));
  if (!read.ok) return findSystemErrno(read.error) === "ENOENT" ? { kind: "absent" } : { kind: "unknown" };
  const parsed = attemptSync<unknown>(() => JSON.parse(read.value));
  if (!parsed.ok) return { kind: "unknown" };
  const record = parsed.value;
  if (!isDiscoveryRecord(record)) return { kind: "unknown" };
  const live = attemptSync(() => isProcessAlive(record.pid));
  if (!live.ok) return { kind: "unknown" };
  return live.value
    ? { kind: "live", pid: record.pid, inflightCount: record.inflightCount ?? 0 }
    : { kind: "absent" };
}

export function probeLegacyHost(
  legacyRoot: string,
  isProcessAlive: (pid: number) => boolean,
  isHost: (pid: number) => boolean,
): "absent" | "unknown" | "live" {
  const read = attemptSync(() => readFileSync(join(legacyRoot, HOST_LOCK_FILENAME), "utf8"));
  if (!read.ok) return findSystemErrno(read.error) === "ENOENT" ? "absent" : "unknown";
  const pid = Number.parseInt(read.value.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  const live = attemptSync(() => isProcessAlive(pid));
  if (!live.ok) return "unknown";
  if (!live.value) return "absent";
  const host = attemptSync(() => isHost(pid));
  return !host.ok ? "unknown" : host.value ? "live" : "absent";
}

function readCanonicalOccupancy(root: string): "empty" | "sand" | "foreign" | "unreadable" {
  const entries = attemptSync(() => readdirSync(root));
  if (!entries.ok) return "unreadable";
  if (entries.value.length === 0) return "empty";
  return entries.value.some((entry) => SAND_ROOT_SIGNATURE_ENTRIES.has(entry)) ? "sand" : "foreign";
}

function settleWithoutLegacy(legacyRoot: string, canonicalRoot: string): DataRootSettlement {
  const canonicalState = inspectDataRootDirectory(canonicalRoot);
  if (canonicalState === "directory") {
    if (!hasDataRootMarker(canonicalRoot)) {
      const occupancy = readCanonicalOccupancy(canonicalRoot);
      if (occupancy === "foreign" || occupancy === "unreadable") {
        return { route: "legacy", reason: "canonical-conflict", root: legacyRoot };
      }
      markDataRoot(canonicalRoot);
    }
    return { route: "canonical", reason: "canonical-existing", root: canonicalRoot };
  }
  if (canonicalState === "absent" && markDataRoot(canonicalRoot)) {
    return { route: "canonical", reason: "canonical-fresh", root: canonicalRoot };
  }
  return { route: "canonical", reason: "canonical-existing", root: canonicalRoot };
}

function migrateLegacyRoot(options: { legacyRoot: string; canonicalRoot: string; rename: (oldPath: string, newPath: string) => void }): DataRootSettlement {
  if (!markDataRoot(options.legacyRoot)) return { route: "legacy", reason: "migration-failed", root: options.legacyRoot };
  const moved = attemptSync(() => options.rename(options.legacyRoot, options.canonicalRoot));
  if (moved.ok) return { route: "canonical", reason: "migrated", root: options.canonicalRoot };
  if (inspectDataRootDirectory(options.legacyRoot) === "absent"
    && inspectDataRootDirectory(options.canonicalRoot) === "directory"
    && hasDataRootMarker(options.canonicalRoot)) {
    return { route: "canonical", reason: "migrated-by-peer", root: options.canonicalRoot };
  }
  return { route: "legacy", reason: "migration-failed", root: options.legacyRoot };
}

export interface SettleStartupDataRootOptions {
  readonly isPackaged: boolean;
  readonly isLabBuild: boolean;
  readonly hasDataRootOverride: boolean;
  readonly hasIsolatedUserData: boolean;
  readonly homeDir: string;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly isSandHostProcess?: (pid: number) => boolean;
  readonly rename?: (oldPath: string, newPath: string) => void;
}

export function settleStartupDataRoot(options: SettleStartupDataRootOptions): DataRootSettlement {
  if (!options.isPackaged) return { route: "unchanged", reason: "unpackaged" };
  if (options.isLabBuild) return { route: "unchanged", reason: "lab" };
  if (options.hasDataRootOverride) return { route: "unchanged", reason: "data-root-override" };
  if (options.hasIsolatedUserData) return { route: "unchanged", reason: "isolated-user-data" };

  const legacyRoot = getLegacySandProductionRootDir(options.homeDir);
  const canonicalRoot = getSandProductionRootDir(options.homeDir);
  const legacyState = inspectDataRootDirectory(legacyRoot);
  if (legacyState === "absent") return settleWithoutLegacy(legacyRoot, canonicalRoot);
  if (legacyState === "unsafe" || inspectDataRootDirectory(dirname(legacyRoot)) !== "directory") {
    return { route: "legacy", reason: "legacy-unsafe", root: legacyRoot };
  }
  const alive = options.isProcessAlive ?? defaultIsProcessAlive;
  const hostState = probeLegacyHost(legacyRoot, alive, options.isSandHostProcess ?? isSandHostProcess);
  if (hostState === "live") return { route: "legacy", reason: "live-legacy-host", root: legacyRoot };
  if (hostState === "unknown") return { route: "legacy", reason: "unknown-legacy-writer", root: legacyRoot };
  const writer = probeLegacyWriter(legacyRoot, alive);
  if (writer.kind === "live" && writer.inflightCount === 0) {
    return { route: "legacy", reason: "idle-legacy-writer", root: legacyRoot, pid: writer.pid };
  }
  if (writer.kind === "live") return { route: "legacy", reason: "busy-legacy-writer", root: legacyRoot };
  if (writer.kind === "unknown") return { route: "legacy", reason: "unknown-legacy-writer", root: legacyRoot };

  const canonicalState = inspectDataRootDirectory(canonicalRoot);
  if (canonicalState === "directory" && hasDataRootMarker(canonicalRoot)) {
    return { route: "canonical", reason: "canonical-marked", root: canonicalRoot };
  }
  if (canonicalState === "directory" && !removeIfEmpty(canonicalRoot)) {
    return { route: "legacy", reason: "canonical-conflict", root: legacyRoot };
  }
  if (canonicalState === "unsafe") return { route: "legacy", reason: "canonical-conflict", root: legacyRoot };
  return migrateLegacyRoot({ legacyRoot, canonicalRoot, rename: options.rename ?? renameSync });
}

export function resolveExistingSandProductionRootDir(homeDir = homedir()): string {
  const canonicalRoot = getSandProductionRootDir(homeDir);
  if (inspectDataRootDirectory(canonicalRoot) === "directory") return canonicalRoot;
  const legacyRoot = getLegacySandProductionRootDir(homeDir);
  return inspectDataRootDirectory(legacyRoot) === "directory" ? legacyRoot : canonicalRoot;
}

export function applyStartupDataRootMigration(options: Omit<SettleStartupDataRootOptions, "hasDataRootOverride" | "homeDir"> & {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}): DataRootSettlement {
  const env = options.env ?? process.env;
  const settlement = settleStartupDataRoot({
    ...options,
    hasDataRootOverride: resolveSandDataRootOverride(env) != null,
    homeDir: options.homeDir ?? homedir(),
  });
  if (settlement.route !== "unchanged") env[SAND_DATA_ROOT_ENV] = settlement.root;
  return settlement;
}
