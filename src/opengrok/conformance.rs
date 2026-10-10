//! Wire conformance: the frames and bodies opengrok-server sends, read by this app's own code.
//!
//! This app transcribes the server's wire by hand, and nothing else checks that the two still
//! agree. `fixtures/wire/` is the server's side of that, recorded by the server itself: every
//! AG-UI frame and REST body its own tests drove, teed off its router by the recorder of
//! opengrok-server#258 and written out by its `examples/wire_corpus.rs`. It is vendored whole from
//! the server's `tests/fixtures/wire/` at opengrok-server #351 (recorded at 9a2b011, git tree
//! a0ef80f): the account events stream (#348) on main 725e1b5, which carries #349, a Bot's routine
//! tools seeing and acting on its own routines alone. Its `MANIFEST.json` names 85ce00c, the commit
//! it was recorded on. The layout is opengrok-server#255's: `agui/<type>/<slug>.json`,
//! a CUSTOM under `agui/custom/<name>/`, and `rest/<METHOD>_<route>/<status>-<slug>.json` holding
//! `{method, path, status, body}`, one file per distinct shape, named after the first test that
//! produced it; since the relay, the frames of its stream under `relay/<type>/<slug>.json`,
//! which are not AG-UI and which the Mac, not the chat, reads; and since the account events
//! stream, its blocks under `events/<name>/<slug>.json`, each kept whole as `{id, event, data}`
//! with a placeholder id. `MANIFEST.json` names the server commit, the test behind every file,
//! and every `type`, CUSTOM `name`, approval `reason`, `formResolution` word and events stream
//! note name the server's code can send. Ids and clocks the tests mint at run time
//! are placeholders in the server's own formats, and secrets read `«redacted»`.
//!
//! A newer recording is taken by copying the server's `tests/fixtures/wire/` over this one
//! whole, never by editing a file here: the files are the server's evidence, and one fixed by
//! hand would say what the server does not.
//!
//! What is held here:
//!
//! - every frame is fed to the code that handles its type and name (a relay frame to the relay's
//!   own reader), and every body is read the way this app reads its route: a success parsed with
//!   the very type the client parses it with, and a refusal with the client's own error reading.
//!   Each must come out the way the app means to read it, not merely without a panic;
//! - every route the corpus records has that reading, or is excused in [`REST_NOT_READ`] with
//!   why this app never asks it;
//! - a route this app was built to ask ahead of the server's recording of it is owed a reading
//!   in [`REST_NOT_RECORDED_YET`], which says what brings its fixtures, until the corpus holds
//!   it; and a key read ahead of its recording on a route the corpus does record waits in
//!   [`REST_FIELDS_NOT_RECORDED_YET`] until a recorded body of the route carries it;
//! - the ledger, every wire word this app branches on, is either a word the manifest says the
//!   server sends (a `RUN_ERROR`'s code, which the manifest does not list, one a recorded frame
//!   carries), excused in [`NOT_SENT_BY_SERVER`] with the evidence, or read ahead of the
//!   server's recording in [`WORDS_NOT_RECORDED_YET`], which says what brings it;
//! - every word the server sends is either in the ledger or excused in [`CLIENT_IGNORES`], so a
//!   name the server starts sending fails here before a person finds it missing on screen;
//! - [`KNOWN_DRIFT`] names the fixtures this app still reads wrongly. Their checks must fail, so
//!   an entry cannot outlive its fix.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use super::activity::{
    ActivityTick, BOX_WAKING, BotActivity, ToolCallTracker, WAKING_COMPUTER, activity_from_agui,
    activity_from_replay,
};
use super::client::{
    AddedToken, AnswerReply, AsyncRunResponse, BotSkillScope, BoxShareScope, ConnectLink,
    ConnectionAttempt, ConnectionKind, ConnectionOwner, ConnectionPin, ConnectionView, Connector,
    CoworkerCeiling, CoworkerComputer, CoworkerSkills, CoworkerUsage, DaemonEnrol, DaemonList,
    DaemonMachine, LocalExecMode, LocalExecPolicy, OpenGrokClient, PluginCatalog, PluginDetail,
    PluginInstallation, QueuedApproval, RecipeDetail, RecipeList, RecipeParameterKind,
    RecipeRunResult, RunBy, RunCause, RunReplay, SKIPPED_FIRING, ScheduleKind, ScheduleRow,
    ScheduleRun, ScheduleRunStarted, ScheduleRunStatus, SkillDetail, SkillSummary, SkillVersion,
    StopReply, ThreadReplay, ToolListing, host_egress_tunnel_available, host_egress_tunnel_flag,
};
use super::credential::{CREDENTIAL_OFFER_SAVE, SaveLoginSpec};
use super::error::{Failure, Unreachable, reads_as_gateway_unreachable};
use super::events::{ACCOUNT_EVENT_NAMES, AccountEvent, Refused, blocks_of, when_refused};
use super::gen_ui::{
    BAR_CHART_NAMES, ChatPart, EGRESS_TUNNEL_ASK_REASON, FORM_NAMES, REVIEW_AN_ACTION_REASONS,
    RUN_AWAITING_APPROVAL, ScreenshotSpec, StepSpec, TurnAssembler, UI_CUSTOM_NAME, USE_SKILL,
    USER_MACHINE_SHELL, approval_from_event, approval_summary, capped, command_from_replay_events,
    is_ui_tool,
};
use super::inference::{
    FallbackFor, INFERENCE_SOURCE_CUSTOM, InferenceKind, InferenceSource, RunErrorCode, TurnSource,
    Via, is_subscription_model,
};
use super::pending::{
    CUSTOM_NAME as PENDING_CUSTOM, PendingCustom, PendingList, PendingMutation, PendingOp,
    PendingUserMessage,
};
use super::relay::{
    RelayAnswered, RelayFrame, data_frame, relay_disabled, stream_refusal, token_turned_away,
};
use super::timing::{RUN_TIMING_CUSTOM, TURN_TIMELINE_CUSTOM, TurnTiming};
use super::types::{
    Account, ArtifactListing, Attachment, Coworker, CoworkerSource, EFFORT_INHERIT, ModelCatalogue,
    ThreadListing, assistant_text_from_sse,
};
use super::user_form::{
    BoxHandoffReply, COMPUTER_HANDOFF_NAMES, ComputerHandoffStatus, FORM_ENTRY_MISSING,
    FORM_RESOLUTION_WORDS, FormResolution, USER_FORM_CUSTOM, USER_FORM_CUSTOM_NAMES,
    USER_FORM_REASON, UserFormActionReply, UserFormSpec, WAITING_FOR_YOU,
    box_handoff_action_from_http, is_user_form_awaiting, is_user_form_tool,
    user_form_action_from_http,
};
use super::visibility::ImageVisibility;

/// Where the corpus lives, from the package root.
const CORPUS: &str = "fixtures/wire";

/// Where a wire word sits on what the server sends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Slot {
    /// A frame's `type`.
    AguiType,
    /// A CUSTOM frame's `name`.
    CustomName,
    /// `reason` on `run-awaiting-approval`, and on `GET /ag-ui/approvals` rows.
    ApprovalReason,
    /// `formResolution` on a settled user-form card.
    FormResolution,
    /// `code` on a `RUN_ERROR`, beside its sentence.
    RunErrorCode,
    /// A frame's `type` on the Mac relay's stream (`RelayFrame::from_value`), which is not an
    /// AG-UI frame: the recorder files each under `relay/<type>/`.
    RelayType,
    /// A note's `event:` name on the account's events stream (`AccountEvent::read`, opengrok-server
    /// #348), which is neither AG-UI nor the relay's.
    AccountEvent,
}

impl Slot {
    const ALL: [Slot; 7] = [
        Slot::AguiType,
        Slot::CustomName,
        Slot::ApprovalReason,
        Slot::FormResolution,
        Slot::RunErrorCode,
        Slot::RelayType,
        Slot::AccountEvent,
    ];

    fn field(self) -> &'static str {
        match self {
            Slot::AguiType => "frame type",
            Slot::CustomName => "CUSTOM name",
            Slot::ApprovalReason => "approval reason",
            Slot::FormResolution => "formResolution",
            Slot::RunErrorCode => "RUN_ERROR code",
            Slot::RelayType => "relay frame type",
            Slot::AccountEvent => "account event",
        }
    }
}

/// Every frame `type` the relay reads off the Mac relay's stream (`RelayFrame::from_value`), which
/// [`relay_frame`] holds to the frames the corpus records, and to the ones read ahead of it
/// ([`WORDS_NOT_RECORDED_YET`]). [`the_ledger_relay_types_are_read_by_the_relay`] holds it to the
/// source.
const RELAY_FRAME_TYPES: &[&str] = &[
    "ready", "replaced", "disabled", "infer", "models", "cancel", "ping",
];

/// Every AG-UI `type` this app branches on anywhere (`TurnAssembler::push_event`,
/// `activity_from_agui`, `command_from_replay_events`, the SSE readers in `client.rs` and
/// `types.rs`, `PendingCustom::from_agui`, `TurnTiming::from_event`). Those match arms are
/// literals, so [`the_ledger_types_are_the_types_the_source_matches`] holds this list to the
/// source: a type matched anywhere and missing here, or listed here and matched nowhere, fails.
const AGUI_TYPES: &[&str] = &[
    "RUN_STARTED",
    "RUN_FINISHED",
    "RUN_ERROR",
    "TEXT_MESSAGE_START",
    "TEXT_MESSAGE_CONTENT",
    "TEXT_MESSAGE_CHUNK",
    // Read in a replay: the person's message that closes with no words between is a message of
    // files alone (opengrok-server#259), kept so its files have a bubble (`persons_messages`).
    "TEXT_MESSAGE_END",
    "TOOL_CALL_START",
    "TOOL_CALL_ARGS",
    "TOOL_CALL_END",
    "TOOL_CALL_CHUNK",
    "TOOL_CALL_RESULT",
    "REASONING_START",
    "REASONING_MESSAGE_START",
    "REASONING_MESSAGE_CONTENT",
    "REASONING_MESSAGE_END",
    "REASONING_MESSAGE_CHUNK",
    "CUSTOM",
    "custom",
];

/// Every `type` in AG-UI 0.0.57 (`@ag-ui/core` `EventType`, as opengrok-wire `agui.rs`
/// transcribes it), and the one lowercase spelling this app accepts. The source scan looks for
/// these, so it catches a new match arm for any type the protocol has.
const AGUI_SPEC_TYPES: &[&str] = &[
    "TEXT_MESSAGE_START",
    "TEXT_MESSAGE_CONTENT",
    "TEXT_MESSAGE_END",
    "TEXT_MESSAGE_CHUNK",
    "TOOL_CALL_START",
    "TOOL_CALL_ARGS",
    "TOOL_CALL_END",
    "TOOL_CALL_CHUNK",
    "TOOL_CALL_RESULT",
    "THINKING_START",
    "THINKING_END",
    "THINKING_TEXT_MESSAGE_START",
    "THINKING_TEXT_MESSAGE_CONTENT",
    "THINKING_TEXT_MESSAGE_END",
    "STATE_SNAPSHOT",
    "STATE_DELTA",
    "MESSAGES_SNAPSHOT",
    "ACTIVITY_SNAPSHOT",
    "ACTIVITY_DELTA",
    "RAW",
    "CUSTOM",
    "RUN_STARTED",
    "RUN_FINISHED",
    "RUN_ERROR",
    "STEP_STARTED",
    "STEP_FINISHED",
    "REASONING_START",
    "REASONING_MESSAGE_START",
    "REASONING_MESSAGE_CONTENT",
    "REASONING_MESSAGE_END",
    "REASONING_MESSAGE_CHUNK",
    "REASONING_END",
    "REASONING_ENCRYPTED_VALUE",
    "custom",
];

/// The ledger: every wire word this app branches on, by where it sits. The names, reasons and
/// resolutions are the very constants and lists the matching code reads, so a word added there
/// lands here; the types are held to the source by a scan (see [`AGUI_TYPES`]).
fn ledger() -> Vec<(Slot, &'static str)> {
    let mut words: Vec<(Slot, &'static str)> = AGUI_TYPES
        .iter()
        .map(|word| (Slot::AguiType, *word))
        .collect();
    let names = [
        RUN_AWAITING_APPROVAL,
        BOX_WAKING,
        PENDING_CUSTOM,
        RUN_TIMING_CUSTOM,
        TURN_TIMELINE_CUSTOM,
        CREDENTIAL_OFFER_SAVE,
        UI_CUSTOM_NAME,
        // `TurnAssembler::push_event` reads which door a run went through, for the reply's badge.
        INFERENCE_SOURCE_CUSTOM,
        // `PluginNeedsSpec::from_event`: the card a tagged plugin that needs something answers
        // the turn with (#360).
        super::gen_ui::PLUGIN_NEEDS_CUSTOM,
        // `OfficeDocSpec::from_custom`: the document card and the window's tab an `office_*`
        // tool's frame drives (gol/betteroffice).
        super::gen_ui::OFFICE_DOC_CUSTOM,
        // `UiSpec::from_custom` reads a CUSTOM with no name as a widget that names itself.
        "",
    ]
    .into_iter()
    .chain(USER_FORM_CUSTOM_NAMES.iter().copied())
    .chain(COMPUTER_HANDOFF_NAMES.iter().copied())
    .chain(BAR_CHART_NAMES.iter().copied())
    .chain(FORM_NAMES.iter().copied());
    words.extend(names.map(|word| (Slot::CustomName, word)));
    words.extend(
        REVIEW_AN_ACTION_REASONS
            .iter()
            .chain([USER_FORM_REASON].iter())
            .map(|word| (Slot::ApprovalReason, *word)),
    );
    words.extend(
        FORM_RESOLUTION_WORDS
            .iter()
            .map(|(word, _)| (Slot::FormResolution, *word)),
    );
    // `RunErrorCode::from_code` reads a `RUN_ERROR`'s code, live and in a replay, and every code
    // it reads offers the turn again on the server's keys.
    words.extend(
        RunErrorCode::ALL
            .iter()
            .map(|code| (Slot::RunErrorCode, code.word())),
    );
    // `RelayFrame::from_value` reads a frame off the Mac relay's stream by its `type`.
    words.extend(
        RELAY_FRAME_TYPES
            .iter()
            .map(|word| (Slot::RelayType, *word)),
    );
    // `AccountEvent::read` reads a note off the account's events stream by its `event:` name.
    words.extend(
        ACCOUNT_EVENT_NAMES
            .iter()
            .map(|word| (Slot::AccountEvent, *word)),
    );
    words
}

/// Words this app matches that the server does not send, each checked against the server at
/// the manifest's commit (every `*.rs`, `*.ts`, `*.json` and the docs, with the snake_case,
/// camelCase and hyphenated spellings, as a `type`, a `name`, a `reason`, a field). The client
/// code for them stays until somebody decides what to do with it; this list is the record of why
/// the server never sends each.
const NOT_SENT_BY_SERVER: &[(Slot, &str, &str)] = &[
    (
        Slot::AguiType,
        "TEXT_MESSAGE_CHUNK",
        "AG-UI's shorthand for a text delta. The server's projection opens, fills and closes every \
         message (TEXT_MESSAGE_START/CONTENT/END, opengrok-harness projection.rs) and never \
         sends a chunk; it is read so another AG-UI producer still paints.",
    ),
    (
        Slot::AguiType,
        "TOOL_CALL_CHUNK",
        "AG-UI's shorthand for a tool call. The server sends TOOL_CALL_START/ARGS/END \
         (projection.rs) and never a chunk.",
    ),
    (
        Slot::AguiType,
        "REASONING_START",
        "The server opens reasoning with REASONING_MESSAGE_START and never sends \
         REASONING_START (projection.rs).",
    ),
    (
        Slot::AguiType,
        "REASONING_MESSAGE_CHUNK",
        "The server's reasoning is REASONING_MESSAGE_START/CONTENT/END (projection.rs); it sends \
         no chunk.",
    ),
    (
        Slot::AguiType,
        "custom",
        "The lowercase spelling timing.rs accepts for a run-timing frame. opengrok-wire \
         serialises EventType in SCREAMING_SNAKE_CASE, so the server only ever says CUSTOM.",
    ),
    (
        Slot::CustomName,
        "turn-timeline",
        "The name first proposed for run-timing. The harness names the frame run-timing \
         (opengrok-harness timing.rs RUN_TIMING_NAME); no server file says turn-timeline.",
    ),
    (
        Slot::CustomName,
        "form-request",
        "No frame is named form-request or form_request. formRequest is a field: the user-form \
         card's message.formRequest (cards.rs user_form_card) and its alias on the stamped \
         run-awaiting-approval (agui/resume.rs apply_user_form_stamp), which this app reads.",
    ),
    (
        Slot::CustomName,
        "form-resolution",
        "No frame is named form-resolution or form_resolution. formResolution is a field on a \
         settled card and on the user-form CUSTOM (agui/user_form.rs agui_user_form_frame).",
    ),
    (
        Slot::CustomName,
        "request-user-form",
        "No CUSTOM is named request-user-form or request_user_form. request_user_form is the \
         tool (opengrok-tools user_form.rs REQUEST_USER_FORM): it arrives as \
         TOOL_CALL_START.toolCallName and as run-awaiting-approval.tool, where this app reads it \
         through is_user_form_tool. The live card is run-awaiting-approval with reason \
         user-form, the settled one a user-form CUSTOM.",
    ),
    (
        Slot::CustomName,
        "computer-handoff-card",
        "The Computer handoff is a gateway transcript entry (cards.rs computer_handoff_card: \
         message.type attachment, url sand://box, boxRequestId, boxInstruction), appended to the \
         transcript and never sent as a frame; cards.rs says there is no computer-handoff message \
         type. This app learns of it from the dismiss reply's handoffEntryId.",
    ),
    (
        Slot::CustomName,
        "computer-handoff",
        "No frame carries a handoff; see computer-handoff-card.",
    ),
    (
        Slot::CustomName,
        "sand://box",
        "The url on the handoff entry's attachment message (cards.rs), never a frame name.",
    ),
    (
        Slot::CustomName,
        "sand:box",
        "No spelling of sand://box names a frame.",
    ),
    (
        Slot::CustomName,
        "box-handoff",
        "Only in the route /ag-ui/box-handoff/resolve and the functions behind it \
         (agui/user_form.rs resolve_box_handoff, start_box_handoff); no frame is named \
         box-handoff, box_handoff or boxHandoff. The handoff is a transcript entry.",
    ),
    (
        Slot::CustomName,
        "box-handoff-card",
        "Never sent; see box-handoff.",
    ),
    (
        Slot::CustomName,
        "ui",
        "The server paints charts and forms through the bar_chart and form tools it offers the \
         model (agui/chat_ui.rs, \"NativeChat paints them from the TOOL_CALL frames\") and sends \
         no generative-UI CUSTOM.",
    ),
    (
        Slot::CustomName,
        "bar-chart",
        "A tool name on the server (bar_chart, agui/chat_ui.rs), read here from TOOL_CALL \
         frames; never a CUSTOM name.",
    ),
    (
        Slot::CustomName,
        "barchart",
        "Never sent under any name; see bar-chart.",
    ),
    (
        Slot::CustomName,
        "form",
        "A tool name on the server (agui/chat_ui.rs form_schema), never a CUSTOM name.",
    ),
    (
        Slot::CustomName,
        "",
        "A CUSTOM with no name. Every CUSTOM the server builds is named (projection.rs, \
         agui/pending.rs, agui/user_form.rs, opengrok-tools credential.rs).",
    ),
    (
        Slot::ApprovalReason,
        "review-an-action",
        "The name of Grok Bot's card chrome, in server comments only (opengrok-tools review.rs \
         EGRESS_TUNNEL_ASK_REASON's doc). That card is raised with reason auto-review, and the \
         tunnel's with EGRESS_TUNNEL_ASK_REASON as its why (opengrok-tools lib.rs); no \
         spelling of review-an-action is a reason.",
    ),
    (
        Slot::ApprovalReason,
        "computer-action",
        "A Grok Bot desktop gateway event channel (the server's docs/research/client-grok-bot.md \
         and docs/archive/client-versions-0.18-0.30.md), in no server code. The server's \
         reasons are exec-consent, policy-approval, auto-review and user-form (opengrok-core \
         run.rs SuspendReason, opengrok-tools review.rs AwaitingReason).",
    ),
    (
        Slot::ApprovalReason,
        "egress",
        "The tunnel's card arrives as reason auto-review with EGRESS_TUNNEL_ASK_REASON as its \
         why, and is_egress_tunnel reads that sentence. No server reason is the word egress.",
    ),
    (
        Slot::FormResolution,
        "sending",
        "This app's own pill between Continue and the reply. The server settles a form as \
         submitted, fill_failed, dismissed or escalated and nothing else (opengrok-tools \
         user_form.rs FormResolution::as_str).",
    ),
    (
        Slot::FormResolution,
        "submitting",
        "Another spelling of this app's Sending pill; never on the wire.",
    ),
    (
        Slot::FormResolution,
        "fill-failed",
        "The server spells it fill_failed (FormResolution::as_str); the hyphenated word is in no \
         server file. fillFailed is a different field, on formFieldOutcomes rows.",
    ),
    (
        Slot::FormResolution,
        "not_filled",
        "Not filled is this app's pill for fill_failed. No server file spells a resolution \
         not_filled, not-filled or notFilled.",
    ),
    (
        Slot::FormResolution,
        "not-filled",
        "Never sent; see not_filled.",
    ),
    (
        Slot::FormResolution,
        "on_screen",
        "No server file spells a resolution on_screen, on-screen, on_the_computer or \
         on-the-computer. The server's word for Open the screen is escalated \
         (agui/user_form.rs dismiss_user_form), which this app reads too.",
    ),
    (
        Slot::FormResolution,
        "on-screen",
        "Never sent; see on_screen.",
    ),
    (
        Slot::FormResolution,
        "on_the_computer",
        "Never sent; see on_screen.",
    ),
    (
        Slot::FormResolution,
        "on-the-computer",
        "Never sent; see on_screen.",
    ),
    (
        Slot::FormResolution,
        "skipped",
        "Skip settles the form here (UserFormSpec::settle_form_from_box, declined to Skipped). \
         The server writes boxResolution declined on the handoff entry and never a skipped \
         formResolution.",
    ),
    (Slot::FormResolution, "skip", "Never sent; see skipped."),
    (
        Slot::FormResolution,
        "superseded",
        "This app paints it when a later message moved the thread on. The server closes that \
         card as dismissed (agui/user_form.rs settle_dead_holds).",
    ),
];

/// Words the server sends that this app has no arm for, each with what happens instead.
const CLIENT_IGNORES: &[(Slot, &str, &str)] = &[
    (
        Slot::CustomName,
        "run-stopped",
        "The RUN_FINISHED the server always sends right after it (projection.rs stopped) ends \
         the turn, so on the stream a stop reads as a finish.",
    ),
    (
        Slot::CustomName,
        "opengrok.timeline",
        "A row of a Bot's main chat (opengrok-server #314, built in #325: TIMELINE_NAME in \
         opengrok-wire pair.rs), sent live beside the stored row a replay carries in timeline: a \
         messaged row says the Bot messaged another, and its chip opens the two Bots' pair \
         thread. This app has no client half of #314 yet, so the frame leaves the turn as it was \
         and the row is not shown; the turn's own frames still paint what the Bot said.",
    ),
    (
        Slot::ApprovalReason,
        "exec-consent",
        "The default card. approval_from_event fills this word in when a frame has none, and \
         which card shows is decided by the tool (user_machine_shell or not), not by the word.",
    ),
    (
        Slot::ApprovalReason,
        "policy-approval",
        "Shown as the default permission card, allow or deny once; nothing branches on the word.",
    ),
];

/// Words this app reads ahead of the server's recording of them: built to a shape agreed with the
/// server session before the server sends it, so the manifest does not list it yet. Each says
/// what brings it. It is no dead word, which is what [`NOT_SENT_BY_SERVER`] records: the day the
/// manifest lists it, it comes off this list, and its frames are read like every other by the
/// arm waiting for them in [`check_frame`];
/// [`every_word_read_ahead_of_its_recording_is_matched_and_not_sent_yet`] fails until it does,
/// and meanwhile holds that arm to the frames [`frames_read_ahead`] writes in the agreed shape.
const WORDS_NOT_RECORDED_YET: &[(Slot, &str, &str)] = &[(
    Slot::CustomName,
    "opengrok.officeDoc",
    "An `office_*` tool's thin frame (opengrok-server `office_desk.rs` `frame`,
    gol/betteroffice): the server's manifest gains it when record-wire.sh runs on the office
    branch.",
)];

/// Fixtures this app still reads wrongly, with the words their check fails with and why. The
/// check has to fail with those words: one that passes means the drift is fixed and the entry
/// goes, and one that fails some other way is a new problem, not this one.
const KNOWN_DRIFT: &[(&str, &str, &str)] = &[];

/// How a 502, 503 or 504 the server wrote itself fails [`refusal`] when it is not in the shape
/// that says so.
const FIVE_HUNDRED_SHAPE: &str = "should carry its sentence under error, as JSON";

/// Routes the server records and this app never asks, by the directory #255 files them under,
/// with the route as the server's router writes it and why. Their bodies are read by nothing
/// here, so nothing here can say whether they would be read right: a route that starts being
/// asked comes off this list and gets a reading in [`REST_ROUTES`] in the same change, and
/// [`every_route_this_app_does_not_read_is_recorded_and_says_why`] fails until it does.
const REST_NOT_READ: &[(&str, &str, &str)] = &[
    (
        "DELETE__auto-review_policy",
        "/auto-review/policy",
        "The auto-review policy (opengrok-server #357, `auto_review` routes, merged to the server's main before #366). This app has no client half of it on this branch: nothing here asks the route, so nothing can be wrong in how it reads it. Built in the change that starts asking it.",
    ),
    (
        "GET__auto-review_effective",
        "/auto-review/effective",
        "The auto-review policy (opengrok-server #357, `auto_review` routes, merged to the server's main before #366). This app has no client half of it on this branch: nothing here asks the route, so nothing can be wrong in how it reads it. Built in the change that starts asking it.",
    ),
    (
        "GET__auto-review_policy",
        "/auto-review/policy",
        "The auto-review policy (opengrok-server #357, `auto_review` routes, merged to the server's main before #366). This app has no client half of it on this branch: nothing here asks the route, so nothing can be wrong in how it reads it. Built in the change that starts asking it.",
    ),
    (
        "PUT__auto-review_policy",
        "/auto-review/policy",
        "The auto-review policy (opengrok-server #357, `auto_review` routes, merged to the server's main before #366). This app has no client half of it on this branch: nothing here asks the route, so nothing can be wrong in how it reads it. Built in the change that starts asking it.",
    ),
    (
        "GET__auth_cursor_dev_session_token",
        "/auth/cursor_dev_session_token",
        "The dev sign-in that stands in for Cursor's OAuth (opengrok-server auth/routes.rs). This \
         app signs in with an email and a password on POST /auth/login.",
    ),
    (
        "GET__auth_poll",
        "/auth/poll",
        "The polling half of the browser login a desktop client starts at /loginDeepControl, \
         asking for its token with a PKCE verifier (auth/routes.rs auth_poll). This app signs in \
         with an email and a password on POST /auth/login, and polls for nothing.",
    ),
    (
        "GET__auth_verify",
        "/auth/verify",
        "The link in a verification email: an HTML page a browser opens, never a body an app \
         reads.",
    ),
    (
        "POST__auth_signup",
        "/auth/signup",
        "Makes an account (auth/identity.rs signup). This app offers no way to make one: its \
         sign-in takes an email and a password for an account that already exists.",
    ),
    (
        "POST__auth_verify_resend",
        "/auth/verify/resend",
        "The web console's login page asks for a new verification link here (auth/routes.rs, \
         identity.rs resend_json). This app's sign-in has no such request: a refusal for an \
         unverified address is shown as the server's own sentence, which says where to ask.",
    ),
    (
        "POST__auth_password_forgot",
        "/auth/password/forgot",
        "The web console's login page asks for a password reset here, as the server's own \
         /forgot-password page does by form (auth/password_reset.rs). This app's sign-in offers \
         no reset.",
    ),
    (
        "POST__coworkers__coworker_id__keys",
        "/coworkers/{coworker_id}/keys",
        "Mints a bot key, the long-lived credential another client (Claude Code, at the MCP \
         door) uses to act as the coworker (agui/routes.rs mint_bot_key). This app talks to the \
         server as the signed-in person, and makes, lists and revokes no bot keys.",
    ),
    (
        "GET__coworkers__coworker_id__keys",
        "/coworkers/{coworker_id}/keys",
        "Lists a coworker's bot keys; see POST /coworkers/{id}/keys.",
    ),
    (
        "DELETE__coworkers__coworker_id__keys__jti_",
        "/coworkers/{coworker_id}/keys/{jti}",
        "Revokes a bot key; see POST /coworkers/{id}/keys.",
    ),
    (
        "GET__coworkers__coworker_id__mcp-calls",
        "/coworkers/{coworker_id}/mcp-calls",
        "What a coworker's bot keys were used for at the MCP door. This app shows no MCP \
         history: a call there that needs a yes reaches it as a card on GET /ag-ui/approvals.",
    ),
    (
        "POST__coworkers__coworker_id__approvals",
        "/coworkers/{coworker_id}/approvals",
        "Which of a coworker's tools need a person's yes, kept on the caller's grant \
         (agui/routes.rs set_approvals). This app has no control for it; it answers the cards \
         the server raises.",
    ),
    (
        "GET__coworkers__coworker_id__computer_egress-policy",
        "/coworkers/{coworker_id}/computer/egress-policy",
        "The same standing answer, read from the same store, reaches this app as egressPolicy on \
         GET /coworkers/{id}/computer (CoworkerComputer::egress_policy), which is what the \
         control on the bot's pane or in Settings shows (AppState::egress_policy). The app only \
         ever PUTs this route.",
    ),
    (
        "GET__coworkers__coworker_id__limit",
        "/coworkers/{coworker_id}/limit",
        "A coworker's points cap for the month and its brake for the day, with what it has used \
         (agui/routes.rs get_limit, points.rs). This app shows neither and sets neither.",
    ),
    (
        "PUT__coworkers__coworker_id__limit",
        "/coworkers/{coworker_id}/limit",
        "Sets that cap and that brake; see GET /coworkers/{id}/limit.",
    ),
    (
        "GET__coworkers__coworker_id__spend",
        "/coworkers/{coworker_id}/spend",
        "A coworker's three spend meters and the limits an admin set; no page in this app shows \
         them.",
    ),
    (
        "GET__local-exec_audit",
        "/local-exec/audit",
        "This account's recent reverse-exec commands and their outcomes (local_exec.rs \
         audit_log). Settings shows each machine's mode and standing rules from GET \
         /local-exec/policy, and no log.",
    ),
    (
        "DELETE__local-exec_daemon__machine_id_",
        "/local-exec/daemon/{machine_id}",
        "Revokes a computer's daemon token, answering 204 with nothing in it; its row reads \
         `revoked` from then on (local_exec.rs revoke_daemon). This app lists computers and \
         switches their relay (PATCH on the same route), enrols this Mac again when its token is \
         turned away, and has no control that revokes one.",
    ),
];

/// Routes this app asks that the corpus does not record yet: the app was built to a shape agreed
/// with the server session before the server recorded it. Each is named by the directory the
/// recorder will file it under, with the route as the server's router writes it and what brings
/// its fixtures. Nothing reads them against the server's evidence yet, so each is owed a
/// reading: the day the corpus holds one, it gets a reading in [`REST_ROUTES`] and comes off this
/// list in the same change, and
/// [`every_route_asked_ahead_of_its_recording_is_asked_and_not_recorded_yet`] fails until it
/// does.
///
/// Only routes built ahead of a recording are listed. Routes this app asks that no test on the
/// server drives are a different gap, and not this list's.
const REST_NOT_RECORDED_YET: &[(&str, &str, &str)] = &[
    (
        "GET__office_docs__id_",
        "/office/docs/{id}",
        "The document window's session fetch (opengrok-server `office_routes.rs`,
        gol/betteroffice): the server's recorder gains its fixtures when record-wire.sh runs on
        the office branch.",
    ),
    (
        "GET__office_docs__id__bytes",
        "/office/docs/{id}/bytes",
        "The document's bytes as the box has them, for the window (same recording).",
    ),
    (
        "GET__office_docs__id__pages__page_.png",
        "/office/docs/{id}/pages/{page}.png",
        "One rendered page/slide/used-range for the document window (same recording).",
    ),
];

/// Routes this app asks with this Mac's machine token (`local_exec.rs` `MachineCredential`)
/// rather than the person's session, so they never pass through `send_json_within`: a 401 on one
/// is the server turning the token away, not the session gone, and the route's own reading in
/// [`REFUSALS`] says what comes of it.
const MACHINE_TOKEN_ROUTES: &[&str] = &[
    "GET__inference-relay_requests",
    "POST__inference-relay_responses__request_id_",
];

/// Keys this app reads and sends on routes the corpus records, ahead of the server's recording
/// of them: built to a shape agreed with the server session before the server sends it. The
/// routes themselves are recorded and read ([`REST_ROUTES`]), so they cannot wait in
/// [`REST_NOT_RECORDED_YET`]; what waits is one key on their bodies. Each is named by the route's
/// directory, with the key and what brings its fixtures, and is read meanwhile from bodies
/// written in the agreed shape. The day a recorded body of the route carries the key, the entry
/// has gone stale and comes off this list, and
/// [`every_key_asked_ahead_of_its_recording_is_read_and_not_recorded_yet`] fails until it does.
const REST_FIELDS_NOT_RECORDED_YET: &[(&str, &str, &str)] = &[];

// ---- the corpus ----

#[derive(Debug, Deserialize)]
struct Manifest {
    server_sha: String,
    recorded_by: String,
    emits: Emits,
    entries: Vec<Entry>,
    /// Names the server can send that no test exercises yet (#255 asks the recorder to say so).
    #[serde(default)]
    unrecorded: Vec<String>,
}

/// What the server's code can send. #255 names the first two lists; the reasons and the
/// resolutions are this app's addition, because four of the eight dead words were words in
/// those two fields rather than names.
#[derive(Debug, Deserialize)]
struct Emits {
    agui_types: Vec<String>,
    custom_names: Vec<String>,
    approval_reasons: Vec<String>,
    form_resolutions: Vec<String>,
    /// Not the manifest's, which lists no codes: the codes the recording's `RUN_ERROR` frames
    /// carry, read off the frames by [`Corpus::load`]. A code is sent once a recorded frame
    /// carries it.
    #[serde(skip)]
    run_error_codes: Vec<String>,
    /// Not the manifest's either: the `type` of each frame the recording keeps under `relay/`.
    #[serde(skip)]
    relay_types: Vec<String>,
    /// The names of the account's events stream's notes the server can send, as the manifest lists
    /// them under `emits.events` (opengrok-server #351, recorded at 9a2b011). A recording from
    /// before the stream has none.
    #[serde(default, rename = "events")]
    account_events: Vec<String>,
}

impl Emits {
    fn words(&self, slot: Slot) -> &[String] {
        match slot {
            Slot::AguiType => &self.agui_types,
            Slot::CustomName => &self.custom_names,
            Slot::ApprovalReason => &self.approval_reasons,
            Slot::FormResolution => &self.form_resolutions,
            Slot::RunErrorCode => &self.run_error_codes,
            Slot::RelayType => &self.relay_types,
            Slot::AccountEvent => &self.account_events,
        }
    }
}

#[derive(Debug, Deserialize)]
struct Entry {
    file: String,
    source: String,
}

struct Corpus {
    root: PathBuf,
    manifest: Manifest,
    /// Every AG-UI frame, by its path under the corpus root.
    frames: BTreeMap<String, Value>,
    /// Every REST fixture, by its path under the corpus root.
    bodies: BTreeMap<String, Value>,
    /// Every frame off the Mac relay's stream, by its path under the corpus root.
    relay: BTreeMap<String, Value>,
    /// Every block off the account's events stream, `{id, event, data}`, by its path under the
    /// corpus root.
    events: BTreeMap<String, Value>,
}

impl Corpus {
    fn load() -> Self {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join(CORPUS);
        let mut manifest: Manifest = serde_json::from_value(read_json(&root, "MANIFEST.json"))
            .unwrap_or_else(|error| {
                panic!(
                    "{CORPUS}/MANIFEST.json is not #255's manifest with emits.approval_reasons \
                     and emits.form_resolutions beside the types and names: {error}"
                )
            });
        let frames: BTreeMap<String, Value> = json_files(&root, "agui")
            .into_iter()
            .map(|file| {
                let frame = read_json(&root, &file);
                (file, frame)
            })
            .collect();
        let codes: BTreeSet<&str> = frames
            .values()
            .filter(|frame| str_at(frame, "type") == "RUN_ERROR")
            .filter_map(|frame| opt_str(frame, "code"))
            .collect();
        manifest.emits.run_error_codes = codes.into_iter().map(str::to_string).collect();
        let bodies = json_files(&root, "rest")
            .into_iter()
            .map(|file| {
                let body = read_json(&root, &file);
                (file, body)
            })
            .collect();
        let relay: BTreeMap<String, Value> = json_files(&root, "relay")
            .into_iter()
            .map(|file| {
                let frame = read_json(&root, &file);
                (file, frame)
            })
            .collect();
        let types: BTreeSet<&str> = relay.values().map(|frame| str_at(frame, "type")).collect();
        manifest.emits.relay_types = types.into_iter().map(str::to_string).collect();
        let events = json_files(&root, "events")
            .into_iter()
            .map(|file| {
                let block = read_json(&root, &file);
                (file, block)
            })
            .collect();
        Self {
            root,
            manifest,
            frames,
            bodies,
            relay,
            events,
        }
    }

    /// Every frame and every REST fixture.
    fn every_value(&self) -> impl Iterator<Item = &Value> {
        self.frames.values().chain(self.bodies.values())
    }

    fn frames_of<'a>(&'a self, kind: &'a str) -> impl Iterator<Item = &'a Value> {
        self.frames
            .values()
            .filter(move |frame| str_at(frame, "type") == kind)
    }

    fn customs_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Value> {
        self.frames_of("CUSTOM")
            .filter(move |frame| str_at(frame, "name") == name)
    }

    /// The call's own permission card when the corpus has one, else a permission card from the
    /// corpus re-aimed at `call_id`, for the frames whose meaning is what they do to a card.
    fn approval_card_for(&self, call_id: &str) -> Option<Value> {
        let cards = || {
            self.customs_named(RUN_AWAITING_APPROVAL)
                .filter(|frame| str_at(frame, "reason") != USER_FORM_REASON)
        };
        if let Some(own) = cards().find(|card| str_at(card, "callId") == call_id) {
            return Some(own.clone());
        }
        let mut card = cards().next()?.clone();
        card["callId"] = Value::String(call_id.to_string());
        Some(card)
    }

    /// The frame of `kind` that belongs to the call `call_id`.
    fn call_frame<'a>(&'a self, kind: &'a str, call_id: &str) -> Option<&'a Value> {
        self.frames_of(kind)
            .find(|frame| str_at(frame, "toolCallId") == call_id)
    }

    /// The tool a call was made with: the `toolCallName` its own opening says, else the `tool` on
    /// its own permission card.
    fn tool_of(&self, call_id: &str) -> Option<&str> {
        self.call_frame("TOOL_CALL_START", call_id)
            .map(|start| str_at(start, "toolCallName"))
            .or_else(|| {
                self.customs_named(RUN_AWAITING_APPROVAL)
                    .find(|card| str_at(card, "callId") == call_id)
                    .map(|card| str_at(card, "tool"))
            })
            .filter(|tool| !tool.is_empty())
    }

    /// The call's own opening when the corpus has it. Otherwise an opening from the corpus
    /// re-aimed at `call_id` and at the tool its card names, for the frames whose meaning is what
    /// they do to a call of that tool: the server opens every call before it asks about it
    /// (opengrok-harness `projection.rs` `push`), so a call with a card had an opening even where
    /// the recording kept only the card. A call with neither says nothing about what it is.
    fn tool_call_start_for(&self, call_id: &str) -> Option<Value> {
        if let Some(own) = self.call_frame("TOOL_CALL_START", call_id) {
            return Some(own.clone());
        }
        let tool = self.tool_of(call_id)?;
        let mut start = self
            .frames_of("TOOL_CALL_START")
            .find(|start| str_at(start, "toolCallName") == tool)
            .or_else(|| self.frames_of("TOOL_CALL_START").next())?
            .clone();
        start["toolCallId"] = Value::String(call_id.to_string());
        start["toolCallName"] = Value::String(tool.to_string());
        // A form's gateway id belongs to the call it was minted for, not to this one.
        if let Some(start) = start.as_object_mut() {
            start.remove("entryId");
        }
        Some(start)
    }

    /// Every frame of the reasoning message `message_id`, in the order a run sends them.
    fn reasoning_frames(&self, message_id: &str) -> Vec<&Value> {
        [
            "REASONING_MESSAGE_START",
            "REASONING_MESSAGE_CONTENT",
            "REASONING_MESSAGE_END",
        ]
        .into_iter()
        .flat_map(|kind| {
            self.frames_of(kind)
                .filter(move |frame| str_at(frame, "messageId") == message_id)
        })
        .collect()
    }
}

/// Every `.json` under `dir`, relative to the corpus root and with `/` between parts.
fn json_files(root: &Path, dir: &str) -> Vec<String> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
        let entries = std::fs::read_dir(dir)
            .unwrap_or_else(|error| panic!("read {}: {error}", dir.display()));
        for entry in entries {
            let path = entry.expect("a directory entry").path();
            if path.is_dir() {
                walk(root, &path, out);
            } else if path.extension().is_some_and(|ext| ext == "json") {
                let rel = path.strip_prefix(root).expect("under the corpus root");
                let parts: Vec<String> = rel
                    .components()
                    .map(|part| part.as_os_str().to_string_lossy().into_owned())
                    .collect();
                out.push(parts.join("/"));
            }
        }
    }
    let mut out = Vec::new();
    walk(root, &root.join(dir), &mut out);
    out.sort();
    out
}

fn read_json(root: &Path, rel: &str) -> Value {
    let path = root.join(rel);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("{} is not JSON: {error}", path.display()))
}

fn str_at<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

/// Whether `word`, in `slot`, is on `list`. Keyed by slot: `user-form` is both a CUSTOM name and
/// an approval reason, and excusing it in one place must not excuse it in the other.
fn is_excused(list: &[(Slot, &str, &str)], slot: Slot, word: &str) -> bool {
    list.iter()
        .any(|(listed_slot, listed, _)| *listed_slot == slot && *listed == word)
}

/// One check's verdict: `Err` says what came out wrong.
type Check = Result<(), String>;

/// Fail the check with a sentence when `$cond` does not hold.
macro_rules! must {
    ($cond:expr, $($why:tt)+) => {
        if !$cond {
            return Err(format!($($why)+));
        }
    };
}

/// Runs `check` over `items` and says what went wrong, holding [`KNOWN_DRIFT`] entries to failing
/// the way they are known to.
fn verdicts<'a>(
    items: impl Iterator<Item = (&'a String, &'a Value)>,
    check: impl Fn(&str, &Value) -> Check,
) -> Vec<String> {
    let mut problems = Vec::new();
    for (file, value) in items {
        let symptom = KNOWN_DRIFT
            .iter()
            .find(|(drifted, _, _)| drifted == file)
            .map(|(_, symptom, _)| *symptom);
        match (check(file, value), symptom) {
            (Ok(()), None) => {}
            (Err(why), Some(symptom)) if why.contains(symptom) => {}
            (Err(why), None) => problems.push(format!("{file}: {why}")),
            (Err(why), Some(_)) => problems.push(format!(
                "{file} fails other than its known drift says: {why}"
            )),
            (Ok(()), Some(_)) => problems.push(format!(
                "{file} now reads as intended; take it off KNOWN_DRIFT"
            )),
        }
    }
    problems
}

// ---- what each frame is meant to do ----

fn tick(frame: &Value) -> ActivityTick {
    activity_from_agui(frame, None)
}

fn label(text: &str) -> ActivityTick {
    ActivityTick::Set(BotActivity {
        label: text.to_string(),
    })
}

fn assembled(frames: &[&Value]) -> TurnAssembler {
    let mut assembler = TurnAssembler::default();
    for frame in frames {
        assembler.push_event(frame);
    }
    assembler
}

/// Frames as the `POST /ag-ui` stream carries them, one `data:` line each.
fn sse(frames: &[&Value]) -> String {
    frames
        .iter()
        .map(|frame| format!("data: {frame}\n\n"))
        .collect()
}

fn check_frame(corpus: &Corpus, frame: &Value) -> Check {
    match str_at(frame, "type") {
        "RUN_STARTED" => {
            must!(
                tick(frame) == label("Thinking"),
                "RUN_STARTED should say Thinking, not {:?}",
                tick(frame)
            );
            Ok(())
        }
        "RUN_FINISHED" | "RUN_ERROR" => run_ended(corpus, frame),
        "TEXT_MESSAGE_START" => text_start(corpus, frame),
        "TEXT_MESSAGE_CONTENT" => text_content(corpus, frame),
        "TEXT_MESSAGE_END" => text_end(corpus, frame),
        "TOOL_CALL_START" => tool_call_start(frame),
        "TOOL_CALL_ARGS" => tool_call_args(corpus, frame),
        "TOOL_CALL_END" => tool_call_end(corpus, frame),
        "TOOL_CALL_RESULT" => tool_call_result(corpus, frame),
        "REASONING_MESSAGE_START" | "REASONING_MESSAGE_CONTENT" | "REASONING_MESSAGE_END" => {
            reasoning(corpus, frame)
        }
        "CUSTOM" => custom(frame),
        kind if is_excused(CLIENT_IGNORES, Slot::AguiType, kind) => ignored(frame),
        kind => Err(format!(
            "no check for a {kind:?} frame: say here what this app does with one"
        )),
    }
}

fn run_ended(corpus: &Corpus, frame: &Value) -> Check {
    must!(
        tick(frame) == ActivityTick::Clear,
        "a run's end should clear the status line, not {:?}",
        tick(frame)
    );
    if let Some(card) = corpus.approval_card_for("c-ended") {
        let assembler = assembled(&[&card, frame]);
        must!(
            !assembler.waiting_approval(),
            "the stream is over, so it is not waiting on the card any more"
        );
    }
    if str_at(frame, "type") == "RUN_ERROR" {
        let said = assistant_text_from_sse(&sse(&[frame]));
        must!(
            said == Err(str_at(frame, "message").to_string()),
            "RUN_ERROR should end the turn with the server's sentence, got {said:?}"
        );
        // The turn's error as the live stream reads it (`run_turn`): the sentence, and beside it
        // the code a run the person's plan could not answer ends with, which offers the turn
        // again on the server's keys. A run that names no code offers nothing, and a code nothing
        // here reads fails, so one the server starts sending is caught before a person misses
        // its action.
        let error = OpenGrokClient::run_ended_badly(frame);
        let code = opt_str(frame, "code");
        must!(
            error.message == str_at(frame, "message") && error.code() == code,
            "the turn's error should keep the sentence and the code as sent: {error:?}"
        );
        if let Some(code) = code {
            must!(
                RUN_ERROR_CODES.contains(&code) || offers_nothing(code),
                "a run ends with the code {code:?}, which nothing here reads: read it, or say \
                 here why a person can be left without it"
            );
        }
        let offered = error.code().and_then(RunErrorCode::from_code);
        must!(
            offered.is_some() == code.is_some_and(|code| RUN_ERROR_CODES.contains(&code)),
            "a code on a RUN_ERROR should offer the turn again on the server's keys, and only \
             such a code: {offered:?} from {code:?}"
        );
    }
    Ok(())
}

/// The codes a `RUN_ERROR` carries beside its sentence, each for a turn the person's plan could
/// not answer. The Mac relay's (opengrok-server main cad36fd (#303, after #298), pin 47a5d6b):
/// `ModelError::Relay` in `crates/opengrok-harness/src/relay.rs`, stamped on the frame by
/// `Projection::failing_with`. No Mac held the relay, the Mac started no answer or went quiet for
/// the door's clock, or the Mac answered with a failure in its own words. A refusal of the Mac's
/// own making, such as one Mac carrying all the calls it may at once, is `ModelError::Proxy`,
/// with a sentence and no code. And `plan_unavailable` (opengrok-server main d6f640e (#307, after
/// #304), pin bf99845: `ModelError::PlanUnavailable` in `crates/opengrok-harness/src/model.rs`,
/// made by `refused` in `local_proxy.rs`): the person's own setting left the plan nothing to
/// answer with, no proxy address or no model for the way the turn goes. A reply source the server
/// could not read and a proxy key it could not open are the server's own faults, and a routine
/// refused for a Bot on its own plan has no reply to send anywhere else: each ends with a sentence
/// and no code.
const RUN_ERROR_CODES: &[&str] = &[
    "relay_offline",
    "relay_timeout",
    "relay_failed",
    "plan_unavailable",
];

/// Codes a `RUN_ERROR` carries that offer nothing, each with why a person is left with the
/// sentence alone. `relay_disabled` (opengrok-server #332 (PR #338 at 66b9f7b): `refused` in
/// `crates/opengrok-server/src/pairs.rs`, with `Skip::reason`'s words) ends a Bot's reply to
/// another Bot that was skipped because the person switched the relay off and set no fallback. It
/// is only ever sent in the two Bots' pair thread, which is read-only: a person's words there,
/// live or queued, are refused 403 `read-only-thread`, so there is no turn of theirs to send
/// again, on the server's keys or otherwise. No chat turn ends with it (one refused for the relay
/// being off is `plan_unavailable`). The recorder keeps no frame of it, since the pair's run is
/// journaled straight into the store and never streamed through the router it tees, so it is
/// read beyond the recording
/// ([`a_bots_reply_skipped_while_the_relay_is_off_is_read_beyond_the_recording`]).
const RUN_ERROR_CODES_OFFERING_NOTHING: &[(&str, &str)] = &[(
    "relay_disabled",
    "a Bot's reply to another, skipped while the relay is off, in their read-only pair thread",
)];

/// Whether `code` is one a `RUN_ERROR` carries that offers nothing
/// ([`RUN_ERROR_CODES_OFFERING_NOTHING`]).
fn offers_nothing(code: &str) -> bool {
    RUN_ERROR_CODES_OFFERING_NOTHING
        .iter()
        .any(|(word, why)| *word == code && !why.trim().is_empty())
}

/// A message's opening paints nothing, and says whose words follow. The coworker's is it writing.
/// The person's, which a replay opens each run with right after `RUN_STARTED` (opengrok-server
/// `agui/history.rs` `with_prompt_frames`), is the question and not the coworker doing anything:
/// it leaves the status line as it was, and so do the words that follow under its id, which are
/// none of the reply's.
fn text_start(corpus: &Corpus, frame: &Value) -> Check {
    let role = str_at(frame, "role");
    // AG-UI also has `system` and `developer` messages. The server replays neither, and one that
    // came would read here as the coworker writing, so a new role is caught rather than blessed.
    must!(
        matches!(role, "assistant" | "user"),
        "a TEXT_MESSAGE_START with role {role:?}, which this app reads as the coworker's"
    );
    let persons = role == "user";
    let mut tracker = ToolCallTracker::default();
    let status = tracker.tick(frame);
    let expected = if persons {
        ActivityTick::Keep
    } else {
        label("Writing")
    };
    must!(
        status == expected,
        "a TEXT_MESSAGE_START with role {role:?} should leave the status line at {expected:?}, \
         not {status:?}"
    );
    let (plain, parts) = assembled(&[frame]).snapshot();
    must!(
        plain.is_empty() && parts.is_empty(),
        "an opening paints nothing, got {plain:?} {parts:?}"
    );
    if !persons {
        return Ok(());
    }
    let id = str_at(frame, "messageId");
    must!(!id.is_empty(), "the person's message names no id");
    // Only the opening names the person, so words from the corpus re-aimed at this message are
    // the person's by its id alone.
    let mut words = corpus
        .frames_of("TEXT_MESSAGE_CONTENT")
        .next()
        .ok_or("the corpus has no words to follow the person's opening")?
        .clone();
    words["messageId"] = Value::String(id.to_string());
    let status = tracker.tick(&words);
    must!(
        status == ActivityTick::Keep,
        "the person's words should leave the status line as it was, not {status:?}"
    );
    let delta = str_at(&words, "delta");
    let (plain, _) = assembled(&[frame, &words]).snapshot();
    must!(
        !plain.contains(delta),
        "the person's own words {delta:?} were painted as the coworker's reply: {plain:?}"
    );
    Ok(())
}

/// The end of a message closes it and paints nothing. It is read in one place: a person's message
/// the replay opens and closes with no words between is kept, since that is a message of files
/// alone (opengrok-server#259). So the end of a message with a known start must close it without
/// adding a word to the coworker's reply, and a person's message closed on no words must survive.
fn text_end(corpus: &Corpus, frame: &Value) -> Check {
    let id = str_at(frame, "messageId");
    must!(!id.is_empty(), "a TEXT_MESSAGE_END names no message");
    let Some(start) = corpus
        .frames_of("TEXT_MESSAGE_START")
        .find(|start| start.get("messageId") == frame.get("messageId"))
    else {
        return Ok(());
    };
    // The whole message, its words included, so an END that dropped or cleared them is caught.
    let mut frames: Vec<&Value> = vec![start];
    frames.extend(
        corpus
            .frames_of("TEXT_MESSAGE_CONTENT")
            .filter(|content| content.get("messageId") == frame.get("messageId")),
    );
    let (before, _) = assembled(&frames).snapshot();
    frames.push(frame);
    let (after, _) = assembled(&frames).snapshot();
    must!(
        before == after,
        "closing a message changed the words: {before:?} became {after:?}"
    );
    if str_at(start, "role") == "user" {
        let kept = super::gen_ui::persons_messages(&[start.clone(), frame.clone()]);
        must!(
            kept.iter().any(|(said, _)| said == id),
            "the person's message {id} closed on no words was dropped"
        );
    }
    Ok(())
}

fn text_content(corpus: &Corpus, frame: &Value) -> Check {
    let delta = str_at(frame, "delta");
    must!(!delta.is_empty(), "a text frame with no delta");
    // The message's own opening says whose words these are.
    let start = corpus
        .frames_of("TEXT_MESSAGE_START")
        .find(|start| start.get("messageId") == frame.get("messageId"));
    let persons = start.is_some_and(|start| str_at(start, "role") == "user");
    // The status line as the app keeps it, from the message's opening on: the person's words
    // leave it as it was, and the coworker's say Writing.
    let mut tracker = ToolCallTracker::default();
    if let Some(start) = start {
        tracker.tick(start);
    }
    let status = tracker.tick(frame);
    let expected = if persons {
        ActivityTick::Keep
    } else {
        label("Writing")
    };
    must!(
        status == expected,
        "text should leave the status line at {expected:?}, not {status:?}"
    );
    let mut frames: Vec<&Value> = start.into_iter().collect();
    frames.push(frame);
    let (plain, _) = assembled(&frames).snapshot();
    if persons {
        must!(
            !plain.contains(delta),
            "the person's own words {delta:?} were painted as the coworker's reply: {plain:?}"
        );
        return Ok(());
    }
    must!(
        plain == delta,
        "the reply should read {delta:?}, not {plain:?}"
    );
    let streamed = assistant_text_from_sse(&sse(&frames));
    must!(
        streamed == Ok(delta.to_string()),
        "the stream reader should keep {delta:?}, got {streamed:?}"
    );
    Ok(())
}

/// What this app draws a call as, which its tool decides (`TurnAssembler::push_event`): a chart
/// or a generative form is a widget drawn as itself, a `request_user_form` is the card the person
/// fills in, and every other call is a step in the reply.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Drawn {
    Widget,
    UserForm,
    Step,
}

fn drawn_as(tool: &str) -> Drawn {
    if is_user_form_tool(tool) {
        Drawn::UserForm
    } else if is_ui_tool(tool) {
        Drawn::Widget
    } else {
        Drawn::Step
    }
}

/// The two shells, whose command is what their permission card shows.
fn is_shell(tool: &str) -> bool {
    matches!(tool, "shell" | USER_MACHINE_SHELL)
}

fn no_opening(call_id: &str) -> String {
    format!("the corpus has neither the opening of {call_id:?} nor a card naming its tool")
}

/// How a step keeps an argument its tool's card withholds.
#[derive(Debug, Clone, Copy)]
enum Withheld {
    /// As its size in bytes.
    Counted,
    /// Whole up to this many characters, cut there with "…" past them, or as the redaction mark
    /// when it looks like a key.
    Clipped(usize),
    /// Without its query or fragment, where a link's token rides.
    PageOnly,
    /// Not at all.
    Dropped,
    /// As the redaction mark.
    Marked,
}

/// The arguments the server's own tools withhold from a step, and how: the approval card's
/// rules, which `step_arguments` and `redact_value` in `gen_ui.rs` apply after opengrok-server
/// `cards.rs` `summary_for` and opengrok-tools `review.rs` `redact_arguments`. Written out here
/// rather than read from there, so a step is held to the rules and not to whatever that code
/// does; a rule changed there is changed here too, on purpose.
const WITHHELD_ARGUMENTS: &[(&str, &str, Withheld)] = &[
    ("write_file", "content", Withheld::Counted),
    ("computer", "text", Withheld::Clipped(60)),
    ("computer", "key", Withheld::Clipped(40)),
    ("open_url", "url", Withheld::PageOnly),
    ("run_recipe", "values", Withheld::Dropped),
];

/// The server's own tools, which withhold only what [`WITHHELD_ARGUMENTS`] names. Any other tool
/// is a plugin's. `use_skill` is the one a bot reads an attached skill through (#270, recorded
/// since #290): its `name` is kept as sent, which the plugin rule would not do for a long one.
const SERVERS_TOOLS: &[&str] = &[
    "shell",
    USER_MACHINE_SHELL,
    "read_file",
    "write_file",
    "computer",
    "open_url",
    "run_recipe",
    USE_SKILL,
];

/// The keys a plugin's card leaves off, which the server fills in itself (`redact_value`).
const PLUGIN_IDENTITY_KEYS: &[&str] = &[
    "account_id",
    "accountId",
    "coworker_id",
    "coworkerId",
    "box_id",
    "boxId",
];

/// The words that make a plugin's argument a secret wherever they are in its name, in any case
/// (`redact_value`).
const PLUGIN_SECRET_NAMES: &[&str] = &[
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

/// What a withheld value reads as (`REDACTED` in `gen_ui.rs`, after opengrok-tools `review.rs`).
const REDACTION_MARK: &str = "«redacted»";

/// How a tool's card withholds one argument, or `None` for one it keeps as sent.
fn withheld(tool: &str, key: &str) -> Option<Withheld> {
    if let Some((_, _, how)) = WITHHELD_ARGUMENTS
        .iter()
        .find(|(named_tool, named_key, _)| *named_tool == tool && *named_key == key)
    {
        return Some(*how);
    }
    if SERVERS_TOOLS.contains(&tool) {
        return None;
    }
    if PLUGIN_IDENTITY_KEYS.contains(&key) {
        return Some(Withheld::Dropped);
    }
    let name = key.to_ascii_lowercase();
    PLUGIN_SECRET_NAMES
        .iter()
        .any(|secret| name.contains(secret))
        .then_some(Withheld::Marked)
}

/// Whether `kept` is `sent` as `how` withholds it. A value the rule is not about (a count where a
/// text was expected) is kept as sent, as the card keeps it.
fn withheld_as(how: Withheld, sent: &Value, kept: Option<&Value>) -> bool {
    match (how, sent.as_str(), kept) {
        (Withheld::Dropped, _, kept) => kept.is_none(),
        (Withheld::Marked, _, kept) => kept.and_then(Value::as_str) == Some(REDACTION_MARK),
        (_, None, kept) => kept == Some(sent),
        (Withheld::Counted, Some(text), kept) => {
            kept.and_then(Value::as_u64) == u64::try_from(text.len()).ok()
        }
        (Withheld::Clipped(max), Some(text), Some(Value::String(kept))) => {
            let whole = kept == text && text.chars().count() <= max;
            let cut = kept
                .strip_suffix('…')
                .is_some_and(|shown| shown.chars().count() == max && text.starts_with(shown));
            whole || cut || kept == REDACTION_MARK
        }
        (Withheld::PageOnly, Some(url), Some(Value::String(kept))) => {
            url.split(['?', '#']).next() == Some(kept.as_str())
        }
        _ => false,
    }
}

/// Whether `kept` is `sent` changed only as a plugin's card changes a value it does not name: an
/// identity key gone from an object inside it, and a value named or shaped like a secret read as
/// the redaction mark.
fn marked_copy(sent: &Value, kept: &Value) -> bool {
    match (sent, kept) {
        (_, Value::String(kept)) if kept == REDACTION_MARK => true,
        (Value::Object(sent), Value::Object(kept)) => {
            kept.keys().all(|key| sent.contains_key(key))
                && sent.iter().all(|(key, value)| match kept.get(key) {
                    Some(kept) => marked_copy(value, kept),
                    None => PLUGIN_IDENTITY_KEYS.contains(&key.as_str()),
                })
        }
        (Value::Array(sent), Value::Array(kept)) => {
            sent.len() == kept.len()
                && sent
                    .iter()
                    .zip(kept)
                    .all(|(sent, kept)| marked_copy(sent, kept))
        }
        (sent, kept) => sent == kept,
    }
}

/// A step's arguments held to the card's rules as stated above, not as `step_arguments` computes
/// them: every key comes through as sent, except one the rules withhold, which comes through cut
/// to the rule's bound or not at all; and nothing is kept that was not sent.
fn kept_as_the_card_allows(tool: &str, sent: &Value, kept: &Value) -> Check {
    let (Some(sent), Some(kept)) = (sent.as_object(), kept.as_object()) else {
        return Err(format!(
            "a {tool} call's arguments, and what its step keeps of them, are objects: {sent} kept \
             as {kept}"
        ));
    };
    let plugin = !SERVERS_TOOLS.contains(&tool);
    for (key, value) in sent {
        let held = kept.get(key);
        match withheld(tool, key) {
            Some(how) => must!(
                withheld_as(how, value, held),
                "a {tool} call's {key:?} should be kept {how:?}, not as {held:?}"
            ),
            None => must!(
                held == Some(value)
                    || (plugin && held.is_some_and(|held| marked_copy(value, held))),
                "a {tool} call's {key:?} should be kept as sent, {value}, not as {held:?}"
            ),
        }
    }
    let invented: Vec<&String> = kept.keys().filter(|key| !sent.contains_key(*key)).collect();
    must!(
        invented.is_empty(),
        "the step for a {tool} call keeps {invented:?}, which the call never sent"
    );
    Ok(())
}

fn tool_call_start(frame: &Value) -> Check {
    let mut tracker = ToolCallTracker::default();
    let status = tracker.tick(frame);
    let tool = str_at(frame, "toolCallName");
    must!(
        matches!(&status, ActivityTick::Set(activity)
            if activity.label != "Working" && activity.label != format!("Using {tool}")),
        "TOOL_CALL_START should name what is being done, not {status:?}"
    );
    must!(
        tracker.deeds().len() == 1,
        "the call should be one thing the turn did, got {:?}",
        tracker.deeds()
    );
    // A call is a step of the reply from the moment it starts, unless it is drawn as itself,
    // which it is once its arguments are all in.
    let call_id = str_at(frame, "toolCallId");
    let (_, parts) = assembled(&[frame]).snapshot();
    let expected = match drawn_as(tool) {
        Drawn::Step => vec![ChatPart::Step(StepSpec {
            call_id: call_id.to_string(),
            tool: tool.to_string(),
            arguments: String::new(),
            result: None,
            ok: None,
            took_ms: None,
        })],
        Drawn::Widget | Drawn::UserForm => Vec::new(),
    };
    must!(
        parts == expected,
        "TOOL_CALL_START for {tool:?} should draw {expected:?}, got {parts:?}"
    );
    Ok(())
}

/// Arguments on their way. With them in, the status line says what the call does in its own
/// words; nothing of them is drawn yet, whatever the call is drawn as; and a shell's command
/// reads back as sent, which is what its permission card shows.
fn tool_call_args(corpus: &Corpus, frame: &Value) -> Check {
    let call_id = str_at(frame, "toolCallId");
    let delta = str_at(frame, "delta");
    let start = corpus
        .tool_call_start_for(call_id)
        .ok_or_else(|| no_opening(call_id))?;
    let tool = str_at(&start, "toolCallName");
    // A delta may be a fragment of the arguments; this recording sends each call's whole.
    let sent = serde_json::from_str::<Value>(delta).ok();
    let mut tracker = ToolCallTracker::default();
    tracker.tick(&start);
    let status = tracker.tick(frame);
    must!(
        matches!(&status, ActivityTick::Set(activity)
            if activity.label != "Working" && activity.label != format!("Using {tool}")),
        "with its arguments in, a {tool} call should say what it does, not {status:?}"
    );
    if is_shell(tool) {
        let command = command_from_replay_events(std::slice::from_ref(frame), call_id);
        let sent = sent
            .as_ref()
            .and_then(|arguments| arguments.get("command"))
            .and_then(Value::as_str);
        must!(
            sent.is_some() && sent == Some(command.as_str()),
            "the command of {call_id:?} should read back as {sent:?}, got {command:?}"
        );
    }
    let (_, parts) = assembled(&[&start, frame]).snapshot();
    match drawn_as(tool) {
        // The step holds none of the text the arguments come as while they are coming: what it
        // keeps of them is decided when they end (see `tool_call_end`).
        Drawn::Step => must!(
            parts.iter().any(
                |part| matches!(part, ChatPart::Step(step) if step.call_id == call_id && step.arguments.is_empty())
            ),
            "the step for {call_id:?} should hold none of its argument text before its end: {parts:?}"
        ),
        // A widget or a form is drawn from its whole arguments, never from half of them.
        Drawn::Widget | Drawn::UserForm => must!(
            parts.is_empty(),
            "a {tool} call draws nothing before its arguments end: {parts:?}"
        ),
    }
    Ok(())
}

/// The end of a call says Thinking, and is where the call is drawn from its whole arguments. A
/// step keeps them as the approval card's rules let it say them, which for a shell is the
/// arguments as they came and for any other tool is [`kept_as_the_card_allows`]; a user-form
/// becomes the card it asks for; a widget mounts.
fn tool_call_end(corpus: &Corpus, frame: &Value) -> Check {
    must!(
        tick(frame) == label("Thinking"),
        "TOOL_CALL_END should say Thinking, not {:?}",
        tick(frame)
    );
    let call_id = str_at(frame, "toolCallId");
    let start = corpus
        .tool_call_start_for(call_id)
        .ok_or_else(|| no_opening(call_id))?;
    let args = corpus
        .call_frame("TOOL_CALL_ARGS", call_id)
        .ok_or("the corpus has no TOOL_CALL_ARGS for the call")?;
    let tool = str_at(&start, "toolCallName");
    let sent: Value = serde_json::from_str(str_at(args, "delta"))
        .map_err(|error| format!("the fixture's arguments are not JSON: {error}"))?;
    let assembler = assembled(&[&start, args, frame]);
    let (_, parts) = assembler.snapshot();
    match drawn_as(tool) {
        Drawn::Step => {
            let step = parts
                .iter()
                .find_map(|part| match part {
                    ChatPart::Step(step) if step.call_id == call_id => Some(step),
                    _ => None,
                })
                .ok_or_else(|| {
                    format!(
                        "the call {call_id:?} should be a step once its arguments end: {parts:?}"
                    )
                })?;
            if is_shell(tool) {
                // A shell's command is what its card shows, so its step keeps the arguments as
                // they came, to the step's cap.
                let sent = capped(&sent.to_string());
                must!(
                    step.arguments == sent,
                    "the step for {call_id:?} should keep {sent:?} once its arguments end, not \
                     {:?}",
                    step.arguments
                );
            } else {
                let kept: Value = serde_json::from_str(&step.arguments).map_err(|error| {
                    format!(
                        "the step for {call_id:?} keeps arguments that do not read back ({error}): \
                         {:?}",
                        step.arguments
                    )
                })?;
                kept_as_the_card_allows(tool, &sent, &kept)?;
            }
        }
        // Keyed by its call: the call's frames carry the gateway `entryId` too, and the card
        // takes its id from the `run-awaiting-approval` the server sends right after them
        // (opengrok-server `agui/routes.rs` `AgUiSink::emit` releases a form's held call frames
        // just before its stamped CUSTOM), folding the two into one card by the call id.
        Drawn::UserForm => {
            let fields = sent
                .get("fields")
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            let asked = |part: &ChatPart| {
                matches!(part, ChatPart::UserForm(card)
                    if card.call_id == call_id
                        && card.title == str_at(&sent, "title")
                        && card.fields.len() == fields
                        && card.is_unresolved())
            };
            must!(
                parts.len() == 1 && parts.iter().any(asked),
                "a {tool} call should be drawn as the open card it asks for, and nothing else: \
                 {parts:?}"
            );
            must!(
                assembler.waiting_user_form(),
                "the card waits on the person"
            );
        }
        Drawn::Widget => must!(
            parts.iter().any(|part| matches!(part, ChatPart::Ui(_)))
                && !parts.iter().any(|part| matches!(part, ChatPart::Step(_))),
            "a {tool} call should mount as its widget and not as a step: {parts:?}"
        ),
    }
    Ok(())
}

/// A result leaves the status line as it was, and lands where its call is drawn.
fn tool_call_result(corpus: &Corpus, frame: &Value) -> Check {
    must!(
        tick(frame) == ActivityTick::Keep,
        "a result should leave the status line as it was, not {:?}",
        tick(frame)
    );
    let call_id = str_at(frame, "toolCallId");
    let start = corpus
        .tool_call_start_for(call_id)
        .ok_or_else(|| no_opening(call_id))?;
    match drawn_as(str_at(&start, "toolCallName")) {
        Drawn::Step => step_result(corpus, frame, &start),
        Drawn::Widget | Drawn::UserForm => drawn_result(corpus, frame, &start),
    }
}

/// A step's result lands on the step, as sent, and on the permission card the call waited on,
/// which it answers. While the card waits the call is drawn as the card alone; once its result
/// is in, it is a step again. A picture on the result goes where its visibility says.
fn step_result(corpus: &Corpus, frame: &Value, start: &Value) -> Check {
    let call_id = str_at(frame, "toolCallId");
    let content = str_at(frame, "content");
    let card = corpus
        .approval_card_for(call_id)
        .ok_or("the corpus has no permission card to answer")?;
    let assembler = assembled(&[&card, frame]);
    must!(
        !assembler.waiting_approval(),
        "a result means the card was answered"
    );
    let (_, parts) = assembler.snapshot();
    let ok = frame.get("ok").and_then(Value::as_bool);
    let answered = |spec: &super::gen_ui::ApprovalSpec| {
        spec.call_id == call_id && spec.output.as_deref() == Some(content) && spec.ok == ok
    };
    must!(
        parts
            .iter()
            .any(|part| matches!(part, ChatPart::Approval(spec) if answered(spec))),
        "the result should land on the card for {call_id:?}: {parts:?}"
    );
    let came_back = |step: &StepSpec| {
        step.call_id == call_id && step.result.as_deref() == Some(content) && step.ok == ok
    };
    let (_, stepped) = assembled(&[start, frame]).snapshot();
    must!(
        stepped
            .iter()
            .any(|part| matches!(part, ChatPart::Step(step) if came_back(step))),
        "the result should land on the step for {call_id:?}: {stepped:?}"
    );
    let (_, waiting) = assembled(&[start, &card]).snapshot();
    must!(
        !waiting
            .iter()
            .any(|part| matches!(part, ChatPart::Step(step) if step.call_id == call_id)),
        "a call waiting on its card is drawn as the card and not also as a step: {waiting:?}"
    );
    let (_, answered) = assembled(&[start, &card, frame]).snapshot();
    must!(
        answered
            .iter()
            .any(|part| matches!(part, ChatPart::Step(step) if came_back(step))),
        "a call whose card was answered is a step with its result: {answered:?}"
    );
    if let Some(image) = frame.get("image") {
        let shot = assembler
            .latest_screenshot()
            .ok_or("the picture on the result was not kept")?;
        must!(
            Some(u64::from(shot.width)) == image.get("width").and_then(Value::as_u64)
                && Some(u64::from(shot.height)) == image.get("height").and_then(Value::as_u64),
            "the picture is {}x{}, not what the frame says",
            shot.width,
            shot.height
        );
        let visibility = ImageVisibility::parse(str_at(image, "visibility"));
        must!(
            shot.visibility == visibility,
            "the picture should be {visibility:?}, not {:?}",
            shot.visibility
        );
        let pinned = parts
            .iter()
            .any(|part| matches!(part, ChatPart::Screenshot(pinned) if pinned.call_id == call_id));
        must!(
            pinned != (visibility == Some(ImageVisibility::Agent)),
            "an agent picture stays in the Computer pane and any other goes in the feed"
        );
    }
    Ok(())
}

/// The result of a call drawn as itself changes nothing drawn. For a user-form it is the
/// server's word that the run is parked on the person ("waiting for approval: …"), and the card
/// stays open and waiting; for a widget it is this app's own answer coming back. Either way the
/// call is no step and the result no permission card.
fn drawn_result(corpus: &Corpus, frame: &Value, start: &Value) -> Check {
    let call_id = str_at(frame, "toolCallId");
    let tool = str_at(start, "toolCallName");
    let mut frames: Vec<&Value> = vec![start];
    frames.extend(corpus.call_frame("TOOL_CALL_ARGS", call_id));
    frames.extend(corpus.call_frame("TOOL_CALL_END", call_id));
    let (_, before) = assembled(&frames).snapshot();
    frames.push(frame);
    let assembler = assembled(&frames);
    let (_, after) = assembler.snapshot();
    must!(
        after == before,
        "the result of a {tool} call should leave what it drew as it was: {before:?} became \
         {after:?}"
    );
    must!(
        !after
            .iter()
            .any(|part| matches!(part, ChatPart::Step(_) | ChatPart::Approval(_))),
        "a {tool} call is neither a step nor a permission card: {after:?}"
    );
    if drawn_as(tool) == Drawn::UserForm {
        must!(
            after.iter().any(
                |part| matches!(part, ChatPart::UserForm(card) if card.call_id == call_id && card.is_unresolved())
            ) && assembler.waiting_user_form(),
            "the card for {call_id:?} should still be open and waiting on the person: {after:?}"
        );
    }
    Ok(())
}

/// A reasoning frame puts Thinking on the status line while the coworker thinks and leaves it
/// alone when the thought ends, and the message it belongs to is one thought in the reply that
/// reads as the fixture's words and is none of the reply's own. The end is what closes it.
fn reasoning(corpus: &Corpus, frame: &Value) -> Check {
    let kind = str_at(frame, "type");
    let status = if kind == "REASONING_MESSAGE_END" {
        ActivityTick::Keep
    } else {
        label("Thinking")
    };
    must!(
        tick(frame) == status,
        "{kind} should leave the status line at {status:?}, not {:?}",
        tick(frame)
    );
    let message = corpus.reasoning_frames(str_at(frame, "messageId"));
    let said: String = message
        .iter()
        .filter(|frame| str_at(frame, "type") == "REASONING_MESSAGE_CONTENT")
        .map(|frame| str_at(frame, "delta"))
        .collect();
    must!(
        !said.trim().is_empty(),
        "the corpus has no words for the reasoning message of {kind}"
    );
    let (plain, parts) = assembled(&message).snapshot();
    must!(
        parts == vec![ChatPart::Reasoning(said.trim().into())],
        "the reasoning should be one thought reading {said:?}, got {parts:?}"
    );
    must!(
        plain.is_empty(),
        "a thought is not the reply's words: {plain:?}"
    );
    if kind == "REASONING_MESSAGE_END" {
        let still_open: Vec<&Value> = message
            .iter()
            .copied()
            .filter(|frame| str_at(frame, "type") != "REASONING_MESSAGE_END")
            .collect();
        must!(
            assembled(&still_open).snapshot().1.is_empty(),
            "a thought is drawn once its message ends, not while it is still being said"
        );
    }
    Ok(())
}

fn custom(frame: &Value) -> Check {
    match str_at(frame, "name") {
        RUN_AWAITING_APPROVAL => awaiting(frame),
        BOX_WAKING => {
            must!(
                tick(frame) == label(WAKING_COMPUTER),
                "box-waking should say {WAKING_COMPUTER:?}, not {:?}",
                tick(frame)
            );
            nothing_painted(frame)
        }
        RUN_TIMING_CUSTOM | TURN_TIMELINE_CUSTOM => run_timing(frame),
        PENDING_CUSTOM => pending(frame),
        USER_FORM_CUSTOM => settled_form(frame),
        CREDENTIAL_OFFER_SAVE => offer_save(frame),
        INFERENCE_SOURCE_CUSTOM => inference_source_frame(frame),
        super::gen_ui::PLUGIN_NEEDS_CUSTOM => plugin_needs_frame(frame),
        super::gen_ui::OFFICE_DOC_CUSTOM => office_doc_frame(frame),
        name if is_excused(CLIENT_IGNORES, Slot::CustomName, name) => ignored(frame),
        name => Err(format!(
            "no check for a CUSTOM {name:?}: say here what this app does with one"
        )),
    }
}

/// What a tagged plugin still needs (`opengrok.pluginNeeds`, #360): one card, holding every need
/// as sent, each account to choose with its id and label, and nothing waiting, since the run ends
/// with the frame and the card's answer is a new turn.
fn plugin_needs_frame(frame: &Value) -> Check {
    use super::gen_ui::{PluginNeedKind, PluginNeedsSpec};
    let sent = frame["value"]["needs"]
        .as_array()
        .ok_or("the frame should list its needs")?;
    let (_, parts) = assembled(&[frame]).snapshot();
    let [ChatPart::PluginNeeds(card)] = parts.as_slice() else {
        return Err(format!(
            "the frame should paint one needs card, got {parts:?}"
        ));
    };
    must!(
        card.needs.len() == sent.len() && card.send_again,
        "every need should be on the card, which sends the message again: {card:?} from {sent:?}"
    );
    for (need, wire) in card.needs.iter().zip(sent) {
        must!(
            need.plugin == str_at(wire, "plugin"),
            "the need should name its plugin as sent: {need:?} from {wire}"
        );
        if let PluginNeedKind::Choose(accounts) = &need.kind {
            let ids: Vec<&str> = wire["accounts"]
                .as_array()
                .map(|listed| listed.iter().map(|a| str_at(a, "id")).collect())
                .unwrap_or_default();
            let read: Vec<&str> = accounts.iter().map(|(id, ..)| id.as_str()).collect();
            must!(
                ids == read,
                "each account to choose should be the one sent: {read:?} from {ids:?}"
            );
        }
    }
    must!(
        PluginNeedsSpec::from_event(frame).is_some(),
        "the card should come from the frame alone"
    );
    Ok(())
}

/// A document a turn is working on (`opengrok.officeDoc`, gol/betteroffice): one card carrying
/// the frame's own id, path, kind and version, and the window's ledger holding the same doc as
/// the turn's live one.
fn office_doc_frame(frame: &Value) -> Check {
    let value = &frame["value"];
    let doc_id = str_at(value, "docId");
    let (_, parts) = assembled(&[frame]).snapshot();
    let [ChatPart::OfficeDoc(card)] = parts.as_slice() else {
        return Err(format!(
            "the frame should paint one document card, got {parts:?}"
        ));
    };
    must!(
        card.doc_id == doc_id
            && card.path == str_at(value, "path")
            && card.kind == str_at(value, "kind")
            && card.version == value["version"].as_u64().unwrap_or(u64::MAX),
        "the card should carry the frame's own identity and version: {card:?} from {value}"
    );
    Ok(())
}

/// Which door a run goes through (`opengrok.inferenceSource`): it says nothing on the status line
/// and paints nothing among the reply's words, and the reply's badge is the frame's own kind and
/// model, as the assembler reads it live and in a replay alike.
fn inference_source_frame(frame: &Value) -> Check {
    must!(
        tick(frame) == ActivityTick::Keep,
        "which door a run goes through is not something the coworker is doing: {:?}",
        tick(frame)
    );
    nothing_painted(frame)?;
    let assembler = assembled(&[frame]);
    let source = assembler
        .reply_source()
        .ok_or("the frame should give the reply its badge")?;
    let value = &frame["value"];
    let model = opt_str(value, "model")
        .map(str::trim)
        .filter(|model| !model.is_empty());
    must!(
        source.kind.word() == str_at(value, "kind") && source.model.as_deref() == model,
        "the badge should be the frame's kind and model as sent: {source:?} from {value}"
    );
    // The way the plan was reached (`via`), from a server with the Mac relay (opengrok-server main
    // cad36fd (#303, after #298), pin 47a5d6b): as sent on the
    // plan's badge, when it is one this app can name.
    let via = opt_str(value, "via")
        .and_then(Via::from_word)
        .filter(|_| source.kind == InferenceKind::LocalProxy);
    must!(
        source.via == via,
        "the badge should say the way as sent: {source:?} from {value}"
    );
    // Why the server's keys answered (opengrok-server #332 (PR #338 at 66b9f7b): `fallbackFor`,
    // written by `converse_raw` in `crates/opengrok-harness/src/lib.rs`): as sent on the
    // gateway's badge, when it is a reason this app knows.
    let fallback_for = opt_str(value, "fallbackFor")
        .and_then(FallbackFor::from_word)
        .filter(|_| source.kind == InferenceKind::Gateway);
    must!(
        source.fallback_for == fallback_for,
        "the badge should say why the server's keys answered as sent: {source:?} from {value}"
    );
    Ok(())
}

/// A frame this app has no arm for leaves the turn as it was.
fn ignored(frame: &Value) -> Check {
    must!(
        tick(frame) == ActivityTick::Keep,
        "an ignored frame should leave the status line alone, not {:?}",
        tick(frame)
    );
    nothing_painted(frame)
}

fn nothing_painted(frame: &Value) -> Check {
    let assembler = assembled(&[frame]);
    let (plain, parts) = assembler.snapshot();
    must!(
        plain.is_empty() && parts.is_empty(),
        "nothing should be painted, got {plain:?} {parts:?}"
    );
    must!(
        !assembler.waiting_approval() && !assembler.waiting_user_form(),
        "nothing should be waiting"
    );
    Ok(())
}

fn awaiting(frame: &Value) -> Check {
    let reason = str_at(frame, "reason");
    let assembler = assembled(&[frame]);
    let (_, parts) = assembler.snapshot();
    if reason == USER_FORM_REASON {
        must!(is_user_form_awaiting(frame), "a user-form park is a form");
        let spec = UserFormSpec::from_awaiting_event(frame, None)
            .ok_or("the form did not parse from its arguments")?;
        must!(
            spec.entry_id == str_at(frame, "entryId")
                && spec.call_id == str_at(frame, "callId")
                && spec.run_id == str_at(frame, "runId"),
            "the card should carry the frame's entryId, callId and runId: {spec:?}"
        );
        let fields = frame
            .pointer("/arguments/fields")
            .and_then(Value::as_array)
            .ok_or("a form with no fields")?;
        let secret = fields
            .iter()
            .filter(|field| {
                matches!(str_at(field, "type"), "password" | "otp")
                    || field.get("secret").and_then(Value::as_bool) == Some(true)
            })
            .count();
        must!(
            spec.fields.len() == fields.len()
                && spec.fields.iter().filter(|field| field.masked()).count() == secret,
            "every field should show, and every secret one masked: {:?}",
            spec.fields
        );
        // Open unless the frame itself says the card was settled. A replay lays the card's
        // entry over its park (opengrok-server `agui/user_form.rs` `overlay_form`):
        // `formResolution` beside the arguments and the entry, `widgetDismissed` too, in
        // `value`. A card settled after its run stopped waiting gets no later `user-form` frame
        // (`journal_agui_custom` journals none onto a run that no longer waits), so the park is
        // the only place its settlement is said (#139). An escalation is the computer's
        // sibling, not a settlement of the form.
        // The entry folded into `value` speaks for this card only when it names this call or
        // none: the server can match another card's entry by title and fields alone.
        let ours = str_at(frame, "callId");
        let entry = frame.get("value").filter(|entry| {
            let theirs = str_at(entry, "callId");
            theirs.is_empty() || ours.is_empty() || theirs == ours
        });
        // Each object's word as the client reads it: its own `formResolution` (a null there
        // says none, as the client takes it), else its message's, through the client's own
        // spelling rules.
        let word = |object: &Value| {
            object
                .get("formResolution")
                .or_else(|| object.pointer("/message/formResolution"))
                .and_then(Value::as_str)
                .map(FormResolution::parse)
        };
        let flag = |object: &Value| match object.get("widgetDismissed") {
            Some(Value::Bool(on)) => *on,
            Some(Value::String(text)) => text.eq_ignore_ascii_case("true") || text == "1",
            _ => false,
        };
        let objects: Vec<&Value> = std::iter::once(frame).chain(entry).collect();
        let words: Vec<FormResolution> = objects.iter().copied().filter_map(word).collect();
        let escalated = words.contains(&FormResolution::Escalated);
        // How an escalation's hand-off ended, stamped on the form's entry once it settles
        // (#143): any word at all ends it, and none means the computer still needs the person.
        let handed_off = escalated
            && objects.iter().any(|object| {
                object
                    .get("boxResolution")
                    .and_then(Value::as_str)
                    .is_some_and(|word| !word.trim().is_empty())
            });
        let dismissed = !escalated && objects.iter().copied().any(flag);
        let settled = handed_off || (!escalated && (!words.is_empty() || dismissed));
        if escalated {
            let computer = spec.computer_handoff;
            must!(
                if handed_off {
                    matches!(
                        computer,
                        Some(ComputerHandoffStatus::Done | ComputerHandoffStatus::Skipped)
                    )
                } else {
                    computer == Some(ComputerHandoffStatus::ActionNeeded)
                },
                "an escalated form hands the page to the computer until the hand-off ends: \
                 {spec:?}"
            );
        }
        must!(
            spec.title == str_at(&frame["arguments"], "title") && spec.is_unresolved() != settled,
            "the card titled as the form, {}: {spec:?}",
            if settled {
                "settled as its frame says"
            } else {
                "open"
            }
        );
        let card = |part: &ChatPart| matches!(part, ChatPart::UserForm(card) if card.entry_id == spec.entry_id);
        must!(
            assembler.waiting_user_form() != settled
                && parts.iter().any(card)
                && !parts
                    .iter()
                    .any(|part| matches!(part, ChatPart::Approval(_))),
            "a form card, and not a permission card: {parts:?}"
        );
        let expected = if settled {
            ActivityTick::Clear
        } else {
            label(WAITING_FOR_YOU)
        };
        must!(
            tick(frame) == expected,
            "a form should tick {expected:?}, not {:?}",
            tick(frame)
        );
        return Ok(());
    }
    let spec = approval_from_event(frame).ok_or("the card did not parse")?;
    must!(
        spec.run_id == str_at(frame, "runId")
            && spec.call_id == str_at(frame, "callId")
            && spec.tool == str_at(frame, "tool")
            && spec.reason == reason
            && spec.why == str_at(frame, "why")
            && spec.thread_id.as_deref() == frame.get("threadId").and_then(Value::as_str),
        "the card should carry the frame's run, call, tool, reason and why: {spec:?}"
    );
    holds_the_servers_sentence(
        str_at(frame, "tool"),
        frame.get("arguments").unwrap_or(&Value::Null),
        frame.get("summary"),
    )?;
    if let Some(command) = frame.pointer("/arguments/command").and_then(Value::as_str) {
        must!(
            spec.command == command,
            "the card should show {command:?}, not {:?}",
            spec.command
        );
    }
    let arguments = frame.get("arguments").unwrap_or(&Value::Null);
    if arguments.is_object() && !matches!(spec.tool.as_str(), "shell" | USER_MACHINE_SHELL) {
        must!(
            !spec.summary.is_empty(),
            "a {} call should say what it would do",
            spec.tool
        );
    }
    must!(
        assembler.waiting_approval()
            && parts.iter().any(
                |part| matches!(part, ChatPart::Approval(card) if card.call_id == spec.call_id)
            ),
        "a permission card should be up and waiting: {parts:?}"
    );
    must!(
        tick(frame) == label("Waiting for approval"),
        "a card should say Waiting for approval, not {:?}",
        tick(frame)
    );
    match reason {
        "auto-review" => {
            must!(
                spec.is_review_an_action(),
                "auto-review is the Review-an-action card"
            );
            let tunnel = spec.why.trim() == EGRESS_TUNNEL_ASK_REASON && !spec.runs_on_this_mac();
            must!(
                spec.is_egress_tunnel() == tunnel,
                "only the tunnel's own sentence makes the tunnel's card"
            );
        }
        "exec-consent" | "policy-approval" => must!(
            !spec.is_review_an_action() && !spec.is_egress_tunnel(),
            "{reason} is the plain permission card"
        ),
        other => return Err(format!("no expectation for a card with reason {other:?}")),
    }
    Ok(())
}

fn run_timing(frame: &Value) -> Check {
    let timing = TurnTiming::from_event(frame).ok_or("the timing did not parse")?;
    let value = frame.get("value").unwrap_or(frame);
    let rounds = value
        .get("tool_rounds")
        .and_then(Value::as_u64)
        .and_then(|rounds| u32::try_from(rounds).ok());
    let tools = value
        .get("tools")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    must!(
        timing.tool_rounds == rounds
            && timing.tools.len() == tools
            && timing.total_ms == value.get("total_ms").and_then(Value::as_u64),
        "the timing should keep its rounds, tools and total: {timing:?}"
    );
    must!(
        tick(frame) == ActivityTick::Keep,
        "timing is not a status, got {:?}",
        tick(frame)
    );
    nothing_painted(frame)
}

/// A queue mutation, as `apply_pending_event` takes it: what was done, on which thread, and the
/// send as it now stands, which every op but a cancel carries (opengrok-server
/// `agui/pending.rs` `custom_event`; a cancel omits the text of a send taken back).
fn pending(frame: &Value) -> Check {
    let custom = PendingCustom::from_agui(frame).ok_or("the pending frame did not parse")?;
    let value = &frame["value"];
    must!(
        Some(custom.op) == PendingOp::parse(str_at(value, "op"))
            && custom.thread_id == str_at(value, "threadId"),
        "the op and the thread should come through: {custom:?}"
    );
    match (value.get("message"), &custom.message) {
        (Some(raw), Some(message)) => held_as_sent(message, raw)?,
        (None, None) => must!(
            custom.op == PendingOp::Canceled,
            "only a cancel comes without the send: {custom:?}"
        ),
        (raw, message) => {
            return Err(format!(
                "the row and its parse disagree: {raw:?} against {message:?}"
            ));
        }
    }
    Ok(())
}

/// One pending row, read as the queue holds it (`hold_from_row` in `state.rs`): the server's id,
/// the bubble it is — the client's own `clientMessageId`, or the server's id for a row minted
/// without one, which `bubble_id` falls back to — its words, the recipe and the values it runs
/// with, the skill, and the message it answers. The status and the drained stamps are the
/// server's bookkeeping, and the queue reads none of them.
fn held_as_sent(message: &PendingUserMessage, raw: &Value) -> Check {
    let bubble = opt_str(raw, "clientMessageId")
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| str_at(raw, "id"));
    must!(
        !message.id.is_empty()
            && message.id == str_at(raw, "id")
            && message.content == str_at(raw, "content")
            && message.bubble_id() == bubble,
        "the row should be the same bubble with the same words: {message:?}"
    );
    let given = |key: &str| raw.get(key).filter(|value| !value.is_null());
    must!(
        message.recipe_id.as_deref() == opt_str(raw, "recipeId")
            && message.recipe_values.as_ref() == given("recipeValues")
            && message.skill_id.as_deref() == opt_str(raw, "skillId")
            && message.reply_to.as_ref() == given("replyTo"),
        "the send's recipe, skill and reply should come through as sent: {message:?}"
    );
    // The door it was queued with, on the row only when the send named one (opengrok-server
    // #294: `message_json` in `crates/opengrok-server/src/agui/pending.rs`): the bare word, or
    // with the Mac relay `{"kind", "via"}` (server main cad36fd (#303, after #298), pin 47a5d6b).
    must!(
        message.inference_source() == raw.get("inferenceSource").and_then(TurnSource::from_value),
        "the send's door should come through as sent: {message:?}"
    );
    // Held for the person's Mac while no Mac holds the relay (`heldFor`, read per reply by
    // `Held::of` in the same file, PR #298).
    must!(
        message.waits_for_mac() == (opt_str(raw, "heldFor") == Some("relay_offline")),
        "whether the send waits for the Mac should come through as sent: {message:?}"
    );
    Ok(())
}

fn settled_form(frame: &Value) -> Check {
    let spec = UserFormSpec::from_custom_event(frame).ok_or("the settled card did not parse")?;
    must!(
        spec.entry_id == str_at(frame, "entryId") && spec.call_id == str_at(frame, "callId"),
        "the card should keep its entryId and callId: {spec:?}"
    );
    let word = str_at(frame, "formResolution");
    let resolution = FormResolution::parse(word);
    if resolution == FormResolution::Escalated {
        // Once the hand-off ends, the server stamps the form's entry with the box's word
        // (opengrok-server #277, #143), read the way the live answer paints it; until then the
        // Computer card beside the form is live.
        let ended = [
            frame.get("boxResolution"),
            frame.pointer("/value/boxResolution"),
        ]
        .into_iter()
        .flatten()
        .find_map(Value::as_str)
        .filter(|word| !word.trim().is_empty());
        let expected = match ended {
            None => (None, ComputerHandoffStatus::ActionNeeded),
            Some("handed_back") => (Some(FormResolution::Dismissed), ComputerHandoffStatus::Done),
            Some("declined" | "timed_out") => (
                Some(FormResolution::Skipped),
                ComputerHandoffStatus::Skipped,
            ),
            Some(_) => (
                Some(FormResolution::Dismissed),
                ComputerHandoffStatus::Skipped,
            ),
        };
        must!(
            (spec.effective_resolution(), spec.computer_handoff) == (expected.0, Some(expected.1)),
            "escalated, then {ended:?}, should read as {expected:?}: {spec:?}"
        );
    } else {
        must!(
            spec.effective_resolution() == Some(resolution),
            "the card should settle as {word:?}: {spec:?}"
        );
    }
    let settled = spec.effective_resolution().is_some();
    let expected = if settled {
        ActivityTick::Clear
    } else {
        label(WAITING_FOR_YOU)
    };
    must!(
        tick(frame) == expected,
        "a settled card clears the status line, got {:?}",
        tick(frame)
    );
    let (_, parts) = assembled(&[frame]).snapshot();
    let painted = |card: &UserFormSpec| {
        card.entry_id == spec.entry_id && card.effective_resolution() == spec.effective_resolution()
    };
    must!(
        parts
            .iter()
            .any(|part| matches!(part, ChatPart::UserForm(card) if painted(card))),
        "the settled card should paint: {parts:?}"
    );
    Ok(())
}

fn offer_save(frame: &Value) -> Check {
    let spec = SaveLoginSpec::from_event(frame).ok_or("the save offer did not parse")?;
    let value = &frame["value"];
    must!(
        spec.origin == str_at(value, "origin")
            && spec.username == str_at(value, "username")
            && spec.form_entry_id == str_at(value, "formEntryId"),
        "the offer should name the site, the account and its form: {spec:?}"
    );
    let (_, parts) = assembled(&[frame]).snapshot();
    must!(
        parts.contains(&ChatPart::SaveLogin(spec.clone())),
        "the offer should paint: {parts:?}"
    );
    Ok(())
}

// ---- what each REST body is read as ----

/// How this app reads one recorded answer, from its status and its body.
type RestCheck = fn(u16, &Value) -> Check;

/// Every route the corpus records that this app asks, by the directory #255 files it under, and
/// how the app reads a success from it: parsed with the very type the client parses it with, and
/// the fields the app goes on to use held to what the server sent. A refusal from any of them is
/// read the way the client reads one, in [`read_fixture`].
const REST_ROUTES: &[(&str, RestCheck)] = &[
    // Signing in, and the account.
    ("POST__auth_login", session_in_cookies),
    ("POST__auth_refresh", session_in_cookies),
    ("POST__auth_logout", read_as_done),
    ("GET__account", account),
    // The time zone this computer keeps on the account (`set_time_zone`), answered as a read is.
    ("PUT__account", account),
    // Turns, threads and the queue of sends waiting on a busy coworker.
    ("POST__ag-ui", turn_stream),
    ("GET__ag-ui_threads", thread_list),
    ("GET__ag-ui_threads__thread_id_", thread_replay),
    ("GET__ag-ui_runs__run_id_", run_replay),
    ("POST__ag-ui_runs__run_id__stop", stopped),
    ("POST__ag-ui_runs__run_id__hide", read_as_done),
    ("GET__ag-ui_threads__thread_id__pending", pending_list),
    ("POST__ag-ui_threads__thread_id__pending", pending_created),
    (
        "PATCH__ag-ui_threads__thread_id__pending__id_",
        pending_edited,
    ),
    (
        "DELETE__ag-ui_threads__thread_id__pending__id_",
        pending_canceled,
    ),
    ("GET__artifacts", sent_files),
    ("POST__artifacts", uploaded),
    // Cards, and the host settings the tunnel's card is gated on.
    ("GET__ag-ui_approvals", approvals),
    ("POST__ag-ui_runs__run_id__answer", answer),
    ("POST__ag-ui_user-form_submit", user_form_answer),
    ("POST__ag-ui_user-form_dismiss", user_form_answer),
    ("POST__ag-ui_box-handoff_resolve", box_handoff),
    ("GET__ag-ui_host-settings", host_settings),
    ("PUT__ag-ui_host-settings", host_settings),
    // Coworkers and their computers.
    ("GET__coworkers", coworkers),
    ("POST__coworkers", coworker_row),
    ("PATCH__coworkers__coworker_id_", coworker_row),
    ("DELETE__coworkers__coworker_id_", coworker_deleted),
    ("GET__coworkers__coworker_id__tools", coworker_tools),
    ("GET__coworkers__coworker_id__ceiling", coworker_ceiling),
    ("PUT__coworkers__coworker_id__ceiling", coworker_ceiling),
    ("PUT__coworkers__coworker_id__tool-mode", tool_mode),
    ("GET__coworkers__coworker_id__skills", coworker_skills),
    ("PUT__coworkers__coworker_id__skills", coworker_skills),
    ("GET__connections", connections_listed),
    ("GET__connections__id__reconnect", sign_in_link),
    ("PATCH__connections__id_", connection_changed),
    ("GET__connections_pins", connection_pins),
    (
        "PUT__coworkers__coworker_id__pins__connector_",
        connection_pin,
    ),
    (
        "DELETE__coworkers__coworker_id__pins__connector_",
        connection_gone,
    ),
    ("POST__connections__id__lend", connection_changed),
    ("POST__connections__id__revoke", connection_changed),
    ("DELETE__connections__id_", connection_gone),
    ("GET__connectors", connectors_listed),
    // Sign-ins that have not finished (#359): what the app shows as Needs Auth, Reopen's page, a
    // rename and a dismiss.
    ("GET__connections_attempts", attempts_listed),
    ("GET__connections_attempts__id__reopen", sign_in_link),
    ("PATCH__connections_attempts__id_", attempt_changed),
    ("DELETE__connections_attempts__id_", read_as_done),
    // Signing in at an installed plugin's own MCP server (#364): how a service adds an account,
    // and its provider's page.
    (
        "GET__plugins_installations__name__connectors__connector__sign-in",
        sign_in_method,
    ),
    (
        "GET__plugins_installations__name__connectors__connector__authorize",
        sign_in_link,
    ),
    // The plugin marketplace (#184): the catalog, a plugin's pinned detail, the installs, an
    // install and an uninstall (any 2xx is done; the installs are read again), and the tokens
    // pasted for an install's services.
    ("GET__plugins_catalog", plugin_catalog),
    ("GET__plugins_catalog__name_", plugin_detail),
    ("GET__plugins_installations", plugin_installations),
    ("POST__plugins_installations", read_as_done),
    ("DELETE__plugins_installations__name_", read_as_done),
    (
        "POST__plugins_installations__name__credentials__connector_",
        token_added,
    ),
    (
        "PUT__plugins_installations__name__credentials__connector_",
        read_as_done,
    ),
    ("GET__connections__connector__authorize", sign_in_link),
    ("GET__coworkers__coworker_id__usage", coworker_usage),
    ("GET__coworkers__coworker_id__computer", computer),
    // Get a computer, Update and Reset (`ensure_coworker_computer`, `update_coworker_computer`,
    // `reset_coworker_computer`) each answer with the status a read gives.
    ("POST__coworkers__coworker_id__computer", computer),
    ("POST__coworkers__coworker_id__computer_update", computer),
    ("POST__coworkers__coworker_id__computer_reset", computer),
    ("GET__coworkers__coworker_id__screen", screen),
    (
        "PUT__coworkers__coworker_id__computer_egress-policy",
        read_as_done,
    ),
    // This Mac, as a machine a coworker may run commands on.
    ("GET__local-exec_daemon", daemons),
    ("POST__local-exec_daemon", enrolled),
    // One computer's own relay switch (`switch_computer_relay`), answered with its row.
    ("PATCH__local-exec_daemon__machine_id_", daemon_switched),
    ("GET__local-exec_policy", local_exec_policy),
    ("PUT__local-exec_policy", read_as_done),
    ("POST__local-exec_policy_rule", read_as_done),
    ("DELETE__local-exec_policy_rule", read_as_done),
    // Recipes: every write answers with the recipe's whole detail.
    ("GET__recipes", recipes),
    ("POST__recipes", recipe_detail),
    ("GET__recipes__id_", recipe_detail),
    ("POST__recipes__id__versions", recipe_detail),
    ("POST__recipes__id__share", recipe_detail),
    (
        "DELETE__recipes__id__share__scope___scope_id_",
        recipe_detail,
    ),
    ("POST__recipes__id__accept", recipe_detail),
    ("POST__recipes__id__decline", recipe_detail),
    ("POST__recipes__id__grants", recipe_detail),
    ("POST__recipes__id__run", recipe_run),
    // Routines, which are schedules on the server.
    ("GET__schedules", schedules),
    ("POST__schedules", one_routine),
    ("PATCH__schedules__id_", one_routine),
    // Delete (`delete_schedule`) answers 204 and nothing to read.
    ("DELETE__schedules__id_", read_as_done),
    ("POST__schedules__id__pause", read_as_done),
    ("POST__schedules__id__resume", read_as_done),
    ("POST__schedules__id__rotate-key", rotated_key),
    ("POST__schedules__id__run", schedule_run_started),
    ("GET__schedules__id__runs", schedule_runs),
    // Skills.
    ("GET__skills", skills),
    ("POST__skills", skill_detail),
    ("POST__skills_from-tape", skill_detail),
    ("GET__skills__id_", skill_detail),
    ("PUT__skills__id_", skill_detail),
    ("DELETE__skills__id_", read_as_done),
    ("POST__skills__id__versions", skill_version),
    // Where the account's replies are paid from, and the models a Bot and the person's own plan
    // can answer with.
    ("GET__account_inference-source", inference_source),
    ("PUT__account_inference-source", inference_source),
    ("GET__models", models_listed),
    // The account's events stream (#348), a stream of SSE blocks.
    ("GET__ag-ui_events", account_events_stream),
    // This Mac as the person's relay, asked with its machine token.
    ("GET__inference-relay_requests", relay_stream),
    ("POST__inference-relay_responses__request_id_", relay_answer),
];

/// Routes whose refusals the client reads its own way rather than with `read_error`, and how.
/// Every other refusal is [`refusal`].
const REFUSALS: &[(&str, RestCheck)] = &[
    ("POST__ag-ui", turn_refused),
    ("DELETE__coworkers__coworker_id_", coworker_delete_refused),
    ("GET__coworkers__coworker_id__tools", tools_refused),
    ("GET__coworkers__coworker_id__ceiling", tools_refused),
    ("PUT__coworkers__coworker_id__ceiling", tools_refused),
    ("GET__coworkers__coworker_id__skills", skills_refused),
    ("PUT__coworkers__coworker_id__skills", skills_refused),
    ("POST__ag-ui_user-form_submit", form_refused),
    ("POST__ag-ui_user-form_dismiss", form_refused),
    ("POST__ag-ui_box-handoff_resolve", handoff_refused),
    ("POST__recipes__id__run", run_refused),
    ("POST__schedules__id__run", schedule_run_refused),
    ("POST__skills_from-tape", tape_refused),
    ("GET__ag-ui_events", account_events_refused),
    ("GET__inference-relay_requests", relay_stream_refused),
    (
        "POST__inference-relay_responses__request_id_",
        relay_answer_refused,
    ),
];

/// One recorded answer, read the way this app reads it: not at all from a route it never asks
/// ([`REST_NOT_READ`]), with its route's reading for a success, and for anything else the way
/// the client takes a refusal.
fn read_fixture(route: &str, fixture: &Value) -> Check {
    if REST_NOT_READ
        .iter()
        .any(|(excused, _, _)| *excused == route)
    {
        return Ok(());
    }
    let (_, read) = REST_ROUTES
        .iter()
        .find(|(dir, _)| *dir == route)
        .ok_or_else(|| {
            format!(
                "no reading for {route}: add it to REST_ROUTES, or say in REST_NOT_READ why this \
                 app never asks it"
            )
        })?;
    let status = fixture
        .get("status")
        .and_then(Value::as_u64)
        .and_then(|status| u16::try_from(status).ok())
        .ok_or("no status")?;
    let body = &fixture["body"];
    if (200..300).contains(&status) {
        return read(status, body);
    }
    // `send_json_within`: a 401 on any route but `/auth/` is the session gone, whatever the route
    // would have made of the refusal, because the one refresh the app can do on its own has been
    // tried. On `/auth/login` the same status is a wrong password, a verdict like any other, and
    // on a route asked with this Mac's machine token it is the token turned away.
    if status == 401
        && !str_at(fixture, "path").starts_with("/auth/")
        && !MACHINE_TOKEN_ROUTES.contains(&route)
    {
        return signed_out(body);
    }
    let refused = REFUSALS
        .iter()
        .find(|(dir, _)| *dir == route)
        .map_or(refusal as RestCheck, |(_, check)| *check);
    refused(status, body)
}

fn parse<T: DeserializeOwned>(body: &Value) -> Result<T, String> {
    serde_json::from_value(body.clone())
        .map_err(|error| format!("does not parse as {}: {error}", std::any::type_name::<T>()))
}

fn rows(body: &Value) -> Result<&Vec<Value>, String> {
    body.as_array()
        .ok_or_else(|| "a list route answered something other than an array".to_string())
}

fn same_len<T>(parsed: &[T], raw: &[Value]) -> Check {
    must!(
        parsed.len() == raw.len(),
        "{} rows parsed out of {}",
        parsed.len(),
        raw.len()
    );
    Ok(())
}

fn opt_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// A recorded body as the client has it off the wire: a text body is its text, and a JSON one
/// its JSON.
fn body_text(body: &Value) -> String {
    match body {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// A body as the user-form routes parse it (`user_form_action_response`): JSON, or `null` for
/// anything that is not.
fn body_json(body: &Value) -> Value {
    let text = body_text(body);
    if text.trim().is_empty() {
        return Value::Null;
    }
    serde_json::from_str(&text).unwrap_or(Value::Null)
}

/// What a refusal says, read off the recording by the rule this app is held to, stated here
/// case by case rather than borrowed from the client (`refusal_words` in `types.rs`), so the
/// check is not the code it checks: the sentence the person is shown, and the server's code
/// word when the body names one.
///
/// The rule is the one opengrok-server writes its refusals to (its error-bodies change): with a
/// `code`, the code is `code` and the sentence is `error`; without one, a bare code word under
/// `error` with a `message` beside it is the code and the `message` the sentence (the queue's
/// 409s); otherwise `error` is the sentence and there is no code. A bare code word with nothing
/// beside it (the queue's `already-consumed` and `not-pending`) is kept as the code and is all
/// there is to show, which the queue needs. A body with nothing under `error`, or not JSON, is
/// its own text. A code word is one lowercase token of letters and digits joined by `-` or `_`,
/// with no spaces.
fn said_by(body: &Value) -> (String, Option<String>) {
    let code_word = |text: &str| {
        text.starts_with(|c: char| c.is_ascii_lowercase())
            && text
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    };
    let Value::Object(_) = body else {
        return (body_text(body).trim().to_string(), None);
    };
    let field = |key: &str| {
        opt_str(body, key)
            .map(str::trim)
            .filter(|text| !text.is_empty())
    };
    let owned = |text: &str| text.to_string();
    let own_text = || body.to_string();
    match (field("error"), field("code"), field("message")) {
        (error, Some(code), message) => (
            error.or(message).map_or_else(own_text, owned),
            Some(owned(code)),
        ),
        (Some(error), None, Some(message)) if code_word(error) => {
            (owned(message), Some(owned(error)))
        }
        (Some(error), None, None) if code_word(error) => (owned(error), Some(owned(error))),
        (Some(error), None, _) => (owned(error), None),
        (None, None, _) => (own_text(), None),
    }
}

// ---- refusals ----

/// A refusal as `read_error` reads one (`OpenGrokClient::refusal`). What it says is what the
/// person is shown, so it must be the server's own sentence ([`said_by`]), and there must be
/// one; the server's code word, when the body names one, is kept apart for the callers that
/// branch on it. A refusal from the send queue carries the `pending-user-message` CUSTOM the
/// queue applies, and its conflict word is one the queue branches on.
///
/// Every refusal recorded here was written by the server, so each reads as its verdict, or as
/// its word that the gateway is out of reach, and never as the server itself out of reach. A
/// 502, 503 or 504 the server writes says it wrote it by its shape, JSON with the sentence under
/// `error`: nothing in front of the server writes that, and it is the one way this app can tell
/// a box that is down from a server it cannot reach.
fn refusal(status: u16, body: &Value) -> Check {
    let error = OpenGrokClient::refusal(status, &body_text(body));
    let (sentence, code) = said_by(body);
    if (502..=504).contains(&status) {
        must!(
            opt_str(body, "error").is_some_and(|error| !error.trim().is_empty()),
            "a {status} the server writes {FIVE_HUNDRED_SHAPE}, not {body}"
        );
    }
    let expected = if reads_as_gateway_unreachable(&sentence) {
        Failure::OutOfReach(Unreachable::Gateway)
    } else {
        Failure::Verdict
    };
    must!(
        error.failure() == expected,
        "a {status} the server wrote should read as {expected:?}, not {:?}",
        error.failure()
    );
    must!(
        !error.message.trim().is_empty(),
        "a refusal with nothing to show the person: {body}"
    );
    if let Some(code) = code.as_deref().filter(|code| *code != sentence) {
        must!(
            error.message != code,
            "a refusal that names its code {code:?} and says a sentence beside it should be \
             shown the sentence, not the code"
        );
    }
    must!(
        error.status == Some(status) && error.message == sentence,
        "the refusal should read as the server's sentence {sentence:?}, not {:?}",
        error.message
    );
    must!(
        error.code() == code.as_deref(),
        "the refusal's code should be kept as {code:?}, not {:?}",
        error.code()
    );
    if let Some(event) = body.get("event") {
        let custom = error.pending_custom().ok_or_else(|| {
            format!("the queue's CUSTOM on the refusal did not reach it: {event}")
        })?;
        must!(
            custom.thread_id == str_at(&event["value"], "threadId"),
            "the queue's CUSTOM should name its thread: {custom:?}"
        );
        let word = code.as_deref().unwrap_or_default();
        must!(
            error.is_already_consumed() == (status == 409 && word == "already-consumed")
                && error.is_not_pending() == (status == 409 && word == "not-pending")
                && error.is_stale_pending() == (status == 409 && word == "stale-pending-message"),
            "the queue should know the conflict {word:?} by its word: {error:?}"
        );
    }
    Ok(())
}

/// The queue's words (`OpenGrokError::is_already_consumed`, `is_not_pending`,
/// `is_stale_pending`), which opengrok-server keeps under `error` on its queue's 409s
/// (`agui/pending.rs`).
const QUEUE_CODES: &[&str] = &["already-consumed", "not-pending", "stale-pending-message"];

/// How a refusal of a turn fails [`turn_refused`] when it names a code in the shape the server
/// has retired for it.
const CODE_UNDER_CODE: &str = "should name its code under code, with its sentence under error";

/// `run_turn`'s refusals, read as `read_error` reads them. The queue's conflicts keep their code
/// under `error`, with the sentence under `message` where they say one; every other code this
/// route names rides under `code`, with the sentence under `error` (opengrok-server's
/// error-bodies change, for `run-exists`). A code under `error` that is not one of the queue's
/// is the shape that change retired.
fn turn_refused(status: u16, body: &Value) -> Check {
    let (_, code) = said_by(body);
    if let Some(code) = code.as_deref()
        && opt_str(body, "error").map(str::trim) == Some(code)
    {
        must!(
            QUEUE_CODES.contains(&code),
            "a turn refused as {code:?} {CODE_UNDER_CODE}; only the queue's words stay under \
             error: {body}"
        );
    }
    refusal(status, body)
}

/// A 401 on any route but `/auth/` (`signed_out_error`): the session is gone, which only the
/// person signing in again mends, and the sentence the person is told is the server's.
fn signed_out(body: &Value) -> Check {
    let error = OpenGrokClient::signed_out_refusal(&body_text(body));
    let (sentence, _) = said_by(body);
    must!(
        error.is_signed_out(),
        "a 401 should read as the session gone: {error:?}"
    );
    must!(
        !sentence.is_empty() && error.message == sentence,
        "the person should be told {sentence:?}, not {:?}",
        error.message
    );
    Ok(())
}

/// `delete_coworker`: a coworker the server no longer has is as gone as one it just deleted, so
/// the client must read a 404 as done (`OpenGrokClient::gone_after_delete`) and show nothing of
/// it. Any other refusal is read as anywhere else.
fn coworker_delete_refused(status: u16, body: &Value) -> Check {
    let gone = OpenGrokClient::gone_after_delete(status);
    must!(
        gone == (status == 404),
        "a delete refused with {status} should read as {}, and the client reads it as {}",
        if status == 404 { "gone" } else { "refused" },
        if gone { "gone" } else { "refused" }
    );
    if gone {
        return Ok(());
    }
    refusal(status, body)
}

/// A refused tool listing, or a refused read or write of a ceiling, is the server's sentence, and
/// the app reads it as a refusal (a 404 is "not this person's bot"; a 422 names what a write asked
/// for that the server does not list), so one must never read as a list.
fn tools_refused(status: u16, body: &Value) -> Check {
    must!(
        body.get("tools").is_none(),
        "a refused listing should not carry tools: {body}"
    );
    refusal(status, body)
}

/// A refused read or write of a bot's skills is the server's sentence, and the app reads it as a
/// refusal (a 404 is "not this person's bot"; a 422 names an id it does not list or says the set
/// is past its cap; a 409 is a stale version), so one must never read as a list of skills.
fn skills_refused(status: u16, body: &Value) -> Check {
    must!(
        body.get("skills").is_none(),
        "a refused read of a bot's skills should not carry skills: {body}"
    );
    refusal(status, body)
}

/// `user_form_action_response`: a 403 is the server declining to fill on that computer, with its
/// sentence under `message` before `error`, which is a code; a 404 is the card gone (`form entry
/// missing`) or no such route. Every other refusal is read as anywhere else.
fn form_refused(status: u16, body: &Value) -> Check {
    let parsed = body_json(body);
    let reply = user_form_action_from_http(status, &parsed);
    match status {
        404 => {
            let expected = if str_at(&parsed, "error").eq_ignore_ascii_case(FORM_ENTRY_MISSING) {
                UserFormActionReply::MissingEntry
            } else {
                UserFormActionReply::MissingRoute
            };
            must!(
                reply == expected,
                "a 404 should read as {expected:?}, not {reply:?}"
            );
        }
        // The form's refusal is read by the one rule every refusal is, in either shape.
        403 if parsed.is_object() => {
            let (said, _) = said_by(&parsed);
            must!(
                !said.is_empty() && reply == UserFormActionReply::Refused(said),
                "a refusal should carry the server's sentence, not {reply:?}"
            );
        }
        // One the client cannot read still keeps the card open with a sentence of its own.
        403 => must!(
            matches!(&reply, UserFormActionReply::Refused(said) if !said.trim().is_empty()),
            "a refusal should keep the card open with a sentence, not {reply:?}"
        ),
        _ => return refusal(status, body),
    }
    Ok(())
}

/// `box_handoff_action_response`: a 404 is the handoff gone (`form entry missing`, nothing left
/// to settle) or no such route, and never a hand-back. Every other refusal is read as anywhere
/// else.
fn handoff_refused(status: u16, body: &Value) -> Check {
    if status != 404 {
        return refusal(status, body);
    }
    let parsed = body_json(body);
    let reply = box_handoff_action_from_http(status, &parsed);
    let expected = if str_at(&parsed, "error").eq_ignore_ascii_case(FORM_ENTRY_MISSING) {
        BoxHandoffReply::Empty
    } else {
        BoxHandoffReply::MissingRoute
    };
    must!(
        reply == expected,
        "a 404 should read as {expected:?}, not {reply:?}"
    );
    Ok(())
}

/// `run_error`: a refusal that carries `historyMissed` is a run that played and could not be
/// written into the history, and that sentence is what it says; every other refusal is the
/// server's sentence, as anywhere else.
fn run_refused(status: u16, body: &Value) -> Check {
    let error = OpenGrokClient::run_refusal(status, &body_text(body));
    match opt_str(body, "historyMissed")
        .map(str::trim)
        .filter(|missed| !missed.is_empty())
    {
        Some(missed) => {
            must!(
                error.history_missed() && error.message == missed,
                "a run the history missed should say so: {error:?}"
            );
            Ok(())
        }
        None => {
            must!(
                !error.history_missed(),
                "a plain refusal is not a missed history: {error:?}"
            );
            refusal(status, body)
        }
    }
}

/// Run it now refused (`run_schedule_now`): the server's sentence, as anywhere else, and a skip
/// is told from every other refusal. Its 409 with a code is the routine's Bot on its person's own
/// plan while the plan cannot answer (#316: `run_schedule_now` in autonomy/routes.rs), which kept
/// the firing as skipped and has the history read again for it; the 409 for a retired coworker
/// names no code, and is no skip.
fn schedule_run_refused(status: u16, body: &Value) -> Check {
    let error = OpenGrokClient::refusal(status, &body_text(body));
    let (_, code) = said_by(body);
    must!(
        error.is_skipped_firing() == (status == 409 && code.is_some()),
        "a skipped firing should be told from any other refusal: {error:?}"
    );
    refusal(status, body)
}

/// `tape_error`: the server's sentence, as anywhere else, read as a verdict about the recording
/// whatever its status, because this route answers 502 and 504 itself, for a model that wrote
/// nothing that can be kept or overran. Only the server saying the gateway could not be reached
/// is a machine out of reach.
fn tape_refused(status: u16, body: &Value) -> Check {
    refusal(status, body)?;
    let error = OpenGrokClient::tape_refusal(status, &body_text(body));
    let expected = if reads_as_gateway_unreachable(&error.message) {
        Failure::OutOfReach(Unreachable::Gateway)
    } else {
        Failure::Verdict
    };
    must!(
        error.failure() == expected,
        "a {status} from a tape should read as {expected:?}, not {:?}",
        error.failure()
    );
    Ok(())
}

// ---- successes ----

/// A success this app reads only as done (`empty_or_error`, or its status alone): a pause, a
/// delete, a rule kept, a sign-out. Nothing in the body is taken, so there is nothing in it to
/// hold to anything.
fn read_as_done(_: u16, _: &Value) -> Check {
    Ok(())
}

/// A deleted coworker is gone by the client's own rule (`OpenGrokClient::gone_after_delete`),
/// which it reads off the status alone.
fn coworker_deleted(status: u16, _: &Value) -> Check {
    must!(
        OpenGrokClient::gone_after_delete(status),
        "a delete answered {status} should read as done"
    );
    Ok(())
}

/// A sign-in and a refresh answer with the session in cookies, and this app reads only the
/// status off a success.
fn session_in_cookies(_: u16, body: &Value) -> Check {
    for token in [
        "accessToken",
        "refreshToken",
        "access_token",
        "refresh_token",
    ] {
        must!(
            body.get(token).is_none(),
            "a sign-in body should not carry {token}; the session is in the cookies"
        );
    }
    Ok(())
}

/// A turn's success is its event stream, read frame by frame (`run_turn`). The recorder files a
/// stream's frames under `agui/`, where [`check_frame`] reads each one, so the stream's own text
/// is never recorded here; it would be `data:` lines the stream reader takes as the coworker's
/// words or the run's error. The one success body recorded is the 202 a fire of a queued send
/// held for the person's Mac is answered with, which is no stream: [`held_for_mac`] reads it.
fn turn_stream(status: u16, body: &Value) -> Check {
    if status == 202 {
        return held_for_mac(body);
    }
    let stream = body
        .as_str()
        .ok_or("a turn answers with its event stream, not a JSON body")?;
    must!(
        stream.lines().any(|line| line.starts_with("data:")),
        "a turn's stream is `data:` lines: {stream:?}"
    );
    if let Err(error) = assistant_text_from_sse(stream) {
        must!(
            !error.trim().is_empty(),
            "a stream that ends in an error should say what it was"
        );
    }
    Ok(())
}

/// A turn answered 202 (opengrok-server main cad36fd (#303, after #298), pin 47a5d6b:
/// `consume_for_turn` in `crates/opengrok-server/src/agui/pending.rs`): the
/// queued send it fired is held for the person's Mac, and no run started. `run_turn` reads it as
/// the turn not starting, never as a stream: held for the Mac by its status and its word, with
/// the server's sentence, and with the row as it now stands for the queue to put back, still
/// queued and waiting for the Mac, the very row that was fired.
fn held_for_mac(body: &Value) -> Check {
    let error = OpenGrokClient::turn_held(&body_text(body));
    must!(
        error.is_held_for_mac(),
        "a send held for the Mac should read as held for it, not {error:?}"
    );
    let said = str_at(body, "message");
    must!(
        !said.trim().is_empty() && error.message == said,
        "the hold should read as the server's sentence {said:?}, not {:?}",
        error.message
    );
    let custom = error
        .pending_custom()
        .ok_or("the row as it stands should come with the hold")?;
    let raw = body
        .pointer("/event/value/message")
        .ok_or("the hold's CUSTOM should carry the row")?;
    let row = custom
        .message
        .as_ref()
        .ok_or("the row should parse off the hold's CUSTOM")?;
    must!(
        custom.op == PendingOp::Edited
            && custom.thread_id == str_at(&body["event"]["value"], "threadId"),
        "a held send stays queued on its thread, as an edit says: {custom:?}"
    );
    must!(
        row.id == str_at(body, "id") && row.waits_for_mac(),
        "the row should be the send fired, waiting for the Mac: {row:?}"
    );
    held_as_sent(row, raw)
}

fn thread_list(_: u16, body: &Value) -> Check {
    let listed: Vec<ThreadListing> = parse(body)?;
    let raw = rows(body)?;
    same_len(&listed, raw)?;
    for (row, raw) in listed.iter().zip(raw) {
        must!(
            row.thread_id == str_at(raw, "threadId")
                && row.coworker_id.as_deref() == opt_str(raw, "coworkerId")
                && row.origin == str_at(raw, "origin")
                && row.title.as_deref() == opt_str(raw, "title")
                && row.last_run_id == str_at(raw, "lastRunId")
                && row.last_status == str_at(raw, "lastStatus")
                && Some(row.updated_at_ms) == raw.get("updatedAtMs").and_then(Value::as_i64),
            "a thread row came through changed: {row:?}"
        );
    }
    Ok(())
}

/// A run's frames read back to the words the coworker said, as the transcript rebuilds them: the
/// person's own words, which a replay opens each run with, are none of them. And a card the
/// replay says is settled ends settled: the server lays the card's `formResolution` over its park
/// (`overlay_form`), which the app reads there (#139), and journals the settled card after it
/// (`journal_settled_form`) while its run still waits.
fn reads_back(run_id: &str, events: &[Value]) -> Check {
    let persons: BTreeSet<&str> = events
        .iter()
        .filter(|frame| {
            str_at(frame, "type") == "TEXT_MESSAGE_START" && str_at(frame, "role") == "user"
        })
        .map(|frame| str_at(frame, "messageId"))
        .collect();
    let said: String = events
        .iter()
        .filter(|frame| str_at(frame, "type") == "TEXT_MESSAGE_CONTENT")
        .filter(|frame| !persons.contains(str_at(frame, "messageId")))
        .map(|frame| str_at(frame, "delta"))
        .collect();
    let mut assembler = TurnAssembler::default();
    for frame in events {
        assembler.push_event(frame);
    }
    assembler.finish();
    let (plain, parts) = assembler.snapshot();
    // Blank lines are the transcript's own, put between the words a card or a picture splits.
    // Compared word by word: a space lost between two deltas joins two words and fails.
    let words =
        |text: &str| -> Vec<String> { text.split_whitespace().map(str::to_string).collect() };
    must!(
        words(&plain) == words(&said),
        "run {run_id:?} should read {said:?}, not {plain:?}"
    );
    for park in events.iter().filter(|frame| is_user_form_awaiting(frame)) {
        let Some(word) = opt_str(park, "formResolution") else {
            continue;
        };
        let call = str_at(park, "callId");
        let resolution = FormResolution::parse(word);
        let settled = |card: &UserFormSpec| {
            card.call_id == call
                && if resolution == FormResolution::Escalated {
                    card.computer_handoff.is_some()
                } else {
                    card.effective_resolution() == Some(resolution)
                }
        };
        must!(
            parts
                .iter()
                .any(|part| matches!(part, ChatPart::UserForm(card) if settled(card))),
            "run {run_id:?} replays the card for {call:?} as {word}, and the app rebuilds it \
             otherwise: {parts:?}"
        );
    }
    Ok(())
}

/// The person's side of a run, as the thread rebuilds it (`missing_questions` in `state.rs`, by
/// `persons_messages`): every message the replay opens as the person's comes back, by the id it
/// was sent under and with its words. One closed on none is a message of files alone
/// (opengrok-server#259), kept so its files have a bubble to be drawn under; one opened and never
/// closed on none is a message cut off, and not one.
fn persons_side(run_id: &str, events: &[Value]) -> Check {
    let mut asked: Vec<(String, String)> = Vec::new();
    for start in events.iter().filter(|frame| {
        str_at(frame, "type") == "TEXT_MESSAGE_START" && str_at(frame, "role") == "user"
    }) {
        let id = str_at(start, "messageId");
        let words: String = events
            .iter()
            .filter(|frame| {
                str_at(frame, "type") == "TEXT_MESSAGE_CONTENT" && str_at(frame, "messageId") == id
            })
            .map(|frame| str_at(frame, "delta"))
            .collect();
        let closed = events.iter().any(|frame| {
            str_at(frame, "type") == "TEXT_MESSAGE_END" && str_at(frame, "messageId") == id
        });
        if closed || !words.trim().is_empty() {
            asked.push((id.to_string(), words));
        }
    }
    let kept = super::gen_ui::persons_messages(events);
    must!(
        kept == asked,
        "run {run_id:?} should give back the person's messages {asked:?}, not {kept:?}"
    );
    // A run picked up by its replay before the coworker has said anything (`activity_from_replay`)
    // says what its opening said: the person's messages the replay opens with are not it writing.
    let theirs: BTreeSet<&str> = asked.iter().map(|(id, _)| id.as_str()).collect();
    let opening = events
        .iter()
        .take_while(|frame| {
            str_at(frame, "type") == "RUN_STARTED"
                || (str_at(frame, "type").starts_with("TEXT_MESSAGE_")
                    && theirs.contains(str_at(frame, "messageId")))
        })
        .count();
    if opening > 1 && str_at(&events[0], "type") == "RUN_STARTED" {
        must!(
            activity_from_replay(&events[..opening]) == activity_from_replay(&events[..1]),
            "run {run_id:?}: the person's messages should leave the status line as the run's start \
             set it, not at {:?}",
            activity_from_replay(&events[..opening])
        );
    }
    Ok(())
}

fn thread_replay(_: u16, body: &Value) -> Check {
    let replay: ThreadReplay = parse(body)?;
    must!(
        replay.thread_id == str_at(body, "threadId"),
        "the thread id changed"
    );
    let raw_runs = body
        .get("runs")
        .and_then(Value::as_array)
        .ok_or("a replay with no runs array")?;
    same_len(&replay.runs, raw_runs)?;
    for (run, raw) in replay.runs.iter().zip(raw_runs) {
        let status = str_at(raw, "status");
        must!(
            run.run_id == str_at(raw, "runId")
                && run.status == status
                && Some(run.started_at_ms) == raw.get("startedAtMs").and_then(Value::as_i64)
                && Some(run.updated_at_ms) == raw.get("updatedAtMs").and_then(Value::as_i64)
                && run.failure.as_deref() == opt_str(raw, "failure")
                && run.is_live() == matches!(status, "running" | "awaiting-approval"),
            "a run came through changed: {:?} {status}",
            run.run_id
        );
        reads_back(&run.run_id, &run.events)?;
        persons_side(&run.run_id, &run.events)?;
        replayed_parks(&run.events)?;
    }
    let hidden: Vec<&str> = body
        .get("hiddenRunIds")
        .and_then(Value::as_array)
        .map(|ids| ids.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    must!(
        replay.hidden_run_ids == hidden,
        "the hidden runs should come through: {:?}",
        replay.hidden_run_ids
    );
    if let Some(events) = body.get("pendingEvents").and_then(Value::as_array) {
        let live = replay
            .live_pending_messages()
            .ok_or("pendingEvents is there, so the live queue is known")?;
        must!(
            live.len() == events.len(),
            "every pending snapshot should be a live row: {live:?}"
        );
    }
    Ok(())
}

/// One run as `GET /ag-ui/runs/{run_id}` replays it (`replay_run`), which is how a turn whose
/// stream was lost is picked up again: its status, when it began, why it failed, and every frame
/// it emitted, which read back to the coworker's words. A run parked on a card names the call it
/// waits on and that call's arguments, which fill a card whose command the frames did not carry.
fn run_replay(_: u16, body: &Value) -> Check {
    let replay: RunReplay = parse(body)?;
    must!(
        replay.run_id == str_at(body, "runId")
            && replay.status == str_at(body, "status")
            && Some(replay.started_at_ms) == body.get("startedAtMs").and_then(Value::as_i64)
            && replay.failure.as_deref() == opt_str(body, "failure"),
        "the run came through changed: {:?} {:?}",
        replay.run_id,
        replay.status
    );
    let parked = body.get("pending").filter(|pending| !pending.is_null());
    must!(
        replay.pending.as_ref() == parked,
        "the call the run is parked on should come through: {:?}",
        replay.pending
    );
    if let Some(pending) = &replay.pending {
        must!(
            opt_str(pending, "call_id").is_some_and(|id| !id.is_empty())
                && pending.get("arguments").is_some(),
            "a parked run should name its call and that call's arguments: {pending}"
        );
    }
    let events = body
        .get("events")
        .and_then(Value::as_array)
        .ok_or("a replay with no events array")?;
    same_len(&replay.events, events)?;
    reads_back(&replay.run_id, &replay.events)?;
    persons_side(&replay.run_id, &replay.events)?;
    replayed_parks(&replay.events)
}

/// `stop_run`: the run, and what it is now. The route is idempotent, so a run that had already
/// ended is `stopped` too; the words about when it takes effect are the server's, for a person
/// reading its API, and the app shows its own.
fn stopped(_: u16, body: &Value) -> Check {
    let reply: StopReply = parse(body)?;
    must!(
        !reply.run_id.is_empty()
            && reply.run_id == str_at(body, "runId")
            && reply.status == "stopped",
        "a stop should name the run and say it is stopped: {reply:?}"
    );
    Ok(())
}

/// The live queue on a thread (`list_pending_user_messages`), read as the app hydrates it:
/// from the snapshot CUSTOMs, which the server sends beside the rows (`PendingList::
/// live_messages`), each one the same send as the row it stands for.
fn pending_list(_: u16, body: &Value) -> Check {
    let list: PendingList = parse(body)?;
    must!(
        list.thread_id == str_at(body, "threadId"),
        "the queue should name its thread"
    );
    let raw = body
        .get("pendingUserMessages")
        .and_then(Value::as_array)
        .ok_or("the rows sit under pendingUserMessages")?;
    same_len(&list.pending_user_messages, raw)?;
    for (row, raw) in list.pending_user_messages.iter().zip(raw) {
        held_as_sent(row, raw)?;
    }
    must!(
        list.pending_events.is_some(),
        "the server sends the snapshots, so the live queue is known"
    );
    let live = list.live_messages();
    must!(
        live == list.pending_user_messages,
        "every snapshot should be the row it stands for: {live:?}"
    );
    Ok(())
}

fn pending_created(_: u16, body: &Value) -> Check {
    pending_mutation(body, PendingOp::Created)
}

fn pending_edited(_: u16, body: &Value) -> Check {
    pending_mutation(body, PendingOp::Edited)
}

fn pending_canceled(_: u16, body: &Value) -> Check {
    pending_mutation(body, PendingOp::Canceled)
}

/// A queue write's answer (`PendingMutation`): the CUSTOM the app applies to its queue, saying
/// the op the route performed, and the send as it now stands, beside the CUSTOM or inside it. A
/// cancel carries no send: the text of one taken back is not sent back.
fn pending_mutation(body: &Value, op: PendingOp) -> Check {
    let mutation: PendingMutation = parse(body)?;
    let custom = mutation
        .custom()
        .ok_or("the answer's CUSTOM did not parse")?;
    must!(
        custom.op == op
            && mutation.thread_id == str_at(body, "threadId")
            && custom.thread_id == mutation.thread_id,
        "the answer should say {} on its thread, not {custom:?}",
        op.as_str()
    );
    let raw = body
        .get("pendingUserMessage")
        .filter(|row| !row.is_null())
        .or_else(|| body.pointer("/event/value/message"));
    match (mutation.row(), raw) {
        (Some(row), Some(raw)) => held_as_sent(&row, raw)?,
        (None, None) => must!(
            op == PendingOp::Canceled,
            "only a cancel answers without the send"
        ),
        (row, raw) => {
            return Err(format!(
                "the row and its parse disagree: {raw:?} against {row:?}"
            ));
        }
    }
    Ok(())
}

/// The files sent on a thread (`sent_attachments`), which a replay draws on the messages they
/// rode on: every row reads as the file it is, and one that names no message (`meta.messageId`)
/// was uploaded and never sent, so it is left out.
fn sent_files(_: u16, body: &Value) -> Check {
    let listed: Vec<ArtifactListing> = parse(body)?;
    let raw = rows(body)?;
    same_len(&listed, raw)?;
    for (row, raw) in listed.into_iter().zip(raw) {
        file_as_sent(&row.file, raw)?;
        let message = raw.pointer("/meta/messageId").and_then(Value::as_str);
        let sent = row.sent();
        must!(
            sent.as_ref().map(|sent| sent.message_id.as_str()) == message,
            "a file should be drawn on the message it rode on, and only then: {sent:?}"
        );
    }
    Ok(())
}

/// An upload (`upload_attachment`) answers with the file, whose `art_` id the message then names.
fn uploaded(_: u16, body: &Value) -> Check {
    let file: Attachment = parse(body)?;
    file_as_sent(&file, body)
}

fn file_as_sent(file: &Attachment, raw: &Value) -> Check {
    must!(
        file.id.starts_with("art_")
            && file.id == str_at(raw, "id")
            && file.mime == str_at(raw, "mime")
            && file.filename == str_at(raw, "filename")
            && Some(file.size_bytes) == raw.get("sizeBytes").and_then(Value::as_u64),
        "a file came through changed: {file:?}"
    );
    Ok(())
}

/// The card's sentence the server sends (opengrok-server #263, `cards.rs` `summary_for_ask`,
/// null for a form) is the one this app builds itself (`approval_summary`, transcribed from the
/// same `summary_for`), on the live frame, its replay and the queue's rows alike. A shell's card
/// shows its command in place of a sentence, and the server's sentence for one is its fixed
/// opening and the command clipped at 200 characters, so that is what it is held to.
fn holds_the_servers_sentence(tool: &str, arguments: &Value, said: Option<&Value>) -> Check {
    let Some(said) = said.filter(|said| !said.is_null()) else {
        return Ok(());
    };
    let said = said.as_str().ok_or("a summary that is not a sentence")?;
    let ours = approval_summary(tool, arguments);
    if !ours.is_empty() {
        must!(
            ours == said,
            "the card says {ours:?} where the server's own says {said:?}"
        );
        return Ok(());
    }
    let opening = match tool {
        USER_MACHINE_SHELL => "Command on your own computer: ",
        "shell" => "Command on the agent's own box: ",
        _ => {
            return Err(format!(
                "the card has no sentence for {tool} where the server says {said:?}"
            ));
        }
    };
    let command = arguments
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or("(none)");
    let clipped: String = if command.chars().count() > 200 {
        format!("{}…", command.chars().take(200).collect::<String>())
    } else {
        command.to_string()
    };
    must!(
        said == format!("{opening}{clipped}"),
        "the server's sentence for a {tool} should be its opening and the command, not {said:?}"
    );
    Ok(())
}

/// Every card a replay parks on says what the live one said (#263): the server stamps the
/// sentence into the journal the replay reads from.
fn replayed_parks(events: &[Value]) -> Check {
    for frame in events.iter().filter(|frame| {
        str_at(frame, "type") == "CUSTOM" && str_at(frame, "name") == RUN_AWAITING_APPROVAL
    }) {
        holds_the_servers_sentence(
            str_at(frame, "tool"),
            frame.get("arguments").unwrap_or(&Value::Null),
            frame.get("summary"),
        )?;
    }
    Ok(())
}

fn approvals(_: u16, body: &Value) -> Check {
    let queue: Vec<QueuedApproval> = parse(body)?;
    let raw = rows(body)?;
    same_len(&queue, raw)?;
    for (item, raw) in queue.iter().zip(raw) {
        must!(
            item.run_id == str_at(raw, "runId")
                && item.thread_id == str_at(raw, "threadId")
                && item.call_id == str_at(raw, "callId")
                && item.tool == str_at(raw, "tool")
                && Some(&item.arguments) == raw.get("arguments")
                && item.reason.as_deref() == opt_str(raw, "reason")
                && item.why.as_deref() == opt_str(raw, "why"),
            "a queued card came through changed: {item:?}"
        );
        holds_the_servers_sentence(&item.tool, &item.arguments, raw.get("summary"))?;
    }
    Ok(())
}

fn answer(_: u16, body: &Value) -> Check {
    let reply: AnswerReply = parse(body)?;
    let flag = |key: &str| body.get(key).and_then(Value::as_bool).unwrap_or(false);
    must!(
        reply.already_answered == flag("alreadyAnswered") && reply.continuing == flag("continuing"),
        "the answer should say whether it was already answered and whether the run goes on: \
         {reply:?}"
    );
    Ok(())
}

/// A settled card on a success (`user_form_action_from_http`), or the server's
/// `{alreadyAnswered: true}` for a card that had settled before and whose run no longer waits on
/// it (opengrok-server `agui/user_form.rs` `heal_or_already`), or `null` for a coworker the
/// caller may not use (`load_owned_entry`), which settles nothing.
fn user_form_answer(status: u16, body: &Value) -> Check {
    let body = &body_json(body);
    let reply = user_form_action_from_http(status, body);
    if body.is_null() {
        must!(
            reply == UserFormActionReply::Empty,
            "a null settles nothing, not {reply:?}"
        );
        return Ok(());
    }
    if body.get("formResolution").is_none()
        && body.get("alreadyAnswered").and_then(Value::as_bool) == Some(true)
    {
        must!(
            reply == UserFormActionReply::AlreadyAnswered,
            "a card answered before should read as that, not {reply:?}"
        );
        return Ok(());
    }
    let UserFormActionReply::Settled(spec) = &reply else {
        return Err(format!(
            "a settled card should read as settled, not {reply:?}"
        ));
    };
    let entry = opt_str(body, "entryId").unwrap_or_else(|| str_at(body, "id"));
    must!(
        spec.entry_id == entry,
        "the card should keep its id: {spec:?}"
    );
    let word = str_at(body, "formResolution");
    if FormResolution::parse(word) == FormResolution::Escalated {
        must!(
            spec.computer_handoff == Some(ComputerHandoffStatus::ActionNeeded)
                && spec.handoff_entry_id.as_deref() == opt_str(body, "handoffEntryId"),
            "Open the screen should bring back the Computer card's id: {spec:?}"
        );
    } else {
        must!(
            spec.effective_resolution() == Some(FormResolution::parse(word)),
            "the card should settle as {word:?}: {spec:?}"
        );
    }
    Ok(())
}

fn box_handoff(status: u16, body: &Value) -> Check {
    let body = &body_json(body);
    let reply = box_handoff_action_from_http(status, body);
    let expected = if body.is_null() {
        BoxHandoffReply::Empty
    } else if body.get("alreadyAnswered").and_then(Value::as_bool) == Some(true) {
        BoxHandoffReply::AlreadyAnswered
    } else {
        BoxHandoffReply::Settled
    };
    must!(
        reply == expected,
        "a hand-back should read as {expected:?}, not {reply:?}"
    );
    Ok(())
}

/// The host's settings record (`host_settings`, `patch_host_settings`), which the app reads two
/// facts off for the egress tunnel: the host's intent (`egressTunnelEnabled`) and whether the
/// tunnel is live for the coworker asked about (`egressTunnelAvailable`, which the server puts on
/// every answer, false when it cannot say). A key the host did not send changes nothing, so each
/// must read as exactly what was sent.
fn host_settings(_: u16, body: &Value) -> Check {
    must!(body.is_object(), "the settings are a record: {body}");
    let available = body.get("egressTunnelAvailable").and_then(Value::as_bool);
    must!(
        available.is_some() && host_egress_tunnel_available(body) == available,
        "whether the tunnel is live should read as sent: {available:?}"
    );
    must!(
        host_egress_tunnel_flag(body) == body.get("egressTunnelEnabled").and_then(Value::as_bool),
        "the host's intent should read as sent"
    );
    Ok(())
}

fn local_exec_policy(_: u16, body: &Value) -> Check {
    let view: LocalExecPolicy = parse(body)?;
    must!(
        view.mode == str_at(body, "mode") && LocalExecMode::parse(&view.mode).is_some(),
        "the machine's mode should be a word this app knows, not {:?}",
        view.mode
    );
    must!(
        view.machine_id == str_at(body, "machineId"),
        "the listing should name its machine: {view:?}"
    );
    // The lists Settings → Computer shows (#93): each rule exactly as kept, and every inert
    // pattern is one of the allows, with the server's reason.
    let listed = |key: &str| -> Vec<String> {
        body.get(key)
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .filter_map(|r| r.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    };
    must!(
        view.allow == listed("allow") && view.deny == listed("deny"),
        "the rule lists should read as sent: {view:?}"
    );
    // The allows the gate can never match (#93, server #246). The server lists them on every
    // answer, an empty list when there are none (`policy_listing` in opengrok-server
    // `local_exec.rs`), so a listing without the field is not the server's; and what it lists
    // reads back exactly, pattern and reason, each one an allow.
    let sent: Vec<(String, String)> = body
        .get("inert")
        .and_then(Value::as_array)
        .ok_or("the listing should say which allows are inert, even when none are")?
        .iter()
        .map(|row| {
            (
                str_at(row, "pattern").to_string(),
                str_at(row, "reason").to_string(),
            )
        })
        .collect();
    let read: Vec<(String, String)> = view
        .inert
        .iter()
        .map(|rule| (rule.pattern.clone(), rule.reason.clone()))
        .collect();
    must!(
        read == sent,
        "the inert rules should read as sent: {read:?} vs {sent:?}"
    );
    must!(
        view.inert
            .iter()
            .all(|rule| !rule.reason.is_empty() && view.allow.contains(&rule.pattern)),
        "every inert rule should be one of the allows, with its reason: {view:?}"
    );
    Ok(())
}

/// The machines enrolled to run commands for the coworkers (`list_daemons`), which is how this
/// Mac finds itself on the roster rather than enrolling a second time.
fn daemons(_: u16, body: &Value) -> Check {
    let list: DaemonList = parse(body)?;
    let raw = body
        .get("machines")
        .and_then(Value::as_array)
        .ok_or("the machines sit under machines")?;
    same_len(&list.machines, raw)?;
    for (machine, raw) in list.machines.iter().zip(raw) {
        must!(
            !machine.machine_id.is_empty()
                && machine.machine_id == str_at(raw, "machineId")
                && machine.label == str_at(raw, "label")
                && Some(machine.revoked) == raw.get("revoked").and_then(Value::as_bool)
                && Some(machine.connected) == raw.get("connected").and_then(Value::as_bool),
            "a machine came through changed: {machine:?}"
        );
        relay_switch_comes_through(machine, raw)?;
    }
    Ok(())
}

/// A computer's own relay switch and whether it relays now, as its row carries them (opengrok-server
/// #342 (main 2136ffc): `row` in `crates/opengrok-server/src/local_exec.rs`, on every row of the
/// recording): `relayEnabled` as sent, on when the row has none, and `relaying` as sent, not
/// relaying when the row has none, which only a server from before the switch leaves out.
fn relay_switch_comes_through(machine: &DaemonMachine, raw: &Value) -> Check {
    must!(
        machine.relay_enabled
            == raw
                .get("relayEnabled")
                .and_then(Value::as_bool)
                .unwrap_or(true)
            && machine.relaying
                == raw
                    .get("relaying")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
        "a computer's relay switch and whether it relays should come through as sent: {machine:?} \
         from {raw}"
    );
    Ok(())
}

/// One computer's own relay switch answered (`switch_computer_relay`): the row it left, as
/// `GET /local-exec/daemon` lists it (opengrok-server #342 (main 2136ffc): `switch_relay` in
/// `crates/opengrok-server/src/local_exec.rs`). Its refusals are read as every other, with the
/// code beside the server's sentence.
fn daemon_switched(_: u16, body: &Value) -> Check {
    let machine: DaemonMachine = parse(body)?;
    must!(
        !machine.machine_id.is_empty()
            && machine.machine_id == str_at(body, "machineId")
            && machine.label == str_at(body, "label")
            && Some(machine.revoked) == body.get("revoked").and_then(Value::as_bool)
            && Some(machine.connected) == body.get("connected").and_then(Value::as_bool),
        "the computer should come through as sent: {machine:?}"
    );
    relay_switch_comes_through(&machine, body)
}

/// An enrol (`enrol_daemon`) answers with the machine's id and the token this Mac keeps to take
/// commands with.
fn enrolled(_: u16, body: &Value) -> Check {
    let enrol: DaemonEnrol = parse(body)?;
    must!(
        !enrol.machine_id.is_empty()
            && enrol.machine_id == str_at(body, "machineId")
            && !enrol.token.is_empty()
            && enrol.token == str_at(body, "token"),
        "an enrol should name the machine and hand over its token"
    );
    Ok(())
}

fn coworker_matches(coworker: &Coworker, raw: &Value) -> Check {
    must!(
        coworker.id == str_at(raw, "id")
            && coworker.name == str_at(raw, "name")
            && coworker.model == str_at(raw, "model")
            && coworker.role.as_deref() == opt_str(raw, "role")
            && coworker.title.as_deref() == opt_str(raw, "title")
            && coworker.avatar_shape.as_deref() == opt_str(raw, "avatarShape")
            && coworker.avatar_color.as_deref() == opt_str(raw, "avatarColor")
            && Some(coworker.updated_at_ms) == raw.get("updatedAtMs").and_then(Value::as_i64)
            && Some(coworker.hidden_from_sidebar)
                == raw.get("hiddenFromSidebar").and_then(Value::as_bool)
            && coworker.box_id.as_deref() == opt_str(raw, "boxId")
            // `effort` arrives with opengrok-server#271, and every recording from before it has
            // none: a server that keeps no effort, whose bots run on `inherit`. Once it is sent,
            // the word is kept as sent, one this app has not heard of included.
            && coworker.effort.as_deref() == opt_str(raw, "effort")
            && coworker.effort() == opt_str(raw, "effort").unwrap_or(EFFORT_INHERIT)
            && coworker.visibility.as_deref() == opt_str(raw, "visibility")
            && coworker.is_shared() == (opt_str(raw, "visibility") == Some("org"))
            // `source` arrives with the per-Bot door (opengrok-server main d6f640e (#307, after
            // #304), pin bf99845: `coworker_row` writes it on every row, `null` and all), and every
            // recording from before it has none, a server that keeps no door per Bot. Once sent,
            // `null` is the account's door, and a word is kept as sent, one this app has not heard
            // of included.
            && coworker.source == door_as_sent(raw),
        "a coworker came through changed: {coworker:?}"
    );
    Ok(())
}

/// A row's `source` as this app is held to read it, stated here rather than borrowed from the
/// client: missing, a server that keeps no door per Bot; `null`, the account's door; a word, the
/// Bot's own, or kept as sent where this app has not heard of it; anything else kept as its text.
fn door_as_sent(raw: &Value) -> CoworkerSource {
    match raw.get("source") {
        None => CoworkerSource::NotKept,
        Some(Value::Null) => CoworkerSource::AccountDefault,
        Some(Value::String(word)) => match word.as_str() {
            "gateway" => CoworkerSource::Kind(InferenceKind::Gateway),
            "local_proxy" => CoworkerSource::Kind(InferenceKind::LocalProxy),
            other => CoworkerSource::Unknown(other.to_string()),
        },
        Some(other) => CoworkerSource::Unknown(other.to_string()),
    }
}

fn coworkers(_: u16, body: &Value) -> Check {
    let roster: Vec<Coworker> = parse(body)?;
    let raw = rows(body)?;
    same_len(&roster, raw)?;
    roster
        .iter()
        .zip(raw)
        .try_for_each(|(coworker, raw)| coworker_matches(coworker, raw))
}

/// A hire and an edit answer with the coworker as it now is, which is the row the roster keeps.
/// The hire's reply also carries the account's `computerError` (opengrok-server
/// `agui/routes.rs`), which this app does not read off the row: the Computer pane reads the same
/// record from the computer route, in [`computer`].
fn coworker_row(_: u16, body: &Value) -> Check {
    coworker_matches(&parse(body)?, body)
}

/// A bot's usage this month (opengrok-server `points.rs` `UsageView`): what the Usage card
/// shows comes through as sent, metered or not (#138).
fn coworker_usage(_: u16, body: &Value) -> Check {
    let usage: CoworkerUsage = parse(body)?;
    must!(
        usage.metered == body["metered"].as_bool().unwrap_or(!usage.metered)
            && usage.note.as_deref() == opt_str(body, "note")
            && usage.window == str_at(body, "window"),
        "the usage report's header should come through: {usage:?}"
    );
    let raw = body["models"]
        .as_array()
        .ok_or("a usage report should carry models")?;
    same_len(&usage.models, raw)?;
    for (model, raw) in usage.models.iter().zip(raw) {
        must!(
            model.model_id == str_at(raw, "modelId")
                && Some(model.requests) == raw["requests"].as_i64()
                && Some(model.input_tokens) == raw["inputTokens"].as_i64()
                && Some(model.output_tokens) == raw["outputTokens"].as_i64()
                && Some(model.cache_read_tokens) == raw["cacheReadTokens"].as_i64()
                && Some(model.cache_write_tokens) == raw["cacheWriteTokens"].as_i64()
                && model.cost_usd == str_at(raw, "costUsd"),
            "each model's use should come through: {model:?} from {raw}"
        );
    }
    must!(
        usage.totals.requests == body["totals"]["requests"].as_i64()
            && usage.totals.input_tokens == body["totals"]["inputTokens"].as_i64()
            && usage.totals.output_tokens == body["totals"]["outputTokens"].as_i64()
            && usage.totals.cache_read_tokens == body["totals"]["cacheReadTokens"].as_i64()
            && usage.totals.cache_write_tokens == body["totals"]["cacheWriteTokens"].as_i64()
            && usage.totals.cost_usd.as_deref() == body["totals"]["costUsd"].as_str(),
        "the totals should come through: {:?}",
        usage.totals
    );
    must!(
        usage.metered || (usage.models.is_empty() && usage.totals.requests.is_none()),
        "a bot that is not metered should have nothing to show: {usage:?}"
    );
    // Metered with a note is the gateway not answering: its zeros are not a measurement, and
    // the card shows the note instead of them.
    must!(
        !usage.metered || usage.note.is_none() || usage.models.is_empty(),
        "a metered report with a note should have no models: {usage:?}"
    );
    Ok(())
}

/// One of the person's connections as the list and a lend or a revoke answer it
/// (opengrok-server#267 `ConnectionView`): its id, service, whose it is, its label and the Bots
/// it is lent to come through as sent, and how it was signed in to (opengrok-server #359), which
/// is waiting for a recording that carries it ([`REST_FIELDS_NOT_RECORDED_YET`]).
fn connection_reads_as_sent(row: &ConnectionView, raw: &Value) -> Check {
    let owner = match (str_at(&raw["owner"], "scope"), opt_str(&raw["owner"], "id")) {
        ("user", Some(id)) => ConnectionOwner::User(id.to_string()),
        ("bot", Some(id)) => ConnectionOwner::Bot(id.to_string()),
        ("global", _) => ConnectionOwner::Global,
        _ => ConnectionOwner::Other,
    };
    // Absent on a server from before opengrok-server #359, and read as the sign-in page then.
    let kind = match raw.get("kind").and_then(Value::as_str) {
        None | Some("oauth") => ConnectionKind::Oauth,
        Some("token") => ConnectionKind::Token,
        Some("mcp") => ConnectionKind::Mcp,
        Some(_) => ConnectionKind::Other,
    };
    let loans: Vec<&str> = raw["loans"]
        .as_array()
        .ok_or("a connection should carry its loans")?
        .iter()
        .filter_map(Value::as_str)
        .collect();
    must!(
        row.id == str_at(raw, "id")
            && row.connector == str_at(raw, "connector")
            && row.owner == owner
            && row.label == str_at(raw, "label")
            && row.loans == loans
            && Some(row.updated_at_ms) == raw.get("updatedAtMs").and_then(Value::as_i64)
            && row.expires_at_ms == raw.get("expiresAtMs").and_then(Value::as_i64)
            && row.kind == kind,
        "a connection came through changed: {row:?} from {raw}"
    );
    Ok(())
}

/// `GET /connectors` (opengrok-server#269): the services this server can connect, always a list,
/// each by the name Connect asks for and the label its button says.
fn connectors_listed(_: u16, body: &Value) -> Check {
    let listed: Vec<Connector> = parse(body)?;
    let raw = body.as_array().ok_or("the connectors should be a list")?;
    same_len(&listed, raw)?;
    for (connector, raw) in listed.iter().zip(raw) {
        must!(
            connector.name == str_at(raw, "name") && connector.label == str_at(raw, "label"),
            "a connector came through changed: {connector:?} from {raw}"
        );
    }
    Ok(())
}

/// `GET /connections/{connector}/authorize?format=json` (opengrok-server#269): the sign-in page the
/// app opens in the person's browser, a web address, with when its signed state lapses.
fn sign_in_link(_: u16, body: &Value) -> Check {
    let link: ConnectLink = parse(body)?;
    must!(
        link.url == str_at(body, "url")
            && url::Url::parse(&link.url).is_ok_and(|url| matches!(url.scheme(), "https" | "http")),
        "the sign-in link should be a web address the app opens: {link:?}"
    );
    must!(
        body.get("expiresAtMs").and_then(Value::as_i64).is_some(),
        "the sign-in link should say when it lapses: {body}"
    );
    Ok(())
}

/// `GET /connections`: always a list, and every row as sent.
fn connections_listed(_: u16, body: &Value) -> Check {
    let listed: Vec<ConnectionView> = parse(body)?;
    let raw = body.as_array().ok_or("the connections should be a list")?;
    same_len(&listed, raw)?;
    for (row, raw) in listed.iter().zip(raw) {
        connection_reads_as_sent(row, raw)?;
    }
    Ok(())
}

/// A lend or a revoke answers with the connection's row as the list has it, which the app puts
/// in place of the one it listed.
fn connection_changed(_: u16, body: &Value) -> Check {
    let row: ConnectionView = parse(body)?;
    connection_reads_as_sent(&row, body)
}

fn pin_reads_as_sent(pin: &ConnectionPin, raw: &Value) -> Check {
    must!(
        pin.coworker_id == str_at(raw, "coworkerId")
            && pin.connector == str_at(raw, "connector")
            && pin.connection_id == str_at(raw, "connectionId"),
        "a connection pin came through changed: {pin:?} from {raw}"
    );
    Ok(())
}

fn connection_pin(_: u16, body: &Value) -> Check {
    let pin: ConnectionPin = parse(body)?;
    pin_reads_as_sent(&pin, body)
}

fn connection_pins(_: u16, body: &Value) -> Check {
    let pins: Vec<ConnectionPin> = parse(body)?;
    let raw = body.as_array().ok_or("pins must be a list")?;
    same_len(&pins, raw)?;
    for (pin, raw) in pins.iter().zip(raw) {
        pin_reads_as_sent(pin, raw)?;
    }
    Ok(())
}

fn attempt_reads_as_sent(attempt: &ConnectionAttempt, raw: &Value) -> Check {
    must!(
        attempt.id == str_at(raw, "id")
            && attempt.connector == str_at(raw, "connector")
            && attempt.label == str_at(raw, "label")
            && attempt.coworker_id.as_deref() == opt_str(raw, "coworkerId")
            && attempt.status == str_at(raw, "status")
            && attempt.error.as_deref() == opt_str(raw, "error")
            && attempt.plugin.as_deref() == opt_str(raw, "plugin")
            && Some(attempt.updated_at_ms) == raw.get("updatedAtMs").and_then(Value::as_i64),
        "a waiting sign-in came through changed: {attempt:?} from {raw}"
    );
    // Either is an account that needs auth; a status this app does not know is not shown as one
    // that connected.
    must!(
        matches!(attempt.status.as_str(), "pending" | "failed"),
        "a waiting sign-in should be pending or failed: {raw}"
    );
    Ok(())
}

/// `GET /connections/attempts` (opengrok-server #359): always a list, every row as sent.
fn attempts_listed(_: u16, body: &Value) -> Check {
    let listed: Vec<ConnectionAttempt> = parse(body)?;
    let raw = body
        .as_array()
        .ok_or("the waiting sign-ins should be a list")?;
    same_len(&listed, raw)?;
    for (row, raw) in listed.iter().zip(raw) {
        attempt_reads_as_sent(row, raw)?;
    }
    Ok(())
}

fn attempt_changed(_: u16, body: &Value) -> Check {
    let row: ConnectionAttempt = parse(body)?;
    attempt_reads_as_sent(&row, body)
}

/// `GET /plugins/catalog`: the registry, the commit it was read at, and every entry as sent, its
/// category the marketplace's own and absent when the marketplace files it nowhere.
fn plugin_catalog(_: u16, body: &Value) -> Check {
    let catalog: PluginCatalog = parse(body)?;
    must!(
        catalog.registry == str_at(body, "registry")
            && catalog.revision == str_at(body, "revision"),
        "the catalog's registry and commit came through changed: {body}"
    );
    let raw = body["plugins"]
        .as_array()
        .ok_or("the catalog should list plugins")?;
    same_len(&catalog.plugins, raw)?;
    for (entry, raw) in catalog.plugins.iter().zip(raw) {
        must!(
            entry.name == str_at(raw, "name")
                && entry.description == str_at(raw, "description")
                && entry.category.as_deref() == opt_str(raw, "category")
                && entry.repository == str_at(raw, "repository")
                && entry.revision == str_at(raw, "revision")
                && entry.path == str_at(raw, "path")
                && entry.unavailable_reason.as_deref() == opt_str(raw, "unavailableReason"),
            "a catalog entry came through changed: {entry:?} from {raw}"
        );
    }
    Ok(())
}

/// `GET /plugins/catalog/{name}`: the entry, the commit, every part as sent and the services.
fn plugin_detail(_: u16, body: &Value) -> Check {
    let detail: PluginDetail = parse(body)?;
    must!(
        detail.entry.name == str_at(&body["entry"], "name")
            && detail.registry_revision == str_at(body, "registryRevision"),
        "a plugin's detail came through changed: {body}"
    );
    let raw = body["parts"]
        .as_array()
        .ok_or("a detail should list its parts")?;
    same_len(&detail.parts, raw)?;
    for (part, raw) in detail.parts.iter().zip(raw) {
        must!(
            part.kind == str_at(raw, "kind")
                && part.name == str_at(raw, "name")
                && Some(part.supported) == raw.get("supported").and_then(Value::as_bool)
                && part.reason.as_deref() == opt_str(raw, "reason"),
            "a part came through changed: {part:?} from {raw}"
        );
    }
    let connectors: Vec<&str> = body["connectors"]
        .as_array()
        .ok_or("a detail should name its services")?
        .iter()
        .filter_map(Value::as_str)
        .collect();
    must!(
        detail.connectors == connectors,
        "a detail's services came through changed: {body}"
    );
    Ok(())
}

/// `GET /plugins/installations`: every install as sent, with its services and the pasted accounts
/// it holds.
fn plugin_installations(_: u16, body: &Value) -> Check {
    let listed: Vec<PluginInstallation> = parse(body)?;
    let raw = body.as_array().ok_or("the installs should be a list")?;
    same_len(&listed, raw)?;
    for (install, raw) in listed.iter().zip(raw) {
        let connectors: Vec<&str> = raw["connectors"]
            .as_array()
            .ok_or("an install should name its services")?
            .iter()
            .filter_map(Value::as_str)
            .collect();
        let accounts = raw["accounts"]
            .as_array()
            .ok_or("an install should list its accounts")?;
        must!(
            install.name == str_at(raw, "name")
                && install.registry == str_at(raw, "registry")
                && install.registry_revision == str_at(raw, "registryRevision")
                && install.repository == str_at(raw, "repository")
                && install.revision == str_at(raw, "revision")
                && Some(install.installed_at_ms)
                    == raw.get("installedAtMs").and_then(Value::as_i64)
                && install.bundle.manifest.name == str_at(&raw["bundle"]["manifest"], "name")
                && install.bundle.parts.len()
                    == raw["bundle"]["parts"].as_array().map_or(0, Vec::len)
                && install.connectors == connectors
                && install.accounts.len() == accounts.len()
                && install.accounts.iter().zip(accounts).all(|(a, raw)| {
                    a.connector == str_at(raw, "connector")
                        && a.connection_id == str_at(raw, "connectionId")
                }),
            "an install came through changed: {install:?} from {raw}"
        );
    }
    Ok(())
}

/// How an installed plugin's service adds an account: at its own provider or by a pasted token.
fn sign_in_method(_: u16, body: &Value) -> Check {
    must!(
        matches!(opt_str(body, "method"), Some("oauth" | "token")),
        "a sign-in method should be oauth or token: {body}"
    );
    Ok(())
}

/// Adding a pasted account answers the new account's id, which the app goes on to name it by.
fn token_added(_: u16, body: &Value) -> Check {
    let added: AddedToken = parse(body)?;
    must!(
        !added.connection_id.is_empty() && added.connection_id == str_at(body, "connectionId"),
        "an added account should be named: {body}"
    );
    Ok(())
}

/// A disconnect answers 204 with nothing; the app takes any 2xx as the connection gone.
fn connection_gone(status: u16, body: &Value) -> Check {
    must!(
        (200..300).contains(&status) && body_json(body).is_null(),
        "a disconnect should be a 2xx with no body, not {status} {body}"
    );
    Ok(())
}

/// A bot's tools (opengrok-server `agui/routes.rs` `list_tools`): every tool the server lists
/// comes through by the name the model is told, with its words and its kind. The kind is what
/// sorts a tool under the server's own or a plugin's, and the parse defaults a missing one to
/// empty, so a row that says none is caught here rather than filed as a plugin's.
fn coworker_tools(_: u16, body: &Value) -> Check {
    let listing: ToolListing = parse(body)?;
    let raw = body["tools"]
        .as_array()
        .ok_or("a listing should carry a tools array")?;
    same_len(&listing.tools, raw)?;
    for (tool, raw) in listing.tools.iter().zip(raw) {
        let kind = str_at(raw, "kind");
        must!(
            !kind.is_empty(),
            "each tool should say what kind it is: {raw}"
        );
        must!(
            tool.name == str_at(raw, "name")
                && tool.description == str_at(raw, "description")
                && tool.kind == kind
                && tool.is_builtin() == (kind == "builtin"),
            "each tool should come through as sent: {tool:?} from {raw}"
        );
    }
    Ok(())
}

/// A bot's tool ceiling (opengrok-server#268), read or as a write's answer: every row comes
/// through by the name a `PUT` names it by, with its kind, whether it is enabled and whether it is
/// available, and the words, label and connector the Tools card draws; and the version a switch
/// sends back, exactly, or none from a server older than it. A row that does not say whether it is
/// enabled cannot be sent back as it stands, so the parse refuses it; one that drops its kind is
/// caught here rather than filed with the plugins.
/// One tool's choice for a Bot, answered with what was set (opengrok-server `agui/ceiling.rs`
/// `put_tool_mode`, #359): the app sends `{tool, mode}` and takes any 2xx as done, so the answer
/// must name the tool and one of the three choices it knows.
fn tool_mode(_: u16, body: &Value) -> Check {
    must!(
        body["tool"].as_str().is_some_and(|t| !t.is_empty()),
        "a tool choice should name its tool: {body}"
    );
    must!(
        matches!(body["mode"].as_str(), Some("always" | "ask" | "never")),
        "a tool choice is always, ask or never: {body}"
    );
    Ok(())
}

fn coworker_ceiling(_: u16, body: &Value) -> Check {
    let ceiling: CoworkerCeiling = parse(body)?;
    must!(
        ceiling.version == body["version"].as_i64(),
        "the version should come through as sent: {:?} from {}",
        ceiling.version,
        body["version"]
    );
    let raw = body["tools"]
        .as_array()
        .ok_or("a ceiling should carry a tools array")?;
    same_len(&ceiling.tools, raw)?;
    for (row, raw) in ceiling.tools.iter().zip(raw) {
        let kind = str_at(raw, "kind");
        must!(
            !kind.is_empty(),
            "each row should say what kind it is: {raw}"
        );
        must!(
            row.name == str_at(raw, "name")
                && row.is_builtin() == (kind == "builtin")
                && Some(row.enabled) == raw["enabled"].as_bool()
                && row.is_available() == (raw["available"].as_bool() != Some(false))
                && row.label.as_deref() == opt_str(raw, "label")
                && row.description.as_deref() == opt_str(raw, "description")
                && row.connector.as_deref() == opt_str(raw, "connector"),
            "each row should come through as sent: {row:?} from {raw}"
        );
    }
    Ok(())
}

/// The account's reply source, read or as a Save's answer (opengrok-server #294: `described` in
/// `crates/opengrok-harness/src/local_proxy.rs`, behind `crates/opengrok-server/src/inference.rs`):
/// the door, the proxy's URL and the model as sent, `null` for none, and the two flags the page
/// acts on. A body without a flag is not read as that flag being false, and a door this app has
/// not heard of is not read as one it has. Its refusals are read as every other: a 400 in the
/// server's words for an address or a model it will not keep, or a way to the plan it has not
/// built (`helper`), a 503 for a key with no vault to keep it in, and a 401 as the session gone.
fn inference_source(_: u16, body: &Value) -> Check {
    let read: InferenceSource = parse(body)?;
    must!(
        read.kind.word() == str_at(body, "kind")
            && read.base_url.as_deref() == opt_str(body, "baseUrl")
            && read.local_model.as_deref() == opt_str(body, "localModel")
            && Some(read.healthy) == body["healthy"].as_bool()
            && Some(read.has_api_key) == body["hasApiKey"].as_bool(),
        "the reply source should come through as sent: {read:?} from {body}"
    );
    // From a server with the Mac relay (opengrok-server main cad36fd (#303, after #298), pin
    // 47a5d6b: `described` in the same file): the account's way as
    // sent, and where the relay stands, field for field, nulls and all when no Mac holds it. A
    // server before the relay sends neither, and the relay is not offered.
    must!(
        read.via.as_deref() == opt_str(body, "via"),
        "the account's way should come through as sent: {read:?} from {body}"
    );
    match (
        &read.relay,
        body.get("relay").filter(|relay| !relay.is_null()),
    ) {
        (None, None) => {}
        (Some(relay), Some(raw)) => must!(
            Some(relay.connected) == raw["connected"].as_bool()
                && relay.machine_id.as_deref() == opt_str(raw, "machineId")
                && relay.machine_label.as_deref() == opt_str(raw, "machineLabel")
                && relay.local_model.as_deref() == opt_str(raw, "localModel"),
            "where the relay stands should come through as sent: {relay:?} from {raw}"
        ),
        (read, sent) => {
            return Err(format!(
                "the relay should be read exactly when it is sent: {read:?} from {sent:?}"
            ));
        }
    }
    // The default for new Bots, from a server that keeps one (opengrok-server #322, on main
    // c0bb6ae: `described` in the same file): read exactly when the key is sent, null as none
    // set, and an object field for field, an effort left out as `inherit`.
    match (&read.new_bot_default, body.get("newBotDefault")) {
        (None, None) | (Some(None), Some(Value::Null)) => {}
        (Some(Some(default)), Some(raw)) => must!(
            default.source.word() == str_at(raw, "source")
                && default.model == str_at(raw, "model")
                && default.effort == opt_str(raw, "effort").unwrap_or(EFFORT_INHERIT),
            "the default for new Bots should come through as sent: {default:?} from {raw}"
        ),
        (read, sent) => {
            return Err(format!(
                "the default for new Bots should be read exactly as it is sent: {read:?} from \
                 {sent:?}"
            ));
        }
    }
    // Whether the relay is on, from a server that keeps it (opengrok-server #332 (PR #338 at
    // 66b9f7b), and since #342 (main 2136ffc) derived from the computers' own switches, true while
    // any un-revoked one is on: `described` in the same file, on every read): read as sent, and as
    // no key from one before it, which the relay switch then tells nothing.
    must!(
        read.relay_enabled == body.get("relayEnabled").and_then(Value::as_bool),
        "whether the relay is on should come through as sent: {read:?} from {body}"
    );
    // The Relay-off fallback, from a server that keeps one (the same PR, on every read too): read
    // exactly when the key is sent, null as none set, and an object field for field, an effort
    // left out as `inherit`.
    match (&read.plan_fallback, body.get("planFallback")) {
        (None, None) | (Some(None), Some(Value::Null)) => {}
        (Some(Some(fallback)), Some(raw)) => must!(
            fallback.model == str_at(raw, "model")
                && fallback.effort == opt_str(raw, "effort").unwrap_or(EFFORT_INHERIT),
            "the Relay-off fallback should come through as sent: {fallback:?} from {raw}"
        ),
        (read, sent) => {
            return Err(format!(
                "the Relay-off fallback should be read exactly as it is sent: {read:?} from \
                 {sent:?}"
            ));
        }
    }
    Ok(())
}

/// `GET /models` (`list_models` in opengrok-server `agui/routes.rs`, #294), which the Bot's Model
/// field and Settings → Reply source's picker are drawn from: every entry through by its id and
/// its door as sent (`gateway`, `local_proxy`, or none from a server before reply sources, read
/// as the gateway's; a word this app does not know is caught here rather than offered by
/// neither picker unseen), the note as sent, and opencodex's health (`localProxy.healthy`) as
/// sent, or none while no proxy address is kept.
fn models_listed(_: u16, body: &Value) -> Check {
    let catalogue: ModelCatalogue = parse(body)?;
    let raw = body["models"]
        .as_array()
        .ok_or("the list should carry a models array")?;
    same_len(&catalogue.models, raw)?;
    for (entry, raw) in catalogue.models.iter().zip(raw) {
        let door = match opt_str(raw, "source") {
            None => Some(InferenceKind::Gateway),
            Some(word) => InferenceKind::from_word(word),
        };
        must!(
            door.is_some() && entry.id == str_at(raw, "id") && entry.source() == door,
            "each model should come through by its id and its door as sent: {entry:?} from {raw}"
        );
    }
    // Each model's levels of effort, lowest first, and the one it runs at when a Bot chooses
    // none: opengrok-server #342 (main 2136ffc), `Model::entry` in
    // `crates/opengrok-core/src/catalogue.rs`, on every entry of the recording. A server from
    // before it sends neither, which is a model that lists no levels, and a list that is `null`
    // or empty reads the same. The server drops an entry with no `value` and shows one with no
    // `label` as its value (`Levels::of`), and so does this app. A key in any other shape is the
    // server not keeping to what it says: the app reads it as none, and it is caught here, so a
    // slider that goes missing is not missed.
    fn said<'a>(level: &'a Value, key: &str) -> Option<&'a str> {
        opt_str(level, key).filter(|word| !word.trim().is_empty())
    }
    for (entry, raw) in catalogue.models.iter().zip(raw) {
        must!(
            matches!(
                raw.get("efforts"),
                None | Some(Value::Null | Value::Array(_))
            ),
            "a model's levels of effort should be a list or null: {raw}"
        );
        must!(
            matches!(
                raw.get("ownEffort"),
                None | Some(Value::Null | Value::String(_))
            ),
            "a model's own level should be a word or null: {raw}"
        );
        let sent: Option<Vec<(&str, &str)>> = raw
            .get("efforts")
            .and_then(Value::as_array)
            .map(|levels| {
                levels
                    .iter()
                    .filter_map(|level| {
                        let value = said(level, "value")?;
                        Some((value, said(level, "label").unwrap_or(value)))
                    })
                    .collect::<Vec<_>>()
            })
            .filter(|levels| !levels.is_empty());
        let read: Option<Vec<(&str, &str)>> = entry.efforts.as_ref().map(|levels| {
            levels
                .iter()
                .map(|level| (level.value.as_str(), level.label.as_str()))
                .collect()
        });
        must!(
            read == sent,
            "each model's levels of effort should come through as sent, lowest first: {entry:?} \
             from {raw}"
        );
        must!(
            entry.own_effort.as_deref() == opt_str(raw, "ownEffort"),
            "each model's own level should come through as sent: {entry:?} from {raw}"
        );
    }
    must!(
        catalogue.note.as_deref() == opt_str(body, "note"),
        "the note should come through as sent: {:?} from {body}",
        catalogue.note
    );
    let healthy = body
        .get("localProxy")
        .and_then(|proxy| proxy.get("healthy"))
        .and_then(Value::as_bool);
    must!(
        catalogue.local_proxy.map(|proxy| proxy.healthy) == healthy,
        "opencodex's health should come through as sent: {:?} from {body}",
        catalogue.local_proxy
    );
    // With the Mac relay (opengrok-server main cad36fd (#303, after #298), pin 47a5d6b: `listed` in
    // `crates/opengrok-harness/src/local_proxy.rs`): each
    // of the plan's models by the way the server reaches it, none named being the server's own
    // machine, and whether a Mac holds the relay.
    for (entry, raw) in catalogue.models.iter().zip(raw) {
        let via = match (entry.is_local_proxy(), opt_str(raw, "via")) {
            (false, _) => None,
            (true, None) => Some(Via::Loopback),
            (true, Some(word)) => Via::from_word(word),
        };
        must!(
            entry.plan_via() == via,
            "each of the plan's models should say its way as sent: {entry:?} from {raw}"
        );
    }
    let relay = body
        .get("localProxy")
        .and_then(|proxy| proxy.get("relayConnected"))
        .and_then(Value::as_bool);
    if let Some(proxy) = catalogue.local_proxy {
        must!(
            proxy.relay_connected == relay.unwrap_or(false),
            "whether a Mac holds the relay should come through as sent: {proxy:?} from {body}"
        );
    }
    Ok(())
}

/// The Mac relay's stream (`open_inference_relay`), read as it comes. NO RECORDED FIXTURE
/// REACHES THIS: the recorder files the stream's frames under `relay/`, where [`relay_frame`]
/// reads each one, and the route's only body it keeps is a refusal, read in [`read_fixture`].
/// This reading stands for the day a 2xx body is recorded here, which would be the stream's
/// text: `data:` lines, each a frame the relay reads as it means to.
fn relay_stream(_: u16, body: &Value) -> Check {
    let stream = body
        .as_str()
        .ok_or("the relay's stream is its frames, not a JSON body")?;
    let frames: Vec<Value> = stream
        .lines()
        .filter_map(|line| data_frame(line.as_bytes()))
        .collect();
    must!(
        !frames.is_empty(),
        "the relay's stream is `data:` lines: {stream:?}"
    );
    frames.iter().try_for_each(relay_frame)
}

/// The account's events stream answered (opengrok-server #351, recorded at 9a2b011): its notes as
/// SSE blocks, read off the body by the stream's own reader (`events::blocks_of`), each as the
/// note it is ([`account_event_frame`]); a ping is a comment, and carries nothing.
fn account_events_stream(_: u16, body: &Value) -> Check {
    let stream = body
        .as_str()
        .ok_or("the events stream is its blocks, not a JSON body")?;
    for (id, name, data) in blocks_of(stream) {
        let data: Value = serde_json::from_str(&data)
            .map_err(|error| format!("a block's data is one line of JSON: {error}"))?;
        account_event_frame(&serde_json::json!({"id": id, "event": name, "data": data}))?;
    }
    Ok(())
}

/// The account's events stream refused (`open_account_events` reads the refusal as every other,
/// and the stream takes it by `events::when_refused`). A `401` is read before this, as the session
/// gone ([`signed_out`]). A route the server does not have, an empty `404` or a `405`, is a server
/// from before the stream, which stops it; anything else, as the `503` of a store the server could
/// not read, is tried again after a wait, and is read as every other refusal.
fn account_events_refused(status: u16, body: &Value) -> Check {
    let error = OpenGrokClient::refusal(status, &body_text(body));
    let no_route = status == 405 || (status == 404 && body_text(body).trim().is_empty());
    let expected = if no_route {
        Refused::NoStream
    } else {
        Refused::TryAgain
    };
    let taken = when_refused(&error);
    must!(
        taken == expected,
        "a {status} on the events stream should be {expected:?}, not {taken:?}"
    );
    refusal(status, body)
}

/// The relay's stream refused (`open_inference_relay` reads the refusal as every other, and the
/// relay takes it in `stream_once`). A 401 is the server turning this Mac's token away, which
/// the relay stops for until this Mac enrols again, rather than asking again with a token that
/// would be turned away again; it says so in its own words, not the server's. A 409 with
/// `code: "relay_disabled"` is the server saying this computer's relay is switched off (opengrok-server
/// #342 (main 2136ffc): `relaying` in `crates/opengrok-server/src/inference.rs`, `RELAY_IS_OFF` in
/// `crates/opengrok-wire/src/relay.rs`, recorded), which the relay stops for and waits on its own
/// row for, rather than knocking again to be refused again; that is the server's word and no
/// other 409 is. Anything else is said in a sentence while the relay tries again, and is read as every other
/// refusal.
fn relay_stream_refused(status: u16, body: &Value) -> Check {
    let error = OpenGrokClient::refusal(status, &body_text(body));
    let stops = token_turned_away(&error);
    must!(
        stops == (status == 401),
        "a {status} on the relay's stream should {} the relay",
        if status == 401 { "stop" } else { "not stop" }
    );
    if stops {
        return Ok(());
    }
    let switched_off = status == 409 && opt_str(body, "code") == Some("relay_disabled");
    must!(
        relay_disabled(&error) == switched_off,
        "a {status} on the relay's stream {} the relay waiting for its switch: {body}",
        if switched_off {
            "should leave"
        } else {
            "should not leave"
        }
    );
    if switched_off {
        return refusal(status, body);
    }
    must!(
        !stream_refusal(&error).trim().is_empty(),
        "a refused stream should be said in a sentence while the relay tries again: {error:?}"
    );
    refusal(status, body)
}

/// What the server made of one of this Mac's answers, as `answer_inference_relay` reads it off
/// the status alone (opengrok-server main cad36fd (#303, after #298), pin 47a5d6b: `relay_response`
/// in `crates/opengrok-server/src/inference.rs`), stated here
/// status by status: taken; a call nothing waits on any more, which is as good as cancelled; one
/// answered already; this Mac turned away, which stops the relay (the server says so of a bad
/// token and of a call sent to another machine, and this Mac answers only the calls its own
/// stream brought it); and an answer past the server's 32 MiB, cut off there, a failed answer
/// with nothing to send again. `None` is a refusal read as every other.
fn relay_answered_as(status: u16) -> Option<RelayAnswered> {
    match status {
        200..=299 => Some(RelayAnswered::Taken),
        404 => Some(RelayAnswered::Gone),
        409 => Some(RelayAnswered::AlreadyAnswered),
        401 => Some(RelayAnswered::TokenRefused),
        413 => Some(RelayAnswered::TooLarge),
        _ => None,
    }
}

/// This Mac's answer taken: the 204, which the relay reads off the status and nothing else.
fn relay_answer(status: u16, _: &Value) -> Check {
    let read = OpenGrokClient::relay_answered(status);
    must!(
        read == Some(RelayAnswered::Taken),
        "an answer the server took with {status} should read as taken, not {read:?}"
    );
    Ok(())
}

/// One of this Mac's answers refused, read off its status ([`relay_answered_as`]), or when the
/// status says nothing the relay acts on, as every other refusal.
fn relay_answer_refused(status: u16, body: &Value) -> Check {
    let expected = relay_answered_as(status);
    let read = OpenGrokClient::relay_answered(status);
    must!(
        read == expected,
        "an answer refused with {status} should read as {expected:?}, not {read:?}"
    );
    if read.is_some() {
        return Ok(());
    }
    refusal(status, body)
}

/// A frame off the Mac relay's stream, read by the relay's own reader (`RelayFrame::from_value`)
/// as the frame it is, with every field the relay goes on to use as sent: the frame's own words
/// as the server writes them (opengrok-server main cad36fd (#303, after #298), pin 47a5d6b:
/// `RelayFrame` in `crates/opengrok-wire/src/relay.rs`), stated here
/// case by case. A call is one the Mac carries: its model, the frame's and the body's, is one the
/// Mac may ask the person's subscription for, so the relay asks opencodex rather than refusing
/// it, and it asks for the stream the relay passes on as it comes.
fn relay_frame(frame: &Value) -> Check {
    let text = |key: &str| str_at(frame, key).to_string();
    let expected = match str_at(frame, "type") {
        "ready" => RelayFrame::Ready {
            machine_id: text("machineId"),
        },
        "replaced" => RelayFrame::Replaced,
        "disabled" => RelayFrame::Disabled,
        "infer" => RelayFrame::Infer {
            request_id: text("requestId"),
            run_id: text("runId"),
            model: text("model"),
            request: frame["request"].clone(),
        },
        "models" => RelayFrame::Models {
            request_id: text("requestId"),
        },
        "cancel" => RelayFrame::Cancel {
            request_id: text("requestId"),
        },
        "ping" => RelayFrame::Ping,
        kind => {
            return Err(format!(
                "no check for a relay frame of type {kind:?}: say here what the relay does with one"
            ));
        }
    };
    let read = RelayFrame::from_value(frame);
    must!(
        read == expected,
        "the relay should read {expected:?}, not {read:?}"
    );
    if let RelayFrame::Infer { model, request, .. } = &read {
        let asked = str_at(request, "model");
        must!(
            is_subscription_model(model) && is_subscription_model(asked),
            "a call the server sends the Mac should name a model the Mac asks the person's \
             subscription for: {model:?}, {asked:?}"
        );
        must!(
            request["stream"] == Value::Bool(true),
            "a call should ask opencodex for the stream the relay passes on: {request}"
        );
    }
    Ok(())
}

/// A bot's skills (opengrok-server#270), read or as a write's answer: every skill comes through
/// by the id a `PUT` names it by, with its name, its words, whose it is, whether it is attached
/// and whether it is switched on; and the version a switch sends back, exactly, or none. A row
/// that does not say whether it is attached or switched on cannot be drawn or sent back as it
/// stands, so the parse refuses it; a scope in a word this app does not know is caught here
/// rather than filed with the organization's.
fn coworker_skills(_: u16, body: &Value) -> Check {
    let skills: CoworkerSkills = parse(body)?;
    must!(
        skills.version == body["version"].as_i64(),
        "the version should come through as sent: {:?} from {}",
        skills.version,
        body["version"]
    );
    let raw = body["skills"]
        .as_array()
        .ok_or("a bot's skills should carry a skills array")?;
    same_len(&skills.skills, raw)?;
    for (row, raw) in skills.skills.iter().zip(raw) {
        let scope = str_at(raw, "scope");
        must!(
            matches!(scope, "mine" | "org"),
            "each skill should say whose it is, mine or org, not {scope:?}: {raw}"
        );
        must!(
            row.id == str_at(raw, "id")
                && row.name == str_at(raw, "name")
                && row.description == opt_str(raw, "description").unwrap_or_default()
                && (row.scope == BotSkillScope::Mine) == (scope == "mine")
                && Some(row.attached) == raw["attached"].as_bool()
                && Some(row.enabled) == raw["enabled"].as_bool(),
            "each skill should come through as sent: {row:?} from {raw}"
        );
    }
    Ok(())
}

/// A coworker's computer (`coworker_computer`), which the Computer pane and the tunnel's chrome
/// are drawn from: whose box it is and where it is shared, its state and its screen, the
/// person's standing answer to the tunnel's card, the tunnel's own readiness, and why the server
/// could not give the bot a computer. A share scope or an egress policy in a word this app does
/// not know hides its control, so each one sent must be a word it knows.
fn computer(_: u16, body: &Value) -> Check {
    let status: CoworkerComputer = parse(body)?;
    let given = |key: &str| body.get(key).filter(|value| !value.is_null());
    must!(
        status.agent_id == str_at(body, "agentId")
            && status.state == str_at(body, "state")
            && status.vnc_url.as_deref() == opt_str(body, "vncUrl")
            && status.box_id.as_deref() == opt_str(body, "boxId")
            && status.group_id() == opt_str(body, "groupId")
            && status.image.is_some() == given("image").is_some()
            && status.update.is_some() == given("update").is_some()
            && status.is_egress_tunnel_available
                == body
                    .get("isEgressTunnelAvailable")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
        "the computer came through changed: {status:?}"
    );
    // An update in flight, or the failure the last one ended in (`update_status` in
    // opengrok-server's `crates/opengrok-server/src/agui/provision.rs`, on a read and on the
    // update's own 202): the phase, when it began and its error as sent. `updatedAtMs` is the
    // server's own clock for an update that has stopped moving, which nothing here reads.
    if let (Some(update), Some(raw)) = (&status.update, given("update")) {
        must!(
            update.phase == str_at(raw, "phase")
                && Some(update.started_at_ms) == raw.get("startedAtMs").and_then(Value::as_i64)
                && update.error.as_deref() == opt_str(raw, "error")
                && update.in_flight() == (str_at(raw, "phase") != "failed"),
            "an update should come through as sent: {update:?} from {raw}"
        );
    }
    let scope = opt_str(body, "shareScope");
    must!(
        status.share_scope == scope.and_then(BoxShareScope::parse)
            && (scope.is_none() || status.share_scope.is_some()),
        "the share scope should be a word this app knows, not {scope:?}"
    );
    let policy = opt_str(body, "egressPolicy");
    must!(
        status.egress_policy == policy.and_then(LocalExecMode::parse)
            && (policy.is_none() || status.egress_policy.is_some()),
        "the egress policy should be a word this app knows, not {policy:?}"
    );
    let tunnel = given("egress_tunnel");
    must!(
        status.box_egress_ready()
            == tunnel.map(|tunnel| tunnel.get("ready").and_then(Value::as_bool) == Some(true))
            && status
                .egress_tunnel
                .as_ref()
                .and_then(|tunnel| tunnel.enabled)
                == tunnel.and_then(|tunnel| tunnel.get("enabled").and_then(Value::as_bool)),
        "the tunnel should come through as the box reported it: {:?}",
        status.egress_tunnel
    );
    // The server's reason comes through word for word, with its code and the stamp it always
    // carries (opengrok-server `agui/provision.rs` `error_json_at`). The pane says it in place of
    // "No computer yet" on a status that names no box; beside a box it is a takeover's note
    // about that box, and no reason to ask for another.
    let sent = given("computerError");
    must!(
        status.computer_error.as_ref().map(|read| (
            read.code.as_str(),
            read.message.as_str(),
            Some(read.updated_at_ms)
        )) == sent.map(|raw| {
            (
                str_at(raw, "code"),
                str_at(raw, "message"),
                raw.get("updatedAtMs").and_then(Value::as_i64),
            )
        }),
        "the computer's error should come through as sent, stamped: {:?}",
        status.computer_error
    );
    must!(
        status
            .computer_error
            .as_ref()
            .is_none_or(|read| !read.code.is_empty() && !read.message.is_empty()),
        "a recorded error should carry a code and words to show: {:?}",
        status.computer_error
    );
    must!(
        status.why_no_computer().map(|read| read.message.as_str())
            == sent
                .filter(|_| given("boxId").is_none())
                .map(|raw| str_at(raw, "message")),
        "the pane should say the server's reason exactly when there is one and no box: {status:?}"
    );
    Ok(())
}

/// The coworker's screen right now (`coworker_screen`): the picture a `TOOL_CALL_RESULT` carries,
/// decoded the same way (`ScreenshotSpec::from_frame`), and tagged `transcript`, as the server's
/// `computer_screen` in `crates/opengrok-server/src/agui/routes.rs` tags it: an explicit look at
/// the screen is a picture a client may keep, where the steps' own shots are `agent`. A coworker
/// that has no computer is its 404, `this coworker has no computer`, read as every refusal is.
fn screen(_: u16, body: &Value) -> Check {
    let shot = ScreenshotSpec::from_frame("screen", "", body)
        .ok_or("the screen did not decode as a picture")?;
    must!(
        shot.visibility == Some(ImageVisibility::Transcript),
        "the screen should be tagged transcript, not {:?}",
        shot.visibility
    );
    must!(
        Some(u64::from(shot.width)) == body.get("width").and_then(Value::as_u64)
            && Some(u64::from(shot.height)) == body.get("height").and_then(Value::as_u64),
        "the screen is {}x{}, not what the answer says",
        shot.width,
        shot.height
    );
    Ok(())
}

fn parameter_kind(word: &str) -> RecipeParameterKind {
    match word {
        "number" => RecipeParameterKind::Number,
        "boolean" => RecipeParameterKind::Boolean,
        _ => RecipeParameterKind::Text,
    }
}

fn recipes(_: u16, body: &Value) -> Check {
    let list: RecipeList = parse(body)?;
    let raw = body
        .get("recipes")
        .and_then(Value::as_array)
        .ok_or("the rows sit under recipes")?;
    same_len(&list.recipes, raw)?;
    for (recipe, raw) in list.recipes.iter().zip(raw) {
        let parameters = raw
            .get("parameters")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        must!(
            recipe.id == str_at(raw, "id")
                && recipe.name == str_at(raw, "name")
                && recipe.is_workflow() == (str_at(raw, "kind") == "workflow")
                && recipe.is_mine() == (str_at(raw, "relation") == "mine")
                && Some(u64::from(recipe.latest_version))
                    == raw.get("latestVersion").and_then(Value::as_u64)
                && recipe.parameters.len() == parameters.len(),
            "a recipe came through changed: {recipe:?}"
        );
        for (parameter, raw) in recipe.parameters.iter().zip(&parameters) {
            must!(
                parameter.name == str_at(raw, "name")
                    && Some(parameter.required) == raw.get("required").and_then(Value::as_bool)
                    && parameter.kind == parameter_kind(str_at(raw, "kind")),
                "a parameter came through changed: {parameter:?}"
            );
        }
    }
    Ok(())
}

/// A recipe's whole detail, which `GET /recipes/{id}` and every write to a recipe answer with.
/// A version's steps are a tape's sequence; a workflow's version carries its decision tree there
/// instead, as named branches, and reads as a version with no tape steps (see `tape_steps` in
/// `client.rs`).
fn recipe_detail(_: u16, body: &Value) -> Check {
    let detail: RecipeDetail = parse(body)?;
    must!(
        detail.recipe.id == str_at(&body["recipe"], "id")
            && detail.recipe.is_workflow() == (str_at(&body["recipe"], "kind") == "workflow"),
        "the recipe changed: {:?}",
        detail.recipe
    );
    let versions = body["versions"].as_array().ok_or("no versions array")?;
    same_len(&detail.versions, versions)?;
    for (version, raw) in detail.versions.iter().zip(versions) {
        let steps = raw
            .pointer("/body/steps")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        must!(
            Some(u64::from(version.version)) == raw.get("version").and_then(Value::as_u64)
                && version.kind == str_at(raw, "kind")
                && version.body.steps.len() == steps,
            "a version came through changed: {version:?}"
        );
    }
    let runs = body["runs"].as_array().ok_or("no runs array")?;
    same_len(&detail.runs, runs)?;
    for (run, raw) in detail.runs.iter().zip(runs) {
        let state = str_at(raw, "state");
        must!(
            run.id == str_at(raw, "id")
                && run.state == state
                && run.is_running() == (state == "running")
                && Some(run.ok) == raw.get("ok").and_then(Value::as_bool),
            "a run came through changed: {run:?}"
        );
    }
    let bots = body["myBots"].as_array().ok_or("no myBots array")?;
    same_len(&detail.my_bots, bots)?;
    for (bot, raw) in detail.my_bots.iter().zip(bots) {
        must!(
            detail.bot_name(&bot.id) == str_at(raw, "name"),
            "a bot's name changed: {bot:?}"
        );
    }
    Ok(())
}

fn recipe_run(status: u16, body: &Value) -> Check {
    match status {
        202 => {
            let accepted: AsyncRunResponse = parse(body)?;
            must!(
                accepted.run_id == str_at(body, "runId"),
                "the run id should come through"
            );
        }
        200 => {
            let result: RecipeRunResult = parse(body)?;
            must!(
                Some(result.ok) == body.get("ok").and_then(Value::as_bool),
                "the outcome should come through: {result:?}"
            );
        }
        other => return Err(format!("no reading for a {other} from a run")),
    }
    Ok(())
}

/// Every line of a routine's history comes through, and every word in it is one this app has
/// a name for: a cause or a status read as `Other` is the server saying something the editor
/// cannot say back. A firing the server skipped (#316: `history` in autonomy/routes.rs) reads as
/// a skip, with no run to open, when it was due, and the server's sentence for why, which is what
/// its line says; and a run is never read as one. A run a Bot started (#337, built in #342, the
/// same `history`) is the cause `bot` and names the Bot, by its id and the name it had then, and
/// no other line does: `by` is null on every other cause, and absent on a line from before it.
fn schedule_runs(_: u16, body: &Value) -> Check {
    let listed: Vec<ScheduleRun> = parse(body)?;
    let raw = rows(body)?;
    same_len(&listed, raw)?;
    for (run, raw) in listed.iter().zip(raw) {
        must!(
            run.cause != RunCause::Other,
            "a word this app has no name for: {raw}"
        );
        let by = raw.get("by").filter(|by| !by.is_null());
        must!(
            run.by
                .as_ref()
                .map(|by| (by.coworker_id.as_str(), by.name.as_str()))
                == by.map(|by| (str_at(by, "coworkerId"), str_at(by, "name")))
                && (run.cause == RunCause::Bot) == (str_at(raw, "cause") == "bot")
                && (run.cause == RunCause::Bot) == by.is_some(),
            "who ran it should come through as sent, and be named exactly when a Bot did: {run:?} \
             from {raw}"
        );
        if str_at(raw, "state") == SKIPPED_FIRING {
            must!(
                run.is_skipped()
                    && run.run_id.is_none()
                    && run.at.is_some()
                    && run.at == raw.get("at").and_then(Value::as_i64)
                    && run.reason.as_deref() == opt_str(raw, "reason")
                    && run
                        .reason
                        .as_deref()
                        .is_some_and(|why| !why.trim().is_empty()),
                "a skipped firing should read as one, with its time and its reason: {run:?}"
            );
            continue;
        }
        must!(
            !run.is_skipped()
                && run.run_id.as_deref() == opt_str(raw, "runId")
                && run.started_at_ms == raw.get("startedAtMs").and_then(Value::as_i64)
                && run.started_at_ms.is_some()
                && run.ended_at_ms == raw.get("endedAtMs").and_then(Value::as_i64),
            "a run came through changed: {run:?}"
        );
        must!(
            run.status
                .is_some_and(|status| status != ScheduleRunStatus::Other),
            "a word this app has no name for: {raw}"
        );
    }
    Ok(())
}

/// A routine's `lastRun`, on every row of the listing, says what set the run off and which Bot
/// did when one did, as a line of the history does (opengrok-server #337, built in #342:
/// `last_run` in `crates/opengrok-server/src/autonomy/mod.rs`): its `cause` is a word this app
/// has a name for, and its `by` is the Bot's id and the name it had then exactly when the cause is
/// `bot`, and null for every other. This app reads none of `lastRun` and draws no line of it, so
/// what is held here is the shape its history reads, on the rows the server sends it with.
#[test]
fn a_routines_last_run_names_the_bot_that_ran_it_exactly_when_a_bot_did() {
    let corpus = Corpus::load();
    let (mut by_a_bot, mut by_nobody) = (0, 0);
    for fixture in recorded(&corpus, "GET__schedules").filter(|fixture| fixture["status"] == 200) {
        for row in fixture["body"].as_array().expect("rows") {
            let Some(last) = row.get("lastRun").filter(|last| !last.is_null()) else {
                continue;
            };
            let cause: RunCause = serde_json::from_value(last["cause"].clone())
                .unwrap_or_else(|why| panic!("the cause of {last}: {why}"));
            assert_ne!(
                cause,
                RunCause::Other,
                "a word this app has no name for: {last}"
            );
            let by: Option<RunBy> = serde_json::from_value(last["by"].clone())
                .unwrap_or_else(|why| panic!("who ran {last}: {why}"));
            assert_eq!(
                cause == RunCause::Bot,
                by.is_some(),
                "a last run names its Bot exactly when a Bot ran it: {last}"
            );
            if by.is_some() {
                by_a_bot += 1;
            } else {
                by_nobody += 1;
            }
        }
    }
    assert!(
        by_a_bot > 0 && by_nobody > 0,
        "the recording holds a last run a Bot started ({by_a_bot}) and ones nobody's ({by_nobody})"
    );
}

fn schedule_run_started(_: u16, body: &Value) -> Check {
    let started: ScheduleRunStarted = parse(body)?;
    must!(
        started.run_id == str_at(body, "runId") && !started.run_id.is_empty(),
        "the run id should come through: {started:?}"
    );
    Ok(())
}

/// A create and an edit answer with the routine as it now is, which is what the editor draws
/// next.
fn one_routine(status: u16, body: &Value) -> Check {
    schedules(status, &Value::Array(vec![body.clone()]))
}

fn schedules(_: u16, body: &Value) -> Check {
    let listed: Vec<ScheduleRow> = parse(body)?;
    let raw = rows(body)?;
    same_len(&listed, raw)?;
    for (row, raw) in listed.iter().zip(raw) {
        let webhook = raw.get("webhook").filter(|webhook| !webhook.is_null());
        let kind = if str_at(raw, "kind") == "webhook" {
            ScheduleKind::Webhook
        } else {
            ScheduleKind::Cron
        };
        must!(
            row.id == str_at(raw, "id")
                && row.coworker_id == str_at(raw, "coworkerId")
                && row.kind == kind
                && row.cron.as_deref() == opt_str(raw, "cron")
                && row.prompt == str_at(raw, "prompt")
                && row.name.as_deref() == opt_str(raw, "name")
                && Some(row.active) == raw.get("active").and_then(Value::as_bool)
                && row.next_due_ms == raw.get("nextDueMs").and_then(Value::as_i64)
                && row.webhook.is_some() == webhook.is_some(),
            "a routine came through changed: {row:?}"
        );
        // The zone its line is read in (#316: `tz` on every row), which the editor names beside
        // its times where it is not this computer's.
        must!(
            row.tz.as_deref() == opt_str(raw, "tz"),
            "a routine's zone should come through as sent: {:?} from {raw}",
            row.tz
        );
        if let (Some(info), Some(raw)) = (&row.webhook, webhook) {
            must!(
                info.url == str_at(raw, "url")
                    && info.key == str_at(raw, "key")
                    && info.header == str_at(raw, "header"),
                "the webhook's url, key and header should come through: {info:?}"
            );
        }
    }
    Ok(())
}

/// A rotated key (`rotate_webhook_key`) answers with the routine's webhook, and that is all the
/// app takes from it: the trigger it redraws (`trigger_from_schedule` in `state.rs`) is the id,
/// the kind and the URL, key and header, so a row that names nothing else still replaces the
/// trigger whole and leaves the routine's prompt and clock where they were.
fn rotated_key(_: u16, body: &Value) -> Check {
    let row: ScheduleRow = parse(body)?;
    let hook = row
        .webhook
        .as_ref()
        .ok_or("a rotated key comes back on the webhook")?;
    let raw = &body["webhook"];
    must!(
        row.id == str_at(body, "id")
            && row.kind == ScheduleKind::Webhook
            && !hook.url.is_empty()
            && hook.url == str_at(raw, "url")
            && !hook.key.is_empty()
            && hook.key == str_at(raw, "key")
            && hook.header == str_at(raw, "header"),
        "the new key should come through on the webhook: {row:?}"
    );
    Ok(())
}

fn skill_matches(skill: &SkillSummary, raw: &Value) -> Check {
    must!(
        skill.id == str_at(raw, "id")
            && skill.name == str_at(raw, "name")
            && skill.description == str_at(raw, "description")
            && skill.source.word() == str_at(raw, "source")
            && Some(u64::from(skill.version_count))
                == raw.get("versionCount").and_then(Value::as_u64)
            && Some(skill.draft) == raw.get("draft").and_then(Value::as_bool)
            && Some(skill.enabled) == raw.get("enabled").and_then(Value::as_bool)
            && skill.approved_at_ms == raw.get("approvedAtMs").and_then(Value::as_i64),
        "a skill came through changed: {skill:?}"
    );
    Ok(())
}

fn skills(_: u16, body: &Value) -> Check {
    let listed: Vec<SkillSummary> = parse(body)?;
    let raw = rows(body)?;
    same_len(&listed, raw)?;
    listed
        .iter()
        .zip(raw)
        .try_for_each(|(skill, raw)| skill_matches(skill, raw))
}

fn skill_detail(_: u16, body: &Value) -> Check {
    let detail: SkillDetail = parse(body)?;
    skill_matches(&detail.skill, body)?;
    let files = body["files"].as_array().map_or(0, Vec::len);
    must!(
        detail.body == str_at(body, "body")
            && Some(u64::from(detail.version)) == body.get("version").and_then(Value::as_u64)
            && detail.files.len() == files,
        "the prose, its version and its files should come through: {detail:?}"
    );
    Ok(())
}

/// A new version of a skill (`add_skill_version`): its number, where its prose came from, and
/// its note.
fn skill_version(_: u16, body: &Value) -> Check {
    let version: SkillVersion = parse(body)?;
    must!(
        Some(u64::from(version.version)) == body.get("version").and_then(Value::as_u64)
            && version.kind.word() == str_at(body, "kind")
            && version.note == str_at(body, "note"),
        "the version came through changed: {version:?}"
    );
    Ok(())
}

fn account(_: u16, body: &Value) -> Check {
    let me: Account = parse(body)?;
    must!(
        me.id == str_at(body, "id")
            && me.email == str_at(body, "email")
            && me.first_name == str_at(body, "firstName")
            && me.last_name == str_at(body, "lastName")
            && me.org_id.as_deref() == opt_str(body, "orgId")
            && Some(me.verified) == body.get("verified").and_then(Value::as_bool)
            && Some(me.enabled) == body.get("enabled").and_then(Value::as_bool)
            && me.is_admin == body.get("isAdmin").and_then(Value::as_bool),
        "the account came through changed: {me:?}"
    );
    // The time zone, from a server that keeps one (opengrok-server #322, on main since c0bb6ae:
    // `account_json` in `crates/opengrok-server/src/account_api.rs`), on a read and on the answer
    // to `PUT /account`: read exactly when the key is sent, null as none set.
    let sent = body
        .get("timeZone")
        .map(|zone| zone.as_str().map(str::to_string));
    must!(
        me.time_zone == sent,
        "the time zone should be read exactly as it is sent: {:?} from {body}",
        me.time_zone
    );
    Ok(())
}

// ---- the tests ----

/// The manifest and the files agree: every file has an entry naming where it came from, and
/// every entry has its file.
#[test]
fn the_manifest_names_every_fixture_and_every_fixture_is_in_it() {
    let corpus = Corpus::load();
    let manifest = &corpus.manifest;
    assert!(
        manifest.server_sha.len() == 40
            && manifest.server_sha.chars().all(|c| c.is_ascii_hexdigit()),
        "server_sha should be the opengrok-server commit, not {:?}",
        manifest.server_sha
    );
    // The corpus is the server's own recording now. A copy made by hand would say what somebody
    // read in the server's code, which is the transcription these tests exist to check.
    assert_eq!(
        manifest.recorded_by, "opengrok-server recorder",
        "the corpus should be the server's own recording"
    );
    let files: BTreeSet<&str> = corpus
        .frames
        .keys()
        .chain(corpus.bodies.keys())
        .chain(corpus.relay.keys())
        .chain(corpus.events.keys())
        .map(String::as_str)
        .collect();
    let listed: BTreeSet<&str> = manifest
        .entries
        .iter()
        .map(|entry| entry.file.as_str())
        .collect();
    let unlisted: Vec<_> = files.difference(&listed).collect();
    let missing: Vec<_> = listed.difference(&files).collect();
    assert!(
        unlisted.is_empty() && missing.is_empty(),
        "files with no manifest entry: {unlisted:?}; entries with no file: {missing:?}"
    );
    let unsourced: Vec<_> = manifest
        .entries
        .iter()
        .filter(|entry| entry.source.trim().is_empty())
        .map(|entry| entry.file.as_str())
        .collect();
    assert!(
        unsourced.is_empty(),
        "every fixture names the server file it came from: {unsourced:?}"
    );
    assert!(
        corpus.root.join("MANIFEST.json").is_file(),
        "the manifest sits at the corpus root"
    );
    for (file, symptom, why) in KNOWN_DRIFT {
        assert!(
            files.contains(file) && !symptom.trim().is_empty() && !why.trim().is_empty(),
            "KNOWN_DRIFT names {file}, which is not in the corpus or says nothing about it"
        );
    }
}

/// #255's layout: a frame sits under its own `type`, a CUSTOM under its `name`, a frame off the
/// Mac relay's stream under its own `type` in `relay/`, a block off the account's events stream
/// under its own `event` in `events/`, kept whole as `{id, event, data}`, and a body under its
/// method and route with its status in the file name.
#[test]
fn every_fixture_sits_where_its_layout_says() {
    let corpus = Corpus::load();
    let mut problems = Vec::new();
    for (file, frame) in &corpus.frames {
        let kind = str_at(frame, "type");
        let expected = if kind == "CUSTOM" {
            format!("agui/custom/{}/", str_at(frame, "name"))
        } else {
            format!("agui/{kind}/")
        };
        if !file.starts_with(&expected) {
            problems.push(format!("{file} belongs under {expected}"));
        }
    }
    for (file, frame) in &corpus.relay {
        let expected = format!("relay/{}/", str_at(frame, "type"));
        if !file.starts_with(&expected) {
            problems.push(format!("{file} belongs under {expected}"));
        }
    }
    for (file, block) in &corpus.events {
        let expected = format!("events/{}/", str_at(block, "event"));
        if !file.starts_with(&expected)
            || str_at(block, "id").is_empty()
            || !block["data"].is_object()
        {
            problems.push(format!(
                "{file} is not {{id, event, data}} filed under {expected}"
            ));
        }
    }
    for (file, fixture) in &corpus.bodies {
        let method = str_at(fixture, "method");
        let status = fixture.get("status").and_then(Value::as_u64).unwrap_or(0);
        let mut parts = file.split('/').skip(1);
        let route = parts.next().unwrap_or("");
        let name = parts.next().unwrap_or("");
        if !route.starts_with(&format!("{method}_"))
            || !name.starts_with(&format!("{status}-"))
            || str_at(fixture, "path").is_empty()
            || fixture.get("body").is_none()
        {
            problems.push(format!(
                "{file} is not {{method, path, status, body}} filed as \
                 rest/{method}_<route>/{status}-<slug>.json"
            ));
        }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

/// The ledger's reading of a park agrees with the client's for the shapes no recording has yet:
/// escalated with a dismissal beside it, on the entry or split between the frame and the entry,
/// is an open form with the computer needing the person, and a dismissal alone settles it (#139).
#[test]
fn the_ledger_reads_a_park_settlement_as_the_client_does() {
    let park = |resolution: Value, entry: Value| {
        serde_json::json!({
            "type": "CUSTOM", "name": "run-awaiting-approval", "reason": "user-form",
            "tool": "request_user_form", "why": "Waiting for you",
            "runId": "run-1", "callId": "call-9", "entryId": "e_1",
            "arguments": {"title": "Google account",
                "fields": [{"id": "email", "label": "Email", "type": "email"}]},
            "formResolution": resolution,
            "value": entry,
        })
    };
    for frame in [
        park(
            Value::from("escalated"),
            serde_json::json!({"id": "e_1", "formResolution": "escalated", "widgetDismissed": true}),
        ),
        park(
            Value::from("escalated"),
            serde_json::json!({"id": "e_1", "widgetDismissed": true}),
        ),
        park(
            Value::Null,
            serde_json::json!({"id": "e_1", "widgetDismissed": true}),
        ),
        park(Value::Null, Value::Null),
        // Another spelling of the escalation, as the client's parse reads it.
        park(Value::from("Escalated"), serde_json::json!({"id": "e_1"})),
        // The hand-off ended (#143): stamped on the entry, and on the frame beside it.
        park(
            Value::from("escalated"),
            serde_json::json!({"id": "e_1", "formResolution": "escalated",
                "widgetDismissed": true, "boxResolution": "handed_back"}),
        ),
        park(
            Value::from("escalated"),
            serde_json::json!({"id": "e_1", "formResolution": "escalated",
                "boxResolution": "declined"}),
        ),
        // Another card's entry, matched by title and fields: it settles nothing here.
        park(
            Value::Null,
            serde_json::json!({"id": "e_0", "callId": "call-1", "formResolution": "submitted"}),
        ),
        park(
            Value::Null,
            serde_json::json!({"id": "e_0", "callId": "call-1", "widgetDismissed": true}),
        ),
    ] {
        awaiting(&frame).unwrap_or_else(|problem| panic!("{problem}: {frame}"));
    }
}

/// #143 against the server's own recordings: every recorded replay whose form frames carry how
/// the hand-off ended (handed back, declined, timed out; on the park alone for a form escalated
/// after its run stopped; read from the run's answer for one settled before the server stamped
/// forms) leaves nothing waiting on the person. A replay taken while the hand-off was still live
/// carries no word and is left to the other checks.
#[test]
fn a_replayed_hand_off_that_ended_leaves_nothing_waiting() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/wire/rest");
    let mut ended = BTreeSet::new();
    for route in ["GET__ag-ui_runs__run_id_", "GET__ag-ui_threads__thread_id_"] {
        let Ok(files) = std::fs::read_dir(root.join(route)) else {
            continue;
        };
        for file in files.flatten() {
            let text = std::fs::read_to_string(file.path()).expect("a recording");
            let fixture: Value = serde_json::from_str(&text).expect("a recording");
            let body = &fixture["body"];
            let runs: Vec<&Value> = match body.get("runs").and_then(Value::as_array) {
                Some(runs) => runs.iter().collect(),
                None => vec![body],
            };
            for run in runs {
                let events: Vec<&Value> = run["events"]
                    .as_array()
                    .map(|events| events.iter().collect())
                    .unwrap_or_default();
                let said = events.iter().any(|frame| {
                    [
                        frame.get("boxResolution"),
                        frame.pointer("/value/boxResolution"),
                    ]
                    .into_iter()
                    .flatten()
                    .any(|word| word.as_str().is_some_and(|word| !word.is_empty()))
                });
                if !said {
                    continue;
                }
                let assembler = assembled(&events);
                let (_, parts) = assembler.snapshot();
                let name = file.file_name().to_string_lossy().into_owned();
                assert!(
                    !assembler.waiting_user_form(),
                    "{route}/{name}: a hand-off that ended leaves nothing waiting: {parts:?}"
                );
                ended.insert(name);
            }
        }
    }
    // The recordings of opengrok-server #277: hand-back, declined, timed out, the park-only case
    // and the backfill (a form settled before the stamp, its end read from its run's answer).
    // Fewer means the corpus lost the case this test is about.
    assert!(
        ended.len() >= 5,
        "the recorded hand-offs that ended: {ended:?}"
    );
}

/// Every frame goes through the code that handles its type and name, and comes out the way this
/// app means to read it.
#[test]
fn every_frame_the_server_sends_is_read_as_intended() {
    let corpus = Corpus::load();
    let problems = verdicts(corpus.frames.iter(), |_, frame| check_frame(&corpus, frame));
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

/// Every frame off the Mac relay's stream goes through the relay's own reader, and comes out as
/// the frame it is, with what the relay goes on to use as the server sent it.
#[test]
fn every_relay_frame_the_server_sends_is_read_as_intended() {
    let corpus = Corpus::load();
    assert!(
        !corpus.relay.is_empty(),
        "the recording holds the relay's frames"
    );
    let problems = verdicts(corpus.relay.iter(), |_, frame| relay_frame(frame));
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

/// Every body is read the way this app reads its route: a success parses with the type the
/// client parses it with and the fields the app uses come through as the server sent them, and
/// a refusal reads as the server's own sentence, the way the client takes one. A route the app
/// never asks is excused in [`REST_NOT_READ`], and any other route with no reading fails.
#[test]
fn every_body_parses_with_the_type_this_app_reads_it_with() {
    let corpus = Corpus::load();
    let problems = verdicts(corpus.bodies.iter(), |file, fixture| {
        read_fixture(file.split('/').nth(1).unwrap_or(""), fixture)
    });
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

/// The REST ledger holds together: no route is read twice or both read and excused, every
/// excuse is for a route the corpus records, under the route the server's router writes, and
/// says why, and a route whose refusals are read its own way has a reading. An excuse for a
/// route nobody records any more, or for one the shipped source asks ([`source_asks`]), has
/// gone stale.
#[test]
fn every_route_this_app_does_not_read_is_recorded_and_says_why() {
    let corpus = Corpus::load();
    let recorded: BTreeSet<&str> = corpus
        .bodies
        .keys()
        .filter_map(|file| file.split('/').nth(1))
        .collect();
    let read = |route: &str| REST_ROUTES.iter().filter(|(dir, _)| *dir == route).count();
    let mut problems = Vec::new();
    for (route, _) in REST_ROUTES {
        if read(route) > 1 {
            problems.push(format!("{route} is in REST_ROUTES more than once"));
        }
    }
    for (route, pattern, why) in REST_NOT_READ {
        if !recorded.contains(route) {
            problems.push(format!(
                "REST_NOT_READ excuses {route}, which the corpus does not record"
            ));
        }
        if read(route) > 0 {
            problems.push(format!(
                "{route} is read and excused at once: take it off REST_NOT_READ"
            ));
        }
        if why.trim().is_empty() {
            problems.push(format!("REST_NOT_READ gives no reason for {route}"));
        }
        // The recorder files a route under its method and its pattern with `/`, `{` and `}` as
        // `_`, so the directory says whether the pattern is the server's.
        let method = route.split('_').next().unwrap_or("");
        let filed = format!("{method}_{}", pattern.replace(['/', '{', '}'], "_"));
        if filed != *route {
            problems.push(format!(
                "REST_NOT_READ names {route} as {method} {pattern}, which the recorder files as \
                 {filed}"
            ));
        }
        let asked = source_asks(method, pattern);
        if !asked.is_empty() {
            problems.push(format!(
                "the app now asks {method} {pattern} ({route}), in {}: give it a reading in \
                 REST_ROUTES and take it off REST_NOT_READ",
                asked.join("; ")
            ));
        }
    }
    // The scan sees what the client does ask, and tells one method from another: the computer's
    // egress policy is set with PUT and never read with GET.
    let pattern = "/coworkers/{coworker_id}/computer/egress-policy";
    if source_asks("PUT", pattern).is_empty() || !source_asks("GET", pattern).is_empty() {
        problems.push(format!(
            "the source scan is blind: it should find PUT {pattern} and not GET"
        ));
    }
    for (route, _) in REFUSALS {
        if read(route) == 0 {
            problems.push(format!(
                "REFUSALS reads the refusals of {route}, which has no reading in REST_ROUTES"
            ));
        }
    }
    // A 401 on a route asked with the machine token is read by the route's own refusal reading,
    // so each has one.
    for route in MACHINE_TOKEN_ROUTES {
        if read(route) == 0 || !REFUSALS.iter().any(|(dir, _)| dir == route) {
            problems.push(format!(
                "{route} is asked with the machine token, and needs a reading in REST_ROUTES and \
                 its refusals' own in REFUSALS"
            ));
        }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

/// The routes this app asks ahead of their recordings ([`REST_NOT_RECORDED_YET`]) are routes
/// the shipped source does ask, filed under the directory the recorder will file them in, each
/// saying what brings its fixtures, that the corpus does not hold yet. Once it holds one, the
/// entry has gone stale: the route gets a reading in [`REST_ROUTES`] and leaves the list.
#[test]
fn every_route_asked_ahead_of_its_recording_is_asked_and_not_recorded_yet() {
    let corpus = Corpus::load();
    let recorded: BTreeSet<&str> = corpus
        .bodies
        .keys()
        .filter_map(|file| file.split('/').nth(1))
        .collect();
    let mut problems = Vec::new();
    for (route, pattern, why) in REST_NOT_RECORDED_YET {
        if recorded.contains(route) {
            problems.push(format!(
                "the corpus records {route} now: give it a reading in REST_ROUTES and take it off \
                 REST_NOT_RECORDED_YET"
            ));
        }
        if REST_ROUTES.iter().any(|(dir, _)| dir == route)
            || REST_NOT_READ.iter().any(|(dir, _, _)| dir == route)
        {
            problems.push(format!(
                "{route} is owed a reading and is in REST_ROUTES or REST_NOT_READ as well"
            ));
        }
        if why.trim().is_empty() {
            problems.push(format!(
                "REST_NOT_RECORDED_YET does not say what brings {route}'s fixtures"
            ));
        }
        let method = route.split('_').next().unwrap_or("");
        let filed = format!("{method}_{}", pattern.replace(['/', '{', '}'], "_"));
        if filed != *route {
            problems.push(format!(
                "REST_NOT_RECORDED_YET names {route} as {method} {pattern}, which the recorder \
                 files as {filed}"
            ));
        }
        if source_asks(method, pattern).is_empty() {
            problems.push(format!(
                "nothing asks {method} {pattern} any more: take {route} off REST_NOT_RECORDED_YET"
            ));
        }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

/// The keys this app reads ahead of their recordings on recorded routes
/// ([`REST_FIELDS_NOT_RECORDED_YET`]) are on routes the corpus records and this app reads, each
/// saying what brings it, and no recorded body of the route carries the key yet. Once one does,
/// the entry has gone stale: the reading already waiting for it reads the recording, and the
/// entry leaves the list.
#[test]
fn every_key_asked_ahead_of_its_recording_is_read_and_not_recorded_yet() {
    let corpus = Corpus::load();
    let mut problems = Vec::new();
    for (route, key, why) in REST_FIELDS_NOT_RECORDED_YET {
        let fixtures: Vec<&Value> = corpus
            .bodies
            .iter()
            .filter(|(file, _)| file.split('/').nth(1) == Some(*route))
            .map(|(_, fixture)| fixture)
            .collect();
        if fixtures.is_empty() {
            problems.push(format!(
                "the corpus does not record {route} at all: it is owed a reading in \
                 REST_NOT_RECORDED_YET, not a key in REST_FIELDS_NOT_RECORDED_YET"
            ));
        }
        if !REST_ROUTES.iter().any(|(dir, _)| dir == route) {
            problems.push(format!(
                "{route} has no reading in REST_ROUTES to read its {key:?} with"
            ));
        }
        if why.trim().is_empty() {
            problems.push(format!(
                "REST_FIELDS_NOT_RECORDED_YET does not say what brings {route}'s {key:?}"
            ));
        }
        // A key of one of `GET /models`' entries is under `models`, in the list's own object.
        let carried = fixtures.iter().any(|fixture| match &fixture["body"] {
            Value::Array(rows) => rows.iter().any(|row| row.get(*key).is_some()),
            body => {
                body.get(*key).is_some()
                    || body
                        .get("models")
                        .and_then(Value::as_array)
                        .is_some_and(|rows| rows.iter().any(|row| row.get(*key).is_some()))
            }
        });
        if carried {
            problems.push(format!(
                "the corpus records {key:?} on {route} now: take it off \
                 REST_FIELDS_NOT_RECORDED_YET"
            ));
        }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

/// The answers the server recorded for `route` (its directory under `rest/`), in file order.
fn recorded<'a>(corpus: &'a Corpus, route: &str) -> impl Iterator<Item = &'a Value> + use<'a> {
    let route = route.to_string();
    corpus
        .bodies
        .iter()
        .filter(move |(file, _)| file.split('/').nth(1) == Some(route.as_str()))
        .map(|(_, fixture)| fixture)
}

/// A computer's relay switch as the server recorded it (opengrok-server #342 (main 2136ffc):
/// `row` and `switch_relay` in `crates/opengrok-server/src/local_exec.rs`): every row of the list
/// and of the switch's answer carries `relayEnabled` and `relaying` as booleans, with a computer on
/// and relaying, on and not relaying, and off; the switch's answer is the row it left, off and
/// not relaying, as the server closes the stream it switches off; its three refusals come with the
/// code beside the server's sentence, which the client keeps apart; and a stream refused while the
/// computer's relay is off is the 409 `relay_disabled` in the server's words (`RELAY_IS_OFF` in
/// `crates/opengrok-wire/src/relay.rs`), which the relay stops for, after the one frame the server
/// sends the open stream before it closes it, `disabled`.
#[test]
fn a_computers_relay_switch_is_read_as_the_server_recorded_it() {
    let corpus = Corpus::load();
    let rows = |route: &str| -> Vec<&Value> {
        recorded(&corpus, route)
            .filter(|fixture| fixture["status"] == 200)
            .flat_map(|fixture| match fixture["body"].get("machines") {
                Some(machines) => machines.as_array().expect("machines").iter().collect(),
                None => vec![&fixture["body"]],
            })
            .collect()
    };
    let listed = rows("GET__local-exec_daemon");
    let switched = rows("PATCH__local-exec_daemon__machine_id_");
    assert!(
        !listed.is_empty() && !switched.is_empty(),
        "the recording holds the list and the switch's answer"
    );
    for row in listed.iter().chain(&switched) {
        assert!(
            row["relayEnabled"].is_boolean() && row["relaying"].is_boolean(),
            "every row the server records carries both keys, as booleans: {row}"
        );
    }
    let states: BTreeSet<(bool, bool)> = listed
        .iter()
        .map(|row| {
            (
                row["relayEnabled"].as_bool().unwrap_or_default(),
                row["relaying"].as_bool().unwrap_or_default(),
            )
        })
        .collect();
    for state in [(true, true), (true, false), (false, false)] {
        assert!(
            states.contains(&state),
            "the recording holds a computer with its relay on: {}, and relaying: {}",
            state.0,
            state.1
        );
    }
    for row in &switched {
        let machine: DaemonMachine = serde_json::from_value((*row).clone()).expect("a row");
        assert_eq!(
            (machine.relay_enabled, machine.relaying),
            (false, false),
            "a switch the server answers is the row it left, off and not relaying: {row}"
        );
    }

    let mut refused: BTreeMap<u16, (String, String)> = BTreeMap::new();
    for fixture in recorded(&corpus, "PATCH__local-exec_daemon__machine_id_") {
        let status = fixture["status"]
            .as_u64()
            .and_then(|s| u16::try_from(s).ok());
        let status = status.expect("a status");
        if status == 200 {
            continue;
        }
        let body = &fixture["body"];
        let error = OpenGrokClient::refusal(status, &body.to_string());
        assert_eq!(
            (error.status, error.message.as_str(), error.code()),
            (
                Some(status),
                str_at(body, "error"),
                Some(str_at(body, "code"))
            ),
            "a refused switch reads as the server's sentence beside its code"
        );
        refused.insert(
            status,
            (
                str_at(body, "error").to_string(),
                str_at(body, "code").to_string(),
            ),
        );
    }
    let said = |status: u16, sentence: &str, code: &str| {
        (status, (sentence.to_string(), code.to_string()))
    };
    assert_eq!(
        refused,
        BTreeMap::from([
            said(400, "relayEnabled must be true or false", "bad_request"),
            said(404, "no computer of yours has that id", "not_found"),
            said(
                409,
                "this computer was revoked; enrol it again to use it",
                "revoked"
            ),
        ]),
        "the refusals the recording holds"
    );

    let off: Vec<&Value> = recorded(&corpus, "GET__inference-relay_requests")
        .filter(|fixture| fixture["status"] == 409)
        .collect();
    assert!(
        !off.is_empty(),
        "the recording holds the stream refused while off"
    );
    for fixture in off {
        let body = &fixture["body"];
        assert_eq!(
            (str_at(body, "error"), str_at(body, "code")),
            (
                "Relay is off for this computer. Turn it on in Settings → Computer.",
                "relay_disabled"
            )
        );
        assert!(
            relay_disabled(&OpenGrokClient::refusal(409, &body.to_string())),
            "the relay stops for it and waits for its row"
        );
    }
    let frames: Vec<&Value> = corpus
        .relay
        .iter()
        .filter(|(file, _)| file.starts_with("relay/disabled/"))
        .map(|(_, frame)| frame)
        .collect();
    assert!(
        !frames.is_empty(),
        "the recording holds the frame `disabled`"
    );
    for frame in frames {
        assert_eq!(*frame, serde_json::json!({"type": "disabled"}));
        assert_eq!(RelayFrame::from_value(frame), RelayFrame::Disabled);
    }
}

/// A computer's relay switch, read from bodies beyond the ones the recording holds: a row from a
/// server before the switch, which sends neither key and reads as on and not relaying, a key that
/// is not true or false refused, an answer whose switch is not one, and the two 409s and the 400
/// that are not the relay's own word.
#[test]
fn a_computers_relay_switch_is_read_beyond_the_recording() {
    use serde_json::json;
    let row = |id: &str, on: bool, relaying: bool| {
        json!({"machineId": id, "label": "Ada's MacBook", "enrolledAtMs": 1_790_000_000_000_i64,
               "revoked": false, "connected": true, "relayEnabled": on, "relaying": relaying})
    };
    let listed = |machines: Value| {
        read_fixture(
            "GET__local-exec_daemon",
            &json!({"method": "GET", "path": "/local-exec/daemon", "status": 200,
                    "body": {"machines": machines}}),
        )
    };
    let before_the_switch = json!({"machineId": "mac_3", "label": "Old", "enrolledAtMs": 1,
                                   "revoked": false, "connected": false});
    listed(json!([
        row("mac_1", true, true),
        row("mac_2", false, false),
        before_the_switch.clone()
    ]))
    .unwrap();
    let old: DaemonMachine = serde_json::from_value(before_the_switch).expect("a row");
    assert_eq!(
        (old.relay_enabled, old.relaying),
        (true, false),
        "a computer enrolled before the switch is on, and not relaying"
    );
    let mut not_a_switch = row("mac_1", true, false);
    not_a_switch["relayEnabled"] = json!("on");
    assert!(
        listed(json!([not_a_switch])).is_err(),
        "a switch that is not true or false is not read as one"
    );
    let not_a_switch_either = json!({"machineId": "mac_1", "label": "x", "revoked": false,
                                     "connected": true, "relayEnabled": "no"});
    assert!(
        daemon_switched(200, &not_a_switch_either).is_err(),
        "an answer whose switch is not true or false is caught"
    );

    // No other 409 is the word the relay waits on its row for, and the word is a 409's alone.
    let other = json!({"error": "somebody else's conflict", "code": "something_else"});
    relay_stream_refused(409, &other).unwrap();
    assert!(!relay_disabled(&OpenGrokClient::refusal(
        409,
        &other.to_string()
    )));
    assert!(
        !relay_disabled(&OpenGrokClient::refusal(
            400,
            &json!({"error": "no", "code": "relay_disabled"}).to_string()
        )),
        "the word is a 409's"
    );
}

/// [`RELAY_FRAME_TYPES`] is exactly the set of frame types `RelayFrame::from_value` matches on,
/// found by reading the relay's source for the arms of its one match over a frame's `type`
/// (`(Some("<type>"), …)`). A type matched there and missing here, or listed here and matched
/// nowhere, fails until the ledger says the same.
#[test]
fn the_ledger_relay_types_are_read_by_the_relay() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/opengrok/relay.rs");
    let source = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    let read: BTreeSet<&str> = shipped_lines(&source)
        .into_iter()
        .filter_map(|line| line.trim_start().strip_prefix("(Some(\""))
        .filter_map(|rest| rest.split('"').next())
        .collect();
    let listed: BTreeSet<&str> = RELAY_FRAME_TYPES.iter().copied().collect();
    assert_eq!(
        read, listed,
        "the types the relay reads, and the types the ledger lists"
    );
}

/// Every type and name the server sends has a fixture, or the manifest lists it as unrecorded:
/// no test exercises it yet.
#[test]
fn every_type_and_name_the_server_sends_has_a_fixture() {
    let corpus = Corpus::load();
    let emits = &corpus.manifest.emits;
    let mut missing = Vec::new();
    for kind in &emits.agui_types {
        if corpus.frames_of(kind).next().is_none() && !corpus.manifest.unrecorded.contains(kind) {
            missing.push(kind.as_str());
        }
    }
    for name in &emits.custom_names {
        if corpus.customs_named(name).next().is_none() && !corpus.manifest.unrecorded.contains(name)
        {
            missing.push(name.as_str());
        }
    }
    // Every note of the account's events stream, under the directory its block is filed in.
    for name in &emits.account_events {
        let filed = format!("events/{name}/");
        if !corpus.events.keys().any(|file| file.starts_with(&filed))
            && !corpus.manifest.unrecorded.contains(name)
        {
            missing.push(name.as_str());
        }
    }
    // The words inside frames and bodies too: every approval reason, and every formResolution,
    // appears in some fixture. `dismissed` is also what an unknown word parses as, so only a
    // fixture carrying it can show it is read rather than defaulted.
    let mut carried = BTreeSet::new();
    for value in corpus.every_value() {
        collect_words(value, &mut carried);
    }
    for (slot, key) in [
        (Slot::ApprovalReason, "reason"),
        (Slot::FormResolution, "formResolution"),
    ] {
        for word in emits.words(slot) {
            let seen = carried.contains(&(key.to_string(), word.clone()));
            if !seen && !corpus.manifest.unrecorded.contains(word) {
                missing.push(word.as_str());
            }
        }
    }
    assert!(missing.is_empty(), "sent, with no fixture: {missing:?}");
}

/// Every `(key, string value)` pair anywhere in `value`.
fn collect_words(value: &Value, out: &mut BTreeSet<(String, String)>) {
    match value {
        Value::Object(map) => {
            for (key, inner) in map {
                if let Value::String(text) = inner {
                    out.insert((key.clone(), text.clone()));
                }
                collect_words(inner, out);
            }
        }
        Value::Array(items) => items.iter().for_each(|item| collect_words(item, out)),
        _ => {}
    }
}

/// Every word this app matches on is one the server sends, or is excused with the evidence that
/// it does not. A word in both places is an excuse that has gone stale.
#[test]
fn every_word_this_app_matches_is_sent_or_excused() {
    let corpus = Corpus::load();
    let emits = &corpus.manifest.emits;
    let ledger = ledger();
    let mut problems = Vec::new();
    for (slot, word) in &ledger {
        let sent = emits.words(*slot).iter().any(|sent| sent.as_str() == *word);
        let excused = is_excused(NOT_SENT_BY_SERVER, *slot, word);
        let ahead = is_excused(WORDS_NOT_RECORDED_YET, *slot, word);
        if sent && excused {
            problems.push(format!(
                "{} {word:?} is sent now: take it off NOT_SENT_BY_SERVER",
                slot.field()
            ));
        } else if sent && ahead {
            problems.push(format!(
                "{} {word:?} is recorded now: take it off WORDS_NOT_RECORDED_YET",
                slot.field()
            ));
        } else if !sent && !excused && !ahead {
            problems.push(format!(
                "{} {word:?} is matched here and the server does not send it: find out why, and \
                 say so in NOT_SENT_BY_SERVER",
                slot.field()
            ));
        }
    }
    let matched: BTreeSet<&str> = ledger.iter().map(|(_, word)| *word).collect();
    for (_, word, why) in NOT_SENT_BY_SERVER {
        if !matched.contains(word) {
            problems.push(format!(
                "NOT_SENT_BY_SERVER excuses {word:?}, which nothing here matches"
            ));
        }
        if why.trim().is_empty() {
            problems.push(format!("NOT_SENT_BY_SERVER gives no evidence for {word:?}"));
        }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

/// Every word the server sends is one this app matches, or is excused with what happens to it
/// instead, so a new name from the server fails here first.
#[test]
fn every_word_the_server_sends_is_matched_or_excused() {
    let corpus = Corpus::load();
    let emits = &corpus.manifest.emits;
    let ledger = ledger();
    let mut problems = Vec::new();
    for slot in Slot::ALL {
        for word in emits.words(slot) {
            let matched = ledger
                .iter()
                .any(|(matched_slot, matched)| *matched_slot == slot && *matched == word.as_str());
            let ignored = is_excused(CLIENT_IGNORES, slot, word);
            if matched && ignored {
                problems.push(format!(
                    "{} {word:?} is matched now: take it off CLIENT_IGNORES",
                    slot.field()
                ));
            } else if !matched && !ignored {
                problems.push(format!(
                    "the server sends the {} {word:?} and nothing here reads it: read it, or \
                     say in CLIENT_IGNORES why it can be left",
                    slot.field()
                ));
            }
        }
    }
    let sent: BTreeSet<&str> = Slot::ALL
        .iter()
        .flat_map(|slot| emits.words(*slot).iter().map(String::as_str))
        .collect();
    for (_, word, why) in CLIENT_IGNORES {
        if !sent.contains(word) {
            problems.push(format!(
                "CLIENT_IGNORES lists {word:?}, which the server does not send"
            ));
        }
        if why.trim().is_empty() {
            problems.push(format!("CLIENT_IGNORES gives no reason for {word:?}"));
        }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

/// The part of a source file that ships: everything before its `#[cfg(test)] mod`.
fn shipped_lines(source: &str) -> Vec<&str> {
    let lines: Vec<&str> = source.lines().collect();
    let mut kept = Vec::new();
    for (at, line) in lines.iter().enumerate() {
        if *line == "#[cfg(test)]" {
            let next = lines[at + 1..]
                .iter()
                .find(|line| !line.starts_with("#["))
                .copied()
                .unwrap_or("");
            if next.starts_with("mod ") {
                break;
            }
        }
        if !line.trim_start().starts_with("//") {
            kept.push(*line);
        }
    }
    kept
}

/// `text` with every `{…}` placeholder as `{}`, so the server's `{coworker_id}` and a format
/// string's `{}` or `{id}` read alike.
fn placeholders_folded(text: &str) -> String {
    let mut folded = String::with_capacity(text.len());
    let mut inside = false;
    for c in text.chars() {
        match c {
            '{' if !inside => {
                folded.push_str("{}");
                inside = true;
            }
            '}' if inside => inside = false,
            _ if inside => {}
            c => folded.push(c),
        }
    }
    folded
}

/// Where the shipped source asks `method` `route` (the server's pattern, an id as `{…}`), as
/// `file: the first line of the function`. A function asks it when it writes the path as a whole
/// string literal, alone or before a query, and names that method, or names none because it
/// hands the path to a helper that does. Every source is read, not only `client.rs`, since a
/// path can be a constant kept beside the code that uses it (`user_form.rs` keeps the form's).
fn source_asks(method: &str, route: &str) -> Vec<String> {
    const METHODS: [&str; 5] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
    let route = placeholders_folded(route);
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_sources(&src, &mut files);
    let this_file = Path::new("opengrok").join("conformance.rs");
    let mut asked = Vec::new();
    for file in files.iter().filter(|file| !file.ends_with(&this_file)) {
        let source = std::fs::read_to_string(file)
            .unwrap_or_else(|error| panic!("read {}: {error}", file.display()));
        let mut functions: Vec<Vec<&str>> = Vec::new();
        for line in shipped_lines(&source) {
            let head = line.trim_start();
            let opens = head.starts_with("fn ")
                || head.starts_with("async fn ")
                || (head.starts_with("pub") && head.contains(" fn "));
            if opens || functions.is_empty() {
                functions.push(Vec::new());
            }
            if let Some(function) = functions.last_mut() {
                function.push(line);
            }
        }
        for function in functions {
            // The pieces between quotes are a line's string literals, for any line whose quotes
            // are all its strings' own.
            let writes_path = function.iter().any(|line| {
                line.split('"').skip(1).step_by(2).any(|literal| {
                    let literal = placeholders_folded(literal);
                    literal == route || literal.starts_with(&format!("{route}?"))
                })
            });
            let named: Vec<&str> = METHODS
                .into_iter()
                .filter(|named| {
                    function.iter().any(|line| {
                        line.contains(&format!("Method::{named}"))
                            || line.contains(&format!("http.{}(", named.to_ascii_lowercase()))
                    })
                })
                .collect();
            if writes_path && (named.is_empty() || named.contains(&method)) {
                let at = file.strip_prefix(&src).unwrap_or(file);
                asked.push(format!("{}: {}", at.display(), function[0].trim()));
            }
        }
    }
    asked
}

fn rust_sources(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries =
        std::fs::read_dir(dir).unwrap_or_else(|error| panic!("read {}: {error}", dir.display()));
    for entry in entries {
        let path = entry.expect("a directory entry").path();
        if path.is_dir() {
            rust_sources(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

/// [`AGUI_TYPES`] is exactly the set of AG-UI types the shipped source matches on, found by
/// reading every source file for the protocol's type names. A new match arm, or one taken away,
/// fails here until the ledger says the same.
#[test]
fn the_ledger_types_are_the_types_the_source_matches() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_sources(&src, &mut files);
    let this_file = Path::new("opengrok").join("conformance.rs");
    let mut found = BTreeSet::new();
    for file in files.iter().filter(|file| !file.ends_with(&this_file)) {
        let source = std::fs::read_to_string(file)
            .unwrap_or_else(|error| panic!("read {}: {error}", file.display()));
        for line in shipped_lines(&source) {
            for kind in AGUI_SPEC_TYPES {
                if line.contains(&format!("\"{kind}\"")) {
                    found.insert(*kind);
                }
            }
        }
    }
    let listed: BTreeSet<&str> = AGUI_TYPES.iter().copied().collect();
    let unlisted: Vec<_> = found.difference(&listed).collect();
    let unmatched: Vec<_> = listed.difference(&found).collect();
    assert!(
        unlisted.is_empty() && unmatched.is_empty(),
        "matched in the source and missing from AGUI_TYPES: {unlisted:?}; in AGUI_TYPES and \
         matched nowhere: {unmatched:?}"
    );
}

/// The rule a step's arguments are held to, fed calls the corpus does not record yet: each
/// withheld argument of the server's own tools and of a plugin's, run through the assembler as
/// the stream brings them, passes as the card's rules state it; and each way a step could keep
/// too much fails.
#[test]
fn a_steps_arguments_are_held_to_the_cards_rules_as_stated() {
    use serde_json::json;
    let long = "a sentence typed into a page that runs well past the sixty characters a card shows";
    let calls = [
        ("computer", json!({"action": "type", "text": "hello"})),
        ("computer", json!({"action": "type", "text": long})),
        (
            "computer",
            json!({"action": "key", "key": "sk-live-0123456789"}),
        ),
        (
            "write_file",
            json!({"path": "notes/todo.md", "content": "milk, eggs"}),
        ),
        (
            "open_url",
            json!({"url": "https://example.com/inbox?token=abc#top"}),
        ),
        (
            "run_recipe",
            json!({"recipe": "Log in", "values": {"password": "hunter2"}}),
        ),
        (
            "gmail_api_send",
            json!({
                "to": "ada@example.com",
                "accountId": "acct_1",
                "api_key": "k",
                "auth": {"token": "t", "coworkerId": "cw_1", "note": "kept"},
                "signature": "Bearer abc",
            }),
        ),
    ];
    for (tool, sent) in &calls {
        let start = json!({"type": "TOOL_CALL_START", "toolCallId": "c1", "toolCallName": tool});
        let args = json!({"type": "TOOL_CALL_ARGS", "toolCallId": "c1", "delta": sent.to_string()});
        let end = json!({"type": "TOOL_CALL_END", "toolCallId": "c1"});
        let (_, parts) = assembled(&[&start, &args, &end]).snapshot();
        let Some(ChatPart::Step(step)) = parts.first() else {
            panic!("a {tool} call is a step: {parts:?}");
        };
        let kept: Value =
            serde_json::from_str(&step.arguments).expect("a step's arguments read back");
        kept_as_the_card_allows(tool, sent, &kept)
            .unwrap_or_else(|why| panic!("{tool} {sent} kept as {kept}: {why}"));
    }
    let leaks = [
        (
            "write_file",
            json!({"content": "milk"}),
            json!({"content": "milk"}),
        ),
        ("computer", json!({"text": long}), json!({"text": long})),
        (
            "open_url",
            json!({"url": "https://example.com/?token=abc"}),
            json!({"url": "https://example.com/?token=abc"}),
        ),
        (
            "run_recipe",
            json!({"values": {"q": "x"}}),
            json!({"values": {"q": "x"}}),
        ),
        (
            "gmail_api_send",
            json!({"api_key": "k"}),
            json!({"api_key": "k"}),
        ),
        (
            "gmail_api_send",
            json!({"boxId": "bx_1"}),
            json!({"boxId": "bx_1"}),
        ),
        ("read_file", json!({"path": "a"}), json!({"path": "b"})),
        (
            "read_file",
            json!({"path": "a"}),
            json!({"path": "a", "extra": 1}),
        ),
    ];
    for (tool, sent, kept) in &leaks {
        assert!(
            kept_as_the_card_allows(tool, sent, kept).is_err(),
            "{tool} {sent} kept as {kept} should fail"
        );
    }
}

/// The wake editor's Cron tab refuses a line under the one-minute floor in the server's own
/// words (`cron_spec::UNDER_A_MINUTE`), held here to the server's recording of the same refusal
/// on a create and on an edit (#316: `FLOOR` in autonomy/desk.rs), so the two cannot drift.
#[test]
fn the_floor_is_said_in_the_servers_words() {
    let corpus = Corpus::load();
    let said: Vec<(&String, &str)> = corpus
        .bodies
        .iter()
        .filter(|(file, fixture)| {
            (file.starts_with("rest/POST__schedules/")
                || file.starts_with("rest/PATCH__schedules__id_/"))
                && fixture["status"] == 422
        })
        .filter_map(|(file, fixture)| Some((file, fixture["body"]["error"].as_str()?)))
        .filter(|(_, error)| error.contains("once a minute"))
        .collect();
    assert!(
        said.iter().any(|(file, _)| file.starts_with("rest/POST__"))
            && said
                .iter()
                .any(|(file, _)| file.starts_with("rest/PATCH__")),
        "the recording holds the floor's refusal of a create and of an edit: {said:?}"
    );
    for (file, error) in said {
        assert_eq!(error, crate::cron_spec::UNDER_A_MINUTE, "{file}");
    }
}

/// The readings of a refusal hold for the shapes opengrok-server's error-bodies change (#262)
/// writes, beyond the ones this recording happens to hold (`run-exists` under `code`, a 502 or a
/// 503 of the server's own as JSON), and for the shapes it still writes and may move to: the
/// queue's codes under `error` (as it sends them) or under `code`, and a form's refusal with its
/// code under `error` beside a `message` (as `agui/user_form.rs` sends it) or under `code`. A plain-text 502, and `run-exists` under `error`, the
/// shapes that change retired, still fail, so a recording that brings one back is caught rather
/// than read.
#[test]
fn a_refusal_reads_in_the_shape_the_server_sends_and_not_in_the_ones_it_retired() {
    use serde_json::json;
    let read = |route: &str, path: &str, status: u16, body: Value| {
        read_fixture(
            route,
            &json!({ "method": "POST", "path": path, "status": status, "body": body }),
        )
    };
    let said = "this run id already has a run; a new turn needs a new run id";
    read(
        "POST__ag-ui",
        "/ag-ui",
        409,
        json!({ "error": said, "code": "run-exists" }),
    )
    .unwrap();
    let old = read(
        "POST__ag-ui",
        "/ag-ui",
        409,
        json!({ "error": "run-exists", "message": said }),
    );
    assert!(
        old.as_ref().is_err_and(|why| why.contains(CODE_UNDER_CODE)),
        "run-exists under error is the shape the server retired for it: {old:?}"
    );
    let stale = "This queued message changed. Refresh it before sending again.";
    let event = json!({
        "type": "CUSTOM",
        "name": "pending-user-message",
        "value": { "v": 1, "op": "edited", "threadId": "th_1" },
    });
    for body in [
        json!({ "v": 1, "error": "stale-pending-message", "message": stale, "event": event.clone() }),
        json!({ "v": 1, "error": stale, "code": "stale-pending-message", "event": event }),
    ] {
        read("POST__ag-ui", "/ag-ui", 409, body.clone())
            .unwrap_or_else(|why| panic!("{body}: {why}"));
    }
    let shared = "This computer is shared with other bots or people.";
    for body in [
        json!({ "error": "shared-computer", "message": shared }),
        json!({ "error": shared, "code": "shared-computer" }),
    ] {
        read(
            "POST__ag-ui_user-form_submit",
            "/ag-ui/user-form/submit",
            403,
            body.clone(),
        )
        .unwrap_or_else(|why| panic!("{body}: {why}"));
    }
    let down = "the box is unreachable: the stand-in box is down";
    read(
        "POST__recipes__id__run",
        "/recipes/rcp_1/run",
        502,
        json!({ "error": down }),
    )
    .unwrap();
    read(
        "POST__recipes",
        "/recipes",
        503,
        json!({ "error": "the recipe was not kept: its raw version could not be stored" }),
    )
    .unwrap();
    read(
        "POST__skills_from-tape",
        "/skills/from-tape",
        502,
        json!({ "error": "the model wrote more than a skill can hold" }),
    )
    .unwrap();
    let retired = read(
        "POST__recipes__id__run",
        "/recipes/rcp_1/run",
        502,
        Value::String(down.into()),
    );
    assert!(
        retired
            .as_ref()
            .is_err_and(|why| why.contains(FIVE_HUNDRED_SHAPE)),
        "a plain-text 502 is the shape the server retired: {retired:?}"
    );
}

/// The tools listing's reading, fed the two bodies the server recorded
/// (`GET__coworkers__coworker_id__tools/200-…` trimmed, `404-…` whole) and the ways a body could
/// go wrong: the list comes through, the refusal is not read as one, and a body with no list or
/// a tool that drops its kind is caught.
#[test]
fn a_bots_tool_listing_has_a_reading_in_the_ledger() {
    let read = |status: u16, body: Value| {
        read_fixture(
            "GET__coworkers__coworker_id__tools",
            &serde_json::json!({
                "method": "GET", "path": "/coworkers/cw_1/tools", "status": status, "body": body
            }),
        )
    };
    let listed = serde_json::json!({"tools": [
        {"name": "shell", "description": "Run a shell command.", "kind": "builtin"},
        {"name": "gmail_api_send", "description": "", "kind": "plugin"}
    ]});
    read(200, listed.clone()).unwrap();
    read(404, Value::String("no such coworker".into())).unwrap();
    assert!(read(404, listed).is_err(), "a refusal carrying tools");
    assert!(read(200, serde_json::json!({})).is_err(), "no tools array");
    assert!(
        read(
            200,
            serde_json::json!({"tools": [{"name": "shell", "description": "Run a shell command."}]})
        )
        .is_err(),
        "a tool that drops its kind"
    );
}

/// The ceiling's reading, fed bodies in the shape agreed for opengrok-server#268 until the
/// server's own are recorded, for the read and for the write's answer alike: builtins and a
/// plugin, `user_machine_shell` unavailable and a plugin the server no longer loads with nothing
/// but its name, at a version and at none, an empty ceiling, the refusals (not the owner's, a
/// name it does not list, a version it has moved on from, no grant to change), and the ways a
/// body could go wrong.
#[test]
fn a_bots_ceiling_has_a_reading_in_the_ledger() {
    use serde_json::json;
    for (route, verb) in [
        ("GET__coworkers__coworker_id__ceiling", "GET"),
        ("PUT__coworkers__coworker_id__ceiling", "PUT"),
    ] {
        let read = |status: u16, body: Value| {
            read_fixture(
                route,
                &json!({
                    "method": verb, "path": "/coworkers/cw_1/ceiling", "status": status, "body": body
                }),
            )
        };
        let ceiling = json!({"tools": [
            {"name": "shell", "kind": "builtin", "enabled": true, "description": "Run a shell command."},
            {"name": "user_machine_shell", "kind": "builtin", "enabled": false, "available": false},
            {
                "name": "gmail", "kind": "plugin", "enabled": true, "label": "Gmail",
                "description": "Read and send mail.", "connector": "gmail"
            },
            {"name": "old_crm", "kind": "plugin", "enabled": true, "available": false}
        ], "version": 7});
        read(200, ceiling.clone()).unwrap_or_else(|why| panic!("{verb}: {why}"));
        read(200, json!({"tools": []})).unwrap_or_else(|why| panic!("{verb}: {why}"));
        read(200, json!({"tools": [], "version": 0})).unwrap_or_else(|why| panic!("{verb}: {why}"));
        read(404, json!({"error": "no such coworker"}))
            .unwrap_or_else(|why| panic!("{verb}: {why}"));
        read(422, json!({"error": "no tool or plugin named nope"}))
            .unwrap_or_else(|why| panic!("{verb}: {why}"));
        read(
            409,
            json!({"error": "the tools changed since you looked", "code": "ceiling-changed"}),
        )
        .unwrap_or_else(|why| panic!("{verb}: {why}"));
        read(403, json!({"error": "no grant to change"}))
            .unwrap_or_else(|why| panic!("{verb}: {why}"));
        assert!(
            read(404, ceiling).is_err(),
            "{verb}: a refusal carrying a ceiling"
        );
        assert!(read(200, json!({})).is_err(), "{verb}: no tools array");
        assert!(
            read(
                200,
                json!({"tools": [{"name": "shell", "kind": "builtin"}]})
            )
            .is_err(),
            "{verb}: a row that does not say whether it is enabled"
        );
        assert!(
            read(200, json!({"tools": [{"name": "shell", "enabled": true}]})).is_err(),
            "{verb}: a row that drops its kind"
        );
    }
}

/// A coworker row's `effort` (opengrok-server#271) has a reading in the ledger beyond what the
/// recording carries. A row without it is a server from before it and reads as inherit; a row with
/// it comes through as sent, a word this app has not heard of included; an effort that is not a
/// word is caught; and the patch route's two refusals of an effort read as the server's
/// sentences. The recorded 400 for a word the server does not know names every word a Bot takes,
/// `ultra` the last of them (opengrok-server #342 (main 2136ffc): `Effort::ALL` and its refusal in
/// `crates/opengrok-core/src/coworker.rs`, the sentence `against_a_coworkers_effort.rs` holds),
/// and the app shows that sentence as the server wrote it.
#[test]
fn a_coworker_rows_effort_has_a_reading_in_the_ledger() {
    let read = |route: &str, status: u16, body: Value| {
        read_fixture(
            route,
            &serde_json::json!({
                "method": "PATCH", "path": "/coworkers/cw_1", "status": status, "body": body
            }),
        )
    };
    let row = |effort: Option<&str>| {
        let mut row = serde_json::json!({
            "id": "cw_1", "name": "Bob", "model": "oag/cheap", "role": null, "title": null,
            "avatarShape": null, "avatarColor": null, "visibility": "private",
            "hiddenFromSidebar": false, "updatedAtMs": 1_790_000_000_000_i64, "boxId": null
        });
        if let Some(effort) = effort {
            row["effort"] = effort.into();
        }
        row
    };
    let patched = "PATCH__coworkers__coworker_id_";
    for effort in [
        None,
        Some("inherit"),
        Some("high"),
        Some("xhigh"),
        Some("ultra"),
    ] {
        read(patched, 200, row(effort)).unwrap();
    }
    read(
        "GET__coworkers",
        200,
        serde_json::json!([row(None), row(Some("max"))]),
    )
    .unwrap();
    let mut numbered = row(None);
    numbered["effort"] = 3.into();
    assert!(
        read(patched, 200, numbered).is_err(),
        "an effort that is not a word"
    );
    let corpus = Corpus::load();
    let unknown: Vec<&str> = recorded(&corpus, patched)
        .filter(|fixture| fixture["status"] == 400)
        .map(|fixture| str_at(&fixture["body"], "error"))
        .filter(|said| said.starts_with("effort must be one of"))
        .collect();
    assert_eq!(
        unknown,
        ["effort must be one of inherit, none, low, medium, high, xhigh, max, ultra"],
        "the recorded refusal of a word the server does not know"
    );
    let error = OpenGrokClient::refusal(400, &serde_json::json!({"error": unknown[0]}).to_string());
    assert_eq!(
        (error.status, error.message.as_str()),
        (Some(400), unknown[0])
    );
    assert_eq!(error.failure(), Failure::Verdict);
    read(
        patched,
        403,
        serde_json::json!({
            "error": "only the person who hired this coworker can change it; you can hide it \
                      from your own sidebar"
        }),
    )
    .unwrap();
}

/// Frames in the shape agreed for each word read ahead of its recording, hand-written until the
/// server's own are recorded, each with whether this app's reading takes it. The guard below
/// holds every entry of [`WORDS_NOT_RECORDED_YET`] to these, so a word added there comes with
/// its frames here, and leaves with it when the recording brings the real ones.
#[allow(clippy::type_complexity)]
const FRAMES_READ_AHEAD: &[(Slot, &str, fn() -> Vec<(Value, bool)>)] =
    &[(Slot::CustomName, "opengrok.officeDoc", office_doc_frames)];

/// The `opengrok.officeDoc` frames opengrok-server's `office_desk.rs` `frame` writes, until the
/// recording brings real ones: the full mutation shape reads, and one without its identity does
/// not — a frame that cannot name a document is no card.
fn office_doc_frames() -> Vec<(Value, bool)> {
    use serde_json::json;
    vec![
        (
            json!({
                "type": "CUSTOM",
                "name": "opengrok.officeDoc",
                "value": {
                    "docId": "odoc_1",
                    "path": "~/office/report.docx",
                    "kind": "docx",
                    "version": 3,
                    "artifactId": null,
                    "changed": {"type": "edited", "proposalId": "p_1"}
                }
            }),
            true,
        ),
        (
            json!({
                "type": "CUSTOM",
                "name": "opengrok.officeDoc",
                "value": {
                    "docId": "odoc_1",
                    "path": "~/office/deck.pptx",
                    "kind": "pptx",
                    "version": 4,
                    "artifactId": "art_9",
                    "changed": {"type": "exported", "exportPath": "~/office/deck-final.pptx"}
                }
            }),
            true,
        ),
        (
            json!({
                "type": "CUSTOM",
                "name": "opengrok.officeDoc",
                "value": {"kind": "docx", "version": 1}
            }),
            false,
        ),
    ]
}

/// A note off the account's events stream as the recording keeps one (opengrok-server #351,
/// recorded at 9a2b011): its `id:`, its `event:` name and its one line of `data:`, held whole as
/// `{"id", "event", "data"}`.
fn account_event(id: u64, name: &str, data: Value) -> Value {
    serde_json::json!({"id": id.to_string(), "event": name, "data": data})
}

/// `thread.changed` names the run whose commit made the change, and `null` when none did; a note
/// without the field is read as `null` too, for safety.
fn thread_changed_notes() -> Vec<(Value, bool)> {
    use serde_json::json;
    vec![
        (
            account_event(
                1,
                "thread.changed",
                json!({"threadId": "cw_1", "coworkerId": "cw_1", "runId": "run_1"}),
            ),
            true,
        ),
        (
            account_event(
                2,
                "thread.changed",
                json!({"threadId": "cw_1", "coworkerId": "cw_1", "runId": null}),
            ),
            true,
        ),
        (
            account_event(
                14,
                "thread.changed",
                json!({"threadId": "cw_1", "coworkerId": "cw_1"}),
            ),
            true,
        ),
        (
            account_event(15, "thread.changed", json!({"coworkerId": "cw_1"})),
            false,
        ),
    ]
}

/// A routine's run says the routine and its cause in the history's words; a monitor's, or a run
/// nothing fired, names no routine.
fn run_started_notes() -> Vec<(Value, bool)> {
    use serde_json::json;
    vec![
        (
            account_event(
                3,
                "run.started",
                json!({"runId": "run_1", "threadId": "sched_1", "coworkerId": "cw_1",
                       "routineId": "sched_1", "cause": "clock"}),
            ),
            true,
        ),
        (
            account_event(
                4,
                "run.started",
                json!({"runId": "run_2", "threadId": "cw_1", "coworkerId": "cw_1",
                       "cause": "chat"}),
            ),
            true,
        ),
        (
            account_event(
                16,
                "run.started",
                json!({"runId": "run_3", "threadId": "mon_1", "coworkerId": "cw_1",
                       "cause": "event"}),
            ),
            true,
        ),
        (
            account_event(
                5,
                "run.started",
                json!({"threadId": "cw_1", "coworkerId": "cw_1", "cause": "chat"}),
            ),
            false,
        ),
    ]
}

/// A run's end in the history's words: `ok`, or `error`, which a stop is too.
fn run_finished_notes() -> Vec<(Value, bool)> {
    use serde_json::json;
    vec![
        (
            account_event(
                6,
                "run.finished",
                json!({"runId": "run_1", "threadId": "sched_1", "coworkerId": "cw_1",
                       "routineId": "sched_1", "state": "ok"}),
            ),
            true,
        ),
        (
            account_event(
                17,
                "run.finished",
                json!({"runId": "run_2", "threadId": "cw_1", "coworkerId": "cw_1",
                       "state": "error"}),
            ),
            true,
        ),
        (
            account_event(
                7,
                "run.finished",
                json!({"runId": "run_1", "coworkerId": "cw_1", "state": "error"}),
            ),
            false,
        ),
    ]
}

fn routine_changed_notes() -> Vec<(Value, bool)> {
    use serde_json::json;
    let changed = |id: u64, change: &str| {
        account_event(
            id,
            "routine.changed",
            json!({"routineId": "sched_1", "coworkerId": "cw_1", "change": change}),
        )
    };
    vec![
        (changed(8, "created"), true),
        (changed(9, "updated"), true),
        (changed(10, "deleted"), true),
        (changed(11, "paused"), true),
        (changed(12, "resumed"), true),
        (
            account_event(
                13,
                "routine.changed",
                json!({"coworkerId": "cw_1", "change": "deleted"}),
            ),
            false,
        ),
    ]
}

fn reset_notes() -> Vec<(Value, bool)> {
    vec![(account_event(97, "reset", serde_json::json!({})), true)]
}

/// The account's events stream's notes beyond the five blocks the recording keeps, in its shapes
/// (opengrok-server #351, recorded at 9a2b011), each with whether the stream's reader takes it: a
/// note from before `runId`, a monitor's run and a run's error, every change to a routine, and a
/// note without an id it needs, which it passes over.
#[test]
fn account_events_are_read_beyond_the_recording() {
    let mut problems = Vec::new();
    for (note, reads) in [
        thread_changed_notes(),
        run_started_notes(),
        run_finished_notes(),
        routine_changed_notes(),
        reset_notes(),
    ]
    .into_iter()
    .flatten()
    {
        match (account_event_frame(&note), reads) {
            (Err(why), true) => problems.push(format!("{note}: {why}")),
            (Ok(()), false) => problems.push(format!("{note} should not read, and does")),
            _ => {}
        }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

/// Every block of the account's events stream the server recorded goes through the stream's own
/// reader, and comes out as the note it is, with every id the window reads again by as sent.
#[test]
fn every_account_event_the_server_sends_is_read_as_intended() {
    let corpus = Corpus::load();
    let names: BTreeSet<&str> = corpus
        .events
        .values()
        .map(|block| str_at(block, "event"))
        .collect();
    assert_eq!(
        names,
        ACCOUNT_EVENT_NAMES.into_iter().collect(),
        "the recording holds a block of every note this app reads"
    );
    let problems = verdicts(corpus.events.iter(), |_, block| account_event_frame(block));
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

/// The account's events stream's route as the server recorded it (opengrok-server #351,
/// recorded at 9a2b011): a stream nobody signed in asks for is refused `401` in the server's
/// words, which the stream reads as the session gone and stops for, after the session's own
/// refresh; and a store the server could not read is a `503` in its words, which the stream
/// opens again after a wait, as after any drop.
#[test]
fn the_events_streams_refusals_are_read_as_the_server_recorded_them() {
    let corpus = Corpus::load();
    let mut statuses = BTreeSet::new();
    for fixture in recorded(&corpus, "GET__ag-ui_events") {
        let status = fixture["status"]
            .as_u64()
            .and_then(|status| u16::try_from(status).ok())
            .expect("a status");
        statuses.insert(status);
        let body = &fixture["body"];
        let (sentence, _) = said_by(body);
        let (error, taken) = if status == 401 {
            let error = OpenGrokClient::signed_out_refusal(&body_text(body));
            (error, Refused::SessionGone)
        } else {
            let error = OpenGrokClient::refusal(status, &body_text(body));
            (error, Refused::TryAgain)
        };
        assert_eq!(when_refused(&error), taken, "{status}: {body}");
        assert_eq!(error.message, sentence, "{status}: the server's own words");
    }
    assert_eq!(
        statuses,
        BTreeSet::from([401, 503]),
        "the refusals the recording holds"
    );
}

/// A note off the account's events stream, read by the stream's own reader (`AccountEvent::read`)
/// as the note it is, with every id the window goes on to read again by as sent: the words of
/// opengrok-server #351 (recorded at 9a2b011), stated here case by case.
fn account_event_frame(frame: &Value) -> Check {
    let name = str_at(frame, "event");
    let data = &frame["data"];
    let text = |key: &str| str_at(data, key).to_string();
    let routine_id = opt_str(data, "routineId").map(str::to_string);
    let word = |key: &str| data.get(key).cloned().unwrap_or(Value::Null);
    let expected = match name {
        "thread.changed" => AccountEvent::ThreadChanged {
            thread_id: text("threadId"),
            coworker_id: text("coworkerId"),
            run_id: opt_str(data, "runId").map(str::to_string),
        },
        "run.started" => AccountEvent::RunStarted {
            run_id: text("runId"),
            thread_id: text("threadId"),
            coworker_id: text("coworkerId"),
            routine_id,
            cause: serde_json::from_value(word("cause")).unwrap_or_default(),
        },
        "run.finished" => AccountEvent::RunFinished {
            run_id: text("runId"),
            thread_id: text("threadId"),
            coworker_id: text("coworkerId"),
            routine_id,
            state: text("state"),
        },
        "routine.changed" => AccountEvent::RoutineChanged {
            routine_id: text("routineId"),
            coworker_id: text("coworkerId"),
            change: serde_json::from_value(word("change")).unwrap_or_default(),
        },
        // A card waiting in a thread (#358): the window reads that thread again, with the run.
        "run.waiting" => AccountEvent::ThreadChanged {
            thread_id: text("threadId"),
            coworker_id: text("coworkerId"),
            run_id: Some(text("runId")),
        },
        "reset" => AccountEvent::Reset,
        other => {
            return Err(format!(
                "no check for an account event named {other:?}: say here what the window does \
                 with one"
            ));
        }
    };
    let read = AccountEvent::read(name, &data.to_string())
        .map_err(|unread| format!("the stream passes it over as {unread:?}"))?;
    must!(
        read == expected,
        "the stream should read {expected:?}, not {read:?}"
    );
    Ok(())
}

/// [`FRAMES_READ_AHEAD`]'s frames for one word, none when it has none.
fn frames_read_ahead(slot: Slot, word: &str) -> Vec<(Value, bool)> {
    FRAMES_READ_AHEAD
        .iter()
        .find(|(at, read_ahead, _)| *at == slot && *read_ahead == word)
        .map(|(_, _, frames)| frames())
        .unwrap_or_default()
}

/// The words this app reads ahead of the server's recording ([`WORDS_NOT_RECORDED_YET`]) are
/// words it does match, which the manifest does not list yet, each saying what brings it; and
/// every one of them has its reading waiting in [`check_frame`], held to frames in its agreed
/// shape ([`frames_read_ahead`]), so the recording is read the day it arrives. Once the manifest
/// lists one, the entry has gone stale.
#[test]
fn every_word_read_ahead_of_its_recording_is_matched_and_not_sent_yet() {
    let corpus = Corpus::load();
    let emits = &corpus.manifest.emits;
    let ledger = ledger();
    let mut problems = Vec::new();
    for (slot, word, why) in WORDS_NOT_RECORDED_YET {
        if !ledger.contains(&(*slot, *word)) {
            problems.push(format!(
                "WORDS_NOT_RECORDED_YET lists the {} {word:?}, which nothing here matches",
                slot.field()
            ));
        }
        if emits.words(*slot).iter().any(|sent| sent == word) {
            problems.push(format!(
                "the manifest lists the {} {word:?} now: take it off WORDS_NOT_RECORDED_YET",
                slot.field()
            ));
        }
        if is_excused(NOT_SENT_BY_SERVER, *slot, word) || is_excused(CLIENT_IGNORES, *slot, word) {
            problems.push(format!(
                "the {} {word:?} is read ahead of its recording and excused as well",
                slot.field()
            ));
        }
        if why.trim().is_empty() {
            problems.push(format!(
                "WORDS_NOT_RECORDED_YET does not say what brings {word:?}"
            ));
        }
        let frames = frames_read_ahead(*slot, word);
        if !frames.iter().any(|(_, reads)| *reads) {
            problems.push(format!(
                "WORDS_NOT_RECORDED_YET lists the {} {word:?}, and frames_read_ahead writes no \
                 frame in its agreed shape for its reading to wait on",
                slot.field()
            ));
        }
        for (frame, reads) in frames {
            // A frame off the relay's stream is read by the relay's own reader, as the recorded
            // ones are, and a note off the account's events stream by that stream's; any other
            // by the chat's.
            let verdict = match slot {
                Slot::RelayType => relay_frame(&frame),
                Slot::AccountEvent => account_event_frame(&frame),
                _ => check_frame(&corpus, &frame),
            };
            match (verdict, reads) {
                (Err(why), true) => problems.push(format!("{frame}: {why}")),
                (Ok(()), false) => problems.push(format!("{frame} should not read, and does")),
                _ => {}
            }
        }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

/// `plan_unavailable` as the server recorded it (opengrok-server main d6f640e (#307, after #304),
/// pin bf99845), where this app read it ahead of the recording: a teammate with no proxy, on a
/// shared Bot on its own plan, is refused in the server's words with the code beside them, live and
/// journaled in the thread's replay. Live, the frame is the turn's error with the code that offers
/// it again on the server's keys; read back, the replay's run failed in those words, and its
/// `RUN_ERROR` carries the same code. The refusals for no model on the person's plan, and the
/// queued send on the person's own door with no proxy set whose reply a retry sends again (#308),
/// are the same shape, of which the recorder keeps one file, under the first test to produce it:
/// since server main 06db932 (#309, after #308), pin b6ca457, that is
/// `agui/RUN_ERROR/a_retry_naming_another_run_is_already_consumed.json`. A code spelt otherwise
/// is one nothing here reads, and is caught.
#[test]
fn a_turn_the_plan_was_unavailable_for_is_recorded_with_its_code() {
    let corpus = Corpus::load();
    let refused: Vec<&Value> = corpus
        .frames_of("RUN_ERROR")
        .filter(|frame| opt_str(frame, "code") == Some("plan_unavailable"))
        .collect();
    assert!(
        !refused.is_empty(),
        "the recording holds a turn refused with plan_unavailable"
    );
    for frame in &refused {
        check_frame(&corpus, frame).unwrap_or_else(|why| panic!("{why}: {frame}"));
        let error = OpenGrokClient::run_ended_badly(frame);
        assert_eq!(
            error.code().and_then(RunErrorCode::from_code),
            Some(RunErrorCode::PlanUnavailable),
            "{frame}"
        );
    }
    let mut journaled = 0;
    for (file, fixture) in &corpus.bodies {
        if !file.starts_with("rest/GET__ag-ui_threads__thread_id_/") || fixture["status"] != 200 {
            continue;
        }
        let replay: ThreadReplay = serde_json::from_value(fixture["body"].clone())
            .unwrap_or_else(|error| panic!("{file}: {error}"));
        for run in &replay.runs {
            let ended = run
                .events
                .iter()
                .rev()
                .find(|frame| str_at(frame, "type") == "RUN_ERROR");
            let Some(ended) =
                ended.filter(|ended| opt_str(ended, "code") == Some("plan_unavailable"))
            else {
                continue;
            };
            assert_eq!(
                (run.status.as_str(), run.failure.as_deref()),
                ("failed", opt_str(ended, "message")),
                "{file}: the run failed in the words its RUN_ERROR says"
            );
            journaled += 1;
        }
    }
    assert!(journaled > 0, "the recording journals the code in a replay");
    let mut misspelt = refused[0].clone();
    misspelt["code"] = Value::String("plan-unavailable".into());
    assert!(
        check_frame(&corpus, &misspelt).is_err(),
        "a code nothing here reads is caught"
    );
}

/// A Bot's reply to another Bot that the server skipped because the person switched the relay off
/// and set no fallback (opengrok-server #332 (PR #338 at 66b9f7b): `refused` in
/// `crates/opengrok-server/src/pairs.rs`, as its test
/// `a_bot_on_its_own_plan_is_skipped_while_the_relay_is_off_with_no_fallback` has it), read
/// beyond the recording, which keeps no frame of it ([`RUN_ERROR_CODES_OFFERING_NOTHING`]). Its
/// `RUN_ERROR` ends the turn in the server's words and keeps `relay_disabled` beside them, and
/// the code offers nothing: no Send this reply on Server, in a pair thread a person cannot write
/// in. `relay_disabled` on a routine's skip and on Run it now's 409 is recorded, and read there.
#[test]
fn a_bots_reply_skipped_while_the_relay_is_off_is_read_beyond_the_recording() {
    use serde_json::json;
    let corpus = Corpus::load();
    let said = "Skipped: Relay is off for your plan";
    let frame = json!({
        "type": "RUN_ERROR", "timestamp": 100, "threadId": "pair-cw_ada-cw_luna",
        "runId": "run_1", "message": said, "code": "relay_disabled"
    });
    run_ended(&corpus, &frame).unwrap_or_else(|why| panic!("{frame}: {why}"));
    let error = OpenGrokClient::run_ended_badly(&frame);
    assert_eq!(
        (error.message.as_str(), error.code()),
        (said, Some("relay_disabled"))
    );
    assert_eq!(
        error.code().and_then(RunErrorCode::from_code),
        None,
        "nothing to send again on the server's keys"
    );
    let unread = json!({"type": "RUN_ERROR", "message": said, "code": "relay_slow"});
    assert!(
        run_ended(&corpus, &unread).is_err(),
        "a code nothing here reads is still caught"
    );
}

/// The queue's reading of the door a send was queued with, fed bodies beyond the ones the
/// server's recording holds: a row that names one and a row that names none, listed and as a write's
/// answer, a row whose parse lost the door, and the route's plain-text 400 for a word it does not
/// know, read as the server's own sentence like the route's other 400s.
#[test]
fn a_queued_sends_door_is_read_beyond_the_recording() {
    use serde_json::json;
    let row = |id: &str, bubble: &str, door: Option<&str>| {
        let mut row = json!({
            "v": 1, "id": id, "threadId": "th_1", "content": "queued",
            "replyTo": null, "recipeId": null, "recipeValues": null, "skillId": null,
            "clientMessageId": bubble, "status": "pending", "createdAtMs": 10,
            "updatedAtMs": 10, "drainedAtMs": null, "drainedRunId": null
        });
        if let Some(door) = door {
            row["inferenceSource"] = json!(door);
        }
        row
    };
    let snapshot = |row: Value| {
        json!({
            "type": "CUSTOM", "name": PENDING_CUSTOM, "timestamp": 1,
            "value": {"v": 1, "op": "snapshot", "threadId": "th_1", "message": row}
        })
    };
    let rows = [
        row("pum_1", "m2", Some("local_proxy")),
        row("pum_2", "m3", None),
    ];
    let listed = json!({
        "pendingUserMessages": rows,
        "pendingEvents": rows.iter().cloned().map(snapshot).collect::<Vec<_>>(),
        "threadId": "th_1",
        "v": 1
    });
    pending_list(200, &listed).unwrap_or_else(|why| panic!("{why}"));
    let created = json!({
        "v": 1, "threadId": "th_1", "pendingUserMessage": rows[0].clone(),
        "event": {
            "type": "CUSTOM", "name": PENDING_CUSTOM, "timestamp": 1,
            "value": {"v": 1, "op": "created", "threadId": "th_1", "message": rows[0].clone()}
        }
    });
    pending_created(201, &created).unwrap_or_else(|why| panic!("{why}"));
    // A row whose door the parse lost would not pass.
    let mut lost: PendingUserMessage = serde_json::from_value(rows[0].clone()).unwrap();
    lost.inference_source = None;
    assert!(held_as_sent(&lost, &rows[0]).is_err());
    // With the Mac relay, whose recording (opengrok-server PR #298) holds a row sent through the
    // person's Mac and held for it: beside such a row, a way this app cannot name reads as no
    // door and never fails the queue, and a row whose hold the parse lost would not pass.
    let mut through_the_mac = row("pum_3", "m4", None);
    through_the_mac["inferenceSource"] = json!({"kind": "local_proxy", "via": "mac"});
    through_the_mac["heldFor"] = json!("relay_offline");
    let mut helper = row("pum_4", "m5", None);
    helper["inferenceSource"] = json!({"kind": "local_proxy", "via": "helper"});
    let relayed = [through_the_mac.clone(), helper];
    let listed = json!({
        "pendingUserMessages": relayed,
        "pendingEvents": relayed.iter().cloned().map(snapshot).collect::<Vec<_>>(),
        "threadId": "th_1",
        "v": 1
    });
    pending_list(200, &listed).unwrap_or_else(|why| panic!("{why}"));
    let read: PendingUserMessage = serde_json::from_value(through_the_mac.clone()).unwrap();
    assert_eq!(
        read.inference_source(),
        Some(TurnSource::plan(Some(Via::Mac)))
    );
    assert!(read.waits_for_mac());
    let mut forgot: PendingUserMessage = serde_json::from_value(through_the_mac.clone()).unwrap();
    forgot.held_for = None;
    assert!(
        held_as_sent(&forgot, &through_the_mac).is_err(),
        "a row whose hold the parse lost would not pass"
    );
    // The queue answers a word it does not know as it answers its other 400s: plain text,
    // which reads as the server's sentence and a verdict, not a server out of reach.
    let said = "inferenceSource must be \"gateway\" or \"local_proxy\"";
    refusal(400, &json!(said)).unwrap_or_else(|why| panic!("{said}: {why}"));
    let error = OpenGrokClient::refusal(400, said);
    assert_eq!(
        (error.status, error.message.as_str(), error.failure()),
        (Some(400), said, Failure::Verdict)
    );
}

/// The server that made the recording has the Mac relay, and says where the relay stands on every
/// read of the account's setting and every Save's answer, nulls and all when no Mac holds it
/// (`described` in opengrok-server's `crates/opengrok-harness/src/local_proxy.rs`, PR #298), on
/// the gateway as on the plan. So every one of them reads as a server that knows the relay, which
/// is what lets this app name a way to the plan to it and offer the Mac; a server from before the
/// relay sends no `relay` and is taken to know none.
#[test]
fn every_recorded_setting_is_from_a_server_that_knows_the_relay() {
    let corpus = Corpus::load();
    let mut read = 0;
    for (file, fixture) in &corpus.bodies {
        let route = file.split('/').nth(1).unwrap_or("");
        let setting = matches!(
            route,
            "GET__account_inference-source" | "PUT__account_inference-source"
        );
        if !setting || fixture["status"] != 200 {
            continue;
        }
        let source: InferenceSource = serde_json::from_value(fixture["body"].clone())
            .unwrap_or_else(|error| panic!("{file}: {error}"));
        assert!(
            source.knows_relay(),
            "{file}: a server with the relay says where it stands: {source:?}"
        );
        read += 1;
    }
    assert!(read > 0, "the recording holds the account's setting");
}

/// The server that made the recording keeps the relay's switch and what answers while it is off
/// (opengrok-server #332 (PR #338 at 66b9f7b): `described` in
/// `crates/opengrok-harness/src/local_proxy.rs`, which writes `relayEnabled` and `planFallback`
/// on every read and every Save's answer, `true` and `null` until they are set). So every
/// recorded setting reads as one from a server that keeps both, which is what has the relay
/// switch tell it `relayEnabled` and makes the Relay-off fallback's card live; and the recording
/// holds the switch both ways, each with a fallback set and with none.
#[test]
fn every_recorded_setting_keeps_the_relay_switch_and_its_fallback() {
    let corpus = Corpus::load();
    let mut seen = BTreeSet::new();
    for (file, fixture) in &corpus.bodies {
        let route = file.split('/').nth(1).unwrap_or("");
        let setting = matches!(
            route,
            "GET__account_inference-source" | "PUT__account_inference-source"
        );
        if !setting || fixture["status"] != 200 {
            continue;
        }
        let source: InferenceSource = serde_json::from_value(fixture["body"].clone())
            .unwrap_or_else(|error| panic!("{file}: {error}"));
        let (Some(on), Some(fallback)) = (source.relay_enabled, &source.plan_fallback) else {
            panic!("{file}: a server with the switch says it, and its fallback, on every read");
        };
        seen.insert((on, fallback.is_some()));
    }
    assert_eq!(
        seen,
        BTreeSet::from([(false, false), (false, true), (true, false), (true, true)]),
        "the recording holds the switch both ways, with a fallback and without"
    );
}

/// The server that made the recording keeps a door per Bot, and writes it on every coworker row it
/// answers with, `null` and all (`coworker_row` in opengrok-server's
/// `crates/opengrok-server/src/agui/routes.rs`, server main d6f640e (#307, after #304), pin
/// bf99845): the roster's, a hire's and a PATCH's. So every recorded row reads as one from a server
/// that keeps a door per Bot, which is what lets a Bot's model picker offer the person's plan and
/// send the Bot's door with a pick; a server from before per-Bot doors writes no `source`, and is
/// taken to keep none. A hire whose body names its model answers `null`, a Bot that follows the
/// account's door until it is given one of its own; since #322 (on main since c0bb6ae: `hire` in
/// the same file, and `Coworker::born_on`), one hired with no model is born on its hirer's default
/// for new Bots, door and all. The recording holds a hire of each, and a row on each door the
/// server writes: the Bot's own plan, and since opengrok-server #332 (PR #338 at 66b9f7b), whose
/// sender is put on the gateway as a PATCH so it answers however the relay is set, the gateway's
/// too. The recorder keeps one file per shape, and both doors are one shape to it, so the
/// recording vendored before (#334, on main 8e7387f) kept no gateway row, and that word was read
/// only beyond the recording ([`a_bots_door_is_read_beyond_the_recording`]).
#[test]
fn every_recorded_coworker_row_is_from_a_server_that_keeps_a_door_per_bot() {
    let corpus = Corpus::load();
    let mut doors = Vec::new();
    let mut hires = Vec::new();
    for (file, fixture) in &corpus.bodies {
        let route = file.split('/').nth(1).unwrap_or("");
        let rows = match (route, &fixture["body"]) {
            ("GET__coworkers", Value::Array(rows)) => rows.clone(),
            ("POST__coworkers" | "PATCH__coworkers__coworker_id_", row)
                if row.get("id").is_some() =>
            {
                vec![row.clone()]
            }
            _ => continue,
        };
        for row in rows {
            let bot: Coworker =
                serde_json::from_value(row).unwrap_or_else(|error| panic!("{file}: {error}"));
            assert_ne!(
                bot.source,
                CoworkerSource::NotKept,
                "{file}: a server that keeps a door per Bot writes it on every row: {bot:?}"
            );
            if route == "POST__coworkers" {
                hires.push(bot.source.clone());
            }
            if !doors.contains(&bot.source) {
                doors.push(bot.source);
            }
        }
    }
    for door in [
        CoworkerSource::AccountDefault,
        CoworkerSource::Kind(InferenceKind::LocalProxy),
        CoworkerSource::Kind(InferenceKind::Gateway),
    ] {
        assert!(
            doors.contains(&door),
            "the recording holds a Bot whose door reads {door:?}: {doors:?}"
        );
    }
    assert!(
        hires.contains(&CoworkerSource::AccountDefault),
        "the recording holds a hire that follows the account's door: {hires:?}"
    );
    assert!(
        hires
            .iter()
            .any(|door| matches!(door, CoworkerSource::Kind(_))),
        "the recording holds a hire born on its hirer's default for new Bots: {hires:?}"
    );
}

/// A Bot's door, read beyond the recording, which holds rows with `null` and `local_proxy`, a
/// hire's and a PATCH's among them, a PATCH's on `gateway` (since opengrok-server #332, PR #338
/// at 66b9f7b), and the PATCH's 400s for a Bot left on the person's plan with a model the
/// allowlist does not take (opengrok-server main d6f640e (#307, after #304), pin bf99845): a
/// roster's row on `gateway`, which the recording keeps no roster of, a row whose door is a word
/// this app has not heard of, and one from a server before per-Bot doors, with no `source` at
/// all, each read as sent, and a row whose parse lost its door caught; and the 400 for a `source`
/// that is neither word, which the recorder keeps no file of, having one 400 of that shape
/// already and no pin on this one, and which this app never provokes, sending only a word it
/// knows.
#[test]
fn a_bots_door_is_read_beyond_the_recording() {
    use serde_json::json;
    let row = |id: &str, source: Option<Value>| {
        let mut row = json!({
            "id": id, "name": "Ada", "model": "gpt-6-luna", "role": null, "title": null,
            "avatarShape": null, "avatarColor": null, "updatedAtMs": 10,
            "hiddenFromSidebar": false, "boxId": null, "effort": "medium", "visibility": "private"
        });
        if let Some(source) = source {
            row["source"] = source;
        }
        row
    };
    let roster = json!([
        row("cw_keys", Some(json!("gateway"))),
        row("cw_odd", Some(json!("byok"))),
        row("cw_old", None)
    ]);
    read_fixture(
        "GET__coworkers",
        &json!({"method": "GET", "path": "/coworkers", "status": 200, "body": roster}),
    )
    .unwrap_or_else(|why| panic!("{why}"));
    let answered = row("cw_plan", Some(json!("local_proxy")));
    let mut lost: Coworker = serde_json::from_value(answered.clone()).unwrap();
    lost.source = CoworkerSource::AccountDefault;
    assert!(
        coworker_matches(&lost, &answered).is_err(),
        "a row whose door the parse lost would not pass"
    );
    let unknown = "source must be \"gateway\" or \"local_proxy\"";
    read_fixture(
        "PATCH__coworkers__coworker_id_",
        &json!({
            "method": "PATCH", "path": "/coworkers/cw_plan", "status": 400,
            "body": {"error": unknown}
        }),
    )
    .unwrap_or_else(|why| panic!("{unknown}: {why}"));
}

/// The reply source's reading, fed bodies beyond the ones the server's recording holds: the read and
/// the Save's answer alike, set and unset as a server from before the relay sends them, the
/// Save's refusals in the server's words (a URL that is not loopback, a provider it will not
/// route), and the ways a body could go wrong.
#[test]
fn the_reply_source_routes_are_read_beyond_the_recording() {
    use serde_json::json;
    // The read and a Save's answer are the same body, and read the same way. A server from
    // before the relay says nothing of a way or of the relay.
    let set = json!({
        "kind": "local_proxy", "baseUrl": "http://127.0.0.1:8080",
        "localModel": "gpt-5-codex", "healthy": true, "hasApiKey": true
    });
    let unset = json!({
        "kind": "gateway", "baseUrl": null, "localModel": null,
        "healthy": false, "hasApiKey": false
    });
    // From a server with the Mac relay, whose recording (opengrok-server PR #298) holds a Mac
    // answering and no Mac at all: a way this app cannot name, which that server refuses to keep
    // until its #293, still reads.
    let helper = json!({
        "kind": "local_proxy", "healthy": true, "hasApiKey": false, "via": "helper",
        "relay": {"connected": false}
    });
    for body in [&set, &unset, &helper] {
        inference_source(200, body).unwrap_or_else(|why| panic!("{body}: {why}"));
    }
    for broken in [
        json!({"kind": "gateway", "baseUrl": null, "localModel": null, "hasApiKey": false}),
        json!({"kind": "byok", "healthy": false, "hasApiKey": false}),
        json!({"baseUrl": null, "healthy": false, "hasApiKey": false}),
        json!({"kind": "gateway", "healthy": "yes", "hasApiKey": false}),
        json!({"kind": "gateway", "healthy": false, "hasApiKey": false,
            "relay": {"machineId": "mac_2"}}),
        json!({"kind": "gateway", "healthy": false, "hasApiKey": false,
            "relay": {"connected": "yes"}}),
    ] {
        assert!(inference_source(200, &broken).is_err(), "{broken}");
    }
    // A relay's model the server will not route is refused as the plan's is, in its words
    // (`apply` names the field before `subscription_model`'s sentence).
    refusal(
        400,
        &json!({"error": "relay.localModel: claude-opus is one of Anthropic's models, and \
                          Anthropic's terms forbid using a consumer subscription through a \
                          third-party app; pick an OpenAI or xAI model, or use the gateway"}),
    )
    .unwrap_or_else(|why| panic!("{why}"));
    // The recording holds one of each refusal; the others the server writes (`apply` in
    // `crates/opengrok-harness/src/local_proxy.rs`) read the same way.
    for said in [
        "baseUrl: that is not a URL; give the address of the proxy on this server's own \
         machine, with no path, like http://127.0.0.1:8080",
        "localModel: \"llama-3\" is not a model this server knows to be OpenAI's or xAI's, and \
         only theirs (gpt-*, o1, o3, o4, codex, grok-*) may use your own subscription",
        "apiKey must be printable ASCII, 512 at most",
    ] {
        refusal(400, &json!({ "error": said })).unwrap_or_else(|why| panic!("{said}: {why}"));
    }
}

/// A bot's skills' reading, fed bodies in the shape agreed for opengrok-server#270 beyond the ones
/// the corpus records (#290), for the read and for the write's answer alike: skills of both
/// scopes, attached and not, one switched off and still attached, at a version and at none, an
/// empty list, the refusals (not the owner's, a withdrawn grant, an id the server does not list,
/// the cap, a version it has moved on from), and the ways a body could go wrong.
#[test]
fn a_bots_skills_have_a_reading_in_the_ledger() {
    use serde_json::json;
    for (route, verb) in [
        ("GET__coworkers__coworker_id__skills", "GET"),
        ("PUT__coworkers__coworker_id__skills", "PUT"),
    ] {
        let read = |status: u16, body: Value| {
            read_fixture(
                route,
                &json!({
                    "method": verb, "path": "/coworkers/cw_1/skills", "status": status, "body": body
                }),
            )
        };
        let skills = json!({"skills": [
            {"id": "sk_triage", "name": "triage", "description": "Sort the inbox.",
                "scope": "mine", "attached": true, "enabled": true},
            {"id": "sk_draft", "name": "draft", "description": "",
                "scope": "mine", "attached": false, "enabled": true},
            {"id": "sk_review", "name": "review", "description": "The team's checklist.",
                "scope": "org", "attached": true, "enabled": true},
            {"id": "sk_old", "name": "old-notes", "description": "Last year's notes.",
                "scope": "mine", "attached": true, "enabled": false}
        ], "version": 4});
        read(200, skills.clone()).unwrap_or_else(|why| panic!("{verb}: {why}"));
        read(200, json!({"skills": []})).unwrap_or_else(|why| panic!("{verb}: {why}"));
        read(200, json!({"skills": [], "version": 0}))
            .unwrap_or_else(|why| panic!("{verb}: {why}"));
        read(404, json!({"error": "no such coworker"}))
            .unwrap_or_else(|why| panic!("{verb}: {why}"));
        read(
            403,
            json!({"error": "your grant to this coworker was withdrawn"}),
        )
        .unwrap_or_else(|why| panic!("{verb}: {why}"));
        read(422, json!({"error": "no skill sk_gone"}))
            .unwrap_or_else(|why| panic!("{verb}: {why}"));
        read(
            422,
            json!({"error": "a coworker takes at most 20 skills, and this is 21"}),
        )
        .unwrap_or_else(|why| panic!("{verb}: {why}"));
        read(
            409,
            json!({"error": "the skills changed since you looked", "code": "skills-changed"}),
        )
        .unwrap_or_else(|why| panic!("{verb}: {why}"));
        assert!(
            read(404, skills).is_err(),
            "{verb}: a refusal carrying skills"
        );
        assert!(read(200, json!({})).is_err(), "{verb}: no skills array");
        for (dropped, why) in [
            (
                "attached",
                "a skill that does not say whether it is attached",
            ),
            (
                "enabled",
                "a skill that does not say whether it is switched on",
            ),
            ("scope", "a skill that does not say whose it is"),
        ] {
            let mut row = json!({"id": "sk_1", "name": "triage", "description": "",
                "scope": "mine", "attached": true, "enabled": true});
            row.as_object_mut().unwrap().remove(dropped);
            assert!(
                read(200, json!({ "skills": [row] })).is_err(),
                "{verb}: {why}"
            );
        }
        assert!(
            read(
                200,
                json!({"skills": [{"id": "sk_1", "name": "triage", "description": "",
                    "scope": "shared", "attached": false, "enabled": true}]})
            )
            .is_err(),
            "{verb}: a scope in a word the app does not know"
        );
    }
}

/// `use_skill` (#270, recorded since #290) reads as the server's own tool, beyond the one turn the
/// corpus records: the call says which skill is being read rather than "Using
/// use_skill", the turn that only read one says what it did, and the step keeps the skill's name
/// as sent, by the rule for the server's own tools — a long name, which reads as a key to the
/// plugin rule, included.
#[test]
fn use_skill_reads_as_the_servers_own_tool() {
    use serde_json::json;
    let start =
        json!({"type": "TOOL_CALL_START", "toolCallId": "call_1", "toolCallName": USE_SKILL});
    tool_call_start(&start).unwrap();
    let name = "finance-team.quarterly-report-checklist-v2";
    let sent = json!({ "name": name });
    let args = json!({"type": "TOOL_CALL_ARGS", "toolCallId": "call_1", "delta": sent.to_string()});
    let end = json!({"type": "TOOL_CALL_END", "toolCallId": "call_1"});
    let mut tracker = ToolCallTracker::default();
    tracker.tick(&start);
    assert_eq!(
        tracker.tick(&args),
        label(&format!("Reading the {name} skill"))
    );
    assert_eq!(tracker.deeds(), [format!("read the {name} skill")]);

    let (_, parts) = assembled(&[&start, &args, &end]).snapshot();
    let step = parts
        .iter()
        .find_map(|part| match part {
            ChatPart::Step(step) if step.call_id == "call_1" => Some(step),
            _ => None,
        })
        .expect("a use_skill call is a step");
    let kept: Value = serde_json::from_str(&step.arguments).expect("kept arguments read back");
    kept_as_the_card_allows(USE_SKILL, &sent, &kept).unwrap();
    assert_eq!(kept, sent);
    assert_eq!(step.shown_arguments().as_deref(), Some(name));
}

/// A model's levels of effort as the server recorded them (opengrok-server #342 (main 2136ffc):
/// `Model::entry` in `crates/opengrok-core/src/catalogue.rs`, `list_models` in
/// `crates/opengrok-server/src/agui/routes.rs`): every entry of every list carries `efforts` and
/// `ownEffort`, both `null` where the model's source publishes none, and the recording holds the
/// plan's models with six levels, up to `ultra`, and with five beside one with none, and the
/// gateway's with three beside one with none. The levels come through lowest first, each named by
/// the label its source gives it without the word every opencodex label ends with ("Low Effort"
/// is "Low"), and the level a model runs at is one of them, which is what the slider lights.
#[test]
fn a_models_levels_are_read_as_the_server_recorded_them() {
    let corpus = Corpus::load();
    let mut shapes: BTreeSet<(String, Vec<String>)> = BTreeSet::new();
    for fixture in recorded(&corpus, "GET__models").filter(|fixture| fixture["status"] == 200) {
        let catalogue: ModelCatalogue =
            serde_json::from_value(fixture["body"].clone()).expect("a list of models");
        let raw = fixture["body"]["models"].as_array().expect("models");
        for (entry, raw) in catalogue.models.iter().zip(raw) {
            assert!(
                raw.get("efforts").is_some() && raw.get("ownEffort").is_some(),
                "every entry the server records carries both keys: {raw}"
            );
            let levels = entry.efforts.iter().flatten();
            if let Some(own) = entry.own_effort.as_deref() {
                assert!(
                    levels.clone().any(|level| level.value == own),
                    "a model's own level is one of its levels: {raw}"
                );
                assert!(entry.own_level().is_some(), "{raw}");
            }
            shapes.insert((
                entry.source.clone().unwrap_or_default(),
                levels.map(|level| level.name()).collect(),
            ));
        }
    }
    let said = |source: &str, levels: &[&str]| {
        (
            source.to_string(),
            levels.iter().map(|level| level.to_string()).collect(),
        )
    };
    for shape in [
        said(
            "local_proxy",
            &["Low", "Medium", "High", "Xhigh", "Max", "Ultra"],
        ),
        said("local_proxy", &["Low", "Medium", "High", "Xhigh", "Max"]),
        said("local_proxy", &[]),
        said("gateway", &["Low", "Medium", "High"]),
        said("gateway", &[]),
    ] {
        assert!(
            shapes.contains(&shape),
            "the recording holds a {} model with the levels {:?}: it holds {shapes:?}",
            shape.0,
            shape.1
        );
    }
}

/// `/models`' reading, fed bodies beyond the ones the server's recording holds (it records the
/// gateway's routes alone and beside the plan's on the server's own machine, opencodex's word on
/// itself, no Mac holding the relay, and levels of effort on the plan's models and the gateway's):
/// both doors' entries and a plan-only list with `note: null` as a server from before the relay
/// sends them, opencodex answering and not, a server from before reply sources, the Mac's own
/// models with a Mac holding the relay, a fast twin and an entry that lists no level, and the one
/// shape it must not take quietly, a door this app does not know.
#[test]
fn the_models_list_is_read_beyond_the_recording() {
    use serde_json::json;
    let both = json!({
        "models": [
            {"id": "xai/grok-4.6", "points": null, "source": "gateway"},
            {"id": "gpt-5.5", "points": null, "source": "local_proxy"}
        ],
        "note": null,
        "localProxy": {"healthy": true}
    });
    let plan_only = json!({
        "models": [{"id": "grok-4", "points": null, "source": "local_proxy"}],
        "note": null,
        "localProxy": {"healthy": true}
    });
    let proxy_down = json!({
        "models": [], "note": "the gateway could not be reached: timed out",
        "localProxy": {"healthy": false}
    });
    let before_reply_sources = json!({"models": [{"id": "oag/auto"}], "note": null});
    // With the Mac relay (opengrok-server PR #298): the recording has no Mac holding it, so the
    // Mac's own models (`via: "mac"`) beside the server's own machine's, with a Mac holding it,
    // and no Mac holding it with nothing to list at all.
    let relayed = json!({
        "models": [
            {"id": "xai/grok-4.6", "points": null, "source": "gateway"},
            {"id": "gpt-5.5", "points": null, "source": "local_proxy", "via": "loopback"},
            {"id": "grok-4", "points": null, "source": "local_proxy", "via": "mac"}
        ],
        "note": null,
        "localProxy": {"healthy": true, "relayConnected": true}
    });
    let relay_down = json!({
        "models": [], "note": null,
        "localProxy": {"healthy": false, "relayConnected": false}
    });
    // With the levels of effort, beyond what the recording holds (a plan model with six, a plan
    // model with five and one with none, a gateway model with three and one with none): a fast
    // twin listing the levels its base does, a model whose source publishes none (`null`, and
    // empty), and one that lists levels and no level of its own.
    let level = |value: &str, label: &str| json!({"value": value, "label": label});
    let levelled = json!({
        "models": [
            {"id": "gpt-6-luna", "points": null, "source": "local_proxy", "ownEffort": "medium",
             "efforts": [
                level("low", "Low Effort"), level("medium", "Medium Effort"),
                level("high", "High Effort"), level("xhigh", "Xhigh Effort"),
                level("max", "Max Effort")
             ]},
            {"id": "gpt-6-luna--fast", "points": null, "source": "local_proxy",
             "ownEffort": "medium",
             "efforts": [level("low", "Low Effort"), level("medium", "Medium Effort")]},
            {"id": "gpt-5.6-sol", "points": null, "source": "local_proxy", "ownEffort": "high",
             "efforts": [
                level("low", "Low Effort"), level("medium", "Medium Effort"),
                level("high", "High Effort"), level("xhigh", "Xhigh Effort"),
                level("max", "Max Effort"), level("ultra", "Ultra Effort")
             ]},
            {"id": "xai/grok-4.6", "points": null, "source": "gateway",
             "efforts": null, "ownEffort": null},
            {"id": "oag/cheap", "points": null, "source": "gateway",
             "efforts": [], "ownEffort": null},
            {"id": "oag/auto", "points": null, "source": "gateway",
             "efforts": [level("low", "Low"), level("high", "High")], "ownEffort": null}
        ],
        "note": null,
        "localProxy": {"healthy": true}
    });
    for body in [
        &both,
        &plan_only,
        &proxy_down,
        &before_reply_sources,
        &relayed,
        &relay_down,
        &levelled,
    ] {
        models_listed(200, body).unwrap_or_else(|why| panic!("{body}: {why}"));
    }
    let unknown = json!({"models": [{"id": "m", "source": "byok"}], "note": null});
    assert!(models_listed(200, &unknown).is_err());
    // A listing this app cannot read is read as none, so the picker draws no slider rather than
    // one from a guess; the reading catches a key the server was not agreed to send in a shape
    // like these, and says so, instead of letting a slider that is missing go unnoticed.
    for lost in [
        json!({"models": [{"id": "m", "source": "gateway", "efforts": "low"}], "note": null}),
        json!({"models": [{"id": "m", "source": "gateway", "efforts": {"low": "Low"}}],
               "note": null}),
        json!({"models": [{"id": "m", "source": "gateway", "ownEffort": 3}], "note": null}),
    ] {
        assert!(models_listed(200, &lost).is_err(), "{lost}");
    }
    // A level with no label is called by its value, and an entry with no value is no level,
    // as the server reads a listing itself (`Levels::of`): none of it loses a model its slider.
    let odd = json!({
        "models": [{"id": "m", "source": "gateway", "ownEffort": "low", "efforts": [
            level("low", ""), {"value": "high"}, {"label": "Nameless"}, level("max", "Max")
        ]}],
        "note": null
    });
    models_listed(200, &odd).unwrap_or_else(|why| panic!("{odd}: {why}"));
}

/// An effort the model does not list is refused with a 400 in the server's words, which name the
/// levels it lists, on the three routes that take one: a Bot's PATCH, and `newBotDefault` and
/// `planFallback` of the account's reply source, the fallback held to the gateway's levels
/// (opengrok-server #342 (main 2136ffc): `effort_refused` in
/// `crates/opengrok-server/src/inference.rs` and `refusal` in
/// `crates/opengrok-core/src/catalogue.rs`, whose sentences `against_a_models_own_levels.rs`
/// asserts), and `ultra`, which is taken only where a listing of the model names it, in words of
/// its own where none does. The recorder files one 400 for a route and shape, and none of these
/// is the one it kept, so they are read here as fed. Each is read as its sentence, which is what
/// the picker shows under its controls; `inherit` is always taken.
#[test]
fn a_refused_effort_is_read_as_the_servers_sentence_beyond_the_recording() {
    use serde_json::json;
    for (route, path, method, said) in [
        (
            "PATCH__coworkers__coworker_id_",
            "/coworkers/cw_1",
            "PATCH",
            "effort: gpt-6-luna takes low, medium, high, xhigh or max, not \"none\"",
        ),
        (
            "PATCH__coworkers__coworker_id_",
            "/coworkers/cw_1",
            "PATCH",
            "effort: no listing of xai/grok-4.6 names \"ultra\", and it is taken only where one \
             does",
        ),
        (
            "PUT__account_inference-source",
            "/account/inference-source",
            "PUT",
            "newBotDefault.effort: gpt-6-luna takes low, medium, high, xhigh or max, not \"none\"",
        ),
        (
            "PUT__account_inference-source",
            "/account/inference-source",
            "PUT",
            "planFallback.effort: openai/gpt-6-luna takes low, medium or high, not \"max\"",
        ),
    ] {
        read_fixture(
            route,
            &json!({"method": method, "path": path, "status": 400, "body": {"error": said}}),
        )
        .unwrap_or_else(|why| panic!("{said}: {why}"));
        let error = OpenGrokClient::refusal(400, &json!({"error": said}).to_string());
        assert_eq!(error.message, said, "shown as the server wrote it");
        assert_eq!(error.failure(), Failure::Verdict);
    }
}

/// The CUSTOM frame's way, fed frames beyond the ones the server's recording holds, which has a
/// reply the person's Mac answered and one the gateway did (opengrok-server PR #298): one the
/// server's own machine answered, and one by a way this app cannot name, each read as its badge
/// says it.
#[test]
fn a_replys_way_is_read_beyond_the_recording() {
    use serde_json::json;
    let frame =
        |value: Value| json!({"type": "CUSTOM", "name": INFERENCE_SOURCE_CUSTOM, "value": value});
    for value in [
        json!({"kind": "local_proxy", "via": "loopback", "model": "gpt-5-codex"}),
        json!({"kind": "local_proxy", "via": "helper", "model": "gpt-5-codex"}),
    ] {
        inference_source_frame(&frame(value.clone()))
            .unwrap_or_else(|why| panic!("{value}: {why}"));
    }
}

/// Every `opengrok.inferenceSource` frame anywhere in `value`, a replay's runs' included.
fn inference_source_frames<'a>(value: &'a Value, out: &mut Vec<&'a Value>) {
    match value {
        Value::Object(object) => {
            if str_at(value, "type") == "CUSTOM" && str_at(value, "name") == INFERENCE_SOURCE_CUSTOM
            {
                out.push(value);
            }
            object
                .values()
                .for_each(|child| inference_source_frames(child, out));
        }
        Value::Array(items) => items
            .iter()
            .for_each(|item| inference_source_frames(item, out)),
        _ => {}
    }
}

/// A reply the person's Relay-off fallback answered, as the recording holds it (opengrok-server
/// #332 (PR #338 at 66b9f7b): a fresh turn by the Mac while the relay is off asks the gateway on
/// the account's `planFallback`): live, under `agui/custom/opengrok.inferenceSource/`, and
/// journaled in the replay of a turn by the Mac with the relay off. Its frame names the gateway
/// and the fallback's model, no way, and why in `fallbackFor: "relay_disabled"`; each is read as
/// sent, and the reply's badge says the relay was off. A reason this app has not heard of is
/// still read beyond the recording, as no reason at all.
#[test]
fn a_reply_on_the_relay_off_fallback_is_recorded_and_says_so() {
    use serde_json::json;
    let corpus = Corpus::load();
    let fell_back = |frames: Vec<&Value>| -> Vec<Value> {
        frames
            .into_iter()
            .filter(|frame| frame["value"].get("fallbackFor").is_some())
            .cloned()
            .collect()
    };
    let live = fell_back(corpus.customs_named(INFERENCE_SOURCE_CUSTOM).collect());
    let mut journaled = Vec::new();
    for fixture in corpus.bodies.values() {
        inference_source_frames(&fixture["body"], &mut journaled);
    }
    let replayed = fell_back(journaled);
    assert!(
        !live.is_empty() && !replayed.is_empty(),
        "the recording holds a reply on the fallback, live and in a replay"
    );
    for frame in live.iter().chain(&replayed) {
        let value = &frame["value"];
        assert_eq!(
            (
                str_at(value, "kind"),
                str_at(value, "fallbackFor"),
                value.get("via")
            ),
            ("gateway", "relay_disabled", None),
            "{frame}"
        );
        inference_source_frame(frame).unwrap_or_else(|why| panic!("{frame}: {why}"));
        let assembler = assembled(&[frame]);
        let source = assembler
            .reply_source()
            .expect("the frame gives the reply its badge");
        assert_eq!(
            crate::components::reply_source::badge_words(source),
            "paid key · relay off",
            "{frame}"
        );
    }
    let unheard = json!({
        "type": "CUSTOM", "name": INFERENCE_SOURCE_CUSTOM,
        "value": {"kind": "gateway", "model": "oag/cheap", "fallbackFor": "relay_slow"}
    });
    inference_source_frame(&unheard).unwrap_or_else(|why| panic!("{unheard}: {why}"));
}

/// This Mac's answers, read beyond the ones the server's recording holds (a 204, a 401, a 404 and
/// a 409): an answer past the server's 32 MiB, refused 413 in its words (`relay_response` in
/// opengrok-server's `crates/opengrok-server/src/inference.rs`, PR #298), reads as a failed
/// answer and nothing more, and a status the relay does not act on as the server's refusal.
#[test]
fn an_answer_is_read_beyond_the_recording() {
    use serde_json::json;
    let answered = |status: u16, body: Value| {
        read_fixture(
            "POST__inference-relay_responses__request_id_",
            &json!({
                "method": "POST", "path": "/inference-relay/responses/req_1",
                "status": status, "body": body
            }),
        )
    };
    answered(413, json!({"error": "that answer is too large"}))
        .unwrap_or_else(|why| panic!("413: {why}"));
    assert_eq!(
        OpenGrokClient::relay_answered(413),
        Some(RelayAnswered::TooLarge)
    );
    answered(500, json!({"error": "the run could not take the answer"}))
        .unwrap_or_else(|why| panic!("500: {why}"));
    assert_eq!(OpenGrokClient::relay_answered(500), None);
}
