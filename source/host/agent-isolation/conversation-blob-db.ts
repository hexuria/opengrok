import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isSqliteCantOpenError, isSqliteCorruptError, isSqliteIoError } from "../storage/sqlite-busy.js";
import {
  copySalvageableSqliteRows,
  openSqliteForSalvage,
  quarantineCorruptSqliteDb,
  removeSqliteDb,
  removeSqliteSidecars as removeSqliteRecoverySidecars,
} from "../storage/sqlite-recovery.js";

export const CONVERSATION_BLOB_SCHEMA = `
CREATE TABLE IF NOT EXISTS blobs (
  id TEXT PRIMARY KEY,
  data BLOB NOT NULL
) STRICT;
`;

export const CONVERSATION_BLOB_MIGRATION_UNSTARTED = 0;
export const CONVERSATION_BLOB_ADOPTION_COMPLETE = 1;
export const CONVERSATION_BLOB_RECOVERY_REBUILT = 2;

export type ConversationBlobMigrationState = "unstarted" | "adoption-complete" | "recovery-rebuilt" | "unknown";

export class ConversationBlobRecoveryError extends Error {
  override name = "ConversationBlobRecoveryError";

  constructor(readonly code: string, message: string) {
    super(message);
  }
}

interface ConversationBlobRecoveryInfo {
  outcome: "recovered" | "reset";
  quarantinePath: string | null;
  salvagedBlobs: number;
}

interface ConversationBlobDbOptions {
  dbPath: string;
  busyTimeoutMs: number;
  agentId: string;
  log?: (message: string) => void;
  onRecovery?: (info: ConversationBlobRecoveryInfo) => void;
}

interface PendingConversationBlobRecovery {
  pendingPath: string;
  quarantinePath: string;
}

export function readConversationBlobMigrationState(db: DatabaseSync): ConversationBlobMigrationState {
  let version: unknown;
  try {
    version = (db.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined)?.user_version;
  } catch {
    return "unknown";
  }
  switch (version ?? CONVERSATION_BLOB_MIGRATION_UNSTARTED) {
    case CONVERSATION_BLOB_MIGRATION_UNSTARTED:
      return "unstarted";
    case CONVERSATION_BLOB_ADOPTION_COMPLETE:
      return "adoption-complete";
    case CONVERSATION_BLOB_RECOVERY_REBUILT:
      return "recovery-rebuilt";
    default:
      return "unknown";
  }
}

export function openConfiguredConversationBlobDb(dbPath: string, busyTimeoutMs: number): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    try {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
    } catch {
      // The database can still be opened when journal configuration is unavailable.
    }
    db.exec(CONVERSATION_BLOB_SCHEMA);
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      // Preserve the original database error.
    }
    throw error;
  }
}

export function runQuickCheck(db: DatabaseSync): "healthy" | "corrupt" {
  const row = db.prepare("PRAGMA quick_check").get() as { quick_check?: unknown } | undefined;
  return row?.quick_check === "ok" ? "healthy" : "corrupt";
}

export function removeSqliteSidecars(path: string): void {
  removeSqliteRecoverySidecars(path);
}

function getHealth(db: DatabaseSync): "healthy" | "corrupt" | "unavailable" {
  try {
    return runQuickCheck(db);
  } catch (error) {
    return isSqliteCorruptError(error) ? "corrupt" : "unavailable";
  }
}

function getHealthOnDisk(options: Pick<ConversationBlobDbOptions, "dbPath" | "busyTimeoutMs">): "healthy" | "corrupt" | "unavailable" {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(options.dbPath, { readOnly: true });
      db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs}`);
      return runQuickCheck(db);
    } catch (error) {
      if (attempt === 0 && (isSqliteIoError(error) || isSqliteCantOpenError(error))) {
        try {
          db?.close();
        } catch {
          // Continue with the sidecar cleanup retry.
        }
        db = undefined;
        removeSqliteSidecars(options.dbPath);
        continue;
      }
      return isSqliteCorruptError(error) ? "corrupt" : "unavailable";
    } finally {
      try {
        db?.close();
      } catch {
        // Preserve the health result.
      }
    }
  }
  return "unavailable";
}

export function recoverConversationBlobDb(options: ConversationBlobDbOptions): DatabaseSync {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const intendedQuarantinePath = `${options.dbPath}.corrupt-${stamp}`;
  const intentPath = `${intendedQuarantinePath}.intent`;
  writeFileSync(intentPath, "");
  const quarantine = quarantineCorruptSqliteDb({
    dbPath: options.dbPath,
    quarantinePath: intendedQuarantinePath,
    preserveSourceOnCopyFailure: true,
    removeAttempts: Math.ceil(options.busyTimeoutMs / 50),
    removeRetryDelayMs: 50,
  });
  const pendingPath = `${quarantine.quarantinePath ?? intendedQuarantinePath}.pending`;
  renameSync(intentPath, pendingPath);
  if (quarantine.renameErrorCode != null) {
    options.log?.(
      quarantine.quarantinePath == null
        ? `[agent-store-worker] could not quarantine conversation-blobs.db for agent=${options.agentId} (rename ${quarantine.renameErrorCode}); resetting without a preserved copy`
        : quarantine.copied
          ? `[agent-store-worker] quarantined conversation-blobs.db by copy for agent=${options.agentId} (rename ${quarantine.renameErrorCode})`
          : `[agent-store-worker] could not copy quarantine for conversation-blobs.db for agent=${options.agentId} (rename ${quarantine.renameErrorCode}); recovering from the source in place`,
    );
  }
  return finishConversationBlobRecovery({
    options,
    quarantinePath: quarantine.quarantinePath,
    pendingPath,
  });
}

function openConversationBlobRecoveryTarget(options: Pick<ConversationBlobDbOptions, "busyTimeoutMs">, dbPath: string): DatabaseSync {
  const open = () => openConfiguredConversationBlobDb(dbPath, options.busyTimeoutMs);
  const remove = () =>
    removeSqliteDb({
      dbPath,
      attempts: Math.ceil(options.busyTimeoutMs / 50),
      retryDelayMs: 50,
    });
  let retriedWithoutSidecars = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let db: DatabaseSync | undefined;
    try {
      db = open();
    } catch (error) {
      if ((isSqliteIoError(error) || isSqliteCantOpenError(error)) && !retriedWithoutSidecars) {
        retriedWithoutSidecars = true;
        removeSqliteSidecars(dbPath);
        continue;
      }
      if (!isSqliteIoError(error) && !isSqliteCorruptError(error) && !isSqliteCantOpenError(error)) {
        throw error;
      }
      remove();
      continue;
    }
    const health = getHealth(db);
    if (health === "healthy") return db;
    try {
      db.close();
    } catch {
      // Continue recovery using the replacement path.
    }
    if (health === "unavailable") {
      throw new ConversationBlobRecoveryError(
        "SAND_BLOB_RECOVERY_TARGET_UNHEALTHY",
        "conversation blob recovery target is temporarily unavailable",
      );
    }
    remove();
  }
  throw new ConversationBlobRecoveryError(
    "SAND_BLOB_RECOVERY_TARGET_UNHEALTHY",
    "failed to create a healthy conversation blob database",
  );
}

function installCompletedConversationBlobReplacement(options: {
  dbPath: string;
  replacementPath: string;
  pendingPath?: string;
  busyTimeoutMs: number;
}): DatabaseSync | undefined {
  const health = getHealthOnDisk({
    dbPath: options.replacementPath,
    busyTimeoutMs: options.busyTimeoutMs,
  });
  if (health === "unavailable") {
    throw new ConversationBlobRecoveryError(
      "SAND_BLOB_RECOVERY_SOURCE_UNAVAILABLE",
      "completed conversation blob replacement is temporarily unavailable",
    );
  }
  if (health === "corrupt") return undefined;
  let replacement: DatabaseSync | undefined;
  try {
    replacement = openConfiguredConversationBlobDb(options.replacementPath, options.busyTimeoutMs);
    const configuredHealth = getHealth(replacement);
    if (configuredHealth === "corrupt") return undefined;
    if (configuredHealth === "unavailable") {
      throw new ConversationBlobRecoveryError(
        "SAND_BLOB_RECOVERY_SOURCE_UNAVAILABLE",
        "completed conversation blob replacement became unavailable",
      );
    }
    const replacementState = readConversationBlobMigrationState(replacement);
    if (replacementState !== "recovery-rebuilt" && replacementState !== "adoption-complete") return undefined;
    replacement.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    replacement.exec("PRAGMA journal_mode = DELETE");
  } catch (error) {
    if (isSqliteCorruptError(error)) return undefined;
    throw error;
  } finally {
    try {
      replacement?.close();
    } catch {
      // Preserve the replacement result/error.
    }
  }
  removeSqliteSidecars(options.replacementPath);
  removeSqliteDb({ dbPath: options.dbPath });
  renameSync(options.replacementPath, options.dbPath);
  const installed = openConfiguredConversationBlobDb(options.dbPath, options.busyTimeoutMs);
  if (getHealth(installed) !== "healthy") {
    installed.close();
    throw new ConversationBlobRecoveryError(
      "SAND_BLOB_RECOVERY_INSTALL_UNHEALTHY",
      "installed completed conversation blob replacement is unhealthy",
    );
  }
  if (options.pendingPath != null) rmSync(options.pendingPath, { force: true });
  return installed;
}

function finishConversationBlobRecovery(args: {
  options: ConversationBlobDbOptions;
  quarantinePath: string | null;
  pendingPath: string | null;
}): DatabaseSync {
  const { options } = args;
  let pendingPath = args.pendingPath;
  let quarantinePath = args.quarantinePath;
  let replacementPath = `${quarantinePath ?? options.dbPath}.replacement`;
  if (!existsSync(options.dbPath) && existsSync(replacementPath)) {
    const installed = installCompletedConversationBlobReplacement({
      dbPath: options.dbPath,
      replacementPath,
      busyTimeoutMs: options.busyTimeoutMs,
      ...(pendingPath == null ? {} : { pendingPath }),
    });
    if (installed != null) return installed;
    const hasSeparateQuarantine =
      quarantinePath != null && quarantinePath !== options.dbPath && existsSync(quarantinePath);
    if (!hasSeparateQuarantine) {
      quarantinePath = replacementPath;
      replacementPath = `${replacementPath}.replacement`;
    }
  }
  if (existsSync(options.dbPath)) {
    let existing: DatabaseSync | undefined;
    const sourceHealth = getHealthOnDisk({
      dbPath: options.dbPath,
      busyTimeoutMs: options.busyTimeoutMs,
    });
    if (sourceHealth === "unavailable") {
      throw new ConversationBlobRecoveryError(
        "SAND_BLOB_RECOVERY_SOURCE_UNAVAILABLE",
        "conversation blob recovery source is temporarily unavailable",
      );
    }
    if (sourceHealth === "healthy") {
      try {
        existing = openConfiguredConversationBlobDb(options.dbPath, options.busyTimeoutMs);
      } catch (error) {
        if (!isSqliteCorruptError(error)) {
          throw new ConversationBlobRecoveryError(
            "SAND_BLOB_RECOVERY_SOURCE_UNAVAILABLE",
            "healthy conversation blob recovery source could not be configured",
          );
        }
      }
      const configuredHealth = existing == null ? "corrupt" : getHealth(existing);
      if (configuredHealth === "healthy" && existing != null) {
        if (quarantinePath != null) removeSqliteDb({ dbPath: `${quarantinePath}.replacement` });
        if (pendingPath != null) rmSync(pendingPath, { force: true });
        return existing;
      }
      if (configuredHealth === "unavailable") {
        try {
          existing?.close();
        } catch {
          // Preserve the source-unavailable result.
        }
        throw new ConversationBlobRecoveryError(
          "SAND_BLOB_RECOVERY_SOURCE_UNAVAILABLE",
          "conversation blob recovery source became temporarily unavailable",
        );
      }
    }
    try {
      existing?.close();
    } catch {
      // Continue with salvage.
    }
    if (quarantinePath === options.dbPath) {
      // The source itself is the salvage path when it could not be moved.
    } else if (quarantinePath != null && !existsSync(quarantinePath)) {
      const quarantine = quarantineCorruptSqliteDb({
        dbPath: options.dbPath,
        quarantinePath,
        preserveSourceOnCopyFailure: true,
        removeAttempts: Math.ceil(options.busyTimeoutMs / 50),
        removeRetryDelayMs: 50,
      });
      quarantinePath = quarantine.quarantinePath;
      const resumedPendingPath = quarantinePath == null ? null : `${quarantinePath}.pending`;
      if (pendingPath != null && resumedPendingPath != null && pendingPath !== resumedPendingPath) {
        renameSync(pendingPath, resumedPendingPath);
        pendingPath = resumedPendingPath;
      }
      replacementPath = `${quarantinePath ?? options.dbPath}.replacement`;
    } else {
      removeSqliteDb({
        dbPath: options.dbPath,
        attempts: Math.ceil(options.busyTimeoutMs / 50),
        retryDelayMs: 50,
      });
    }
  }
  removeSqliteDb({ dbPath: replacementPath });
  const freshDb = openConversationBlobRecoveryTarget(options, replacementPath);
  let salvagedBlobs = 0;
  try {
    if (quarantinePath != null) {
      const source = openSqliteForSalvage({
        dbPath: quarantinePath,
        busyTimeoutMs: options.busyTimeoutMs,
      });
      if (source == null && existsSync(quarantinePath)) {
        throw new ConversationBlobRecoveryError(
          "SAND_BLOB_RECOVERY_QUARANTINE_UNREADABLE",
          "quarantined conversation blob database is unreadable",
        );
      }
      if (source != null) {
        try {
          salvagedBlobs = copySalvageableSqliteRows(
            source,
            "SELECT id, data FROM blobs",
            freshDb.prepare("INSERT OR IGNORE INTO blobs (id, data) VALUES (?, ?)"),
            (row: unknown) => {
              const value = row as { id: string; data: unknown };
              return [value.id, value.data];
            },
          );
        } finally {
          try {
            source.close();
          } catch {
            // Preserve the salvage result.
          }
        }
      }
    }
    freshDb.exec(`PRAGMA user_version = ${CONVERSATION_BLOB_RECOVERY_REBUILT}`);
    freshDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    freshDb.exec("PRAGMA journal_mode = DELETE");
  } finally {
    try {
      freshDb.close();
    } catch {
      // Preserve the recovery error.
    }
  }
  removeSqliteSidecars(replacementPath);
  removeSqliteDb({
    dbPath: options.dbPath,
    attempts: Math.ceil(options.busyTimeoutMs / 50),
    retryDelayMs: 50,
  });
  renameSync(replacementPath, options.dbPath);
  const installedDb = openConfiguredConversationBlobDb(options.dbPath, options.busyTimeoutMs);
  if (getHealth(installedDb) !== "healthy") {
    installedDb.close();
    throw new ConversationBlobRecoveryError(
      "SAND_BLOB_RECOVERY_INSTALL_UNHEALTHY",
      "installed conversation blob recovery is unhealthy",
    );
  }
  const info: ConversationBlobRecoveryInfo = {
    outcome: salvagedBlobs > 0 ? "recovered" : "reset",
    quarantinePath,
    salvagedBlobs,
  };
  options.log?.(
    `[agent-store-worker] conversation-blobs.db recovery: outcome=${info.outcome} agent=${options.agentId} quarantine=${info.quarantinePath != null ? basename(info.quarantinePath) : "none"} salvaged.blobs=${info.salvagedBlobs}`,
  );
  try {
    options.onRecovery?.(info);
  } catch {
    // Recovery callback failures do not invalidate the installed database.
  }
  if (pendingPath != null) rmSync(pendingPath, { force: true });
  return installedDb;
}

function findPendingRecovery(dbPath: string): PendingConversationBlobRecovery | undefined {
  const dir = dirname(dbPath);
  const dbName = basename(dbPath);
  const prefix = `${dbName}.corrupt-`;
  const names = readdirSync(dir);
  const quarantineMarkerNames = names
    .filter((name) => name.startsWith(prefix) && (name.endsWith(".intent") || name.endsWith(".pending")))
    .sort();
  const inPlaceMarkerName = `${dbName}.pending`;
  const markerNames = [
    ...(names.includes(inPlaceMarkerName) ? [inPlaceMarkerName] : []),
    ...quarantineMarkerNames,
  ];
  const markerName = markerNames.at(-1);
  const quarantinePathFor = (name: string): string => {
    const markerPath = join(dir, name);
    if (name === `${dbName}.pending`) return dbPath;
    const suffix = name.endsWith(".intent") ? ".intent" : ".pending";
    return markerPath.slice(0, -suffix.length);
  };
  const activeReplacement = markerName == null ? null : `${quarantinePathFor(markerName)}.replacement`;
  for (const name of names) {
    if ((name.startsWith(prefix) || name === `${dbName}.replacement`) && name.endsWith(".replacement")) {
      const replacementPath = join(dir, name);
      if (replacementPath !== activeReplacement) removeSqliteDb({ dbPath: replacementPath });
    }
  }
  if (markerName == null) return undefined;
  for (const staleName of markerNames.slice(0, -1)) {
    rmSync(join(dir, staleName), { force: true });
    removeSqliteDb({ dbPath: `${quarantinePathFor(staleName)}.replacement` });
  }
  const pendingPath = join(dir, markerName);
  return {
    pendingPath,
    quarantinePath: quarantinePathFor(markerName),
  };
}

export function openConversationBlobDb(options: ConversationBlobDbOptions): DatabaseSync {
  mkdirSync(dirname(options.dbPath), { recursive: true });
  const pending = findPendingRecovery(options.dbPath);
  if (pending != null) {
    return finishConversationBlobRecovery({
      options,
      quarantinePath: pending.quarantinePath,
      pendingPath: pending.pendingPath,
    });
  }
  let db: DatabaseSync;
  try {
    db = openConfiguredConversationBlobDb(options.dbPath, options.busyTimeoutMs);
  } catch (error) {
    if (isSqliteIoError(error) || isSqliteCantOpenError(error)) {
      removeSqliteSidecars(options.dbPath);
      try {
        db = openConfiguredConversationBlobDb(options.dbPath, options.busyTimeoutMs);
      } catch (retryError) {
        if (isSqliteCorruptError(retryError)) return recoverConversationBlobDb(options);
        throw retryError;
      }
    } else if (isSqliteCorruptError(error)) {
      return recoverConversationBlobDb(options);
    } else {
      throw error;
    }
  }
  let health: "healthy" | "corrupt";
  try {
    health = runQuickCheck(db);
  } catch (error) {
    try {
      db.close();
    } catch {
      // Continue with the classified health failure.
    }
    if (isSqliteIoError(error) || isSqliteCantOpenError(error)) {
      removeSqliteSidecars(options.dbPath);
      try {
        db = openConfiguredConversationBlobDb(options.dbPath, options.busyTimeoutMs);
        health = runQuickCheck(db);
      } catch (retryError) {
        if (isSqliteIoError(retryError) || isSqliteCantOpenError(retryError) || isSqliteCorruptError(retryError)) {
          return recoverConversationBlobDb(options);
        }
        throw retryError;
      }
    } else if (isSqliteCorruptError(error)) {
      return recoverConversationBlobDb(options);
    } else {
      throw new ConversationBlobRecoveryError(
        "SAND_BLOB_RECOVERY_SOURCE_UNAVAILABLE",
        "conversation blob database health check is temporarily unavailable",
      );
    }
  }
  if (health === "healthy") return db;
  try {
    db.close();
  } catch {
    // Continue recovery using the quarantined source.
  }
  return recoverConversationBlobDb(options);
}
