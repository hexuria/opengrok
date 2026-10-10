use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub email: String,
    #[serde(default)]
    pub first_name: String,
    #[serde(default)]
    pub last_name: String,
    #[serde(default)]
    pub avatar_url: Option<String>,
    #[serde(default)]
    pub org_id: Option<String>,
    #[serde(default)]
    pub verified: bool,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub is_admin: Option<bool>,
    /// The IANA zone the person's routines default to, from a server that keeps one, which
    /// sends the key on every read, `null` until set (opengrok-server #322, on main since
    /// c0bb6ae: `account_json` in `crates/opengrok-server/src/account_api.rs`, #316).
    /// `None` is the key left out: a server before it, which is never sent one.
    #[serde(default, deserialize_with = "super::inference::keyed")]
    pub time_zone: Option<Option<String>>,
}

impl Account {
    pub fn display_name(&self) -> String {
        let name = format!("{} {}", self.first_name, self.last_name)
            .trim()
            .to_string();
        if name.is_empty() {
            self.email.clone()
        } else {
            name
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProfileUpdate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Coworker {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub avatar_shape: Option<String>,
    #[serde(default)]
    pub avatar_color: Option<String>,
    /// Hire/rename time from the server. Idle bots (no messages) sort by this.
    #[serde(default, alias = "updated_at_ms", alias = "updatedAt")]
    pub updated_at_ms: i64,
    #[serde(default, alias = "hiddenFromSidebar")]
    pub hidden_from_sidebar: bool,
    #[serde(default, alias = "boxId", alias = "box_id")]
    pub box_id: Option<String>,
    /// How hard it thinks before it answers, in the server's word: `inherit`, `none`, or a level
    /// of its model's ([`ModelEntry::efforts`]), kept as the server sent it so the settings never
    /// show a value the server does not hold. Missing is a server from before
    /// opengrok-server#271, which keeps no effort and sends none on a turn: that reads as
    /// `inherit` ([`Self::effort`]), and nothing offers to change what that server has nowhere to
    /// keep.
    #[serde(default)]
    pub effort: Option<String>,
    /// Who may use this bot: `private`, its owner alone, or `org`, shared with the owner's
    /// organization. Transcribed from opengrok-server `agui/routes.rs` `coworker_row`, which
    /// writes it on every row, as `fixtures/wire/rest/GET__coworkers/` records both words. The
    /// app reads it through [`Self::is_shared`].
    #[serde(default)]
    pub visibility: Option<String>,
    /// Which door the Bot's replies go through ([`CoworkerSource`]), read from `source`, which
    /// may be missing, `null` or a word, and each of the three says something different.
    #[serde(default, deserialize_with = "coworker_source")]
    pub source: CoworkerSource,
}

/// Which door a Bot's replies go through, as its row says it: `"source": "gateway" |
/// "local_proxy" | null`, and `PATCH /coworkers/{id}` takes the same word (opengrok-server
/// main d6f640e (#307, after #304), pin bf99845: `coworker_row` in
/// `crates/opengrok-server/src/agui/routes.rs`). A server with per-Bot doors writes the key, a
/// word or `null` and never left out, on every row it answers with: the roster's
/// (`GET /coworkers`), a hire's (`POST /coworkers`) and a PATCH's. It mounts no
/// `GET /coworkers/{id}`, so those three are where a Bot's door is read. `null` is a Bot that
/// follows the account's setting, Settings → Reply source, and on the person's plan it answers
/// with the account's plan model whatever it is pinned to: only a Bot whose own door is
/// `local_proxy` is answered there with its pin. A server from before it writes no key at all,
/// and every Bot there goes where the account's setting says, answering on the person's plan with
/// the account's plan model whatever the Bot is pinned to. The two are told apart here because
/// the picker offers a Bot its own plan model only where the server would keep one.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum CoworkerSource {
    /// The row carries no `source`: a server from before per-Bot doors.
    #[default]
    NotKept,
    /// `null`: the account's own door.
    AccountDefault,
    /// The Bot's own door.
    Kind(super::InferenceKind),
    /// A word this app has not heard of, kept as the server sent it: a door this app cannot name
    /// is not claimed to be either of the two it can, and the server goes by its own word.
    Unknown(String),
}

/// `source` as a row brings it. The key is there (the field's default covers a row without it),
/// so `null` is the account's door; anything but a known word is kept as sent rather than failing
/// the roster, as one row's `effort` never does.
fn coworker_source<'de, D>(deserializer: D) -> Result<CoworkerSource, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(
        match Option::<serde_json::Value>::deserialize(deserializer)? {
            None => CoworkerSource::AccountDefault,
            Some(serde_json::Value::String(word)) => super::InferenceKind::from_word(&word)
                .map_or(CoworkerSource::Unknown(word), CoworkerSource::Kind),
            Some(other) => CoworkerSource::Unknown(other.to_string()),
        },
    )
}

/// How hard a coworker thinks before it answers is a word of the server's: every roster row
/// carries one under `effort`, and `PATCH /coworkers/{id}` takes one (opengrok-server#271, the
/// shape agreed with the server before it landed). `inherit` is a coworker with none set, whose
/// turns send the gateway no effort, so the model's route decides; any other word goes to the
/// gateway as the turn's `reasoning_effort`, taken when the run starts. Some models ignore it,
/// and the server cannot know which. What a model takes is its own to say: `GET /models` lists
/// each model's levels ([`ModelEntry::efforts`]), `ultra` among them for a model that has one,
/// and the picker offers those and no others, so this app keeps no list of the words itself.
///
/// The effort of a coworker with none set, and of every coworker on a server that keeps none.
pub const EFFORT_INHERIT: &str = "inherit";

impl Coworker {
    /// The effort its turns run with, in the server's word: `inherit` where the server keeps none.
    pub fn effort(&self) -> &str {
        self.effort.as_deref().unwrap_or(EFFORT_INHERIT)
    }

    /// Shared with the owner's organization, so the people in it use this bot too, and a bot
    /// used by others lets them read the skills attached to it (opengrok-server#270). Only the
    /// server's `org` says so: a row that does not say, or says a word this app does not know,
    /// is not claimed as shared.
    pub fn is_shared(&self) -> bool {
        self.visibility.as_deref() == Some("org")
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoworkerPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_shape: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_color: Option<String>,
    // No `notifyOnUpdates`: opengrok-server reads it nowhere, on purpose (`agui/routes.rs`,
    // the coworker PATCH), and refuses a patch carrying only that with a 400. The desktop
    // client keeps that setting on the machine, and NativeChat has nowhere to keep it yet.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden_from_sidebar: Option<bool>,
    /// A level of the model's ([`ModelEntry::efforts`]) or `inherit`, sent only when the person
    /// changed it: absent leaves the stored effort alone, and `inherit` clears it
    /// (opengrok-server#271, which reads `null` the same way). The server refuses a word it does
    /// not know with a 400 and changes nothing (`effort must be one of inherit, none, low,
    /// medium, high, xhigh, max, ultra`), and so it does a level the model does not list, in
    /// words that name the ones it does (`effort: gpt-6-luna takes low, medium, high, xhigh or
    /// max, not "none"`), and `ultra` where no listing of the model names it (`effort: no
    /// listing of xai/grok-4.6 names "ultra", and it is taken only where one does`):
    /// opengrok-server #342 (main 2136ffc), `effort_refused` in
    /// `crates/opengrok-server/src/inference.rs`, which `repin_coworker` in
    /// `crates/opengrok-server/src/agui/routes.rs` asks. It refuses a word on a coworker shared
    /// with the caller with a 403, as it does every change there but the sidebar flag.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// The Bot's own door, sent with the model the model picker put it on, and only to a server
    /// whose rows carry `source` (opengrok-server main d6f640e (#307, after #304), pin bf99845:
    /// `repin_coworker` in `crates/opengrok-server/src/agui/routes.rs`):
    /// absent leaves the door alone. The server refuses with a 400 in its own words, `model: ` and
    /// the sentence its subscription allowlist refuses the account's plan model with, a patch
    /// whose whole body leaves the Bot on `local_proxy` with a model the allowlist does not take;
    /// and a `source` that is neither of its two words (`source must be "gateway" or
    /// "local_proxy"`), which this app never sends, sending only an
    /// [`InferenceKind`](super::InferenceKind). Either way it writes nothing. A teammate's patch of
    /// a shared Bot is refused with a 403, as every change there but the sidebar flag is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<super::InferenceKind>,
}

impl CoworkerPatch {
    pub fn is_empty(&self) -> bool {
        self.name.is_none()
            && self.model.is_none()
            && self.role.is_none()
            && self.title.is_none()
            && self.avatar_shape.is_none()
            && self.avatar_color.is_none()
            && self.hidden_from_sidebar.is_none()
            && self.effort.is_none()
            && self.source.is_none()
    }
}

/// One of the account's conversations, as `GET /ag-ui/threads` lists it.
///
/// Transcribed from `ThreadListRow` in opengrok-server
/// `crates/opengrok-server/src/agui/routes.rs` (hexuria/opengrok-server#247, for #230). The list
/// is the caller's own threads, newest first, without hidden runs or the MCP door's audit thread.
/// The server sends `coworkerId` and `title` as `null` when there is none, never leaves them out.
/// Every other field is always there, so a row without one is refused rather than read as zero:
/// a time of zero would date the thread 1970 and hand the pager a cursor that ends the list.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadListing {
    pub thread_id: String,
    #[serde(default)]
    pub coworker_id: Option<String>,
    /// `chat`, `schedule`, `webhook` or `monitor`: whether a person started the thread or one of
    /// their routines did.
    pub origin: String,
    /// A routine's name, or the first line of the first thing the person said.
    #[serde(default)]
    pub title: Option<String>,
    pub last_run_id: String,
    pub last_status: String,
    /// The thread's latest activity. The list is ordered by it, and a page's last row hands it
    /// back as the cursor for the next page.
    pub updated_at_ms: i64,
}

/// One level of effort a model takes, as `GET /models` lists it under `efforts`: the word the
/// server keeps and a `PATCH /coworkers/{id}` takes (`low`, `medium`, `ultra`), and what the model
/// calls it, which is a word of the source's own (opencodex says "Low Effort").
///
/// Transcribed from opengrok-server #342 (main 2136ffc): `Level` and `Levels::of` in
/// `crates/opengrok-core/src/catalogue.rs`, which `Model::entry` there writes on every row
/// `list_models` in `crates/opengrok-server/src/agui/routes.rs` lists. The server sends a `label`
/// on every level, showing one that was missing or blank as the `value`, and drops an entry that
/// has no `value`; this app reads a listing the same way, so one odd entry never takes the slider
/// from a model. The recording holds the shape in `fixtures/wire/rest/GET__models/`, which
/// `opengrok/conformance.rs` reads (`a_models_levels_are_read_as_the_server_recorded_them`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffortLevel {
    pub value: String,
    pub label: String,
}

/// A model of `GET /models`. Its `efforts` and `ownEffort` are from opengrok-server #342 (main
/// 2136ffc): `Model::entry` in `crates/opengrok-core/src/catalogue.rs` writes both on every row,
/// the gateway's and the person's plan's alike, `null` where the source publishes none
/// ([`EffortLevel`]).
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
pub struct ModelEntry {
    pub id: String,
    /// Which door serves it, `gateway` or `local_proxy` (the inference-source contract agreed
    /// with open-ai-gateway and opengrok-server, 2026-09-30, built in opengrok-server #294:
    /// `list_models` in `crates/opengrok-server/src/agui/routes.rs`, `listed` in
    /// `crates/opengrok-harness/src/local_proxy.rs`): a `local_proxy` entry is one of
    /// opencodex's models, as the server lists them for the person's own subscription. Kept as
    /// the word the server sent and read through [`Self::source`].
    #[serde(default)]
    pub source: Option<String>,
    /// For one of the plan's models, which way the server reaches it: `loopback`, listed by
    /// opencodex on the server's machine, or `mac`, listed by the opencodex of the Mac holding
    /// the relay (opengrok-server #292: `listed` in `crates/opengrok-harness/src/local_proxy.rs`,
    /// server main cad36fd (#303, after #298), pin 47a5d6b). Kept as the word
    /// sent and read through [`Self::plan_via`].
    #[serde(default)]
    pub via: Option<String>,
    /// The levels of effort the model takes, lowest first: `[{value, label}]`, or `null` when
    /// the source the model comes from publishes none. The app never works them out for a model
    /// that lists none: a slider drawn from a guess would offer a stop the server then refuses.
    /// An entry with no `value` is no level, and one with no `label` is called by its value, as
    /// the server reads a listing itself; a list with no level left is none.
    #[serde(default, deserialize_with = "effort_levels_or_none")]
    pub efforts: Option<Vec<EffortLevel>>,
    /// The `value` of the level the model runs at when a Bot chooses none, `null` when the
    /// source publishes none. Read through [`Self::own_level`], which holds it to the levels
    /// listed.
    #[serde(default, rename = "ownEffort", deserialize_with = "own_effort_or_none")]
    pub own_effort: Option<String>,
    /// For one of the gateway's models, the upstream it is served from: `anthropic`, `xai`, an
    /// operator's endpoint such as `merge`, or `oag` for a virtual name. The picker groups the
    /// gateway's models by it. Absent from a server before it, and from the plan's models.
    /// Transcribed from `Model::entry` in opengrok-server's `crates/opengrok-core/src/catalogue.rs`
    /// (gol/tools-and-skill-packs, 9 Oct 2026), which copies open-ai-gateway's `oag.provider`.
    #[serde(default)]
    pub provider: Option<String>,
    /// The kind of credential a pinned row is reached through, `api` or `sub`, from the same
    /// change (open-ai-gateway's `oag.channel`). Absent where the row pins none.
    #[serde(default)]
    pub channel: Option<String>,
}

impl ModelEntry {
    /// The door this model is served through. A server from before reply sources sends no
    /// `source`, and every model it lists is the gateway's. A word this app has not heard of is
    /// `None`, and such a model is offered by neither picker rather than guessed into one.
    pub fn source(&self) -> Option<super::InferenceKind> {
        match self.source.as_deref() {
            None => Some(super::InferenceKind::Gateway),
            Some(word) => super::InferenceKind::from_word(word),
        }
    }

    /// One of the person's own plan's models, which Settings → Reply source offers, and a Bot's
    /// model picker in its plan group where the server keeps a door per Bot.
    pub fn is_local_proxy(&self) -> bool {
        self.source() == Some(super::InferenceKind::LocalProxy)
    }

    /// The way the server reaches one of the plan's models: `loopback` when the entry names none,
    /// as a server before the relay lists only those, and `None` for the gateway's models and for
    /// a way this app has not heard of, which neither of the plan's pickers offers.
    pub fn plan_via(&self) -> Option<super::Via> {
        if !self.is_local_proxy() {
            return None;
        }
        match self.via.as_deref() {
            None => Some(super::Via::Loopback),
            Some(word) => super::Via::from_word(word),
        }
    }

    /// The level the model runs at when a Bot chooses none: the one `ownEffort` names, as long
    /// as the model lists it. A word that is not one of its levels is no level to light.
    pub fn own_level(&self) -> Option<&EffortLevel> {
        let own = self.own_effort.as_deref()?;
        self.efforts
            .as_ref()?
            .iter()
            .find(|level| level.value == own)
    }
}

/// A key of a row that this app reads as far as it can, and as none beyond: whatever the row
/// holds there that it cannot make anything of is no more than the key missing, and never fails
/// the list of models.
fn read_or_none<'de, D, T>(
    deserializer: D,
    read: fn(&serde_json::Value) -> Option<T>,
) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<serde_json::Value>::deserialize(deserializer)?
        .as_ref()
        .and_then(read))
}

/// `efforts` as a row brings it ([`effort_levels`]).
fn effort_levels_or_none<'de, D>(deserializer: D) -> Result<Option<Vec<EffortLevel>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    read_or_none(deserializer, effort_levels)
}

/// `ownEffort` as a row brings it: a word, or `null`; anything else is none.
fn own_effort_or_none<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    read_or_none(deserializer, |raw| word(raw).map(str::to_string))
}

/// The levels `efforts` lists: `[{value, label}]` lowest first, as the server reads a listing
/// itself (`Levels::of`): an entry with no `value` is no level, and one with no `label` is
/// called by its value. A list with no level left is none.
fn effort_levels(raw: &serde_json::Value) -> Option<Vec<EffortLevel>> {
    let levels: Vec<EffortLevel> = raw
        .as_array()?
        .iter()
        .filter_map(|row| {
            let value = word(row.get("value")?)?;
            let label = row.get("label").and_then(word).unwrap_or(value);
            Some(EffortLevel {
                value: value.to_string(),
                label: label.to_string(),
            })
        })
        .collect();
    (!levels.is_empty()).then_some(levels)
}

/// A word: a string with something in it.
fn word(raw: &serde_json::Value) -> Option<&str> {
    raw.as_str().filter(|word| !word.trim().is_empty())
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ModelCatalogue {
    #[serde(default)]
    pub models: Vec<ModelEntry>,
    #[serde(default)]
    pub note: Option<String>,
    /// Whether opencodex answered the server as it listed these, `"localProxy": {"healthy"}`:
    /// there whenever the account keeps a proxy address, whatever its reply source, and absent
    /// while it keeps none (the inference-source contract agreed with opengrok-server
    /// 2026-09-30, built in its #294: `list_models` in
    /// `crates/opengrok-server/src/agui/routes.rs`, `listed` in
    /// `crates/opengrok-harness/src/local_proxy.rs`). A proxy that is down lists nothing, and
    /// this is how that reads apart from a plan with nothing to offer. One this app cannot read
    /// is none: the list a Bot's model picker is drawn from never fails for it.
    #[serde(
        default,
        rename = "localProxy",
        deserialize_with = "proxy_status_or_none"
    )]
    pub local_proxy: Option<LocalProxyStatus>,
}

/// `GET /models`' word on the person's own proxy (see [`ModelCatalogue::local_proxy`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct LocalProxyStatus {
    /// opencodex answered its `/healthz` when the server asked.
    pub healthy: bool,
    /// A Mac holds the relay, so the models listed through it are its opencodex's word now
    /// (opengrok-server #292: server main cad36fd (#303, after #298), pin 47a5d6b). False from a
    /// server before the relay, which lists none that way.
    #[serde(default, rename = "relayConnected")]
    pub relay_connected: bool,
}

fn proxy_status_or_none<'de, D>(deserializer: D) -> Result<Option<LocalProxyStatus>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(raw.and_then(|raw| serde_json::from_value(raw).ok()))
}

/// The message a reply points at, carried beside the message that answers it.
///
/// The quote is also spelled into the user message's `content`, because today's server reads
/// only `content`. This field is what a server that understands replies should read instead:
/// it can find the quoted message itself and word the context its own way.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ReplyQuote {
    #[serde(rename = "messageId")]
    pub message_id: String,
    /// The quoted words, already clipped: a reply to a long answer names it, it does not replay it.
    pub preview: String,
    /// The person wrote the quoted message, rather than the coworker.
    #[serde(rename = "isMe")]
    pub is_me: bool,
}

#[derive(Debug, Clone)]
pub struct AguiMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub tool_call_id: Option<String>,
    pub reply_to: Option<ReplyQuote>,
    /// Files the person attached to this message, already uploaded (#90). With none, `content`
    /// goes as the plain string it always was.
    pub attachments: Vec<Attachment>,
}

/// A message goes as `{id, role, content, toolCallId?, replyTo?}`. `content` is the words, or,
/// when files ride along, an array of AG-UI 1.0 parts: a `text` part for the words and one part
/// per file (see [`Attachment::part`]). Transcribed from opengrok-server#259
/// (`crates/opengrok-wire/src/agui.rs` `Content`), which reads either.
impl Serialize for AguiMessage {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("id", &self.id)?;
        map.serialize_entry("role", &self.role)?;
        if self.attachments.is_empty() {
            map.serialize_entry("content", &self.content)?;
        } else {
            let mut parts = Vec::with_capacity(self.attachments.len() + 1);
            if !self.content.is_empty() {
                parts.push(serde_json::json!({"type": "text", "text": self.content}));
            }
            parts.extend(self.attachments.iter().map(Attachment::part));
            map.serialize_entry("content", &parts)?;
        }
        if let Some(id) = &self.tool_call_id {
            map.serialize_entry("toolCallId", id)?;
        }
        if let Some(quote) = &self.reply_to {
            map.serialize_entry("replyTo", quote)?;
        }
        map.end()
    }
}

/// A file uploaded to `POST /artifacts` for a message, as the upload answers it (the server's
/// `ArtifactRow`, camelCase, opengrok-store `postgres.rs`). Only what the app uses is read.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub mime: String,
    pub filename: String,
    pub size_bytes: u64,
}

impl Attachment {
    /// The part that names this file in a message: AG-UI 1.0 `ImagePartSchema` for a picture and
    /// `DocumentPartSchema` for anything else, each with a `FileSourceSchema` source whose
    /// provider is the server that issued the `art_` id (`ag-ui-protocol/ag-ui`
    /// `sdks/typescript/packages/core/src/generated/schemas.ts` at `b8ebd02c84`; the shape agreed
    /// on hexuria/nativechat#90).
    pub fn part(&self) -> serde_json::Value {
        let kind = if self.mime.starts_with("image/") {
            "image"
        } else {
            "document"
        };
        serde_json::json!({
            "type": kind,
            "source": {
                "type": "file",
                "value": self.id,
                "provider": "opengrok",
                "mimeType": self.mime,
            },
            "metadata": {"filename": self.filename, "sizeBytes": self.size_bytes},
        })
    }
}

/// A file sent on a thread, as `GET /artifacts?threadId=` lists it (opengrok-server#259
/// `artifacts.rs` `list_for_thread`): the row, with `meta.messageId` saying which message it
/// rode on. A row without one was uploaded and never sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SentAttachment {
    pub file: Attachment,
    pub message_id: String,
}

/// An office document's session row as `GET /office/docs/{id}` answers it (opengrok-server
/// `detail` in `crates/opengrok-server/src/office_routes.rs`, gol/betteroffice): identity,
/// kind, version, the proposals still pending — everything the document window needs except
/// the bytes and pages, which are routes of their own.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeDocDetail {
    pub doc_id: String,
    pub path: String,
    pub kind: String,
    pub version: u64,
    #[serde(default)]
    pub content_sha256: String,
    #[serde(default)]
    pub proposals: Vec<OfficeProposal>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

/// One pending proposal on an office document, as `GET /office/docs/{id}` summarizes it: the
/// change count instead of the diffs themselves — the window lists what is waiting, the
/// model's `office_review` is what reads the diffs.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeProposal {
    pub id: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub changes: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArtifactListing {
    #[serde(flatten)]
    pub file: Attachment,
    #[serde(default)]
    pub meta: serde_json::Value,
}

impl ArtifactListing {
    pub(crate) fn sent(self) -> Option<SentAttachment> {
        let message_id = self.meta.get("messageId")?.as_str()?.to_string();
        Some(SentAttachment {
            file: self.file,
            message_id,
        })
    }
}

/// Pull assistant `delta` fields out of an AG-UI SSE body (desktop Seam A
/// paints from `/events`; we consume the same TEXT_MESSAGE_CONTENT frames
/// on the `POST /ag-ui` stream).
pub fn assistant_text_from_sse(body: &str) -> Result<String, String> {
    let mut out = String::new();
    let mut persons = super::gen_ui::PersonsText::default();
    for block in body.split("\n\n") {
        for line in block.lines() {
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
                continue;
            };
            let kind = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if kind == "RUN_ERROR" {
                let message = value
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("run failed");
                return Err(message.to_string());
            }
            // The person's own words (a replay opens each run with them) are not the reply.
            let persons = kind.starts_with("TEXT_MESSAGE") && persons.is_persons(&value);
            if !persons
                && (kind == "TEXT_MESSAGE_CONTENT" || kind == "TEXT_MESSAGE_CHUNK")
                && let Some(delta) = value.get("delta").and_then(|v| v.as_str())
            {
                out.push_str(delta);
            }
        }
    }
    Ok(out)
}

/// What a refusal's JSON body says: the sentence the person is shown, and the server's code word
/// for the refusal, which is what a caller branches on. Either may be missing.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct RefusalWords {
    pub(crate) sentence: Option<String>,
    pub(crate) code: Option<String>,
}

/// Reads both of a refusal's fields, by the rule opengrok-server writes them to (its
/// error-bodies change):
///
/// - with a `code`, the code is `code` and the sentence is `error`: `{"error": "this run id
///   already has a run; a new turn needs a new run id", "code": "run-exists"}`;
/// - without one, a bare code word under `error` with a `message` beside it is the code, and the
///   `message` is the sentence: the queue's 409s, which keep that shape (`agui/pending.rs`
///   `stale-pending-message`);
/// - otherwise `error` is the sentence, and there is no code.
///
/// One case the rule leaves open is read so the queue still works: a bare code word with nothing
/// beside it (the queue's `already-consumed` and `not-pending`, which carry no `message`) is kept
/// as the code, and is all there is to show. A body with nothing under `error` gives no sentence,
/// and is shown as its own text. Shown `run-exists`, a person is shown the server's name for the
/// problem rather than the problem, which is why the sentence is read wherever it sits.
pub(crate) fn refusal_words(body: &serde_json::Value) -> RefusalWords {
    let field = |key: &str| {
        body.get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
    };
    let error = field("error");
    let message = field("message");
    if let Some(code) = field("code") {
        return RefusalWords {
            sentence: error.or(message).map(str::to_string),
            code: Some(code.to_string()),
        };
    }
    match error {
        Some(code) if is_error_code(code) => RefusalWords {
            sentence: Some(message.unwrap_or(code).to_string()),
            code: Some(code.to_string()),
        },
        error => RefusalWords {
            sentence: error.map(str::to_string),
            code: None,
        },
    }
}

/// What a refusal says to the person: the sentence of a JSON body ([`refusal_words`]), or a text
/// body's own text.
pub fn error_message_from_body(body: &str) -> String {
    if let Some(sentence) = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|body| refusal_words(&body).sentence)
    {
        return sentence;
    }
    let trimmed = body.trim();
    if trimmed.is_empty() {
        "request failed".to_string()
    } else {
        trimmed.to_string()
    }
}

/// The server's code word for a refusal, when its body names one ([`refusal_words`]).
pub(crate) fn error_code_from_body(body: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|body| refusal_words(&body).code)
}

/// Whether OpenGrok wrote this refusal itself, which it says by its shape: a JSON object with its
/// sentence under `error`. Nothing standing in front of the server writes that (a proxy answers
/// with its own page, or with nothing), so it is how a `502` the server wrote about a box that is
/// down is told from a `502` that means the server itself could not be reached.
pub(crate) fn written_by_opengrok(body: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|body| {
            body.get("error")
                .and_then(serde_json::Value::as_str)
                .map(|error| !error.trim().is_empty())
        })
        .unwrap_or(false)
}

/// A code word rather than a sentence: one lowercase token of letters and digits joined by `-`
/// or `_`, with no spaces (`run-exists`, `stale-pending-message`, `shared-computer`).
fn is_error_code(text: &str) -> bool {
    text.starts_with(|c: char| c.is_ascii_lowercase())
        && text
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every key a coworker patch can carry is one the server's patch route reads
    /// (opengrok-server `agui/routes.rs`: name, model, role, visibility, hiddenFromSidebar, and
    /// title/avatarShape/avatarColor; `effort` from opengrok-server#271; `source` from
    /// opengrok-server main d6f640e (#307, after #304), pin bf99845). A key it reads nowhere
    /// is a setting that looks saved and is not, and a patch of only that is refused.
    #[test]
    fn a_coworker_patch_names_only_what_the_server_keeps() {
        let full = CoworkerPatch {
            name: Some("n".into()),
            model: Some("m".into()),
            role: Some("r".into()),
            title: Some("t".into()),
            avatar_shape: Some("s".into()),
            avatar_color: Some("c".into()),
            hidden_from_sidebar: Some(true),
            effort: Some("high".into()),
            source: Some(super::super::InferenceKind::LocalProxy),
        };
        let wire = serde_json::to_value(&full).unwrap();
        let mut keys: Vec<&str> = wire
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        let read = [
            "avatarColor",
            "avatarShape",
            "effort",
            "hiddenFromSidebar",
            "model",
            "name",
            "role",
            "source",
            "title",
            "visibility",
        ];
        for key in &keys {
            assert!(read.contains(key), "the server reads no {key:?}");
        }
        assert_eq!(keys.len(), 9, "every field is on the wire: {keys:?}");
        assert_eq!(wire["source"], "local_proxy", "the door goes as its word");
    }

    /// A row's `source` says three different things by being missing, `null` or a word: a server
    /// from before per-Bot doors, a Bot that follows the account's door, and the Bot's own door
    /// (opengrok-server main d6f640e (#307, after #304), pin bf99845).
    /// A word this app has not heard of is kept as sent, and no row's door ever fails the roster.
    #[test]
    fn a_rows_door_is_missing_null_or_its_word() {
        use super::super::InferenceKind;
        let roster: Vec<Coworker> = serde_json::from_value(serde_json::json!([
            {"id": "cw_old", "name": "Old", "model": "oag/cheap"},
            {"id": "cw_default", "name": "Default", "model": "oag/cheap", "source": null},
            {"id": "cw_plan", "name": "Plan", "model": "gpt-6-luna", "source": "local_proxy"},
            {"id": "cw_keys", "name": "Keys", "model": "oag/cheap", "source": "gateway"},
            {"id": "cw_odd", "name": "Odd", "model": "oag/cheap", "source": "byok"},
            {"id": "cw_worse", "name": "Worse", "model": "oag/cheap", "source": 7}
        ]))
        .expect("one row's door never fails the roster");
        let doors: Vec<CoworkerSource> = roster.into_iter().map(|bot| bot.source).collect();
        assert_eq!(
            doors,
            vec![
                CoworkerSource::NotKept,
                CoworkerSource::AccountDefault,
                CoworkerSource::Kind(InferenceKind::LocalProxy),
                CoworkerSource::Kind(InferenceKind::Gateway),
                CoworkerSource::Unknown("byok".into()),
                CoworkerSource::Unknown("7".into()),
            ]
        );
    }

    /// A roster from a server before opengrok-server#271 has no `effort` on its rows, and every
    /// row still parses: it is a server that keeps none, so its bots run on `inherit`. A word
    /// this app has not heard of is kept as the server sent it rather than failing the roster,
    /// or being read as another word the server does not hold.
    #[test]
    fn a_rows_effort_reads_as_sent_and_a_missing_one_as_inherit() {
        let roster: Vec<Coworker> = serde_json::from_value(serde_json::json!([
            {"id": "cw_old", "name": "Old", "model": "oag/cheap"},
            {"id": "cw_new", "name": "New", "model": "oag/cheap", "effort": "ultra"},
            {"id": "cw_set", "name": "Set", "model": "oag/cheap", "effort": "xhigh"},
            {"id": "cw_unset", "name": "Unset", "model": "oag/cheap", "effort": "inherit"}
        ]))
        .expect("one row's effort never fails the roster");
        let efforts: Vec<(Option<&str>, &str)> = roster
            .iter()
            .map(|coworker| (coworker.effort.as_deref(), coworker.effort()))
            .collect();
        assert_eq!(
            efforts,
            vec![
                (None, "inherit"),
                (Some("ultra"), "ultra"),
                (Some("xhigh"), "xhigh"),
                (Some("inherit"), "inherit"),
            ]
        );
    }

    /// The effort rides a patch only when it is set, so a Save that did not touch it leaves the
    /// body a server before opengrok-server#271 already reads.
    #[test]
    fn a_patch_without_an_effort_leaves_the_key_off() {
        let patch = CoworkerPatch {
            name: Some("Bob".into()),
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_value(&patch).unwrap(),
            serde_json::json!({"name": "Bob"})
        );
        let effort = CoworkerPatch {
            effort: Some("inherit".into()),
            ..Default::default()
        };
        assert!(!effort.is_empty(), "an effort alone is a change to send");
        assert_eq!(
            serde_json::to_value(&effort).unwrap(),
            serde_json::json!({"effort": "inherit"})
        );
    }

    /// A `/models` entry says which door serves it. A server from before reply sources sends
    /// none, and its models are the gateway's; a word this app has not heard of names neither
    /// door, and one entry's word never fails the list.
    #[test]
    fn a_models_source_reads_as_sent_and_a_missing_one_as_the_gateway() {
        use super::super::InferenceKind;
        let catalogue: ModelCatalogue = serde_json::from_value(serde_json::json!({
            "models": [
                {"id": "oag/cheap"},
                {"id": "oag/fast", "source": "gateway", "points": null},
                {"id": "gpt-5-codex", "source": "local_proxy"},
                {"id": "odd", "source": "byok"},
                {"id": "nulled", "source": null}
            ],
            "note": null
        }))
        .expect("one entry's source never fails the list");
        let sources: Vec<(&str, Option<InferenceKind>)> = catalogue
            .models
            .iter()
            .map(|entry| (entry.id.as_str(), entry.source()))
            .collect();
        assert_eq!(
            sources,
            vec![
                ("oag/cheap", Some(InferenceKind::Gateway)),
                ("oag/fast", Some(InferenceKind::Gateway)),
                ("gpt-5-codex", Some(InferenceKind::LocalProxy)),
                ("odd", None),
                ("nulled", Some(InferenceKind::Gateway)),
            ]
        );
    }

    /// A model lists the levels of effort it takes, lowest first, and the one it runs at when a
    /// Bot chooses none (opengrok-server #342 (main 2136ffc): `Levels::of` in
    /// `crates/opengrok-core/src/catalogue.rs`). Both are `null` where the source publishes
    /// nothing and then read as none, as when the keys are missing; the app never works a model's
    /// levels out. A level with no label is called by its value, as the server calls it, and an
    /// entry with no value is no level; an empty list, one with no level left, and an own level
    /// the model does not list are none, and never fail the list.
    #[test]
    fn a_models_levels_of_effort_read_as_sent_and_as_none_where_there_are_none() {
        let catalogue: ModelCatalogue = serde_json::from_value(serde_json::json!({
            "models": [
                {"id": "gpt-6-luna", "source": "local_proxy", "ownEffort": "medium", "efforts": [
                    {"value": "low", "label": "Low Effort"},
                    {"value": "medium", "label": "Medium Effort"},
                    {"value": "max", "label": "Max Effort"}
                ]},
                {"id": "oag/cheap", "efforts": null, "ownEffort": null},
                {"id": "oag/fast"},
                {"id": "empty", "efforts": [], "ownEffort": "medium"},
                {"id": "half", "efforts": [{"value": "low"}, {"value": "high", "label": "High"}]},
                {"id": "unlabelled", "efforts": [{"value": "medium", "label": "  "}]},
                {"id": "dropped", "efforts": [
                    {"label": "Nameless"}, {"value": "max", "label": "Max Effort"}
                ]},
                {"id": "blank", "efforts": [{"value": "", "label": "Low"}]},
                {"id": "odd", "efforts": "low", "ownEffort": 3},
                {"id": "unlisted", "ownEffort": "ultra", "efforts": [
                    {"value": "low", "label": "Low"}
                ]}
            ],
            "note": null
        }))
        .expect("one entry's levels never fail the list");
        let read = |id: &str| {
            catalogue
                .models
                .iter()
                .find(|entry| entry.id == id)
                .unwrap_or_else(|| panic!("{id} is listed"))
        };
        let luna = read("gpt-6-luna");
        assert_eq!(
            luna.efforts.as_ref().map(|levels| levels
                .iter()
                .map(|l| (l.value.as_str(), l.label.as_str()))
                .collect::<Vec<_>>()),
            Some(vec![
                ("low", "Low Effort"),
                ("medium", "Medium Effort"),
                ("max", "Max Effort")
            ])
        );
        assert_eq!(luna.own_effort.as_deref(), Some("medium"));
        assert_eq!(
            luna.own_level().map(|level| level.value.as_str()),
            Some("medium")
        );
        let called = |id: &str| -> Vec<(String, String)> {
            read(id)
                .efforts
                .iter()
                .flatten()
                .map(|level| (level.value.clone(), level.label.clone()))
                .collect()
        };
        let pair = |value: &str, label: &str| (value.to_string(), label.to_string());
        assert_eq!(
            called("half"),
            [pair("low", "low"), pair("high", "High")],
            "no label: the value"
        );
        assert_eq!(
            called("unlabelled"),
            [pair("medium", "medium")],
            "a blank label too"
        );
        assert_eq!(
            called("dropped"),
            [pair("max", "Max Effort")],
            "no value, no level"
        );
        for none in ["oag/cheap", "oag/fast", "empty", "blank", "odd"] {
            let entry = read(none);
            assert_eq!(entry.efforts, None, "{none}");
            assert_eq!(entry.own_level(), None, "{none}");
        }
        assert_eq!(read("empty").own_effort.as_deref(), Some("medium"));
        assert_eq!(read("odd").own_effort, None, "not a word");
        let unlisted = read("unlisted");
        assert_eq!(unlisted.own_effort.as_deref(), Some("ultra"));
        assert_eq!(
            unlisted.own_level(),
            None,
            "a level it does not list is none to light"
        );
    }

    /// The listings opengrok-server's own tests record of `GET /models`, transcribed as they are
    /// (opengrok-server #342 (main 2136ffc):
    /// `crates/opengrok-server/tests/against_a_models_own_levels.rs`): the plan's gpt-6-sol with
    /// six levels, up to `ultra`, and gpt-6-luna with five beside a model with none, and the
    /// gateway's route with three beside one with none. Each row carries `points`, `source` and
    /// `via` as before, and `efforts` and `ownEffort`, both `null` where the source publishes none.
    #[test]
    fn the_listings_the_server_branch_records_are_read_as_they_say() {
        use crate::opengrok::{InferenceKind, Via};
        let level = |word: &str| {
            serde_json::json!({
                "value": word,
                "label": format!("{}{} Effort", word[..1].to_uppercase(), &word[1..])
            })
        };
        let six = ["low", "medium", "high", "xhigh", "max", "ultra"].map(level);
        let five = ["low", "medium", "high", "xhigh", "max"].map(level);
        let three = ["low", "medium", "high"].map(level);
        let plan: ModelCatalogue = serde_json::from_value(serde_json::json!({
            "models": [
                {"id": "gpt-6-sol", "points": null, "source": "local_proxy", "via": "loopback",
                 "efforts": six, "ownEffort": "medium"},
                {"id": "gpt-6-luna", "points": null, "source": "local_proxy", "via": "loopback",
                 "efforts": five, "ownEffort": "medium"},
                {"id": "xai/grok-4.6", "points": null, "source": "local_proxy",
                 "via": "loopback", "efforts": null, "ownEffort": null}
            ],
            "note": null
        }))
        .expect("the plan's listing");
        let gateway: ModelCatalogue = serde_json::from_value(serde_json::json!({
            "models": [
                {"id": "openai/gpt-6-luna", "points": null, "source": "gateway",
                 "efforts": three, "ownEffort": "medium"},
                {"id": "xai/grok-4.6", "points": null, "source": "gateway",
                 "efforts": null, "ownEffort": null}
            ],
            "note": null
        }))
        .expect("the gateway's listing");
        let called = |entry: &ModelEntry| -> Vec<(String, String)> {
            entry
                .efforts
                .iter()
                .flatten()
                .map(|level| (level.value.clone(), level.label.clone()))
                .collect()
        };
        let pair = |value: &str, label: &str| (value.to_string(), label.to_string());
        let [sol, luna, grok] = &plan.models[..] else {
            panic!("three models")
        };
        assert_eq!(
            called(sol),
            [
                pair("low", "Low Effort"),
                pair("medium", "Medium Effort"),
                pair("high", "High Effort"),
                pair("xhigh", "Xhigh Effort"),
                pair("max", "Max Effort"),
                pair("ultra", "Ultra Effort")
            ]
        );
        assert_eq!(
            called(luna),
            [
                pair("low", "Low Effort"),
                pair("medium", "Medium Effort"),
                pair("high", "High Effort"),
                pair("xhigh", "Xhigh Effort"),
                pair("max", "Max Effort")
            ]
        );
        for plan_model in [sol, luna] {
            assert_eq!(
                plan_model.own_level().map(|level| level.value.as_str()),
                Some("medium")
            );
        }
        assert_eq!(
            (sol.plan_via(), luna.plan_via(), grok.plan_via()),
            (
                Some(Via::Loopback),
                Some(Via::Loopback),
                Some(Via::Loopback)
            )
        );
        assert_eq!((grok.efforts.as_ref(), grok.own_level()), (None, None));
        let [luna, grok] = &gateway.models[..] else {
            panic!("two models")
        };
        assert_eq!(
            called(luna),
            [
                pair("low", "Low Effort"),
                pair("medium", "Medium Effort"),
                pair("high", "High Effort")
            ]
        );
        assert_eq!(luna.own_effort.as_deref(), Some("medium"));
        assert_eq!((grok.efforts.as_ref(), grok.own_level()), (None, None));
        assert_eq!(luna.source(), Some(InferenceKind::Gateway));
    }

    /// `localProxy` says whether opencodex answered as the server listed its models: read when
    /// there, none when the account keeps no proxy address, and none, not a failed list, when it
    /// is in a shape this app cannot read.
    #[test]
    fn a_models_list_says_whether_the_proxy_answered() {
        let read = |body: serde_json::Value| -> ModelCatalogue {
            serde_json::from_value(body).expect("the list is read whatever localProxy says")
        };
        let up = read(serde_json::json!({
            "models": [{"id": "gpt-5-codex", "source": "local_proxy", "points": null}],
            "note": null,
            "localProxy": {"healthy": true}
        }));
        assert_eq!(
            up.local_proxy,
            Some(LocalProxyStatus {
                healthy: true,
                relay_connected: false,
            })
        );
        assert!(up.models[0].is_local_proxy());
        let down = read(serde_json::json!({
            "models": [{"id": "oag/cheap", "source": "gateway", "points": null}],
            "note": null,
            "localProxy": {"healthy": false}
        }));
        assert_eq!(
            down.local_proxy,
            Some(LocalProxyStatus {
                healthy: false,
                relay_connected: false,
            })
        );
        assert!(!down.models[0].is_local_proxy());
        let none = read(serde_json::json!({"models": [], "note": null}));
        assert_eq!(none.local_proxy, None);
        // `?source=local_proxy` as the server builds it: the plan's models, `note: null`.
        let plan_only = read(serde_json::json!({
            "models": [{"id": "grok-4", "points": null, "source": "local_proxy"}],
            "note": null,
            "localProxy": {"healthy": true}
        }));
        assert_eq!(plan_only.note, None);
        assert!(plan_only.models[0].is_local_proxy());
        for odd in [
            serde_json::json!(null),
            serde_json::json!({}),
            serde_json::json!({"healthy": "yes"}),
            serde_json::json!(true),
        ] {
            let odd = read(serde_json::json!({
                "models": [{"id": "oag/cheap"}], "note": null, "localProxy": odd
            }));
            assert_eq!(odd.local_proxy, None);
            assert_eq!(odd.models.len(), 1);
        }
    }

    /// With the Mac relay each of the plan's models says which way the server reaches it, and
    /// `localProxy` whether a Mac holds the relay (opengrok-server PR #298, whose recording the
    /// ledger reads). A plan's model that names no way is the server's own machine's, as
    /// every one a server before the relay lists; a way this app has not heard of is neither
    /// picker's, and the gateway's models have none.
    #[test]
    fn a_plans_model_says_which_way_it_is_reached() {
        use super::super::Via;
        let catalogue: ModelCatalogue = serde_json::from_value(serde_json::json!({
            "models": [
                {"id": "oag/cheap", "source": "gateway", "points": null},
                {"id": "gpt-5-codex", "source": "local_proxy", "via": "loopback"},
                {"id": "grok-4", "source": "local_proxy", "via": "mac"},
                {"id": "gpt-5", "source": "local_proxy"},
                {"id": "odd", "source": "local_proxy", "via": "helper"},
                {"id": "stray", "source": "gateway", "via": "mac"}
            ],
            "note": null,
            "localProxy": {"healthy": false, "relayConnected": true}
        }))
        .expect("one entry's way never fails the list");
        let ways: Vec<(&str, Option<Via>)> = catalogue
            .models
            .iter()
            .map(|entry| (entry.id.as_str(), entry.plan_via()))
            .collect();
        assert_eq!(
            ways,
            vec![
                ("oag/cheap", None),
                ("gpt-5-codex", Some(Via::Loopback)),
                ("grok-4", Some(Via::Mac)),
                ("gpt-5", Some(Via::Loopback)),
                ("odd", None),
                ("stray", None),
            ]
        );
        assert_eq!(
            catalogue.local_proxy,
            Some(LocalProxyStatus {
                healthy: false,
                relay_connected: true,
            })
        );
    }

    /// The field is new: a server that has never heard of it must still see the array it saw
    /// before, field for field.
    #[test]
    fn a_message_with_no_reply_leaves_reply_to_off_the_wire() {
        let message = AguiMessage {
            id: "m1".into(),
            role: "user".into(),
            content: "hi".into(),
            tool_call_id: None,
            reply_to: None,
            attachments: Vec::new(),
        };
        let json = serde_json::to_value(&message).expect("serialises");
        assert_eq!(json["content"], "hi");
        assert!(json.get("replyTo").is_none(), "{json}");
        assert!(json.get("toolCallId").is_none(), "{json}");
    }

    /// With files, `content` is the AG-UI parts: the words first, then one part per file, a
    /// picture as `image` and anything else as `document`, each naming its `art_` id as a file
    /// the opengrok server issued (hexuria/nativechat#90, opengrok-server#259).
    #[test]
    fn files_ride_as_parts_after_the_words() {
        let file = |id: &str, mime: &str, name: &str| Attachment {
            id: id.into(),
            mime: mime.into(),
            filename: name.into(),
            size_bytes: 42,
        };
        let message = AguiMessage {
            id: "m1".into(),
            role: "user".into(),
            content: "What changed in Q3?".into(),
            tool_call_id: None,
            reply_to: None,
            attachments: vec![
                file("art_1", "application/pdf", "q3.pdf"),
                file("art_2", "image/png", "screen.png"),
            ],
        };
        let json = serde_json::to_value(&message).expect("serialises");
        assert_eq!(
            json["content"],
            serde_json::json!([
                {"type": "text", "text": "What changed in Q3?"},
                {"type": "document",
                 "source": {"type": "file", "value": "art_1", "provider": "opengrok", "mimeType": "application/pdf"},
                 "metadata": {"filename": "q3.pdf", "sizeBytes": 42}},
                {"type": "image",
                 "source": {"type": "file", "value": "art_2", "provider": "opengrok", "mimeType": "image/png"},
                 "metadata": {"filename": "screen.png", "sizeBytes": 42}}
            ])
        );
        // Files alone: no empty text part.
        let alone = AguiMessage {
            content: String::new(),
            ..message
        };
        let json = serde_json::to_value(&alone).expect("serialises");
        assert_eq!(json["content"].as_array().map(Vec::len), Some(2));
        assert_eq!(json["content"][0]["type"], "document");
    }

    #[test]
    fn a_reply_rides_along_under_reply_to() {
        let message = AguiMessage {
            id: "m2".into(),
            role: "user".into(),
            content: "what am I replying to?".into(),
            tool_call_id: None,
            reply_to: Some(ReplyQuote {
                message_id: "m1".into(),
                preview: "The build is green.".into(),
                is_me: false,
            }),
            attachments: Vec::new(),
        };
        let json = serde_json::to_value(&message).expect("serialises");
        assert_eq!(json["replyTo"]["messageId"], "m1");
        assert_eq!(json["replyTo"]["preview"], "The build is green.");
        assert_eq!(json["replyTo"]["isMe"], false);
    }

    /// A refusal with a code and a sentence is shown as the sentence, with the code kept apart,
    /// in the shape the server sends for a run that already exists (the sentence under `error`,
    /// the code under `code`, as
    /// `fixtures/wire/rest/POST__ag-ui/409-another_account_cannot_take_a_run_by_its_id.json`
    /// records it since opengrok-server's error-bodies change) and in the one it sent before (the
    /// code under `error`, the sentence under `message`), which the queue's 409s keep. `run-exists` used to reach the person as it was.
    #[test]
    fn a_code_beside_a_sentence_is_shown_as_the_sentence() {
        let said = "this run id already has a run; a new turn needs a new run id";
        let taken = r#"{"error": "run-exists", "message": "this run id already has a run; a new turn needs a new run id"}"#;
        let moved = r#"{"error": "this run id already has a run; a new turn needs a new run id", "code": "run-exists"}"#;
        for body in [taken, moved] {
            assert_eq!(error_message_from_body(body), said, "{body}");
            assert_eq!(
                error_code_from_body(body).as_deref(),
                Some("run-exists"),
                "{body}"
            );
            assert!(written_by_opengrok(body), "{body}");
        }

        let stale = r#"{"v": 1, "error": "stale-pending-message", "id": "pum_1", "message": "This queued message changed. Refresh it before sending again."}"#;
        assert_eq!(
            error_message_from_body(stale),
            "This queued message changed. Refresh it before sending again."
        );
        assert_eq!(
            error_code_from_body(stale).as_deref(),
            Some("stale-pending-message")
        );

        // A code with no sentence beside it is all the body says.
        let consumed = r#"{"v": 1, "error": "already-consumed", "id": "pum_1"}"#;
        assert_eq!(error_message_from_body(consumed), "already-consumed");
        assert_eq!(
            error_code_from_body(consumed).as_deref(),
            Some("already-consumed")
        );
        for alone in [
            r#"{"error": "run-exists", "message": ""}"#,
            r#"{"error": "run-exists", "message": "   "}"#,
            r#"{"error": "run-exists", "message": 7}"#,
        ] {
            assert_eq!(error_message_from_body(alone), "run-exists", "{alone}");
        }

        // A sentence under `error` is the sentence, whatever else the body carries, and names no
        // code.
        let sentence = r#"{"error": "form entry missing", "message": "something else"}"#;
        assert_eq!(error_message_from_body(sentence), "form entry missing");
        assert_eq!(error_code_from_body(sentence), None);
        let capital = r#"{"error": "Wrong email or password."}"#;
        assert_eq!(error_message_from_body(capital), "Wrong email or password.");
        assert_eq!(error_code_from_body(capital), None);

        // Whatever sits under `message` beside a bare code is its sentence.
        assert_eq!(
            error_message_from_body(r#"{"error": "run-exists", "message": "retry"}"#),
            "retry"
        );
        // Nothing under `error` is nothing the rule reads: the body is its own text, and
        // nothing says OpenGrok wrote it, which is a proxy's shape as much as the server's.
        let bare = r#"{"message": "Internal server error"}"#;
        assert_eq!(error_message_from_body(bare), bare);
        assert_eq!(error_code_from_body(bare), None);
        assert!(!written_by_opengrok(bare));
        let coded = r#"{"code": "run-exists"}"#;
        assert_eq!(error_message_from_body(coded), coded);
        assert_eq!(error_code_from_body(coded).as_deref(), Some("run-exists"));

        // A body that is not JSON, or has no string to say, is its own text.
        assert_eq!(error_message_from_body("  no such run \n"), "no such run");
        assert_eq!(error_code_from_body("no-such-run"), None);
        assert!(!written_by_opengrok("the box is unreachable"));
        assert!(!written_by_opengrok(
            "<html><body>502 Bad Gateway</body></html>"
        ));
        assert!(!written_by_opengrok(""));
        assert_eq!(
            error_message_from_body(r#"{"error": {"message": "nested"}}"#),
            r#"{"error": {"message": "nested"}}"#
        );
        assert_eq!(error_message_from_body(""), "request failed");
    }
}
