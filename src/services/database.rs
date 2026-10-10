//! Database service for the application.

use crate::db::DbPool;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use std::collections::HashMap;
use std::time::SystemTime;

/// When a message was said, and — for a coworker's reply — when its run ended.
///
/// `sent_at` is the thread's order: a run is placed by when it began, so a
/// turn recovered after a restart still sits after the message it answers.
/// `finished_at` is the other end of the wait, for the peek stamp. Timing
/// JSON is the harness CUSTOM payload, when one arrived. Source JSON is the
/// run's `opengrok.inferenceSource` CUSTOM, when one arrived: which door the
/// reply came through, for its badge.
#[derive(Debug, Clone)]
pub struct SaveStamp {
    pub sent_at: SystemTime,
    pub finished_at: Option<SystemTime>,
    pub timing_json: Option<String>,
    pub source_json: Option<String>,
}

impl SaveStamp {
    pub fn at(sent_at: SystemTime) -> Self {
        Self {
            sent_at,
            finished_at: None,
            timing_json: None,
            source_json: None,
        }
    }
}

/// Database service for local session/message cache.
#[derive(Clone)]
pub struct DatabaseService {
    pool: DbPool,
}

impl DatabaseService {
    pub fn new(pool: DbPool) -> Self {
        Self { pool }
    }

    pub fn pool(&self) -> DbPool {
        self.pool.clone()
    }

    pub async fn create_session(&self, title: &str) -> Result<String> {
        let id = uuid::Uuid::now_v7().to_string();
        sqlx::query("INSERT INTO chat_sessions (id, title) VALUES (?, ?)")
            .bind(&id)
            .bind(title)
            .execute(&self.pool)
            .await?;
        Ok(id)
    }

    /// A session row under a caller-chosen id. Coworker threads use the
    /// coworker id, so their messages persist under the id the conversation
    /// already carries. A row that exists is left alone.
    pub async fn ensure_session(&self, id: &str, title: &str) -> Result<()> {
        sqlx::query("INSERT OR IGNORE INTO chat_sessions (id, title) VALUES (?, ?)")
            .bind(id)
            .bind(title)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// A session row for a thread the server listed and this Mac has never had.
    ///
    /// It is written with the thread's latest activity as the server gave it, not the moment it
    /// was written, so it sorts and reads as that on the next launch. When the thread began is
    /// not known here, and `created_at` is left empty to say so. A row that exists is left
    /// alone.
    pub async fn keep_listed_session(&self, id: &str, title: &str, updated_at: &str) -> Result<()> {
        sqlx::query(
            "INSERT OR IGNORE INTO chat_sessions (id, title, created_at, updated_at) VALUES (?, ?, '', ?)",
        )
        .bind(id)
        .bind(title)
        .bind(updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_sessions(&self) -> Result<Vec<ChatSession>> {
        let rows = sqlx::query_as::<_, ChatSession>(
            "SELECT id, title, created_at, updated_at FROM chat_sessions ORDER BY updated_at DESC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    pub async fn update_session_title(&self, id: &str, title: &str) -> Result<()> {
        sqlx::query(
            "UPDATE chat_sessions SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        )
        .bind(title)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn delete_session(&self, id: &str) -> Result<()> {
        sqlx::query("DELETE FROM chat_sessions WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// A message and, when it was more than words, the pieces it was made of.
    ///
    /// The two go in together: a half-written turn would come back as a bubble whose picture
    /// never arrived, which is the very thing keeping the pieces is here to stop.
    ///
    /// `run_id` is the run a coworker's reply came out of, and is what lets a thread be
    /// reconciled against the server without saying everything twice. The person's own messages
    /// came out of no run and carry none.
    /// Write a message down under the name its bubble already has.
    ///
    /// The id comes from the caller, and that is the whole point: a bubble whose row is filed
    /// under some other name cannot be deleted, edited or found again — the statement runs, no
    /// row matches, and the next reload paints the message straight back. The caller has an id
    /// from the moment the bubble exists, so there is nothing to mint here and nothing to hand
    /// back. Writing the same message twice is the same row twice, not two rows: a run that is
    /// settled by two paths at once (the live stream and the watcher) must not say everything
    /// twice.
    #[allow(clippy::too_many_arguments)]
    pub async fn save_message(
        &self,
        id: &str,
        session_id: &str,
        role: &str,
        content: &str,
        model: Option<String>,
        provider: Option<String>,
        reply: Option<ReplyRef>,
        parts: &[MessagePart],
        run_id: Option<&str>,
        hidden: bool,
        // When the message was said, not when it reached the database: a reply recovered from
        // the server happened before the turns either side of it, and the moment it was
        // recovered would put it at the bottom of the thread on the next load. Finished-at
        // and the harness timing JSON ride along; they never move `sent_at`.
        stamp: SaveStamp,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("UPDATE chat_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            .bind(session_id)
            .execute(&mut *tx)
            .await?;

        sqlx::query(
            // A message hidden before it was ever written down is written down hidden, and a
            // write that comes later never clears a mark that is already there. The person
            // can hide a reply while it is still being typed out, and the row for it does not
            // exist until the turn settles.
            //
            // The badge is the run's, not the row's. A second write for the same run that knows
            // no source keeps the one there; a write that files the row under another run takes
            // that run's source, or none, because the door the old run went through says nothing
            // about the new one. (Every `chat_messages.*` in the SET is the row before this write.)
            "INSERT INTO chat_messages (id, session_id, role, content, model, provider, reply_to_id, reply_preview, reply_is_me, run_id, deleted_at, created_at, finished_at, run_timing, inference_source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               content = excluded.content,
               model = excluded.model,
               provider = excluded.provider,
               run_id = excluded.run_id,
               deleted_at = coalesce(chat_messages.deleted_at, excluded.deleted_at),
               finished_at = coalesce(excluded.finished_at, chat_messages.finished_at),
               run_timing = coalesce(excluded.run_timing, chat_messages.run_timing),
               inference_source = CASE
                 WHEN chat_messages.run_id IS excluded.run_id
                   THEN coalesce(excluded.inference_source, chat_messages.inference_source)
                 ELSE excluded.inference_source
               END",
        )
        .bind(id)
        .bind(session_id)
        .bind(role)
        .bind(content)
        .bind(model)
        .bind(provider)
        .bind(reply.as_ref().map(|r| r.message_id.clone()))
        .bind(reply.as_ref().map(|r| r.preview.clone()))
        .bind(reply.as_ref().map(|r| i64::from(r.is_me)))
        .bind(run_id)
        .bind(hidden.then(Self::hidden_now))
        // Only on the way in: a second write of the same message is the same message, said
        // when it was said.
        .bind(Self::stamp(stamp.sent_at).unwrap_or_else(Self::hidden_now))
        .bind(stamp.finished_at.and_then(Self::stamp))
        .bind(stamp.timing_json.as_deref())
        .bind(stamp.source_json.as_deref())
        .execute(&mut *tx)
        .await?;

        // A second write of the same message brings the whole of its pieces, so the first
        // write's are cleared rather than left to pile up beside them.
        sqlx::query("DELETE FROM chat_message_parts WHERE message_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;

        for (ord, part) in parts.iter().enumerate() {
            sqlx::query(
                "INSERT INTO chat_message_parts (message_id, ord, kind, text, call_id, image, width, height) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(id)
            .bind(ord as i64)
            .bind(part.kind())
            .bind(part.text())
            .bind(part.call_id())
            .bind(part.image())
            .bind(part.width())
            .bind(part.height())
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// Write down which door a reply came through, learned from a replay of its run, on the
    /// reply's row. Only a row still filed under that run takes it: the badge is the run's, as in
    /// `save_message`, and a row since written under another run keeps the source that write
    /// gave it, or none. Nothing else of the row is touched, and a reply not written down yet has
    /// no row to take it; the write that makes one carries the badge from its bubble. Reports
    /// whether a row took it.
    pub async fn keep_reply_source(
        &self,
        id: &str,
        run_id: &str,
        source_json: &str,
    ) -> Result<bool> {
        let written = sqlx::query(
            "UPDATE chat_messages SET inference_source = ? WHERE id = ? AND run_id = ?",
        )
        .bind(source_json)
        .bind(id)
        .bind(run_id)
        .execute(&self.pool)
        .await?
        .rows_affected();
        Ok(written == 1)
    }

    /// Write down something the person said that a replay brought back, under the id it was
    /// sent with, unless a row already has that id.
    ///
    /// Not `save_message`: that one's second write is an update, and it clears the message's
    /// pieces. The id here is whatever the server put in `messageId`, and a row's id is unique
    /// across every thread. A recovered question that is already on disk is already right, and
    /// an id that names some other row must never rewrite that row's words or take its pieces.
    /// Reports whether a row was written.
    pub async fn keep_recovered_question(
        &self,
        id: &str,
        session_id: &str,
        content: &str,
        sent_at: SystemTime,
    ) -> Result<bool> {
        let written = sqlx::query(
            "INSERT OR IGNORE INTO chat_messages (id, session_id, role, content, created_at)
             VALUES (?, ?, 'user', ?, ?)",
        )
        .bind(id)
        .bind(session_id)
        .bind(content)
        .bind(Self::stamp(sent_at).unwrap_or_else(Self::hidden_now))
        .execute(&self.pool)
        .await?
        .rows_affected();
        Ok(written == 1)
    }

    /// The stamp a hidden row carries, in the same shape as `created_at`.
    fn hidden_now() -> String {
        chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string()
    }

    /// A time as a row carries it: to the millisecond, so a turn read back off the server and
    /// the message it answered do not land in the same second with nothing to order them by.
    /// It reads the same as the old whole-second stamps and sorts beside them.
    ///
    /// `None` for a time chrono cannot hold: both clocks can come from the server, and chrono's
    /// own `From<SystemTime>` panics on them.
    fn stamp(at: SystemTime) -> Option<String> {
        let since = at.duration_since(SystemTime::UNIX_EPOCH).ok()?;
        let ms = i64::try_from(since.as_millis()).ok()?;
        let at = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)?;
        Some(at.format("%Y-%m-%d %H:%M:%S%.3f").to_string())
    }

    /// Rewrite a message's words. A queued send that is edited before it drains has to
    /// change the row as well as the bubble, or a reload paints the old sentence.
    pub async fn update_message_content(&self, id: &str, content: &str) -> Result<()> {
        sqlx::query("UPDATE chat_messages SET content = ? WHERE id = ?")
            .bind(content)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Hide a message rather than take it away.
    ///
    /// The row is what names the run it came out of, and a thread that can name a run does not
    /// fetch it back from the server. Take the row away and the thread forgets, and what the
    /// person deleted returns on their next visit. So the row stays, stamped, and nothing
    /// paints it.
    pub async fn hide_message(&self, id: &str) -> Result<()> {
        sqlx::query(
            "UPDATE chat_messages SET deleted_at = strftime('%Y-%m-%d %H:%M:%S', 'now') WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// A thread's messages, each carrying the pieces saved under it. A message written before
    /// pieces were kept has none, and reads back as the words in `content`.
    pub async fn get_messages(&self, session_id: &str) -> Result<Vec<ChatMessage>> {
        let mut rows = sqlx::query_as::<_, ChatMessage>(
            "SELECT id, session_id, role, content, created_at, model, provider, reply_to_id, reply_preview, reply_is_me, run_id, deleted_at, finished_at, run_timing, inference_source FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC, id ASC",
        )
        .bind(session_id)
        .fetch_all(&self.pool)
        .await?;

        let part_rows = sqlx::query_as::<_, PartRow>(
            "SELECT p.message_id, p.kind, p.text, p.call_id, p.image, p.width, p.height FROM chat_message_parts p JOIN chat_messages m ON m.id = p.message_id WHERE m.session_id = ? ORDER BY p.message_id, p.ord",
        )
        .bind(session_id)
        .fetch_all(&self.pool)
        .await?;

        let mut by_message: HashMap<String, Vec<MessagePart>> = HashMap::new();
        for row in part_rows {
            let message_id = row.message_id.clone();
            if let Some(part) = row.into_part() {
                by_message.entry(message_id).or_default().push(part);
            }
        }
        for row in &mut rows {
            row.parts = by_message.remove(&row.id).unwrap_or_default();
        }
        Ok(rows)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ChatSession {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ChatMessage {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub created_at: String,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub reply_to_id: Option<String>,
    pub reply_preview: Option<String>,
    pub reply_is_me: Option<i64>,
    /// The run this reply came out of, when it came out of one. It is how a thread being
    /// reconciled against the server tells a run it has already written down from one it has
    /// only just heard about.
    pub run_id: Option<String>,
    /// When the person hid this message, for a message they hid. The row stays so the thread
    /// can still name its run; nothing paints it.
    pub deleted_at: Option<String>,
    /// When the run ended, for a coworker's reply. Null on the person's own
    /// messages, on rows written before this column, and on a bubble still
    /// being filled in.
    pub finished_at: Option<String>,
    /// Harness CUSTOM `run-timing` JSON (`v:1`), when the turn sent one.
    pub run_timing: Option<String>,
    /// The run's `opengrok.inferenceSource` CUSTOM, `{"kind", "model"}`, when the server sent
    /// one: which door the reply came through.
    pub inference_source: Option<String>,
    /// The pieces of the message, in the order they were seen. They live in a table of their own
    /// so the picture bytes stay off this row; `get_messages` is what fills this in.
    #[sqlx(skip)]
    pub parts: Vec<MessagePart>,
}

/// One piece of a saved message: the words of a bubble, a picture of the box's screen with the
/// caption the tool wrote under it, a widget, a step the coworker took or a thought it had.
///
/// A permission card is deliberately not one of these. It belongs to a run that is long over by
/// the time the thread is opened again, and reviving it would ask the person to allow something
/// that has already happened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum MessagePart {
    Text(String),
    Screenshot {
        call_id: String,
        caption: String,
        /// The PNG as it arrived, not base64: a third smaller, and out of the text column.
        image: Vec<u8>,
        width: u32,
        height: u32,
    },
    /// A generative widget the coworker answered with — a form of choice chips, a bar chart —
    /// kept as the JSON it was parsed from, so the thread mounts the same widget when it is read
    /// back. Without it a turn that said nothing but the form came back as its stand-in line
    /// alone, "[used form]", on the very next visit.
    Ui {
        /// `{"component": "form" | "bar-chart", ...}` as `UiSpec::to_value` writes it.
        spec: String,
    },
    /// A tool call the coworker made, as its step row showed it: without it a reopened thread
    /// would show the words and lose what was done between them.
    Step {
        call_id: String,
        /// `{"tool", "arguments", "result", "ok"}` as `StepSpec::to_value` writes it.
        spec: String,
    },
    /// A document the turn's `opengrok.officeDoc` frames named, as the `OfficeDocSpec::to_value`
    /// JSON the card parsed — thin on purpose: the bytes and pages stay on the server and are
    /// fetched again, only the card's identity is kept.
    OfficeDoc {
        spec: String,
    },
    /// What the coworker thought on the way, as its "Thought" row showed it.
    Reasoning(String),
}

impl MessagePart {
    fn kind(&self) -> &'static str {
        match self {
            Self::Text(_) => "text",
            Self::Screenshot { .. } => "screenshot",
            Self::OfficeDoc { .. } => "officedoc",
            Self::Ui { .. } => "ui",
            Self::Step { .. } => "step",
            Self::Reasoning(_) => "reasoning",
        }
    }

    /// One text column serves them all: a text part's words, a screenshot's caption, a
    /// widget's or a step's JSON, a thought.
    fn text(&self) -> String {
        match self {
            Self::Text(text) | Self::Reasoning(text) => text.clone(),
            Self::Screenshot { caption, .. } => caption.clone(),
            Self::Ui { spec } | Self::Step { spec, .. } | Self::OfficeDoc { spec } => spec.clone(),
        }
    }

    fn call_id(&self) -> Option<String> {
        match self {
            Self::Text(_) | Self::Ui { .. } | Self::Reasoning(_) | Self::OfficeDoc { .. } => None,
            Self::Screenshot { call_id, .. } | Self::Step { call_id, .. } => Some(call_id.clone()),
        }
    }

    fn image(&self) -> Option<Vec<u8>> {
        match self {
            Self::Text(_)
            | Self::Ui { .. }
            | Self::Step { .. }
            | Self::Reasoning(_)
            | Self::OfficeDoc { .. } => None,
            Self::Screenshot { image, .. } => Some(image.clone()),
        }
    }

    fn width(&self) -> Option<i64> {
        match self {
            Self::Text(_)
            | Self::Ui { .. }
            | Self::Step { .. }
            | Self::Reasoning(_)
            | Self::OfficeDoc { .. } => None,
            Self::Screenshot { width, .. } => Some(i64::from(*width)),
        }
    }

    fn height(&self) -> Option<i64> {
        match self {
            Self::Text(_)
            | Self::Ui { .. }
            | Self::Step { .. }
            | Self::Reasoning(_)
            | Self::OfficeDoc { .. } => None,
            Self::Screenshot { height, .. } => Some(i64::from(*height)),
        }
    }
}

#[derive(Debug, Clone, FromRow)]
struct PartRow {
    message_id: String,
    kind: String,
    text: Option<String>,
    call_id: Option<String>,
    image: Option<Vec<u8>>,
    width: Option<i64>,
    height: Option<i64>,
}

impl PartRow {
    /// A screenshot whose bytes are gone still has its caption, so it comes back as text rather
    /// than as nothing.
    ///
    /// A kind this build does not know is one a later build wrote, and it is left out rather
    /// than shown as whatever its text column holds, which for a step is its JSON. The message's
    /// words are in its other parts and in its own text, so a thread read by an older build
    /// still says everything that was said.
    fn into_part(self) -> Option<MessagePart> {
        let text = self.text.unwrap_or_default();
        match self.kind.as_str() {
            "text" => Some(MessagePart::Text(text)),
            "screenshot" => match (self.image, self.width, self.height) {
                (Some(image), Some(width), Some(height)) => Some(MessagePart::Screenshot {
                    call_id: self.call_id.unwrap_or_default(),
                    caption: text,
                    image,
                    width: width.max(0) as u32,
                    height: height.max(0) as u32,
                }),
                _ => Some(MessagePart::Text(text)),
            },
            "ui" => Some(MessagePart::Ui { spec: text }),
            "officedoc" => Some(MessagePart::OfficeDoc { spec: text }),
            "step" => Some(MessagePart::Step {
                call_id: self.call_id.unwrap_or_default(),
                spec: text,
            }),
            "reasoning" => Some(MessagePart::Reasoning(text)),
            _ => None,
        }
    }
}

/// The message a saved message answers. Rows written before replies were kept have none of it,
/// which is why every column is nullable and this is an `Option` at the call.
#[derive(Debug, Clone)]
pub struct ReplyRef {
    pub message_id: String,
    pub preview: String,
    pub is_me: bool,
}
