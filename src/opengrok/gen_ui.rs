//! Generative UI on an AG-UI stream.
//!
//! Text (`TEXT_MESSAGE_*`) paints as it arrives. A bar chart or form is a
//! *different* event (tool call, CUSTOM, or a complete `{"ui":...}` object)
//! and mounts only when its JSON is whole. Incomplete JSON is held, not
//! rendered as markdown, and does not stall the prose around it.

use std::collections::HashSet;
use std::time::Instant;

use serde_json::{Value, json};

use super::client::LocalExecMode;
use super::credential::SaveLoginSpec;
use super::inference::{INFERENCE_SOURCE_CUSTOM, ReplySource};
use super::user_form::{
    ComputerHandoffSpec, UserFormSpec, is_user_form_awaiting, is_user_form_tool,
};
use super::visibility::{ImageVisibility, pin_shot_at_turn_end, pin_shot_now};
use crate::threads::{conversation_for_thread, is_mcp_thread};

#[derive(Debug, Clone, PartialEq)]
pub enum ChatPart {
    Text(String),
    Ui(UiSpec),
    /// A tool the person must allow or refuse before the run continues.
    Approval(ApprovalSpec),
    /// The bot's screen when it belongs in the feed (`image.visibility` =
    /// `transcript` | `failure` | `end`, or an untagged turn-end/failure pin).
    /// `agent` shots stay off this list and paint in the Computer pane.
    Screenshot(ScreenshotSpec),
    /// In-chat credentials that fill the box page. Not [`UiSpec::Form`], not a vault.
    UserForm(UserFormSpec),
    /// Opt-in save prompt after Continue. Origin + username only — never a password.
    SaveLogin(SaveLoginSpec),
    /// A tool call the coworker made, where it made it: a collapsed row between the words
    /// around it. A chart, a form and a user-form are not steps; they are drawn as themselves.
    Step(StepSpec),
    /// What the coworker thought on the way (`REASONING_MESSAGE_*`), as a collapsed "Thought"
    /// row. It is never part of the reply's words.
    Reasoning(ThoughtSpec),
    /// The whole answer to a message whose tagged plugins need something first: which account,
    /// an account at all, or an install (`opengrok.pluginNeeds`, #360). No model was asked.
    PluginNeeds(PluginNeedsSpec),
    /// A document the turn is working on (`opengrok.officeDoc`): its card in the feed is the
    /// window's anchor — click it and the document window is on it.
    OfficeDoc(OfficeDocSpec),
}

/// The CUSTOM a turn answers with, instead of asking the model, when a plugin its message tagged
/// cannot be used yet (opengrok-server `plugin_needs_answer` in `crates/opengrok-server/src/agui/
/// routes.rs` and `turn::needs` in `crates/opengrok-integrations/src/turn.rs`, #360,
/// gol/service-accounts).
pub const PLUGIN_NEEDS_CUSTOM: &str = "opengrok.pluginNeeds";

/// The plugin tool whose answer is a card for the person rather than words for the model
/// (opengrok-tools `plugin_desk::ADD_PLUGIN_ACCOUNT`, #359).
pub const ADD_PLUGIN_ACCOUNT: &str = "add_plugin_account";

/// What each tagged plugin still needs, in the order the server listed them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginNeedsSpec {
    pub needs: Vec<PluginNeed>,
    /// Whether answering it sends the message again: a turn that stopped for the card did not
    /// run, while the Bot's own `add_plugin_account` card comes from a turn that did.
    pub send_again: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginNeed {
    pub plugin: String,
    /// The service an account is for; none on an install.
    pub connector: Option<String>,
    pub kind: PluginNeedKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PluginNeedKind {
    /// Tagged and not installed.
    Install,
    /// No account for a service that needs one.
    Account,
    /// Several accounts and nothing says which: `(id, label, kind)` of each, never a secret.
    Choose(Vec<(String, String, String)>),
}

impl PluginNeedsSpec {
    /// The card a `opengrok.pluginNeeds` frame carries; `None` for any other frame, or one whose
    /// needs this app cannot read (a need it does not know is left out, not guessed at).
    pub fn from_event(event: &Value) -> Option<Self> {
        if event.get("name").and_then(Value::as_str) != Some(PLUGIN_NEEDS_CUSTOM) {
            return None;
        }
        let listed = event.get("value")?.get("needs")?.as_array()?;
        let text =
            |need: &Value, key: &str| need.get(key).and_then(Value::as_str).map(str::to_string);
        let needs: Vec<PluginNeed> = listed
            .iter()
            .filter_map(|need| {
                let kind = match need.get("need").and_then(Value::as_str)? {
                    "install" => PluginNeedKind::Install,
                    "account" => PluginNeedKind::Account,
                    "choose" => PluginNeedKind::Choose(
                        need.get("accounts")?
                            .as_array()?
                            .iter()
                            .filter_map(|account| {
                                Some((
                                    text(account, "id")?,
                                    text(account, "label")?,
                                    text(account, "kind").unwrap_or_default(),
                                ))
                            })
                            .collect(),
                    ),
                    _ => return None,
                };
                Some(PluginNeed {
                    plugin: text(need, "plugin")?,
                    connector: text(need, "connector"),
                    kind,
                })
            })
            .collect();
        (!needs.is_empty()).then_some(Self {
            needs,
            send_again: true,
        })
    }
}

/// The CUSTOM an `office_*` tool emits for every document it opens or touches: thin by design
/// (opengrok-server `frame` in `crates/opengrok-server/src/office_desk.rs`, gol/betteroffice) —
/// id, path, kind, version, which change — and the document window pulls bytes and rendered
/// pages through `GET /office/docs/{id}/…` rather than receiving them here.
pub const OFFICE_DOC_CUSTOM: &str = "opengrok.officeDoc";

/// One office document a turn is working on, as its newest `opengrok.officeDoc` frame
/// described it. The card in the feed and a tab in the document window both read this.
#[derive(Debug, Clone, PartialEq)]
pub struct OfficeDocSpec {
    /// The session handle, `odoc_…`: what the fetch routes take.
    pub doc_id: String,
    /// The file's path on the Bot's computer.
    pub path: String,
    /// `docx`, `xlsx` or `pptx` (the server's `Kind::extension`).
    pub kind: String,
    /// The session's mutation count: every applied change bumps it, so a card holding an
    /// older number is stale and a held page is worth refetching.
    pub version: u64,
    /// The artifact an `office_export` attached to the reply, when the change was one.
    pub artifact_id: Option<String>,
    /// What the last frame says changed (`{"type": "created"|"edited"|…}`), kept whole so the
    /// window can still read fields a later card stops painting.
    pub changed: Value,
}

impl OfficeDocSpec {
    /// The document a `opengrok.officeDoc` frame carries; `None` for any other frame or one
    /// missing its identity (a frame without a doc id or path names nothing).
    pub fn from_custom(name: &str, value: &Value) -> Option<Self> {
        if name != OFFICE_DOC_CUSTOM {
            return None;
        }
        Self::from_value(value)
    }

    /// The same shape out of storage: [`saved_parts`] keeps it as `to_value` wrote it.
    pub fn from_value(value: &Value) -> Option<Self> {
        Some(Self {
            doc_id: value.get("docId")?.as_str()?.to_string(),
            path: value.get("path")?.as_str()?.to_string(),
            kind: value.get("kind")?.as_str()?.to_string(),
            version: value.get("version")?.as_u64()?,
            artifact_id: value
                .get("artifactId")
                .and_then(Value::as_str)
                .map(str::to_string),
            changed: value.get("changed").cloned().unwrap_or(Value::Null),
        })
    }

    /// The frame's own shape, for the stored copy a reopened thread reads back.
    pub fn to_value(&self) -> Value {
        json!({
            "docId": self.doc_id,
            "path": self.path,
            "kind": self.kind,
            "version": self.version,
            "artifactId": self.artifact_id,
            "changed": self.changed,
        })
    }

    /// The file's name as the card and the tab say it: the path's last segment.
    pub fn file_name(&self) -> &str {
        self.path.rsplit('/').next().unwrap_or(&self.path)
    }

    /// The kind's badge word.
    pub fn kind_label(&self) -> String {
        self.kind.to_uppercase()
    }

    /// The last change's `type` word, for the card's subline.
    pub fn changed_type(&self) -> Option<&str> {
        self.changed.get("type").and_then(Value::as_str)
    }
}

/// A visible reasoning segment and its locally observed duration, never a guessed model round.
#[derive(Debug, Clone, PartialEq)]
pub struct ThoughtSpec {
    pub text: String,
    pub took_ms: Option<u64>,
}

impl From<String> for ThoughtSpec {
    fn from(text: String) -> Self {
        Self {
            text,
            took_ms: None,
        }
    }
}

impl From<&str> for ThoughtSpec {
    fn from(text: &str) -> Self {
        text.to_string().into()
    }
}

impl ThoughtSpec {
    pub fn took(&self) -> Option<String> {
        self.took_ms.map(super::timing::format_ms)
    }

    /// Versioned local storage preserves existing plain-text reasoning rows.
    pub fn stored(&self) -> String {
        serde_json::json!({"nativechat_reasoning_v": 1, "text": self.text,
            "took_ms": self.took_ms})
        .to_string()
    }

    pub fn from_stored(stored: &str) -> Self {
        if let Ok(value) = serde_json::from_str::<Value>(stored)
            && value["nativechat_reasoning_v"].as_u64() == Some(1)
            && let Some(text) = value["text"].as_str()
        {
            return Self {
                text: capped(text),
                took_ms: value["took_ms"].as_u64(),
            };
        }
        capped(stored).into()
    }
}

fn observed_ms(start: Option<Instant>, end: Option<Instant>) -> Option<u64> {
    let ms = end?.checked_duration_since(start?)?.as_millis();
    // A shared delivery boundary says nothing about the duration inside a buffered batch.
    (ms > 0).then(|| u64::try_from(ms).unwrap_or(u64::MAX))
}

/// One tool call as the reply shows it, from what the server sent for it: `TOOL_CALL_START`
/// `{toolCallId, toolCallName}`, `TOOL_CALL_ARGS` `{toolCallId, delta}` and `TOOL_CALL_RESULT`
/// `{toolCallId, content, ok}` (opengrok-harness `projection.rs` `push` and `push_tool_result`,
/// as `fixtures/wire/agui/TOOL_CALL_*` carries them).
///
/// What the row says is not kept. It is worked out from `tool` and `arguments` when the row is
/// drawn, by the words the status line uses for the same call, so the two cannot disagree.
#[derive(Debug, Clone, PartialEq)]
pub struct StepSpec {
    pub call_id: String,
    /// `toolCallName`, as sent.
    pub tool: String,
    /// The arguments as JSON, once they have all arrived, held to what the approval card may
    /// say of the call ([`step_arguments`]) and kept to [`STEP_TEXT_CAP`]. Empty until then.
    pub arguments: String,
    /// `TOOL_CALL_RESULT.content`, kept to [`STEP_TEXT_CAP`]. `None` until it arrives.
    pub result: Option<String>,
    /// `TOOL_CALL_RESULT.ok`. `None` until it arrives.
    pub ok: Option<bool>,
    /// How long the call's answer took, in milliseconds: from its `TOOL_CALL_END` to its
    /// `TOOL_CALL_RESULT`, as this app received the two (see [`TurnAssembler::push_event_at`]).
    ///
    /// Measured here because the wire has no time for a call: the harness's `run-timing` frame
    /// lists its tools by name and not by call (opengrok-harness `timing.rs` `ToolPhase`), and
    /// every frame of a run carries the run's opening `timestamp` (`projection.rs` `event`).
    /// `None` wherever this app did not watch both arrive, or cannot say whose time it was: a
    /// replay, a call already under way when the app began following its run, a call answered
    /// together with another (the harness sends a round's results only once all of them have
    /// run), and a call that waited on a person. None of those is guessed at.
    pub took_ms: Option<u64>,
}

/// How much of a step's arguments and of its result, and of a thought, is kept: a step row is
/// cloned into every repaint of a turn that can run to hundreds of them, a shell's output can
/// be megabytes, and so can a model's reasoning.
pub(crate) const STEP_TEXT_CAP: usize = 4 * 1024;

/// How a step came out, as its row marks it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepStatus {
    /// No result yet.
    Running,
    Ok,
    Failed,
}

impl StepStatus {
    /// The word gpui-agent reads.
    pub fn word(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Ok => "ok",
            Self::Failed => "failed",
        }
    }

    /// The mark at the front of the row.
    pub fn mark(self) -> &'static str {
        match self {
            Self::Running => "…",
            Self::Ok => "✓",
            Self::Failed => "✗",
        }
    }
}

impl StepSpec {
    /// What the row says the call did: "Running `cargo test`", "Reading main.rs", "Using
    /// <tool>". The status line's own words for the call.
    pub fn label(&self) -> String {
        super::activity::describe_tool(&self.tool, Some(&self.arguments))
    }

    pub fn status(&self) -> StepStatus {
        match (&self.result, self.ok) {
            (None, _) => StepStatus::Running,
            (Some(_), Some(false)) => StepStatus::Failed,
            (Some(_), _) => StepStatus::Ok,
        }
    }

    /// The arguments as the opened row shows them. See [`super::activity::describe_arguments`].
    pub fn shown_arguments(&self) -> Option<String> {
        super::activity::describe_arguments(&self.tool, &self.arguments)
    }

    /// How long the call took, as the end of its row says it: `1s`, `350ms`. `None` when this
    /// app did not time it (see [`Self::took_ms`]).
    pub fn took(&self) -> Option<String> {
        self.took_ms.map(super::timing::format_ms)
    }

    /// The step as its database row keeps it (`chat_message_parts.text` of a `step` row), for
    /// [`Self::from_value`] to read back unchanged. The call id has a column of its own. A time
    /// this app measured is kept with it, since nothing can measure it again once the turn is
    /// over; a row written before there were any reads back with none.
    pub fn to_value(&self) -> Value {
        let mut value = serde_json::json!({
            "tool": self.tool,
            "arguments": self.arguments,
            "result": self.result,
            "ok": self.ok,
        });
        if let (Some(took_ms), Some(object)) = (self.took_ms, value.as_object_mut()) {
            object.insert("took_ms".into(), took_ms.into());
        }
        value
    }

    /// A row read back is held to the same rules as a step kept as it happened, which changes
    /// nothing for a row this build wrote and keeps a secret an earlier one wrote off the screen.
    /// Arguments that are not JSON were cut at the cap after they were kept, and stay as they are.
    pub fn from_value(call_id: String, value: &Value) -> Option<Self> {
        let tool = value.get("tool")?.as_str()?.to_string();
        let stored = value
            .get("arguments")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let arguments = serde_json::from_str::<Value>(stored)
            .map(|arguments| capped(&step_arguments(&tool, &arguments).to_string()))
            .unwrap_or_else(|_| stored.to_string());
        Some(Self {
            call_id,
            tool,
            arguments,
            result: value
                .get("result")
                .and_then(Value::as_str)
                .map(str::to_string),
            ok: value.get("ok").and_then(Value::as_bool),
            took_ms: value.get("took_ms").and_then(Value::as_u64),
        })
    }
}

/// `text` kept to [`STEP_TEXT_CAP`] bytes: a longer one is cut on a character boundary and ends
/// with "…", which counts toward the cap.
pub(crate) fn capped(text: &str) -> String {
    if text.len() <= STEP_TEXT_CAP {
        return text.to_string();
    }
    let mut end = STEP_TEXT_CAP - '…'.len_utf8();
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

/// Adds a delta of a thought to what is kept of it. `seen` is every byte that has arrived for
/// it, kept or not: once it has gone past the cap it was cut there, and a later delta is
/// dropped rather than written after the "…". Kept this way, it is the same however the deltas
/// were split, live or replayed.
fn push_capped(kept: &mut String, seen: &mut usize, delta: &str) {
    let before = *seen;
    *seen += delta.len();
    if before > STEP_TEXT_CAP {
        return;
    }
    kept.push_str(delta);
    if *seen > STEP_TEXT_CAP {
        *kept = capped(kept);
    }
}

/// The step for `call_id`, wherever it is in the turn. Searched from the end, where an open
/// call is.
fn step_mut<'a>(parts: &'a mut [ChatPart], call_id: &str) -> Option<&'a mut StepSpec> {
    parts.iter_mut().rev().find_map(|part| match part {
        ChatPart::Step(step) if step.call_id == call_id => Some(step),
        _ => None,
    })
}

/// When the frames that start and stop a call's clock first reached this app, for a run it
/// follows by asking the server for the run again and again (`AppState::follow_run`) rather
/// than by listening to its stream. Each ask brings back every frame so far; a frame is as new
/// as the first ask that brought it, so a call's time is good to one ask.
///
/// Frames the first ask brings back happened before anyone here was watching, and have no
/// time: a call already under way then gets none (see [`StepSpec::took_ms`]).
#[derive(Debug, Default)]
pub struct FrameArrivals {
    asked: bool,
    first_seen: std::collections::HashMap<String, Option<Instant>>,
}

impl FrameArrivals {
    /// What one ask brought back, `now` being when it came.
    pub fn note(&mut self, events: &[Value], now: Instant) {
        let seen = self.asked.then_some(now);
        for key in events.iter().filter_map(clock_frame_key) {
            self.first_seen.entry(key).or_insert(seen);
        }
        self.asked = true;
    }

    /// When `event` first came, for the frames a call's clock reads.
    pub fn at(&self, event: &Value) -> Option<Instant> {
        clock_frame_key(event).and_then(|key| self.first_seen.get(&key).copied().flatten())
    }
}

/// Boundaries read by the action clocks, keyed by kind and action. The same call's answer can
/// come twice, the gate's word and then the tool's, and the first stops the tool clock.
fn clock_frame_key(event: &Value) -> Option<String> {
    let kind = event.get("type").and_then(Value::as_str)?;
    let id = match kind {
        "TOOL_CALL_START" | "TOOL_CALL_END" | "TOOL_CALL_RESULT" => event.get("toolCallId"),
        "REASONING_MESSAGE_START" | "REASONING_MESSAGE_END" | "RUN_FINISHED" | "RUN_ERROR" => {
            event.get("messageId").or_else(|| event.get("runId"))
        }
        _ => return None,
    }
    .and_then(Value::as_str)?;
    Some(format!("{kind}/{id}"))
}

/// A reply rebuilt from the server's frames keeps the times this app measured for its calls
/// before it was rebuilt. The frames carry no time of their own, so a rebuild (a followed run
/// repainting the turn, a thread coming back to a turn it left running) would otherwise take
/// every "· 1s" off the rows it had.
pub fn keep_call_times(before: &[ChatPart], after: &mut [ChatPart]) {
    let times: std::collections::HashMap<&str, u64> = before
        .iter()
        .filter_map(|part| match part {
            ChatPart::Step(step) => Some((step.call_id.as_str(), step.took_ms?)),
            _ => None,
        })
        .collect();
    let blocked: HashSet<String> = after
        .iter()
        .filter_map(|part| match part {
            ChatPart::Approval(spec) => Some(spec.call_id.clone()),
            ChatPart::UserForm(spec) => Some(spec.call_id.clone()),
            _ => None,
        })
        .collect();
    let thoughts: Vec<&ThoughtSpec> = before
        .iter()
        .filter_map(|part| match part {
            ChatPart::Reasoning(thought) => Some(thought),
            _ => None,
        })
        .collect();
    let mut thought_n = 0;
    for part in after {
        if let ChatPart::Step(step) = part
            && step.took_ms.is_none()
            && !blocked.contains(&step.call_id)
        {
            step.took_ms = times.get(step.call_id.as_str()).copied();
        }
        if let ChatPart::Reasoning(thought) = part {
            if let Some(before) = thoughts.get(thought_n)
                && before.text == thought.text
                && thought.took_ms.is_none()
            {
                thought.took_ms = before.took_ms;
            }
            thought_n += 1;
        }
    }
}

/// A call waiting on a yes is drawn once, as its card. Its step comes back when its result
/// does, and from then on the card is only the line saying how it was answered.
fn hide_steps_behind_cards(parts: &mut Vec<ChatPart>) {
    let asked: HashSet<&str> = parts
        .iter()
        .filter_map(|part| match part {
            ChatPart::Approval(spec) => Some(spec.call_id.as_str()),
            _ => None,
        })
        .collect();
    if asked.is_empty() {
        return;
    }
    let hidden: HashSet<String> = parts
        .iter()
        .filter_map(|part| match part {
            ChatPart::Step(step)
                if step.result.is_none() && asked.contains(step.call_id.as_str()) =>
            {
                Some(step.call_id.clone())
            }
            _ => None,
        })
        .collect();
    parts.retain(|part| !matches!(part, ChatPart::Step(step) if hidden.contains(&step.call_id)));
}

fn is_hitl_card(part: &ChatPart) -> bool {
    matches!(part, ChatPart::UserForm(_) | ChatPart::SaveLogin(_))
}

/// Paint HITL cards in the **settled** document slot from the first frame.
///
/// Live SSE used to append the awaiting form after tool screenshots, then
/// replay/`overlay_server_cards` put it under the intro and above the shot
/// block — the card jumped on Dismiss / Continue / Open the screen. Insert
/// before the first [`ChatPart::Screenshot`] (or at the end when there is
/// none) so the open Form Label already sits where Dismissed ends up.
pub fn place_hitl_cards_in_document_order(parts: &mut Vec<ChatPart>) {
    if parts.len() < 2 {
        return;
    }
    let mut hitl = Vec::new();
    let mut rest = Vec::new();
    for part in parts.drain(..) {
        if is_hitl_card(&part) {
            hitl.push(part);
        } else {
            rest.push(part);
        }
    }
    if hitl.is_empty() {
        *parts = rest;
        return;
    }
    let insert_at = rest
        .iter()
        .position(|part| matches!(part, ChatPart::Screenshot(_)))
        .unwrap_or(rest.len());
    rest.splice(insert_at..insert_at, hitl);
    *parts = rest;
}

/// A screenshot the run produced, decoded once and shared by every row that paints it.
#[derive(Debug, Clone)]
pub struct ScreenshotSpec {
    pub call_id: String,
    /// The tool's own words, e.g. "clicking at 120,40; screenshot of the 1280x800 screen attached".
    pub caption: String,
    pub image: std::sync::Arc<gpui_kit::Image>,
    pub width: u32,
    pub height: u32,
    /// `None` on frames that predate `image.visibility`.
    pub visibility: Option<ImageVisibility>,
}

impl PartialEq for ScreenshotSpec {
    /// One screenshot per call: the bytes need not be compared to know it is the same one.
    fn eq(&self, other: &Self) -> bool {
        self.call_id == other.call_id
            && self.caption == other.caption
            && self.width == other.width
            && self.height == other.height
    }
}

impl ScreenshotSpec {
    /// From a `TOOL_CALL_RESULT` frame's `image`
    /// (`{mime, base64, width, height, visibility?}`), or `None` when it is
    /// not a PNG we can paint. Journalled `agent` frames drop `base64`.
    pub fn from_frame(call_id: &str, caption: &str, image: &Value) -> Option<Self> {
        use base64::Engine as _;
        let mime = image
            .get("mime")
            .and_then(Value::as_str)
            .unwrap_or("image/png");
        if mime != "image/png" {
            return None;
        }
        let encoded = image.get("base64").and_then(Value::as_str)?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .ok()?;
        let width = image.get("width").and_then(Value::as_u64)? as u32;
        let height = image.get("height").and_then(Value::as_u64)? as u32;
        let visibility = image
            .get("visibility")
            .and_then(Value::as_str)
            .and_then(ImageVisibility::parse);
        Some(Self {
            call_id: call_id.to_string(),
            caption: caption.to_string(),
            image: std::sync::Arc::new(gpui_kit::Image::from_bytes(
                gpui_kit::ImageFormat::Png,
                bytes,
            )),
            width,
            height,
            visibility,
        })
    }

    /// Pin into chat now. Tagged `transcript`/`failure`/`end` yes; `agent` no.
    /// Untagged: only a failed tool (`ok == false`), matching the pre-tag heuristic.
    pub fn pin_now(&self, ok: Option<bool>) -> bool {
        pin_shot_now(self.visibility, ok)
    }

    /// Turn-end pin. Tagged `agent` stays off the feed; everything else may
    /// already be pinned (`pin_now`) and this is idempotent by `call_id`.
    pub fn pin_at_turn_end(&self) -> bool {
        pin_shot_at_turn_end(self.visibility)
    }
}

/// The fields `POST /ag-ui/runs/{runId}/answer` needs, plus what the card shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalSpec {
    pub run_id: String,
    /// The thread the run belongs to, when the server said which. An `mcp-…`
    /// thread is the MCP door auditing a call the coworker made somewhere
    /// else, and its cards belong in that coworker's conversation.
    pub thread_id: Option<String>,
    pub call_id: String,
    pub tool: String,
    pub command: String,
    pub why: String,
    pub reason: String,
    /// What the call would do, in the words the server's own approval card uses: "Click at
    /// (120, 40) on the agent's own screen", "Open https://example.com/inbox in the agent's own
    /// browser". Built from the tool and its arguments by [`approval_summary`], the same way the
    /// server builds the `summary` it now sends on the frame and the queue (#263), which older
    /// servers do not send; the conformance ledger holds the two to the same words. Empty for a
    /// shell, whose command is what the card shows, and for a call that came without arguments.
    pub summary: String,
    /// Tool result after the command ran (`exit 0` + stdout/stderr).
    pub output: Option<String>,
    pub ok: Option<bool>,
}

/// The harness tool that runs on the person's own machine, through this
/// app's local-exec daemon. Every other tool runs on the coworker's box.
pub const USER_MACHINE_SHELL: &str = "user_machine_shell";

/// The builtin a bot reads one of its attached skills through: `{"name": …}` in, the skill's
/// `SKILL.md` body out as the call's result, with the skill's files copied onto its box
/// (opengrok-server#270, merged as #290: `opengrok_tools::skill::USE_SKILL`). It is offered
/// exactly when the bot has an attached skill that is switched on and the turn's person may use,
/// and it is no row of the tool ceiling: `GET /coworkers/{id}/tools` lists it while it is offered.
pub const USE_SKILL: &str = "use_skill";

/// The four tools a Bot lists, makes, changes and deletes its person's routines with when they ask
/// in chat (opengrok-server #316, #334, on main 8e7387f: `crates/opengrok-tools/src/routine.rs`),
/// and the fifth, [`RUN_ROUTINE`], which runs one (#337, built in #342). None of them touches a
/// computer, and a delete always asks first, its card's `why` naming the routine as it is stored.
/// The tool ceiling switches all five as one row, `routines`.
pub const LIST_ROUTINES: &str = "list_routines";
pub const CREATE_ROUTINE: &str = "create_routine";
pub const UPDATE_ROUTINE: &str = "update_routine";
pub const DELETE_ROUTINE: &str = "delete_routine";
/// A Bot runs one of its person's routines now, as their Run now does: `{routine}`, its id or its
/// name as `list_routines` gives it, answered with `{runId, threadId}` (opengrok-server #337,
/// built in #342: `RUN_ROUTINE` in `crates/opengrok-tools/src/routine.rs`). It raises no card, so
/// [`approval_summary`] has no arm for it, as the server's `summary_for` has none. The history
/// names the Bot that ran it ([`super::RunBy`]).
pub const RUN_ROUTINE: &str = "run_routine";

/// The routine tools whose answer changes what the person's routines are or have done: a routine
/// made, changed or deleted is a row of the Routines list, and one run is a line of its history.
/// Listing them changes nothing.
pub(crate) fn changes_routines(tool: &str) -> bool {
    matches!(
        tool,
        CREATE_ROUTINE | UPDATE_ROUTINE | DELETE_ROUTINE | RUN_ROUTINE
    )
}

/// Which calls of a run change the person's routines ([`changes_routines`]), from the frame that
/// names each, so the frame that answers one is known for what it is: a `TOOL_CALL_RESULT` names
/// no tool. Fed a run's frames in order, each once.
#[derive(Debug, Default)]
pub struct RoutineChanges {
    calls: HashSet<String>,
}

impl RoutineChanges {
    /// Whether `frame` is the server's answer to a call that changed the person's routines. Not
    /// the answer of a call that was refused or that waits on a card (`ok: false`), which changed
    /// nothing: a delete always asks first, and its call is answered `waiting for approval` before
    /// the answer that follows a yes (opengrok-tools `ToolResult::awaiting`). An answer that does
    /// not say is taken as one that did.
    pub fn answered(&mut self, frame: &Value) -> bool {
        let Some(call) = frame.get("toolCallId").and_then(Value::as_str) else {
            return false;
        };
        if frame
            .get("toolCallName")
            .and_then(Value::as_str)
            .is_some_and(changes_routines)
        {
            self.calls.insert(call.to_string());
        }
        frame.get("type").and_then(Value::as_str) == Some("TOOL_CALL_RESULT")
            && self.calls.contains(call)
            && frame.get("ok").and_then(Value::as_bool) != Some(false)
    }
}

/// The CUSTOM `name` of a run parked on a card: a tool waiting on a yes, or a form waiting on the
/// person (opengrok-harness `projection.rs` `awaiting_approval`).
pub(crate) const RUN_AWAITING_APPROVAL: &str = "run-awaiting-approval";

/// The tunnel's card named in a word rather than by its sentence. OpenGrok raises that card with
/// `reason: auto-review` and [`EGRESS_TUNNEL_ASK_REASON`] as its `why`, so this word is read only
/// in case a server says it.
pub(crate) const EGRESS_REASON: &str = "egress";

/// The `reason`s that put Review-an-action chrome on a card. The conformance ledger reads this
/// list, so a word added here is checked against the reasons the server sends.
pub(crate) const REVIEW_AN_ACTION_REASONS: &[&str] = &[
    "auto-review",
    "review-an-action",
    "computer-action",
    EGRESS_REASON,
];

/// The sentence OpenGrok puts on the egress tunnel's Review-an-action card
/// (`opengrok_tools::review::EGRESS_TUNNEL_ASK_REASON`), and which its
/// approvals queue carries for a card rebuilt after a relaunch. Matched whole.
pub const EGRESS_TUNNEL_ASK_REASON: &str =
    "This action would use your network through the egress tunnel. Review it before it runs.";

/// The person's answer on a permission card.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocalExecResolution {
    Always,
    AllowOnce,
    Never,
    DenyOnce,
}

impl ApprovalSpec {
    pub fn runs_on_this_mac(&self) -> bool {
        self.tool == USER_MACHINE_SHELL
    }

    /// The card came off the MCP door rather than out of a turn of the chat.
    pub fn is_mcp(&self) -> bool {
        self.thread_id.as_deref().is_some_and(is_mcp_thread)
    }

    /// The conversation this card belongs in, when the server said which
    /// thread raised it.
    pub fn conversation_id(&self) -> Option<&str> {
        self.thread_id.as_deref().map(conversation_for_thread)
    }

    /// Where the command runs, the way the card and its outcome line say it.
    pub fn place(&self) -> &'static str {
        if self.runs_on_this_mac() {
            "your computer"
        } else {
            "its computer"
        }
    }

    /// Grok Bot Steps 3–4: tunnel / auto-review HITL. Exec-consent stays
    /// Allow/Deny once. OpenGrok stamps this reason only when
    /// `isEgressTunnelAvailable` (env `OG_*`/`SAND_*_EGRESS_TUNNEL_ENABLED=1`
    /// or host `egressTunnelEnabled`). We do not invent it.
    ///
    /// Never for an MCP card. The door reuses the same words for why it
    /// stopped a call — `auto-review` among them — and Review chrome would
    /// put an Always allow on a card that has no standing policy behind it:
    /// there is nothing on this Mac for Always to write to.
    pub fn is_review_an_action(&self) -> bool {
        !self.is_mcp()
            && REVIEW_AN_ACTION_REASONS.contains(&self.reason.trim().to_ascii_lowercase().as_str())
    }

    /// The Review-an-action card the egress tunnel raises: the server's own sentence for it,
    /// whole — a judge's card whose instructions merely mention the tunnel is not this card.
    /// Always and Never on THIS card set the computer's standing policy; on a judge's card
    /// they answer the one call. Never a local-shell card, whose Always/Never keep a rule for
    /// its command on this Mac.
    pub fn is_egress_tunnel(&self) -> bool {
        self.is_review_an_action()
            && !self.runs_on_this_mac()
            && (self.reason.trim().eq_ignore_ascii_case(EGRESS_REASON)
                || self.why.trim() == EGRESS_TUNNEL_ASK_REASON)
    }

    /// The standing choice an answer to the tunnel's card writes for its computer, as
    /// `PUT /coworkers/{id}/computer/egress-policy`: Always is `bypass`, Never is `never`. A
    /// once answers only this call, and no other card has the computer's choice behind it.
    pub fn egress_standing(&self, resolution: LocalExecResolution) -> Option<LocalExecMode> {
        if !self.is_egress_tunnel() {
            return None;
        }
        match resolution {
            LocalExecResolution::Always => Some(LocalExecMode::Always),
            LocalExecResolution::Never => Some(LocalExecMode::Never),
            LocalExecResolution::AllowOnce | LocalExecResolution::DenyOnce => None,
        }
    }

    /// The centered line this card leaves behind once it is answered, in the
    /// words its own kind of card uses.
    pub fn outcome(&self, bot: &str, resolution: LocalExecResolution) -> String {
        if self.is_mcp() {
            mcp_call_outcome(bot, resolution, &self.tool)
        } else if self.is_egress_tunnel() {
            egress_tunnel_outcome(bot, resolution)
        } else if self.runs_on_this_mac() {
            local_shell_outcome(bot, resolution)
        } else {
            local_exec_outcome(bot, resolution, self.place())
        }
    }
}

/// The line the tunnel's card leaves behind. Always and Never are the computer's standing
/// choice, so they read as one; the commands wording belongs to the local shell and was a lie
/// here ("can run commands on its computer" after an Always that wrote nothing, 21 Sep 2026).
pub fn egress_tunnel_outcome(bot: &str, resolution: LocalExecResolution) -> String {
    match resolution {
        LocalExecResolution::Always => {
            format!("{bot} may use your network from its computer.")
        }
        LocalExecResolution::Never => {
            format!("{bot} may not use your network from its computer.")
        }
        LocalExecResolution::AllowOnce => {
            format!("{bot} may use your network this time.")
        }
        LocalExecResolution::DenyOnce => {
            format!("{bot} was not allowed to use your network this time.")
        }
    }
}

/// What this Mac's Always/Never setting answers on its own. Only the
/// local-shell tool is covered; a box tool always gets its card.
pub fn policy_answer(
    spec: &ApprovalSpec,
    mode: Option<LocalExecMode>,
) -> Option<LocalExecResolution> {
    if !spec.runs_on_this_mac() {
        return None;
    }
    match mode? {
        LocalExecMode::Always => Some(LocalExecResolution::Always),
        LocalExecMode::Never => Some(LocalExecResolution::Never),
        LocalExecMode::Ask => None,
    }
}

impl ChatPart {
    pub fn is_widget(&self) -> bool {
        !matches!(self, Self::Text(_))
    }
}

/// At most one open permission card. Older unanswered host-shell runs stay
/// off this bubble so a turn does not look like it needs two yeses.
pub fn collapse_open_approvals(
    parts: &[ChatPart],
    open_call_ids: &HashSet<String>,
) -> Vec<ChatPart> {
    let keep = parts.iter().rev().find_map(|part| match part {
        ChatPart::Approval(spec) if open_call_ids.contains(&spec.call_id) => {
            Some(spec.call_id.clone())
        }
        _ => None,
    });
    let mut kept = false;
    parts
        .iter()
        .filter(|part| match part {
            ChatPart::Approval(spec) if open_call_ids.contains(&spec.call_id) => {
                if keep.as_ref() == Some(&spec.call_id) && !kept {
                    kept = true;
                    true
                } else {
                    false
                }
            }
            _ => true,
        })
        .cloned()
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
pub enum UiSpec {
    BarChart(BarChartSpec),
    Form(FormSpec),
}

#[derive(Debug, Clone, PartialEq)]
pub struct BarChartSpec {
    pub title: Option<String>,
    pub bars: Vec<BarItem>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BarItem {
    pub label: String,
    pub value: f32,
}

/// Generative choice-chip form. Answers go through `send_message` as chat text.
///
/// This is **not** user-form credentials. Password / otp / `secret` fields must
/// never be routed here — those are [`UserFormSpec`].
#[derive(Debug, Clone, PartialEq)]
pub struct FormSpec {
    pub title: Option<String>,
    pub prompt: Option<String>,
    pub fields: Vec<FormField>,
    pub submit: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FormField {
    pub id: String,
    pub label: String,
    pub options: Vec<String>,
}

/// Where a choice card stands. Nothing about it is kept: it is read off the thread, so it
/// survives a restart and a replay, and a card answered from another Mac reads as answered.
#[derive(Debug, Clone, PartialEq)]
pub enum ChoiceCard {
    /// Still asking, and the person has said nothing since.
    Open,
    /// The person's next message is this card's answer: what they picked, by field id.
    Answered(std::collections::HashMap<String, String>),
    /// The person wrote something else after it. The bot has moved on with them, so the card
    /// no longer takes an answer: one sent now would answer a question nobody is asking.
    MovedOn,
    /// Put away with its ✕ in this session. Nothing is sent: the server acknowledged the form
    /// when it was drawn and the run did not wait on it, so there is nothing to tell it.
    Dismissed,
}

/// The letter a choice's keycap wears and the key that picks it: A for the first.
pub fn choice_letter(index: usize) -> Option<char> {
    u8::try_from(index)
        .ok()
        .filter(|at| *at < 26)
        .map(|at| char::from(b'A' + at))
}

/// Which choice a key picks: `a` or `A` is the first. Anything else picks nothing.
pub fn choice_index(key: &str) -> Option<usize> {
    let mut chars = key.chars();
    let (Some(ch), None) = (chars.next(), chars.next()) else {
        return None;
    };
    ch.is_ascii_alphabetic()
        .then(|| usize::from(ch.to_ascii_uppercase() as u8 - b'A'))
}

impl FormSpec {
    /// A one-question card answers the moment a choice is picked, the way Grok Bot's does;
    /// a card with several questions keeps its button, since one pick is not the whole answer.
    pub fn answers_on_pick(&self) -> bool {
        matches!(self.fields.as_slice(), [field] if !field.options.is_empty())
    }

    /// The words an answer is sent as: the card's title, then one `Label: choice` line per
    /// question answered. This is what the model has always been sent for a form.
    pub fn answer_text(&self, picks: &std::collections::HashMap<String, String>) -> String {
        let mut lines = Vec::new();
        if let Some(title) = &self.title {
            lines.push(title.clone());
        }
        for field in &self.fields {
            if let Some(value) = picks.get(&field.id) {
                lines.push(format!("{}: {value}", field.label));
            }
        }
        lines.join("\n")
    }

    /// The picks a message holds when it is this card's answer, read back from
    /// [`Self::answer_text`]'s words. Every line has to be the title or one of the card's own
    /// choices, so a person's own sentence after the card is never taken for an answer.
    pub fn answer_in(&self, text: &str) -> Option<std::collections::HashMap<String, String>> {
        let lines = text.lines().map(str::trim).filter(|line| !line.is_empty());
        let mut picks = std::collections::HashMap::new();
        let mut first = true;
        for line in lines {
            if first && self.title.as_deref().map(str::trim) == Some(line) {
                first = false;
                continue;
            }
            first = false;
            let (id, value) = self.fields.iter().find_map(|field| {
                let value = line.strip_prefix(&format!("{}:", field.label))?.trim();
                field
                    .options
                    .iter()
                    .find(|option| option.trim() == value)
                    .map(|option| (field.id.clone(), option.clone()))
            })?;
            if picks.insert(id, value).is_some() {
                return None;
            }
        }
        (!picks.is_empty()).then_some(picks)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletedUiTool {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Default)]
pub struct TurnAssembler {
    committed: Vec<ChatPart>,
    /// The person's own words in a replay, kept out of the coworker's text.
    persons: PersonsText,
    text: String,
    tool: Option<OpenTool>,
    waiting_approval: bool,
    completed_ui: Vec<CompletedUiTool>,
    shell_args: std::collections::HashMap<String, String>,
    /// `request_user_form` args by call id, so an awaiting CUSTOM with empty
    /// `arguments` can still paint the schema.
    form_args: std::collections::HashMap<String, String>,
    /// Newest tool PNG. Computer pane / last-screen thumb; chat only on pin.
    latest_shot: Option<ScreenshotSpec>,
    /// The argument text of each step whose arguments are still arriving, by call id. The step
    /// holds none of it: when the call's arguments end, the step keeps what [`step_arguments`]
    /// lets it say of them, and the text here goes.
    step_args: std::collections::HashMap<String, String>,
    /// Thoughts still being said, in the order they began. Each becomes a part when its message
    /// ends, when a call starts while it is being said, or when the run ends.
    reasoning: Vec<OpenThought>,
    /// Which door the run's model calls go through, from its `opengrok.inferenceSource` CUSTOM
    /// ([`ReplySource`]). It is not a part: it paints nothing in the reply, and is the reply's
    /// badge.
    source: Option<ReplySource>,
    /// Calls whose arguments are all in and whose answer has not come, by call id: the clock
    /// each call's row reads its time from ([`StepSpec::took_ms`]).
    clocks: std::collections::HashMap<String, CallClock>,
    /// The newest `opengrok.officeDoc` frame per document, by doc id: what the document window
    /// follows across the turn — the committed part carries the card, this carries the truth.
    office_docs: std::collections::BTreeMap<String, OfficeDocSpec>,
    /// The document the newest frame touched: the tab the window paints live.
    office_latest: Option<String>,
}

/// A call waiting for its answer.
#[derive(Debug)]
struct CallClock {
    /// When its `TOOL_CALL_END` reached this app. `None` when it came before the app was
    /// watching: in a replay, or in the part of a followed run that had already happened.
    since: Option<Instant>,
    /// Another call was waiting for its answer at the same time. The harness runs a round's
    /// calls one after another and sends all their results together once the last is done
    /// (opengrok-harness `lib.rs`, the loop over `results` after `run_all_timed`), so either
    /// call's wait would be the whole round's, and which part of it was its own cannot be told.
    shared: bool,
}

/// A thought still being said: its message id, and as much of it as is kept (see
/// `push_capped`).
#[derive(Debug, Default)]
struct OpenThought {
    id: String,
    said: String,
    seen: usize,
    since: Option<Instant>,
}

#[derive(Debug)]
struct OpenTool {
    id: String,
    name: String,
    args: String,
}

/// Which text messages are the person's own rather than the coworker's.
///
/// A replay (`GET /ag-ui/runs/{id}`, `GET /ag-ui/threads/{id}`) opens each run with what the
/// person sent that turn, as `TEXT_MESSAGE_*` frames with `role: "user"` under the client's own
/// message id (opengrok-server `agui/history.rs` `with_prompt_frames`, since 5814af1). Only the
/// opening frame names the role; the rest of that message is known by its id.
#[derive(Debug, Default, Clone)]
pub(crate) struct PersonsText {
    ids: std::collections::HashSet<String>,
}

impl PersonsText {
    /// Whether this text frame is the person's. A frame that says `role: "user"` is, and its
    /// message id is remembered, so the frames that carry that message's words after it are too.
    pub(crate) fn is_persons(&mut self, event: &Value) -> bool {
        let id = event.get("messageId").and_then(Value::as_str).unwrap_or("");
        if event.get("role").and_then(Value::as_str) == Some("user") {
            if !id.is_empty() {
                self.ids.insert(id.to_string());
            }
            return true;
        }
        !id.is_empty() && self.ids.contains(id)
    }
}

/// The person's own messages in a run's replay, in the order they were said, as their message
/// id and their words. The id is the one this app sent them under, so a thread that already
/// holds a message knows it by that id.
pub fn persons_messages(events: &[Value]) -> Vec<(String, String)> {
    let mut persons = PersonsText::default();
    let mut said: Vec<(String, String)> = Vec::new();
    // Messages the replay opened and closed. A message of files alone replays as a START and an
    // END with no words between (opengrok-server#259), and it is still the person's message:
    // its files are drawn under it.
    let mut closed: HashSet<String> = HashSet::new();
    for event in events {
        let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
        if !kind.starts_with("TEXT_MESSAGE") || !persons.is_persons(event) {
            continue;
        }
        let Some(id) = event
            .get("messageId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        let at = match said.iter().position(|(known, _)| known == id) {
            Some(at) => at,
            None => {
                said.push((id.to_string(), String::new()));
                said.len() - 1
            }
        };
        if matches!(kind, "TEXT_MESSAGE_CONTENT" | "TEXT_MESSAGE_CHUNK")
            && let Some(delta) = event.get("delta").and_then(Value::as_str)
        {
            said[at].1.push_str(delta);
        }
        if kind == "TEXT_MESSAGE_END" {
            closed.insert(id.to_string());
        }
    }
    said.retain(|(id, words)| !words.trim().is_empty() || closed.contains(id));
    said
}

impl TurnAssembler {
    /// A frame as it reached this app, `at` being when it did, or `None` for a frame that came
    /// before the app was watching. The live stream and a followed run come in this way, so each
    /// call's row can say how long its answer took ([`StepSpec::took_ms`]). A replay comes in
    /// through [`Self::push_event`] and times nothing.
    pub fn push_event_at(&mut self, event: &Value, at: Option<Instant>) {
        self.push_frame(event, at);
        self.time_call(event, at);
    }

    pub fn push_event(&mut self, event: &Value) {
        self.push_frame(event, None);
    }

    fn push_frame(&mut self, event: &Value, arrived_at: Option<Instant>) {
        let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "TEXT_MESSAGE_START" => {
                self.persons.is_persons(event);
            }
            "TEXT_MESSAGE_CONTENT" | "TEXT_MESSAGE_CHUNK" => {
                if self.persons.is_persons(event) {
                    return;
                }
                if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                    self.text.push_str(delta);
                    if self.tool.is_none() {
                        self.flush_text();
                    }
                }
            }
            "TOOL_CALL_START" | "TOOL_CALL_CHUNK" => {
                let name = event
                    .get("toolCallName")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let id = event
                    .get("toolCallId")
                    .or_else(|| event.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if name == USER_MACHINE_SHELL && !id.is_empty() {
                    self.shell_args.entry(id.clone()).or_default();
                }
                // The model reached for a tool: what it thought up to here came before the
                // call, and what it goes on to think comes after.
                if !name.is_empty() {
                    self.settle_thoughts(arrived_at);
                }
                if kind == "TOOL_CALL_CHUNK" {
                    if let Some(delta) = event.get("delta").and_then(Value::as_str)
                        && let Some(buf) = self.shell_args.get_mut(&id)
                    {
                        buf.push_str(delta);
                    }
                    if let Some(args) = event.get("arguments") {
                        let command = command_from_args(args);
                        if !command.is_empty() && !id.is_empty() {
                            self.shell_args.insert(id.clone(), args.to_string());
                        }
                    }
                }
                if is_ui_tool(name) || is_user_form_tool(name) {
                    self.flush_text();
                    if is_user_form_tool(name) && !id.is_empty() {
                        self.form_args.entry(id.clone()).or_default();
                    }
                    self.tool = Some(OpenTool {
                        id,
                        name: name.to_string(),
                        args: String::new(),
                    });
                } else {
                    // Every other call is a step. A chunk that goes on with a call names no
                    // tool, and adds to the step its first chunk opened.
                    if !name.is_empty() && !id.is_empty() {
                        self.open_step(&id, name);
                    }
                    if kind == "TOOL_CALL_CHUNK"
                        && let Some(delta) = event.get("delta").and_then(Value::as_str)
                    {
                        self.push_step_arguments(&id, delta);
                    }
                }
            }
            "TOOL_CALL_ARGS" => {
                let id = event
                    .get("toolCallId")
                    .or_else(|| event.get("id"))
                    .and_then(Value::as_str);
                if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                    if let Some(id) = id {
                        self.shell_args
                            .entry(id.to_string())
                            .or_default()
                            .push_str(delta);
                        if let Some(buf) = self.form_args.get_mut(id) {
                            buf.push_str(delta);
                        }
                        self.push_step_arguments(id, delta);
                    }
                    if let Some(tool) = self.tool.as_mut() {
                        tool.args.push_str(delta);
                    }
                }
            }
            "TOOL_CALL_END" => {
                self.flush_text();
                if let Some(id) = event.get("toolCallId").and_then(Value::as_str) {
                    self.settle_step_arguments(id);
                }
                if let Some(tool) = self.tool.take() {
                    self.close_tool(tool);
                }
            }
            "CUSTOM" => {
                let name = event.get("name").and_then(Value::as_str).unwrap_or("");
                // Which door the run went through. Live it comes right after RUN_STARTED; a
                // replay opens the run with the person's own messages first and the frame after
                // them, so where it sits is not the rule: the run's first such frame is. The
                // server sends one a run and none on a carry-on (`local_proxy::route` in
                // opengrok-server). Read before anything else can take it for a card or a
                // widget, and never drawn in the reply: it is the reply's badge.
                if name == INFERENCE_SOURCE_CUSTOM {
                    if self.source.is_none() {
                        self.source = ReplySource::from_event(event);
                    }
                    return;
                }
                if let Some(spec) = PluginNeedsSpec::from_event(event) {
                    self.flush_text();
                    self.committed.push(ChatPart::PluginNeeds(spec));
                    return;
                }
                if is_user_form_awaiting(event) {
                    self.flush_text();
                    let call_id = event
                        .get("callId")
                        .or_else(|| event.get("toolCallId"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let fallback = self
                        .form_args
                        .get(call_id)
                        .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
                    if let Some(spec) = UserFormSpec::from_awaiting_event(event, fallback.as_ref())
                    {
                        self.push_user_form(spec);
                    }
                } else if name == RUN_AWAITING_APPROVAL {
                    self.flush_text();
                    if let Some(mut spec) = approval_from_event(event) {
                        if spec.command.is_empty()
                            && let Some(raw) = self.shell_args.get(&spec.call_id)
                        {
                            if let Ok(value) = serde_json::from_str::<Value>(raw) {
                                spec.command = command_from_args(&value);
                            } else if !raw.trim().is_empty() {
                                spec.command = raw.clone();
                            }
                        }
                        self.committed.retain(|part| {
                            !matches!(part, ChatPart::Approval(existing) if existing.call_id == spec.call_id)
                        });
                        self.committed.push(ChatPart::Approval(spec));
                        self.waiting_approval = true;
                    }
                } else if let Some(spec) = SaveLoginSpec::from_event(event) {
                    self.flush_text();
                    self.push_save_login(spec);
                } else if let Some(spec) = UserFormSpec::from_custom_event(event) {
                    self.flush_text();
                    self.push_user_form(spec);
                } else if let Some(handoff) = ComputerHandoffSpec::from_event(event) {
                    self.flush_text();
                    self.push_user_form(handoff.as_escalated_form());
                } else if let Some(spec) =
                    OfficeDocSpec::from_custom(name, event.get("value").unwrap_or(&Value::Null))
                {
                    self.flush_text();
                    // One card per document, kept where the document first appeared in the
                    // reply and rewritten by each frame: ten edits in a turn are ten versions
                    // of one card, not ten cards.
                    match self.committed.iter_mut().find(|part| {
                        matches!(part, ChatPart::OfficeDoc(existing) if existing.doc_id == spec.doc_id)
                    }) {
                        Some(part) => *part = ChatPart::OfficeDoc(spec.clone()),
                        None => self.committed.push(ChatPart::OfficeDoc(spec.clone())),
                    }
                    self.office_latest = Some(spec.doc_id.clone());
                    self.office_docs.insert(spec.doc_id.clone(), spec);
                } else {
                    let value = event.get("value").cloned().unwrap_or(Value::Null);
                    if let Some(spec) = UiSpec::from_custom(name, &value) {
                        self.flush_text();
                        self.committed.push(ChatPart::Ui(spec));
                    }
                }
            }
            "TOOL_CALL_RESULT" => {
                self.waiting_approval = false;
                self.flush_text();
                self.attach_tool_result(event);
            }
            "REASONING_MESSAGE_START" => {
                self.flush_text();
                let id = message_id(event);
                if !self.reasoning.iter().any(|thought| thought.id == id) {
                    self.reasoning.push(OpenThought {
                        id,
                        since: arrived_at,
                        ..OpenThought::default()
                    });
                }
            }
            "REASONING_MESSAGE_CONTENT" => {
                if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                    let id = message_id(event);
                    if !self.reasoning.iter().any(|thought| thought.id == id) {
                        // Its opening never came: the words still belong to a thought.
                        self.flush_text();
                        self.reasoning.push(OpenThought {
                            id: id.clone(),
                            ..OpenThought::default()
                        });
                    }
                    if let Some(thought) =
                        self.reasoning.iter_mut().find(|thought| thought.id == id)
                    {
                        push_capped(&mut thought.said, &mut thought.seen, delta);
                    }
                }
            }
            "REASONING_MESSAGE_END" => {
                let id = message_id(event);
                if let Some(at) = self.reasoning.iter().position(|thought| thought.id == id) {
                    let thought = self.reasoning.remove(at);
                    self.push_reasoning(&thought.said, observed_ms(thought.since, arrived_at));
                }
            }
            "RUN_FINISHED" | "RUN_ERROR" => {
                self.waiting_approval = false;
                self.close_reasoning(arrived_at);
            }
            _ => {}
        }
    }

    pub fn snapshot(&self) -> (String, Vec<ChatPart>) {
        let mut parts = self.committed.clone();
        if !self.holding_ui() && !self.text.is_empty() {
            parts.push(ChatPart::Text(self.text.clone()));
        }
        hide_steps_behind_cards(&mut parts);
        place_hitl_cards_in_document_order(&mut parts);
        let plain = plain_text(&parts);
        (plain, parts)
    }

    /// Starts and stops the clocks of the calls a frame is about. A call's clock starts when its
    /// arguments are all in, which is when the harness can run it, and stops at its answer; the
    /// model's time writing those arguments is the model's, not the call's.
    fn time_call(&mut self, event: &Value, at: Option<Instant>) {
        let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
        let call_id = |key: &str| event.get(key).and_then(Value::as_str).unwrap_or("");
        match kind {
            "TOOL_CALL_END" => {
                let id = call_id("toolCallId");
                if id.is_empty() {
                    return;
                }
                let shared = !self.clocks.is_empty();
                for clock in self.clocks.values_mut() {
                    clock.shared = true;
                }
                self.clocks
                    .insert(id.to_string(), CallClock { since: at, shared });
            }
            "TOOL_CALL_RESULT" => {
                let id = call_id("toolCallId");
                let Some(clock) = self.clocks.remove(id) else {
                    return;
                };
                // Strictly later: an answer that came in the same delivery as its call's end, as
                // two frames of one poll of a followed run do, says only that it took less than
                // a poll, and "0ms" would be a guess.
                if clock.shared {
                    return;
                }
                if let Some(step) = step_mut(&mut self.committed, id) {
                    step.took_ms = observed_ms(clock.since, at);
                }
            }
            "CUSTOM"
                if event.get("name").and_then(Value::as_str) == Some(RUN_AWAITING_APPROVAL)
                    || is_user_form_awaiting(event) =>
            {
                // The call is waiting on a person. What came back for it just before this was
                // the gate's word ("waiting for approval: …"), not the tool's answer, and the
                // answer that comes once the person has decided will have waited on them too.
                let id = match call_id("callId") {
                    "" => call_id("toolCallId"),
                    id => id,
                };
                self.clocks.remove(id);
                if let Some(step) = step_mut(&mut self.committed, id) {
                    step.took_ms = None;
                }
            }
            // A call still waiting when its run ends or parks is not coming back on this clock.
            "RUN_FINISHED" | "RUN_ERROR" => self.clocks.clear(),
            _ => {}
        }
    }

    /// A call that is not a chart, a form or a user-form becomes a step where it starts, so it
    /// sits between the words before it and the words after.
    fn open_step(&mut self, call_id: &str, tool: &str) {
        if step_mut(&mut self.committed, call_id).is_some() {
            return;
        }
        self.flush_text();
        self.committed.push(ChatPart::Step(StepSpec {
            call_id: call_id.to_string(),
            tool: tool.to_string(),
            arguments: String::new(),
            result: None,
            ok: None,
            took_ms: None,
        }));
        self.step_args.insert(call_id.to_string(), String::new());
    }

    /// Several calls can be open at once, so each delta finds its own call's text by id.
    fn push_step_arguments(&mut self, call_id: &str, delta: &str) {
        if let Some(raw) = self.step_args.get_mut(call_id) {
            raw.push_str(delta);
        }
    }

    /// A call's arguments are all in (its `TOOL_CALL_END`, or its result if that came first):
    /// the step keeps what the card's rules let it say of them, and the text they came as goes.
    fn settle_step_arguments(&mut self, call_id: &str) {
        let Some(raw) = self.step_args.remove(call_id) else {
            return;
        };
        if let Some(step) = step_mut(&mut self.committed, call_id) {
            step.arguments = kept_arguments(&step.tool, &raw);
        }
    }

    /// A thought that has ended joins the thought just before it, if that is where it ends up:
    /// two blocks back to back are one thing the coworker thought, and one row. Kept to the cap
    /// either way.
    fn push_reasoning(&mut self, said: &str, took_ms: Option<u64>) {
        let said = said.trim();
        if said.is_empty() {
            return;
        }
        if let Some(ChatPart::Reasoning(before)) = self.committed.last_mut() {
            before.text = capped(&format!("{}\n\n{said}", before.text));
            before.took_ms = before
                .took_ms
                .zip(took_ms)
                .map(|(a, b)| a.saturating_add(b));
            return;
        }
        self.committed.push(ChatPart::Reasoning(ThoughtSpec {
            text: capped(said),
            took_ms,
        }));
    }

    /// Whatever the coworker is in the middle of thinking goes into the reply as far as it has
    /// got, where it has got to. A thought still being said stays open, and what it goes on to
    /// say is kept as a thought of its own.
    fn settle_thoughts(&mut self, at: Option<Instant>) {
        let settled: Vec<(String, Option<u64>)> = self
            .reasoning
            .iter_mut()
            .map(|thought| {
                thought.seen = 0;
                (
                    std::mem::take(&mut thought.said),
                    observed_ms(thought.since.take(), at),
                )
            })
            .collect();
        for (said, took_ms) in settled {
            self.push_reasoning(&said, took_ms);
        }
    }

    /// The run is over: a thought it was still in the middle of is kept as far as it got.
    fn close_reasoning(&mut self, at: Option<Instant>) {
        for thought in std::mem::take(&mut self.reasoning) {
            self.push_reasoning(&thought.said, observed_ms(thought.since, at));
        }
    }

    pub fn waiting_approval(&self) -> bool {
        self.waiting_approval
    }

    /// Which door the run's reply came through, once its `opengrok.inferenceSource` CUSTOM has
    /// arrived. A server from before reply sources sends none, and a reply of its has no badge.
    pub fn reply_source(&self) -> Option<&ReplySource> {
        self.source.as_ref()
    }

    /// An unresolved user-form card or live Computer sibling is on the turn.
    /// Distinct from a permission card. Local Skip/Dismiss that already
    /// settled the grafted card is the AppState map's job, not this flag.
    pub fn waiting_user_form(&self) -> bool {
        self.committed.iter().any(|part| {
            matches!(part, ChatPart::UserForm(spec) if spec.is_unresolved() || spec.live_computer_handoff())
        })
    }

    fn attach_tool_result(&mut self, event: &Value) {
        let call_id = event
            .get("toolCallId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if call_id.is_empty() {
            return;
        }
        let content = event
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let ok = event.get("ok").and_then(Value::as_bool);
        if let Some(ChatPart::Approval(spec)) = self.committed.iter_mut().find(
            |part| matches!(part, ChatPart::Approval(existing) if existing.call_id == call_id),
        ) {
            spec.output = Some(content.clone());
            spec.ok = ok;
        }
        self.settle_step_arguments(&call_id);
        let mut tool = String::new();
        if let Some(step) = step_mut(&mut self.committed, &call_id) {
            step.result = Some(capped(&content));
            step.ok = ok;
            tool = step.tool.clone();
        }
        // The Bot asked for an account (`add_plugin_account`, #359): the person is shown the same
        // card a tag that needed one shows, which opens Plugins, where the key or the sign-in
        // goes. The result carries the plugin and the service and nothing else
        // (opengrok-server `plugin_desk.rs`, `Ask::AddAccount`, gol/service-accounts).
        if tool == ADD_PLUGIN_ACCOUNT
            && ok != Some(false)
            && let Ok(answer) = serde_json::from_str::<Value>(&content)
            && answer["card"] == "shown"
            && let Some(plugin) = answer["plugin"].as_str()
        {
            let need = PluginNeed {
                plugin: plugin.to_string(),
                connector: answer["connector"].as_str().map(str::to_string),
                kind: PluginNeedKind::Account,
            };
            let card = PluginNeedsSpec {
                needs: vec![need],
                send_again: false,
            };
            self.committed.push(ChatPart::PluginNeeds(card));
        }
        // Keep every PNG with bytes for the Computer pane / last-screen thumb.
        // Chat row follows `image.visibility` (opengrok-server#139). Untagged
        // frames keep the old heuristic: failure now, last shot at turn-end.
        if let Some(shot) = event
            .get("image")
            .and_then(|image| ScreenshotSpec::from_frame(&call_id, &content, image))
        {
            let pin_now = shot.pin_now(ok);
            self.latest_shot = Some(shot.clone());
            if pin_now {
                self.pin_shot(shot);
            } else {
                self.break_feed_paragraph();
            }
        }
    }

    fn pin_shot(&mut self, shot: ScreenshotSpec) {
        self.committed.retain(|part| {
            !matches!(part, ChatPart::Screenshot(existing) if existing.call_id == shot.call_id)
        });
        self.committed.push(ChatPart::Screenshot(shot));
    }

    fn pin_latest_shot(&mut self) {
        let Some(shot) = self.latest_shot.clone() else {
            return;
        };
        if !shot.pin_at_turn_end() {
            return;
        }
        if self.committed.iter().any(|part| {
            matches!(part, ChatPart::Screenshot(existing) if existing.call_id == shot.call_id)
        }) {
            return;
        }
        self.committed.push(ChatPart::Screenshot(shot));
    }

    /// A tool PNG that stays off the feed still splits the words around it.
    fn break_feed_paragraph(&mut self) {
        let Some(ChatPart::Text(text)) = self.committed.last_mut() else {
            return;
        };
        if text.trim().is_empty() || text.ends_with("\n\n") {
            return;
        }
        text.truncate(text.trim_end().len());
        text.push_str("\n\n");
    }

    /// Stream ended. Mount a UI tool if its args already parse; otherwise release held text.
    /// Pins the last computer PNG when `image.visibility` is not `agent` (turn-end
    /// `end` / untagged heuristic). Tagged `agent` stays Computer-pane only.
    pub fn finish(&mut self) {
        self.close_reasoning(None);
        // A call whose end never came keeps what of its arguments did.
        let unsettled: Vec<String> = self.step_args.keys().cloned().collect();
        for call_id in unsettled {
            self.settle_step_arguments(&call_id);
        }
        // Nothing more is coming, so nothing is held back: an object that never closed is words.
        drain_complete_ui(&mut self.text, &mut self.committed, Held::Release);
        if let Some(tool) = self.tool.take() {
            self.close_tool(tool);
        }
        self.pin_latest_shot();
    }

    /// Newest tool PNG, including steps that did not earn a chat row.
    pub fn latest_screenshot(&self) -> Option<&ScreenshotSpec> {
        self.latest_shot.as_ref()
    }

    /// The documents this turn's `opengrok.officeDoc` frames have named so far, by doc id —
    /// the set the document window's tab strip shows, and which of them is newest says which
    /// tab is live.
    pub fn office_docs(&self) -> &std::collections::BTreeMap<String, OfficeDocSpec> {
        &self.office_docs
    }

    /// The doc id the newest `opengrok.officeDoc` frame touched.
    pub fn office_latest(&self) -> Option<&str> {
        self.office_latest.as_deref()
    }

    fn close_tool(&mut self, tool: OpenTool) {
        let Ok(value) = serde_json::from_str::<Value>(&tool.args) else {
            return;
        };
        if is_user_form_tool(&tool.name) {
            self.form_args.insert(tool.id.clone(), tool.args.clone());
            if let Some(spec) = UserFormSpec::from_tool_args(&value, &tool.id) {
                self.push_user_form(spec);
            }
            return;
        }
        if let Some(spec) = UiSpec::from_tool(&tool.name, &value) {
            self.push_ui(spec, tool.id, tool.name);
        }
    }

    fn push_user_form(&mut self, spec: UserFormSpec) {
        if let Some(existing) = self.committed.iter_mut().find_map(|part| match part {
            ChatPart::UserForm(existing) if existing.same_card(&spec) => Some(existing),
            _ => None,
        }) {
            existing.merge(spec);
            place_hitl_cards_in_document_order(&mut self.committed);
            return;
        }
        // Awaiting CUSTOM has callId; a later send-message envelope has the
        // gateway id and no callId — fold those. A second OTP form after a
        // password Submitted is a different entry / call: push a new card.
        let mut unresolved_ix = None;
        let mut unresolved_count = 0usize;
        for (i, part) in self.committed.iter().enumerate() {
            if let ChatPart::UserForm(existing) = part
                && existing.is_unresolved()
            {
                unresolved_count += 1;
                unresolved_ix = Some(i);
            }
        }
        if unresolved_count == 1
            && let Some(i) = unresolved_ix
            && let ChatPart::UserForm(existing) = &mut self.committed[i]
            && existing.completes_with(&spec)
        {
            existing.merge(spec);
            place_hitl_cards_in_document_order(&mut self.committed);
            return;
        }
        self.committed.push(ChatPart::UserForm(spec));
        place_hitl_cards_in_document_order(&mut self.committed);
    }

    fn push_save_login(&mut self, spec: SaveLoginSpec) {
        if let Some(existing) = self.committed.iter_mut().find_map(|part| match part {
            ChatPart::SaveLogin(existing)
                if existing.form_entry_id == spec.form_entry_id
                    || (existing.origin == spec.origin && existing.username == spec.username) =>
            {
                Some(existing)
            }
            _ => None,
        }) {
            *existing = spec;
            return;
        }
        self.committed.push(ChatPart::SaveLogin(spec));
        place_hitl_cards_in_document_order(&mut self.committed);
    }

    pub fn take_completed_ui_tools(&mut self) -> Vec<CompletedUiTool> {
        std::mem::take(&mut self.completed_ui)
    }

    fn push_ui(&mut self, spec: UiSpec, id: String, name: String) {
        let chart = matches!(spec, UiSpec::BarChart(_));
        self.committed.retain(|part| match part {
            ChatPart::Ui(UiSpec::BarChart(_)) => !chart,
            ChatPart::Ui(UiSpec::Form(_)) => chart,
            ChatPart::Text(_)
            | ChatPart::Approval(_)
            | ChatPart::Screenshot(_)
            | ChatPart::UserForm(_)
            | ChatPart::SaveLogin(_)
            | ChatPart::Step(_)
            | ChatPart::Reasoning(_)
            | ChatPart::PluginNeeds(_)
            | ChatPart::OfficeDoc(_) => true,
        });
        self.committed.push(ChatPart::Ui(spec));
        self.completed_ui.retain(|tool| tool.name != name);
        self.completed_ui.push(CompletedUiTool { id, name });
    }

    fn holding_ui(&self) -> bool {
        self.tool.is_some()
            || ui_object_incomplete(&self.text)
            || ui_opening_at_end(&self.text).is_some()
    }

    /// Commit what the text so far can be committed as, mid-stream. An object not yet closed, and
    /// a tail that may yet become one, are held for the next delta.
    fn flush_text(&mut self) {
        drain_complete_ui(&mut self.text, &mut self.committed, Held::Keep);
    }
}

/// What a chart is called: a CUSTOM `name`, a tool's name, or the object's own `ui` /
/// `component` / `type`, each after [`normalize_name`]. OpenGrok paints charts and forms through
/// the `bar_chart` and `form` tools it offers the model (opengrok-server `agui/chat_ui.rs`), so as
/// CUSTOM names these are the conformance ledger's, checked against what the server sends.
pub(crate) const BAR_CHART_NAMES: &[&str] = &["bar-chart", "barchart"];

/// What a generative form is called, read the same way as [`BAR_CHART_NAMES`].
pub(crate) const FORM_NAMES: &[&str] = &["form"];

/// The CUSTOM `name` of a widget that says what it is inside its own value.
pub(crate) const UI_CUSTOM_NAME: &str = "ui";

impl UiSpec {
    /// The widget as a value `from_value` reads back unchanged — what the database keeps, so a
    /// thread read back off disk mounts the same form or chart the stream did.
    pub fn to_value(&self) -> Value {
        match self {
            Self::Form(form) => serde_json::json!({
                "component": "form",
                "title": form.title,
                "prompt": form.prompt,
                "submit": form.submit,
                "fields": form.fields.iter().map(|field| serde_json::json!({
                    "id": field.id,
                    "label": field.label,
                    "options": field.options,
                })).collect::<Vec<_>>(),
            }),
            Self::BarChart(chart) => serde_json::json!({
                "component": "bar-chart",
                "title": chart.title,
                "bars": chart.bars.iter().map(|bar| serde_json::json!({
                    "label": bar.label,
                    "value": bar.value,
                })).collect::<Vec<_>>(),
            }),
        }
    }

    pub fn from_value(value: &Value) -> Option<Self> {
        Self::named(&ui_kind(value)?, value)
    }

    fn from_tool(name: &str, value: &Value) -> Option<Self> {
        if let Some(spec) = Self::from_value(value) {
            return Some(spec);
        }
        Self::named(&normalize_name(name), value)
    }

    /// The widget a normalized name stands for, read from `value`.
    fn named(kind: &str, value: &Value) -> Option<Self> {
        if BAR_CHART_NAMES.contains(&kind) {
            Some(Self::BarChart(BarChartSpec::from_value(value)?))
        } else if FORM_NAMES.contains(&kind) {
            Some(Self::Form(FormSpec::from_value(value)?))
        } else {
            None
        }
    }

    fn from_custom(name: &str, value: &Value) -> Option<Self> {
        if normalize_name(name) == UI_CUSTOM_NAME || name.is_empty() {
            return Self::from_value(value);
        }
        Self::from_tool(name, value)
    }
}

impl BarChartSpec {
    fn from_value(value: &Value) -> Option<Self> {
        let data = value.get("data").unwrap_or(value);
        let rows = data
            .get("bars")
            .or_else(|| data.get("values"))
            .or_else(|| value.get("bars"))?;
        let bars = parse_bars(rows);
        if bars.is_empty() {
            return None;
        }
        Some(Self {
            title: string_field(data, "title").or_else(|| string_field(value, "title")),
            bars,
        })
    }
}

impl FormSpec {
    fn from_value(value: &Value) -> Option<Self> {
        let data = value.get("data").unwrap_or(value);
        let fields = data
            .get("fields")
            .or_else(|| value.get("fields"))
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .enumerate()
                    .filter_map(|(i, row)| parse_field(row, i))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if fields.is_empty() {
            return None;
        }
        Some(Self {
            title: string_field(data, "title").or_else(|| string_field(value, "title")),
            prompt: string_field(data, "prompt").or_else(|| string_field(value, "prompt")),
            fields,
            submit: string_field(data, "submit")
                .or_else(|| string_field(value, "submit"))
                .unwrap_or_else(|| "Send".to_string()),
        })
    }
}

fn parse_field(row: &Value, index: usize) -> Option<FormField> {
    let label = string_field(row, "label").or_else(|| string_field(row, "name"))?;
    let id = string_field(row, "id").unwrap_or_else(|| format!("field-{index}"));
    let options = row
        .get("options")
        .and_then(Value::as_array)
        .map(|opts| {
            opts.iter()
                .filter_map(|opt| {
                    opt.as_str()
                        .map(str::to_string)
                        .or_else(|| string_field(opt, "label"))
                        .or_else(|| string_field(opt, "value"))
                })
                .collect()
        })
        .unwrap_or_default();
    Some(FormField { id, label, options })
}

fn parse_bars(rows: &Value) -> Vec<BarItem> {
    let Some(rows) = rows.as_array() else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|row| {
            if let Some(arr) = row.as_array() {
                let label = arr.first().and_then(Value::as_str)?.to_string();
                let value = arr.get(1).and_then(json_f32)?;
                return Some(BarItem { label, value });
            }
            let label = string_field(row, "label")
                .or_else(|| string_field(row, "name"))
                .unwrap_or_default();
            let value = row
                .get("value")
                .or_else(|| row.get("y"))
                .and_then(json_f32)?;
            if label.is_empty() {
                return None;
            }
            Some(BarItem { label, value })
        })
        .collect()
}

fn json_f32(value: &Value) -> Option<f32> {
    value
        .as_f64()
        .map(|n| n as f32)
        .or_else(|| value.as_i64().map(|n| n as f32))
        .or_else(|| value.as_u64().map(|n| n as f32))
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn ui_kind(value: &Value) -> Option<String> {
    if let Some(kind) = value
        .get("ui")
        .or_else(|| value.get("component"))
        .and_then(Value::as_str)
    {
        return Some(normalize_name(kind));
    }
    let ty = value.get("type").and_then(Value::as_str)?;
    if ty.eq_ignore_ascii_case("ui") {
        return value
            .get("name")
            .and_then(Value::as_str)
            .map(normalize_name);
    }
    Some(normalize_name(ty))
}

pub(crate) fn is_ui_tool(name: &str) -> bool {
    matches!(
        normalize_name(name).as_str(),
        "bar-chart"
            | "barchart"
            | "show-bar-chart"
            | "render-bar-chart"
            | "form"
            | "show-form"
            | "render-form"
    )
}

fn normalize_name(name: &str) -> String {
    name.trim().to_ascii_lowercase().replace(['_', ' '], "-")
}

/// What `drain_complete_ui` does with text that may still become a UI object.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Held {
    /// Mid-stream: keep it for the next delta.
    Keep,
    /// The stream is over: it is words, and goes out as text.
    Release,
}

fn drain_complete_ui(buf: &mut String, out: &mut Vec<ChatPart>, held: Held) {
    loop {
        let Some(start) = find_ui_object(buf) else {
            // A delta can end partway into an object's opening (`{`, `{"u`, `{ "compon`). Sent on
            // as text, the rest of the object would arrive with no `{` in front of it and never be
            // recognised, so that tail waits for the next delta.
            let keep = match held {
                Held::Keep => ui_opening_at_end(buf).unwrap_or(buf.len()),
                Held::Release => buf.len(),
            };
            if keep > 0 {
                out.push(ChatPart::Text(buf[..keep].to_string()));
                buf.replace_range(..keep, "");
            }
            return;
        };
        let Some(len) = complete_json_len(&buf[start..]) else {
            if held == Held::Release {
                out.push(ChatPart::Text(std::mem::take(buf)));
            }
            return;
        };
        if start > 0 {
            out.push(ChatPart::Text(buf[..start].to_string()));
        }
        let end = start + len;
        let raw = buf[start..end].to_string();
        buf.replace_range(..end, "");
        match serde_json::from_str::<Value>(&raw)
            .ok()
            .and_then(|v| UiSpec::from_value(&v))
        {
            Some(spec) => out.push(ChatPart::Ui(spec)),
            None => out.push(ChatPart::Text(raw)),
        }
    }
}

fn ui_object_incomplete(buf: &str) -> bool {
    match find_ui_object(buf) {
        None => false,
        Some(start) => complete_json_len(&buf[start..]).is_none(),
    }
}

/// Where a UI object's opening may be starting at the very end of `s`: a `{` followed by no more
/// than a strict prefix of what `find_ui_object` looks for. `None` when the tail cannot be one.
fn ui_opening_at_end(s: &str) -> Option<usize> {
    s.char_indices()
        .filter(|&(_, c)| c == '{')
        .map(|(i, _)| i)
        .find(|&i| {
            let rest = &s[i + 1..];
            let key = rest.strip_prefix(' ').unwrap_or(rest);
            ["\"ui\"", "\"component\""]
                .iter()
                .any(|opening| opening.len() > key.len() && opening.starts_with(key))
        })
}

fn find_ui_object(s: &str) -> Option<usize> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            let rest = s[i..].trim_start();
            if rest.starts_with("{\"ui\"")
                || rest.starts_with("{ \"ui\"")
                || rest.starts_with("{\"component\"")
                || rest.starts_with("{ \"component\"")
            {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

fn complete_json_len(s: &str) -> Option<usize> {
    let bytes = s.as_bytes();
    if bytes.first() != Some(&b'{') {
        return None;
    }
    let mut depth = 0i32;
    let mut in_str = false;
    let mut escape = false;
    for (i, &b) in bytes.iter().enumerate() {
        if in_str {
            if escape {
                escape = false;
                continue;
            }
            if b == b'\\' {
                escape = true;
                continue;
            }
            if b == b'"' {
                in_str = false;
            }
            continue;
        }
        match b {
            b'"' => in_str = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
    }
    None
}

/// A turn's words, with the things that are not words left out.
///
/// Text arrives in deltas and each one is committed as its own part, so neighbouring text parts
/// are halves of the same sentence and are joined with nothing between them. A picture or a card
/// between them is not: the stream broke the text there, and the person read what came after as
/// a new bubble, so those keep a blank line between them. Joining those too was what turned a
/// recipe run into "…using the taught recipe.YouTube is open on my box…", one run-on paragraph
/// in the feed and in the history the model is sent next turn.
///
/// A chart is the exception: it is cut out of the middle of a sentence that was streamed whole,
/// and "See this <chart> and more" is one sentence with a picture in it.
///
/// A step and a thought are drawn between the words either side of them, like a card, and part
/// them like one. Nothing of either is words: what a tool was given or gave back, and what the
/// coworker thought, stay out of what is copied, read aloud, searched and sent back as history.
fn plain_text(parts: &[ChatPart]) -> String {
    let mut out = String::new();
    let mut run = String::new();
    for part in parts {
        match part {
            ChatPart::Text(text) => run.push_str(text),
            ChatPart::Ui(_) => {}
            ChatPart::Approval(_)
            | ChatPart::Screenshot(_)
            | ChatPart::UserForm(_)
            | ChatPart::SaveLogin(_)
            | ChatPart::Step(_)
            | ChatPart::Reasoning(_)
            | ChatPart::PluginNeeds(_)
            | ChatPart::OfficeDoc(_) => push_run(&mut out, std::mem::take(&mut run)),
        }
    }
    push_run(&mut out, run);
    out
}

/// One bubble's worth of words onto the end of the turn, a blank line after the last.
fn push_run(out: &mut String, run: String) {
    if run.trim().is_empty() {
        return;
    }
    if out.is_empty() {
        out.push_str(&run);
        return;
    }
    out.truncate(out.trim_end().len());
    out.push_str("\n\n");
    out.push_str(run.trim_start());
}

pub fn approval_from_event(event: &Value) -> Option<ApprovalSpec> {
    let run_id = string_at(event, "runId")?;
    let call_id = string_at(event, "callId")?;
    if run_id.is_empty() || call_id.is_empty() {
        return None;
    }
    let tool = string_at(event, "tool").unwrap_or_else(|| "a tool".to_string());
    let arguments = event
        .get("arguments")
        .cloned()
        .or_else(|| {
            event
                .get("value")
                .and_then(|value| value.get("arguments"))
                .cloned()
        })
        .unwrap_or(Value::Null);
    let summary = approval_summary(&tool, &arguments);
    Some(ApprovalSpec {
        run_id,
        thread_id: string_at(event, "threadId").filter(|id| !id.trim().is_empty()),
        call_id,
        command: command_from_args(&arguments),
        why: string_at(event, "why").unwrap_or_default(),
        reason: string_at(event, "reason").unwrap_or_else(|| "exec-consent".to_string()),
        summary,
        tool,
        output: None,
        ok: None,
    })
}

/// What a call would do, in the words opengrok-server's own approval card uses: "Click at
/// (120, 40) on the agent's own screen", "Open https://example.com/inbox in the agent's own
/// browser". Transcribed from `summary_for` in opengrok-server `cards.rs` (#211, and #246 for
/// the redaction) as of 234e755.
///
/// It is built here because servers before opengrok-server #263 sent the tool and its arguments
/// and nothing else about what the call would do, so the card used to show the arguments as
/// JSON. Since #263 the `run-awaiting-approval` frame, its replay and the approvals queue carry
/// the server's own `summary` (`summary_for_ask`, null for a form), and the conformance ledger
/// holds every recorded one to what this builds. Built the same way, typed text and keys that
/// look like secrets read `«redacted»` and a page is named without its query, as on the
/// server's card.
///
/// Empty for the two shells, whose command is what the card shows (the server's card shows
/// its `command_for` in place of the summary), and for a call that came without arguments.
/// An empty summary leaves the card as it was.
pub fn approval_summary(tool: &str, arguments: &Value) -> String {
    if !arguments.is_object() {
        return String::new();
    }
    match tool {
        USER_MACHINE_SHELL | "shell" => String::new(),
        "read_file" => format!(
            "Read {} on the agent's own box",
            clip(string_arg(arguments, "path").unwrap_or("a file"), 200)
        ),
        "write_file" => format!(
            "Write {} bytes to {} on the agent's own box",
            string_arg(arguments, "content").map_or(0, str::len),
            clip(string_arg(arguments, "path").unwrap_or("a file"), 200)
        ),
        "computer" => screen_summary(arguments),
        "open_url" => format!(
            "Open {} in the agent's own browser",
            clip(page_of(arguments), 120)
        ),
        // The recipe's `values` stay off the card: a login recipe is handed a password.
        "run_recipe" => format!(
            "Play the recipe \"{}\" on the agent's own computer",
            clip(string_arg(arguments, "recipe").unwrap_or("(unnamed)"), 80)
        ),
        // The server's own builtin for reading an attached skill (#270), named by the skill as a
        // recipe is: opengrok-server `cards.rs` `summary_for` has the same arm (#290), which no
        // card should ever need, since `use_skill` raises none. Named by the skill rather than by
        // the plugin rule, which would read a long skill name as a key and hide it.
        USE_SKILL => format!(
            "Read the skill \"{}\"",
            clip(string_arg(arguments, "name").unwrap_or("(unnamed)"), 80)
        ),
        // The routine tools (#316, the same `summary_for` at #334, on main 8e7387f, and a list of
        // the Bot's own routines since #349, `cards.rs` at 9a2b011): a routine by its id, never by
        // a name the call wrote, since a delete's card names the routine as stored in its `why`; a
        // create by its `when` as the call wrote it, as JSON.
        LIST_ROUTINES => "List this Bot's routines".to_string(),
        CREATE_ROUTINE => format!(
            "Make a routine that wakes at {}",
            clip(
                &arguments.get("when").unwrap_or(&Value::Null).to_string(),
                80
            )
        ),
        UPDATE_ROUTINE | DELETE_ROUTINE => format!(
            "{} the routine {}",
            if tool == DELETE_ROUTINE {
                "Delete"
            } else {
                "Change"
            },
            clip(string_arg(arguments, "routine").unwrap_or("(none)"), 80)
        ),
        other => format!(
            "{other} — a plugin tool this agent wants to call, with {}",
            clip(&redacted_arguments(arguments), 160)
        ),
    }
}

/// A call's arguments as its step keeps them, with what the approval card for the same call
/// keeps off it kept off here too, by the card's own rules (see [`approval_summary`]): a
/// shell's command, and the skill a `use_skill` call reads, as they are; a file named and what
/// is written into it only counted; typed text and keys that look like secrets as
/// `«redacted»`; a page without its query or fragment; a recipe without its `values`, since a
/// login recipe is handed a password; and a plugin call with its identity keys dropped and its
/// secrets redacted.
///
/// A step is on screen, opened and written to disk long after its card would have been
/// answered, and it is shown for every call, card or none, so it is held to at least the
/// card's rules. The assembler applies this when a call's arguments are complete, and keeps
/// nothing else of them: neither the part in memory nor its row on disk holds the raw text.
/// Applied twice it changes nothing, so a row read back is held to the same rules.
pub(crate) fn step_arguments(tool: &str, arguments: &Value) -> Value {
    if !arguments.is_object() {
        return match tool {
            USER_MACHINE_SHELL | "shell" => arguments.clone(),
            _ => redact_value(arguments, None),
        };
    }
    let mut kept = arguments.clone();
    match tool {
        // A skill's name is what a `use_skill` call means, and it is kept as sent: the plugin
        // rule would read a long one as a key.
        USER_MACHINE_SHELL | "shell" | "read_file" | USE_SKILL => {}
        "write_file" => {
            if let Some(content) = string_arg(arguments, "content") {
                kept["content"] = Value::from(content.len());
            }
        }
        "computer" => {
            for (key, max) in [("text", 60), ("key", 40)] {
                if let Some(said) = string_arg(arguments, key) {
                    kept[key] = Value::String(shown(said, max));
                }
            }
        }
        "open_url" => {
            if string_arg(arguments, "url").is_some() {
                kept["url"] = Value::String(page_of(arguments).to_string());
            }
        }
        "run_recipe" => {
            if let Some(object) = kept.as_object_mut() {
                object.remove("values");
            }
        }
        _ => kept = redact_value(arguments, None),
    }
    kept
}

/// What a step keeps of a call's argument text: [`step_arguments`] of it, cut to the cap.
/// Nothing, for text that is not JSON — there is no telling what in it is a secret.
fn kept_arguments(tool: &str, raw: &str) -> String {
    serde_json::from_str::<Value>(raw)
        .map(|arguments| capped(&step_arguments(tool, &arguments).to_string()))
        .unwrap_or_default()
}

/// A `computer` call in words, from the fields the server's `screen_summary` reads. An action
/// it does not know is named, not dropped.
fn screen_summary(arguments: &Value) -> String {
    let screen = if string_arg(arguments, "machine") == Some("group") {
        "the group's shared screen"
    } else {
        "the agent's own screen"
    };
    let point = |key: &str| {
        let xy = arguments.get(key).and_then(Value::as_array);
        let at = |i: usize| xy.and_then(|xy| xy.get(i)).and_then(Value::as_i64);
        match (at(0), at(1)) {
            (Some(x), Some(y)) => format!("({x}, {y})"),
            _ => "(no position)".to_string(),
        }
    };
    let at = point("coordinate");
    match string_arg(arguments, "action").unwrap_or("") {
        "screenshot" => format!("Take a screenshot of {screen}"),
        "click" | "left_click" => format!("Click at {at} on {screen}"),
        "right_click" => format!("Right-click at {at} on {screen}"),
        "double_click" => format!("Double-click at {at} on {screen}"),
        "move" | "mouse_move" => format!("Move the pointer to {at} on {screen}"),
        "drag" | "left_click_drag" => format!("Drag from {at} to {} on {screen}", point("to")),
        "type" => format!(
            "Type \"{}\" on {screen}",
            shown(string_arg(arguments, "text").unwrap_or(""), 60)
        ),
        "key" => format!(
            "Press {} on {screen}",
            shown(string_arg(arguments, "key").unwrap_or("a key"), 40)
        ),
        "scroll" => format!("Scroll at {at} on {screen}"),
        other => format!("Screen action \"{}\" on {screen}", clip(other, 30)),
    }
}

fn string_arg<'a>(arguments: &'a Value, key: &str) -> Option<&'a str> {
    arguments.get(key).and_then(Value::as_str)
}

/// Typed text as the card may show it. The whole text is checked before it is clipped, which
/// would otherwise cut a key below the length the check needs.
fn shown(text: &str, max: usize) -> String {
    if looks_like_a_secret(text) {
        REDACTED.to_string()
    } else {
        clip(text, max)
    }
}

/// The page an `open_url` call names, without its query or fragment, where a link's token
/// rides.
fn page_of(arguments: &Value) -> &str {
    let url = string_arg(arguments, "url").unwrap_or("a page");
    url.split(['?', '#']).next().unwrap_or(url)
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let kept: String = text.chars().take(max).collect();
    format!("{kept}…")
}

/// What a secret-looking value reads as on the server's card (opengrok-tools `review.rs`).
pub(crate) const REDACTED: &str = "«redacted»";

/// The server's own test for a key-shaped string (opengrok-tools `review.rs`
/// `looks_like_a_secret`): a known key prefix, or one long run of token characters with no
/// spaces. As coarse as the server's, so the two cards hide the same values.
fn looks_like_a_secret(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.starts_with("Bearer ") || trimmed.starts_with("sk-") || trimmed.starts_with("xoxb-")
    {
        return true;
    }
    trimmed.len() >= 40
        && !trimmed.contains(' ')
        && trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '+' | '/' | '='))
}

/// A plugin call's arguments as the server's card shows them (opengrok-tools `review.rs`
/// `redact_arguments`): the identity keys the server fills in itself are dropped, and a value
/// under a secret's name, or shaped like one, reads `«redacted»`. The server also clips each
/// value at 500 characters, which the 160 the summary keeps never reaches.
fn redacted_arguments(arguments: &Value) -> String {
    redact_value(arguments, None).to_string()
}

fn redact_value(value: &Value, key: Option<&str>) -> Value {
    const IDENTITY_KEYS: &[&str] = &[
        "account_id",
        "accountId",
        "coworker_id",
        "coworkerId",
        "box_id",
        "boxId",
    ];
    const SECRET_KEY_FRAGMENTS: &[&str] = &[
        "token",
        "secret",
        "password",
        "passwd",
        "authorization",
        "api_key",
        "apikey",
        "credential",
        "cookie",
    ];
    if let Some(key) = key {
        let lower = key.to_ascii_lowercase();
        if SECRET_KEY_FRAGMENTS
            .iter()
            .any(|fragment| lower.contains(fragment))
        {
            return Value::String(REDACTED.to_string());
        }
    }
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(key, _)| !IDENTITY_KEYS.contains(&key.as_str()))
                .map(|(key, value)| (key.clone(), redact_value(value, Some(key))))
                .collect(),
        ),
        Value::Array(items) => {
            Value::Array(items.iter().map(|item| redact_value(item, None)).collect())
        }
        Value::String(text) if looks_like_a_secret(text) => Value::String(REDACTED.to_string()),
        other => other.clone(),
    }
}

/// Centered status Grok paints after the permission card leaves the transcript.
/// `place` is [`ApprovalSpec::place`].
pub fn local_exec_outcome(bot: &str, resolution: LocalExecResolution, place: &str) -> String {
    match resolution {
        LocalExecResolution::Always => format!("{bot} can run commands on {place}."),
        LocalExecResolution::Never => format!("{bot} cannot run commands on {place}."),
        LocalExecResolution::DenyOnce => {
            format!("{bot} was not allowed to run commands on {place}.")
        }
        LocalExecResolution::AllowOnce => {
            format!("{bot} can run commands on {place} this time.")
        }
    }
}

/// The line the local shell's card leaves behind. Always and Never there answer the one command
/// on the card from then on, with a rule this Mac keeps for it, and not every command (#87):
/// "can run commands on your computer" told the person the whole Mac was open, or shut, when it
/// was not. Said by this Mac's own Always or Never instead, the same words are as true. Once is
/// once, in the words it always had.
pub fn local_shell_outcome(bot: &str, resolution: LocalExecResolution) -> String {
    match resolution {
        LocalExecResolution::Always => {
            format!("{bot} can run this command on your computer without asking.")
        }
        LocalExecResolution::Never => format!("{bot} cannot run this command on your computer."),
        once => local_exec_outcome(bot, once, "your computer"),
    }
}

/// The same line for a card the MCP door raised.
///
/// The local-shell wording is about a machine and a policy that outlives the
/// answer — "can run commands on your computer" — and none of that is what was
/// answered here: one call, by one tool, once. There is no policy to move
/// either, which is why an MCP card has no Always and no Never to reach this
/// with; the two that cannot happen read as the once they would have been.
pub fn mcp_call_outcome(bot: &str, resolution: LocalExecResolution, tool: &str) -> String {
    match resolution {
        LocalExecResolution::AllowOnce | LocalExecResolution::Always => {
            format!("{bot} may run {tool} once.")
        }
        LocalExecResolution::DenyOnce | LocalExecResolution::Never => {
            format!("{bot} was told no.")
        }
    }
}

pub fn command_from_replay_events(events: &[Value], call_id: &str) -> String {
    let mut args = String::new();
    for event in events {
        let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
        let tool_id = event
            .get("toolCallId")
            .or_else(|| event.get("id"))
            .or_else(|| event.get("callId"))
            .and_then(Value::as_str);
        if matches!(kind, "TOOL_CALL_ARGS" | "TOOL_CALL_CHUNK") && tool_id == Some(call_id) {
            if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                args.push_str(delta);
            }
            let from_args = event
                .get("arguments")
                .map(command_from_args)
                .unwrap_or_default();
            if !from_args.is_empty() {
                return from_args;
            }
        }
        if kind == "CUSTOM"
            && event.get("name").and_then(Value::as_str) == Some(RUN_AWAITING_APPROVAL)
            && event.get("callId").and_then(Value::as_str) == Some(call_id)
        {
            let from_args = event
                .get("arguments")
                .or_else(|| event.get("args"))
                .map(command_from_args)
                .unwrap_or_default();
            if !from_args.is_empty() {
                return from_args;
            }
        }
    }
    if let Ok(parsed) = serde_json::from_str::<Value>(&args) {
        let command = command_from_args(&parsed);
        if !command.is_empty() {
            return command;
        }
    }
    args.trim().to_string()
}

pub fn command_from_args(arguments: &Value) -> String {
    for key in ["command", "cmd", "shell", "script"] {
        if let Some(command) = arguments.get(key).and_then(Value::as_str) {
            let command = command.trim();
            if !command.is_empty() {
                return command.to_string();
            }
        }
    }
    if let Some(raw) = arguments.as_str() {
        if let Ok(parsed) = serde_json::from_str::<Value>(raw) {
            return command_from_args(&parsed);
        }
        return raw.to_string();
    }
    if arguments.is_null() || arguments.as_object().is_some_and(|map| map.is_empty()) {
        return String::new();
    }
    arguments.to_string()
}

/// A reasoning frame's `messageId`, which is how its blocks are told apart.
fn message_id(event: &Value) -> String {
    event
        .get("messageId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn string_at(event: &Value, key: &str) -> Option<String> {
    event
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            event
                .get("value")
                .and_then(|value| value.get(key))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
}

/// What the next `/ag-ui` run is told after NativeChat paints a frontend tool.
pub const UI_TOOL_RESULT: &str = "It is now on screen for the person.";

pub const MAX_TURN_CONTINUES: usize = 8;

pub fn agui_tools() -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({
            "name": "bar_chart",
            "description": "Render an interactive bar chart in the chat instead of markdown or ASCII.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "bars": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "label": { "type": "string" },
                                "value": { "type": "number" }
                            },
                            "required": ["label", "value"]
                        }
                    }
                },
                "required": ["bars"]
            }
        }),
        serde_json::json!({
            "name": "form",
            "description": "Render an interactive choice form in the chat instead of a bullet list.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "prompt": { "type": "string" },
                    "submit": { "type": "string" },
                    "fields": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": { "type": "string" },
                                "label": { "type": "string" },
                                "options": { "type": "array", "items": { "type": "string" } }
                            },
                            "required": ["label", "options"]
                        }
                    }
                },
                "required": ["fields"]
            }
        }),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn text(delta: &str) -> Value {
        json!({"type":"TEXT_MESSAGE_CONTENT","delta":delta})
    }

    /// The badge comes from the live stream's own frame, the CUSTOM the server sends right after
    /// RUN_STARTED, and from that frame alone: it is on the reply from the moment it arrives,
    /// paints nothing among the reply's words, and a run with no such frame has no badge.
    #[test]
    fn the_reply_source_comes_from_the_custom_frame_and_paints_nothing() {
        use super::super::inference::InferenceKind;
        let mut live = TurnAssembler::default();
        live.push_event(&json!({"type": "RUN_STARTED", "runId": "r1", "threadId": "cw_1"}));
        assert_eq!(live.reply_source(), None, "nothing said yet");
        live.push_event(&json!({
            "type": "CUSTOM",
            "name": INFERENCE_SOURCE_CUSTOM,
            "value": {"kind": "local_proxy", "model": "gpt-5-codex"}
        }));
        assert_eq!(
            live.reply_source(),
            Some(&ReplySource {
                kind: InferenceKind::LocalProxy,
                model: Some("gpt-5-codex".into()),
                via: None,
                fallback_for: None,
            }),
            "on the reply before a word of it has come"
        );
        assert_eq!(live.snapshot(), (String::new(), Vec::new()));
        live.push_event(&text("Done."));
        live.push_event(&json!({"type": "RUN_FINISHED", "runId": "r1"}));
        live.finish();
        assert_eq!(live.snapshot().1, vec![ChatPart::Text("Done.".into())]);
        assert_eq!(
            live.reply_source().map(|source| source.kind),
            Some(InferenceKind::LocalProxy)
        );

        // A frame of a door this app cannot name leaves the badge off rather than guessing.
        let mut odd = TurnAssembler::default();
        odd.push_event(&json!({
            "type": "CUSTOM", "name": INFERENCE_SOURCE_CUSTOM, "value": {"kind": "byok"}
        }));
        odd.push_event(&text("Hi."));
        assert_eq!(odd.reply_source(), None);
        assert_eq!(odd.snapshot().1, vec![ChatPart::Text("Hi.".into())]);

        let mut older = TurnAssembler::default();
        older.push_event(&json!({"type": "RUN_STARTED", "runId": "r1", "threadId": "cw_1"}));
        older.push_event(&text("Hi."));
        assert_eq!(older.reply_source(), None, "a server before reply sources");
    }

    /// The frame an `office_*` tool emits (opengrok-server `office_desk.rs` `frame`,
    /// gol/betteroffice), as the stream carries it.
    fn office_frame(doc_id: &str, path: &str, kind: &str, version: u64) -> Value {
        json!({
            "type": "CUSTOM",
            "name": OFFICE_DOC_CUSTOM,
            "value": {
                "docId": doc_id,
                "path": path,
                "kind": kind,
                "version": version,
                "artifactId": null,
                "changed": {"type": "edited"},
            }
        })
    }

    /// A document frame becomes one card in the reply and one entry for the window: the card
    /// says what the file is, the map says which doc the turn touched last.
    #[test]
    fn an_office_doc_frame_is_a_card_and_the_windows_doc() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&office_frame("odoc_1", "~/office/report.docx", "docx", 1));
        let (_, parts) = turn.snapshot();
        let spec = OfficeDocSpec {
            doc_id: "odoc_1".into(),
            path: "~/office/report.docx".into(),
            kind: "docx".into(),
            version: 1,
            artifact_id: None,
            changed: json!({"type": "edited"}),
        };
        assert_eq!(parts, vec![ChatPart::OfficeDoc(spec.clone())]);
        assert_eq!(turn.office_docs().get("odoc_1"), Some(&spec));
        assert_eq!(turn.office_latest(), Some("odoc_1"));
    }

    /// Every frame for the same document rewrites its card in place rather than dealing another
    /// one — ten edits in a turn are ten versions of one card — and the window's entry keeps the
    /// newest word on it.
    #[test]
    fn office_doc_frames_rewrite_the_card_in_place() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&office_frame("odoc_1", "deck.pptx", "pptx", 1));
        turn.push_event(&text("Adjusted the title."));
        turn.push_event(&office_frame("odoc_1", "deck.pptx", "pptx", 2));
        let (plain, parts) = turn.snapshot();
        let docs: Vec<_> = parts
            .iter()
            .filter(|part| matches!(part, ChatPart::OfficeDoc(_)))
            .collect();
        assert_eq!(docs.len(), 1, "one card for one document, {parts:?}");
        let ChatPart::OfficeDoc(spec) = &parts[0] else {
            panic!("the card sits where the document first appeared");
        };
        assert_eq!(spec.version, 2);
        assert_eq!(
            parts.get(1),
            Some(&ChatPart::Text("Adjusted the title.".into())),
            "the words after it stay after it"
        );
        assert!(plain.contains("Adjusted the title."));
        assert_eq!(turn.office_docs().get("odoc_1").map(|s| s.version), Some(2));
    }

    /// Two documents are two cards in the order they were first touched, and the tab the window
    /// paints live is whichever the newest frame named.
    #[test]
    fn two_documents_are_two_cards_and_the_latest_frame_picks_the_live_one() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&office_frame("odoc_1", "a.docx", "docx", 1));
        turn.push_event(&office_frame("odoc_2", "b.xlsx", "xlsx", 1));
        turn.push_event(&office_frame("odoc_1", "a.docx", "docx", 2));
        let (_, parts) = turn.snapshot();
        let ids: Vec<_> = parts
            .iter()
            .filter_map(|part| match part {
                ChatPart::OfficeDoc(spec) => Some(spec.doc_id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(ids, vec!["odoc_1", "odoc_2"]);
        assert_eq!(turn.office_latest(), Some("odoc_1"));
    }

    /// The stored card reads back as the frame it was written from: a thread reopened from the
    /// local store shows the document card without waiting on a replay.
    #[test]
    fn an_office_doc_spec_round_trips_through_storage() {
        let spec = OfficeDocSpec {
            doc_id: "odoc_7".into(),
            path: "~/office/q3.xlsx".into(),
            kind: "xlsx".into(),
            version: 4,
            artifact_id: Some("art_2".into()),
            changed: json!({"type": "exported", "exportPath": "~/office/q3-final.xlsx"}),
        };
        let back = OfficeDocSpec::from_value(&spec.to_value());
        assert_eq!(back.as_ref(), Some(&spec));
        assert_eq!(spec.file_name(), "q3.xlsx");
        assert_eq!(spec.kind_label(), "XLSX");
        assert_eq!(spec.changed_type(), Some("exported"));
    }

    /// A CUSTOM that merely shares the name's prefix is not a document, and a document frame
    /// missing its identity is dropped rather than painted as a card that opens nothing.
    #[test]
    fn only_a_whole_office_doc_frame_is_a_card() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&json!({
            "type": "CUSTOM", "name": "opengrok.officeDoc.draft",
            "value": {"docId": "odoc_1", "path": "a.docx", "kind": "docx", "version": 1}
        }));
        turn.push_event(&json!({
            "type": "CUSTOM", "name": OFFICE_DOC_CUSTOM,
            "value": {"kind": "docx", "version": 1}
        }));
        assert!(turn.snapshot().1.is_empty());
        assert!(turn.office_docs().is_empty());
    }

    /// A replay opens a run with the person's own messages, and the frame that says which door
    /// the run went through comes after them rather than right after RUN_STARTED: the badge is
    /// the run's first such frame wherever it sits, the person's words stay the person's, and
    /// the reply is the coworker's words alone.
    #[test]
    fn the_reply_source_is_the_runs_first_frame_wherever_a_replay_puts_it() {
        use super::super::inference::InferenceKind;
        let custom = |kind: &str, model: &str| {
            json!({
                "type": "CUSTOM", "name": INFERENCE_SOURCE_CUSTOM,
                "value": {"kind": kind, "model": model}
            })
        };
        let replay = [
            json!({"type": "RUN_STARTED", "runId": "r2", "threadId": "cw_1"}),
            json!({"type": "TEXT_MESSAGE_START", "messageId": "m2", "role": "user"}),
            json!({"type": "TEXT_MESSAGE_CONTENT", "messageId": "m2", "delta": "and the second?"}),
            json!({"type": "TEXT_MESSAGE_END", "messageId": "m2"}),
            custom("local_proxy", "gpt-5.5"),
            json!({"type": "TEXT_MESSAGE_START", "messageId": "a2", "role": "assistant"}),
            json!({"type": "TEXT_MESSAGE_CONTENT", "messageId": "a2", "delta": "from the proxy"}),
            json!({"type": "TEXT_MESSAGE_END", "messageId": "a2"}),
            // Were a second frame ever to come, the run's first stands.
            custom("gateway", "xai/grok-4.6"),
            json!({"type": "RUN_FINISHED", "runId": "r2"}),
        ];
        let mut read = TurnAssembler::default();
        for (at, frame) in replay.iter().enumerate() {
            read.push_event(frame);
            if at < 4 {
                assert_eq!(read.reply_source(), None, "not said yet at frame {at}");
            }
        }
        read.finish();
        assert_eq!(
            read.reply_source(),
            Some(&ReplySource {
                kind: InferenceKind::LocalProxy,
                model: Some("gpt-5.5".into()),
                via: None,
                fallback_for: None,
            })
        );
        assert_eq!(
            read.snapshot().1,
            vec![ChatPart::Text("from the proxy".into())],
            "the reply is the coworker's words"
        );
        assert_eq!(
            persons_messages(&replay),
            vec![("m2".to_string(), "and the second?".to_string())]
        );
    }

    fn review_card(why: &str) -> ApprovalSpec {
        ApprovalSpec {
            run_id: "run_1".into(),
            thread_id: Some("cw_1".into()),
            call_id: "call_1".into(),
            tool: "computer".into(),
            command: "screenshot".into(),
            why: why.into(),
            reason: "auto-review".into(),
            summary: String::new(),
            output: None,
            ok: None,
        }
    }

    /// The tunnel's card is told apart by the server's own sentence, and its Always and Never
    /// read as the standing choice they are; a judge's card keeps the once-only wording.
    #[test]
    fn the_tunnel_card_is_its_own_kind_and_says_so_when_answered() {
        let tunnel = review_card(
            "This action would use your network through the egress tunnel. Review it before it runs.",
        );
        assert!(tunnel.is_review_an_action());
        assert!(tunnel.is_egress_tunnel());
        assert_eq!(
            tunnel.outcome("Vamos", LocalExecResolution::Always),
            "Vamos may use your network from its computer."
        );
        assert_eq!(
            tunnel.outcome("Vamos", LocalExecResolution::Never),
            "Vamos may not use your network from its computer."
        );
        assert_eq!(
            tunnel.outcome("Vamos", LocalExecResolution::DenyOnce),
            "Vamos was not allowed to use your network this time."
        );

        let judge = review_card("Ask first: the page is a bank.");
        assert!(judge.is_review_an_action());
        assert!(!judge.is_egress_tunnel());
        // A judge's instruction that mentions the tunnel is still a judge's card.
        let mentions =
            review_card("Ask first when a page would reach the web through the egress tunnel.");
        assert!(!mentions.is_egress_tunnel());
        // A local-shell card is never the tunnel's, whatever its sentence.
        let mut local = tunnel.clone();
        local.tool = USER_MACHINE_SHELL.into();
        assert!(!local.is_egress_tunnel());
        // The server may also say it in a word.
        let mut worded = judge.clone();
        worded.reason = "egress".into();
        assert!(worded.is_egress_tunnel());
        assert_eq!(
            judge.outcome("Vamos", LocalExecResolution::AllowOnce),
            "Vamos can run commands on its computer this time."
        );
    }

    /// Always and Never on the tunnel's card write its computer's standing choice, for the bot
    /// whose thread raised it: Always goes out as `bypass`. A once writes nothing, and a judge's
    /// card, a local-shell card or a plain consent card has no computer choice behind its Always.
    #[test]
    fn only_the_tunnel_cards_always_and_never_write_the_computers_choice() {
        let tunnel = review_card(EGRESS_TUNNEL_ASK_REASON);
        assert_eq!(tunnel.conversation_id(), Some("cw_1"));
        assert_eq!(
            tunnel.egress_standing(LocalExecResolution::Always),
            Some(LocalExecMode::Always)
        );
        assert_eq!(LocalExecMode::Always.as_stored(), "bypass");
        assert_eq!(
            tunnel.egress_standing(LocalExecResolution::Never),
            Some(LocalExecMode::Never)
        );
        assert_eq!(tunnel.egress_standing(LocalExecResolution::AllowOnce), None);
        assert_eq!(tunnel.egress_standing(LocalExecResolution::DenyOnce), None);

        let judge = review_card("Ask first: the page is a bank.");
        assert_eq!(judge.egress_standing(LocalExecResolution::Always), None);
        let mut local = tunnel.clone();
        local.tool = USER_MACHINE_SHELL.into();
        assert_eq!(local.egress_standing(LocalExecResolution::Always), None);
        let mut consent = tunnel.clone();
        consent.reason = "exec-consent".into();
        assert_eq!(consent.egress_standing(LocalExecResolution::Never), None);
    }

    /// A generative form or chart is saved as the value it was parsed from, so a thread read
    /// back from the database mounts the same widget the stream did.
    #[test]
    fn a_form_and_a_chart_survive_the_trip_through_their_own_value() {
        let form = UiSpec::Form(FormSpec {
            title: Some("QA collapse remasure".into()),
            prompt: Some("Enter a label.".into()),
            fields: vec![
                FormField {
                    id: "label".into(),
                    label: "Label".into(),
                    options: vec![],
                },
                FormField {
                    id: "size".into(),
                    label: "Size".into(),
                    options: vec!["S".into(), "M".into()],
                },
            ],
            submit: "Submit".into(),
        });
        assert_eq!(UiSpec::from_value(&form.to_value()), Some(form));

        let chart = UiSpec::BarChart(BarChartSpec {
            title: Some("Visits".into()),
            bars: vec![BarItem {
                label: "Mon".into(),
                value: 3.5,
            }],
        });
        assert_eq!(UiSpec::from_value(&chart.to_value()), Some(chart));
    }

    #[test]
    fn text_deltas_stream_before_the_run_ends() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&text("Hello "));
        let (plain, parts) = turn.snapshot();
        assert_eq!(plain, "Hello ");
        assert_eq!(parts, vec![ChatPart::Text("Hello ".into())]);
    }

    /// A replay opens each run with the person's own words, as text frames with role user. They
    /// are the question, not the answer: the coworker's reply is only the coworker's words,
    /// whether the role comes on the message's opening frame or on a chunk that carries its own.
    /// A replay names the person's messages by the ids they were sent under, their words joined
    /// across deltas, in the order said; the coworker's words are not them. A message opened and
    /// closed with no words is a message of files alone (opengrok-server#259), and it is kept, so
    /// its files have a bubble to be drawn under (#90).
    #[test]
    fn a_replay_names_the_persons_messages_by_the_ids_they_were_sent_under() {
        let events = [
            json!({"type":"RUN_STARTED","runId":"r1","threadId":"cw_1"}),
            json!({"type":"TEXT_MESSAGE_START","messageId":"u1","role":"user"}),
            json!({"type":"TEXT_MESSAGE_CONTENT","messageId":"u1","delta":"What is "}),
            json!({"type":"TEXT_MESSAGE_CONTENT","messageId":"u1","delta":"on today?"}),
            json!({"type":"TEXT_MESSAGE_END","messageId":"u1"}),
            json!({"type":"TEXT_MESSAGE_CHUNK","messageId":"u2","role":"user","delta":"And tomorrow?"}),
            json!({"type":"TEXT_MESSAGE_START","messageId":"m1","role":"assistant"}),
            json!({"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"Two meetings."}),
            json!({"type":"TEXT_MESSAGE_START","messageId":"u3","role":"user"}),
            json!({"type":"TEXT_MESSAGE_END","messageId":"u3"}),
        ];
        assert_eq!(
            persons_messages(&events),
            vec![
                ("u1".to_string(), "What is on today?".to_string()),
                ("u2".to_string(), "And tomorrow?".to_string()),
                ("u3".to_string(), String::new()),
            ]
        );
        // Opened and never closed, with no words: a message cut off, not a message.
        let cut = [json!({"type":"TEXT_MESSAGE_START","messageId":"u4","role":"user"})];
        assert!(persons_messages(&cut).is_empty());
    }

    #[test]
    fn the_persons_words_in_a_replay_are_not_the_coworkers_reply() {
        let mut turn = TurnAssembler::default();
        for event in [
            json!({"type":"RUN_STARTED","runId":"r1","threadId":"cw_1"}),
            json!({"type":"TEXT_MESSAGE_START","messageId":"m1","role":"user"}),
            json!({"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"What is on my calendar?"}),
            json!({"type":"TEXT_MESSAGE_END","messageId":"m1"}),
            json!({"type":"TEXT_MESSAGE_CHUNK","messageId":"m2","role":"user","delta":"And tomorrow?"}),
            json!({"type":"TEXT_MESSAGE_START","messageId":"msg_r1_1","role":"assistant"}),
            json!({"type":"TEXT_MESSAGE_CONTENT","messageId":"msg_r1_1","delta":"Two meetings today."}),
            json!({"type":"TEXT_MESSAGE_END","messageId":"msg_r1_1"}),
        ] {
            turn.push_event(&event);
        }
        turn.finish();
        let (plain, parts) = turn.snapshot();
        assert_eq!(plain, "Two meetings today.");
        assert_eq!(parts, vec![ChatPart::Text("Two meetings today.".into())]);
    }

    #[test]
    fn incomplete_ui_json_is_held_not_painted() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&text("See this {\"ui\":\"bar-chart\",\"bars\":["));
        let (plain, parts) = turn.snapshot();
        assert_eq!(plain, "");
        assert!(parts.is_empty());
    }

    /// A delta can end anywhere, including partway into an object's opening. Wherever the stream
    /// is cut, the chart still mounts and the words around it read the same as one delta would.
    #[test]
    fn a_ui_object_split_at_any_byte_still_mounts() {
        for whole in [
            "Here: {\"ui\":\"bar-chart\",\"title\":\"Q3\",\"bars\":[{\"label\":\"A\",\"value\":3}]} done",
            "Here: { \"component\":\"bar-chart\",\"title\":\"Q3\",\"bars\":[{\"label\":\"A\",\"value\":3}]} done",
        ] {
            let mut once = TurnAssembler::default();
            once.push_event(&text(whole));
            once.finish();
            let (expected, _) = once.snapshot();
            for cut in 0..=whole.len() {
                let mut turn = TurnAssembler::default();
                turn.push_event(&text(&whole[..cut]));
                turn.push_event(&text(&whole[cut..]));
                turn.finish();
                let (plain, parts) = turn.snapshot();
                let charts = parts
                    .iter()
                    .filter(|part| matches!(part, ChatPart::Ui(UiSpec::BarChart(_))))
                    .count();
                assert_eq!(charts, 1, "cut at {cut} of {whole:?}: {parts:?}");
                assert_eq!(plain, expected, "cut at {cut} of {whole:?}");
            }
        }
    }

    /// A `{` at the end of a delta is held only until it is clear it opens no object; words keep
    /// their braces, and one left dangling when the turn ends is still said.
    #[test]
    fn a_brace_that_opens_no_ui_is_still_words() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&text("use {"));
        turn.push_event(&text("braces} freely"));
        turn.finish();
        assert_eq!(turn.snapshot().0, "use {braces} freely");

        let mut turn = TurnAssembler::default();
        turn.push_event(&text("a dangling {"));
        turn.finish();
        assert_eq!(turn.snapshot().0, "a dangling {");
    }

    /// An object that never closes is held while the stream runs, and is words once it has ended,
    /// rather than vanishing with the turn.
    #[test]
    fn an_object_that_never_closes_is_words_when_the_turn_ends() {
        let unclosed = "See {\"ui\":\"bar-chart\",\"bars\":[";
        let mut turn = TurnAssembler::default();
        turn.push_event(&text(unclosed));
        assert_eq!(turn.snapshot().0, "");
        turn.finish();
        assert_eq!(turn.snapshot().0, unclosed);
    }

    #[test]
    fn a_ui_tool_in_flight_does_not_stream() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&json!({
            "type":"TOOL_CALL_START",
            "toolCallId":"c1",
            "toolCallName":"bar_chart"
        }));
        turn.push_event(&text("should not appear yet"));
        let (plain, parts) = turn.snapshot();
        assert_eq!(plain, "");
        assert!(parts.is_empty());
        turn.push_event(&json!({
            "type":"TOOL_CALL_ARGS",
            "toolCallId":"c1",
            "delta":"{\"title\":\"Q3\",\"bars\":[{\"label\":\"A\",\"value\":3}]}"
        }));
        turn.push_event(&json!({"type":"TOOL_CALL_END","toolCallId":"c1"}));
        let (_, parts) = turn.snapshot();
        assert!(matches!(parts.first(), Some(ChatPart::Text(t)) if t == "should not appear yet"));
        assert!(matches!(
            parts.get(1),
            Some(ChatPart::Ui(UiSpec::BarChart(_)))
        ));
        let done = turn.take_completed_ui_tools();
        assert_eq!(done.len(), 1);
        assert_eq!(done[0].id, "c1");
    }

    #[test]
    fn a_complete_bar_chart_object_mounts_without_waiting_for_later_text() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&text(
            "See this {\"ui\":\"bar-chart\",\"title\":\"Q3\",\"bars\":[{\"label\":\"A\",\"value\":10}]} and more",
        ));
        let (plain, parts) = turn.snapshot();
        assert_eq!(plain, "See this  and more");
        assert!(matches!(parts[0], ChatPart::Text(ref t) if t == "See this "));
        assert!(matches!(parts[1], ChatPart::Ui(UiSpec::BarChart(_))));
        assert!(matches!(parts[2], ChatPart::Text(ref t) if t == " and more"));
    }

    #[test]
    fn a_tool_call_chart_mounts_when_args_are_complete() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&text("Here:"));
        turn.push_event(&json!({
            "type":"TOOL_CALL_START",
            "toolCallId":"c1",
            "toolCallName":"bar_chart"
        }));
        turn.push_event(&json!({
            "type":"TOOL_CALL_ARGS",
            "toolCallId":"c1",
            "delta":"{\"title\":\"Q3\",\"bars\":[{\"label\":\"A\",\"value\":3}]}"
        }));
        let (_, mid) = turn.snapshot();
        assert!(mid.iter().all(|p| !matches!(p, ChatPart::Ui(_))));
        turn.push_event(&json!({"type":"TOOL_CALL_END","toolCallId":"c1"}));
        let (_, parts) = turn.snapshot();
        assert!(matches!(
            parts.last(),
            Some(ChatPart::Ui(UiSpec::BarChart(_)))
        ));
    }

    #[test]
    fn a_custom_form_event_mounts_as_a_widget() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&json!({
            "type":"CUSTOM",
            "name":"ui",
            "value":{
                "component":"form",
                "title":"Next",
                "fields":[{"id":"go","label":"Go","options":["Yes","No"]}],
                "submit":"Send"
            }
        }));
        let (_, parts) = turn.snapshot();
        assert!(matches!(parts.as_slice(), [ChatPart::Ui(UiSpec::Form(_))]));
    }

    #[test]
    fn curly_braces_in_prose_are_not_held() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&text("The set {a, b} is finite."));
        let (plain, _) = turn.snapshot();
        assert_eq!(plain, "The set {a, b} is finite.");
    }

    #[test]
    fn command_from_replay_reads_tool_args_and_custom() {
        let events = vec![
            json!({
                "type": "TOOL_CALL_ARGS",
                "toolCallId": "c1",
                "delta": "{\"command\":\"ls /Volumes/goldcoders\"}"
            }),
            json!({
                "type": "CUSTOM",
                "name": "run-awaiting-approval",
                "callId": "c1",
                "arguments": null
            }),
        ];
        assert_eq!(
            command_from_replay_events(&events, "c1"),
            "ls /Volumes/goldcoders"
        );
        let custom = vec![json!({
            "type": "CUSTOM",
            "name": "run-awaiting-approval",
            "callId": "c2",
            "arguments": {"command": "pwd"}
        })];
        assert_eq!(command_from_replay_events(&custom, "c2"), "pwd");
    }

    #[test]
    fn shell_args_fill_an_approval_card_command() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&json!({
            "type": "TOOL_CALL_START",
            "toolCallId": "call-9",
            "toolCallName": "user_machine_shell"
        }));
        turn.push_event(&json!({
            "type": "TOOL_CALL_ARGS",
            "toolCallId": "call-9",
            "delta": "{\"command\":\"ls /Volumes/goldcoders\"}"
        }));
        turn.push_event(&json!({
            "type": "CUSTOM",
            "name": "run-awaiting-approval",
            "runId": "run-1",
            "callId": "call-9",
            "tool": "user_machine_shell"
        }));
        let (_, parts) = turn.snapshot();
        match parts.as_slice() {
            [ChatPart::Approval(spec)] => {
                assert_eq!(spec.command, "ls /Volumes/goldcoders");
                assert_eq!(spec.run_id, "run-1");
            }
            other => panic!("expected approval with command, got {other:?}"),
        }
    }

    #[test]
    fn run_awaiting_approval_is_a_card_not_a_sentence() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&text("I'll check that path."));
        turn.push_event(&json!({
            "type": "CUSTOM",
            "name": "run-awaiting-approval",
            "runId": "run-1",
            "threadId": "t1",
            "callId": "call-9",
            "tool": "user_machine_shell",
            "arguments": {"command": "ls /Volumes/goldcoders/examples"},
            "reason": "exec-consent",
            "why": "your machine's owner must approve this command"
        }));
        let (plain, parts) = turn.snapshot();
        assert_eq!(plain, "I'll check that path.");
        assert!(turn.waiting_approval());
        match parts.as_slice() {
            [ChatPart::Text(text), ChatPart::Approval(spec)] => {
                assert_eq!(text, "I'll check that path.");
                assert_eq!(spec.run_id, "run-1");
                assert_eq!(spec.call_id, "call-9");
                assert_eq!(spec.tool, "user_machine_shell");
                assert_eq!(spec.command, "ls /Volumes/goldcoders/examples");
                assert_eq!(spec.reason, "exec-consent");
            }
            other => panic!("expected text + approval card, got {other:?}"),
        }
    }

    #[test]
    fn a_finished_run_is_no_longer_waiting() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&json!({
            "type": "CUSTOM",
            "name": "run-awaiting-approval",
            "runId": "run-1",
            "callId": "call-9",
            "tool": "user_machine_shell",
            "arguments": {"command": "ls"}
        }));
        assert!(turn.waiting_approval());
        turn.push_event(&json!({"type":"RUN_FINISHED"}));
        assert!(!turn.waiting_approval());
    }

    /// The frame as servers before opengrok-server #263 send it (opengrok-harness
    /// `projection.rs` `awaiting_approval`): the tool and its arguments, and no summary. The card
    /// says what the call would do all the same, in the server's card's words.
    #[test]
    fn a_card_says_what_the_call_would_do_from_the_frame_the_server_sends() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&json!({
            "type": "CUSTOM",
            "name": "run-awaiting-approval",
            "threadId": "cw_1",
            "runId": "run-1",
            "callId": "call-9",
            "tool": "computer",
            "arguments": {"action": "click", "coordinate": [120, 40]},
            "reason": "auto-review",
            "why": EGRESS_TUNNEL_ASK_REASON
        }));
        let (_, parts) = turn.snapshot();
        match parts.as_slice() {
            [ChatPart::Approval(spec)] => {
                assert!(spec.is_egress_tunnel());
                assert_eq!(spec.summary, "Click at (120, 40) on the agent's own screen");
            }
            other => panic!("expected one approval card, got {other:?}"),
        }

        // The same frame with its fields under `value`.
        let nested = approval_from_event(&json!({
            "value": {
                "runId": "run-1",
                "callId": "call-9",
                "tool": "open_url",
                "arguments": {"url": "https://example.com/inbox?token=s3cret#top"}
            }
        }))
        .unwrap();
        assert_eq!(
            nested.summary,
            "Open https://example.com/inbox in the agent's own browser"
        );
    }

    /// Each tool reads as it does on the server's card (opengrok-server `tests/unit/cards.rs`),
    /// and what that card keeps off, this one keeps off too: a typed key, a pressed key, a
    /// link's token, a recipe's values, and a plugin call's secrets and identity keys.
    #[test]
    fn the_summary_is_the_servers_sentence_for_each_tool() {
        let said = |tool: &str, arguments: Value| approval_summary(tool, &arguments);
        let screen = |arguments: Value| said("computer", arguments);
        assert_eq!(
            screen(
                json!({"to": [0, 0], "key": "", "text": "", "action": "screenshot",
                          "button": 1, "scroll": [0, 0], "coordinate": [0, 0]})
            ),
            "Take a screenshot of the agent's own screen"
        );
        assert_eq!(
            screen(json!({"action": "screenshot", "machine": "group"})),
            "Take a screenshot of the group's shared screen"
        );
        assert_eq!(
            screen(json!({"action": "right_click", "coordinate": [5, 6]})),
            "Right-click at (5, 6) on the agent's own screen"
        );
        assert_eq!(
            screen(json!({"action": "left_click_drag", "coordinate": [1, 2], "to": [30, 40]})),
            "Drag from (1, 2) to (30, 40) on the agent's own screen"
        );
        assert_eq!(
            screen(json!({"action": "scroll"})),
            "Scroll at (no position) on the agent's own screen"
        );
        assert_eq!(
            screen(json!({"action": "type", "text": "hello world"})),
            "Type \"hello world\" on the agent's own screen"
        );
        assert_eq!(
            screen(json!({"action": "key", "key": "Return"})),
            "Press Return on the agent's own screen"
        );
        assert_eq!(
            screen(json!({"action": "zoom", "coordinate": [1, 2]})),
            "Screen action \"zoom\" on the agent's own screen"
        );
        let key = format!("sk-live-{}", "a1".repeat(24));
        assert_eq!(
            screen(json!({"action": "type", "text": key})),
            "Type \"«redacted»\" on the agent's own screen"
        );
        assert_eq!(
            screen(json!({"action": "key", "key": key})),
            "Press «redacted» on the agent's own screen"
        );
        let long_token = "Z".repeat(30) + &"9".repeat(30);
        assert!(!screen(json!({"action": "type", "text": long_token})).contains("ZZZZ"));
        let typed = screen(json!({"action": "type", "text": "say x ".repeat(50)}));
        assert!(
            typed.contains("say x say x") && typed.contains('…'),
            "{typed}"
        );

        assert_eq!(
            said("read_file", json!({"path": "/etc/hosts"})),
            "Read /etc/hosts on the agent's own box"
        );
        assert_eq!(
            said(
                "write_file",
                json!({"path": "/etc/hosts", "content": "abc"})
            ),
            "Write 3 bytes to /etc/hosts on the agent's own box"
        );
        assert_eq!(
            said(
                "run_recipe",
                json!({"recipe": "Open Gmail", "values": {"password": "s3cret"}})
            ),
            "Play the recipe \"Open Gmail\" on the agent's own computer"
        );
        let plugin = said(
            "gmail.api.send",
            json!({"to": "a@example.com", "api_key": "s3cret", "coworkerId": "cw_1",
                   "auth": "Bearer s3cret"}),
        );
        assert!(
            plugin.starts_with("gmail.api.send — a plugin tool this agent wants to call, with {"),
            "{plugin}"
        );
        assert!(plugin.contains("a@example.com"), "{plugin}");
        assert!(!plugin.contains("s3cret"), "{plugin}");
        assert!(!plugin.contains("cw_1"), "{plugin}");
    }

    /// A shell's card shows its command, not a summary of it, and a call that came without its
    /// arguments has nothing to summarise: both cards read as they did.
    #[test]
    fn a_shell_or_a_call_without_arguments_has_no_summary() {
        let command = json!({"command": "ls"});
        assert_eq!(approval_summary(USER_MACHINE_SHELL, &command), "");
        assert_eq!(approval_summary("shell", &command), "");
        assert_eq!(approval_summary("computer", &Value::Null), "");

        let older = approval_from_event(&json!({
            "runId": "run-1",
            "callId": "call-9",
            "tool": "computer",
            "reason": "auto-review"
        }))
        .unwrap();
        assert_eq!(older.summary, "");
        assert_eq!(older.command, "");
    }

    fn ask(call_id: &str, command: &str) -> ChatPart {
        ChatPart::Approval(ApprovalSpec {
            run_id: "r".into(),
            thread_id: None,
            call_id: call_id.into(),
            tool: "user_machine_shell".into(),
            command: command.into(),
            why: String::new(),
            reason: "exec-consent".into(),
            summary: String::new(),
            output: None,
            ok: None,
        })
    }

    #[test]
    fn extra_open_approval_cards_are_dropped() {
        let parts = vec![
            ChatPart::Text("ok".into()),
            ask("old", "ls"),
            ask("new", "uname"),
        ];
        let open = HashSet::from(["old".to_string(), "new".to_string()]);
        let out = collapse_open_approvals(&parts, &open);
        assert_eq!(out.len(), 2);
        assert!(matches!(&out[0], ChatPart::Text(t) if t == "ok"));
        assert!(matches!(&out[1], ChatPart::Approval(s) if s.call_id == "new"));
    }

    #[test]
    fn a_refused_shell_result_is_not_a_permission_card() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&json!({
            "type": "TOOL_CALL_START",
            "toolCallId": "call_missing_args",
            "toolCallName": "user_machine_shell"
        }));
        turn.push_event(&json!({
            "type": "TOOL_CALL_END",
            "toolCallId": "call_missing_args"
        }));
        turn.push_event(&json!({
            "type": "TOOL_CALL_RESULT",
            "toolCallId": "call_missing_args",
            "ok": false,
            "content": "refused: bad arguments: missing field `command`"
        }));
        let (_, parts) = turn.snapshot();
        assert!(
            parts
                .iter()
                .all(|part| !matches!(part, ChatPart::Approval(_))),
            "a refusal is not a command to approve, got {parts:?}"
        );
        assert!(!turn.waiting_approval());
    }

    #[test]
    fn tool_result_stdout_lands_on_the_approval_card() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&json!({
            "type": "CUSTOM",
            "name": "run-awaiting-approval",
            "runId": "run-1",
            "callId": "call-9",
            "tool": "user_machine_shell",
            "arguments": {"command": "ls"}
        }));
        turn.push_event(&json!({
            "type": "TOOL_CALL_RESULT",
            "toolCallId": "call-9",
            "ok": true,
            "content": "exit 0\n--- stdout ---\nhello\n"
        }));
        let (_, parts) = turn.snapshot();
        match parts.as_slice() {
            [ChatPart::Approval(spec)] => {
                assert_eq!(spec.ok, Some(true));
                assert_eq!(
                    spec.output.as_deref(),
                    Some("exit 0\n--- stdout ---\nhello\n")
                );
            }
            other => panic!("expected approval with stdout, got {other:?}"),
        }
        assert!(!turn.waiting_approval());
    }

    #[test]
    fn local_exec_outcome_matches_grok_copy() {
        let here = "your computer";
        assert_eq!(
            local_exec_outcome("Hexuria", LocalExecResolution::AllowOnce, here),
            "Hexuria can run commands on your computer this time."
        );
        assert_eq!(
            local_exec_outcome("Hexuria", LocalExecResolution::Always, here),
            "Hexuria can run commands on your computer."
        );
        assert_eq!(
            local_exec_outcome("Hexuria", LocalExecResolution::DenyOnce, here),
            "Hexuria was not allowed to run commands on your computer."
        );
        assert_eq!(
            local_exec_outcome("Hexuria", LocalExecResolution::Never, here),
            "Hexuria cannot run commands on your computer."
        );
        assert_eq!(
            local_exec_outcome("Hexuria", LocalExecResolution::AllowOnce, "its computer"),
            "Hexuria can run commands on its computer this time."
        );
    }

    fn approval_for(tool: &str) -> ApprovalSpec {
        ApprovalSpec {
            run_id: "r1".into(),
            thread_id: None,
            call_id: "c1".into(),
            tool: tool.into(),
            command: "ls".into(),
            why: String::new(),
            reason: "exec-consent".into(),
            summary: String::new(),
            output: None,
            ok: None,
        }
    }

    #[test]
    fn only_the_local_shell_tool_runs_on_this_mac() {
        let local = approval_for(USER_MACHINE_SHELL);
        let boxed = approval_for("Shell");
        assert!(local.runs_on_this_mac());
        assert!(!boxed.runs_on_this_mac());
        assert_eq!(local.place(), "your computer");
        assert_eq!(boxed.place(), "its computer");
        let mut review = boxed.clone();
        review.reason = "auto-review".into();
        assert!(review.is_review_an_action());
        assert!(!local.is_review_an_action());
    }

    fn mcp_card() -> ApprovalSpec {
        let mut spec = approval_for("read_file");
        spec.thread_id = Some("mcp-cw_1".into());
        spec.reason = "policy-approval".into();
        spec
    }

    /// An MCP card is one call being let through, not a machine being let
    /// loose, and it says so where the card was.
    #[test]
    fn an_mcp_card_leaves_behind_what_was_actually_answered() {
        let spec = mcp_card();
        assert!(spec.is_mcp());
        assert_eq!(
            spec.outcome("Hexuria", LocalExecResolution::AllowOnce),
            "Hexuria may run read_file once."
        );
        assert_eq!(
            spec.outcome("Hexuria", LocalExecResolution::DenyOnce),
            "Hexuria was told no."
        );
        // The local shell keeps its own words: once for the call, and Always and Never for
        // the command on the card, never the whole Mac.
        let local = approval_for(USER_MACHINE_SHELL);
        assert!(!local.is_mcp());
        assert_eq!(
            local.outcome("Hexuria", LocalExecResolution::AllowOnce),
            "Hexuria can run commands on your computer this time."
        );
        assert_eq!(
            local.outcome("Hexuria", LocalExecResolution::DenyOnce),
            "Hexuria was not allowed to run commands on your computer."
        );
        assert_eq!(
            local.outcome("Hexuria", LocalExecResolution::Always),
            "Hexuria can run this command on your computer without asking."
        );
        assert_eq!(
            local.outcome("Hexuria", LocalExecResolution::Never),
            "Hexuria cannot run this command on your computer."
        );
    }

    /// Review chrome is Always allow, and Always keeps a standing answer. An
    /// MCP card has no such thing behind it, whatever word the door used for
    /// why it stopped the call.
    #[test]
    fn an_mcp_card_is_never_review_an_action() {
        let mut spec = mcp_card();
        spec.reason = "auto-review".into();
        assert!(!spec.is_review_an_action());

        let mut box_tool = approval_for("Shell");
        box_tool.reason = "auto-review".into();
        assert!(box_tool.is_review_an_action());
    }

    #[test]
    fn machine_policy_never_answers_for_a_box_tool() {
        let local = approval_for(USER_MACHINE_SHELL);
        let boxed = approval_for("Shell");
        assert_eq!(
            policy_answer(&local, Some(LocalExecMode::Always)),
            Some(LocalExecResolution::Always)
        );
        assert_eq!(
            policy_answer(&local, Some(LocalExecMode::Never)),
            Some(LocalExecResolution::Never)
        );
        assert_eq!(policy_answer(&local, Some(LocalExecMode::Ask)), None);
        assert_eq!(policy_answer(&local, None), None);
        assert_eq!(policy_answer(&boxed, Some(LocalExecMode::Always)), None);
        assert_eq!(policy_answer(&boxed, Some(LocalExecMode::Never)), None);
    }

    /// A 1x1 transparent PNG: enough bytes to be a picture, small enough to read.
    const TINY_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

    #[test]
    fn a_tool_result_with_a_picture_is_a_screenshot_row() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&json!({"type":"TEXT_MESSAGE_CONTENT","delta":"Looking."}));
        turn.push_event(&json!({
            "type": "TOOL_CALL_RESULT",
            "toolCallId": "c9",
            "content": "clicking at 10,10; screenshot of the 1280x800 screen attached",
            "ok": true,
            "image": {"mime": "image/png", "base64": TINY_PNG, "width": 1280, "height": 800}
        }));
        turn.finish();
        let (_, parts) = turn.snapshot();
        let shot = parts
            .iter()
            .find_map(|part| match part {
                ChatPart::Screenshot(spec) => Some(spec),
                _ => None,
            })
            .expect("a screenshot part");
        assert_eq!(shot.call_id, "c9");
        assert_eq!((shot.width, shot.height), (1280, 800));
        assert!(shot.caption.starts_with("clicking at 10,10"));
        assert!(!shot.image.bytes.is_empty());
        // Words before the picture stay words.
        assert!(matches!(parts.first(), Some(ChatPart::Text(text)) if text.contains("Looking.")));
    }

    #[test]
    fn success_tool_images_wait_until_turn_end() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&json!({"type":"TEXT_MESSAGE_CONTENT","delta":"Working."}));
        turn.push_event(&json!({
            "type": "TOOL_CALL_RESULT",
            "toolCallId": "c1",
            "content": "click 1",
            "ok": true,
            "image": {"mime": "image/png", "base64": TINY_PNG, "width": 1280, "height": 800}
        }));
        turn.push_event(&json!({
            "type": "TOOL_CALL_RESULT",
            "toolCallId": "c2",
            "content": "click 2",
            "ok": true,
            "image": {"mime": "image/png", "base64": TINY_PNG, "width": 640, "height": 480}
        }));
        let (_, mid) = turn.snapshot();
        assert!(
            !mid.iter()
                .any(|part| matches!(part, ChatPart::Screenshot(_))),
            "intermediate success PNGs are Computer-pane only: {mid:?}"
        );
        assert_eq!(
            turn.latest_screenshot().map(|s| s.call_id.as_str()),
            Some("c2")
        );
        turn.finish();
        let (_, parts) = turn.snapshot();
        let shots: Vec<_> = parts
            .iter()
            .filter_map(|part| match part {
                ChatPart::Screenshot(spec) => Some(spec.call_id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(
            shots,
            vec!["c2"],
            "turn end pins the last screen, not every step"
        );
    }

    #[test]
    fn a_failed_tool_image_is_a_screenshot_row() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&json!({
            "type": "TOOL_CALL_RESULT",
            "toolCallId": "c-fail",
            "content": "click missed",
            "ok": false,
            "image": {"mime": "image/png", "base64": TINY_PNG, "width": 10, "height": 10}
        }));
        let (_, parts) = turn.snapshot();
        match parts.as_slice() {
            [ChatPart::Screenshot(spec)] => assert_eq!(spec.call_id, "c-fail"),
            other => panic!("failure pins immediately, got {other:?}"),
        }
    }

    /// The giveaway of the bug the person reported: two things the coworker said either side of
    /// a picture were glued into "…using the taught recipe.YouTube is open…" the moment the turn
    /// was flattened to text. Deltas of one sentence still join with nothing between them.
    #[test]
    fn words_either_side_of_a_picture_are_two_paragraphs() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&json!({
            "type": "TEXT_MESSAGE_CONTENT", "delta": "I'll open YouTube on my box "
        }));
        turn.push_event(&json!({
            "type": "TEXT_MESSAGE_CONTENT", "delta": "using the taught recipe."
        }));
        turn.push_event(&json!({
            "type": "TOOL_CALL_RESULT",
            "toolCallId": "c1",
            "content": "ran recipe \"youtube\" (v2): 6 steps",
            "ok": true,
            "image": {"mime": "image/png", "base64": TINY_PNG, "width": 1280, "height": 800}
        }));
        turn.push_event(&json!({
            "type": "TEXT_MESSAGE_CONTENT", "delta": "YouTube is open on my box."
        }));
        turn.finish();
        let (plain, _) = turn.snapshot();
        assert_eq!(
            plain,
            "I'll open YouTube on my box using the taught recipe.\n\nYouTube is open on my box."
        );
    }

    #[test]
    fn a_result_without_a_png_is_not_a_screenshot() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&json!({
            "type": "TOOL_CALL_RESULT",
            "toolCallId": "c1",
            "content": "wrote /tmp/x",
            "ok": true,
            "image": {"mime": "image/jpeg", "base64": TINY_PNG, "width": 1, "height": 1}
        }));
        turn.finish();
        let (_, parts) = turn.snapshot();
        assert!(
            !parts
                .iter()
                .any(|part| matches!(part, ChatPart::Screenshot(_)))
        );
    }

    fn png_image(visibility: Option<&str>) -> Value {
        let mut image = json!({
            "mime": "image/png",
            "base64": TINY_PNG,
            "width": 1280,
            "height": 800
        });
        if let Some(visibility) = visibility {
            image["visibility"] = json!(visibility);
        }
        image
    }

    #[test]
    fn agent_visibility_stays_off_the_feed_and_on_the_computer_pane() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&json!({"type":"TEXT_MESSAGE_CONTENT","delta":"Working."}));
        turn.push_event(&json!({
            "type": "TOOL_CALL_RESULT",
            "toolCallId": "step-1",
            "content": "click 1",
            "ok": true,
            "image": png_image(Some("agent"))
        }));
        turn.push_event(&json!({
            "type": "TOOL_CALL_RESULT",
            "toolCallId": "step-2",
            "content": "click 2",
            "ok": true,
            "image": png_image(Some("agent"))
        }));
        let (_, mid) = turn.snapshot();
        assert!(
            !mid.iter()
                .any(|part| matches!(part, ChatPart::Screenshot(_))),
            "agent shots are Computer-pane only: {mid:?}"
        );
        assert_eq!(
            turn.latest_screenshot().map(|s| s.call_id.as_str()),
            Some("step-2")
        );
        assert_eq!(
            turn.latest_screenshot().and_then(|s| s.visibility),
            Some(ImageVisibility::Agent)
        );
        turn.finish();
        let (_, parts) = turn.snapshot();
        assert!(
            !parts
                .iter()
                .any(|part| matches!(part, ChatPart::Screenshot(_))),
            "finish must not pin agent: {parts:?}"
        );
    }

    #[test]
    fn transcript_failure_end_visibility_pin_immediately() {
        for (visibility, call_id) in [
            ("transcript", "observe"),
            ("failure", "stuck"),
            ("end", "turn-end"),
        ] {
            let mut turn = TurnAssembler::default();
            turn.push_event(&json!({
                "type": "TOOL_CALL_RESULT",
                "toolCallId": call_id,
                "content": visibility,
                "ok": true,
                "image": png_image(Some(visibility))
            }));
            let (_, parts) = turn.snapshot();
            match parts.as_slice() {
                [ChatPart::Screenshot(spec)] => {
                    assert_eq!(spec.call_id, call_id);
                    assert_eq!(
                        spec.visibility,
                        ImageVisibility::parse(visibility),
                        "{visibility}"
                    );
                }
                other => panic!("{visibility} should pin before finish, got {other:?}"),
            }
        }
    }

    #[test]
    fn journalled_agent_frame_without_bytes_is_not_a_chat_row() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&json!({
            "type": "TOOL_CALL_RESULT",
            "toolCallId": "step-1",
            "content": "click",
            "ok": true,
            "image": {
                "mime": "image/png",
                "width": 1280,
                "height": 800,
                "visibility": "agent"
            }
        }));
        turn.finish();
        let (_, parts) = turn.snapshot();
        assert!(
            !parts
                .iter()
                .any(|part| matches!(part, ChatPart::Screenshot(_)))
        );
        assert!(turn.latest_screenshot().is_none());
    }

    fn user_form_custom(entry: &str, request: Value, resolution: Value) -> Value {
        json!({
            "type": "CUSTOM",
            "name": "user-form",
            "value": {
                "entryId": entry,
                "formRequest": request,
                "formResolution": resolution
            }
        })
    }

    fn password_request() -> Value {
        json!({
            "title": "Google password",
            "instruction": "Enter the password for that account.",
            "fields": [
                {
                    "id": "password",
                    "label": "Password",
                    "type": "password",
                    "required": true,
                    "value": "s3cret-pass"
                }
            ]
        })
    }

    #[test]
    fn a_user_form_custom_is_not_a_generative_form() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&user_form_custom(
            "entry-pw",
            password_request(),
            Value::Null,
        ));
        let (plain, parts) = turn.snapshot();
        assert_eq!(plain, "", "field values must not become chat text");
        match parts.as_slice() {
            [ChatPart::UserForm(spec)] => {
                assert_eq!(spec.title, "Google password");
                assert!(spec.fields[0].masked());
                assert!(spec.fields[0].prefill.is_none());
                assert!(spec.is_unresolved());
            }
            other => panic!("expected UserForm, got {other:?}"),
        }
        assert!(
            parts.iter().all(|part| !matches!(part, ChatPart::Ui(_))),
            "user-form must not mount as UiSpec::Form: {parts:?}"
        );
        let dump = format!("{parts:?}");
        assert!(
            !dump.contains("s3cret-pass"),
            "password must not appear in the assembler snapshot: {dump}"
        );
        assert!(turn.waiting_user_form());
        assert!(!turn.waiting_approval());
    }

    #[test]
    fn form_resolution_settles_the_same_entry() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&user_form_custom(
            "entry-pw",
            password_request(),
            Value::Null,
        ));
        turn.push_event(&json!({
            "type": "CUSTOM",
            "name": "user-form",
            "value": { "entryId": "entry-pw", "formResolution": "fill_failed" }
        }));
        let (plain, parts) = turn.snapshot();
        assert_eq!(plain, "");
        match parts.as_slice() {
            [ChatPart::UserForm(spec)] => {
                assert_eq!(spec.pill(), Some("Not filled"));
                assert!(!spec.is_unresolved());
            }
            other => panic!("expected one settled card, got {other:?}"),
        }
        assert!(!turn.waiting_user_form());
    }

    #[test]
    fn request_user_form_tool_mounts_as_user_form() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&json!({
            "type": "TOOL_CALL_START",
            "toolCallId": "c-form",
            "toolCallName": "request_user_form"
        }));
        turn.push_event(&json!({
            "type": "TOOL_CALL_ARGS",
            "toolCallId": "c-form",
            "delta": "{\"formRequest\":{\"title\":\"Code\",\"fields\":[{\"id\":\"otp\",\"label\":\"Code\",\"type\":\"otp\",\"required\":true,\"value\":\"654321\"}]}}"
        }));
        turn.push_event(&json!({"type":"TOOL_CALL_END","toolCallId":"c-form"}));
        let (plain, parts) = turn.snapshot();
        assert_eq!(plain, "");
        match parts.as_slice() {
            [ChatPart::UserForm(spec)] => {
                assert_eq!(spec.fields[0].kind, crate::opengrok::UserFormFieldKind::Otp);
                assert!(spec.fields[0].prefill.is_none());
            }
            other => panic!("expected UserForm from tool, got {other:?}"),
        }
        let dump = format!("{parts:?}");
        assert!(
            !dump.contains("654321"),
            "otp must not appear in snapshot: {dump}"
        );
    }

    #[test]
    fn a_custom_form_event_is_still_generative_ui() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&json!({
            "type":"CUSTOM",
            "name":"ui",
            "value":{
                "component":"form",
                "title":"Next",
                "fields":[{"id":"go","label":"Go","options":["Yes","No"]}],
                "submit":"Send"
            }
        }));
        let (_, parts) = turn.snapshot();
        assert!(matches!(parts.as_slice(), [ChatPart::Ui(UiSpec::Form(_))]));
        assert!(!turn.waiting_user_form());
    }

    #[test]
    fn user_form_does_not_use_formspec_submit_copy() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&user_form_custom(
            "e1",
            json!({
                "title": "Email",
                "fields": [{"id":"email","label":"Email","type":"email","required":true}]
            }),
            Value::Null,
        ));
        let (_, parts) = turn.snapshot();
        let dump = format!("{parts:?}");
        assert!(
            !dump.contains("Fill in the required field to continue"),
            "must not steal plugin-setup copy: {dump}"
        );
        assert!(!matches!(parts.as_slice(), [ChatPart::Ui(UiSpec::Form(_))]));
    }

    #[test]
    fn a_form_named_custom_is_still_generative_choice_chips() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&json!({
            "type":"CUSTOM",
            "name":"form",
            "value":{
                "title":"Next",
                "fields":[{"id":"go","label":"Go","options":["Yes","No"]}],
                "submit":"Send"
            }
        }));
        let (_, parts) = turn.snapshot();
        match parts.as_slice() {
            [ChatPart::Ui(UiSpec::Form(spec))] => {
                assert_eq!(spec.title.as_deref(), Some("Next"));
                assert_eq!(spec.fields[0].options, vec!["Yes", "No"]);
            }
            other => panic!("expected FormSpec, got {other:?}"),
        }
        assert!(!turn.waiting_user_form());
    }

    #[test]
    fn official_send_message_envelope_mounts_as_user_form() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&json!({
            "type": "CUSTOM",
            "name": "user-form",
            "value": {
                "kind": "send-message",
                "id": "entry-email",
                "message": {
                    "type": "user-form",
                    "formRequest": {
                        "title": "Google account email",
                        "instruction": "Enter the other Gmail address you want to sign in with.",
                        "fields": [
                            {"id": "email", "label": "Email or phone", "type": "email", "required": true}
                        ],
                        "domain": "accounts.google.com",
                        "liveHost": "accounts.google.com"
                    }
                },
                "formResolution": null
            }
        }));
        let (plain, parts) = turn.snapshot();
        assert_eq!(plain, "");
        match parts.as_slice() {
            [ChatPart::UserForm(spec)] => {
                assert_eq!(spec.entry_id, "entry-email");
                assert_eq!(spec.title, "Google account email");
                assert!(spec.is_unresolved());
            }
            other => panic!("expected UserForm from official envelope, got {other:?}"),
        }
    }

    /// #139: a card settled after its run stopped waiting gets no settled `user-form` frame of
    /// its own (the server journals none onto a run that no longer waits). On replay the server
    /// folds the settled entry onto the card's own frame instead (`hydrate_agui_events` /
    /// `overlay_form` in opengrok-server `agui/user_form.rs`): `formResolution` beside the
    /// arguments, and the whole entry, `widgetDismissed` too, in `value`. The card must be
    /// drawn settled from that frame alone, not asked again.
    #[test]
    fn a_replayed_card_settled_on_its_own_frame_is_not_asked_again() {
        let frame = |resolution: Value, entry: Value| {
            json!({
                "type": "CUSTOM",
                "name": "run-awaiting-approval",
                "runId": "run-1",
                "callId": "call-9",
                "tool": "request_user_form",
                "reason": "user-form",
                "why": "Waiting for you",
                "entryId": "entry-1",
                "arguments": {
                    "title": "Google account email",
                    "fields": [{"id": "email", "label": "Email", "type": "email", "required": true}]
                },
                "formResolution": resolution,
                "value": entry
            })
        };
        let submitted = frame(
            json!("submitted"),
            json!({"id": "entry-1", "callId": "call-9", "formResolution": "submitted"}),
        );
        // Closed without an answer: no resolution word, only the entry's dismissal.
        let dismissed = frame(
            Value::Null,
            json!({"id": "entry-1", "callId": "call-9", "widgetDismissed": true}),
        );
        for (event, settled) in [
            (submitted, Some(crate::opengrok::FormResolution::Submitted)),
            (dismissed, Some(crate::opengrok::FormResolution::Dismissed)),
        ] {
            let mut turn = TurnAssembler::default();
            turn.push_event(&event);
            let (_, parts) = turn.snapshot();
            match parts.as_slice() {
                [ChatPart::UserForm(spec)] => {
                    assert_eq!(spec.title, "Google account email", "still the card it was");
                    assert!(!spec.is_unresolved(), "settled on its frame: {spec:?}");
                    assert_eq!(spec.effective_resolution(), settled);
                }
                other => panic!("expected the card, got {other:?}"),
            }
            assert!(!turn.waiting_user_form(), "nothing is being asked");
            assert_eq!(
                crate::opengrok::activity_from_agui(&event, None),
                crate::opengrok::ActivityTick::Clear,
                "an answered card is not waiting on anyone"
            );
        }

        // Escalated to the computer: the escalation wins over a dismissal beside it, whether
        // both are on the entry or split between the frame and the entry. The form stays in
        // place and the computer is what now needs the person.
        let escalated_entry = frame(
            json!("escalated"),
            json!({"id": "entry-1", "callId": "call-9", "formResolution": "escalated",
                   "widgetDismissed": true}),
        );
        let split = frame(
            json!("escalated"),
            json!({"id": "entry-1", "callId": "call-9", "widgetDismissed": true}),
        );
        // A fallback parse that took a dismissal off the frame does not outvote the escalation.
        let mut fallback = frame(
            Value::Null,
            json!({"id": "entry-1", "callId": "call-9", "formResolution": "escalated"}),
        );
        fallback["widgetDismissed"] = json!(true);
        for event in [escalated_entry, split, fallback] {
            let mut turn = TurnAssembler::default();
            turn.push_event(&event);
            let (_, parts) = turn.snapshot();
            match parts.as_slice() {
                [ChatPart::UserForm(spec)] => {
                    assert!(spec.is_unresolved(), "escalated is not settled: {spec:?}");
                    assert_eq!(
                        spec.computer_handoff,
                        Some(crate::opengrok::ComputerHandoffStatus::ActionNeeded)
                    );
                }
                other => panic!("expected the card, got {other:?}"),
            }
            assert!(turn.waiting_user_form());
        }
    }

    /// #143: once the person hands the computer back (or declines, or it times out), the server
    /// stamps the escalated form's entry with the box's own `boxResolution`, and a replay carries
    /// it on the form's frames. The form is then settled the way the live answer paints it, and
    /// nothing is waiting: before, a replay showed "Action needed" for ever and parked the
    /// finished run. A word this app does not know still ends the handoff.
    #[test]
    fn a_replayed_escalation_that_was_handed_back_is_settled() {
        use crate::opengrok::{ComputerHandoffStatus, FormResolution};
        let park = |entry: Value| {
            json!({
                "type": "CUSTOM", "name": "run-awaiting-approval", "reason": "user-form",
                "tool": "request_user_form", "runId": "run-1", "callId": "call-9",
                "entryId": "entry-1",
                "arguments": {"title": "Google account",
                    "fields": [{"id": "email", "label": "Email", "type": "email"}]},
                "formResolution": "escalated",
                "boxResolution": entry.get("boxResolution").cloned().unwrap_or(Value::Null),
                "value": entry,
            })
        };
        let form_frame = |entry: Value| {
            json!({
                "type": "CUSTOM", "name": "user-form", "runId": "run-1", "callId": "call-9",
                "entryId": "entry-1", "value": entry,
            })
        };
        let entry = |word: Option<&str>| {
            let mut entry = json!({
                "id": "entry-1", "callId": "call-9", "formResolution": "escalated",
                "widgetDismissed": true,
                "message": {"type": "user-form", "formRequest": {"title": "Google account",
                    "fields": [{"id": "email", "label": "Email", "type": "email"}]}},
            });
            if let Some(word) = word {
                entry["boxResolution"] = json!(word);
            }
            entry
        };
        for (word, form, computer) in [
            (
                "handed_back",
                FormResolution::Dismissed,
                ComputerHandoffStatus::Done,
            ),
            (
                "timed_out",
                FormResolution::Skipped,
                ComputerHandoffStatus::Skipped,
            ),
            (
                "declined",
                FormResolution::Skipped,
                ComputerHandoffStatus::Skipped,
            ),
            (
                "a_word_from_later",
                FormResolution::Dismissed,
                ComputerHandoffStatus::Skipped,
            ),
        ] {
            for frame in [park(entry(Some(word))), form_frame(entry(Some(word)))] {
                let mut turn = TurnAssembler::default();
                turn.push_event(&frame);
                let (_, parts) = turn.snapshot();
                match parts.as_slice() {
                    [ChatPart::UserForm(spec)] => {
                        assert_eq!(spec.effective_resolution(), Some(form), "{word}: {spec:?}");
                        assert_eq!(spec.computer_handoff, Some(computer), "{word}");
                    }
                    other => panic!("{word}: expected the card, got {other:?}"),
                }
                assert!(!turn.waiting_user_form(), "{word}: nothing is waiting");
            }
        }
        // No word yet: the handoff is still live, and the person is still asked.
        for frame in [park(entry(None)), form_frame(entry(None))] {
            let mut turn = TurnAssembler::default();
            turn.push_event(&frame);
            let (_, parts) = turn.snapshot();
            assert!(matches!(
                parts.as_slice(),
                [ChatPart::UserForm(spec)]
                    if spec.computer_handoff == Some(ComputerHandoffStatus::ActionNeeded)
            ));
            assert!(turn.waiting_user_form());
        }
    }

    #[test]
    fn live_awaiting_user_form_is_not_an_approval_card() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&json!({
            "type": "CUSTOM",
            "name": "run-awaiting-approval",
            "runId": "run-1",
            "callId": "call-9",
            "tool": "request_user_form",
            "reason": "user-form",
            "why": "Waiting for you",
            "arguments": {
                "title": "Google account email",
                "fields": [
                    {"id": "email", "label": "Email", "type": "email", "required": true},
                    {"id": "password", "label": "Password", "type": "password", "required": true, "value": "s3cret-pass"}
                ],
                "liveHost": "accounts.google.com"
            }
        }));
        let (plain, parts) = turn.snapshot();
        assert_eq!(plain, "", "field values must not become chat text");
        match parts.as_slice() {
            [ChatPart::UserForm(spec)] => {
                assert_eq!(spec.title, "Google account email");
                assert_eq!(spec.call_id, "call-9");
                assert_eq!(spec.run_id, "run-1");
                assert!(
                    spec.entry_id.is_empty(),
                    "AG-UI callId is not the gateway entryId: {}",
                    spec.entry_id
                );
                assert!(!spec.has_gateway_entry_id());
                assert!(spec.fields.iter().any(|f| f.masked()));
                assert!(spec.is_unresolved());
            }
            other => panic!("expected UserForm from awaiting, got {other:?}"),
        }
        assert!(turn.waiting_user_form());
        assert!(
            !turn.waiting_approval(),
            "user-form HITL is not a permission card"
        );
        let dump = format!("{parts:?}");
        assert!(
            !dump.contains("s3cret-pass"),
            "password must not appear in the assembler snapshot: {dump}"
        );
        assert!(
            parts
                .iter()
                .all(|part| !matches!(part, ChatPart::Approval(_))),
            "must not mount as Approval: {parts:?}"
        );
        assert!(
            parts.iter().all(|part| !matches!(part, ChatPart::Ui(_))),
            "must not mount as UiSpec::Form: {parts:?}"
        );
    }

    #[test]
    fn awaiting_with_entry_id_keeps_the_gateway_card_id() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&json!({
            "type": "CUSTOM",
            "name": "run-awaiting-approval",
            "runId": "run-1",
            "callId": "call-9",
            "entryId": "e_form",
            "tool": "request_user_form",
            "reason": "user-form",
            "arguments": {
                "title": "Sign in",
                "fields": [{"id": "email", "label": "Email", "type": "email", "required": true}]
            }
        }));
        let (_, parts) = turn.snapshot();
        match parts.as_slice() {
            [ChatPart::UserForm(spec)] => {
                assert_eq!(spec.entry_id, "e_form");
                assert_eq!(spec.call_id, "call-9");
                assert!(spec.has_gateway_entry_id());
            }
            other => panic!("expected UserForm with gateway id, got {other:?}"),
        }
    }

    #[test]
    fn d12fffc_custom_entry_id_is_not_call_id() {
        let schema = json!({
            "title": "Google account",
            "instruction": "Enter the address and password.",
            "liveHost": "accounts.google.com",
            "fields": [
                {"id": "email", "label": "Email", "type": "email", "required": true, "secret": false},
                {"id": "password", "label": "Password", "type": "password", "required": true, "secret": false, "value": "s3cret-pass"}
            ]
        });
        let mut turn = TurnAssembler::default();
        turn.push_event(&json!({
            "type": "CUSTOM",
            "name": "run-awaiting-approval",
            "threadId": "thr-1",
            "runId": "run-1",
            "callId": "mock-form-1",
            "tool": "request_user_form",
            "reason": "user-form",
            "why": "Waiting for you",
            "entryId": "e_form",
            "arguments": schema.clone(),
            "formRequest": schema
        }));
        let (plain, parts) = turn.snapshot();
        assert_eq!(plain, "", "field values must not become chat text");
        match parts.as_slice() {
            [ChatPart::UserForm(spec)] => {
                assert_eq!(spec.entry_id, "e_form");
                assert_eq!(spec.call_id, "mock-form-1");
                assert_ne!(spec.entry_id, spec.call_id);
                assert!(spec.has_gateway_entry_id());
                assert!(spec.can_post(true));
                assert!(spec.fields.iter().any(|f| f.masked()));
                assert!(spec.fields.iter().all(|f| f.prefill.is_none()));
            }
            other => panic!("expected UserForm from d12fffc CUSTOM, got {other:?}"),
        }
        assert!(turn.waiting_user_form());
        assert!(!turn.waiting_approval());
        let dump = format!("{parts:?}");
        assert!(!dump.contains("s3cret-pass"), "{dump}");
        assert!(
            parts
                .iter()
                .all(|part| !matches!(part, ChatPart::Approval(_) | ChatPart::Ui(_))),
            "must not mount as Approval or FormSpec: {parts:?}"
        );
    }

    #[test]
    fn send_message_envelope_folds_onto_the_awaiting_card() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&json!({
            "type": "CUSTOM",
            "name": "run-awaiting-approval",
            "runId": "run-1",
            "callId": "call-9",
            "tool": "request_user_form",
            "reason": "user-form",
            "arguments": {
                "title": "Sign in",
                "fields": [
                    {"id": "email", "label": "Email", "type": "email", "required": true},
                    {"id": "password", "label": "Password", "type": "password", "required": true}
                ]
            }
        }));
        turn.push_event(&json!({
            "type": "CUSTOM",
            "name": "user-form",
            "value": {
                "kind": "send-message",
                "id": "e_form",
                "message": {
                    "type": "user-form",
                    "formRequest": {
                        "title": "Sign in",
                        "fields": [{"id": "email", "label": "Email", "type": "email", "required": true}]
                    }
                },
                "formResolution": null
            }
        }));
        let (_, parts) = turn.snapshot();
        match parts.as_slice() {
            [ChatPart::UserForm(spec)] => {
                assert_eq!(spec.entry_id, "e_form");
                assert_eq!(spec.call_id, "call-9");
                assert!(spec.has_gateway_entry_id());
                assert!(spec.fields.iter().any(|f| f.masked()));
            }
            other => panic!("expected one merged card, got {other:?}"),
        }
    }

    #[test]
    fn a_second_otp_form_mounts_after_password_submitted() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&json!({
            "type": "CUSTOM",
            "name": "run-awaiting-approval",
            "runId": "run-1",
            "callId": "call-pw",
            "entryId": "e_pw",
            "tool": "request_user_form",
            "reason": "user-form",
            "arguments": {
                "title": "Google password",
                "fields": [{"id": "password", "label": "Password", "type": "password", "required": true}]
            }
        }));
        turn.push_event(&json!({
            "type": "CUSTOM",
            "name": "user-form",
            "value": { "entryId": "e_pw", "formResolution": "submitted" }
        }));
        turn.push_event(&json!({
            "type": "CUSTOM",
            "name": "run-awaiting-approval",
            "runId": "run-1",
            "callId": "call-otp",
            "entryId": "e_otp",
            "tool": "request_user_form",
            "reason": "user-form",
            "arguments": {
                "title": "Enter the code",
                "fields": [{"id": "otp", "label": "Code", "type": "otp", "required": true}]
            }
        }));
        let (_, parts) = turn.snapshot();
        match parts.as_slice() {
            [ChatPart::UserForm(password), ChatPart::UserForm(otp)] => {
                assert_eq!(password.entry_id, "e_pw");
                assert_eq!(
                    password.effective_resolution(),
                    Some(crate::opengrok::FormResolution::Submitted)
                );
                assert_eq!(otp.entry_id, "e_otp");
                assert!(otp.is_unresolved());
                assert_eq!(otp.fields[0].kind, crate::opengrok::UserFormFieldKind::Otp);
            }
            other => panic!("expected password Submitted then OTP idle, got {other:?}"),
        }
        assert!(turn.waiting_user_form());
    }

    #[test]
    fn a_second_otp_form_is_not_folded_onto_an_open_password_card() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&json!({
            "type": "CUSTOM",
            "name": "run-awaiting-approval",
            "runId": "run-1",
            "callId": "call-pw",
            "entryId": "e_pw",
            "tool": "request_user_form",
            "reason": "user-form",
            "arguments": {
                "title": "Google password",
                "fields": [{"id": "password", "label": "Password", "type": "password", "required": true}]
            }
        }));
        turn.push_event(&json!({
            "type": "CUSTOM",
            "name": "run-awaiting-approval",
            "runId": "run-1",
            "callId": "call-otp",
            "entryId": "e_otp",
            "tool": "request_user_form",
            "reason": "user-form",
            "arguments": {
                "title": "Enter the code",
                "fields": [{"id": "otp", "label": "Code", "type": "otp", "required": true}]
            }
        }));
        let (_, parts) = turn.snapshot();
        match parts.as_slice() {
            [ChatPart::UserForm(password), ChatPart::UserForm(otp)] => {
                assert_eq!(password.entry_id, "e_pw");
                assert!(password.is_unresolved());
                assert!(
                    password.can_post(false),
                    "stamped sibling must stay Continue-able; merge must not steal its entryId"
                );
                assert_eq!(otp.entry_id, "e_otp");
                assert!(otp.is_unresolved());
                assert!(otp.can_post(true));
                assert!(
                    otp.can_post(false),
                    "server_fill on another card must not gray this one"
                );
            }
            other => panic!("expected two cards, got {other:?}"),
        }
    }

    #[test]
    fn credential_offer_save_is_a_protocol_part_without_a_password() {
        let mut assembler = TurnAssembler::default();
        assembler.push_event(&json!({
            "type": "CUSTOM",
            "name": "credential.offer_save",
            "value": {
                "origin": "google.com",
                "username": "ada@example.com",
                "formEntryId": "e_form",
                "password": "s3cret-pass"
            }
        }));
        let (_, parts) = assembler.snapshot();
        match parts.as_slice() {
            [ChatPart::SaveLogin(offer)] => {
                assert_eq!(offer.origin, "google.com");
                assert_eq!(offer.username, "ada@example.com");
            }
            other => panic!("expected the save offer, got {other:?}"),
        }
        let dump = format!("{parts:?}");
        assert!(!dump.contains("s3cret-pass"));
    }

    #[test]
    fn settled_send_message_form_resolution_folds_onto_awaiting() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&json!({
            "type": "CUSTOM",
            "name": "run-awaiting-approval",
            "runId": "run-1",
            "callId": "call-9",
            "entryId": "e_form",
            "tool": "request_user_form",
            "reason": "user-form",
            "arguments": {
                "title": "Sign in",
                "fields": [
                    {"id": "email", "label": "Email", "type": "email", "required": true},
                    {"id": "password", "label": "Password", "type": "password", "required": true, "value": "s3cret-pass"}
                ]
            }
        }));
        turn.push_event(&json!({
            "type": "CUSTOM",
            "name": "user-form",
            "value": {
                "kind": "send-message",
                "id": "e_form",
                "message": {
                    "type": "user-form",
                    "formRequest": {
                        "title": "Sign in",
                        "fields": [{"id": "email", "label": "Email", "type": "email", "required": true}]
                    }
                },
                "formResolution": "submitted"
            }
        }));
        let (_, parts) = turn.snapshot();
        match parts.as_slice() {
            [ChatPart::UserForm(spec)] => {
                assert_eq!(spec.entry_id, "e_form");
                assert_eq!(spec.call_id, "call-9");
                assert_eq!(
                    spec.effective_resolution(),
                    Some(crate::opengrok::FormResolution::Submitted)
                );
                assert!(!spec.is_unresolved());
            }
            other => panic!("expected one settled card, got {other:?}"),
        }
        let dump = format!("{parts:?}");
        assert!(!dump.contains("s3cret-pass"));
    }

    fn form_label_card() -> ChatPart {
        ChatPart::UserForm(
            UserFormSpec::parse(
                &json!({
                    "entryId": "e_form",
                    "formRequest": {
                        "title": "Form Label",
                        "instruction": "I'll raise a single in-chat form.",
                        "fields": [{"id": "email", "label": "Email", "type": "email", "required": true}]
                    }
                }),
                None,
            )
            .unwrap(),
        )
    }

    fn dummy_shot(call_id: &str) -> ChatPart {
        ChatPart::Screenshot(ScreenshotSpec {
            call_id: call_id.into(),
            caption: "screenshot".into(),
            image: std::sync::Arc::new(gpui_kit::Image::from_bytes(
                gpui_kit::ImageFormat::Png,
                vec![0],
            )),
            width: 1280,
            height: 800,
            visibility: Some(ImageVisibility::Transcript),
        })
    }

    #[test]
    fn place_hitl_puts_the_open_form_where_dismissed_ends_up() {
        let mut live = vec![
            ChatPart::Text("I'll raise a single in-chat form…".into()),
            dummy_shot("obs-1"),
            ChatPart::Text("more.".into()),
            form_label_card(),
        ];
        place_hitl_cards_in_document_order(&mut live);
        match live.as_slice() {
            [
                ChatPart::Text(intro),
                ChatPart::UserForm(spec),
                ChatPart::Screenshot(_),
                ChatPart::Text(after),
            ] => {
                assert!(intro.contains("in-chat form"));
                assert_eq!(spec.title, "Form Label");
                assert!(spec.is_unresolved());
                assert_eq!(after, "more.");
            }
            other => panic!("open form must sit above the screenshot block, got {other:?}"),
        }
        let mut settled = live.clone();
        if let ChatPart::UserForm(spec) = &mut settled[1] {
            spec.resolution = Some(crate::opengrok::FormResolution::Dismissed);
        }
        place_hitl_cards_in_document_order(&mut settled);
        assert_eq!(
            live.iter().map(std::mem::discriminant).collect::<Vec<_>>(),
            settled
                .iter()
                .map(std::mem::discriminant)
                .collect::<Vec<_>>(),
            "settle must not move the card"
        );
    }

    #[test]
    fn live_awaiting_form_is_not_appended_under_the_screenshot_block() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&json!({
            "type": "TEXT_MESSAGE_CONTENT",
            "delta": "I'll raise a single in-chat form…"
        }));
        turn.push_event(&json!({
            "type": "TOOL_CALL_RESULT",
            "toolCallId": "obs-1",
            "content": "observe",
            "ok": true,
            "image": png_image(Some("transcript"))
        }));
        turn.push_event(&json!({
            "type": "TEXT_MESSAGE_CONTENT",
            "delta": "Working on the page."
        }));
        turn.push_event(&json!({
            "type": "CUSTOM",
            "name": "run-awaiting-approval",
            "runId": "run-1",
            "callId": "call-9",
            "entryId": "e_form",
            "tool": "request_user_form",
            "reason": "user-form",
            "arguments": {
                "title": "Form Label",
                "fields": [{"id": "email", "label": "Email", "type": "email", "required": true}]
            }
        }));
        let (_, open) = turn.snapshot();
        match open.as_slice() {
            [
                ChatPart::Text(_),
                ChatPart::UserForm(spec),
                ChatPart::Screenshot(_),
                ChatPart::Text(_),
            ] => {
                assert_eq!(spec.title, "Form Label");
                assert!(spec.is_unresolved());
            }
            other => {
                panic!("PASS: open Form Label already sits where Dismissed ends up; got {other:?}")
            }
        }
        turn.push_event(&json!({
            "type": "CUSTOM",
            "name": "user-form",
            "value": {
                "kind": "send-message",
                "id": "e_form",
                "message": {
                    "type": "user-form",
                    "formRequest": { "title": "Form Label" }
                },
                "formResolution": "dismissed"
            }
        }));
        let (_, settled) = turn.snapshot();
        match settled.as_slice() {
            [
                ChatPart::Text(_),
                ChatPart::UserForm(spec),
                ChatPart::Screenshot(_),
                ChatPart::Text(_),
            ] => {
                assert_eq!(
                    spec.effective_resolution(),
                    Some(crate::opengrok::FormResolution::Dismissed)
                );
            }
            other => panic!("Dismissed must stay in the same slot, got {other:?}"),
        }
    }

    #[test]
    fn computer_handoff_custom_paints_an_escalated_form() {
        let mut turn = TurnAssembler::default();
        turn.push_event(&json!({
            "type": "CUSTOM",
            "name": "computer-handoff-card",
            "value": {
                "entryId": "e_form",
                "boxRequestId": "box-9",
                "boxInstruction": "Sign in on the computer."
            }
        }));
        let (_, parts) = turn.snapshot();
        match parts.as_slice() {
            [ChatPart::UserForm(spec)] => {
                assert!(spec.shows_computer_handoff());
                assert_eq!(spec.handoff_prompt(), "Sign in on the computer.");
            }
            other => panic!("expected Computer handoff card, got {other:?}"),
        }
    }

    fn assembled(events: &[Value]) -> TurnAssembler {
        let mut turn = TurnAssembler::default();
        for event in events {
            turn.push_event(event);
        }
        turn
    }

    fn steps_in(parts: &[ChatPart]) -> Vec<&StepSpec> {
        parts
            .iter()
            .filter_map(|part| match part {
                ChatPart::Step(step) => Some(step),
                _ => None,
            })
            .collect()
    }

    /// A tool call is a step of the reply, drawn where it was made: after the words the
    /// coworker said before it and before the words it said after, with how it came out once
    /// its result is in. Its arguments arrive in pieces and are kept whole.
    #[test]
    fn a_tool_call_is_a_step_between_the_words_around_it() {
        let mut turn = assembled(&[
            json!({"type":"TEXT_MESSAGE_START","messageId":"m1","role":"assistant"}),
            json!({"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"Let me run the tests."}),
            json!({"type":"TEXT_MESSAGE_END","messageId":"m1"}),
            json!({"type":"TOOL_CALL_START","toolCallId":"c1","toolCallName":"shell"}),
            json!({"type":"TOOL_CALL_ARGS","toolCallId":"c1","delta":"{\"command\":"}),
            json!({"type":"TOOL_CALL_ARGS","toolCallId":"c1","delta":"\"cargo test\"}"}),
            json!({"type":"TOOL_CALL_END","toolCallId":"c1"}),
            json!({"type":"TOOL_CALL_RESULT","toolCallId":"c1","content":"exit 0\ntest result: ok","ok":true}),
            json!({"type":"TEXT_MESSAGE_START","messageId":"m2","role":"assistant"}),
            json!({"type":"TEXT_MESSAGE_CONTENT","messageId":"m2","delta":"All green."}),
            json!({"type":"TEXT_MESSAGE_END","messageId":"m2"}),
            json!({"type":"RUN_FINISHED"}),
        ]);
        turn.finish();
        let (plain, parts) = turn.snapshot();
        let step = StepSpec {
            call_id: "c1".into(),
            tool: "shell".into(),
            arguments: "{\"command\":\"cargo test\"}".into(),
            result: Some("exit 0\ntest result: ok".into()),
            ok: Some(true),
            took_ms: None,
        };
        assert_eq!(
            parts,
            vec![
                ChatPart::Text("Let me run the tests.".into()),
                ChatPart::Step(step.clone()),
                ChatPart::Text("All green.".into()),
            ]
        );
        assert_eq!(step.label(), "Running `cargo test`");
        assert_eq!(step.status(), StepStatus::Ok);
        assert_eq!(step.shown_arguments().as_deref(), Some("cargo test"));
        // The words either side are two things said, as they are two bubbles.
        assert_eq!(plain, "Let me run the tests.\n\nAll green.");
    }

    /// Until its result comes back a step is still going, and says what it is doing.
    #[test]
    fn a_step_without_a_result_yet_is_still_going() {
        let turn = assembled(&[
            json!({"type":"TOOL_CALL_START","toolCallId":"c1","toolCallName":"read_file"}),
            json!({"type":"TOOL_CALL_ARGS","toolCallId":"c1","delta":"{\"path\":\"src/main.rs\"}"}),
            json!({"type":"TOOL_CALL_END","toolCallId":"c1"}),
        ]);
        let (_, parts) = turn.snapshot();
        match parts.as_slice() {
            [ChatPart::Step(step)] => {
                assert_eq!(step.result, None);
                assert_eq!(step.ok, None);
                assert_eq!(step.status(), StepStatus::Running);
                assert_eq!(step.status().word(), "running");
                assert_eq!(step.label(), "Reading main.rs");
                assert_eq!(step.shown_arguments().as_deref(), Some("src/main.rs"));
            }
            other => panic!("expected one step still going, got {other:?}"),
        }
    }

    fn call(id: &str, tool: &str, arguments: &str) -> [Value; 3] {
        [
            json!({"type":"TOOL_CALL_START","toolCallId":id,"toolCallName":tool}),
            json!({"type":"TOOL_CALL_ARGS","toolCallId":id,"delta":arguments}),
            json!({"type":"TOOL_CALL_END","toolCallId":id}),
        ]
    }

    fn answer(id: &str, content: &str) -> Value {
        json!({"type":"TOOL_CALL_RESULT","toolCallId":id,"content":content,"ok":true})
    }

    /// Each call's time, by call id, as its row would say it.
    fn times(turn: &TurnAssembler) -> Vec<(String, Option<String>)> {
        let (_, parts) = turn.snapshot();
        steps_in(&parts)
            .into_iter()
            .map(|step| (step.call_id.clone(), step.took()))
            .collect()
    }

    #[test]
    fn reasoning_duration_follows_its_own_segment_and_survives_storage_and_replay() {
        let t0 = Instant::now();
        let mut turn = TurnAssembler::default();
        for (ms, event) in [
            (
                0,
                json!({"type":"REASONING_MESSAGE_START","messageId":"r1"}),
            ),
            (
                200,
                json!({"type":"REASONING_MESSAGE_CONTENT","messageId":"r1","delta":"Check the file."}),
            ),
            (
                5000,
                json!({"type":"REASONING_MESSAGE_END","messageId":"r1"}),
            ),
        ] {
            turn.push_event_at(&event, Some(t0 + std::time::Duration::from_millis(ms)));
        }
        let (_, before) = turn.snapshot();
        let [ChatPart::Reasoning(thought)] = before.as_slice() else {
            panic!("one thought");
        };
        assert_eq!(thought.took(), Some("5s".into()));
        assert_eq!(ThoughtSpec::from_stored(&thought.stored()), *thought);
        assert_eq!(
            ThoughtSpec::from_stored("older plain text"),
            "older plain text".into()
        );
        let mut replay = vec![ChatPart::Reasoning(thought.text.clone().into())];
        keep_call_times(&before, &mut replay);
        assert_eq!(replay, before);
        let mut changed = vec![ChatPart::Reasoning("A different thought".into())];
        keep_call_times(&before, &mut changed);
        assert!(matches!(&changed[0], ChatPart::Reasoning(thought) if thought.took_ms.is_none()));
    }

    #[test]
    fn reasoning_with_missing_or_buffered_boundaries_has_no_guessed_time() {
        let t0 = Instant::now();
        for opening in [None, Some(t0)] {
            let mut turn = TurnAssembler::default();
            turn.push_event_at(
                &json!({"type":"REASONING_MESSAGE_START","messageId":"r1"}),
                opening,
            );
            turn.push_event_at(
                &json!({"type":"REASONING_MESSAGE_CONTENT","messageId":"r1","delta":"Check."}),
                Some(t0),
            );
            turn.push_event_at(
                &json!({"type":"REASONING_MESSAGE_END","messageId":"r1"}),
                Some(t0),
            );
            let (_, parts) = turn.snapshot();
            assert!(matches!(&parts[0], ChatPart::Reasoning(thought) if thought.took_ms.is_none()));
        }
    }

    #[test]
    fn a_tool_boundary_settles_thinking_before_the_tool_instead_of_timing_the_model_round() {
        let t0 = Instant::now();
        let mut turn = TurnAssembler::default();
        turn.push_event_at(
            &json!({"type":"REASONING_MESSAGE_START","messageId":"r1"}),
            Some(t0),
        );
        turn.push_event_at(
            &json!({"type":"REASONING_MESSAGE_CONTENT","messageId":"r1","delta":"Read it."}),
            Some(t0),
        );
        turn.push_event_at(
            &json!({"type":"TOOL_CALL_START","toolCallId":"c1","toolCallName":"shell"}),
            Some(t0 + std::time::Duration::from_secs(2)),
        );
        turn.push_event_at(
            &json!({"type":"RUN_FINISHED"}),
            Some(t0 + std::time::Duration::from_secs(30)),
        );
        let (_, parts) = turn.snapshot();
        assert!(
            matches!(&parts[0], ChatPart::Reasoning(thought) if thought.took() == Some("2s".into()))
        );
    }

    /// A live turn that ran two calls, one per round, as the harness runs them: each call's row
    /// says how long its own answer took, from its arguments being all in to its result. The
    /// model's time writing the arguments, and the time between the rounds, are not the call's.
    #[test]
    fn a_live_turn_gives_each_call_its_own_time() {
        let t0 = Instant::now();
        let mut turn = TurnAssembler::default();
        let mut feed = |at: u64, event: &Value| {
            turn.push_event_at(event, Some(t0 + std::time::Duration::from_millis(at)));
        };
        feed(
            0,
            &json!({"type":"RUN_STARTED","threadId":"cw_1","runId":"r1"}),
        );
        let [start, args, end] = call("c1", "shell", "{\"command\":\"uname -a\"}");
        feed(100, &start);
        feed(900, &args);
        feed(1000, &end);
        feed(2000, &answer("c1", "Darwin"));
        let [start, args, end] = call("c2", "read_file", "{\"path\":\"notes.txt\"}");
        feed(4000, &start);
        feed(4100, &args);
        feed(4200, &end);
        feed(4550, &answer("c2", "hello"));
        feed(6000, &text("It is a Mac."));
        feed(7000, &json!({"type":"RUN_FINISHED"}));
        turn.finish();
        assert_eq!(
            times(&turn),
            vec![
                ("c1".to_string(), Some("1s".to_string())),
                ("c2".to_string(), Some("350ms".to_string())),
            ]
        );
        let (_, parts) = turn.snapshot();
        let steps = steps_in(&parts);
        assert_eq!(steps[0].took_ms, Some(1000));
        assert_eq!(steps[0].label(), "Running `uname -a`");
        assert_eq!(steps[1].took_ms, Some(350));
    }

    /// Two calls made in one round are run one after the other and answered together, once the
    /// second is done: either call's wait is the whole round's, so neither row claims it. The
    /// next round's call, alone again, has its own.
    #[test]
    fn calls_answered_together_have_no_time_of_their_own() {
        let t0 = Instant::now();
        let mut turn = TurnAssembler::default();
        let mut feed = |at: u64, event: &Value| {
            turn.push_event_at(event, Some(t0 + std::time::Duration::from_millis(at)));
        };
        for event in call("c1", "shell", "{\"command\":\"ls\"}") {
            feed(100, &event);
        }
        for event in call("c2", "shell", "{\"command\":\"pwd\"}") {
            feed(300, &event);
        }
        feed(3300, &answer("c1", "a.txt"));
        feed(3301, &answer("c2", "/srv"));
        for event in call("c3", "shell", "{\"command\":\"wc -l a.txt\"}") {
            feed(5000, &event);
        }
        feed(5500, &answer("c3", "3 a.txt"));
        assert_eq!(
            times(&turn),
            vec![
                ("c1".to_string(), None),
                ("c2".to_string(), None),
                ("c3".to_string(), Some("500ms".to_string())),
            ]
        );
    }

    /// A replay is the run's frames with no time on any of them, since every frame of a run
    /// carries the run's opening timestamp. Its rows say nothing about how long a call took,
    /// rather than a guess.
    #[test]
    fn a_replay_times_no_call() {
        let mut frames =
            vec![json!({"type":"RUN_STARTED","threadId":"cw_1","runId":"r1","timestamp":100})];
        frames.extend(call("c1", "shell", "{\"command\":\"uname -a\"}"));
        frames.push(answer("c1", "Darwin"));
        frames.extend(call("c2", "read_file", "{\"path\":\"notes.txt\"}"));
        frames.push(answer("c2", "hello"));
        frames.push(json!({"type":"RUN_FINISHED","timestamp":100}));
        let replayed = assembled(&frames);
        assert_eq!(
            times(&replayed),
            vec![("c1".to_string(), None), ("c2".to_string(), None)]
        );
        // Frames nobody saw arrive are the same as a replay's.
        let mut unseen = TurnAssembler::default();
        for frame in &frames {
            unseen.push_event_at(frame, None);
        }
        assert_eq!(times(&unseen), times(&replayed));
    }

    /// A call held for the person's yes is answered twice: first with the gate's word, then,
    /// once the person has decided, with the tool's. Neither is the call's own time.
    #[test]
    fn a_call_that_waited_on_a_person_has_no_time() {
        let t0 = Instant::now();
        let mut turn = TurnAssembler::default();
        let mut feed = |at: u64, event: &Value| {
            turn.push_event_at(event, Some(t0 + std::time::Duration::from_millis(at)));
        };
        for event in call("c1", "shell", "{\"command\":\"rm -rf build\"}") {
            feed(100, &event);
        }
        feed(
            140,
            &json!({"type":"TOOL_CALL_RESULT","toolCallId":"c1","ok":false,
                    "content":"waiting for approval: it deletes files"}),
        );
        feed(
            150,
            &json!({"type":"CUSTOM","name":"run-awaiting-approval","runId":"r1","callId":"c1",
                    "tool":"shell","arguments":{"command":"rm -rf build"},"reason":"exec-consent"}),
        );
        feed(160, &json!({"type":"RUN_FINISHED"}));
        feed(90_000, &answer("c1", "removed"));
        assert_eq!(times(&turn), vec![("c1".to_string(), None)]);
    }

    /// A run followed by asking the server again and again: a frame is as new as the first ask
    /// that brought it. A call that was already under way at the first ask has no time; a call
    /// that ended in one ask and was answered in a later one has the time between them; a call
    /// that ended and was answered in the same ask took less than an ask, and says nothing.
    #[test]
    fn a_followed_run_times_the_calls_it_saw_arrive() {
        let t0 = Instant::now();
        let mut journal = vec![json!({"type":"RUN_STARTED","threadId":"cw_1","runId":"r1"})];
        journal.extend(call("c1", "shell", "{\"command\":\"make\"}"));
        let asks: Vec<(u64, Vec<Value>)> = vec![
            (0, Vec::new()),
            (2000, {
                let mut more = vec![answer("c1", "built")];
                more.extend(call("c2", "shell", "{\"command\":\"make test\"}"));
                more
            }),
            (5000, {
                let mut more = vec![answer("c2", "ok")];
                more.extend(call("c3", "shell", "{\"command\":\"ls\"}"));
                more.push(answer("c3", "a.out"));
                more
            }),
        ];
        let mut arrivals = FrameArrivals::default();
        for (at, more) in asks {
            journal.extend(more);
            arrivals.note(&journal, t0 + std::time::Duration::from_millis(at));
        }
        // Each ask rebuilds the reply from every frame so far, so the last rebuild is the reply.
        let mut rebuilt = TurnAssembler::default();
        for event in &journal {
            rebuilt.push_event_at(event, arrivals.at(event));
        }
        assert_eq!(
            times(&rebuilt),
            vec![
                ("c1".to_string(), None),
                ("c2".to_string(), Some("3s".to_string())),
                ("c3".to_string(), None),
            ]
        );
    }

    /// Rebuilding a reply from the server's frames keeps the times this app measured for its
    /// calls, which the frames cannot give back, and takes nothing from a call it could time.
    #[test]
    fn a_rebuilt_reply_keeps_the_times_it_had() {
        let step = |id: &str, took_ms: Option<u64>| {
            ChatPart::Step(StepSpec {
                call_id: id.into(),
                tool: "shell".into(),
                arguments: String::new(),
                result: Some("ok".into()),
                ok: Some(true),
                took_ms,
            })
        };
        let before = vec![step("c1", Some(1000)), step("c2", None)];
        let mut after = vec![step("c1", None), step("c2", None), step("c3", Some(700))];
        keep_call_times(&before, &mut after);
        assert_eq!(
            after,
            vec![
                step("c1", Some(1000)),
                step("c2", None),
                step("c3", Some(700))
            ]
        );
    }

    #[test]
    fn a_rebuilt_reply_does_not_restore_a_person_wait_as_tool_time() {
        let mut before = TurnAssembler::default();
        let t0 = Instant::now();
        for event in call("c1", "shell", "{\"command\":\"make\"}") {
            before.push_event_at(&event, Some(t0));
        }
        before.push_event_at(
            &answer("c1", "waiting for approval"),
            Some(t0 + std::time::Duration::from_secs(1)),
        );
        let (_, before_parts) = before.snapshot();
        assert!(matches!(&before_parts[0], ChatPart::Step(step) if step.took_ms == Some(1000)));
        let mut replay = TurnAssembler::default();
        for event in call("c1", "shell", "{\"command\":\"make\"}") {
            replay.push_event(&event);
        }
        replay.push_event(&answer("c1", "waiting for approval"));
        replay.push_event(
            &json!({"type":"CUSTOM","name":"run-awaiting-approval","runId":"r1","callId":"c1",
                    "tool":"shell","arguments":{"command":"make"},"reason":"exec-consent"}),
        );
        replay.push_event(&answer("c1", "built"));
        let (_, mut replay_parts) = replay.snapshot();
        keep_call_times(&before_parts, &mut replay_parts);
        assert_eq!(steps_in(&replay_parts)[0].took_ms, None);
    }

    /// A step's time is kept with its database row and read back; a row written before there
    /// were times reads back with none.
    #[test]
    fn a_step_s_time_is_kept_with_its_row() {
        let step = StepSpec {
            call_id: "c1".into(),
            tool: "shell".into(),
            arguments: "{\"command\":\"ls\"}".into(),
            result: Some("a.txt".into()),
            ok: Some(true),
            took_ms: Some(1234),
        };
        assert_eq!(
            StepSpec::from_value("c1".into(), &step.to_value()).as_ref(),
            Some(&step)
        );
        let older =
            json!({"tool":"shell","arguments":"{\"command\":\"ls\"}","result":"a.txt","ok":true});
        let read = StepSpec::from_value("c1".into(), &older).expect("an older row reads");
        assert_eq!(read.took_ms, None);
        assert_eq!(read.took(), None);
    }

    /// Reasoning is a part of its own, drawn as a thought, and none of it is the reply's words.
    /// Two blocks back to back are one thought, and a run that ends in the middle of one keeps
    /// what it had thought so far.
    #[test]
    fn reasoning_is_its_own_part_and_not_the_reply() {
        let turn = assembled(&[
            json!({"type":"RUN_STARTED","threadId":"cw_1","runId":"r1"}),
            json!({"type":"REASONING_MESSAGE_START","messageId":"msg_r1_1"}),
            json!({"type":"REASONING_MESSAGE_CONTENT","messageId":"msg_r1_1","delta":"The person wants the build checked."}),
            json!({"type":"REASONING_MESSAGE_CONTENT","messageId":"msg_r1_1","delta":" Tests first."}),
            json!({"type":"REASONING_MESSAGE_END","messageId":"msg_r1_1"}),
            json!({"type":"REASONING_MESSAGE_START","messageId":"msg_r1_2"}),
            json!({"type":"REASONING_MESSAGE_CONTENT","messageId":"msg_r1_2","delta":"Then say so."}),
            json!({"type":"REASONING_MESSAGE_END","messageId":"msg_r1_2"}),
            json!({"type":"TEXT_MESSAGE_START","messageId":"msg_r1_3","role":"assistant"}),
            json!({"type":"TEXT_MESSAGE_CONTENT","messageId":"msg_r1_3","delta":"Checking the build."}),
            json!({"type":"TEXT_MESSAGE_END","messageId":"msg_r1_3"}),
        ]);
        let (plain, parts) = turn.snapshot();
        assert_eq!(
            parts,
            vec![
                ChatPart::Reasoning(
                    "The person wants the build checked. Tests first.\n\nThen say so.".into()
                ),
                ChatPart::Text("Checking the build.".into()),
            ]
        );
        assert_eq!(plain, "Checking the build.");

        // Nothing is drawn while the thought is still being said; the status line says
        // "Thinking" meanwhile. Then the run stops mid-thought, one way or the other.
        let open = [
            json!({"type":"REASONING_MESSAGE_START","messageId":"msg_r2_1"}),
            json!({"type":"REASONING_MESSAGE_CONTENT","messageId":"msg_r2_1","delta":"Half a"}),
        ];
        assert!(assembled(&open).snapshot().1.is_empty());
        let mut failed = assembled(&open);
        failed.push_event(&json!({"type":"RUN_ERROR","message":"the model went away"}));
        let mut finished = assembled(&open);
        finished.finish();
        for turn in [failed, finished] {
            let (plain, parts) = turn.snapshot();
            assert_eq!(parts, vec![ChatPart::Reasoning("Half a".into())]);
            assert_eq!(plain, "");
        }
    }

    /// A chart, a form and a user-form are drawn as themselves and are not steps, and a call
    /// waiting on the person's yes is drawn as its card and not also as a step. Once the card
    /// is answered and the call has run, the call is a step like any other.
    #[test]
    fn ui_and_user_form_tools_are_not_steps() {
        let mut turn = assembled(&[
            json!({"type":"TOOL_CALL_START","toolCallId":"c1","toolCallName":"bar_chart"}),
            json!({"type":"TOOL_CALL_ARGS","toolCallId":"c1","delta":"{\"title\":\"Q3\",\"bars\":[{\"label\":\"A\",\"value\":3}]}"}),
            json!({"type":"TOOL_CALL_END","toolCallId":"c1"}),
            json!({"type":"TOOL_CALL_START","toolCallId":"c2","toolCallName":"form"}),
            json!({"type":"TOOL_CALL_ARGS","toolCallId":"c2","delta":"{\"fields\":[{\"id\":\"go\",\"label\":\"Go\",\"options\":[\"Yes\",\"No\"]}]}"}),
            json!({"type":"TOOL_CALL_END","toolCallId":"c2"}),
            json!({"type":"TOOL_CALL_START","toolCallId":"c3","toolCallName":"request_user_form"}),
            json!({"type":"TOOL_CALL_ARGS","toolCallId":"c3","delta":"{\"formRequest\":{\"title\":\"Code\",\"fields\":[{\"id\":\"otp\",\"label\":\"Code\",\"type\":\"otp\",\"required\":true,\"value\":\"654321\"}]}}"}),
            json!({"type":"TOOL_CALL_END","toolCallId":"c3"}),
            json!({"type":"TOOL_CALL_START","toolCallId":"c4","toolCallName":"shell"}),
            json!({"type":"TOOL_CALL_ARGS","toolCallId":"c4","delta":"{\"command\":\"rm -rf build\"}"}),
            json!({"type":"TOOL_CALL_END","toolCallId":"c4"}),
            json!({
                "type": "CUSTOM", "name": "run-awaiting-approval", "runId": "r1", "callId": "c4",
                "tool": "shell", "arguments": {"command": "rm -rf build"}, "reason": "exec-consent"
            }),
        ]);
        let (_, parts) = turn.snapshot();
        assert!(
            steps_in(&parts).is_empty(),
            "a chart, a form, a user-form and a call waiting on its card are not steps: {parts:?}"
        );
        assert!(
            parts
                .iter()
                .any(|part| matches!(part, ChatPart::Ui(UiSpec::BarChart(_))))
        );
        assert!(
            parts
                .iter()
                .any(|part| matches!(part, ChatPart::Ui(UiSpec::Form(_))))
        );
        assert!(
            parts
                .iter()
                .any(|part| matches!(part, ChatPart::UserForm(_)))
        );
        assert!(
            parts
                .iter()
                .any(|part| matches!(part, ChatPart::Approval(spec) if spec.call_id == "c4"))
        );

        turn.push_event(&json!({
            "type": "TOOL_CALL_RESULT", "toolCallId": "c4", "content": "exit 0", "ok": true
        }));
        let (_, parts) = turn.snapshot();
        let steps = steps_in(&parts);
        assert_eq!(steps.len(), 1, "{parts:?}");
        assert_eq!(steps[0].call_id, "c4");
        assert_eq!(steps[0].result.as_deref(), Some("exit 0"));
        assert!(!format!("{parts:?}").contains("654321"));
    }

    /// A result, or arguments, longer than a step keeps are cut to the cap on a character
    /// boundary and end with "…", once: arguments are kept when all of them are in.
    #[test]
    fn a_long_result_is_cut_on_a_char_boundary() {
        // Three bytes to a character, so the cap falls inside one.
        let content = "界".repeat(3_500);
        // Eighteen bytes, then four to a character, so the cut backs off three bytes into the
        // room the "…" needs.
        let mut events = vec![
            json!({"type":"TOOL_CALL_START","toolCallId":"c1","toolCallName":"shell"}),
            json!({"type":"TOOL_CALL_ARGS","toolCallId":"c1","delta":"{\"command\":\"echo: "}),
        ];
        // A thousand bytes to a delta, ten of them.
        for _ in 0..10 {
            events
                .push(json!({"type":"TOOL_CALL_ARGS","toolCallId":"c1","delta":"🦀".repeat(250)}));
        }
        events.push(json!({"type":"TOOL_CALL_ARGS","toolCallId":"c1","delta":"\"}"}));
        events.push(json!({"type":"TOOL_CALL_END","toolCallId":"c1"}));
        events
            .push(json!({"type":"TOOL_CALL_RESULT","toolCallId":"c1","content":content,"ok":true}));
        let (_, parts) = assembled(&events).snapshot();
        let steps = steps_in(&parts);
        let [step] = steps.as_slice() else {
            panic!("expected one step, got {parts:?}");
        };
        let result = step.result.as_deref().expect("a result");
        assert!(result.len() <= STEP_TEXT_CAP, "{}", result.len());
        assert!(result.len() > STEP_TEXT_CAP - 8, "{}", result.len());
        assert!(result.ends_with('…'));
        assert!(result.trim_end_matches('…').chars().all(|c| c == '界'));
        assert!(std::str::from_utf8(result.as_bytes()).is_ok());

        let arguments = &step.arguments;
        assert!(arguments.len() <= STEP_TEXT_CAP, "{}", arguments.len());
        assert!(arguments.ends_with('…'), "nothing is added after the cut");
        assert!(arguments.starts_with("{\"command\":\"echo: 🦀"));
        assert!(arguments.trim_end_matches('…').ends_with('🦀'));
        assert_eq!(arguments.matches('…').count(), 1);
    }

    /// What the server kept off the wire stays off the step: typed text it redacted reads
    /// `«redacted»` on the row, opened, as it came.
    #[test]
    fn redacted_arguments_stay_redacted() {
        let (_, parts) = assembled(&[
            json!({"type":"TOOL_CALL_START","toolCallId":"c1","toolCallName":"computer"}),
            json!({"type":"TOOL_CALL_ARGS","toolCallId":"c1","delta":"{\"action\":\"type\",\"text\":\"«redacted»\"}"}),
            json!({"type":"TOOL_CALL_END","toolCallId":"c1"}),
            json!({"type":"TOOL_CALL_RESULT","toolCallId":"c1","content":"typed «redacted»","ok":true}),
        ])
        .snapshot();
        let steps = steps_in(&parts);
        let [step] = steps.as_slice() else {
            panic!("expected one step, got {parts:?}");
        };
        assert_eq!(step.label(), "Typing on its computer");
        assert_eq!(
            step.arguments,
            "{\"action\":\"type\",\"text\":\"«redacted»\"}"
        );
        let shown = step.shown_arguments().expect("the arguments are shown");
        assert!(shown.contains("\"text\": \"«redacted»\""), "{shown}");
        assert_eq!(step.result.as_deref(), Some("typed «redacted»"));
    }

    /// The four calls whose arguments carry what the approval card keeps off it: a login
    /// recipe's password, a link's token, a key typed on the screen, and a plugin's key.
    fn secret_calls() -> Vec<Value> {
        let typed = format!("sk-live-{}", "a1".repeat(24));
        let mut frames = Vec::new();
        for (id, tool, arguments) in [
            (
                "c1",
                "run_recipe",
                json!({"recipe": "Gmail login", "values": {"email": "ada@example.com", "password": "hunter2-horse-battery"}}),
            ),
            (
                "c2",
                "open_url",
                json!({"url": "https://example.com/inbox?token=tok_live_q8x7#settings"}),
            ),
            ("c3", "computer", json!({"action": "type", "text": typed})),
            (
                "c4",
                "gmail.api.send",
                json!({"to": "bo@example.com", "api_key": "plugin-key-9f8e7d", "coworkerId": "cw_1"}),
            ),
        ] {
            frames.push(json!({"type":"TOOL_CALL_START","toolCallId":id,"toolCallName":tool}));
            frames.push(
                json!({"type":"TOOL_CALL_ARGS","toolCallId":id,"delta":arguments.to_string()}),
            );
            frames.push(json!({"type":"TOOL_CALL_END","toolCallId":id}));
            frames.push(
                json!({"type":"TOOL_CALL_RESULT","toolCallId":id,"content":"done","ok":true}),
            );
        }
        frames
    }

    /// What the card keeps off, as it would be found in a step's text.
    const SECRETS: &[&str] = &[
        "hunter2-horse-battery",
        "tok_live_q8x7",
        "token=",
        "a1a1a1a1a1a1",
        "plugin-key-9f8e7d",
        "cw_1",
    ];

    /// A step keeps off what the approval card for the same call keeps off, from the moment it
    /// is drawn: while its arguments are still arriving, once they have, and opened.
    #[test]
    fn a_steps_arguments_keep_off_what_the_card_keeps_off() {
        let frames = secret_calls();
        let mut turn = TurnAssembler::default();
        for frame in &frames {
            turn.push_event(frame);
            let (_, parts) = turn.snapshot();
            for step in steps_in(&parts) {
                let said = format!("{} {:?}", step.arguments, step.shown_arguments());
                for secret in SECRETS {
                    assert!(
                        !said.contains(secret),
                        "{secret:?} in {} as {said}",
                        step.tool
                    );
                }
            }
        }
        let (_, parts) = turn.snapshot();
        let steps = steps_in(&parts);
        assert_eq!(steps.len(), 4);
        // What the card says of each call is still there to read.
        assert!(steps[0].arguments.contains("Gmail login"));
        assert!(steps[1].arguments.contains("https://example.com/inbox"));
        assert_eq!(steps[1].label(), "Opening example.com");
        assert!(steps[2].arguments.contains(REDACTED));
        assert_eq!(steps[2].label(), "Typing on its computer");
        assert!(steps[3].arguments.contains("bo@example.com"));
        assert!(steps[3].arguments.contains(REDACTED));
    }

    /// `use_skill` is the server's own tool (opengrok-server#270), and reads as one: its card
    /// names the skill rather than calling it a plugin's tool, and its step keeps the name as it
    /// was sent. A skill's name may run to 64 letters, digits, dots and dashes, and a long one is
    /// shaped like a key to the plugin rule, which would show the step as «redacted».
    #[test]
    fn use_skill_reads_as_the_servers_own_tool_and_keeps_the_skills_name() {
        let name = "finance-team.quarterly-report-checklist-v2";
        let arguments = json!({ "name": name });
        assert!(
            looks_like_a_secret(name),
            "the name the plugin rule would hide"
        );
        let summary = approval_summary(USE_SKILL, &arguments);
        assert_eq!(summary, format!("Read the skill \"{name}\""));
        assert!(!summary.contains("plugin"), "{summary}");
        assert_eq!(
            approval_summary(USE_SKILL, &json!({})),
            "Read the skill \"(unnamed)\""
        );
        assert_eq!(step_arguments(USE_SKILL, &arguments), arguments);

        let (_, parts) = assembled(&[
            json!({"type":"TOOL_CALL_START","toolCallId":"c1","toolCallName":"use_skill"}),
            json!({"type":"TOOL_CALL_ARGS","toolCallId":"c1","delta": arguments.to_string()}),
            json!({"type":"TOOL_CALL_END","toolCallId":"c1"}),
            json!({"type":"TOOL_CALL_RESULT","toolCallId":"c1",
                "content":"---\nname: finance-team.quarterly-report-checklist-v2\n---\nCheck the totals.",
                "ok":true}),
        ])
        .snapshot();
        let [ChatPart::Step(step)] = parts.as_slice() else {
            panic!("a use_skill call is a step: {parts:?}");
        };
        assert_eq!(step.label(), format!("Reading the {name} skill"));
        assert_eq!(step.shown_arguments().as_deref(), Some(name));
        assert!(
            step.result
                .as_deref()
                .is_some_and(|body| body.contains("Check the totals.")),
            "the skill's body is the call's result"
        );
    }

    /// Words of one message on either side of a tool's result are one run of words, not two.
    #[test]
    fn a_result_does_not_split_the_words_around_it() {
        let turn = assembled(&[
            json!({"type":"TEXT_MESSAGE_START","messageId":"m1","role":"assistant"}),
            json!({"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"Let me run it."}),
            json!({"type":"TOOL_CALL_START","toolCallId":"c1","toolCallName":"shell"}),
            json!({"type":"TOOL_CALL_ARGS","toolCallId":"c1","delta":"{\"command\":\"ls\"}"}),
            json!({"type":"TOOL_CALL_END","toolCallId":"c1"}),
            json!({"type":"TOOL_CALL_RESULT","toolCallId":"c1","content":"a.txt","ok":true}),
            json!({"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"It listed one file."}),
            json!({"type":"TEXT_MESSAGE_END","messageId":"m1"}),
        ]);
        let (_, parts) = turn.snapshot();
        assert!(
            matches!(
                parts.as_slice(),
                [ChatPart::Text(before), ChatPart::Step(_), ChatPart::Text(after)]
                    if before == "Let me run it." && after == "It listed one file."
            ),
            "{parts:?}"
        );
    }

    /// A thought is kept to the size a step's result is, however much of it the model said.
    #[test]
    fn a_long_thought_is_cut_like_a_result() {
        let thought = "思".repeat(3_500);
        let (_, parts) = assembled(&[
            json!({"type":"REASONING_MESSAGE_START","messageId":"r1"}),
            json!({"type":"REASONING_MESSAGE_CONTENT","messageId":"r1","delta":thought}),
            json!({"type":"REASONING_MESSAGE_END","messageId":"r1"}),
        ])
        .snapshot();
        let [ChatPart::Reasoning(kept)] = parts.as_slice() else {
            panic!("expected one thought, got {} parts", parts.len());
        };
        assert!(kept.text.len() <= STEP_TEXT_CAP, "{}", kept.text.len());
        assert!(kept.text.ends_with('…'));
        assert!(kept.text.trim_end_matches('…').chars().all(|c| c == '思'));
    }

    /// A thought the model was in the middle of when it reached for a tool comes before that
    /// call, and what it thought after the call comes after it.
    #[test]
    fn a_thought_open_when_a_call_starts_comes_before_the_call() {
        let (_, parts) = assembled(&[
            json!({"type":"REASONING_MESSAGE_START","messageId":"r1"}),
            json!({"type":"REASONING_MESSAGE_CONTENT","messageId":"r1","delta":"Size it first."}),
            json!({"type":"TOOL_CALL_START","toolCallId":"c1","toolCallName":"shell"}),
            json!({"type":"TOOL_CALL_ARGS","toolCallId":"c1","delta":"{\"command\":\"du -sh .\"}"}),
            json!({"type":"TOOL_CALL_END","toolCallId":"c1"}),
            json!({"type":"TOOL_CALL_RESULT","toolCallId":"c1","content":"4.0G","ok":true}),
            json!({"type":"REASONING_MESSAGE_CONTENT","messageId":"r1","delta":"Then say so."}),
            json!({"type":"REASONING_MESSAGE_END","messageId":"r1"}),
            json!({"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"Four gigabytes."}),
        ])
        .snapshot();
        assert!(
            matches!(
                parts.as_slice(),
                [
                    ChatPart::Reasoning(before),
                    ChatPart::Step(step),
                    ChatPart::Reasoning(after),
                    ChatPart::Text(_),
                ] if before.text == "Size it first." && step.call_id == "c1" && after.text == "Then say so."
            ),
            "{parts:?}"
        );
    }

    fn two_questions() -> FormSpec {
        FormSpec {
            title: Some("Setup".into()),
            prompt: None,
            fields: vec![
                FormField {
                    id: "size".into(),
                    label: "Size".into(),
                    options: vec!["Small".into(), "Large".into()],
                },
                FormField {
                    id: "colour".into(),
                    label: "Colour".into(),
                    options: vec!["Red: dark".into(), "Blue".into()],
                },
            ],
            submit: "Send".into(),
        }
    }

    /// What a card sends is what reads back as its answer, choice for choice, including a
    /// choice with a colon in it.
    #[test]
    fn a_choice_answer_reads_back_as_what_was_picked() {
        let spec = two_questions();
        let picks: std::collections::HashMap<String, String> = [
            ("size".to_string(), "Large".to_string()),
            ("colour".to_string(), "Red: dark".to_string()),
        ]
        .into();
        let sent = spec.answer_text(&picks);
        assert_eq!(sent, "Setup\nSize: Large\nColour: Red: dark");
        assert_eq!(spec.answer_in(&sent), Some(picks));
        let partial: std::collections::HashMap<String, String> =
            [("size".to_string(), "Small".to_string())].into();
        assert_eq!(
            spec.answer_in("Size: Small"),
            Some(partial),
            "no title is fine"
        );
    }

    /// Words that are not the card's own choices are the person talking, not an answer.
    #[test]
    fn words_that_are_not_the_cards_choices_are_not_its_answer() {
        let spec = two_questions();
        for text in [
            "",
            "Setup",
            "Size: Medium",
            "Size: Large\nand hurry",
            "Size: Large\nSize: Small",
            "I think Size: Large is best",
        ] {
            assert_eq!(spec.answer_in(text), None, "{text:?}");
        }
    }

    #[test]
    fn a_choices_letter_is_its_key() {
        assert_eq!(choice_letter(0), Some('A'));
        assert_eq!(choice_letter(5), Some('F'));
        assert_eq!(choice_letter(26), None);
        assert_eq!(choice_index("a"), Some(0));
        assert_eq!(choice_index("F"), Some(5));
        for key in ["", "ab", "1", "enter", "é"] {
            assert_eq!(choice_index(key), None, "{key:?}");
        }
        assert!(!two_questions().answers_on_pick());
        let mut one = two_questions();
        one.fields.truncate(1);
        assert!(one.answers_on_pick());
        one.fields[0].options.clear();
        assert!(
            !one.answers_on_pick(),
            "a question with no choices has nothing to pick"
        );
    }

    /// The answers that change the person's routines are those of a make, a change, a delete
    /// and a run, each told once: a listing changes nothing, and neither does another tool's
    /// answer, nor one that waits on a card or was refused (`ok: false`). An answer is known by its
    /// call's id from the frame that named the tool, which it does not name itself.
    #[test]
    fn a_routine_change_is_known_by_its_calls_answer() {
        let start = |id: &str, tool: &str| {
            json!({"type": "TOOL_CALL_START", "toolCallId": id,
                   "toolCallName": tool})
        };
        let answer = |id: &str, ok: Option<bool>| {
            let mut frame = json!({"type": "TOOL_CALL_RESULT", "toolCallId": id, "content": "x"});
            if let Some(ok) = ok {
                frame["ok"] = json!(ok);
            }
            frame
        };
        let mut changes = RoutineChanges::default();
        for (id, tool) in [
            ("make", CREATE_ROUTINE),
            ("change", UPDATE_ROUTINE),
            ("delete", DELETE_ROUTINE),
            ("run", RUN_ROUTINE),
            ("list", LIST_ROUTINES),
            ("shell", "shell"),
        ] {
            assert!(
                !changes.answered(&start(id, tool)),
                "{tool}: not answered yet"
            );
            assert!(
                !changes.answered(&json!({"type": "TOOL_CALL_END", "toolCallId": id})),
                "{tool}: not answered yet"
            );
        }
        for id in ["make", "change", "run"] {
            assert!(changes.answered(&answer(id, Some(true))), "{id}");
        }
        assert!(
            changes.answered(&answer("make", None)),
            "an answer that does not say"
        );
        assert!(
            !changes.answered(&answer("delete", Some(false))),
            "waiting on a card"
        );
        assert!(
            changes.answered(&answer("delete", Some(true))),
            "after the yes"
        );
        assert!(!changes.answered(&answer("list", Some(true))));
        assert!(!changes.answered(&answer("shell", Some(true))));
        assert!(!changes.answered(&answer("never-named", Some(true))));
    }

    /// A needs frame becomes the card, each need as the server listed it; one this app does not
    /// know is left out rather than guessed at, and the Bot's `add_plugin_account` answer is the
    /// same account card, with no Send again (#359, #360).
    #[test]
    fn a_needs_frame_and_an_add_account_answer_are_cards() {
        let mut assembler = TurnAssembler::default();
        assembler.push_event(&serde_json::json!({
            "type": "CUSTOM", "name": PLUGIN_NEEDS_CUSTOM, "value": {"needs": [
                {"plugin": "nope", "need": "install"},
                {"plugin": "cloudflare", "connector": "cloudflare", "need": "choose",
                 "accounts": [{"id": "conn_a", "label": "Work", "kind": "mcp"}]},
                {"plugin": "x", "need": "telepathy"}
            ]}
        }));
        let (_, parts) = assembler.snapshot();
        let [ChatPart::PluginNeeds(card)] = parts.as_slice() else {
            panic!("{parts:?}");
        };
        assert!(card.send_again);
        assert_eq!(card.needs.len(), 2);
        assert_eq!(card.needs[0].kind, PluginNeedKind::Install);
        assert_eq!(
            card.needs[1].kind,
            PluginNeedKind::Choose(vec![("conn_a".into(), "Work".into(), "mcp".into())])
        );

        let mut assembler = TurnAssembler::default();
        for event in [
            serde_json::json!({"type": "TOOL_CALL_START", "toolCallId": "c1", "toolCallName": ADD_PLUGIN_ACCOUNT}),
            serde_json::json!({"type": "TOOL_CALL_END", "toolCallId": "c1"}),
            serde_json::json!({"type": "TOOL_CALL_RESULT", "toolCallId": "c1", "ok": true,
                "content": "{\"plugin\":\"cloudflare\",\"connector\":\"cloudflare\",\"card\":\"shown\"}"}),
        ] {
            assembler.push_event(&event);
        }
        let card = assembler
            .snapshot()
            .1
            .into_iter()
            .find_map(|part| match part {
                ChatPart::PluginNeeds(card) => Some(card),
                _ => None,
            });
        let card = card.expect("the account card");
        assert!(!card.send_again);
        assert_eq!(card.needs[0].kind, PluginNeedKind::Account);
    }
}
