use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use crate::actions::{PauseReadAloud, ResumeReadAloud, StopReadAloud, ToggleReadAloud};
use crate::chrome::{CHAT_CONTENT_MAX, chat_column_width, timestamps_fit};
use crate::components::chat_find::find_bar_element;
use crate::components::chat_input::MessageInput;
use crate::components::emoji_picker::{full_picker, reaction_strip};
use crate::components::gen_ui::{render_approval, render_screenshots, render_ui_spec};
use crate::components::message::{MessageBubble, TS_PEEK_MAX, TimestampPeek, turn_metadata};
use crate::components::persona::PersonaMark;
use crate::components::save_login::render_save_login;
use crate::components::steps::{RunLayout, RunRow, render_run_row};
use crate::components::transcript_scroll::{TranscriptScroll, TranscriptScroller};
use crate::components::user_form::{
    UserFormInputMap, UserFormTextareaMap, field_key, render_user_form,
};
use crate::find_text::{FindHit, marks_for_row, project_hits};
use crate::opengrok::{
    ApprovalSpec, ChatPart, SaveLoginSpec, ScreenshotSpec, UiSpec, UserFormSpec, UserFormValues,
    collapse_open_approvals,
};
use crate::state::{
    AppState, EmojiPickerOpen, STOPPED_TURN_NOTE, bot_status_line, is_status_line, is_tool_standin,
    is_unsent_turn_note,
};
use crate::tts_text::{looks_like_markdown, map_utf16_range_to_utf8};

/// Beside the line of a turn the person's plan could not answer: the turn again, on the server's
/// paid keys.
pub(crate) const SEND_ON_SERVER: &str = "run-error-send-on-server";
/// What a failed turn's line says in the chat; the sentence itself is in the notifications.
pub const TURN_FAILED: &str = "Turn failed";
pub(crate) const SEND_ON_SERVER_LABEL: &str = "Send this reply on Server instead";
use gpui_kit::base::{Align, Placement, Positioner};
use gpui_kit::component::input::{InputEvent, InputState, TextareaState};
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::{ActiveTheme, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;

/// Cheap fingerprint so ChatView does not rebuild markdown on unrelated AppState
/// changes (sidebar toggle, theme, amplitude, etc.).
#[derive(Clone, PartialEq, Eq)]
struct ChatFeedRev {
    conversation_id: Option<String>,
    message_count: usize,
    /// How many of the thread's messages the person has hidden. Hiding changes no other
    /// field here — the message stays in the thread, same id, same words — so without this
    /// the feed would decide nothing had changed and leave the bubble on screen.
    hidden_count: usize,
    last_id: Option<String>,
    /// How much each row holds: its words, its parts, and the output under its approval cards.
    /// Every row's, not the last one's, because the row a run is painting into is not always
    /// last. A message sent while the reply streams is held on the end of the thread, under it,
    /// and something stays there when that message is edited (a new bubble on the end) or
    /// cancelled (hidden, not removed). Read off the last row alone, the reply stood still on
    /// screen from the moment a message was held, "working" still lit, and landed whole only
    /// when the run's clock changed at its end.
    bodies: Vec<(usize, usize, usize)>,
    form_picks: Vec<(String, String, String)>,
    /// A card put away with its ✕ changes nothing else here: the thread and its parts stay
    /// as they were, so without this the card would keep asking.
    dismissed_choices: Vec<String>,
    user_form_picks: Vec<(String, String, String)>,
    user_forms: Vec<(String, String, String)>,
    user_form_verbs: bool,
    user_form_handoffs: Vec<(String, String, bool)>,
    save_logins: Vec<(String, String)>,
    /// How many files the thread's messages carry: the list of them arrives after the replay,
    /// and a feed that did not count them would never draw them.
    files: usize,
    box_screen: bool,
    is_ai_responding: bool,
    debug_mode: bool,
    can_read_aloud: bool,
    theme_mode: String,
    native_speaking_id: Option<String>,
    native_paused: bool,
    native_loading: bool,
    highlight: Option<(usize, usize)>,
    reactions: Vec<(String, String)>,
    reply_to: Option<String>,
    emoji_for: Option<String>,
    approvals: Vec<(String, String)>,
    expanded_output: Vec<String>,
    /// How much the thread's steps and thoughts hold, and how many steps have come back. A
    /// step's arguments and result arrive into a part that is already there, so the part count
    /// alone would leave its row saying "…" after the call was done.
    steps: (usize, usize),
    expanded_steps: Vec<String>,
    show_turn_timing: bool,
    action_times: Vec<Option<u64>>,
    /// Every row's, not the last one's: a resumed run finishes on a bubble that a later
    /// message may already sit below.
    clocks: Vec<(
        Option<std::time::SystemTime>,
        Option<crate::opengrok::TurnTiming>,
    )>,
    /// Every reply's badge: the frame that brings one changes nothing else a row is drawn from.
    sources: Vec<Option<crate::opengrok::ReplySource>>,
    /// The reply the person's plan could not answer, which offers itself on the server's keys: a
    /// run's code arrives with the same words a row already shows.
    plan_failed: Option<String>,
    /// The held sends the server holds for the person's Mac: a row's `heldFor` changes nothing
    /// else a bubble is drawn from.
    waiting_for_mac: Vec<String>,
}

impl ChatFeedRev {
    fn from_state(state: &AppState) -> Self {
        let conv = state
            .active_conversation_id
            .as_ref()
            .and_then(|id| state.conversations.iter().find(|c| &c.id == id));
        let last = conv.and_then(|c| c.messages.last());
        let highlight = state
            .active_highlight_range()
            .map(|range| (range.start, range.end));
        Self {
            conversation_id: state.active_conversation_id.clone(),
            message_count: conv.map(|c| c.messages.len()).unwrap_or(0),
            hidden_count: conv
                .map(|c| c.messages.iter().filter(|m| m.hidden).count())
                .unwrap_or(0),
            last_id: last.map(|m| m.id.clone()),
            bodies: conv
                .map(|c| {
                    c.messages
                        .iter()
                        .map(|m| {
                            let output = m
                                .parts
                                .iter()
                                .map(|part| match part {
                                    ChatPart::Approval(spec) => {
                                        spec.output.as_ref().map_or(0, String::len)
                                    }
                                    _ => 0,
                                })
                                .sum();
                            (m.content.len(), m.parts.len(), output)
                        })
                        .collect()
                })
                .unwrap_or_default(),
            form_picks: {
                let mut picks: Vec<(String, String, String)> = state
                    .form_picks
                    .iter()
                    .flat_map(|(msg, fields)| {
                        fields
                            .iter()
                            .map(|(field, value)| (msg.clone(), field.clone(), value.clone()))
                    })
                    .collect();
                picks.sort();
                picks
            },
            dismissed_choices: {
                let mut dismissed: Vec<String> = state.dismissed_choices.iter().cloned().collect();
                dismissed.sort();
                dismissed
            },
            user_form_picks: {
                let mut picks: Vec<(String, String, String)> = state
                    .user_form_picks
                    .iter()
                    .flat_map(|(entry, fields)| {
                        fields
                            .iter()
                            .map(|(field, value)| (entry.clone(), field.clone(), value.clone()))
                    })
                    .collect();
                picks.sort();
                picks
            },
            user_forms: {
                let mut cards: Vec<(String, String, String)> = conv
                    .map(|c| {
                        c.messages
                            .iter()
                            .flat_map(|m| m.parts.iter())
                            .filter_map(|part| match part {
                                ChatPart::UserForm(spec) => Some((
                                    spec.card_key().to_string(),
                                    spec.effective_resolution()
                                        .map(|r| r.as_str().to_string())
                                        .unwrap_or_else(|| {
                                            if spec.has_gateway_entry_id() {
                                                "idle".into()
                                            } else {
                                                "idle-no-entry".into()
                                            }
                                        }),
                                    spec.computer_handoff
                                        .map(|status| status.as_str().to_string())
                                        .unwrap_or_else(|| "none".into()),
                                )),
                                _ => None,
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                cards.sort();
                cards
            },
            user_form_verbs: state.user_form_verbs_available,
            user_form_handoffs: {
                let mut rows: Vec<(String, String, bool)> = conv
                    .map(|c| {
                        c.messages
                            .iter()
                            .flat_map(|m| m.parts.iter())
                            .filter_map(|part| match part {
                                ChatPart::UserForm(spec) => {
                                    let id = spec
                                        .handoff_entry_id
                                        .clone()
                                        .or_else(|| state.user_form_handoff_id(spec.card_key()))
                                        .unwrap_or_default();
                                    Some((
                                        spec.card_key().to_string(),
                                        id,
                                        state.user_form_handoff_resolved(spec.card_key()),
                                    ))
                                }
                                _ => None,
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                rows.sort();
                rows
            },
            files: conv
                .map(|c| {
                    c.messages
                        .iter()
                        .filter_map(|m| state.message_files.get(&m.id))
                        .map(Vec::len)
                        .sum()
                })
                .unwrap_or(0),
            save_logins: {
                let mut cards: Vec<(String, String)> = conv
                    .map(|c| {
                        c.messages
                            .iter()
                            .flat_map(|m| m.parts.iter())
                            .filter_map(|part| match part {
                                ChatPart::SaveLogin(spec) => {
                                    Some((spec.form_entry_id.clone(), spec.username.clone()))
                                }
                                _ => None,
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                cards.sort();
                cards
            },
            box_screen: state.coworker_screen.is_some() || state.last_box_shot.is_some(),
            is_ai_responding: state.is_active_bot_responding(),
            debug_mode: state.debug_markdown_disabled,
            can_read_aloud: true,
            theme_mode: state.theme_mode.clone(),
            native_speaking_id: state.native_tts.message_id.clone(),
            native_paused: state.native_tts.is_paused,
            native_loading: state.native_tts.is_loading,
            highlight,
            reactions: {
                let mut pairs: Vec<(String, String)> = state
                    .message_reactions
                    .iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect();
                pairs.sort();
                pairs
            },
            reply_to: state.reply_to.as_ref().map(|r| r.message_id.clone()),
            emoji_for: state.emoji_picker.as_ref().map(|p| p.message_id.clone()),
            approvals: {
                let mut pairs: Vec<(String, String)> = state
                    .approval_decisions
                    .iter()
                    .map(|(id, decision)| (id.clone(), format!("{decision:?}")))
                    .collect();
                pairs.sort();
                pairs
            },
            expanded_output: {
                let mut ids: Vec<String> = state.expanded_shell_output.iter().cloned().collect();
                ids.sort();
                ids
            },
            steps: conv
                .map(|c| {
                    c.messages.iter().flat_map(|m| m.parts.iter()).fold(
                        (0, 0),
                        |(held, settled), part| match part {
                            ChatPart::Step(step) => (
                                held + step.arguments.len()
                                    + step.result.as_ref().map_or(0, String::len),
                                settled + usize::from(step.result.is_some()),
                            ),
                            ChatPart::Reasoning(thought) => (held + thought.text.len(), settled),
                            _ => (held, settled),
                        },
                    )
                })
                .unwrap_or_default(),
            expanded_steps: {
                let mut keys: Vec<String> = state.expanded_steps.iter().cloned().collect();
                keys.sort();
                keys
            },
            show_turn_timing: state.show_turn_timing,
            action_times: conv
                .map(|c| {
                    c.messages
                        .iter()
                        .flat_map(|m| m.parts.iter())
                        .filter_map(|part| match part {
                            ChatPart::Step(step) => Some(step.took_ms),
                            ChatPart::Reasoning(thought) => Some(thought.took_ms),
                            _ => None,
                        })
                        .collect()
                })
                .unwrap_or_default(),
            clocks: conv
                .map(|c| {
                    c.messages
                        .iter()
                        .map(|m| (m.finished_at, m.run_timing.clone()))
                        .collect()
                })
                .unwrap_or_default(),
            sources: conv
                .map(|c| c.messages.iter().map(|m| m.reply_source.clone()).collect())
                .unwrap_or_default(),
            plan_failed: state.plan_failed_turn(),
            waiting_for_mac: state.sends_waiting_for_mac(),
        }
    }
}

#[derive(Clone)]
struct ChatRow {
    id: String,
    content: SharedString,
    is_me: bool,
    timestamp: SharedString,
    duration: SharedString,
    /// One total for the entire reply, beside the final row's timestamp.
    turn_total: Option<SharedString>,
    is_native_speaking: bool,
    is_native_paused: bool,
    is_native_loading: bool,
    is_ai_speaking: bool,
    is_ai_paused: bool,
    is_ai_loading: bool,
    is_cached: bool,
    /// The person's message is on screen but its turn is held until the thread is idle.
    queued: bool,
    /// Held by the server until a Mac holds the relay again: the queued line says it waits for
    /// the person's Mac.
    waiting_for_mac: bool,
    highlight_range: Option<std::ops::Range<usize>>,
    highlight_native: bool,
    use_markdown: bool,
    show_footer: bool,
    source_id: String,
    tts_text: SharedString,
    reply_preview: Option<String>,
    /// A line over the bubble saying whose words these are when they are not the person's own:
    /// a routine's instruction in its thread.
    caption: Option<String>,
    reaction: Option<String>,
    widget: Option<UiSpec>,
    approval: Option<ApprovalSpec>,
    status_line: Option<String>,
    /// A status line about a run that failed, painted in the danger colour rather than dimmed.
    status_failed: bool,
    /// A status line for a turn that never left, which carries the offer to send it again.
    status_retry: bool,
    /// A status line for a turn the person's plan could not answer, which carries the offer to
    /// send it again on the server's keys.
    status_send_on_server: bool,
    /// The pictures of one stretch of a turn, which the row paints as one strip and the
    /// lightbox pages through as one set.
    screenshots: Vec<ScreenshotSpec>,
    user_form: Option<UserFormSpec>,
    save_login: Option<SaveLoginSpec>,
    plugin_needs: Option<crate::opengrok::PluginNeedsSpec>,
    /// A document the turn's `opengrok.officeDoc` frames named: the card that opens the
    /// document window onto it.
    office_doc: Option<crate::opengrok::OfficeDocSpec>,
    /// A step, a stretch of steps, or a thought. Its `content` stays
    /// empty: none of it is words, so find, copy and read aloud pass it by.
    run: Option<RunRow>,
    /// The files one of the person's messages carried (#90), drawn as tiles under it.
    files: Vec<crate::opengrok::Attachment>,
    /// Which door a coworker's reply came through, on the last row of its words.
    source_badge: Option<crate::opengrok::ReplySource>,
}

impl ChatRow {
    /// A row with nothing said yet: no speech, no footer, no card. Each
    /// kind of row sets the few fields it owns on top of this.
    fn slot(id: String, source_id: String) -> Self {
        Self {
            id,
            content: SharedString::from(""),
            is_me: false,
            timestamp: SharedString::from(""),
            duration: SharedString::from(""),
            turn_total: None,
            is_native_speaking: false,
            is_native_paused: false,
            is_native_loading: false,
            is_ai_speaking: false,
            is_ai_paused: false,
            is_ai_loading: false,
            is_cached: false,
            queued: false,
            waiting_for_mac: false,
            highlight_range: None,
            highlight_native: false,
            use_markdown: false,
            show_footer: false,
            source_id,
            tts_text: SharedString::from(""),
            reply_preview: None,
            caption: None,
            reaction: None,
            widget: None,
            approval: None,
            status_line: None,
            status_failed: false,
            status_retry: false,
            status_send_on_server: false,
            files: Vec::new(),
            screenshots: Vec::new(),
            user_form: None,
            save_login: None,
            plugin_needs: None,
            office_doc: None,
            run: None,
            source_badge: None,
        }
    }

    /// Whether this is the same row, drawn the same way, as `other`: an opened step is a
    /// different row from the shut one, because it is taller. Adding or removing total-time
    /// metadata needs a fresh render of its swipe rail.
    fn same_as(&self, other: &Self) -> bool {
        self.id == other.id
            && self.run.as_ref().map(RunRow::is_open) == other.run.as_ref().map(RunRow::is_open)
            && self.turn_total.is_some() == other.turn_total.is_some()
            // A document card is rewritten by every officeDoc frame: a version bump under the
            // same id is a different row.
            && self.office_doc == other.office_doc
    }
}

/// The rows that changed between `old` and `new`, as the span of `old` to replace and how many
/// rows of `new` replace it: everything between the rows the two begin with and the rows they
/// end with.
fn changed_rows(old: &[ChatRow], new: &[ChatRow]) -> (std::ops::Range<usize>, usize) {
    let head = old
        .iter()
        .zip(new)
        .take_while(|(old, new)| old.same_as(new))
        .count();
    let tail = old[head..]
        .iter()
        .rev()
        .zip(new[head..].iter().rev())
        .take_while(|(old, new)| old.same_as(new))
        .count();
    (head..old.len() - tail, new.len() - tail - head)
}

/// Whether the rows now end on a message of the person's own that the old rows did not have,
/// which is what a send looks like from here: the message goes on the end of the thread at
/// once, whether it went to the coworker then, waits behind a running turn, or steered a card.
fn just_sent(old: &[ChatRow], new: &[ChatRow]) -> bool {
    new.last()
        .is_some_and(|last| last.is_me && !old.iter().any(|row| row.source_id == last.source_id))
}

/// What changed about the thread besides its rows, for [`apply_rows`].
#[derive(Clone, Copy, Debug, Default)]
struct RowsChange {
    /// Another thread was opened in the transcript.
    thread_opened: bool,
    /// A step or a thought was opened or shut, which adds or takes away rows under it.
    steps_toggled: bool,
    /// The coworker is replying, so its last row may have grown.
    responding: bool,
}

/// Bring the transcript's list up to date with the thread's rows: `old` is what the list was
/// drawn from, `new` what it is drawn from now.
///
/// Rows arriving are no reason to go back to the newest row. A person who went back up the
/// thread stays where they are while a reply streams in below them, a step arrives or a message
/// is hidden: only the rows that changed are replaced, and the list keeps its place. Starting
/// the list over whenever the number of rows changed, as it once did, carried them back down
/// with every row a turn added. The newest row is taken back only by another thread opening, or
/// by a message of the person's own: they sent it, and whoever sends wants to see what comes
/// back.
fn apply_rows(scroll: &mut TranscriptScroll, old: &[ChatRow], new: &[ChatRow], change: RowsChange) {
    // A scrollbar movement can arrive before the next render. Hear it before a row update
    // decides whether the person still wants to follow the newest row.
    scroll.sync_frame();
    let count = new.len();
    // The list and the old rows agree on how many there are, unless something replaced the rows
    // without telling the list (the read-aloud pump does). A splice would then point into rows
    // that are not there, so the list starts over at the newest row instead, as it always did.
    let in_step = scroll.item_count() == old.len();
    if change.steps_toggled && in_step {
        // A step opened or shut in the middle of the thread adds or takes away rows there, and a
        // list reset for that would carry the person off to the bottom of the thread, away from
        // the very row they clicked. Only the rows that changed are replaced.
        let (span, added) = changed_rows(old, new);
        scroll.splice(span, added);
    } else if change.thread_opened || just_sent(old, new) {
        scroll.reset(count);
    } else if count != scroll.item_count() {
        if scroll.is_following() || !in_step {
            scroll.reset(count);
        } else {
            splice_in_place(scroll, old, new);
        }
    } else if change.responding && count > 0 {
        scroll.remeasure_items(count - 1..count);
    }
}

/// Replace the rows that changed while the person reads further up the thread, keeping the row
/// at the top of their view where it is, and as far into it. A splice keeps that place by
/// itself unless the row is one of those replaced; then it is found again by its id, where a
/// splice alone would put the view at the top of the rows replaced.
fn splice_in_place(scroll: &mut TranscriptScroll, old: &[ChatRow], new: &[ChatRow]) {
    let (span, added) = changed_rows(old, new);
    let anchor = scroll.anchor();
    let held = old
        .get(anchor.item_ix)
        .filter(|_| span.contains(&anchor.item_ix))
        .map(|row| row.id.as_str());
    scroll.splice(span, added);
    if let Some(item_ix) = held.and_then(|id| new.iter().position(|row| row.id == id)) {
        scroll.hold(ListOffset {
            item_ix,
            offset_in_item: anchor.offset_in_item,
        });
    }
}

/// Actions read as one compact sequence, not separate message bubbles. The scroller's
/// default 32px message gap belongs only between ordinary transcript rows.
fn transcript_row_gap(row: &ChatRow, next: Option<&ChatRow>) -> Pixels {
    match next {
        None => px(0.),
        Some(next) if row.run.is_some() && next.run.is_some() => px(4.),
        Some(next) if row.run.is_some() || next.run.is_some() => px(12.),
        Some(_) => px(32.),
    }
}

/// The first row of a routine's run in a thread: the instruction it opened with, which a replay
/// names `{runId}-prompt` (opengrok-server `agui/history.rs`, `routine_prompt`), or else the first
/// row of any message of that run.
fn run_row(rows: &[ChatRow], run_id: &str) -> Option<usize> {
    let prompt = format!("{run_id}-prompt");
    rows.iter()
        .position(|row| row.source_id == prompt)
        .or_else(|| {
            rows.iter()
                .position(|row| row.source_id.starts_with(run_id))
        })
}

/// Whether a picture belongs to the strip the row before it already holds. Pictures are one
/// set when they came from the same turn with nothing but pictures between them — that is
/// what makes a strip, rather than a column of full-width screens nobody scrolls past.
fn joins_previous_set(rows: &[ChatRow], message_id: &str) -> bool {
    rows.last()
        .is_some_and(|last| !last.screenshots.is_empty() && last.source_id == message_id)
}

/// The replies in the open thread that wear a badge, as the feed draws them, oldest first: the
/// reply's message id and which door it came through. For the gpui-agent tree, which names what
/// the window shows: a reply that said nothing but a status line has no bubble, and no badge.
#[cfg(feature = "agent")]
pub(crate) fn reply_badges(state: &AppState) -> Vec<(String, crate::opengrok::ReplySource)> {
    snapshot_rows(state)
        .iter()
        .filter_map(|row| Some((row.source_id.clone(), row.source_badge.clone()?)))
        .collect()
}

fn snapshot_rows(state: &AppState) -> Arc<Vec<ChatRow>> {
    let Some(conv) = state
        .active_conversation_id
        .as_ref()
        .and_then(|id| state.conversations.iter().find(|c| &c.id == id))
    else {
        return Arc::new(Vec::new());
    };
    // The one turn the thread would send again, if it has one. Asked once rather than per row,
    // and by id, because only the thread's last turn is the one a retry would be about.
    let retryable = state.retryable_turn();
    // And the one the person's plan could not answer, which goes again on the server's keys.
    let plan_failed = state.plan_failed_turn();
    let mut rows = Vec::new();
    for msg in &conv.messages {
        // Saved quotes may have been truncated in the middle of Markdown. Project the
        // original when available; leave the stored text and model context untouched.
        let reply_preview = msg
            .reply_to_id
            .as_ref()
            .and_then(|id| conv.messages.iter().find(|source| &source.id == id))
            .map(|source| {
                crate::reply_preview::preview(
                    &source.content,
                    !source.is_me && looks_like_markdown(&source.content),
                    88,
                )
            })
            .or_else(|| msg.reply_preview.clone());
        // A message the person hid is still here — it is what keeps the thread from fetching
        // its turn back off the server — but it is never painted again.
        if msg.hidden {
            continue;
        }
        let is_native_speaking = state.native_tts.message_id.as_ref() == Some(&msg.id);
        let full_highlight = if is_native_speaking {
            state
                .active_highlight_range()
                .and_then(|range| map_utf16_range_to_utf8(&msg.content, range))
        } else {
            None
        };
        if !msg.is_me && !msg.has_visible_body() {
            continue;
        }
        let highlight_native = is_native_speaking && full_highlight.is_some();
        let bot_name = state.active_bot_name();
        let display: Vec<ChatPart> = if msg.parts.iter().any(ChatPart::is_widget) {
            let open: std::collections::HashSet<String> = msg
                .parts
                .iter()
                .filter_map(|part| match part {
                    ChatPart::Approval(spec) => match state.approval_decisions.get(&spec.call_id) {
                        Some(decision) if decision.is_settled() => None,
                        _ => Some(spec.call_id.clone()),
                    },
                    _ => None,
                })
                .collect();
            let mut display = collapse_open_approvals(&msg.parts, &open);
            // A turn that stopped short of saying anything has the app's line about why as its
            // text. The steps it took do not say that, and drawn alone they would be all there
            // was to see of a run that failed after its tools ran, so the line goes under them.
            let said_nothing = !display
                .iter()
                .any(|part| matches!(part, ChatPart::Text(text) if !text.trim().is_empty()));
            let acted = display
                .iter()
                .any(|part| matches!(part, ChatPart::Step(_) | ChatPart::Reasoning(_)));
            if !msg.is_me && acted && said_nothing && is_status_line(&msg.content) {
                display.push(ChatPart::Text(msg.content.clone()));
            }
            display
        } else {
            vec![ChatPart::Text(msg.content.clone())]
        };
        let runs = RunLayout::new(
            &msg.id,
            &display,
            &state.expanded_steps,
            state.show_turn_timing,
        );
        let mut text_buf = String::new();
        let mut ui_n = 0usize;
        let mut text_n = 0usize;
        let flush_text = |rows: &mut Vec<ChatRow>, text_buf: &mut String, text_n: &mut usize| {
            let text = std::mem::take(text_buf);
            if text.trim().is_empty() {
                return;
            }
            let id = text_row_id(&msg.id, *text_n);
            *text_n += 1;
            // What the app says about a turn, and the stand-in a wordless turn leaves, are not
            // speech: they get the quiet centred line, not a bubble with a toolbar on it.
            if !msg.is_me && (is_status_line(&text) || is_tool_standin(&text)) {
                rows.push(ChatRow {
                    // Red is for a turn that went wrong. A turn the person stopped went exactly
                    // as they asked, and a turn that never left did not go wrong either — it did
                    // not go — so both get the quiet grey the stand-ins get; painting either in
                    // the colour of a failure would send someone looking for what broke. A turn
                    // the app would not send while it had no session is the second of those: the
                    // red line about spend limits is exactly what this replaces.
                    status_failed: is_status_line(&text)
                        && text.trim() != STOPPED_TURN_NOTE
                        && !is_unsent_turn_note(&text),
                    status_retry: retryable.as_ref() == Some(&msg.id),
                    status_send_on_server: plan_failed.as_ref() == Some(&msg.id),
                    content: SharedString::from(text.clone()),
                    status_line: Some(text),
                    ..ChatRow::slot(id, msg.id.clone())
                });
                return;
            }
            rows.push(ChatRow {
                content: SharedString::from(text.clone()),
                is_me: msg.is_me,
                timestamp: SharedString::from(msg.formatted_time()),
                duration: SharedString::from(msg.formatted_duration().unwrap_or_default()),
                queued: msg.is_me && state.is_send_queued(&msg.id),
                waiting_for_mac: msg.is_me && state.is_send_waiting_for_mac(&msg.id),
                is_native_speaking,
                is_native_paused: state.native_tts.is_paused && is_native_speaking,
                is_native_loading: state.native_tts.is_loading && is_native_speaking,
                highlight_range: full_highlight.clone(),
                highlight_native,
                use_markdown: !msg.is_me && looks_like_markdown(&text),
                show_footer: true,
                tts_text: SharedString::from(text),
                reply_preview: reply_preview.clone(),
                caption: crate::state::routine_instruction_caption(conv, msg),
                reaction: state.message_reactions.get(&msg.id).cloned(),
                ..ChatRow::slot(id, msg.id.clone())
            });
        };
        for (at, part) in display.into_iter().enumerate() {
            match part {
                ChatPart::Text(text) => text_buf.push_str(&text),
                ChatPart::Step(_) | ChatPart::Reasoning(_) => {
                    flush_text(&mut rows, &mut text_buf, &mut text_n);
                    for run in runs.rows(at, part) {
                        let id = run.key().to_string();
                        rows.push(ChatRow {
                            run: Some(run),
                            ..ChatRow::slot(id, msg.id.clone())
                        });
                    }
                }
                ChatPart::Ui(spec) => {
                    flush_text(&mut rows, &mut text_buf, &mut text_n);
                    rows.push(ChatRow {
                        widget: Some(spec),
                        ..ChatRow::slot(format!("{}-ui-{ui_n}", msg.id), msg.id.clone())
                    });
                    ui_n += 1;
                }
                ChatPart::Screenshot(spec) => {
                    flush_text(&mut rows, &mut text_buf, &mut text_n);
                    if joins_previous_set(&rows, &msg.id) {
                        if let Some(last) = rows.last_mut() {
                            last.screenshots.push(spec);
                        }
                        continue;
                    }
                    rows.push(ChatRow {
                        screenshots: vec![spec],
                        ..ChatRow::slot(format!("{}-shot-{ui_n}", msg.id), msg.id.clone())
                    });
                    ui_n += 1;
                }
                ChatPart::Approval(spec) => {
                    flush_text(&mut rows, &mut text_buf, &mut text_n);
                    let outcome = state.approval_status_line(&spec, &bot_name);
                    rows.push(ChatRow {
                        content: SharedString::from(outcome.clone().unwrap_or_default()),
                        approval: outcome.is_none().then_some(spec),
                        status_line: outcome,
                        ..ChatRow::slot(format!("{}-ask-{ui_n}", msg.id), msg.id.clone())
                    });
                    ui_n += 1;
                }
                ChatPart::UserForm(spec) => {
                    flush_text(&mut rows, &mut text_buf, &mut text_n);
                    rows.push(ChatRow {
                        user_form: Some(spec),
                        ..ChatRow::slot(format!("{}-user-form-{ui_n}", msg.id), msg.id.clone())
                    });
                    ui_n += 1;
                }
                ChatPart::SaveLogin(spec) => {
                    flush_text(&mut rows, &mut text_buf, &mut text_n);
                    rows.push(ChatRow {
                        save_login: Some(spec),
                        ..ChatRow::slot(format!("{}-save-login-{ui_n}", msg.id), msg.id.clone())
                    });
                    ui_n += 1;
                }
                ChatPart::PluginNeeds(spec) => {
                    flush_text(&mut rows, &mut text_buf, &mut text_n);
                    rows.push(ChatRow {
                        plugin_needs: Some(spec),
                        ..ChatRow::slot(format!("{}-plugin-needs-{ui_n}", msg.id), msg.id.clone())
                    });
                    ui_n += 1;
                }
                ChatPart::OfficeDoc(spec) => {
                    flush_text(&mut rows, &mut text_buf, &mut text_n);
                    rows.push(ChatRow {
                        office_doc: Some(spec),
                        ..ChatRow::slot(format!("{}-office-{ui_n}", msg.id), msg.id.clone())
                    });
                    ui_n += 1;
                }
            }
        }
        flush_text(&mut rows, &mut text_buf, &mut text_n);
        // A reply's badge goes on its last row of words, once, where the reply ends. A reply that
        // said nothing but a status line has no bubble to wear one.
        if !msg.is_me
            && let Some(source) = msg.reply_source.as_ref()
            && let Some(row) = rows
                .iter_mut()
                .rev()
                .take_while(|row| row.source_id == msg.id)
                .find(|row| row.show_footer)
        {
            row.source_badge = Some(source.clone());
        }
        // Keep the total with the final row's metadata, whether it ends in words or a card.
        // Never attach a wordless message's total to the preceding message.
        if !msg.is_me
            && state.show_turn_timing
            && let Some(total) = msg
                .run_timing
                .as_ref()
                .and_then(crate::opengrok::TurnTiming::total_line)
            && let Some(last) = rows.last_mut().filter(|row| row.source_id == msg.id)
        {
            last.turn_total = Some(total.into());
            last.timestamp = msg.formatted_time().into();
            // The turn's measured total replaces the older wall-clock duration here.
            last.duration = "".into();
        }
        // A person's files go on their message's last row of words, under the bubble. A message
        // of files alone gets a row of its own that is otherwise a message like any other: its
        // time, its toolbar (reply, delete), its queued line (#136).
        if msg.is_me
            && let Some(files) = state.message_files.get(&msg.id)
            && !files.is_empty()
        {
            let last_words = rows
                .iter_mut()
                .rev()
                .take_while(|row| row.source_id == msg.id)
                .find(|row| row.show_footer);
            match last_words {
                Some(row) => row.files = files.clone(),
                None => {
                    let names = files
                        .iter()
                        .map(|file| file.filename.as_str())
                        .collect::<Vec<_>>()
                        .join(", ");
                    rows.push(ChatRow {
                        is_me: true,
                        // Read aloud says the names, and its button follows it as for words.
                        is_native_speaking,
                        is_native_paused: state.native_tts.is_paused && is_native_speaking,
                        is_native_loading: state.native_tts.is_loading && is_native_speaking,
                        timestamp: SharedString::from(msg.formatted_time()),
                        queued: state.is_send_queued(&msg.id),
                        waiting_for_mac: state.is_send_waiting_for_mac(&msg.id),
                        show_footer: true,
                        // What Copy puts on the clipboard and what is read aloud: the files'
                        // names, the only words a files-alone message has.
                        tts_text: SharedString::from(names),
                        reply_preview: reply_preview.clone(),
                        reaction: state.message_reactions.get(&msg.id).cloned(),
                        files: files.clone(),
                        ..ChatRow::slot(text_row_id(&msg.id, 0), msg.id.clone())
                    });
                }
            }
        }
    }
    Arc::new(rows)
}

/// The rows the transcript is showing, kept the way `ChatTranscript`'s observer keeps them, for
/// a test that drives a thread from `state.rs`: taken again from the state only when
/// [`ChatFeedRev`] has moved. That rule decides what reaches the screen, so a change the
/// fingerprint does not see is one the person never sees, however true it is in the state.
#[cfg(test)]
pub(crate) struct ShownFeed {
    rev: ChatFeedRev,
    rows: Arc<Vec<ChatRow>>,
}

#[cfg(test)]
impl ShownFeed {
    pub(crate) fn of(state: &AppState) -> Self {
        Self {
            rev: ChatFeedRev::from_state(state),
            rows: snapshot_rows(state),
        }
    }

    /// The state notified: the observer either returns early or takes the rows again.
    pub(crate) fn observe(&mut self, state: &AppState) {
        let rev = ChatFeedRev::from_state(state);
        if rev != self.rev {
            self.rev = rev;
            self.rows = snapshot_rows(state);
        }
    }

    /// The words on screen, one entry per row that has any: whose message the row is, what it
    /// says, and whether it wears the queued line.
    pub(crate) fn words(&self) -> Vec<(String, String, bool)> {
        self.rows
            .iter()
            .filter(|row| !row.content.is_empty())
            .map(|row| (row.source_id.clone(), row.content.to_string(), row.queued))
            .collect()
    }
}

#[derive(Clone)]
struct ChatPalette {
    primary: Hsla,
    primary_foreground: Hsla,
    secondary: Hsla,
    secondary_foreground: Hsla,
    yellow: Hsla,
    green: Hsla,
    danger: Hsla,
}

impl ChatPalette {
    fn from_cx(cx: &App) -> Self {
        let theme = cx.theme();
        Self {
            primary: theme.primary,
            primary_foreground: theme.primary_foreground,
            secondary: theme.secondary,
            secondary_foreground: theme.secondary_foreground,
            yellow: theme.yellow,
            green: theme.green,
            danger: theme.danger,
        }
    }
}

/// The air the transcript keeps at either end: above the first bubble, and between the last
/// one and the composer floating over it, on top of the composer's own height.
///
/// `MessageScroller` gave its list this much as `py_2`. The transcript's own scroller gives its
/// list none, and the rows carry it instead, because the list must have no padding at all. GPUI
/// measures the list's scroll twice and only one of the two counts that padding: the wheel
/// reads the offset in the items' own space, where the floor is `items + padding - viewport`,
/// while the mask that turns the wheel into an offset clamps against `items - viewport` and
/// writes the clamped value back. Room held in the padding is therefore a teleport of exactly
/// that much on the first scroll away from the bottom. Room held inside a row is part of
/// `items` and both readings agree.
const TRANSCRIPT_EDGE_GAP: f32 = 8.0;

/// The room a row keeps beneath itself, which only the last one has any of.
///
/// The composer floats over the transcript's bottom, so the final bubble has to be able to
/// come to rest above it rather than under it, and that room has to be part of the row's own
/// measured height — see [`TRANSCRIPT_EDGE_GAP`] for why it cannot be the list's padding.
fn tail_room(ix: usize, row_count: usize, composer_height: Pixels) -> Option<Pixels> {
    (row_count > 0 && ix + 1 == row_count).then(|| composer_height + px(TRANSCRIPT_EDGE_GAP))
}

struct ChatTranscript {
    app_state: Entity<AppState>,
    input: Entity<MessageInput>,
    /// The list, and whether it keeps to the newest row: the person's decision, never the
    /// list's (see `transcript_scroll`).
    scroll: TranscriptScroll,
    rows: Arc<Vec<ChatRow>>,
    feed_rev: ChatFeedRev,
    last_conversation_id: Option<String>,
    debug_mode: bool,
    can_read_aloud: bool,
    palette: ChatPalette,
    highlight_pump: bool,
    ts_peek: f32,
    peek_epoch: u64,
    find_query: String,
    find_hits: Vec<FindHit>,
    find_current: Option<usize>,
    /// How tall the composer floating over the transcript's bottom stands right now, as the
    /// composer itself last measured it (see `ChatView::render`). Zero until that first
    /// measurement lands, which is one frame.
    composer_height: Pixels,
    user_form_inputs: UserFormInputMap,
    user_form_textareas: UserFormTextareaMap,
}

impl ChatTranscript {
    fn new(state: Entity<AppState>, input: Entity<MessageInput>, cx: &mut Context<Self>) -> Self {
        let (rows, feed_rev, debug_mode, can_read_aloud, last_conversation_id) = {
            let app = state.read(cx);
            let feed_rev = ChatFeedRev::from_state(app);
            (
                snapshot_rows(app),
                feed_rev.clone(),
                feed_rev.debug_mode,
                feed_rev.can_read_aloud,
                app.active_conversation_id.clone(),
            )
        };
        let scroll = TranscriptScroll::new(rows.len());
        cx.observe(&state, |this, state, cx| {
            let (feed, rows) = {
                let app = state.read(cx);
                let feed = ChatFeedRev::from_state(app);
                if this.feed_rev == feed {
                    // The rows are the same, but a run of this very thread may have been asked
                    // for from the routine's Run history.
                    this.reveal_asked_run(&state, cx);
                    return;
                }
                (feed, snapshot_rows(app))
            };
            let thread_opened = this.feed_rev.conversation_id != feed.conversation_id;
            let change = RowsChange {
                thread_opened,
                steps_toggled: !thread_opened
                    && (this.feed_rev.expanded_steps != feed.expanded_steps
                        || this.feed_rev.clocks != feed.clocks
                        || this.feed_rev.show_turn_timing != feed.show_turn_timing),
                responding: feed.is_ai_responding,
            };
            let old = std::mem::replace(&mut this.rows, rows);
            this.debug_mode = feed.debug_mode;
            this.can_read_aloud = feed.can_read_aloud;
            this.last_conversation_id = feed.conversation_id.clone();
            this.palette = ChatPalette::from_cx(cx);
            this.feed_rev = feed;
            apply_rows(&mut this.scroll, &old, &this.rows, change);
            this.publish_tail(cx);
            if this.feed_rev.native_speaking_id.is_some() {
                this.start_highlight_pump(cx);
            }
            this.recompute_find(false, cx);
            this.reveal_asked_run(&state, cx);
            cx.notify();
        })
        .detach();

        let mut this = Self {
            app_state: state,
            input,
            scroll,
            rows,
            feed_rev,
            last_conversation_id,
            debug_mode,
            can_read_aloud,
            palette: ChatPalette::from_cx(cx),
            highlight_pump: false,
            ts_peek: 0.0,
            peek_epoch: 0,
            find_query: String::new(),
            find_hits: Vec::new(),
            find_current: None,
            composer_height: px(0.),
            user_form_inputs: HashMap::new(),
            user_form_textareas: HashMap::new(),
        };
        if this.feed_rev.native_speaking_id.is_some() {
            this.start_highlight_pump(cx);
        }
        this
    }

    /// The composer floats over the transcript's bottom, so the rows have to come to rest a
    /// composer's height above the pane's floor: a last bubble that stopped at the floor
    /// would be read through the pill, and no amount of scrolling could free it. The composer
    /// measures itself and tells us, because how tall it stands is the draft's business — a
    /// second line, a recipe bar or the working line each move it.
    fn set_composer_height(&mut self, height: Pixels, cx: &mut Context<Self>) {
        // Every layout pass the composer takes reports again, and each notify buys another
        // frame: only a height that has really moved is worth one. Half a pixel is under what
        // a row can show and over what rounding can invent.
        if (self.composer_height - height).abs() < px(0.5) {
            return;
        }
        self.composer_height = height;
        // The room belongs to the last row's own height, so the list is holding a measurement
        // of that row taken against the composer as it used to stand. Nothing else about the
        // row changed, so only that one is worth taking again.
        if let Some(last) = self.scroll.item_count().checked_sub(1) {
            self.scroll.remeasure_items(last..last + 1);
        }
        cx.notify();
    }

    /// Say whether the transcript follows its newest row, for a driver (see
    /// [`AppState::transcript_following`]).
    fn publish_tail(&self, cx: &mut Context<Self>) {
        let following = self.scroll.is_following();
        self.app_state
            .update(cx, |state, _| state.set_transcript_following(following));
    }

    fn set_find_query(&mut self, query: String, cx: &mut Context<Self>) {
        if self.find_query == query {
            return;
        }
        self.find_query = query;
        self.recompute_find(true, cx);
    }

    fn step_find(&mut self, delta: i32, cx: &mut Context<Self>) {
        if self.find_hits.is_empty() {
            return;
        }
        let len = self.find_hits.len() as i32;
        let index = match self.find_current {
            Some(current) => (current as i32 + delta).rem_euclid(len) as usize,
            None if delta < 0 => self.find_hits.len() - 1,
            None => 0,
        };
        self.find_current = Some(index);
        self.scroll_to_hit(index, cx);
        cx.notify();
    }

    fn clear_find(&mut self, cx: &mut Context<Self>) {
        self.find_query.clear();
        self.find_hits.clear();
        self.find_current = None;
        cx.notify();
    }

    fn find_status(&self) -> (Option<usize>, usize, bool) {
        (
            self.find_current,
            self.find_hits.len(),
            !self.find_query.trim().is_empty(),
        )
    }

    fn recompute_find(&mut self, land: bool, cx: &mut Context<Self>) {
        let hits = project_hits(
            self.rows.iter().map(|row| row.content.as_ref()),
            &self.find_query,
        );
        if hits.is_empty() {
            self.find_hits = hits;
            self.find_current = None;
            cx.notify();
            return;
        }
        if land {
            self.find_current = Some(0);
        } else if let Some(current) = self.find_current {
            if current >= hits.len() {
                self.find_current = Some(hits.len() - 1);
            }
        } else {
            self.find_current = Some(0);
        }
        self.find_hits = hits;
        if land && let Some(index) = self.find_current {
            self.scroll_to_hit(index, cx);
        }
        cx.notify();
    }

    /// Bring the routine's run that the person asked for from its Run history into view, once the
    /// open thread has a row of it. A thread rebuilt from the server may not have it the first
    /// time its rows are taken, so this is asked again each time they change; it is let go once
    /// shown, or once the person is in another thread.
    fn reveal_asked_run(&mut self, state: &Entity<AppState>, cx: &mut Context<Self>) {
        let Some((thread_id, run_id)) = state.read(cx).reveal_run.clone() else {
            return;
        };
        if self.last_conversation_id.as_deref() != Some(thread_id.as_str()) {
            state.update(cx, |state, _| state.reveal_run = None);
            return;
        }
        let Some(row) = run_row(&self.rows, &run_id) else {
            return;
        };
        // Going to a run is the person going somewhere in the thread, as going to a find hit is.
        self.scroll.scroll_to_item(row);
        self.scroll.remeasure_items(row..row + 1);
        self.publish_tail(cx);
        state.update(cx, |state, _| state.reveal_run = None);
        cx.notify();
    }

    fn scroll_to_hit(&mut self, index: usize, cx: &mut Context<Self>) {
        let Some(hit) = self.find_hits.get(index) else {
            return;
        };
        let row = hit.row;
        // Going to a hit is the person going somewhere in the thread, so the transcript lets
        // go of the newest row there, as it does for a step up.
        self.scroll.scroll_to_item(row);
        self.scroll.remeasure_items(row..row + 1);
        self.publish_tail(cx);
    }

    fn arm_peek_release(&mut self, cx: &mut Context<Self>) {
        self.peek_epoch = self.peek_epoch.wrapping_add(1);
        let epoch = self.peek_epoch;
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(90))
                .await;
            let _ = this.update(cx, |this, cx| {
                if this.peek_epoch != epoch {
                    return;
                }
                this.ts_peek = 0.0;
                cx.notify();
            });
        })
        .detach();
    }

    /// Whether a wheel event is the timestamp gesture: a sideways swipe, or any sideways
    /// movement while the timestamps are already peeking. Decided in the CAPTURE phase, before
    /// the list underneath sees the event — the list scrolls by the vertical part of whatever
    /// reaches it, which is what made a sideways swipe creep up and down.
    fn is_peek_gesture(&self, dx: f32, dy: f32) -> bool {
        if self.ts_peek > 0.0 {
            dx.abs() > 0.5
        } else {
            dx.abs() > dy.abs() && dx.abs() >= 1.5
        }
    }

    /// Move the timestamp peek by a swipe. Natural scrolling: fingers moving left give a
    /// negative dx, and that is the swipe that reveals — the bubbles slide left to make room, as
    /// on the phone. So the peek grows with `-dx`.
    fn peek_by(&mut self, dx: f32, window: &Window, cx: &mut Context<Self>) {
        let win = f32::from(window.viewport_size().width);
        let app = self.app_state.read(cx);
        let chat_w = chat_column_width(
            win,
            app.sidebar_hidden,
            app.sidebar_collapsed,
            app.sidebar_expanded_width,
            app.right_pane != crate::state::RightPane::Closed,
        );
        if !timestamps_fit(chat_w) {
            return;
        }
        self.ts_peek = (self.ts_peek - dx).clamp(0.0, TS_PEEK_MAX);
        self.arm_peek_release(cx);
        cx.notify();
    }

    /// Tick highlight on this view only. Do not notify AppState (that dirties the window).
    fn start_highlight_pump(&mut self, cx: &mut Context<Self>) {
        if self.highlight_pump {
            return;
        }
        self.highlight_pump = true;
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(30))
                    .await;
                let keep = this
                    .update(cx, |this, cx| {
                        let app = this.app_state.read(cx);
                        let speaking = app.native_tts.message_id.is_some();
                        let feed = ChatFeedRev::from_state(app);
                        if this.feed_rev != feed {
                            this.rows = snapshot_rows(app);
                            this.feed_rev = feed;
                            cx.notify();
                        }
                        if !speaking {
                            this.highlight_pump = false;
                        }
                        speaking
                    })
                    .unwrap_or(false);
                if !keep {
                    break;
                }
            }
        })
        .detach();
    }

    fn sync_user_form_fields(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let mut needed: HashMap<String, (bool, bool, Option<String>, Option<String>)> =
            HashMap::new();
        for row in self.rows.iter() {
            let Some(spec) = &row.user_form else {
                continue;
            };
            // Keep the typed values through Sending and FillFailed. These inputs
            // are what "Try again" re-posts, and clearing them the moment a
            // submit went out meant the retry after a failed fill left with
            // the password gone.
            let live = spec.is_unresolved()
                || matches!(
                    spec.effective_resolution(),
                    Some(
                        crate::opengrok::FormResolution::Sending
                            | crate::opengrok::FormResolution::FillFailed
                    )
                );
            if !live {
                continue;
            }
            for field in &spec.fields {
                match field.kind {
                    crate::opengrok::UserFormFieldKind::Checkbox
                    | crate::opengrok::UserFormFieldKind::Select => {}
                    crate::opengrok::UserFormFieldKind::Textarea => {
                        needed.insert(
                            field_key(spec.card_key(), &field.id),
                            (
                                true,
                                field.masked(),
                                field.placeholder.clone(),
                                field.prefill.clone(),
                            ),
                        );
                    }
                    _ => {
                        needed.insert(
                            field_key(spec.card_key(), &field.id),
                            (
                                false,
                                field.masked(),
                                field.placeholder.clone(),
                                field.prefill.clone(),
                            ),
                        );
                    }
                }
            }
        }
        self.user_form_inputs
            .retain(|key, _| needed.get(key).is_some_and(|(textarea, _, _, _)| !textarea));
        self.user_form_textareas
            .retain(|key, _| needed.get(key).is_some_and(|(textarea, _, _, _)| *textarea));
        for (key, (textarea, masked, placeholder, prefill)) in needed {
            if textarea {
                if self.user_form_textareas.contains_key(&key) {
                    continue;
                }
                let placeholder = placeholder.unwrap_or_default();
                let prefill = prefill.unwrap_or_default();
                let state = cx.new(|cx| {
                    let mut state = TextareaState::new(window, cx);
                    if !placeholder.is_empty() {
                        state = state.placeholder(placeholder);
                    }
                    if !prefill.is_empty() {
                        state = state.default_value(prefill);
                    }
                    state
                });
                cx.subscribe(&state, |_, _, event: &InputEvent, cx| {
                    if matches!(event, InputEvent::Change) {
                        cx.notify();
                    }
                })
                .detach();
                self.user_form_textareas.insert(key, state);
            } else if !self.user_form_inputs.contains_key(&key) {
                let placeholder = placeholder.unwrap_or_default();
                let prefill = prefill.unwrap_or_default();
                let state = cx.new(|cx| {
                    let mut state = InputState::new(window, cx);
                    if !placeholder.is_empty() {
                        state = state.placeholder(placeholder);
                    }
                    if masked {
                        state = state.masked(true);
                    }
                    if !prefill.is_empty() {
                        state = state.default_value(prefill);
                    }
                    state
                });
                let app_state = self.app_state.clone();
                let field = key.clone();
                cx.subscribe(&state, move |_, _, event: &InputEvent, cx| {
                    match event {
                        InputEvent::Change => cx.notify(),
                        // Back in the field the accounts belong to: the list the person
                        // clicked away from comes back, the way autofill does.
                        InputEvent::Focus => {
                            if let Some((card_key, field_id)) = field.split_once('\u{1f}') {
                                let (card_key, field_id) =
                                    (card_key.to_string(), field_id.to_string());
                                app_state.update(cx, |state, cx| {
                                    state.open_saved_login_list(card_key, &field_id, cx);
                                });
                            }
                            cx.notify();
                        }
                        _ => {}
                    }
                })
                .detach();
                self.user_form_inputs.insert(key, state);
            }
        }
    }
}

impl Render for ChatTranscript {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_user_form_fields(window, cx);
        // The scrollbar moves the list without telling anyone. What it did is read here, before
        // the list is laid out again, and only a drag of it can take the newest row back.
        if self.scroll.sync_frame() {
            self.publish_tail(cx);
        }
        let rows = self.rows.clone();
        let app_state = self.app_state.clone();
        let user_form_inputs = self.user_form_inputs.clone();
        let user_form_textareas = self.user_form_textareas.clone();
        let input = self.input.clone();
        let debug_mode = self.debug_mode;
        let can_read_aloud = self.can_read_aloud;
        let palette = self.palette.clone();
        let picker_id = self
            .app_state
            .read(cx)
            .emoji_picker
            .as_ref()
            .map(|p| p.message_id.clone());
        let ts_peek = self.ts_peek;
        let find_hits = self.find_hits.clone();
        let find_current = self.find_current;
        let composer_height = self.composer_height;
        let timestamps_ok = {
            let win = f32::from(window.viewport_size().width);
            let app = self.app_state.read(cx);
            timestamps_fit(chat_column_width(
                win,
                app.sidebar_hidden,
                app.sidebar_collapsed,
                app.sidebar_expanded_width,
                app.right_pane != crate::state::RightPane::Closed,
            ))
        };
        div()
            .id("chat-timestamp-peek")
            .size_full()
            .relative()
            // The gesture is taken in the capture phase over the whole transcript, so a
            // sideways swipe never reaches the list (no vertical creep) while a vertical one
            // passes through untouched. A canvas is the one element that can register a
            // capture-phase mouse handler from here.
            .child({
                let this = cx.entity().downgrade();
                gpui::canvas(
                    |_, _, _| (),
                    move |bounds, _, window, _cx| {
                        let this = this.clone();
                        window.on_mouse_event(
                            move |event: &ScrollWheelEvent, phase, window, cx| {
                                if phase != gpui::DispatchPhase::Capture
                                    || !bounds.contains(&event.position)
                                {
                                    return;
                                }
                                let Some(this) = this.upgrade() else {
                                    return;
                                };
                                let delta = event.delta.pixel_delta(px(16.));
                                let dx = f32::from(delta.x);
                                let dy = f32::from(delta.y);
                                if !this.read(cx).is_peek_gesture(dx, dy) {
                                    return;
                                }
                                this.update(cx, |this, cx| this.peek_by(dx, window, cx));
                                cx.stop_propagation();
                            },
                        );
                    },
                )
                .absolute()
                .inset_0()
            })
            .child(
                TranscriptScroller::new(
                    "chat-messages",
                    // The list, and whether it keeps to the newest row (see `transcript_scroll`).
                    &self.scroll,
                    move |ix, window, cx| {
                        // Every row is laid out in the same centred column the transcript used to
                        // sit in, so bubbles and timestamps do not move — only the scrollbar did.
                        let row_body = |ix: usize,
                                        _window: &mut Window,
                                        cx: &mut App|
                         -> AnyElement {
                            let Some(row) = rows.get(ix) else {
                                return div().into_any_element();
                            };
                            if let Some(run) = &row.run {
                                return div()
                                    .id(ElementId::Name(row.id.clone().into()))
                                    .w_full()
                                    .flex()
                                    .justify_start()
                                    .py(px(1.))
                                    .child(render_run_row(run, app_state.clone(), cx))
                                    .into_any_element();
                            }
                            if let Some(spec) = &row.widget {
                                return div()
                                    .id(ElementId::Name(row.id.clone().into()))
                                    .w_full()
                                    .flex()
                                    .justify_start()
                                    .py(px(6.))
                                    .child(div().w_full().max_w(px(CHAT_CONTENT_MAX * 0.72)).child(
                                        render_ui_spec(
                                            spec,
                                            &row.source_id,
                                            Some(app_state.clone()),
                                            cx,
                                        ),
                                    ))
                                    .into_any_element();
                            }
                            if !row.screenshots.is_empty() {
                                return div()
                                    .id(ElementId::Name(row.id.clone().into()))
                                    .w_full()
                                    .flex()
                                    .justify_start()
                                    .py(px(6.))
                                    .child(render_screenshots(
                                        &row.screenshots,
                                        Some(app_state.clone()),
                                        cx,
                                    ))
                                    .into_any_element();
                            }
                            if let Some(line) = &row.status_line {
                                // A run that failed said nothing the person can act on: the line
                                // that explains it is worth seeing, not worth reading as speech.
                                let color = if row.status_failed {
                                    palette.danger
                                } else {
                                    palette.secondary_foreground.opacity(0.7)
                                };
                                // A failed turn is one quiet line: the whole sentence is in the
                                // Bot's notifications, a click away, and Copy takes it as it is
                                // (8 Oct 2026: the line could be neither dismissed nor selected).
                                let failed_turn = row.status_failed
                                    && line.trim().starts_with(crate::state::RUN_ERROR_PREFIX);
                                let shown = if failed_turn {
                                    TURN_FAILED.to_string()
                                } else {
                                    line.clone()
                                };
                                let full = line.clone();
                                return div()
                                    .id(ElementId::Name(row.id.clone().into()))
                                    .w_full()
                                    .flex()
                                    .justify_center()
                                    .items_center()
                                    .gap(px(8.))
                                    .py(px(8.))
                                    .child(div().text_sm().text_color(color).child(shown))
                                    .when(failed_turn, |this| {
                                        let open = app_state.clone();
                                        let copy = full.clone();
                                        this.child(
                                            div()
                                                .id(SharedString::from(format!(
                                                    "turn-failed-details-{}",
                                                    row.source_id
                                                )))
                                                .text_sm()
                                                .text_color(palette.primary)
                                                .cursor_pointer()
                                                .on_mouse_down(
                                                    MouseButton::Left,
                                                    move |_, _, cx| {
                                                        open.update(cx, |state, cx| {
                                                            let bot =
                                                                state.active_coworker_id.clone();
                                                            state.open_notifications_for(bot, cx);
                                                        });
                                                    },
                                                )
                                                .child("Details"),
                                        )
                                        .child(
                                            div()
                                                .id(SharedString::from(format!(
                                                    "turn-failed-copy-{}",
                                                    row.source_id
                                                )))
                                                .text_sm()
                                                .text_color(palette.primary)
                                                .cursor_pointer()
                                                .on_mouse_down(
                                                    MouseButton::Left,
                                                    move |_, _, cx| {
                                                        cx.write_to_clipboard(
                                                            ClipboardItem::new_string(copy.clone()),
                                                        );
                                                    },
                                                )
                                                .child("Copy"),
                                        )
                                    })
                                    // A turn that never left is the one status line worth
                                    // answering: retyping the message was the only way back
                                    // from it, and the message is still right there.
                                    .when(row.status_retry, |this| {
                                        let state = app_state.clone();
                                        this.child(
                                            div()
                                                .id("retry-turn")
                                                .text_sm()
                                                .text_color(palette.primary)
                                                .cursor_pointer()
                                                .on_mouse_down(
                                                    MouseButton::Left,
                                                    move |_, _, cx| {
                                                        state.update(cx, |state, cx| {
                                                            state.retry_turn(cx);
                                                        });
                                                    },
                                                )
                                                .child("Try again"),
                                        )
                                    })
                                    // A turn the person's plan could not answer: the sentence says
                                    // why, and the turn can go again on the server's paid keys,
                                    // this once, without the person's message sent twice.
                                    .when(row.status_send_on_server, |this| {
                                        let state = app_state.clone();
                                        this.child(
                                            div()
                                                .id(SEND_ON_SERVER)
                                                .text_sm()
                                                .text_color(palette.primary)
                                                .cursor_pointer()
                                                .on_mouse_down(
                                                    MouseButton::Left,
                                                    move |_, _, cx| {
                                                        state.update(cx, |state, cx| {
                                                            state.send_on_server(cx);
                                                        });
                                                    },
                                                )
                                                .child(SEND_ON_SERVER_LABEL),
                                        )
                                    })
                                    .into_any_element();
                            }
                            if let Some(spec) = &row.approval {
                                return div()
                                    .id(ElementId::Name(row.id.clone().into()))
                                    .w_full()
                                    .flex()
                                    .justify_start()
                                    .py(px(6.))
                                    .child(div().w_full().max_w(px(560.)).child(render_approval(
                                        spec,
                                        Some(app_state.clone()),
                                        cx,
                                    )))
                                    .into_any_element();
                            }
                            if let Some(spec) = &row.user_form {
                                let picks = app_state
                                    .read(cx)
                                    .user_form_picks
                                    .get(spec.card_key())
                                    .cloned()
                                    .unwrap_or_default();
                                let mut values = UserFormValues { by_id: picks };
                                for field in &spec.fields {
                                    if values.by_id.contains_key(&field.id) {
                                        continue;
                                    }
                                    let key = field_key(spec.card_key(), &field.id);
                                    let raw = if let Some(state) = user_form_textareas.get(&key) {
                                        Some(state.read(cx).value().to_string())
                                    } else {
                                        user_form_inputs
                                            .get(&key)
                                            .map(|state| state.read(cx).value().to_string())
                                    };
                                    let Some(raw) = raw else {
                                        continue;
                                    };
                                    // Secrets stay in InputState. Do not put a presence stub
                                    // in this map: Continue reads live InputState, and a
                                    // non-empty stub would look like a filled password.
                                    if field.masked() {
                                        continue;
                                    }
                                    if raw.trim().is_empty() {
                                        continue;
                                    }
                                    values.by_id.insert(field.id.clone(), raw);
                                }
                                return div()
                                    .id(ElementId::Name(row.id.clone().into()))
                                    .w_full()
                                    .flex()
                                    .justify_start()
                                    .py(px(6.))
                                    .child(div().w_full().max_w(px(560.)).child(render_user_form(
                                        spec,
                                        &user_form_inputs,
                                        &user_form_textareas,
                                        &values,
                                        Some(app_state.clone()),
                                        cx,
                                    )))
                                    .into_any_element();
                            }
                            if let Some(spec) = &row.plugin_needs {
                                return div()
                                    .id(ElementId::Name(row.id.clone().into()))
                                    .w_full()
                                    .flex()
                                    .justify_start()
                                    .py(px(6.))
                                    .child(div().w_full().max_w(px(560.)).child(
                                        crate::components::plugin_needs::render_plugin_needs(
                                            spec,
                                            &row.source_id,
                                            app_state.clone(),
                                            cx,
                                        ),
                                    ))
                                    .into_any_element();
                            }
                            if let Some(spec) = &row.office_doc {
                                return div()
                                    .id(ElementId::Name(row.id.clone().into()))
                                    .w_full()
                                    .flex()
                                    .justify_start()
                                    .py(px(6.))
                                    .child(div().w_full().max_w(px(560.)).child(
                                        crate::components::office_doc::render_office_doc_card(
                                            spec,
                                            &row.source_id,
                                            app_state.clone(),
                                            cx,
                                        ),
                                    ))
                                    .into_any_element();
                            }
                            if let Some(spec) = &row.save_login {
                                return div()
                                    .id(ElementId::Name(row.id.clone().into()))
                                    .w_full()
                                    .flex()
                                    .justify_start()
                                    .py(px(6.))
                                    .child(div().w_full().max_w(px(560.)).child(render_save_login(
                                        spec,
                                        app_state.clone(),
                                        cx,
                                    )))
                                    .into_any_element();
                            }
                            let highlight_color = if row.highlight_range.is_some() {
                                if row.highlight_native {
                                    Some(palette.yellow.opacity(0.4))
                                } else {
                                    Some(palette.green.opacity(0.4))
                                }
                            } else {
                                None
                            };
                            let (bg_color, text_color) = if row.is_me {
                                (palette.primary, palette.primary_foreground)
                            } else {
                                (palette.secondary, palette.secondary_foreground)
                            };
                            let state_entity = app_state.clone();
                            let source_id = row.source_id.clone();
                            let tts_text = row.tts_text.to_string();
                            let show_footer = row.show_footer;
                            let picker_open = picker_id.as_ref() == Some(&row.source_id);
                            let mut bubble = MessageBubble::new(row.content.to_string())
                                .message_id(row.id.clone())
                                .source_id(row.source_id.clone())
                                .is_me(row.is_me)
                                .bg_color(bg_color)
                                .text_color(text_color)
                                .timestamp(row.timestamp.to_string())
                                .duration(row.duration.to_string())
                                .turn_total(row.turn_total.as_ref().map(ToString::to_string))
                                .debug_mode(debug_mode)
                                .can_read_aloud(can_read_aloud && show_footer)
                                .is_native_speaking(row.is_native_speaking)
                                .is_native_paused(row.is_native_paused)
                                .is_native_loading(row.is_native_loading)
                                .is_ai_speaking(row.is_ai_speaking)
                                .is_ai_paused(row.is_ai_paused)
                                .is_ai_loading(row.is_ai_loading)
                                .is_cached(row.is_cached)
                                .queued(row.queued)
                                .waiting_for_mac(row.waiting_for_mac)
                                .files(row.files.clone())
                                .source_badge(row.source_badge.clone())
                                .highlight_range(row.highlight_range.clone())
                                .highlight_color(highlight_color)
                                .find_marks(marks_for_row(ix, &find_hits, find_current))
                                .use_markdown(row.use_markdown)
                                .show_footer(show_footer)
                                .reply_preview(row.reply_preview.clone())
                                .caption(row.caption.clone())
                                .reaction(row.reaction.clone())
                                .picker_open(picker_open)
                                .ts_peek(ts_peek)
                                .timestamps_ok(timestamps_ok)
                                .app_state(app_state.clone());
                            if show_footer {
                                let state_for_tts = state_entity.clone();
                                let source_for_tts = source_id.clone();
                                let tts = tts_text.clone();
                                bubble = bubble.copy_text(tts_text.clone()).on_read_aloud(
                                    move |_, cx| {
                                        state_for_tts.update(cx, |state, cx| {
                                            state.toggle_read_aloud(
                                                source_for_tts.clone(),
                                                tts.clone(),
                                                crate::actions::TtsSource::Native,
                                                cx,
                                            );
                                        });
                                    },
                                );
                                let input = input.clone();
                                bubble = bubble.on_reply(move |window, cx| {
                                    input.update(cx, |input, cx| {
                                        input.focus(window, cx);
                                    });
                                });
                            }
                            bubble.into_any_element()
                        };
                        let row = &rows[ix];
                        let body = row_body(ix, window, cx);
                        let body = if !row.show_footer
                            && let Some(total) = &row.turn_total
                        {
                            let peek = TimestampPeek::new(ts_peek, timestamps_ok);
                            div()
                                .relative()
                                .w_full()
                                .child(div().w_full().ml(px(-peek.shift)).child(body))
                                .child(peek.rail(turn_metadata(&row.timestamp, total, cx)))
                                .into_any_element()
                        } else {
                            body
                        };
                        div()
                            .w_full()
                            .flex()
                            .justify_center()
                            .px_4()
                            .pb(transcript_row_gap(&rows[ix], rows.get(ix + 1)))
                            // The transcript's own edges, carried by the rows that sit against
                            // them rather than by the list's padding (see `tail_room`).
                            .when(ix == 0, |this| {
                                this.pt(px(crate::chrome::TITLE_BAR_H + TRANSCRIPT_EDGE_GAP))
                            })
                            .when_some(tail_room(ix, rows.len(), composer_height), |this, room| {
                                this.pb(room)
                            })
                            .child(div().w_full().max_w(px(CHAT_CONTENT_MAX)).child(body))
                    },
                )
                // Only the first row reserves room for the floating header; scrolled
                // messages use the full viewport behind its fade.
                // The chevron belongs over the chat, not behind the composer, so lift it off
                // the scroller's floor by exactly what the composer covers; the rem the
                // scroller already holds it by then reads from the composer's top edge.
                .jump_lift(composer_height)
                // Every step of the wheel is heard before the list moves by it: a step toward
                // older messages lets go of the newest row, however small, and only the person
                // takes it back (see `transcript_scroll`).
                .on_wheel({
                    let this = cx.entity().downgrade();
                    move |event, line_height, _, cx| {
                        let Some(this) = this.upgrade() else {
                            return;
                        };
                        this.update(cx, |this, cx| {
                            if this.scroll.wheel(event, line_height) {
                                this.publish_tail(cx);
                                cx.notify();
                            }
                        });
                    }
                })
                .on_jump({
                    let this = cx.entity().downgrade();
                    move |_, cx| {
                        let Some(this) = this.upgrade() else {
                            return;
                        };
                        this.update(cx, |this, cx| {
                            this.scroll.follow();
                            this.publish_tail(cx);
                            cx.notify();
                        });
                    }
                }),
            )
    }
}

pub struct ChatView {
    input: Entity<MessageInput>,
    state: Entity<AppState>,
    transcript: Entity<ChatTranscript>,
    last_conversation_id: Option<String>,
    bot_status: Option<String>,
    coworker_name: Option<String>,
    coworker_id: Option<String>,
    coworker_shape: Option<String>,
    coworker_color: Option<String>,
    emoji_search: Entity<InputState>,
    emoji_query: String,
    emoji_full: bool,
    emoji_category: usize,
    emoji_open: Option<EmojiPickerOpen>,
    find_open: bool,
    find_input: Entity<InputState>,
    find_pending_focus: bool,
}

impl ChatView {
    pub fn focus_input(&self, window: &mut Window, cx: &mut Context<Self>) {
        self.input.update(cx, |input, cx| {
            input.focus(window, cx);
        });
    }

    /// The find bar, while a search is open: the title bar shows it in the chat's header.
    pub fn find_bar(&self, view: Entity<Self>, cx: &App) -> Option<AnyElement> {
        if !self.find_open {
            return None;
        }
        let (find_current, find_total, find_has_query) = self.transcript.read(cx).find_status();
        Some(
            find_bar_element(
                &self.find_input,
                find_current,
                find_total,
                find_has_query,
                {
                    let view = view.clone();
                    move |_, cx| {
                        view.update(cx, |this, cx| this.find_prev(cx));
                    }
                },
                {
                    let view = view.clone();
                    move |_, cx| {
                        view.update(cx, |this, cx| this.find_next(cx));
                    }
                },
                move |window, cx| {
                    view.update(cx, |this, cx| {
                        this.close_find(window, cx);
                    });
                },
                cx,
            )
            .into_any_element(),
        )
    }

    pub fn open_find(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.find_open = true;
        self.find_pending_focus = true;
        cx.notify();
    }

    pub fn close_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.find_open && self.find_input.read(cx).value().is_empty() {
            return;
        }
        self.find_open = false;
        self.find_pending_focus = false;
        self.find_input.update(cx, |input, cx| {
            input.set_value("", window, cx);
        });
        self.transcript.update(cx, |transcript, cx| {
            transcript.clear_find(cx);
        });
        cx.notify();
    }

    pub fn find_next(&mut self, cx: &mut Context<Self>) {
        if !self.find_open {
            self.find_open = true;
            self.find_pending_focus = true;
            cx.notify();
            return;
        }
        self.transcript.update(cx, |transcript, cx| {
            transcript.step_find(1, cx);
        });
        cx.notify();
    }

    pub fn find_prev(&mut self, cx: &mut Context<Self>) {
        if !self.find_open {
            self.find_open = true;
            self.find_pending_focus = true;
            cx.notify();
            return;
        }
        self.transcript.update(cx, |transcript, cx| {
            transcript.step_find(-1, cx);
        });
        cx.notify();
    }

    fn render_emoji_overlay(
        &self,
        open: EmojiPickerOpen,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let app = self.state.clone();
        let search = self.emoji_search.clone();
        let query = self.emoji_query.clone();
        let category = self.emoji_category;
        let full = self.emoji_full;
        let view = cx.entity();
        let panel = if full {
            full_picker(
                app.clone(),
                open.message_id.clone(),
                search,
                query,
                category,
                Rc::new({
                    let view = view.clone();
                    move |ix, cx| {
                        view.update(cx, |this, cx| {
                            this.emoji_category = ix;
                            this.emoji_query.clear();
                            cx.notify();
                        });
                    }
                }),
                cx,
            )
            .into_any_element()
        } else {
            reaction_strip(
                app.clone(),
                open.message_id.clone(),
                Rc::new({
                    let view = view.clone();
                    move |_, cx| {
                        view.update(cx, |this, cx| {
                            this.emoji_full = true;
                            cx.notify();
                        });
                    }
                }),
                cx,
            )
            .into_any_element()
        };
        div()
            .id("emoji-overlay")
            .absolute()
            .inset_0()
            .occlude()
            .on_mouse_down(MouseButton::Left, {
                let app = app.clone();
                move |_, _, cx| {
                    app.update(cx, |state, cx| state.close_emoji_picker(cx));
                }
            })
            .child(deferred(
                Positioner::side(open.bounds)
                    .placement(Placement::Bottom)
                    .align(Align::Start)
                    .offset(px(6.))
                    .occlude()
                    .child(
                        div()
                            .id("emoji-panel")
                            .on_mouse_down(MouseButton::Left, |_, _, cx| {
                                cx.stop_propagation();
                            })
                            .child(panel),
                    ),
            ))
    }

    pub fn new(window: &mut Window, state: Entity<AppState>, cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| {
            MessageInput::new(window, state.clone(), cx).on_submit({
                let state = state.clone();
                move |text, steer, files, cx| {
                    state.update(cx, |state, cx| {
                        // The draft's own door: these are the words in the composer, so what
                        // the composer is holding goes with them and comes off it here.
                        state.send_draft(text, steer, files, cx);
                    });
                }
            })
        });

        let last_conversation_id = state.read(cx).active_conversation_id.clone();

        let transcript = cx.new(|cx| ChatTranscript::new(state.clone(), input.clone(), cx));
        let emoji_search = cx.new(|cx| InputState::new(window, cx).placeholder("Search emoji"));
        let find_input = cx.new(|cx| InputState::new(window, cx).placeholder("Find in chat"));

        let this = Self {
            input,
            state: state.clone(),
            transcript,
            last_conversation_id,
            bot_status: None,
            coworker_name: None,
            coworker_id: None,
            coworker_shape: None,
            coworker_color: None,
            emoji_search: emoji_search.clone(),
            emoji_query: String::new(),
            emoji_full: false,
            emoji_category: 0,
            emoji_open: None,
            find_open: false,
            find_input: find_input.clone(),
            find_pending_focus: false,
        };

        cx.observe(&state, |this: &mut Self, state, cx| {
            let current_id = state.read(cx).active_conversation_id.clone();
            if current_id != this.last_conversation_id {
                this.last_conversation_id = current_id;
                cx.notify();
            }
        })
        .detach();

        cx.observe(&state, |this, app, cx| {
            let app = app.read(cx);
            let label = app.visible_bot_status();
            let coworker = app
                .active_coworker_id
                .as_ref()
                .and_then(|id| app.coworkers.iter().find(|c| &c.id == id));
            let coworker_name = coworker.map(|c| c.name.clone());
            let coworker_id = coworker.map(|c| c.id.clone());
            let coworker_shape = coworker.and_then(|c| c.avatar_shape.clone());
            let coworker_color = coworker.and_then(|c| c.avatar_color.clone());
            let emoji_open = app.emoji_picker.clone();
            let mut changed = false;
            if this.bot_status != label {
                this.bot_status = label;
                changed = true;
            }
            if this.coworker_name != coworker_name {
                this.coworker_name = coworker_name;
                changed = true;
            }
            if this.coworker_id != coworker_id {
                this.coworker_id = coworker_id;
                changed = true;
            }
            if this.coworker_shape != coworker_shape {
                this.coworker_shape = coworker_shape;
                changed = true;
            }
            if this.coworker_color != coworker_color {
                this.coworker_color = coworker_color;
                changed = true;
            }
            let picker_changed = match (&this.emoji_open, &emoji_open) {
                (None, None) => false,
                (Some(a), Some(b)) => a.message_id != b.message_id,
                _ => true,
            };
            if picker_changed {
                this.emoji_open = emoji_open;
                this.emoji_full = false;
                this.emoji_category = 0;
                this.emoji_query.clear();
                changed = true;
            }
            if changed {
                cx.notify();
            }
        })
        .detach();

        cx.subscribe(
            &emoji_search,
            |this: &mut Self, input, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    this.emoji_query = input.read(cx).value().to_string();
                    cx.notify();
                }
            },
        )
        .detach();

        cx.subscribe(
            &find_input,
            |this: &mut Self, input, event: &InputEvent, cx| match event {
                InputEvent::Change => {
                    let query = input.read(cx).value().to_string();
                    this.transcript.update(cx, |transcript, cx| {
                        transcript.set_find_query(query, cx);
                    });
                    cx.notify();
                }
                InputEvent::PressEnter { shift, .. } => {
                    let delta = if *shift { -1 } else { 1 };
                    this.transcript.update(cx, |transcript, cx| {
                        transcript.step_find(delta, cx);
                    });
                    cx.notify();
                }
                _ => {}
            },
        )
        .detach();

        this
    }
}

impl Render for ChatView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.find_pending_focus {
            self.find_pending_focus = false;
            self.find_input.update(cx, |input, cx| {
                input.focus(window, cx);
                input.select_all(window, cx);
            });
        }
        let theme = cx.theme().clone();

        let app = self.state.clone();
        v_flex()
            .size_full()
            .bg(theme.background)
            .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                app.update(cx, |state, cx| {
                    if state.model_picker.open || state.avatar_editor_open {
                        state.dismiss_popovers(cx);
                    }
                });
            })
            .on_action({
                let state = self.state.clone();
                move |action: &ToggleReadAloud, _window: &mut Window, cx: &mut App| {
                    eprintln!(
                        "[Chat] ToggleReadAloud action received. ID: {}, Mode: {:?}",
                        action.message_id, action.mode
                    );
                    state.update(cx, |state, cx| {
                        state.toggle_read_aloud(
                            action.message_id.clone(),
                            action.text.clone(),
                            action.mode.clone(),
                            cx,
                        );
                    });
                }
            })
            .on_action({
                let state = self.state.clone();
                move |_: &PauseReadAloud, _window: &mut Window, cx: &mut App| {
                    state.update(cx, |state, cx| {
                        state.pause_read_aloud(cx);
                    });
                }
            })
            .on_action({
                let state = self.state.clone();
                move |_: &ResumeReadAloud, _window: &mut Window, cx: &mut App| {
                    state.update(cx, |state, cx| {
                        state.resume_read_aloud(cx);
                    });
                }
            })
            .on_action({
                let state = self.state.clone();
                move |_: &StopReadAloud, _window: &mut Window, cx: &mut App| {
                    state.update(cx, |state, cx| {
                        state.stop_read_aloud(cx);
                    });
                }
            })
            .child(
                // The transcript is the whole column: the composer that follows is out of the
                // flow, so nothing takes a strip off the bottom of this.
                div()
                    .id("chat-transcript-slot")
                    .flex_1()
                    .min_h_0()
                    .relative()
                    .child(
                        // The transcript spans the whole slot so its scrollbar sits on the
                        // pane's edge; each row centres itself inside (see `ChatTranscript`).
                        div().absolute().inset_0().child(
                            div().id("chat-content-col").size_full().child(
                                self.transcript
                                    .clone()
                                    .cached(StyleRefinement::default().size_full()),
                            ),
                        ),
                    )
                    .when_some(self.emoji_open.clone(), |this, open| {
                        this.child(self.render_emoji_overlay(open, cx))
                    }),
            )
            .child(
                // The composer floats over the transcript instead of standing beside it. As a
                // row of its own it took its height out of the transcript's, and the last
                // bubble was sliced off at the row's top edge with nothing able to scroll past
                // that line; and the band it held, opaque or not, read as a wall across the
                // column. Nothing here paints: the chat runs on underneath, and only the pill
                // and the working line are solid. The transcript holds its rows a composer's
                // height clear of the floor, so the last one can still be read in full.
                v_flex()
                    .absolute()
                    .bottom_0()
                    .left_0()
                    .right_0()
                    .items_center()
                    .px_4()
                    .pb_4()
                    .child({
                        // How far the transcript has to hold back is whatever the composer
                        // grew to, and it grows with the draft, the recipe bar and the working
                        // line, so it is taken from the laid-out box rather than guessed. The
                        // canvas is absolute, so asking costs the composer no room, and it
                        // spans the padding box, so the 16px below the pill is counted too.
                        let transcript = self.transcript.clone();
                        gpui::canvas(
                            move |bounds, _, cx| {
                                let height = bounds.size.height;
                                if transcript.read(cx).composer_height == height {
                                    return;
                                }
                                // A notify raised here would be swallowed: the window clears
                                // its dirty flag when the frame begins, so nothing would ask
                                // for the next one and the transcript would keep the old floor
                                // until something else redrew it. Handing the height over once
                                // the frame is off leaves the notify a frame to buy.
                                let transcript = transcript.clone();
                                cx.defer(move |cx| {
                                    transcript.update(cx, |transcript, cx| {
                                        transcript.set_composer_height(height, cx);
                                    });
                                });
                            },
                            |_, _, _, _| (),
                        )
                        .absolute()
                        .inset_0()
                    })
                    .child(
                        // Everything the composer is made of is in this column, and it is
                        // exactly as wide as the pill, so this is the one box that may take
                        // the mouse. The chat runs on behind the band to either side of it,
                        // and a click there is a click on the chat: the band itself must stay
                        // as invisible to the mouse as it is to the eye, or it would be the
                        // wall again with nothing to show for it. Occluding is what makes a
                        // click on the pill the field's own — without it the click also
                        // reaches whatever row of the transcript happens to be underneath,
                        // which opened pictures in the lightbox while the person was only
                        // trying to type.
                        v_flex()
                            .occlude()
                            .on_mouse_down(MouseButton::Left, {
                                // Taking the click also takes it from the chat's own surface,
                                // and what that surface does with one is shut the right pane's
                                // popovers — see this view's root, and the sidebar's.
                                let app = self.state.clone();
                                move |_, _, cx| {
                                    app.update(cx, |state, cx| {
                                        if state.model_picker.open || state.avatar_editor_open {
                                            state.dismiss_popovers(cx);
                                        }
                                    });
                                }
                            })
                            .w_full()
                            .max_w(px(CHAT_CONTENT_MAX))
                            .gap_2()
                            .when_some(self.bot_status.clone(), |this, label| {
                                let name =
                                    self.coworker_name.clone().unwrap_or_else(|| "Agent".into());
                                let id = self.coworker_id.clone().unwrap_or_default();
                                let tooltip_label = label.clone();
                                this.child(
                                    h_flex()
                                        .id("bot-working")
                                        .gap(px(8.))
                                        .items_center()
                                        .px_1()
                                        .tooltip(move |w, cx| {
                                            Tooltip::new(tooltip_label.clone()).build(w, cx)
                                        })
                                        .child(
                                            PersonaMark::new(id)
                                                .shape(self.coworker_shape.clone())
                                                .color(self.coworker_color.clone())
                                                .size(px(20.))
                                                .dark(theme.is_dark()),
                                        )
                                        .child(
                                            div()
                                                .text_sm()
                                                .text_color(theme.muted_foreground)
                                                .child(bot_status_line(&name, &label)),
                                        ),
                                )
                            })
                            .child(self.input.clone()),
                    ),
            )
    }
}

/// One message can flush several text rows (text, then a card, then more
/// text). Their element ids key hover and menu state, so each row needs its
/// own. The first keeps the message id; later ones get an ordinal.
fn text_row_id(msg_id: &str, n: usize) -> String {
    if n == 0 {
        msg_id.to_string()
    } else {
        format!("{msg_id}-t{n}")
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ChatFeedRev, ChatRow, RowsChange, RunRow, ScreenshotSpec, TRANSCRIPT_EDGE_GAP, apply_rows,
        changed_rows, joins_previous_set, just_sent, run_row, snapshot_rows, tail_room,
        text_row_id,
    };
    use crate::components::steps::{step_key, timing_key};
    use crate::components::transcript_scroll::TranscriptScroll;
    use crate::opengrok::{ChatPart, StepSpec, TurnTiming};
    use crate::state::AppState;
    use gpui_kit::{ListOffset, px};

    /// A line of a routine's Run history lands on the run's first row in the thread: the
    /// instruction it opened with, or failing that the first row of anything the run said. A run
    /// the thread does not hold yet has no row, and is waited for rather than guessed at.
    #[test]
    fn a_runs_line_lands_on_the_runs_first_row() {
        let rows = [
            ChatRow::slot("r0".into(), "client-q1".into()),
            ChatRow::slot("r1".into(), "run_01a-prompt".into()),
            ChatRow::slot("r2".into(), "run_01a-reply".into()),
            ChatRow::slot("r3".into(), "run_02b-reply".into()),
        ];
        assert_eq!(run_row(&rows, "run_01a"), Some(1));
        assert_eq!(
            run_row(&rows, "run_02b"),
            Some(3),
            "no instruction row: its first"
        );
        assert_eq!(run_row(&rows, "run_03c"), None);
    }

    /// The room is the last bubble's alone: give it to every row and the transcript would be
    /// mostly air, and the rows above the composer would each hold a composer's worth of it.
    #[test]
    fn only_the_last_bubble_keeps_room_for_the_composer() {
        let composer = px(96.);
        assert_eq!(tail_room(0, 3, composer), None);
        assert_eq!(tail_room(1, 3, composer), None);
        assert_eq!(
            tail_room(2, 3, composer),
            Some(composer + px(TRANSCRIPT_EDGE_GAP))
        );
    }

    /// The composer grows with the draft, the recipe bar and the working line, and the room
    /// under the last bubble is what keeps it clear of all of that.
    #[test]
    fn the_room_under_the_last_bubble_follows_the_composers_height() {
        let short = tail_room(0, 1, px(72.));
        let tall = tail_room(0, 1, px(220.));
        assert_eq!(short, Some(px(72. + TRANSCRIPT_EDGE_GAP)));
        assert_eq!(tall, Some(px(220. + TRANSCRIPT_EDGE_GAP)));
        assert!(tall > short, "a taller composer has to take more room");
    }

    /// A transcript with nothing in it has no last bubble to hold anything off the floor.
    #[test]
    fn an_empty_transcript_holds_nothing_back() {
        assert_eq!(tail_room(0, 0, px(96.)), None);
    }

    #[test]
    fn text_rows_of_one_message_get_distinct_ids() {
        assert_eq!(text_row_id("m1", 0), "m1");
        assert_eq!(text_row_id("m1", 1), "m1-t1");
        assert_ne!(text_row_id("m1", 1), text_row_id("m1", 2));
    }

    fn shot(call_id: &str) -> ScreenshotSpec {
        ScreenshotSpec {
            call_id: call_id.to_string(),
            caption: String::new(),
            image: std::sync::Arc::new(gpui_kit::Image::from_bytes(
                gpui_kit::ImageFormat::Png,
                Vec::new(),
            )),
            width: 1280,
            height: 800,
            visibility: None,
        }
    }

    fn picture_row(message_id: &str, call_id: &str) -> ChatRow {
        ChatRow {
            screenshots: vec![shot(call_id)],
            ..ChatRow::slot(format!("{message_id}-shot-0"), message_id.to_string())
        }
    }

    fn word_row(message_id: &str) -> ChatRow {
        ChatRow::slot(message_id.to_string(), message_id.to_string())
    }

    /// Several pictures in a row from one turn are one set, so the transcript shows a strip
    /// and the lightbox can page through all of them.
    #[test]
    fn pictures_that_follow_one_another_in_a_turn_are_one_set() {
        let rows = vec![word_row("m1"), picture_row("m1", "call-1")];
        assert!(joins_previous_set(&rows, "m1"));
    }

    /// A turn's pictures are its own: the next turn starts a strip of its own, however many
    /// pictures the one before it ended on.
    #[test]
    fn the_next_turns_pictures_start_their_own_set() {
        let rows = vec![picture_row("m1", "call-1")];
        assert!(!joins_previous_set(&rows, "m2"));
    }

    /// Words between two pictures break the strip: what the bot said belongs between them.
    #[test]
    fn words_between_two_pictures_end_the_set() {
        let rows = vec![picture_row("m1", "call-1"), word_row("m1")];
        assert!(!joins_previous_set(&rows, "m1"));
    }

    #[test]
    fn the_first_picture_of_the_transcript_has_nothing_to_join() {
        assert!(!joins_previous_set(&[], "m1"));
    }

    fn step(call_id: &str, result: Option<(&str, bool)>) -> ChatPart {
        ChatPart::Step(StepSpec {
            call_id: call_id.to_string(),
            tool: "shell".to_string(),
            arguments: format!("{{\"command\":\"echo {call_id}\"}}"),
            result: result.map(|(content, _)| content.to_string()),
            ok: result.map(|(_, ok)| ok),
            took_ms: None,
        })
    }

    /// A step that came back, timed by this app or not.
    fn timed_step(call_id: &str, took_ms: Option<u64>) -> ChatPart {
        let ChatPart::Step(step) = step(call_id, Some(("ok", true))) else {
            unreachable!("a step");
        };
        ChatPart::Step(StepSpec { took_ms, ..step })
    }

    fn one_reply(parts: Vec<ChatPart>) -> AppState {
        let mut state = AppState::new();
        state.active_conversation_id = Some("cw_1".into());
        state.conversations.push(crate::state::Conversation {
            id: "cw_1".into(),
            title: "Hex".into(),
            created_at: String::new(),
            updated_at: String::new(),
            messages: vec![crate::state::Message {
                id: "m1".into(),
                sender: "AI".into(),
                content: "Let me look.\n\nDone.".into(),
                sent_at: std::time::SystemTime::UNIX_EPOCH,
                finished_at: None,
                run_timing: None,
                reply_source: None,
                is_me: false,
                reply_preview: None,
                reply_to_id: None,
                reply_is_me: false,
                parts,
                run_id: None,
                hidden: false,
            }],
            unread_count: 0,
            origin: None,
        });
        state
    }

    #[test]
    fn saved_reply_quotes_project_the_original_before_truncation() {
        let mut state = one_reply(Vec::new());
        let messages = &mut state.conversations[0].messages;
        messages[0].content = "Time is **Thursday, October 1**.".into();
        let mut reply = messages[0].clone();
        reply.id = "m2".into();
        reply.content = "Do it again".into();
        reply.is_me = true;
        reply.reply_to_id = Some("m1".into());
        reply.reply_preview = Some("Time is **Thursday…".into());
        messages.push(reply);
        let rows = snapshot_rows(&state);
        assert_eq!(
            rows[1].reply_preview.as_deref(),
            Some("Time is Thursday, October 1.")
        );
        assert_eq!(
            state.conversations[0].messages[1].reply_preview.as_deref(),
            Some("Time is **Thursday…")
        );

        state.conversations[0].messages[0].is_me = true;
        assert_eq!(
            snapshot_rows(&state)[1].reply_preview.as_deref(),
            Some("Time is **Thursday, October 1**.")
        );
    }

    /// What each row is, in a word, so a test can say the feed in one line.
    fn feed(state: &AppState) -> Vec<String> {
        snapshot_rows(state)
            .iter()
            .map(|row| match &row.run {
                Some(RunRow::Steps {
                    count,
                    open,
                    status,
                    ..
                }) => format!("{count} steps {} {}", status.mark(), open_word(*open)),
                Some(RunRow::Step {
                    step,
                    open,
                    group,
                    took,
                    ..
                }) => format!(
                    "{}step {} {}{}",
                    if group.is_some() { "  " } else { "" },
                    step.call_id,
                    open_word(*open),
                    took.as_ref()
                        .map(|took| format!(" · {took}"))
                        .unwrap_or_default()
                ),
                Some(RunRow::Thought {
                    open, group, took, ..
                }) => format!(
                    "{}thought {}{}",
                    if group.is_some() { "  " } else { "" },
                    open_word(*open),
                    took.as_ref()
                        .map(|took| format!(" · {took}"))
                        .unwrap_or_default()
                ),
                #[cfg(feature = "agent")]
                Some(RunRow::Timing { total, .. }) => format!("timing {total} shut"),
                None => format!("words {}", row.content),
            })
            .collect()
    }

    fn open_word(open: bool) -> &'static str {
        if open { "open" } else { "shut" }
    }

    #[test]
    fn timing_keeps_each_action_visible_and_each_detail_collapsed() {
        let mut state = one_reply(vec![
            ChatPart::Reasoning(crate::opengrok::ThoughtSpec {
                text: "Look first.".into(),
                took_ms: Some(5000),
            }),
            timed_step("read-1", Some(2000)),
            timed_step("read-2", Some(3000)),
            timed_step("search", Some(8000)),
            timed_step("write", Some(4000)),
            timed_step("command", Some(8000)),
            ChatPart::Text("Done.".into()),
        ]);
        state.show_turn_timing = true;
        state.conversations[0].messages[0].run_timing = crate::opengrok::TurnTiming::from_value(
            &serde_json::json!({"total_ms":30000,"model_ms":[5000],"tool_wait_ms":25000}),
        );
        assert_eq!(
            feed(&state),
            [
                "thought shut · 5s",
                "step read-1 shut · 2s",
                "step read-2 shut · 3s",
                "step search shut · 8s",
                "step write shut · 4s",
                "step command shut · 8s",
                "words Done."
            ]
        );
        let rows = snapshot_rows(&state);
        let gaps: Vec<_> = rows
            .iter()
            .enumerate()
            .map(|(ix, row)| super::transcript_row_gap(row, rows.get(ix + 1)))
            .collect();
        assert_eq!(
            gaps,
            [px(4.), px(4.), px(4.), px(4.), px(4.), px(12.), px(0.)]
        );
        assert_eq!(super::transcript_row_gap(&rows[6], Some(&rows[6])), px(32.));
        let rev = ChatFeedRev::from_state(&state);
        let ChatPart::Reasoning(thought) = &mut state.conversations[0].messages[0].parts[0] else {
            panic!("thought");
        };
        thought.took_ms = Some(6000);
        assert!(
            rev != ChatFeedRev::from_state(&state),
            "a timing-only update repaints"
        );
        state.mark_steps_open(&[step_key("m1", "command")], true);
        assert_eq!(feed(&state)[5], "step command open · 8s");
        assert_eq!(feed(&state).last().map(String::as_str), Some("words Done."));
        let rows = snapshot_rows(&state);
        assert_eq!(
            rows.last().unwrap().turn_total.as_deref(),
            Some("30s total")
        );
        assert_eq!(
            rows.iter().filter(|row| row.turn_total.is_some()).count(),
            1
        );
    }

    /// Steps with no words between them are one "N steps" row until it is opened, a thought
    /// between them does not split them, and a stretch of one step is that step. None of those
    /// rows has words in it for find, copy or read aloud to take. A step opened inside a shut
    /// stretch opens the stretch; shutting the stretch shuts what is in it.
    #[test]
    fn consecutive_steps_are_one_row_until_opened() {
        let mut state = one_reply(vec![
            ChatPart::Text("Let me look.".into()),
            step("c1", Some(("a", true))),
            ChatPart::Reasoning("Now the other one.".into()),
            step("c2", None),
            ChatPart::Text("Done.".into()),
            step("c3", Some(("no", false))),
        ]);
        assert_eq!(
            feed(&state),
            vec![
                "words Let me look.",
                "2 steps … shut",
                "words Done.",
                "step c3 shut"
            ]
        );
        let rows = snapshot_rows(&state);
        assert!(
            rows.iter()
                .filter(|row| row.run.is_some())
                .all(|row| row.content.is_empty() && row.tts_text.is_empty()),
            "a step's row has no words in it"
        );

        state.mark_steps_open(&[step_key("m1", "c2")], true);
        assert_eq!(
            feed(&state),
            vec![
                "words Let me look.",
                "2 steps … open",
                "  step c1 shut",
                "  thought shut",
                "  step c2 open",
                "words Done.",
                "step c3 shut",
            ]
        );

        let Some(RunRow::Steps { key, members, .. }) =
            snapshot_rows(&state).iter().find_map(|row| {
                row.run
                    .clone()
                    .filter(|run| matches!(run, RunRow::Steps { .. }))
            })
        else {
            panic!("the stretch has its line");
        };
        let shut: Vec<String> = std::iter::once(key).chain(members).collect();
        state.mark_steps_open(&shut, false);
        assert_eq!(feed(&state)[1], "2 steps … shut");
        assert_eq!(feed(&state).len(), 4);
    }

    /// A run that failed after its tools ran said nothing, and the app's line saying why is
    /// drawn under its steps rather than hidden behind them.
    #[test]
    fn a_run_that_failed_after_its_steps_still_says_why() {
        let mut state = one_reply(vec![
            step("c1", Some(("a", true))),
            step("c2", Some(("no", false))),
        ]);
        state.conversations[0].messages[0].content = "OpenGrok: the model gateway went away".into();
        assert_eq!(
            feed(&state),
            vec![
                "2 steps ✗ shut",
                "words OpenGrok: the model gateway went away"
            ]
        );
        let rows = snapshot_rows(&state);
        assert!(rows.last().is_some_and(|row| row.status_failed));
    }

    /// With Settings → Show turn timing on, each call this app timed says how long its answer
    /// took at the end of its own row, and a call it could not time says nothing rather than a
    /// guess. With the setting off, no row says it.
    #[test]
    fn each_call_s_time_is_at_the_end_of_its_own_row() {
        let mut state = one_reply(vec![
            ChatPart::Text("Let me look.".into()),
            timed_step("c1", Some(1000)),
            ChatPart::Text("Now the other one.".into()),
            timed_step("c2", None),
            ChatPart::Text("Done.".into()),
        ]);
        assert_eq!(
            feed(&state),
            vec![
                "words Let me look.",
                "step c1 shut",
                "words Now the other one.",
                "step c2 shut",
                "words Done.",
            ],
            "the setting is off"
        );
        state.show_turn_timing = true;
        assert_eq!(
            feed(&state),
            vec![
                "words Let me look.",
                "step c1 shut · 1s",
                "words Now the other one.",
                "step c2 shut",
                "words Done.",
            ]
        );
        // Open, it still says it: the time is on the line, not in what opening shows.
        state.mark_steps_open(&[step_key("m1", "c1")], true);
        assert_eq!(feed(&state)[1], "step c1 open · 1s");
    }

    /// A total belongs to the final reply row's metadata, not a separate transcript row,
    /// even when the reply ends with a tool rather than words.
    #[test]
    fn a_reply_s_total_is_metadata_on_its_last_row() {
        let mut state = one_reply(vec![
            ChatPart::Text("Let me look.".into()),
            timed_step("c1", Some(1000)),
            ChatPart::Text("Done.".into()),
            timed_step("c2", None),
        ]);
        state.conversations[0].messages[0].run_timing =
            TurnTiming::from_value(&serde_json::json!({
                "model_ms": [2000, 2000],
                "tools": [{ "name": "shell", "ms": 1000 }],
                "tool_wait_ms": 1000,
                "auto_review_ms": 0,
                "total_ms": 10000,
                "tool_rounds": 1
            }));
        assert!(
            !feed(&state).iter().any(|row| row.starts_with("timing")),
            "the setting is off"
        );

        state.show_turn_timing = true;
        let shut = snapshot_rows(&state);
        assert_eq!(
            shut.last().unwrap().turn_total.as_deref(),
            Some("10s total")
        );
        assert_eq!(
            shut.last().unwrap().timestamp,
            state.conversations[0].messages[0].formatted_time()
        );
        assert!(shut.last().unwrap().duration.is_empty());
        assert!(
            shut[..shut.len() - 1]
                .iter()
                .all(|row| row.turn_total.is_none())
        );
        assert_eq!(
            feed(&state),
            vec![
                "words Let me look.",
                "step c1 shut · 1s",
                "words Done.",
                "step c2 shut",
            ]
        );

        state.mark_steps_open(&[timing_key("m1")], true);
        assert_eq!(
            feed(&state).last().map(String::as_str),
            Some("step c2 shut")
        );
        let open = snapshot_rows(&state);
        assert_eq!(changed_rows(&shut, &open), (4..4, 0));
        state.show_turn_timing = false;
        assert!(
            snapshot_rows(&state)
                .iter()
                .all(|row| row.turn_total.is_none())
        );
    }

    #[test]
    fn a_total_arriving_after_the_reply_remeasures_its_metadata_row() {
        let mut state = one_reply(vec![ChatPart::Text("Done.".into())]);
        state.show_turn_timing = true;
        let before = snapshot_rows(&state);
        state.conversations[0].messages[0].run_timing =
            TurnTiming::from_value(&serde_json::json!({"total_ms":30000}));
        let after = snapshot_rows(&state);
        assert_eq!(after.len(), before.len(), "no separate total row");
        assert_eq!(changed_rows(&before, &after), (0..1, 1));
        assert_eq!(after[0].turn_total.as_deref(), Some("30s total"));
        state.show_turn_timing = false;
        assert_eq!(changed_rows(&after, &snapshot_rows(&state)), (0..1, 1));
    }

    /// Opening a row in the middle of the thread replaces only the rows that changed, so the
    /// list keeps its place instead of being reset to the bottom.
    #[test]
    fn opening_a_step_changes_only_its_own_rows() {
        let mut state = one_reply(vec![
            ChatPart::Text("Let me look.".into()),
            step("c1", Some(("a", true))),
            step("c2", Some(("b", true))),
            ChatPart::Text("Done.".into()),
        ]);
        let shut = snapshot_rows(&state);
        state.mark_steps_open(&[step_key("m1", "c1")], true);
        let open = snapshot_rows(&state);
        // The line stays, opened; its two steps come in under it; the words either side stay.
        assert_eq!(changed_rows(&shut, &open), (1..2, 3));
        assert_eq!(changed_rows(&open, &shut), (1..4, 1));
        assert_eq!(changed_rows(&open, &open), (5..5, 0));
    }

    /// A message in the thread, said by the person or by the coworker.
    fn said(id: &str, content: &str, is_me: bool) -> crate::state::Message {
        crate::state::Message {
            id: id.into(),
            sender: if is_me { "Me" } else { "AI" }.into(),
            content: content.into(),
            sent_at: std::time::SystemTime::UNIX_EPOCH,
            finished_at: None,
            run_timing: None,
            is_me,
            reply_preview: None,
            reply_to_id: None,
            reply_is_me: false,
            parts: Vec::new(),
            run_id: None,
            reply_source: None,
            hidden: false,
        }
    }

    /// Where the view begins: the row at its top, and how far into that row.
    fn place(scroll: &TranscriptScroll) -> (usize, gpui_kit::Pixels) {
        let anchor = scroll.anchor();
        (anchor.item_ix, anchor.offset_in_item)
    }

    /// A transcript whose reader has gone back up the thread, to `row` and `into` pixels into it.
    fn read_back(rows: usize, row: usize, into: f32) -> TranscriptScroll {
        let mut scroll = TranscriptScroll::new(rows);
        assert!(scroll.scroll_to_item(row));
        scroll.hold(ListOffset {
            item_ix: row,
            offset_in_item: px(into),
        });
        scroll
    }

    /// The reply goes on below the person while they read further up: a step arrives, then the
    /// words after it. Until this fix every row a turn added started the list over at the newest
    /// row, and whoever had scrolled up was carried back down with it. Now the rows are spliced
    /// in and the person stays on the row they were reading, as far into it as they were.
    #[test]
    fn rows_that_arrive_while_reading_back_leave_the_reader_where_they_are() {
        let mut state = one_reply(vec![
            ChatPart::Text("Let me look.".into()),
            step("c1", Some(("a", true))),
        ]);
        let before = snapshot_rows(&state);
        let mut scroll = read_back(before.len(), 0, 12.);

        let reply = &mut state.conversations[0].messages[0].parts;
        reply.push(step("c2", Some(("b", true))));
        reply.push(ChatPart::Text("Done.".into()));
        let after = snapshot_rows(&state);
        assert!(after.len() > before.len(), "the turn added rows");
        let responding = RowsChange {
            responding: true,
            ..RowsChange::default()
        };
        apply_rows(&mut scroll, &before, &after, responding);

        assert!(!scroll.is_following(), "the reader was not taken back down");
        assert!(!scroll.list().is_following_tail(), "nor was GPUI's list");
        assert_eq!(
            scroll.item_count(),
            after.len(),
            "the list has the new rows"
        );
        assert_eq!(
            place(&scroll),
            (0, px(12.)),
            "the reader is where they were"
        );

        // The coworker's next message is not the person's, so it does not take them down either.
        state.conversations[0]
            .messages
            .push(said("m2", "Anything else?", false));
        let next = snapshot_rows(&state);
        apply_rows(&mut scroll, &after, &next, responding);
        assert!(!scroll.is_following());
        assert_eq!(place(&scroll), (0, px(12.)));
    }

    /// At the newest row, rows arriving keep the person there, as they always did.
    #[test]
    fn at_the_newest_row_rows_arriving_keep_the_reader_there() {
        let mut state = one_reply(vec![ChatPart::Text("Let me look.".into())]);
        let before = snapshot_rows(&state);
        let mut scroll = TranscriptScroll::new(before.len());
        state.conversations[0]
            .messages
            .push(said("m2", "Found it.", false));
        let after = snapshot_rows(&state);
        apply_rows(&mut scroll, &before, &after, RowsChange::default());
        assert!(scroll.is_following() && scroll.list().is_following_tail());
        assert_eq!(scroll.item_count(), after.len());
    }

    /// The scrollbar moves GPUI's list before the transcript's next render hears about it. A
    /// reply can add a row in between, and must leave the reader where the scrollbar put them.
    #[test]
    fn rows_arriving_before_the_next_frame_preserve_the_scrollbar_position() {
        let before: Vec<_> = (0..12)
            .map(|ix| ChatRow::slot(format!("row-{ix}"), format!("message-{ix}")))
            .collect();
        let mut after = before.clone();
        after.push(ChatRow::slot("new-row".into(), "new-message".into()));
        let mut scroll = TranscriptScroll::new(before.len());
        // Height hints give the list scrollable content without drawing a window. Moving the
        // list directly models the scrollbar's off-bottom result before render synchronizes it.
        scroll.list().clone().with_uniform_item_height(px(100.));
        scroll.list().scroll_to(ListOffset {
            item_ix: 3,
            offset_in_item: px(12.),
        });
        assert!(!scroll.list().is_following_tail());
        assert!(scroll.is_following(), "the transcript has not rendered yet");

        apply_rows(&mut scroll, &before, &after, RowsChange::default());

        assert_eq!(place(&scroll), (3, px(12.)), "still on the row being read");
        assert!(!scroll.is_following() && !scroll.list().is_following_tail());
        assert_eq!(scroll.item_count(), after.len());
    }

    /// Streaming can grow a row without adding one. It still has to hear a scrollbar movement
    /// before it publishes whether the transcript follows, so a later row cannot reset it.
    #[test]
    fn a_growing_reply_before_the_next_frame_hears_the_scrollbar_position() {
        let mut state = one_reply(vec![ChatPart::Text("Let me look.".into())]);
        let before = snapshot_rows(&state);
        let mut scroll = TranscriptScroll::new(before.len());
        scroll.list().clone().with_uniform_item_height(px(100.));
        scroll.list().scroll_to(ListOffset {
            item_ix: 0,
            offset_in_item: px(12.),
        });
        state.conversations[0].messages[0].parts =
            vec![ChatPart::Text("Let me look at the logs.".into())];
        let after = snapshot_rows(&state);
        assert_eq!(before.len(), after.len());

        apply_rows(
            &mut scroll,
            &before,
            &after,
            RowsChange {
                responding: true,
                ..RowsChange::default()
            },
        );

        assert!(!scroll.is_following() && !scroll.list().is_following_tail());
        assert_eq!(place(&scroll), (0, px(12.)));
    }

    /// A message of the person's own takes them to the newest row from wherever they were
    /// reading: they sent it, and whoever sends wants to see what comes back. So does opening
    /// another thread.
    #[test]
    fn a_send_or_another_thread_takes_the_reader_to_the_newest_row() {
        let mut state = one_reply(vec![ChatPart::Text("Let me look.".into())]);
        let before = snapshot_rows(&state);
        let mut scroll = read_back(before.len(), 0, 12.);
        state.conversations[0]
            .messages
            .push(said("q2", "And the logs?", true));
        let after = snapshot_rows(&state);
        apply_rows(&mut scroll, &before, &after, RowsChange::default());
        assert!(scroll.is_following() && scroll.list().is_following_tail());

        let mut scroll = read_back(after.len(), 0, 12.);
        let opened = RowsChange {
            thread_opened: true,
            ..RowsChange::default()
        };
        apply_rows(&mut scroll, &after, &before, opened);
        assert!(scroll.is_following() && scroll.list().is_following_tail());
    }

    /// A send is a message of the person's own that is new on the end of the thread. The
    /// coworker's words there are not one, and neither is the person's message seen again, as
    /// when a queued send goes out and its row changes.
    #[test]
    fn a_send_is_a_new_message_of_the_persons_own_on_the_end() {
        let row = |id: &str, is_me: bool| ChatRow {
            is_me,
            ..ChatRow::slot(id.into(), id.into())
        };
        let before = vec![row("m1", false)];
        let sent = vec![row("m1", false), row("q2", true)];
        assert!(just_sent(&before, &sent));
        assert!(!just_sent(&before, &[row("m1", false), row("m2", false)]));
        assert!(!just_sent(&sent, &sent));
    }

    /// The row at the top of the reader's view can be one of the rows a change replaces, as when
    /// a line above it goes and a row arrives at the end in the same change. It is found again
    /// by its id, so the view stays on it, as far into it as it was, where a plain splice would
    /// have moved the view to the top of the rows replaced.
    #[test]
    fn the_row_being_read_keeps_its_place_when_the_rows_around_it_change() {
        let rows = |ids: &[&str]| -> Vec<ChatRow> {
            ids.iter()
                .map(|id| ChatRow::slot(id.to_string(), "m1".into()))
                .collect()
        };
        let before = rows(&["a", "note", "b", "c"]);
        let after = rows(&["a", "b", "c", "d", "e"]);
        let mut scroll = read_back(before.len(), 2, 30.);
        apply_rows(&mut scroll, &before, &after, RowsChange::default());
        assert!(!scroll.is_following());
        assert_eq!(place(&scroll), (1, px(30.)), "still on b, thirty pixels in");
    }

    /// A driver's click opens the very row the feed draws: the keys the host's click hands the
    /// app open a step standing alone, with what it was given and what came back; a step in a
    /// stretch, whose line opens with it; and the Thought rows. A second click shuts the step.
    ///
    /// This is the contract between the tree and the feed, not the whole of the bug a driver
    /// found on 28 Sep 2026: these rows were already right then. The window went on drawing
    /// the old ones because the click was applied in the middle of a frame, where GPUI does not
    /// tell the state's observers, and the transcript builds its rows in one. That half is in
    /// `RootView::drain_agent`, and only a live window shows it.
    #[cfg(feature = "agent")]
    #[test]
    fn a_drivers_click_opens_the_row_the_feed_draws() {
        use gpui_agent::{AgentHost, Op};
        let mut state = one_reply(vec![
            ChatPart::Reasoning("Size it first.".into()),
            ChatPart::Text("Let me look.".into()),
            step("c1", Some(("4.0G", true))),
            ChatPart::Text("Now the index.".into()),
            step("c2", Some(("a", true))),
            ChatPart::Reasoning("Then read it.".into()),
            step("c3", Some(("denied", false))),
            ChatPart::Text("Done.".into()),
        ]);
        let click = |state: &mut AppState, target: &str| {
            let mut host = crate::agent::NativeChatHost::from_app(state);
            host.dispatch(&Op::click(target))
                .expect("the host takes the click");
            let Some(crate::agent::Command::SetStepsOpen { keys, open }) = host.take_command()
            else {
                panic!("a click on {target} opens or shuts rows");
            };
            state.mark_steps_open(&keys, open);
        };
        let row = |state: &AppState, call_id: &str| {
            snapshot_rows(state)
                .iter()
                .find_map(|row| match &row.run {
                    Some(RunRow::Step {
                        step, open, group, ..
                    }) if step.call_id == call_id => Some((step.clone(), *open, group.is_some())),
                    _ => None,
                })
                .unwrap_or_else(|| panic!("no row for {call_id} in {:?}", feed(state)))
        };

        click(&mut state, "step-c1");
        let (lone, open, grouped) = row(&state, "c1");
        assert!(open && !grouped, "the step standing alone is open, alone");
        assert_eq!(lone.shown_arguments().as_deref(), Some("echo c1"));
        assert_eq!(lone.result.as_deref(), Some("4.0G"));

        click(&mut state, "step-c3");
        assert_eq!(
            feed(&state),
            vec![
                "thought shut",
                "words Let me look.",
                "step c1 open",
                "words Now the index.",
                "2 steps ✗ open",
                "  step c2 shut",
                "  thought shut",
                "  step c3 open",
                "words Done.",
            ]
        );

        click(&mut state, "reply-reasoning");
        let thoughts: Vec<bool> = snapshot_rows(&state)
            .iter()
            .filter_map(|row| match &row.run {
                Some(RunRow::Thought { open, .. }) => Some(*open),
                _ => None,
            })
            .collect();
        assert_eq!(
            thoughts,
            vec![true, true],
            "both thoughts, in the stretch too"
        );

        click(&mut state, "step-c1");
        assert!(!row(&state, "c1").1, "a second click shuts it");
    }

    /// A step's result landing after its row was drawn is a change the feed sees, and the rows
    /// it rebuilds say how the call came out: the step's mark, an opened step's result, and the
    /// mark on the "N steps" line it sits in. `ChatRow::same_as` never decides what is drawn,
    /// only which rows the list measures again when one is opened or shut.
    #[test]
    fn a_result_landing_late_redraws_its_row() {
        let mut state = one_reply(vec![
            ChatPart::Text("Let me look.".into()),
            step("c1", None),
            ChatPart::Text("Now the two others.".into()),
            step("c2", Some(("a", true))),
            step("c3", None),
        ]);
        state.mark_steps_open(&[step_key("m1", "c1")], true);
        let before = ChatFeedRev::from_state(&state);
        assert_eq!(
            feed(&state),
            vec![
                "words Let me look.",
                "step c1 open",
                "words Now the two others.",
                "2 steps … shut",
            ]
        );
        let settle = |state: &mut AppState, call_id: &str, content: &str, ok: bool| {
            for part in &mut state.conversations[0].messages[0].parts {
                if let ChatPart::Step(step) = part
                    && step.call_id == call_id
                {
                    step.result = Some(content.to_string());
                    step.ok = Some(ok);
                }
            }
        };
        settle(&mut state, "c1", "4.0G", true);
        settle(&mut state, "c3", "denied", false);
        assert!(
            ChatFeedRev::from_state(&state) != before,
            "the feed sees the results land, so it rebuilds its rows"
        );
        let rows = snapshot_rows(&state);
        let opened = rows
            .iter()
            .find_map(|row| match &row.run {
                Some(RunRow::Step { step, open, .. }) if step.call_id == "c1" => {
                    Some((step.status().mark(), *open, step.result.clone()))
                }
                _ => None,
            })
            .expect("c1's row");
        assert_eq!(opened, ("✓", true, Some("4.0G".to_string())));
        assert_eq!(feed(&state)[3], "2 steps ✗ shut");
    }

    fn person_says(words: &str, id: &str) -> crate::state::Message {
        let mut state = one_reply(Vec::new());
        let mut message = state.conversations[0].messages.remove(0);
        message.id = id.into();
        message.is_me = true;
        message.sender = "Me".into();
        message.content = words.into();
        message
    }

    fn a_file(id: &str) -> crate::opengrok::Attachment {
        crate::opengrok::Attachment {
            id: id.into(),
            mime: "application/pdf".into(),
            filename: format!("{id}.pdf"),
            size_bytes: 10,
        }
    }

    /// A message of files alone is a message like any other: one row, with its time and its
    /// footer (reply, delete), carrying its files, and the files' names for copy and read aloud.
    /// A worded message carries its files on its own row, with no extra row (#136).
    #[test]
    fn a_message_of_files_alone_has_its_time_and_controls() {
        let mut state = one_reply(Vec::new());
        state.conversations[0].messages = vec![
            person_says("", "m_files"),
            person_says("see these", "m_words"),
        ];
        state
            .message_files
            .insert("m_files".into(), vec![a_file("art_1"), a_file("art_2")]);
        state
            .message_files
            .insert("m_words".into(), vec![a_file("art_3")]);
        let rows = snapshot_rows(&state);
        let of = |id: &str| {
            rows.iter()
                .filter(|row| row.source_id == id)
                .collect::<Vec<_>>()
        };
        let files_alone = of("m_files");
        assert_eq!(files_alone.len(), 1, "one row, not a bare row of tiles");
        let row = files_alone[0];
        assert!(
            row.show_footer && row.is_me,
            "it has the footer a message has"
        );
        assert_eq!(row.files.len(), 2);
        assert_eq!(row.tts_text.as_ref(), "art_1.pdf, art_2.pdf");
        // Read aloud on it shows as reading, as for a worded message (review of #140).
        state.native_tts.message_id = Some("m_files".into());
        let rows = snapshot_rows(&state);
        let row = rows.iter().find(|row| row.source_id == "m_files").unwrap();
        assert!(row.is_native_speaking);
        let worded = of("m_words");
        assert_eq!(worded.len(), 1, "the files ride on the words' own row");
        assert_eq!(worded[0].content.as_ref(), "see these");
        assert_eq!(worded[0].files.len(), 1);
    }
}
