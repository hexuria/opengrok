import * as fs from "node:fs";
import * as path from "node:path";

import { ensureSecureDirectoryChain, assertNoSymlinkInPath } from "./paths.js";
import { openSecureSqlitePath, type SecureSqlitePath } from "./secure-open.js";

const CURRENT_SCHEMA_VERSION = 3;
const PRIVATE_FILE_MODE = 0o600;

export const META_DELETION_ARMED = "deletion_armed";
export const META_FILES_ROOT_DEV = "files_root_dev";
export const META_FILES_ROOT_INO = "files_root_ino";

export type LocalIndexErrorCode = "unsupported_schema_version";

export class LocalIndexError extends Error {
  readonly code: LocalIndexErrorCode;

  constructor(code: LocalIndexErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "LocalIndexError";
  }
}

type FileDirection = "pulled" | "pushed";
type FileState = "live" | "tombstoned";

interface FileEntry {
  readonly relPath: string;
  readonly lastSyncedSha: string;
  readonly lastSeenEtag?: string;
  readonly size: number;
  readonly lastSyncedMs: number;
  readonly direction: FileDirection;
  readonly state?: FileState;
  readonly tombstoneEtag?: string;
  readonly deletedAtMs?: number;
}

interface PendingDeleteEntry {
  readonly relPath: string;
  readonly baseEtag: string;
  readonly requestedAtMs: number;
  readonly mutationId?: string;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface SqliteRow {
  readonly [key: string]: unknown;
}

interface SqliteStatement {
  get(...params: unknown[]): SqliteRow | undefined;
  all(...params: unknown[]): SqliteRow[];
  run(...params: unknown[]): { readonly changes: number };
}

interface SqliteDatabase {
  close(): void;
  exec(sql: string): void;
  pragma(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
  transaction<T>(callback: () => T): () => T;
}

interface LocalIndexOptions {
  readonly sqlite: new (path: string) => SqliteDatabase;
}

export class LocalAgentStoreIndex {
  private static readonly openHandles = new Map<string, LocalAgentStoreIndex>();
  private readonly indexPath: string;
  private readonly db: SqliteDatabase;
  private opened: SecureSqlitePath | undefined;
  private closed = false;

  static open(indexPath: string, options: LocalIndexOptions): LocalAgentStoreIndex {
    const resolvedPath = path.resolve(indexPath);
    const existing = LocalAgentStoreIndex.openHandles.get(resolvedPath);
    if (existing !== undefined && !existing.closed) {
      return existing;
    }
    assertNoSymlinkInPath(resolvedPath);
    ensureSecureDirectoryChain(path.dirname(resolvedPath));
    assertNoSymlinkInPath(resolvedPath);
    const opened = openSecureSqlitePath(resolvedPath, PRIVATE_FILE_MODE);
    let db: SqliteDatabase | undefined;
    try {
      db = new options.sqlite(opened.sqlitePath);
      opened.verifyOpenedInode();
      restrictIndexFileModes(resolvedPath);
      const index = new LocalAgentStoreIndex(resolvedPath, db);
      index.opened = opened;
      index.migrate();
      index.restrictFileModes();
      LocalAgentStoreIndex.openHandles.set(resolvedPath, index);
      return index;
    } catch (error) {
      db?.close();
      opened.close();
      throw error;
    }
  }

  private constructor(indexPath: string, db: SqliteDatabase) {
    this.indexPath = indexPath;
    this.db = db;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.db.close();
    this.opened?.close();
    this.opened = undefined;
    this.closed = true;
    LocalAgentStoreIndex.openHandles.delete(this.indexPath);
  }

  getFile(relPath: string): FileEntry | undefined {
    const row = this.db.prepare("SELECT rel_path, last_synced_sha, last_seen_etag, size, last_synced_ms, direction, state, tombstone_etag, deleted_at_ms FROM files WHERE rel_path = ?").get(relPath);
    return row === undefined ? undefined : fileEntryFromRow(row);
  }

  listFiles(): FileEntry[] {
    const rows = this.db.prepare("SELECT rel_path, last_synced_sha, last_seen_etag, size, last_synced_ms, direction, state, tombstone_etag, deleted_at_ms FROM files ORDER BY rel_path ASC").all();
    return rows.map(fileEntryFromRow);
  }

  upsertFile(entry: FileEntry): void {
    const state = entry.state ?? "live";
    const tombstoneEtag = state === "tombstoned" ? entry.tombstoneEtag : null;
    const deletedAtMs = state === "tombstoned" ? entry.deletedAtMs : null;
    this.db.prepare(`
        INSERT INTO files (
          rel_path,
          last_synced_sha,
          last_seen_etag,
          size,
          last_synced_ms,
          direction,
          state,
          tombstone_etag,
          deleted_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(rel_path) DO UPDATE SET
          last_synced_sha = excluded.last_synced_sha,
          last_seen_etag = excluded.last_seen_etag,
          size = excluded.size,
          last_synced_ms = excluded.last_synced_ms,
          direction = excluded.direction,
          state = excluded.state,
          tombstone_etag = excluded.tombstone_etag,
          deleted_at_ms = excluded.deleted_at_ms
      `).run(entry.relPath, entry.lastSyncedSha, entry.lastSeenEtag ?? null, entry.size, entry.lastSyncedMs, entry.direction, state, tombstoneEtag ?? null, deletedAtMs ?? null);
    this.restrictFileModes();
  }

  listPendingDeletes(): PendingDeleteEntry[] {
    const rows = this.db.prepare("SELECT rel_path, base_etag, requested_at_ms, mutation_id FROM pending_deletes ORDER BY rel_path ASC").all();
    return rows.map(row => ({
      relPath: stringValue(row.rel_path),
      baseEtag: stringValue(row.base_etag),
      requestedAtMs: numberValue(row.requested_at_ms),
      ...(row.mutation_id === null || row.mutation_id === undefined ? {} : { mutationId: stringValue(row.mutation_id) }),
    }));
  }

  hasPendingDelete(relPath: string): boolean {
    const row = this.db.prepare("SELECT rel_path FROM pending_deletes WHERE rel_path = ?").get(relPath);
    return row !== undefined;
  }

  upsertPendingDelete(entry: PendingDeleteEntry): void {
    this.db.prepare(`
        INSERT INTO pending_deletes (
          rel_path,
          base_etag,
          requested_at_ms,
          mutation_id
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(rel_path) DO UPDATE SET
          base_etag = excluded.base_etag,
          requested_at_ms = excluded.requested_at_ms,
          mutation_id = excluded.mutation_id
      `).run(entry.relPath, entry.baseEtag, entry.requestedAtMs, entry.mutationId ?? null);
    this.restrictFileModes();
  }

  removePendingDelete(relPath: string): boolean {
    const result = this.db.prepare("DELETE FROM pending_deletes WHERE rel_path = ?").run(relPath);
    return result.changes > 0;
  }

  clearPendingDeletes(): number {
    const result = this.db.prepare("DELETE FROM pending_deletes").run();
    return result.changes;
  }

  disarmDeletionAndClearPending(): number {
    const disarm = this.db.transaction(() => {
      this.db.prepare(`
          INSERT INTO meta (key, value)
          VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(META_DELETION_ARMED, "0");
      this.db.prepare("DELETE FROM meta WHERE key = ?").run(META_FILES_ROOT_DEV);
      this.db.prepare("DELETE FROM meta WHERE key = ?").run(META_FILES_ROOT_INO);
      return this.db.prepare("DELETE FROM pending_deletes").run().changes;
    });
    const cleared = disarm();
    this.restrictFileModes();
    return cleared;
  }

  armDeletionWithIdentity(identity: FileIdentity): void {
    const arm = this.db.transaction(() => {
      const upsert = this.db.prepare(`
        INSERT INTO meta (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `);
      upsert.run(META_DELETION_ARMED, "1");
      upsert.run(META_FILES_ROOT_DEV, String(identity.dev));
      upsert.run(META_FILES_ROOT_INO, String(identity.ino));
    });
    arm();
    this.restrictFileModes();
  }

  deleteFile(relPath: string): boolean {
    const result = this.db.prepare("DELETE FROM files WHERE rel_path = ?").run(relPath);
    if (result.changes > 0) {
      this.restrictFileModes();
    }
    return result.changes > 0;
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row === null || row === undefined ? undefined : stringValue(row.value);
  }

  setMeta(entry: { readonly key: string; readonly value: string }): void {
    this.db.prepare(`
        INSERT INTO meta (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(entry.key, entry.value);
    this.restrictFileModes();
  }

  private migrate(): void {
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const version = this.getMeta("schema_version");
    if (version === undefined) {
      this.createCurrentSchema();
      return;
    }
    const parsedVersion = Number(version);
    if (!Number.isInteger(parsedVersion) || parsedVersion < 1 || parsedVersion > CURRENT_SCHEMA_VERSION) {
      throw new LocalIndexError("unsupported_schema_version", `Unsupported agent store index schema version: ${version}`);
    }
    this.createFilesTableIfNeeded();
    if (parsedVersion < 2) {
      this.migrateV1ToV2();
    }
    if (parsedVersion < 3) {
      this.migrateV2ToV3();
    }
  }

  private createCurrentSchema(): void {
    this.createFilesTableIfNeeded();
    this.createPendingDeletesTableIfNeeded();
    this.setMeta({ key: "schema_version", value: String(CURRENT_SCHEMA_VERSION) });
  }

  private createFilesTableIfNeeded(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        rel_path TEXT PRIMARY KEY,
        last_synced_sha TEXT NOT NULL,
        last_seen_etag TEXT,
        size INTEGER NOT NULL,
        last_synced_ms INTEGER NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('pulled', 'pushed')),
        state TEXT NOT NULL DEFAULT 'live' CHECK(state IN ('live', 'tombstoned')),
        tombstone_etag TEXT,
        deleted_at_ms INTEGER
      );
    `);
  }

  private createPendingDeletesTableIfNeeded(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_deletes (
        rel_path TEXT PRIMARY KEY,
        base_etag TEXT NOT NULL,
        requested_at_ms INTEGER NOT NULL,
        mutation_id TEXT
      );
    `);
  }

  private migrateV1ToV2(): void {
    const columns = this.db.prepare("PRAGMA table_info(files)").all();
    if (columns.some(column => column.name === "last_seen_sha")) {
      this.db.exec("ALTER TABLE files RENAME COLUMN last_seen_sha TO last_synced_sha");
    }
    if (!columns.some(column => column.name === "last_seen_etag")) {
      this.db.exec("ALTER TABLE files ADD COLUMN last_seen_etag TEXT");
    }
    this.setMeta({ key: "schema_version", value: "2" });
  }

  private migrateV2ToV3(): void {
    const columns = this.db.prepare("PRAGMA table_info(files)").all();
    if (!columns.some(column => column.name === "state")) {
      this.db.exec("ALTER TABLE files ADD COLUMN state TEXT NOT NULL DEFAULT 'live' CHECK(state IN ('live', 'tombstoned'))");
    }
    if (!columns.some(column => column.name === "tombstone_etag")) {
      this.db.exec("ALTER TABLE files ADD COLUMN tombstone_etag TEXT");
    }
    if (!columns.some(column => column.name === "deleted_at_ms")) {
      this.db.exec("ALTER TABLE files ADD COLUMN deleted_at_ms INTEGER");
    }
    this.createPendingDeletesTableIfNeeded();
    this.setMeta({ key: "schema_version", value: String(CURRENT_SCHEMA_VERSION) });
  }

  private restrictFileModes(): void {
    restrictIndexFileModes(this.indexPath);
  }
}

function fileEntryFromRow(row: SqliteRow): FileEntry {
  return {
    relPath: stringValue(row.rel_path),
    lastSyncedSha: stringValue(row.last_synced_sha),
    ...(row.last_seen_etag === null || row.last_seen_etag === undefined ? {} : { lastSeenEtag: stringValue(row.last_seen_etag) }),
    size: numberValue(row.size),
    lastSyncedMs: numberValue(row.last_synced_ms),
    direction: directionValue(row.direction),
    state: stateValue(row.state),
    ...(row.tombstone_etag === null || row.tombstone_etag === undefined ? {} : { tombstoneEtag: stringValue(row.tombstone_etag) }),
    ...(row.deleted_at_ms === null || row.deleted_at_ms === undefined ? {} : { deletedAtMs: numberValue(row.deleted_at_ms) }),
  };
}

function restrictIndexFileModes(indexPath: string): void {
  for (const filePath of [indexPath, `${indexPath}-wal`, `${indexPath}-shm`]) {
    if (fs.existsSync(filePath)) {
      fs.chmodSync(filePath, PRIVATE_FILE_MODE);
    }
  }
}

function stringValue(value: unknown): string {
  return value as string;
}

function numberValue(value: unknown): number {
  return value as number;
}

function directionValue(value: unknown): FileDirection {
  return value as FileDirection;
}

function stateValue(value: unknown): FileState {
  return value as FileState;
}
