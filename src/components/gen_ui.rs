//! Native AG-UI widgets. Not markdown, not KaTeX.

use crate::opengrok::{
    ApprovalSpec, BarChartSpec, CREATE_ROUTINE, ChoiceCard, DELETE_ROUTINE, FormSpec,
    LIST_ROUTINES, LocalExecResolution, ScreenshotSpec, UPDATE_ROUTINE, UiSpec, choice_letter,
};
use crate::state::{AppState, ApprovalDecision};
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::{ActiveTheme, Icon, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;

pub fn render_ui_spec(
    spec: &UiSpec,
    message_id: &str,
    app: Option<Entity<AppState>>,
    cx: &App,
) -> AnyElement {
    match spec {
        UiSpec::BarChart(chart) => render_bar_chart(chart, cx),
        UiSpec::Form(form) => render_form(form, message_id, app, cx),
    }
}

/// How many tiles the strip shows before it starts counting the rest.
const STRIP_TILES: usize = 3;
const STRIP_TILE_H: f32 = 110.0;
/// The single picture's width in the feed, unchanged since the card was all there was.
const CARD_W: f32 = 520.0;
/// Every picture in the transcript belongs to this hover group, so the eye appears on the
/// one the mouse is over. The name is looked up inside each tile's own subtree, so tiles
/// can share it.
const IMAGE_GROUP: &str = "chat-image";

/// The pictures the strip cannot show, which is the number its last tile carries.
fn overflow_count(total: usize) -> usize {
    total.saturating_sub(STRIP_TILES)
}

/// The bot's screens in the feed. One picture is a card at the feed's width with the tool's
/// own words underneath; several from one turn are a strip of tiles with the words in a
/// tooltip. Either way a click opens the set in the lightbox.
pub fn render_screenshots(
    shots: &[ScreenshotSpec],
    app: Option<Entity<AppState>>,
    cx: &App,
) -> AnyElement {
    let theme = cx.theme();
    if shots.len() == 1 {
        let Some(spec) = shots.first() else {
            return div().into_any_element();
        };
        let height = CARD_W * spec.height.max(1) as f32 / spec.width.max(1) as f32;
        return v_flex()
            .gap(px(6.))
            .child(
                // The tile is exactly the picture's size: the column would otherwise stretch it
                // to the feed's width, and the eye, centred on the tile, would sit off the picture.
                screenshot_tile("image-thumb-0", shots, 0, app)
                    .self_start()
                    .w(px(CARD_W))
                    .h(px(height))
                    .child(
                        img(spec.image.clone())
                            .w(px(CARD_W))
                            .h(px(height))
                            .rounded(px(8.))
                            .border_1()
                            .border_color(theme.border),
                    )
                    .child(eye_scrim(8.)),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child(spec.caption.clone()),
            )
            .into_any_element();
    }
    let hidden = overflow_count(shots.len());
    let mut strip = h_flex().gap(px(6.)).flex_wrap();
    for (ix, spec) in shots.iter().take(STRIP_TILES).enumerate() {
        let width = STRIP_TILE_H * spec.width.max(1) as f32 / spec.height.max(1) as f32;
        let counts_the_rest = hidden > 0 && ix + 1 == STRIP_TILES;
        let caption = spec.caption.clone();
        strip = strip.child(
            screenshot_tile(&format!("image-thumb-{ix}"), shots, ix, app.clone())
                .when(!caption.trim().is_empty(), |this| {
                    this.tooltip(move |window, cx| Tooltip::new(caption.clone()).build(window, cx))
                })
                .child(
                    img(spec.image.clone())
                        .w(px(width))
                        .h(px(STRIP_TILE_H))
                        .rounded(px(8.))
                        .border_1()
                        .border_color(theme.border),
                )
                // On the tile that stands for the ones with no room, the count is the
                // affordance; an eye on top of it would only hide the number.
                .map(|this| {
                    if counts_the_rest {
                        this.child(
                            div()
                                .absolute()
                                .inset_0()
                                .rounded(px(8.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .bg(gpui::black().opacity(0.55))
                                .text_xl()
                                .font_weight(FontWeight::BOLD)
                                .text_color(gpui::white())
                                .child(format!("+{hidden}")),
                        )
                    } else {
                        this.child(eye_scrim(8.))
                    }
                }),
        );
    }
    strip.into_any_element()
}

/// A picture in the transcript: the hover group, the pointer, and the click that opens the
/// whole set in the lightbox at this one.
fn screenshot_tile(
    id: &str,
    shots: &[ScreenshotSpec],
    index: usize,
    app: Option<Entity<AppState>>,
) -> Stateful<Div> {
    let set = shots.to_vec();
    div()
        .id(ElementId::Name(id.to_string().into()))
        .group(IMAGE_GROUP)
        .relative()
        .flex_shrink_0()
        .cursor_pointer()
        .when_some(app, |this, app| {
            this.on_mouse_down(MouseButton::Left, move |_, _, cx| {
                let set = set.clone();
                app.update(cx, |state, cx| state.open_lightbox(set, index, cx));
            })
        })
}

/// What hovering a picture says: a light wash over it and an eye on a dark chip, meaning
/// this one can be looked at properly.
fn eye_scrim(radius: f32) -> impl IntoElement {
    div()
        .absolute()
        .inset_0()
        .rounded(px(radius))
        .opacity(0.)
        .group_hover(IMAGE_GROUP, |style| style.opacity(1.))
        .flex()
        .items_center()
        .justify_center()
        .bg(gpui::white().opacity(0.16))
        .child(
            div()
                .size(px(38.))
                .rounded_full()
                .flex()
                .items_center()
                .justify_center()
                .bg(gpui::black().opacity(0.55))
                .child(
                    Icon::default()
                        .path("icons/eye.svg")
                        .size(px(18.))
                        .text_color(gpui::white()),
                ),
        )
}

pub fn render_approval(spec: &ApprovalSpec, app: Option<Entity<AppState>>, cx: &App) -> AnyElement {
    let theme = cx.theme();
    let (decision, bot, machine, tunnel) = app
        .as_ref()
        .map(|entity| {
            let state = entity.read(cx);
            let decision = state
                .approval_decisions
                .get(&spec.call_id)
                .cloned()
                .unwrap_or(ApprovalDecision::Pending);
            (
                decision,
                state.active_bot_name(),
                state.local_exec_machine_id.clone().unwrap_or_default(),
                state.egress_tunnel_available(),
            )
        })
        .unwrap_or((
            ApprovalDecision::Pending,
            "this agent".into(),
            String::new(),
            false,
        ));
    if let Some(line) = decision.outcome_line(&bot, spec) {
        return div()
            .w_full()
            .py(px(8.))
            .flex()
            .justify_center()
            .child(
                div()
                    .text_sm()
                    .text_color(theme.muted_foreground)
                    .child(line),
            )
            .into_any_element();
    }
    if matches!(decision, ApprovalDecision::Failed(ref message) if !message.is_empty()) {
        let message = match &decision {
            ApprovalDecision::Failed(message) => message.clone(),
            _ => String::new(),
        };
        return div()
            .w_full()
            .py(px(8.))
            .flex()
            .justify_center()
            .child(
                div()
                    .text_sm()
                    .text_color(theme.muted_foreground)
                    .child(message),
            )
            .into_any_element();
    }
    // Painted as a Review-an-action card: the title, the lines under it and the buttons all
    // go by this one gate (see the buttons below for why the tunnel flag is part of it).
    let review = spec.is_review_an_action() && (tunnel || app.is_none());
    let mut body = v_flex()
        .w_full()
        .gap(px(8.))
        .p(px(14.))
        .rounded(px(10.))
        .border_1()
        .border_color(theme.border)
        .bg(theme.background);
    body = body.child(
        h_flex()
            .w_full()
            .items_start()
            .justify_between()
            .gap(px(8.))
            .child(
                div()
                    .flex_1()
                    .text_sm()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(approval_title(spec, &bot, review)),
            )
            .child(dismiss_button(spec, app.clone(), theme.muted_foreground)),
    );
    // What the card is about, in the server's words: see `card_lines`. A Review-an-action card
    // used to show only its title, so the person could not tell the tunnel's card from a
    // judge's.
    for line in card_lines(spec, review) {
        body = body.child(
            div()
                .text_xs()
                .text_color(theme.muted_foreground)
                .child(line.to_string()),
        );
    }
    if spec.runs_on_this_mac() {
        if !machine.is_empty() {
            body = body.child(
                div()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child(machine),
            );
        }
        body = body.child(
            div()
                .text_xs()
                .text_color(theme.muted_foreground)
                .child(format!(
                    "Always allow and Never answer this command from now on, for {bot} and every Bot."
                )),
        );
    }
    if let Some(command) = arguments_box(spec) {
        body = body.child(
            div()
                .w_full()
                .px(px(8.))
                .py(px(6.))
                .rounded(px(6.))
                .bg(theme.secondary)
                .text_xs()
                .text_color(theme.secondary_foreground)
                .child(command),
        );
    }
    if matches!(decision, ApprovalDecision::Sending) {
        body = body.child(
            div()
                .text_xs()
                .text_color(theme.muted_foreground)
                .child("Sending…"),
        );
    } else {
        // Always/Never keep a rule for the command on this Mac, so only the
        // local-shell tool offers them. A box tool is answered one request at a time.
        // Review an action (egress / auto-review): Always allow / Allow once / Deny.
        // Gated on host/env/box isEgressTunnelAvailable — OpenGrok only stamps
        // the reason when the tunnel is on; we still require the flag here so
        // exec-consent never grows Review chrome because a leftover reason.
        let local = spec.runs_on_this_mac();
        let (primary, plain) = (
            (theme.primary, theme.primary_foreground, theme.primary),
            (theme.border, theme.foreground, theme.background),
        );
        let allow_once = if local || review { plain } else { primary };
        let mut row = h_flex().w_full().justify_end().gap(px(8.)).flex_wrap();
        if local || review {
            row = row.child(approval_button(
                spec,
                "Always allow",
                LocalExecResolution::Always,
                app.clone(),
                primary.0,
                primary.1,
                primary.2,
            ));
        }
        row = row
            .child(approval_button(
                spec,
                "Allow once",
                LocalExecResolution::AllowOnce,
                app.clone(),
                allow_once.0,
                allow_once.1,
                allow_once.2,
            ))
            .child(approval_button(
                spec,
                if review { "Deny" } else { "Deny once" },
                LocalExecResolution::DenyOnce,
                app.clone(),
                plain.0,
                plain.1,
                plain.2,
            ));
        // Never is a standing no: a rule for the command on this Mac for the local shell, the
        // computer's policy for the tunnel's card. A judge's card has nothing for it to keep.
        if (local && !review) || (review && spec.is_egress_tunnel()) {
            row = row.child(approval_button(
                spec,
                "Never",
                LocalExecResolution::Never,
                app,
                plain.0,
                plain.1,
                plain.2,
            ));
        }
        body = body.child(row);
    }
    body.into_any_element()
}

/// The card's title: one short question about where the call would act, by the surface the
/// server's own card files it under (opengrok-server `cards.rs` `surface_for`). A shell runs a
/// command on its computer, a qualified `plugin.server.tool` is a connected service, and every
/// other tool uses its computer. What the call would do is the line under the title (see
/// `card_lines`). The title used to be built from the tool's name, and read "Allow Hex to run
/// computer on its computer?". A review card keeps its own title, and the local shell's card
/// asks about this Mac's policy rather than one call, so neither changes.
///
/// The routine tools (opengrok-server #316) touch no computer, which the server's surface for
/// them says nonetheless, so each asks about routines: the Bot's own, which since #349 are the
/// only ones its routine tools see or touch (recorded in #351 at 9a2b011). A delete always asks
/// first, and its `why` is the server's own question naming the routine as it is stored ("Delete
/// the routine "Weekly report"? It stops for good."): that question is the card's title
/// ([`routine_question`]).
pub(crate) fn approval_title(spec: &ApprovalSpec, bot: &str, review: bool) -> String {
    if review {
        return "Review an action".to_string();
    }
    if spec.runs_on_this_mac() {
        return format!("Allow {bot} to run this command on your local computer?");
    }
    if let Some(question) = routine_question(spec) {
        return question.to_string();
    }
    match spec.tool.as_str() {
        "shell" => format!("Allow {bot} to run a command on its computer?"),
        "read_file" => format!("Allow {bot} to read a file on its computer?"),
        "write_file" => format!("Allow {bot} to write a file on its computer?"),
        LIST_ROUTINES => format!("Allow {bot} to see its routines?"),
        CREATE_ROUTINE => format!("Allow {bot} to make a routine?"),
        UPDATE_ROUTINE => format!("Allow {bot} to change a routine?"),
        DELETE_ROUTINE => format!("Allow {bot} to delete a routine?"),
        tool if tool.matches('.').count() >= 2 => {
            format!("Allow {bot} to use a connected service?")
        }
        _ => format!("Allow {bot} to use its computer?"),
    }
}

/// The server's question on a routine's delete card, which names the routine as it is stored
/// (opengrok-server #316, #334, on main 8e7387f: `admit` in `crates/opengrok-tools/src/routine.rs`
/// writes it as the card's `why`, live and in the approvals queue alike). `None` for any other
/// card, and for a delete card that came without one.
fn routine_question(spec: &ApprovalSpec) -> Option<&str> {
    let why = spec.why.trim();
    (spec.tool == DELETE_ROUTINE && !why.is_empty()).then_some(why)
}

/// The lines under the title, in the server's words. A card painted as a review card says why
/// the call was stopped and then what it would do: the tunnel's reason is the same sentence
/// for every call, and the summary is what tells a click from a page load. A consent card says
/// only what the call would do, because a reason under a plain consent title would read as a
/// review card's. A routine's delete card is its title alone: the server's question names the
/// routine as stored, where its summary names it by id.
fn card_lines(spec: &ApprovalSpec, review: bool) -> Vec<&str> {
    if !review && routine_question(spec).is_some() {
        return Vec::new();
    }
    let why = if review { spec.why.trim() } else { "" };
    [why, spec.summary.as_str()]
        .into_iter()
        .filter(|line| !line.is_empty())
        .collect()
}

/// The raw arguments box, where the card has one. It is there only where the arguments are
/// what the call means: a shell's command, or a call that could not be put in words. Under a
/// summary it showed the same call again as JSON, including typed text that the summary keeps
/// as `«redacted»`.
fn arguments_box(spec: &ApprovalSpec) -> Option<String> {
    if !spec.summary.is_empty() {
        return None;
    }
    Some(if spec.command.trim().is_empty() {
        "Command was not included with this request.".to_string()
    } else {
        spec.command.clone()
    })
}

fn dismiss_button(spec: &ApprovalSpec, app: Option<Entity<AppState>>, color: Hsla) -> AnyElement {
    let spec = spec.clone();
    div()
        .id(ElementId::Name(
            format!("approval-dismiss-{}", spec.call_id).into(),
        ))
        .cursor_pointer()
        .text_color(color)
        .child("×")
        .tooltip(|w, cx| Tooltip::new("Deny this time").build(w, cx))
        .when_some(app, |this, app| {
            this.on_mouse_down(MouseButton::Left, move |_, _, cx| {
                app.update(cx, |state, cx| {
                    state.answer_approval(spec.clone(), LocalExecResolution::DenyOnce, cx);
                });
            })
        })
        .into_any_element()
}

fn approval_button(
    spec: &ApprovalSpec,
    label: &'static str,
    resolution: LocalExecResolution,
    app: Option<Entity<AppState>>,
    border: Hsla,
    text: Hsla,
    fill: Hsla,
) -> AnyElement {
    let spec = spec.clone();
    div()
        .id(ElementId::Name(
            format!("approval-{}-{label}", spec.call_id).into(),
        ))
        .px(px(9.))
        .py(px(6.))
        .rounded(px(6.))
        .border_1()
        .border_color(border)
        .bg(fill)
        .text_color(text)
        .text_xs()
        .cursor_pointer()
        .child(label)
        .when_some(app, |this, app| {
            this.on_mouse_down(MouseButton::Left, move |_, _, cx| {
                app.update(cx, |state, cx| {
                    state.answer_approval(spec.clone(), resolution, cx);
                });
            })
        })
        .into_any_element()
}

fn render_bar_chart(chart: &BarChartSpec, cx: &App) -> AnyElement {
    let theme = cx.theme();
    let max = chart
        .bars
        .iter()
        .map(|bar| bar.value.abs())
        .fold(0.0_f32, f32::max)
        .max(1.0);
    let bars = chart.bars.clone();
    let columns = bars.into_iter().enumerate().map(|(i, bar)| {
        let frac = (bar.value.abs() / max).clamp(0.08, 1.0);
        let fill = if i % 2 == 0 {
            theme.primary
        } else {
            theme.primary.opacity(0.55)
        };
        v_flex()
            .items_center()
            .gap(px(6.))
            .child(div().w(px(28.)).h(px(120. * frac)).rounded(px(6.)).bg(fill))
            .child(
                div()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child(bar.label.clone()),
            )
            .into_any_element()
    });
    v_flex()
        .w_full()
        .gap(px(8.))
        .when_some(chart.title.clone(), |this, title| {
            this.child(
                div()
                    .text_sm()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(title),
            )
        })
        .child(
            h_flex()
                .w_full()
                .items_end()
                .justify_around()
                .h(px(148.))
                .gap(px(10.))
                .children(columns),
        )
        .into_any_element()
}

fn render_form(
    form: &FormSpec,
    message_id: &str,
    app: Option<Entity<AppState>>,
    cx: &App,
) -> AnyElement {
    // Generative choice card → `send_message`. Never used for passwords; those are
    // `render_user_form`.
    let theme = cx.theme();
    let (card, picks, keyed) = match app.as_ref() {
        Some(entity) => {
            let state = entity.read(cx);
            (
                state.choice_card(message_id, form),
                state
                    .form_picks
                    .get(message_id)
                    .cloned()
                    .unwrap_or_default(),
                state.keyed_choice().as_deref() == Some(message_id),
            )
        }
        None => (ChoiceCard::Open, Default::default(), false),
    };
    let heading = form.title.clone().or_else(|| form.prompt.clone());
    let subtitle = form.title.as_ref().and(form.prompt.clone());
    let title_el = |muted: bool| {
        div()
            .text_sm()
            .font_weight(FontWeight::SEMIBOLD)
            .when(muted, |this| this.text_color(theme.muted_foreground))
            .child(heading.clone().unwrap_or_default())
    };
    let pill = |words: &'static str| {
        div()
            .px(px(8.))
            .py(px(2.))
            .rounded(px(999.))
            .bg(theme.muted)
            .text_xs()
            .text_color(theme.muted_foreground)
            .child(words)
    };
    let shell = || {
        v_flex()
            .id(ElementId::Name(format!("choice-{message_id}").into()))
            .w_full()
            .gap(px(10.))
    };
    match card {
        ChoiceCard::Dismissed | ChoiceCard::MovedOn => {
            let words = if card == ChoiceCard::Dismissed {
                "Dismissed"
            } else {
                "Not answered"
            };
            return shell()
                .child(
                    h_flex()
                        .w_full()
                        .gap(px(8.))
                        .items_center()
                        .child(div().flex_1().child(title_el(true)))
                        .child(pill(words)),
                )
                .into_any_element();
        }
        ChoiceCard::Answered(answer) => {
            let mut body = shell().child(title_el(false));
            for field in &form.fields {
                let Some(value) = answer.get(&field.id) else {
                    continue;
                };
                let letter = form
                    .answers_on_pick()
                    .then(|| field.options.iter().position(|option| option == value))
                    .flatten()
                    .and_then(choice_letter);
                body = body.child(
                    h_flex()
                        .gap(px(8.))
                        .items_center()
                        .text_xs()
                        .when_some(letter, |this, letter| this.child(keycap(letter, false, cx)))
                        .when(!form.answers_on_pick(), |this| {
                            this.child(
                                div()
                                    .text_color(theme.muted_foreground)
                                    .child(format!("{}:", field.label)),
                            )
                        })
                        .child(value.clone())
                        .child(div().text_color(theme.primary).child("✓")),
                );
            }
            return body.into_any_element();
        }
        ChoiceCard::Open => {}
    }

    // Clicking the card itself takes the caret out of the composer, so the letters on the
    // keycaps work: a letter typed into a field is the person's words, never an answer.
    let mut body = shell().on_mouse_down(MouseButton::Left, |_, window, cx| window.blur(cx));
    let dismiss = app.clone().map(|app| {
        let message_id = message_id.to_string();
        div()
            .id(ElementId::Name(
                format!("choice-{message_id}-dismiss").into(),
            ))
            .px(px(6.))
            .rounded(px(6.))
            .text_sm()
            .text_color(theme.muted_foreground)
            .cursor_pointer()
            .hover(|this| this.bg(theme.muted))
            .tooltip(|window, cx| Tooltip::new("Dismiss without answering").build(window, cx))
            .child("✕")
            .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                cx.stop_propagation();
                app.update(cx, |state, cx| state.dismiss_choice(message_id.clone(), cx));
            })
    });
    body = body.child(
        h_flex()
            .w_full()
            .gap(px(8.))
            .items_start()
            .child(
                v_flex()
                    .flex_1()
                    .gap(px(4.))
                    .child(title_el(false))
                    .when_some(subtitle, |this, prompt| {
                        this.child(
                            div()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child(prompt),
                        )
                    }),
            )
            .children(dismiss),
    );
    let one_question = form.answers_on_pick();
    for (field_index, field) in form.fields.iter().enumerate() {
        let selected = picks.get(&field.id).cloned();
        let mut options = if one_question {
            v_flex().gap(px(6.))
        } else {
            h_flex().gap(px(6.)).flex_wrap()
        };
        for (option_index, option) in field.options.iter().enumerate() {
            let on = selected.as_deref() == Some(option.as_str());
            let message_id = message_id.to_string();
            let app = app.clone();
            let letter = one_question.then(|| choice_letter(option_index)).flatten();
            options = options.child(
                h_flex()
                    .id(ElementId::Name(
                        format!("choice-{message_id}-{field_index}-{option_index}").into(),
                    ))
                    .gap(px(8.))
                    .items_center()
                    .px(px(10.))
                    .py(px(if one_question { 6. } else { 4. }))
                    .rounded(px(if one_question { 8. } else { 999. }))
                    .border_1()
                    .border_color(if on { theme.primary } else { theme.border })
                    .bg(if on { theme.primary } else { theme.background })
                    .text_color(if on {
                        theme.primary_foreground
                    } else {
                        theme.foreground
                    })
                    .text_xs()
                    .cursor_pointer()
                    .hover(|this| this.border_color(theme.primary))
                    .when_some(letter, |this, letter| this.child(keycap(letter, keyed, cx)))
                    .child(option.clone())
                    .when_some(app, |this, app| {
                        this.on_mouse_down(MouseButton::Left, move |_, _, cx| {
                            app.update(cx, |state, cx| {
                                state.choose(message_id.clone(), field_index, option_index, cx);
                            });
                        })
                    }),
            );
        }
        body = body.child(
            v_flex()
                .gap(px(6.))
                .when(!one_question, |this| {
                    this.child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(field.label.clone()),
                    )
                })
                .child(options),
        );
    }
    if one_question {
        return body.into_any_element();
    }
    let spec = form.clone();
    let message_id = message_id.to_string();
    // In a row of its own so it is as wide as its word, not as the card.
    body.child(
        h_flex().child(
            div()
                .id(ElementId::Name(
                    format!("choice-{message_id}-submit").into(),
                ))
                .px(px(12.))
                .py(px(6.))
                .rounded(px(8.))
                .bg(theme.primary)
                .text_color(theme.primary_foreground)
                .text_xs()
                .cursor_pointer()
                .child(form.submit.clone())
                .when_some(app, |this, app| {
                    this.on_mouse_down(MouseButton::Left, move |_, _, cx| {
                        app.update(cx, |state, cx| {
                            state.submit_form(message_id.clone(), spec.clone(), cx);
                        });
                    })
                }),
        ),
    )
    .into_any_element()
}

/// A choice's letter in a key-shaped box. Bright while the letter key answers this card, dim
/// once it does not: on an older card, or on the answer the card settled on.
fn keycap(letter: char, live: bool, cx: &App) -> impl IntoElement {
    let theme = cx.theme();
    div()
        .flex()
        .items_center()
        .justify_center()
        .size(px(18.))
        .rounded(px(4.))
        .border_1()
        .border_color(theme.border)
        .bg(theme.secondary)
        .text_color(if live {
            theme.secondary_foreground
        } else {
            theme.muted_foreground
        })
        .text_xs()
        .font_weight(FontWeight::MEDIUM)
        .child(letter.to_string())
}

#[cfg(test)]
mod tests {
    use super::{STRIP_TILES, approval_title, arguments_box, card_lines, overflow_count};
    use crate::opengrok::{ApprovalSpec, USER_MACHINE_SHELL, approval_from_event};
    use serde_json::{Value, json};

    const CLICK: &str = "Click at (120, 40) on the agent's own screen";
    const TUNNEL: &str =
        "This action would use your network through the egress tunnel. Review it before it runs.";

    /// A card off the frame the server sends today (opengrok-harness `projection.rs`
    /// `awaiting_approval`), which carries the tool and its arguments and no summary.
    fn card(tool: &str, arguments: Value, reason: &str, why: &str) -> ApprovalSpec {
        approval_from_event(&json!({
            "type": "CUSTOM",
            "name": "run-awaiting-approval",
            "threadId": "cw_1",
            "runId": "run_1",
            "callId": "call_1",
            "tool": tool,
            "arguments": arguments,
            "reason": reason,
            "why": why
        }))
        .expect("a card")
    }

    fn click() -> Value {
        json!({"action": "click", "coordinate": [120, 40]})
    }

    /// A consent card asks where the call would act, never "run computer on its computer",
    /// and says what the call would do under that.
    #[test]
    fn a_consent_card_is_titled_by_where_the_call_acts() {
        let screen = card("computer", click(), "exec-consent", "");
        assert_eq!(
            approval_title(&screen, "Hex", false),
            "Allow Hex to use its computer?"
        );
        assert_eq!(card_lines(&screen, false), vec![CLICK]);
        let shell = card("shell", json!({"command": "ls -la"}), "policy-approval", "");
        assert_eq!(
            approval_title(&shell, "Hex", false),
            "Allow Hex to run a command on its computer?"
        );
        let read = card(
            "read_file",
            json!({"path": "notes.md"}),
            "policy-approval",
            "",
        );
        assert_eq!(
            approval_title(&read, "Hex", false),
            "Allow Hex to read a file on its computer?"
        );
        let write = card(
            "write_file",
            json!({"path": "notes.md"}),
            "policy-approval",
            "",
        );
        assert_eq!(
            approval_title(&write, "Hex", false),
            "Allow Hex to write a file on its computer?"
        );
        let plugin = card(
            "gmail.api.send",
            json!({"to": "a@example.com"}),
            "policy-approval",
            "",
        );
        assert_eq!(
            approval_title(&plugin, "Hex", false),
            "Allow Hex to use a connected service?"
        );
    }

    /// A routine's card asks about the person's routines, never about the Bot's computer, which
    /// none of the four touches; and a delete, which always asks first, asks in the server's own
    /// question, naming the routine as it is stored (opengrok-server #316, recorded at #334, on
    /// main 8e7387f, as
    /// `agui/custom/run-awaiting-approval/a_delete_asks_first_naming_the_routine_as_stored`). That
    /// is its title, and nothing under it names the routine by its id; a delete card from a frame
    /// without the question asks as the others do, and says what it would delete.
    #[test]
    fn a_routines_card_asks_about_routines_and_a_delete_in_the_servers_words() {
        use crate::opengrok::{CREATE_ROUTINE, DELETE_ROUTINE, LIST_ROUTINES, UPDATE_ROUTINE};
        let question = "Delete the routine \"Weekly report\"? It stops for good.";
        let asked = |why: &str| {
            card(
                DELETE_ROUTINE,
                json!({"routine": "sched_3", "name": "A harmless test"}),
                "policy-approval",
                why,
            )
        };
        let delete = asked(question);
        assert_eq!(approval_title(&delete, "Hex", false), question);
        assert!(card_lines(&delete, false).is_empty(), "the title says it");
        assert_eq!(arguments_box(&delete), None);
        let unasked = asked("");
        assert_eq!(
            approval_title(&unasked, "Hex", false),
            "Allow Hex to delete a routine?"
        );
        assert_eq!(
            card_lines(&unasked, false),
            vec!["Delete the routine sched_3"]
        );

        let make = card(
            CREATE_ROUTINE,
            json!({"prompt": "post the standup", "when": ["0 9 * * MON-FRI"]}),
            "policy-approval",
            "",
        );
        assert_eq!(
            approval_title(&make, "Hex", false),
            "Allow Hex to make a routine?"
        );
        assert_eq!(
            card_lines(&make, false),
            vec!["Make a routine that wakes at [\"0 9 * * MON-FRI\"]"]
        );
        let change = card(
            UPDATE_ROUTINE,
            json!({"routine": "sched_3", "name": "Standup"}),
            "policy-approval",
            "",
        );
        assert_eq!(
            approval_title(&change, "Hex", false),
            "Allow Hex to change a routine?"
        );
        assert_eq!(
            card_lines(&change, false),
            vec!["Change the routine sched_3"]
        );
        let list = card(LIST_ROUTINES, json!({}), "policy-approval", "");
        assert_eq!(
            approval_title(&list, "Hex", false),
            "Allow Hex to see its routines?",
            "a Bot's routine tools see its own routines alone (opengrok-server #349)"
        );
        assert_eq!(card_lines(&list, false), vec!["List this Bot's routines"]);
    }

    /// A review card keeps its own title whatever the call is, and the local shell's card asks
    /// about the one command on it (#87).
    #[test]
    fn review_and_local_shell_cards_keep_their_titles() {
        let review = card(
            "computer",
            click(),
            "auto-review",
            "Ask first: the page is a bank.",
        );
        assert_eq!(approval_title(&review, "Hex", true), "Review an action");
        let local = card(
            USER_MACHINE_SHELL,
            json!({"command": "ls"}),
            "exec-consent",
            "",
        );
        assert_eq!(
            approval_title(&local, "Hex", false),
            "Allow Hex to run this command on your local computer?"
        );
    }

    /// Under a review card's title: why the call was stopped, then what it would do. A consent
    /// card says only what it would do, and a call with nothing to summarise shows only its
    /// why, as before.
    #[test]
    fn a_review_card_says_why_then_what_under_its_title() {
        let tunnel = card("computer", click(), "auto-review", TUNNEL);
        assert_eq!(card_lines(&tunnel, true), vec![TUNNEL, CLICK]);
        assert_eq!(card_lines(&tunnel, false), vec![CLICK]);
        let older = card("computer", Value::Null, "auto-review", TUNNEL);
        assert_eq!(card_lines(&older, true), vec![TUNNEL]);
    }

    /// The raw arguments are shown only where they are the meaning. A typed key used to sit in
    /// the box as JSON under a summary that had redacted it.
    #[test]
    fn the_raw_arguments_show_only_where_nothing_else_says_what_the_call_does() {
        let key = format!("sk-live-{}", "a1".repeat(24));
        let typed = card(
            "computer",
            json!({"action": "type", "text": key}),
            "auto-review",
            TUNNEL,
        );
        assert_eq!(arguments_box(&typed), None);
        let said = format!(
            "{} {}",
            approval_title(&typed, "Hex", true),
            card_lines(&typed, true).join(" ")
        );
        assert!(said.contains("«redacted»"), "{said}");
        assert!(!said.contains("a1a1"), "{said}");

        let shell = card("shell", json!({"command": "ls -la"}), "policy-approval", "");
        assert_eq!(arguments_box(&shell).as_deref(), Some("ls -la"));
        let bare = card("computer", Value::Null, "auto-review", TUNNEL);
        assert_eq!(
            arguments_box(&bare).as_deref(),
            Some("Command was not included with this request.")
        );
    }

    /// The strip shows three tiles; the count on the last one is what is left over, so a
    /// set of five reads "+2" and every picture is still one click away.
    #[test]
    fn the_last_tile_counts_the_pictures_with_no_room() {
        assert_eq!(overflow_count(5), 2);
        assert_eq!(overflow_count(STRIP_TILES + 1), 1);
    }

    #[test]
    fn a_set_the_strip_fits_counts_nothing() {
        assert_eq!(overflow_count(0), 0);
        assert_eq!(overflow_count(2), 0);
        assert_eq!(overflow_count(STRIP_TILES), 0);
    }
}
