import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { AGENT_CONTENT_SEARCH_MAX_MATCHES_PER_AGENT } from "./agent-content-search.js";
import { DB_BUSY_TIMEOUT_MS } from "../../storage/store-db.js";
export const SEARCH_INDEX_SCHEMA_VERSION = 1;
export const SEARCH_INDEX_FILENAME = "search-index.db";
export const FTS_QUERY_MAX_TERMS = 8;
export const SNIPPET_CONTEXT_TOKENS = 16;
export const META_RECONCILE_DONE = "reconcile_done";
export type AttachmentKind = "image" | "video" | "audio" | "pdf" | "markdown" | "table" | "json" | "text" | "document" | "archive" | "file";
const ATTACHMENT_KINDS = new Set<AttachmentKind>(["image","video","audio","pdf","markdown","table","json","text","document","archive","file"]);
export const SCHEMA = `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS agents (agent_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, entry_id TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('user', 'assistant')), timestamp_ms INTEGER NOT NULL, body TEXT NOT NULL, UNIQUE(agent_id, entry_id)) STRICT;
CREATE INDEX IF NOT EXISTS messages_agent_recency ON messages(agent_id, timestamp_ms DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(body, content='messages', content_rowid='id', tokenize='unicode61 remove_diacritics 2', prefix='2 3');
CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body); END;
CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.id, old.body); END;
CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages BEGIN INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.id, old.body); INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body); END;
CREATE TABLE IF NOT EXISTS media (id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, entry_id TEXT NOT NULL, file_name TEXT NOT NULL, ext TEXT NOT NULL, mime TEXT, kind TEXT NOT NULL, timestamp_ms INTEGER NOT NULL, width INTEGER, height INTEGER, UNIQUE(agent_id, entry_id)) STRICT;
CREATE INDEX IF NOT EXISTS media_recency ON media(timestamp_ms DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS media_fts USING fts5(file_name, content='media', content_rowid='id', tokenize='unicode61 remove_diacritics 2', prefix='2 3');
CREATE TRIGGER IF NOT EXISTS media_fts_insert AFTER INSERT ON media BEGIN INSERT INTO media_fts(rowid, file_name) VALUES (new.id, new.file_name); END;
CREATE TRIGGER IF NOT EXISTS media_fts_delete AFTER DELETE ON media BEGIN INSERT INTO media_fts(media_fts, rowid, file_name) VALUES ('delete', old.id, old.file_name); END;
CREATE TRIGGER IF NOT EXISTS media_fts_update AFTER UPDATE ON media BEGIN INSERT INTO media_fts(media_fts, rowid, file_name) VALUES ('delete', old.id, old.file_name); INSERT INTO media_fts(rowid, file_name) VALUES (new.id, new.file_name); END;`;
export function openSearchIndexDb(path: string): DatabaseSync { const db = new DatabaseSync(path); try { db.exec(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS}`); db.exec("PRAGMA journal_mode = WAL"); db.exec("PRAGMA synchronous = NORMAL"); db.exec("PRAGMA auto_vacuum = INCREMENTAL"); return db; } catch (error) { try { db.close(); } catch {} throw error; } }
export function ensureSearchIndexSchema(db: DatabaseSync): void { db.exec(SCHEMA); }
export function readSearchIndexSchemaVersion(db: DatabaseSync): number { const row = db.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined; return typeof row?.user_version === "number" ? row.user_version : 0; }
export function stampSearchIndexSchemaVersion(db: DatabaseSync): void { db.exec(`PRAGMA user_version = ${SEARCH_INDEX_SCHEMA_VERSION}`); }
export function readReconcileDone(db: DatabaseSync): boolean { const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(META_RECONCILE_DONE) as { value?: unknown } | undefined; return row?.value === "1"; }
export function writeReconcileDone(db: DatabaseSync): void { db.prepare("INSERT INTO meta (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run(META_RECONCILE_DONE); }
export function buildFtsMatchQuery(query: string): string | null { const terms = query.normalize("NFKC").trim().split(/\s+/).filter(Boolean).slice(0, FTS_QUERY_MAX_TERMS); return terms.length === 0 ? null : terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(" "); }
export interface MessageSearchResult { readonly agentId: string; readonly entryId: string; readonly role: "user" | "assistant"; readonly timestampMs: number; readonly snippet: string }
export interface MediaSearchResult { readonly agentId: string; readonly entryId: string; readonly fileName: string; readonly ext: string; readonly mime: string | null; readonly kind: AttachmentKind; readonly timestampMs: number; readonly width: number | null; readonly height: number | null }
function rows(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): Record<string, unknown>[] { return db.prepare(sql).all(...params) as Record<string, unknown>[]; }
export function searchMessages(db: DatabaseSync, query: string, limit: number): MessageSearchResult[] {
  const match = buildFtsMatchQuery(query);
  if (match == null || limit <= 0) return [];
  const effectiveTimestamp = `CASE
    WHEN m.timestamp_ms > 0 THEN m.timestamp_ms
    ELSE COALESCE((SELECT MAX(m2.timestamp_ms) FROM messages m2 WHERE m2.agent_id = m.agent_id), 0)
  END`;
  const result = rows(db, `SELECT
      m.agent_id AS agentId,
      m.entry_id AS entryId,
      m.role AS role,
      matched.ts AS timestampMs,
      snippet(messages_fts, 0, '', '', '…', ${SNIPPET_CONTEXT_TOKENS}) AS snippet
    FROM (
      SELECT fts_rowid, ts FROM (
        SELECT fts_rowid, ts,
          ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY ts DESC) AS agent_rank
        FROM (
          SELECT messages_fts.rowid AS fts_rowid, m.agent_id AS agent_id, ${effectiveTimestamp} AS ts
          FROM messages_fts
          JOIN messages m ON m.id = messages_fts.rowid
          WHERE messages_fts MATCH ?
        )
      )
      WHERE agent_rank <= ${AGENT_CONTENT_SEARCH_MAX_MATCHES_PER_AGENT}
      ORDER BY ts DESC
      LIMIT ?
    ) AS matched
    JOIN messages_fts ON messages_fts.rowid = matched.fts_rowid
    JOIN messages m ON m.id = matched.fts_rowid
    WHERE messages_fts MATCH ?
    ORDER BY matched.ts DESC`, match, limit, match);
  return result.flatMap((row) => typeof row.agentId === "string" && typeof row.entryId === "string" && (row.role === "user" || row.role === "assistant") && typeof row.timestampMs === "number" && typeof row.snippet === "string" ? [{ agentId: row.agentId, entryId: row.entryId, role: row.role, timestampMs: row.timestampMs, snippet: row.snippet.replace(/\s+/g, " ").trim() }] : []);
}
export function searchMedia(db: DatabaseSync, query: string, limit: number): MediaSearchResult[] { if (limit <= 0) return []; const match = buildFtsMatchQuery(query), columns = "md.agent_id AS agentId, md.entry_id AS entryId, md.file_name AS fileName, md.ext AS ext, md.mime AS mime, md.kind AS kind, md.timestamp_ms AS timestampMs, md.width AS width, md.height AS height", result = match == null ? rows(db, `SELECT ${columns} FROM media md ORDER BY md.timestamp_ms DESC LIMIT ?`, limit) : rows(db, `SELECT ${columns} FROM media_fts JOIN media md ON md.id = media_fts.rowid WHERE media_fts MATCH ? ORDER BY md.timestamp_ms DESC LIMIT ?`, match, limit); return result.flatMap((row) => { if (typeof row.agentId !== "string" || typeof row.entryId !== "string" || typeof row.fileName !== "string" || typeof row.ext !== "string" || typeof row.kind !== "string" || typeof row.timestampMs !== "number") return []; const kind = ATTACHMENT_KINDS.has(row.kind as AttachmentKind) ? row.kind as AttachmentKind : "file"; return [{ agentId: row.agentId, entryId: row.entryId, fileName: row.fileName, ext: row.ext, mime: typeof row.mime === "string" ? row.mime : null, kind, timestampMs: row.timestampMs, width: typeof row.width === "number" ? row.width : null, height: typeof row.height === "number" ? row.height : null }]; }); }
