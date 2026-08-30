export const WINDOW_ENTRY_FILTER_SQL = `json_extract(entry, '$.kind') != 'tool-call'
        AND COALESCE(json_extract(entry, '$.branched'), 0) != 1`;
export const BRANCHED_ENTRY_FILTER_SQL = `COALESCE(json_extract(entry, '$.branched'), 0) = 1`;
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
-- Conversation blobs are owned by the agent's isolation worker in its own
-- conversation-blobs.db; this legacy table remains readable for adoption and salvage.
CREATE TABLE IF NOT EXISTS blobs (
  id TEXT PRIMARY KEY,
  data BLOB NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS transcript_entries (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  entry TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_transcript_window
  ON transcript_entries(seq, entry)
  WHERE ${WINDOW_ENTRY_FILTER_SQL};
CREATE INDEX IF NOT EXISTS idx_transcript_branched
  ON transcript_entries(seq, entry)
  WHERE ${BRANCHED_ENTRY_FILTER_SQL};
`;
export const MAIN_TRANSCRIPT_MESSAGE_FILTER_SQL = `
        COALESCE(json_extract(entry, '$.branched'), 0) != 1
        AND (
          json_extract(entry, '$.kind') IN ('send-message', 'user-attachment')
          OR (
            json_extract(entry, '$.kind') = 'message'
            AND (
              json_extract(entry, '$.role') = 'user'
              OR json_extract(entry, '$.fromAgent') IS NOT NULL
              OR json_extract(entry, '$.toAgent') IS NOT NULL
            )
          )
        )`;
export const DIVIDER_ANCHOR_ENTRY_FILTER_SQL = `
        ${MAIN_TRANSCRIPT_MESSAGE_FILTER_SQL}
        AND NOT (
          json_extract(entry, '$.kind') = 'user-attachment'
          OR (
            json_extract(entry, '$.kind') = 'message'
            AND json_extract(entry, '$.role') = 'user'
            AND json_extract(entry, '$.fromAgent') IS NULL
            AND json_extract(entry, '$.toAgent') IS NULL
          )
        )`;

export interface PreparedStatement { all(...parameters: unknown[]): unknown[]; get(...parameters: unknown[]): unknown; run(...parameters: unknown[]): unknown }
export interface StatementDatabase { prepare(sql: string): PreparedStatement }
export function prepareStatements(db: StatementDatabase): Record<string, PreparedStatement> {
  return {
    getKv: db.prepare("SELECT value FROM kv WHERE key = ?"),
    setKv: db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
    compareAndSetKv: db.prepare("UPDATE kv SET value = ? WHERE key = ? AND value = ?"), deleteKv: db.prepare("DELETE FROM kv WHERE key = ?"),
    hasLegacyBlob: db.prepare("SELECT 1 AS present FROM blobs LIMIT 1"), clearBlobs: db.prepare("DELETE FROM blobs"), listTranscriptEntries: db.prepare("SELECT entry FROM transcript_entries ORDER BY seq"),
    newestDividerAnchorTimestamp: db.prepare(`SELECT json_extract(entry, '$.timestampMs') AS timestampMs FROM transcript_entries WHERE json_extract(entry, '$.timestampMs') IS NOT NULL AND ${DIVIDER_ANCHOR_ENTRY_FILTER_SQL} ORDER BY seq DESC LIMIT 1`),
    listTranscriptPage: db.prepare(`SELECT seq, entry FROM transcript_entries WHERE (? IS NULL OR seq < ?) AND (json_extract(entry, '$.timestampMs') IS NULL OR (? IS NULL OR json_extract(entry, '$.timestampMs') >= ?)) AND (json_extract(entry, '$.timestampMs') IS NULL OR json_extract(entry, '$.timestampMs') <= ?) AND ${MAIN_TRANSCRIPT_MESSAGE_FILTER_SQL} ORDER BY seq DESC LIMIT ?`),
    listTranscriptWindow: db.prepare(`SELECT seq, entry FROM transcript_entries WHERE (? IS NULL OR seq < ?) AND ${WINDOW_ENTRY_FILTER_SQL} ORDER BY seq DESC LIMIT ?`),
    listTranscriptTail: db.prepare("SELECT seq, entry FROM transcript_entries WHERE (? IS NULL OR seq < ?) ORDER BY seq DESC LIMIT ?"),
    listBranchedEntries: db.prepare(`SELECT entry FROM transcript_entries WHERE ${BRANCHED_ENTRY_FILTER_SQL} ORDER BY seq`), getTranscriptEntry: db.prepare("SELECT entry FROM transcript_entries WHERE id = ?"),
    insertTranscriptEntry: db.prepare("INSERT OR IGNORE INTO transcript_entries (id, entry) VALUES (?, ?)"), updateTranscriptEntry: db.prepare("UPDATE transcript_entries SET entry = ? WHERE id = ?"), deleteTranscriptEntry: db.prepare("DELETE FROM transcript_entries WHERE id = ?"), clearTranscriptEntries: db.prepare("DELETE FROM transcript_entries")
  };
}
