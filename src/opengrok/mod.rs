//! OpenGrok HTTP client. No GPUI. Cookies are the session.

mod activity;
mod client;
// The wire corpus in `fixtures/wire/`, read by this module's own parsers.
#[cfg(test)]
mod conformance;
mod credential;
mod error;
mod events;
mod gen_ui;
mod inference;
mod local_exec;
mod model_choice;
// The list of models the tests that draw a picker read.
#[cfg(test)]
pub(crate) mod model_fixtures;
mod pending;
mod relay;
mod timing;
mod types;
mod user_form;
mod visibility;

pub use activity::{
    ActivityTick, BotActivity, ToolCallTracker, WAKING_COMPUTER, activity_from_agui,
    activity_from_replay, deeds_from_replay, tool_standin,
};
pub use credential::{
    CREDENTIAL_OFFER_SAVE, SaveLoginSpec, keep_local_save_offer, save_login_card_id,
    save_login_from_local, save_login_save_id, save_login_skip_id,
};
#[cfg(test)]
pub(crate) use gen_ui::capped;
pub use gen_ui::{
    ApprovalSpec, BarChartSpec, BarItem, CREATE_ROUTINE, ChatPart, ChoiceCard, CompletedUiTool,
    DELETE_ROUTINE, FormField, FormSpec, FrameArrivals, LIST_ROUTINES, LocalExecResolution,
    MAX_TURN_CONTINUES, OFFICE_DOC_CUSTOM, OfficeDocSpec, PLUGIN_NEEDS_CUSTOM, PluginNeed,
    PluginNeedKind, PluginNeedsSpec, RUN_ROUTINE, RoutineChanges, ScreenshotSpec, StepSpec,
    StepStatus, ThoughtSpec, TurnAssembler, UI_TOOL_RESULT, UPDATE_ROUTINE, USER_MACHINE_SHELL,
    UiSpec, agui_tools, approval_from_event, approval_summary, choice_index, choice_letter,
    collapse_open_approvals, command_from_args, command_from_replay_events, keep_call_times,
    local_exec_outcome, persons_messages, place_hitl_cards_in_document_order, policy_answer,
};
pub use inference::{
    DEFAULT_PROXY_URL, FallbackFor, HELD_FOR_RELAY_OFFLINE, INFERENCE_SOURCE_CUSTOM, InferenceKind,
    InferenceSource, InferenceSourceUpdate, NewBotDefault, PlanFallback, RelayRead, ReplySource,
    RunErrorCode, TurnSource, Via, is_loopback, is_subscription_model,
};
pub use local_exec::{
    Enrolment, LocalExecStopped, MachineCredential, enrol_this_machine, serve_local_exec,
    stored_machine_id,
};
pub use model_choice::{
    AccountPlan, CURRENT_TITLE, ChoiceGroup, EFFORT_NOT_KEPT, FAST_ACCOUNT_PLAN, FAST_DOOR_UNKNOWN,
    FAST_NO_TWIN, FAST_SUFFIX, GATEWAY_GROUP, LIST_ROWS, ListLine, ModelChoice, ModelPick,
    NEW_BOTS_NONE, NEW_BOTS_PICK_FIRST, NEW_BOTS_PICK_ID, NO_MODEL, PLAN_FALLBACK_PICK_FIRST,
    ROUTINES_ON_PLAN, SUBSCRIPTION_GROUP, base_label, bot_pick, group_title, is_fast,
    last_window_start, list_window, model_label, new_bots_pick, plan_choices, plan_fallback_pick,
    row_count, server_choices, without_fast,
};
pub use relay::{
    OpencodexAddress, RelayHandle, RelayKey, RelayReport, RelayStatus, RelayTarget, RelayTimings,
    SERVER_QUIET, SERVER_UNREACHED, SERVER_WITHOUT_RELAY, TOKEN_REFUSED, start_relay,
};
pub(crate) use user_form::USER_FORM_REASON;
pub use user_form::{
    BOX_HANDOFF_RESOLVE_PATH, BoxHandoffReply, BoxHandoffResolution, ComputerHandoffSpec,
    ComputerHandoffStatus, FORM_ENTRY_MISSING, FormResolution, MASKED_PRESENCE_STUB,
    REQUEST_USER_FORM_TOOL, USER_FORM_CUSTOM, USER_FORM_DISMISS_PATH,
    USER_FORM_SERVER_FILL_AVAILABLE, USER_FORM_SUBMIT_PATH, UserFormActionReply,
    UserFormDismissMode, UserFormField, UserFormFieldKind, UserFormHttpSettle, UserFormSpec,
    UserFormValues, UserFormVerb, WAITING_FOR_YOU, bind_call_peers, box_handoff_action_from_http,
    box_handoff_resolve_entry_id, box_handoff_settles_locally, computer_attention_done_id,
    computer_attention_id, computer_attention_skip_id, computer_handoff_card_id,
    computer_handoff_done_id, computer_handoff_skip_id, computer_handoff_takeover_id,
    computer_window_attention_done_id, computer_window_attention_id,
    computer_window_attention_skip_id, continue_enabled, dismiss_request_body,
    is_form_entry_missing, is_user_form_awaiting, is_user_form_custom_name, is_user_form_event,
    is_user_form_tool, resolve_handoff_request_body, settle_user_form_http, submit_request_body,
    submit_request_body_for, user_form_action_from_http, user_form_all_bots_id,
    user_form_by_hand_id, user_form_card_id, user_form_continue_id, user_form_dismiss_id,
    user_form_field_id, user_form_own_computer_id, user_form_pill_id, user_form_saved_clear_id,
    user_form_saved_list_id, user_form_saved_note_id, user_form_screen_id, user_form_use_saved_id,
};
pub use visibility::ImageVisibility;

pub use client::{
    AsyncRunResponse, BotSkillRow, BotSkillScope, BoxShareScope, CatalogEntry, CeilingKind,
    CeilingRow, ComputerError, ConnectedComputer, ConnectionAttempt, ConnectionKind,
    ConnectionOwner, ConnectionPin, ConnectionView, Connector, CoworkerCeiling, CoworkerComputer,
    CoworkerSkills, CoworkerTool, CoworkerUsage, DaemonMachine, EgressTunnel, ImageStatus,
    InertRule, InstalledAccount, InstalledBundle, LocalExecMode, LocalExecPolicy,
    MAX_ATTACHMENT_BYTES, ModelUsage, NewSchedule, NewSkill, OpenGrokClient, PluginAuthor,
    PluginCatalog, PluginDetail, PluginInstallation, PluginManifest, PluginPart, PluginSkill,
    QueuedApproval, RecipeBot, RecipeDetail, RecipeGrant, RecipeKind, RecipeParameter,
    RecipeParameterKind, RecipeRelation, RecipeRun, RecipeRunResult, RecipeScreen, RecipeShare,
    RecipeShareState, RecipeShareTarget, RecipeStep, RecipeSummary, RecipeTape, RecipeTapeEvent,
    RecipeVersion, RevealedSecrets, RunBy, RunCause, RunRecipeResponse, RunReplay,
    SKILL_BODY_CHARS, SKILL_BUNDLE_FILES, SKILL_BUNDLE_LIMIT, SavedLoginCheck, ScheduleEdit,
    ScheduleKind, ScheduleRow, ScheduleRun, ScheduleRunStatus, SiteLoginSave, SiteLoginUpdate,
    SkillDetail, SkillFile, SkillPatch, SkillSource, SkillSummary, SkillVersion, StopReply,
    ThreadReplay, ThreadRun, TurnRecipe, TurnTags, UpdateStatus, UsageTotals, UsageWindow,
    WebhookInfo, collapse_computer_roster, collapse_computers_by_machine_id,
    env_egress_tunnel_enabled, host_egress_tunnel_available, host_egress_tunnel_enabled,
    host_egress_tunnel_flag, thin_tape,
};
pub use error::{Failure, OpenGrokError, Unreachable, reads_as_gateway_unreachable, retry_enqueue};
pub use events::{
    AccountEvent, AccountEvents, EventsNote, EventsTimings, RoutineChange, RunStartCause,
    start_account_events,
};
pub use pending::{
    CUSTOM_NAME, PAYLOAD_V, PendingCustom, PendingList, PendingMutation, PendingOp,
    PendingUserMessage, PendingWrite,
};
pub use timing::{TurnTiming, stamp_duration};
pub use types::{
    Account, AguiMessage, Attachment, Coworker, CoworkerPatch, CoworkerSource, EFFORT_INHERIT,
    EffortLevel, LocalProxyStatus, ModelCatalogue, ModelEntry, OfficeDocDetail, OfficeProposal,
    ProfileUpdate, ReplyQuote, SentAttachment, ThreadListing, assistant_text_from_sse,
};
