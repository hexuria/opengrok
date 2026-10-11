//! What the coworker did and thought on the way to a reply, drawn between its words: a row per
//! tool call it made, one "N steps" row for a stretch of them while timing is off, and a
//! "Thinking" row for its reasoning. Every detail starts closed: a computer run of two hundred
//! calls is one line until somebody wants to know what those calls were. While Settings → Show turn timing
//! is on, every action stays visible with its own observed duration. The total belongs to the
//! final reply's swipe-revealed timestamp metadata.

use std::collections::HashSet;

#[cfg(feature = "agent")]
use crate::opengrok::TurnTiming;
use crate::opengrok::{ChatPart, StepSpec, StepStatus};
use crate::state::AppState;
use gpui_kit::component::{ActiveTheme, Icon, IconName, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;

/// A step row's key in [`AppState::expanded_steps`]. The reply's id goes with the call's,
/// because a call id is only sure to be unique within its run: two runs can each have a `c1`,
/// and opening one would have opened both.
pub(crate) fn step_key(message_id: &str, call_id: &str) -> String {
    format!("{message_id}/step/{call_id}")
}

/// The key of a reply's `n`th Thought row, counted from 0 in the order the reply has them.
pub(crate) fn thought_key(message_id: &str, n: usize) -> String {
    format!("{message_id}/thought/{n}")
}

/// The key of a reply's `n`th stretch of steps (see [`step_runs`]).
fn steps_key(message_id: &str, n: usize) -> String {
    format!("{message_id}/steps/{n}")
}

/// The stable key of a reply's total-time metadata.
#[cfg(any(feature = "agent", test))]
pub(crate) fn timing_key(message_id: &str) -> String {
    format!("{message_id}/timing")
}

/// The agent's non-interactive total-time metadata. It is not a separate transcript row.
/// Old expansion keys are deliberately ignored.
#[cfg(feature = "agent")]
pub(crate) fn timing_row(
    message_id: &str,
    timing: &TurnTiming,
    _open: &HashSet<String>,
) -> Option<RunRow> {
    let total = timing.total_line()?;
    let key = timing_key(message_id);
    Some(RunRow::Timing { key, total })
}

/// A stretch of a reply with no words in it: the steps the coworker took there, and what it
/// thought between them, in the order they happened.
///
/// Words end a stretch, and so does anything else the feed draws on its own — a picture, a
/// card, a widget — which has to stay where it happened and in sight. A thought does not end
/// one: a model that thinks between every call would otherwise leave a two-hundred-call run as
/// four hundred rows.
struct StepRun {
    /// Its parts, by their place in the reply.
    parts: Vec<usize>,
    steps: usize,
}

fn step_runs(parts: &[ChatPart]) -> Vec<StepRun> {
    let mut runs = Vec::new();
    let mut open: Option<StepRun> = None;
    for (at, part) in parts.iter().enumerate() {
        match part {
            ChatPart::Step(_) | ChatPart::Reasoning(_) => {
                let run = open.get_or_insert_with(|| StepRun {
                    parts: Vec::new(),
                    steps: 0,
                });
                run.parts.push(at);
                if matches!(part, ChatPart::Step(_)) {
                    run.steps += 1;
                }
            }
            ChatPart::Text(text) if text.trim().is_empty() => {}
            _ => runs.extend(open.take()),
        }
    }
    runs.extend(open);
    runs
}

/// One row of what the coworker did or thought.
#[derive(Clone)]
pub(crate) enum RunRow {
    /// Two or more steps with no words between them, as one line until it is opened.
    Steps {
        key: String,
        count: usize,
        /// Still going while any of them is, failed if any of them did.
        status: StepStatus,
        open: bool,
        /// The keys of the rows inside, which shut with it.
        members: Vec<String>,
    },
    Step {
        key: String,
        step: StepSpec,
        open: bool,
        /// The key of the open "N steps" it is drawn inside, when it is inside one.
        group: Option<String>,
        /// How long the call took, at the end of its line ([`StepSpec::took`]): only while
        /// Settings → Show turn timing is on, and only for a call this app timed.
        took: Option<String>,
    },
    Thought {
        key: String,
        text: String,
        open: bool,
        group: Option<String>,
        took: Option<String>,
    },
    /// Agent representation of the final reply's total-time metadata (see [`timing_row`]).
    #[cfg(feature = "agent")]
    Timing {
        key: String,
        /// `10s total`. Model/tool aggregate phases are not another disclosure.
        total: String,
    },
}

impl RunRow {
    pub(crate) fn key(&self) -> &str {
        match self {
            Self::Steps { key, .. } | Self::Step { key, .. } | Self::Thought { key, .. } => key,
            #[cfg(feature = "agent")]
            Self::Timing { key, .. } => key,
        }
    }

    pub(crate) fn is_open(&self) -> bool {
        match self {
            Self::Steps { open, .. } | Self::Step { open, .. } | Self::Thought { open, .. } => {
                *open
            }
            #[cfg(feature = "agent")]
            Self::Timing { .. } => false,
        }
    }
}

/// One stretch as the feed draws it.
struct RunPlan {
    /// Its first part, by its place in the reply.
    first: usize,
    steps: usize,
    status: StepStatus,
    /// Opened, or holding a row that was: a step a driver opened, or one the person opened
    /// while it still stood alone and that another step has joined since.
    open: bool,
    /// The keys of its rows, which only an open stretch needs: they are what shuts with it.
    members: Vec<String>,
}

/// Where each step and thought of one reply goes in the feed.
pub(crate) struct RunLayout {
    message_id: String,
    /// For each part of the reply, the stretch it is in.
    run_of: Vec<Option<usize>>,
    /// For each part of the reply that is a thought, which one it is.
    thought_of: Vec<usize>,
    runs: Vec<RunPlan>,
    /// The rows of this reply that are open.
    open: HashSet<String>,
    /// Settings → Show turn timing: each step's line ends with how long it took.
    timing: bool,
}

impl RunLayout {
    /// `parts` are the ones the feed draws for the reply, in its order; `open` is
    /// [`AppState::expanded_steps`], and `timing` is [`AppState::show_turn_timing`].
    pub(crate) fn new(
        message_id: &str,
        parts: &[ChatPart],
        open: &HashSet<String>,
        timing: bool,
    ) -> Self {
        let mut layout = Self {
            message_id: message_id.to_string(),
            run_of: Vec::new(),
            thought_of: Vec::new(),
            runs: Vec::new(),
            open: HashSet::new(),
            timing,
        };
        let stretches = step_runs(parts);
        if stretches.is_empty() {
            return layout;
        }
        layout.thought_of = vec![0; parts.len()];
        let mut thoughts = 0;
        for (at, part) in parts.iter().enumerate() {
            if matches!(part, ChatPart::Reasoning(_)) {
                layout.thought_of[at] = thoughts;
                thoughts += 1;
            }
        }
        // The feed is rebuilt as a turn streams, and a long run is hundreds of steps: their
        // keys are only worked out for a reply that has something open.
        let anything_open = open.iter().any(|key| {
            key.strip_prefix(message_id)
                .is_some_and(|rest| rest.starts_with('/'))
        });
        layout.run_of = vec![None; parts.len()];
        for (n, run) in stretches.into_iter().enumerate() {
            let mut statuses = Vec::new();
            let mut members = Vec::new();
            for &at in &run.parts {
                layout.run_of[at] = Some(n);
                match &parts[at] {
                    ChatPart::Step(step) => {
                        statuses.push(step.status());
                        if anything_open {
                            members.push(step_key(message_id, &step.call_id));
                        }
                    }
                    _ if anything_open => {
                        members.push(thought_key(message_id, layout.thought_of[at]));
                    }
                    _ => {}
                }
            }
            let status = if statuses.contains(&StepStatus::Running) {
                StepStatus::Running
            } else if statuses.contains(&StepStatus::Failed) {
                StepStatus::Failed
            } else {
                StepStatus::Ok
            };
            let is_open = anything_open
                && (open.contains(&steps_key(message_id, n))
                    || members.iter().any(|key| open.contains(key)));
            layout
                .open
                .extend(members.iter().filter(|key| open.contains(*key)).cloned());
            layout.runs.push(RunPlan {
                first: run.parts.first().copied().unwrap_or_default(),
                steps: run.steps,
                status,
                open: is_open,
                members,
            });
        }
        layout
    }

    /// The rows the reply's part at `at` puts in the feed: the "N steps" line in front of the
    /// first part of a stretch of two steps or more, and the part's own row unless that line is
    /// shut. A stretch with one step in it is drawn as that step. Anything but a step or a
    /// thought puts nothing here.
    pub(crate) fn rows(&self, at: usize, part: ChatPart) -> Vec<RunRow> {
        let Some(run) = self
            .run_of
            .get(at)
            .copied()
            .flatten()
            .and_then(|n| self.runs.get(n).map(|run| (n, run)))
        else {
            return Vec::new();
        };
        let (n, run) = run;
        // With timing visible, hiding the action rows would hide the very breakdown the
        // person asked to read. Their contents still start collapsed.
        let grouped = run.steps >= 2 && !self.timing;
        let mut rows = Vec::new();
        if grouped && run.first == at {
            rows.push(RunRow::Steps {
                key: steps_key(&self.message_id, n),
                count: run.steps,
                status: run.status,
                open: run.open,
                members: run.members.clone(),
            });
        }
        if grouped && !run.open {
            return rows;
        }
        let group = grouped.then(|| steps_key(&self.message_id, n));
        match part {
            ChatPart::Step(step) => {
                let key = step_key(&self.message_id, &step.call_id);
                rows.push(RunRow::Step {
                    open: self.open.contains(&key),
                    key,
                    took: self.timing.then(|| step.took()).flatten(),
                    step,
                    group,
                });
            }
            ChatPart::Reasoning(thought) => {
                let key = thought_key(&self.message_id, self.thought_of[at]);
                rows.push(RunRow::Thought {
                    open: self.open.contains(&key),
                    key,
                    text: thought.text.clone(),
                    took: self.timing.then(|| thought.took()).flatten(),
                    group,
                });
            }
            _ => {}
        }
        rows
    }
}

/// How wide an opened row's detail gets. The column is as wide as it is for words, and a
/// shell's output read at that width is lines of two hundred characters.
const DETAIL_MAX: f32 = 640.0;

/// Disclosure contents share the transcript's left edge, not the label's inset.
/// Group membership affects toggling only; it must not add a nested visual gutter.
fn flat_column(gap: f32) -> Div {
    v_flex().w_full().items_start().gap(px(gap))
}

/// One row of what the coworker did or thought, and what a click on it opens or shuts.
pub(crate) fn render_run_row(row: &RunRow, app: Entity<AppState>, cx: &App) -> AnyElement {
    let theme = cx.theme();
    match row {
        RunRow::Steps {
            key,
            count,
            status,
            open,
            members,
        } => {
            // Shutting the line shuts what is in it too: a row left open inside would hold the
            // line open (see `RunPlan::open`), and the click would look like it did nothing.
            let keys = if *open {
                std::iter::once(key.clone())
                    .chain(members.iter().cloned())
                    .collect()
            } else {
                vec![key.clone()]
            };
            let toggle = Toggle {
                keys,
                open: !*open,
                group: None,
            };
            let label = format!("{count} steps");
            heading(key, *open, Some(*status), label, toggle, app, cx).into_any_element()
        }
        RunRow::Step {
            key,
            step,
            open,
            group,
            took,
        } => {
            let head = heading(
                key,
                *open,
                Some(step.status()),
                step.label(),
                Toggle::row(key, *open, group),
                app,
                cx,
            )
            // On the line itself, open or shut, so a stretch of rows can be read down the side
            // for where the time went without opening any of them.
            .when_some(took.clone(), |this, took| {
                this.child(
                    div()
                        .text_color(theme.muted_foreground.opacity(0.7))
                        .child(format!("· {took}")),
                )
            });
            if !*open {
                return head.into_any_element();
            }
            let mut detail = flat_column(6.).max_w(px(DETAIL_MAX));
            if let Some(arguments) = step.shown_arguments() {
                detail = detail.child(mono_block(arguments, cx));
            }
            if let Some(result) = &step.result {
                detail = detail.child(mono_block(result.clone(), cx));
            }
            flat_column(4.).child(head).child(detail).into_any_element()
        }
        RunRow::Thought {
            key,
            text,
            open,
            group,
            took,
        } => {
            let head = heading(
                key,
                *open,
                None,
                "Thinking".to_string(),
                Toggle::row(key, *open, group),
                app,
                cx,
            )
            .when_some(took.clone(), |this, took| {
                this.child(
                    div()
                        .text_color(theme.muted_foreground.opacity(0.7))
                        .child(format!("· {took}")),
                )
            });
            if !*open {
                return head.into_any_element();
            }
            flat_column(4.)
                .child(head)
                .child(
                    div()
                        .max_w(px(DETAIL_MAX))
                        .text_sm()
                        .text_color(theme.muted_foreground)
                        .child(text.clone()),
                )
                .into_any_element()
        }
        #[cfg(feature = "agent")]
        RunRow::Timing { total, .. } => div()
            .py(px(3.))
            .text_xs()
            .text_color(theme.muted_foreground)
            .child(total.clone())
            .into_any_element(),
    }
}

/// What a click on a row's line does: sets `keys` open or shut and, for a row inside an open
/// "N steps", keeps that line open. Shutting a step the person opened in there leaves the rest
/// of the stretch in sight; without it, a stretch held open only by that step would fold away
/// under the click.
struct Toggle {
    keys: Vec<String>,
    open: bool,
    group: Option<String>,
}

impl Toggle {
    fn row(key: &str, open: bool, group: &Option<String>) -> Self {
        Self {
            keys: vec![key.to_string()],
            open: !open,
            group: group.clone(),
        }
    }
}

/// The line a row is read and opened by: a chevron, the mark for how it came out, and what it
/// says.
fn heading(
    key: &str,
    open: bool,
    status: Option<StepStatus>,
    label: String,
    toggle: Toggle,
    app: Entity<AppState>,
    cx: &App,
) -> Stateful<Div> {
    let theme = cx.theme();
    let muted = theme.muted_foreground;
    let hover_group = SharedString::from(format!("{key}/hover"));
    h_flex()
        .id(ElementId::Name(format!("{key}/heading").into()))
        .group(hover_group.clone())
        // A disclosure is a text control, not a full-width button. Its hit target follows
        // its content even when the surrounding reply column stretches.
        .flex_none()
        .self_start()
        .gap(px(6.))
        .py(px(3.))
        .items_center()
        .text_sm()
        .text_color(muted)
        .cursor_pointer()
        .on_mouse_down(MouseButton::Left, move |_, _, cx| {
            app.update(cx, |state, cx| {
                if let Some(group) = &toggle.group {
                    state.mark_steps_open(std::slice::from_ref(group), true);
                }
                state.set_steps_open(&toggle.keys, toggle.open, cx);
            });
        })
        .child(
            Icon::new(if open {
                IconName::ChevronDown
            } else {
                IconName::ChevronRight
            })
            .size(px(12.))
            .text_color(muted),
        )
        .when_some(status, |this, status| {
            this.child(
                div()
                    .text_color(match status {
                        StepStatus::Running => muted,
                        StepStatus::Ok => theme.green,
                        StepStatus::Failed => theme.danger,
                    })
                    .child(status.mark()),
            )
        })
        .child(
            div()
                // Keep the label's hover state through layout so its text colour, not just
                // paint-only styles, updates when entering the disclosure's hit target.
                .id(SharedString::from(format!("{key}/label")))
                .text_color(muted)
                .group_hover(hover_group, |style| style.text_color(theme.foreground))
                .child(label),
        )
}

/// A step's arguments or its result, exactly as they are kept, in the font code is read in.
/// The words are not selectable, so the block's own copy affordance is the only way the
/// output leaves the row — the disclosure's click is the row's toggle, not a selection.
fn mono_block(text: String, cx: &App) -> Div {
    let theme = cx.theme();
    let copy = text.clone();
    div()
        .relative()
        .w_full()
        .px(px(8.))
        .py(px(6.))
        .rounded(px(6.))
        .bg(theme.secondary)
        .text_xs()
        .font_family(theme.mono_font_family.clone())
        .text_color(theme.secondary_foreground)
        .child(text)
        .child(
            div()
                .id("step-mono-copy")
                .absolute()
                .top(px(4.))
                .right(px(4.))
                .p(px(3.))
                .rounded(px(4.))
                .cursor_pointer()
                .text_color(theme.muted_foreground)
                .hover(|style| style.text_color(theme.foreground).bg(theme.background))
                .child(Icon::new(IconName::Copy).size(px(12.)))
                .on_mouse_down(gpui::MouseButton::Left, move |_, _, cx| {
                    cx.stop_propagation();
                    cx.write_to_clipboard(ClipboardItem::new_string(copy.clone()));
                }),
        )
}

#[cfg(test)]
mod tests {
    use super::flat_column;
    use gpui_kit::{AlignItems, Styled, px};

    #[test]
    fn expanded_disclosures_do_not_indent_their_contents() {
        // Both the header/content stack and the arguments/result stack use this
        // production builder. Keep the outer gutter at zero; mono blocks still
        // retain their own internal padding for readable command text.
        for gap in [4., 6.] {
            let mut column = flat_column(gap);
            let style = column.style();
            assert_eq!(style.padding.left.unwrap_or_default(), px(0.).into());
            assert_eq!(style.margin.left.unwrap_or_default(), px(0.).into());
            assert_eq!(style.align_items, Some(AlignItems::FlexStart));
        }
    }
}
