import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { brandedErrno } from "../../../shared/errors/bounded.js";
import { findSystemErrno } from "../../../shared/system-errno.js";
import { DB_BUSY_TIMEOUT_MS, SQLITE_DB_SIDECAR_SUFFIXES } from "../../storage/store-db.js";
import {
  isSqliteBusyError,
  isSqliteCantOpenError,
  isSqliteCorruptError,
  isSqliteIoError,
} from "../../storage/sqlite-busy.js";

export const LOCKED_DB_COPY_ATTEMPTS = 3;

export type SqliteSnapshotOperation =
  | "prepare_staged"
  | "read_source_main"
  | "write_staged_main"
  | "copy_source_sidecars"
  | "verify_source_stability"
  | "open_staged"
  | "checkpoint_staged"
  | "set_staged_journal_mode"
  | "quick_check_staged"
  | "close_staged"
  | "cleanup_staged"
  | "vacuum_into";

export type SqliteSnapshotPathStage =
  | "source_main"
  | "staged_main"
  | "staged_sidecars"
  | "source_and_staged_sidecars"
  | "source_or_staged_main";

export interface SqliteSnapshotFailure {
  readonly operation: SqliteSnapshotOperation;
  readonly pathStage: SqliteSnapshotPathStage;
  readonly cause: string;
  readonly errorClass: string;
  readonly errno?: string;
  readonly sqliteCode?: number;
}

export function sqliteVacuumInto(
  srcPath: string,
  destPath: string,
  busyTimeoutMs = DB_BUSY_TIMEOUT_MS,
): void {
  const db = new DatabaseSync(srcPath, { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

function numericErrcode(error: unknown): number | undefined {
  if (typeof error !== "object" || error == null || !("errcode" in error)) return undefined;
  const candidate = error.errcode;
  return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0
    ? candidate
    : undefined;
}

export function classifySqliteSnapshotFailure(
  error: unknown,
  operation: SqliteSnapshotOperation,
  pathStage: SqliteSnapshotPathStage,
): SqliteSnapshotFailure {
  const sqliteCode = numericErrcode(error);
  const systemErrno = sqliteCode === undefined ? findSystemErrno(error) : undefined;
  const errno = brandedErrno(systemErrno);
  const primarySqliteCode = sqliteCode === undefined ? undefined : sqliteCode & 0xff;
  const isCapacityFailure = systemErrno === "ENOSPC"
    || systemErrno === "EDQUOT"
    || primarySqliteCode === 13;
  let resolvedPathStage = pathStage;
  if (operation === "vacuum_into" && isCapacityFailure) resolvedPathStage = "staged_main";
  else if (operation === "copy_source_sidecars" && isCapacityFailure) resolvedPathStage = "staged_sidecars";
  else if (operation === "vacuum_into" && (isSqliteBusyError(error) || isSqliteCorruptError(error))) {
    resolvedPathStage = "source_main";
  }

  let errorClass = "unknown";
  if (error instanceof TypeError) errorClass = "TypeError";
  else if (error instanceof RangeError) errorClass = "RangeError";
  else if (error instanceof Error) errorClass = "Error";

  let cause = "unknown";
  if (isSqliteBusyError(error)) cause = "busy";
  else if (isSqliteIoError(error)) cause = "io";
  else if (isSqliteCorruptError(error)) cause = "corrupt";
  else if (isSqliteCantOpenError(error)) cause = "cant_open";
  else if (sqliteCode !== undefined) cause = "sqlite";
  else if (errno !== undefined) cause = "system";
  else if (error instanceof Error) cause = "error";

  return {
    operation,
    pathStage: resolvedPathStage,
    cause,
    errorClass,
    ...(errno === undefined ? {} : { errno }),
    ...(sqliteCode === undefined ? {} : { sqliteCode }),
  };
}

function quickCheckOk(row: unknown): boolean {
  return typeof row === "object" && row != null && "quick_check" in row && row.quick_check === "ok";
}

export function copyLockedSqliteDb(args: {
  srcPath: string;
  destPath: string;
  readFile?(path: string): Buffer;
  onFailure?(failure: SqliteSnapshotFailure): void;
}): boolean {
  const { srcPath, destPath } = args;
  const readFile = args.readFile ?? readFileSync;
  let lastFailure: SqliteSnapshotFailure = {
    operation: "prepare_staged",
    pathStage: "staged_main",
    cause: "unknown",
    errorClass: "unknown",
  };

  for (let attempt = 1; attempt <= LOCKED_DB_COPY_ATTEMPTS; attempt += 1) {
    let verified = false;
    let attemptFailure: SqliteSnapshotFailure | undefined;
    let db: DatabaseSync | undefined;
    let operation: SqliteSnapshotOperation = "prepare_staged";
    let pathStage: SqliteSnapshotPathStage = "staged_main";
    try {
      rmSync(destPath, { force: true });
      pathStage = "staged_sidecars";
      for (const suffix of SQLITE_DB_SIDECAR_SUFFIXES) rmSync(`${destPath}${suffix}`, { force: true });
      operation = "read_source_main";
      pathStage = "source_main";
      const mainBytes = readFile(srcPath);
      operation = "write_staged_main";
      pathStage = "staged_main";
      writeFileSync(destPath, mainBytes);
      operation = "copy_source_sidecars";
      pathStage = "source_and_staged_sidecars";
      for (const suffix of SQLITE_DB_SIDECAR_SUFFIXES) {
        const sidecar = `${srcPath}${suffix}`;
        if (existsSync(sidecar)) copyFileSync(sidecar, `${destPath}${suffix}`);
      }
      operation = "verify_source_stability";
      pathStage = "source_main";
      if (!readFile(srcPath).equals(mainBytes)) {
        attemptFailure = {
          operation,
          pathStage,
          cause: "source_changed",
          errorClass: "none",
        };
      } else {
        operation = "open_staged";
        pathStage = "staged_main";
        db = new DatabaseSync(destPath);
        operation = "checkpoint_staged";
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        operation = "set_staged_journal_mode";
        db.exec("PRAGMA journal_mode=DELETE");
        operation = "quick_check_staged";
        verified = quickCheckOk(db.prepare("PRAGMA quick_check").get());
        if (!verified) {
          attemptFailure = {
            operation,
            pathStage,
            cause: "quick_check_failed",
            errorClass: "none",
          };
        }
      }
    } catch (error) {
      attemptFailure = classifySqliteSnapshotFailure(error, operation, pathStage);
      verified = false;
    } finally {
      try {
        db?.close();
      } catch (error) {
        verified = false;
        attemptFailure ??= classifySqliteSnapshotFailure(error, "close_staged", "staged_main");
      }
      for (const suffix of SQLITE_DB_SIDECAR_SUFFIXES) {
        try {
          rmSync(`${destPath}${suffix}`, { force: true });
        } catch (error) {
          verified = false;
          attemptFailure ??= classifySqliteSnapshotFailure(error, "cleanup_staged", "staged_sidecars");
        }
      }
      if (!verified) {
        try {
          rmSync(destPath, { force: true });
        } catch (error) {
          attemptFailure ??= classifySqliteSnapshotFailure(error, "cleanup_staged", "staged_main");
        }
      }
    }
    if (verified && attemptFailure === undefined) return true;
    if (attemptFailure !== undefined) lastFailure = attemptFailure;
  }
  args.onFailure?.(lastFailure);
  return false;
}
