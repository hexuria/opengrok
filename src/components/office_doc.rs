//! The office document surface: the card an `opengrok.officeDoc` frame leaves in the feed,
//! and the window those cards — and the live-follow — open (opengrok-server
//! `crates/opengrok-server/src/office_desk.rs` + `office_routes.rs`, gol/betteroffice).
//!
//! THE WINDOW IS A WATCHER, NOT AN EDITOR. It shows the document the way the server renders
//! it — one PNG page/slide/used-range per fetch — and it follows the turn: the newest
//! `officeDoc` frame is the live tab unless the person pinned one (D12, D14). Editing, which
//! would mean a WASM document core in a webview, is a later phase; until then the proposals a
//! `office_propose` left are listed here so what the Bot is waiting on is visible, and the
//! file itself is reached through the export artifact on the message (D11).
//!
//! The window outlives the turn that opened it: a surface that closed when the run finished
//! would vanish under somebody still reading the page it was showing.

use std::sync::Arc;

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::{ActiveTheme, Disableable as _, Sizable as _, Theme, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;

use crate::opengrok::{OfficeDocDetail, OfficeDocSpec, OpenGrokClient};
use crate::state::AppState;

/// The card's and the window's ids, by what they act on — the catalogue in `agent/mod.rs`
/// names them so the driver can reach every control from a snapshot. A turn can touch several
/// documents, so a card's ids carry the doc id too.
pub fn card_open_id(message_id: &str, doc_id: &str) -> String {
    format!("office-open-{message_id}-{doc_id}")
}
pub fn doc_tab_id(doc_id: &str) -> String {
    format!("office-tab-{doc_id}")
}
pub fn doc_page_prev_id() -> &'static str {
    "office-page-prev"
}
pub fn doc_page_next_id() -> &'static str {
    "office-page-next"
}
pub fn doc_follow_id() -> &'static str {
    "office-follow"
}

/// The kind's colour, from the apps themselves: Word blue, Sheets green, Slides orange.
/// Anything else — a kind a newer server writes — still gets a badge, in the theme's accent.
fn kind_rgb(kind: &str, theme: &Theme) -> Hsla {
    match kind {
        "docx" => rgb(0x2B579A).into(),
        "xlsx" => rgb(0x217346).into(),
        "pptx" => rgb(0xC53F1F).into(),
        _ => theme.accent,
    }
}

/// The badge a document wears in the card and on its tab: the kind's letters on its colour.
fn kind_badge(spec: &OfficeDocSpec, theme: &Theme) -> impl IntoElement {
    div()
        .w(px(30.))
        .h(px(30.))
        .rounded(px(7.))
        .bg(kind_rgb(&spec.kind, theme))
        .flex()
        .items_center()
        .justify_center()
        .child(
            div()
                .text_xs()
                .font_weight(gpui::FontWeight::BOLD)
                .text_color(gpui::white())
                .child(spec.kind_label()),
        )
}

/// The feed's document card: what the file is, what last happened to it, and Open — the
/// window's anchor in the transcript, so a reader can get back to the document after the
/// turn (and the window's tab) moved on.
pub fn render_office_doc_card(
    spec: &OfficeDocSpec,
    message_id: &str,
    app: Entity<AppState>,
    cx: &App,
) -> AnyElement {
    let theme = cx.theme();
    let subline = match spec.changed_type() {
        Some("created") => "Created".to_string(),
        Some("edited") | Some("accepted") => format!("Edited · v{}", spec.version),
        Some("rejected") => "Edits rejected".to_string(),
        Some("exported") => format!("Exported · v{}", spec.version),
        Some("closed") => "Closed".to_string(),
        _ => format!("v{}", spec.version),
    };
    let doc_id = spec.doc_id.clone();
    v_flex()
        .id(ElementId::Name(
            format!("office-card-{message_id}-{}", spec.doc_id).into(),
        ))
        .w_full()
        .gap(px(8.))
        .p(px(12.))
        .rounded(px(10.))
        .border_1()
        .border_color(theme.border)
        .bg(theme.background)
        .child(
            h_flex()
                .gap(px(10.))
                .items_center()
                .child(kind_badge(spec, theme))
                .child(
                    v_flex()
                        .flex_1()
                        .overflow_hidden()
                        .child(
                            div()
                                .text_sm()
                                .font_weight(gpui::FontWeight::SEMIBOLD)
                                .text_color(theme.foreground)
                                .child(spec.file_name().to_string()),
                        )
                        .child(
                            div()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child(format!("{subline} · {}", spec.path)),
                        ),
                )
                .child(
                    Button::new(SharedString::from(card_open_id(message_id, &spec.doc_id)))
                        .label("Open")
                        .ghost()
                        .small()
                        .on_click(move |_, _, cx| {
                            app.update(cx, |state, cx| {
                                state.open_office_doc(&doc_id, cx);
                            });
                        }),
                ),
        )
        .into_any_element()
}

/// One fetched page, and which version of which document it is — a bump on either means the
/// image on screen is old and the fetch runs again.
type ShownPage = (String, u64, u32, Arc<gpui_kit::Image>);

/// The window. Its state is a cache of AppState's — never `app.read` in `render`, because
/// `open_window` paints before the lease that opened it ends (the same constraint
/// `ComputerScreen` documents).
pub struct OfficeDocWindow {
    app: Entity<AppState>,
    client: Option<OpenGrokClient>,
    /// The tab strip, first-touched order, as AppState keeps it.
    docs: Vec<OfficeDocSpec>,
    /// The doc the newest frame touched — the live tab while nothing is pinned.
    live: Option<String>,
    /// The tab the person chose by clicking it; `None` follows the live doc.
    pinned: Option<String>,
    /// The page of the active doc on screen, one-based like the fetch route.
    page: u32,
    /// `(doc_id, version, page, image)` of what is on screen.
    shown: Option<ShownPage>,
    /// A page fetch in flight, deduped on `(doc_id, version, page)`.
    fetching: Option<(String, u64, u32)>,
    /// The page the server answered 404 for: Back stops there instead of fetching it again.
    page_end: Option<u32>,
    /// The active doc's detail — proposals pending — refetched per version.
    detail: Option<OfficeDocDetail>,
    /// A detail fetch in flight, deduped on `(doc_id, version)`.
    detail_fetching: Option<(String, u64)>,
    /// The last fetch failure, painted where the page would be: a window that shows nothing
    /// says why.
    failure: Option<String>,
}

impl OfficeDocWindow {
    pub fn new(app: Entity<AppState>, _window: &mut Window, cx: &mut Context<Self>) -> Self {
        // The read is deferred onto a spawn: this observer can run inside `open_window`'s
        // nested flush while the AppState lease that opened the window is still held.
        cx.observe(&app, |_this, app, cx| {
            cx.notify();
            let app = app.downgrade();
            cx.spawn(async move |this, cx| {
                let _ = this.update(cx, |this, cx| {
                    if let Some(app) = app.upgrade() {
                        let (docs, live, client) = {
                            let state = app.read(cx);
                            (
                                state.office_docs.clone(),
                                state.office_active.clone(),
                                state.opengrok.clone(),
                            )
                        };
                        this.sync(docs, live, client, cx);
                    }
                });
            })
            .detach();
        })
        .detach();
        let this = Self {
            app,
            client: None,
            docs: Vec::new(),
            live: None,
            pinned: None,
            page: 1,
            shown: None,
            fetching: None,
            page_end: None,
            detail: None,
            detail_fetching: None,
            failure: None,
        };
        // The first sync may land before observe's first spawn: open_window draws at once,
        // and the window's first answer to "which doc" should not wait for an event.
        cx.spawn(async move |this, cx| {
            let _ = this.update(cx, |this, cx| this.pull(cx));
        })
        .detach();
        this
    }

    /// Read AppState's office set into the window's cache, then make sure whatever is now
    /// the active tab has a page and a detail fetch going. Every entry point — the observer,
    /// a tab click, a page turn — ends here.
    fn pull(&mut self, cx: &mut Context<Self>) {
        let app = self.app.clone();
        let (docs, live, client) = {
            let state = app.read(cx);
            (
                state.office_docs.clone(),
                state.office_active.clone(),
                state.opengrok.clone(),
            )
        };
        self.sync(docs, live, client, cx);
    }

    /// The state read, deferred past whatever lease was held when it was asked for.
    fn sync(
        &mut self,
        docs: Vec<OfficeDocSpec>,
        live: Option<String>,
        client: Option<OpenGrokClient>,
        cx: &mut Context<Self>,
    ) {
        let before = self.active_doc_id().map(str::to_string);
        self.docs = docs;
        self.live = live;
        self.client = client;
        let after = self.active_doc_id().map(str::to_string);
        if before != after {
            // A different document is live: its page numbering restarts, and a page fetched
            // for the old one is not its page.
            self.page = 1;
            self.page_end = None;
            self.shown = None;
            self.detail = None;
        }
        self.ensure_surfaces(cx);
        cx.notify();
    }

    /// The doc the window is on: the pinned tab, else the live one, else the newest in the
    /// strip — an empty strip is no tab at all.
    fn active_doc(&self) -> Option<&OfficeDocSpec> {
        let id = self.active_doc_id()?;
        self.docs.iter().find(|doc| doc.doc_id == id)
    }

    fn active_doc_id(&self) -> Option<&str> {
        self.pinned
            .as_deref()
            .or(self.live.as_deref())
            .or_else(|| self.docs.last().map(|doc| doc.doc_id.as_str()))
    }

    /// Start whichever fetches the active tab is missing: its page, and its detail for the
    /// proposals list. A bump in version invalidates both — the page was rendered from the
    /// old bytes and the proposals list may have changed with them.
    fn ensure_surfaces(&mut self, cx: &mut Context<Self>) {
        let Some(client) = self.client.clone() else {
            return;
        };
        let Some(spec) = self.active_doc().cloned() else {
            return;
        };
        let key = (spec.doc_id.clone(), spec.version, self.page);
        let shown_current = self.shown.as_ref().is_some_and(|(id, version, page, _)| {
            id == &key.0 && *version == key.1 && *page == key.2
        });
        let end = self.page_end.is_some_and(|end| self.page > end);
        if !shown_current && !end && self.fetching.as_ref() != Some(&key) {
            self.fetching = Some(key.clone());
            let (id, _, page) = key.clone();
            let page_client = client.clone();
            cx.spawn(async move |this, cx| {
                let fetched = page_client.office_doc_page(&id, page).await;
                let _ = this.update(cx, |this, cx| {
                    if this.fetching.as_ref() == Some(&key) {
                        this.fetching = None;
                    }
                    match fetched {
                        Ok(Some(png)) => {
                            this.shown = Some((
                                key.0,
                                key.1,
                                key.2,
                                Arc::new(gpui_kit::Image::from_bytes(
                                    gpui_kit::ImageFormat::Png,
                                    png,
                                )),
                            ));
                            this.failure = None;
                        }
                        // Past the last page — remembered so Back can stop instead of asking
                        // again, and the page pointer steps back onto real content.
                        Ok(None) => {
                            this.page_end = Some(key.2.saturating_sub(1).max(1));
                            if this.page > 1 {
                                this.page -= 1;
                            }
                        }
                        Err(error) => this.failure = Some(error.message.clone()),
                    }
                    this.ensure_surfaces(cx);
                    cx.notify();
                });
            })
            .detach();
        }
        let dkey = (spec.doc_id.clone(), spec.version);
        let detail_current = self
            .detail
            .as_ref()
            .is_some_and(|detail| detail.doc_id == dkey.0 && detail.version == dkey.1);
        if !detail_current && self.detail_fetching.as_ref() != Some(&dkey) {
            self.detail_fetching = Some(dkey.clone());
            let id = dkey.0.clone();
            let detail_client = client.clone();
            cx.spawn(async move |this, cx| {
                let fetched = detail_client.office_doc(&id).await;
                let _ = this.update(cx, |this, cx| {
                    if this.detail_fetching.as_ref() == Some(&dkey) {
                        this.detail_fetching = None;
                    }
                    match fetched {
                        Ok(detail) => this.detail = Some(detail),
                        // A gone doc is a 404 the window reads as closed: the tab keeps the
                        // card's word on it, the detail area says nothing more.
                        Err(_) => this.detail = None,
                    }
                    cx.notify();
                });
            })
            .detach();
        }
    }

    /// A tab click pins the strip on that doc until Follow rejoins the live one.
    fn pin(&mut self, doc_id: &str, cx: &mut Context<Self>) {
        if self.pinned.as_deref() != Some(doc_id) {
            self.pinned = Some(doc_id.to_string());
            self.page = 1;
            self.page_end = None;
            self.shown = None;
            self.detail = None;
            self.ensure_surfaces(cx);
            cx.notify();
        }
    }

    /// Follow rejoins whichever doc the turn is touching now: the pin is dropped and the
    /// live marker takes over again.
    fn follow(&mut self, cx: &mut Context<Self>) {
        self.pinned = None;
        self.page = 1;
        self.page_end = None;
        self.shown = None;
        self.detail = None;
        self.ensure_surfaces(cx);
        cx.notify();
    }

    /// The tab strip: one chip per document, the live one dotted, the shown one raised.
    /// First-touched order — the strip stays put while the live marker moves.
    fn tabs(&self, theme: &Theme, cx: &mut Context<Self>) -> impl IntoElement {
        let active = self.active_doc_id().map(str::to_string);
        let live = self.live.clone();
        h_flex()
            .gap(px(6.))
            .items_center()
            .px(px(80.))
            .h(px(44.))
            .border_b_1()
            .border_color(theme.border)
            .children(self.docs.iter().map(|spec| {
                let is_active = active.as_deref() == Some(spec.doc_id.as_str());
                let is_live = live.as_deref() == Some(spec.doc_id.as_str());
                let doc_id = spec.doc_id.clone();
                let mut tab = h_flex()
                    .id(ElementId::Name(doc_tab_id(&spec.doc_id).into()))
                    .gap(px(6.))
                    .items_center()
                    .px(px(10.))
                    .h(px(28.))
                    .rounded(px(7.))
                    .cursor_pointer()
                    .child(div().w(px(6.)).h(px(6.)).rounded(px(3.)).bg(if is_live {
                        kind_rgb(&spec.kind, theme)
                    } else {
                        theme.border
                    }))
                    .child(
                        div()
                            .text_sm()
                            .text_color(if is_active {
                                theme.foreground
                            } else {
                                theme.muted_foreground
                            })
                            .child(spec.file_name().to_string()),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(format!("v{}", spec.version)),
                    )
                    .on_mouse_down(
                        gpui::MouseButton::Left,
                        cx.listener(move |this, _, _window, cx| {
                            this.pin(&doc_id, cx);
                        }),
                    );
                if is_active {
                    tab = tab.bg(theme.secondary);
                }
                tab
            }))
    }

    /// The proposals the active doc is waiting on, one line each — read-only, because the
    /// accept/reject gestures belong to the editor this window becomes, and inventing a
    /// review door the server's tool gate never wrote would let the client decide.
    fn proposals(&self, theme: &Theme) -> Option<AnyElement> {
        let detail = self.detail.as_ref()?;
        let pending: Vec<_> = detail
            .proposals
            .iter()
            .filter(|proposal| proposal.status == "pending")
            .collect();
        if pending.is_empty() {
            return None;
        }
        let mut list = v_flex()
            .w_full()
            .gap(px(4.))
            .px(px(16.))
            .py(px(8.))
            .border_t_1()
            .border_color(theme.border);
        list = list.child(
            div()
                .text_xs()
                .font_weight(gpui::FontWeight::SEMIBOLD)
                .text_color(theme.muted_foreground)
                .child(format!("WAITING ON REVIEW — {}", pending.len())),
        );
        for proposal in pending {
            let line = if proposal.note.trim().is_empty() {
                format!("{} — {} changes", proposal.id, proposal.changes)
            } else {
                format!(
                    "{} — {} changes · {}",
                    proposal.id, proposal.changes, proposal.note
                )
            };
            list = list.child(div().text_xs().text_color(theme.foreground).child(line));
        }
        Some(list.into_any_element())
    }
}

impl Render for OfficeDocWindow {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // Cloned, not borrowed: the tab strip and buttons take `&mut Context`, and a `&Theme`
        // held across them is a borrow of `cx` still live.
        let theme = cx.theme().clone();
        let active = self.active_doc().cloned();

        // The page area: the fetched page fitted to the window, or the reason it is not
        // there — a doc whose kind cannot render yet, a fetch that failed, or a doc still
        // on its way.
        let page_area: AnyElement = match (active.as_ref(), &self.shown) {
            (Some(spec), Some((id, version, page, image)))
                if id == &spec.doc_id && *version == spec.version && *page == self.page =>
            {
                div()
                    .flex_1()
                    .w_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .p(px(24.))
                    .child(
                        img(image.clone())
                            .size_full()
                            .object_fit(ObjectFit::Contain),
                    )
                    .into_any_element()
            }
            (Some(spec), _) => {
                let (title, note) = if let Some(failure) = &self.failure {
                    (
                        "This page could not be fetched".to_string(),
                        failure.clone(),
                    )
                } else if self.fetching.is_some() {
                    (
                        format!("Rendering {}…", spec.file_name()),
                        "The computer is drawing this page.".to_string(),
                    )
                } else {
                    (
                        format!("No page to show for {}", spec.file_name()),
                        "This document may not render yet — DOCX page layout is still being \
                         wired on the server."
                            .to_string(),
                    )
                };
                v_flex()
                    .flex_1()
                    .w_full()
                    .items_center()
                    .justify_center()
                    .gap(px(10.))
                    .child(kind_badge(spec, &theme))
                    .child(
                        div()
                            .text_sm()
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .text_color(theme.foreground)
                            .child(title),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(note),
                    )
                    .into_any_element()
            }
            (None, _) => v_flex()
                .flex_1()
                .w_full()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .text_sm()
                        .text_color(theme.muted_foreground)
                        .child("No documents yet — they appear here as the Bot works on them."),
                )
                .into_any_element(),
        };

        // The chrome row under the tabs: the doc's identity on the left, page turns and the
        // follow state on the right.
        let footer = h_flex()
            .w_full()
            .h(px(36.))
            .px(px(16.))
            .items_center()
            .justify_between()
            .border_t_1()
            .border_color(theme.border)
            .child(
                div()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .overflow_hidden()
                    .child(
                        active
                            .as_ref()
                            .map(|spec| format!("{} · v{}", spec.path, spec.version))
                            .unwrap_or_default(),
                    ),
            )
            .child(
                h_flex()
                    .gap(px(6.))
                    .items_center()
                    .when(self.pinned.is_some(), |row| {
                        row.child(
                            Button::new(SharedString::from(doc_follow_id()))
                                .label("Follow live")
                                .ghost()
                                .small()
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.follow(cx);
                                })),
                        )
                    })
                    .child(
                        Button::new(SharedString::from(doc_page_prev_id()))
                            .label("‹")
                            .ghost()
                            .small()
                            .disabled(self.page <= 1)
                            .on_click(cx.listener(|this, _, _, cx| {
                                if this.page > 1 {
                                    this.page -= 1;
                                    this.ensure_surfaces(cx);
                                    cx.notify();
                                }
                            })),
                    )
                    .child(div().text_xs().text_color(theme.muted_foreground).child(
                        match self.page_end {
                            Some(end) if end > 0 => format!("{} / {}", self.page, end),
                            _ => format!("{}", self.page),
                        },
                    ))
                    .child(
                        Button::new(SharedString::from(doc_page_next_id()))
                            .label("›")
                            .ghost()
                            .small()
                            .disabled(self.page_end.is_some_and(|end| self.page >= end.max(1)))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.page += 1;
                                this.ensure_surfaces(cx);
                                cx.notify();
                            })),
                    ),
            );

        v_flex()
            .w_full()
            .h_full()
            .bg(theme.background)
            .child(self.tabs(&theme, cx))
            .child(page_area)
            .children(self.proposals(&theme))
            .child(footer)
    }
}
