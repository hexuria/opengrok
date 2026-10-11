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

/// The version picker's moving parts, kept as data so a keystroke's answer can be tested
/// without a window: `filter` is what was typed, `highlight` the row the arrows rest on —
/// an index into the filtered list, so every keystroke starts the next match at its top.
#[derive(Debug, Default)]
struct VersionPicker {
    filter: String,
    highlight: usize,
}

/// What a keystroke inside the picker did: swallowed, picked a version, or closed it.
#[derive(Debug, PartialEq, Eq)]
enum PickerKey {
    Handled,
    Pick(u64),
    Close,
}

impl VersionPicker {
    /// The rows under the filter, newest first (the server's order kept): "3" matches v3,
    /// and the head's "latest" label is part of its row so typing "lat" lands there too.
    fn filtered(&self, versions: &[u64], head: u64) -> Vec<u64> {
        let query = self.filter.trim().to_lowercase();
        versions
            .iter()
            .copied()
            .filter(|version| {
                query.is_empty()
                    || version.to_string().contains(&query)
                    || (*version == head && "latest".contains(&query))
            })
            .collect()
    }

    /// One keystroke's answer. `rows` is the filtered list, so highlight moves inside what
    /// the person can see; Enter on an empty list is still swallowed, because a key meant
    /// for the picker must not leak into the window behind it.
    fn press(&mut self, key: &str, ch: Option<char>, rows: &[u64]) -> PickerKey {
        match key {
            "escape" => return PickerKey::Close,
            "enter" => {
                if let Some(version) = rows.get(self.highlight) {
                    return PickerKey::Pick(*version);
                }
            }
            "up" => self.highlight = self.highlight.saturating_sub(1),
            "down" => {
                if self.highlight + 1 < rows.len() {
                    self.highlight += 1;
                }
            }
            "backspace" => {
                self.filter.pop();
                self.highlight = 0;
            }
            _ => {
                if let Some(ch) = ch.filter(|c| !c.is_control()) {
                    self.filter.push(ch);
                    self.highlight = 0;
                }
            }
        }
        PickerKey::Handled
    }
}

/// The card's and the window's ids, by what they act on — the catalogue in `agent/mod.rs`
/// names them so the driver can reach every control from a snapshot. A turn can touch several
/// documents, so a card's ids carry the doc id too.
pub fn card_id(message_id: &str, doc_id: &str) -> String {
    format!("office-card-{message_id}-{doc_id}")
}
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
/// The version trigger on the active tab — a combobox, so its id carries the doc's like a
/// tab's does.
pub fn doc_version_id(doc_id: &str) -> String {
    format!("office-version-{doc_id}")
}
/// One row in the open version list.
pub fn doc_version_row_id(version: u64) -> String {
    format!("office-version-v{version}")
}
/// The footer's way back to the live head while an older version is being browsed.
pub fn doc_version_latest_id() -> &'static str {
    "office-version-latest"
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

/// The feed's document card: the page the document was dealt at — page 1, or the page the
/// change named — fetched through AppState's cache, then the file's name and what last
/// happened to it. The whole card is the window's anchor: clicking it opens the document
/// on that page, like the Open button does.
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
    let page = spec.changed_page().unwrap_or(1);
    let thumb = app.read(cx).office_thumb(&spec.doc_id, spec.version);
    if thumb.is_none() {
        // Deferred past this render's read: the task re-borrows AppState to kick the fetch,
        // and its landing repaints — the card shows the badge row until the page arrives.
        let app = app.clone();
        let spec = spec.clone();
        cx.spawn(async move |cx| {
            app.update(cx, |state, cx| {
                state.ensure_office_thumb(&spec, cx);
            });
        })
        .detach();
    }
    let thumb_row = thumb.map(|image| {
        div()
            .w_full()
            .flex()
            .justify_center()
            .rounded(px(6.))
            .overflow_hidden()
            .border_1()
            .border_color(theme.border)
            .bg(theme.secondary)
            .child(img(image).h(px(280.)).object_fit(ObjectFit::Contain))
            .into_any_element()
    });
    v_flex()
        .id(ElementId::Name(card_id(message_id, &spec.doc_id).into()))
        .w_full()
        .gap(px(8.))
        .p(px(12.))
        .rounded(px(10.))
        .border_1()
        .border_color(theme.border)
        .bg(theme.background)
        .cursor_pointer()
        .on_mouse_down(gpui::MouseButton::Left, {
            let app = app.clone();
            let doc_id = doc_id.clone();
            move |_, _, cx| {
                app.update(cx, |state, cx| {
                    state.open_office_doc(&doc_id, page, cx);
                });
            }
        })
        .children(thumb_row)
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
                                state.open_office_doc(&doc_id, page, cx);
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
    /// The version the person picked in the list — `None` follows the live head, so a new
    /// accept repaints the page on its own. A picked version stays until the head's row is
    /// chosen again.
    view_version: Option<u64>,
    /// The version combobox's open state: `None` is closed.
    picker: Option<VersionPicker>,
    /// The picker's focus owner — while it holds focus, arrows, Enter and the filter's
    /// typing all land on its `on_key_down`.
    picker_focus: gpui::FocusHandle,
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
            view_version: None,
            picker: None,
            picker_focus: cx.focus_handle(),
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
            // A different document is live: its page numbering restarts, a page fetched
            // for the old one is not its page, and a version browsed on it is not this
            // one's history.
            self.page = 1;
            self.page_end = None;
            self.shown = None;
            self.detail = None;
            self.view_version = None;
            self.picker = None;
        }
        self.ensure_surfaces(cx);
        cx.notify();
    }

    /// A card's Open lands here: that document pinned on its tab, on the page the card
    /// named — the first when the change said nothing about pages. Same resets a tab
    /// click makes: the old doc's page, version and detail are not this one's.
    pub(crate) fn show_doc(&mut self, doc_id: &str, page: u32, cx: &mut Context<Self>) {
        self.pinned = Some(doc_id.to_string());
        self.page = page.max(1);
        self.page_end = None;
        self.shown = None;
        self.detail = None;
        self.view_version = None;
        self.picker = None;
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
        let key = (spec.doc_id.clone(), self.shown_version(&spec), self.page);
        let shown_current = self.shown.as_ref().is_some_and(|(id, version, page, _)| {
            id == &key.0 && *version == key.1 && *page == key.2
        });
        let end = self.page_end.is_some_and(|end| self.page > end);
        if !shown_current && !end && self.fetching.as_ref() != Some(&key) {
            self.fetching = Some(key.clone());
            let (id, _, page) = key.clone();
            let at = self.view_version;
            let page_client = client.clone();
            cx.spawn(async move |this, cx| {
                let fetched = page_client.office_doc_page(&id, page, at).await;
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
        // Detail is current when it carries a head at least as new as the spec's: a restored
        // card can name a version behind the server's (the detail then still answers it),
        // while a live frame bumping the spec ahead refetches for the new proposals.
        let dkey = (spec.doc_id.clone(), spec.version);
        let detail_current = self
            .detail
            .as_ref()
            .is_some_and(|detail| detail.doc_id == dkey.0 && detail.version >= spec.version);
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
            self.view_version = None;
            self.picker = None;
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
        self.view_version = None;
        self.picker = None;
        self.ensure_surfaces(cx);
        cx.notify();
    }

    /// The live head: detail's answer when it has landed (a card's saved `version` can be a
    /// relaunch-old word), else the newest frame's.
    fn head_version(&self, spec: &OfficeDocSpec) -> u64 {
        match &self.detail {
            Some(detail) if detail.doc_id == spec.doc_id => detail.version.max(spec.version),
            _ => spec.version,
        }
    }

    /// The version on screen: the picked one, else the live head.
    fn shown_version(&self, spec: &OfficeDocSpec) -> u64 {
        self.view_version.unwrap_or_else(|| self.head_version(spec))
    }

    /// The versions on offer for `spec`, newest first — the server's chain once detail has
    /// landed (it always carries the head), the head alone before it has.
    fn version_list(&self, spec: &OfficeDocSpec) -> Vec<u64> {
        match &self.detail {
            Some(detail) if detail.doc_id == spec.doc_id && !detail.versions.is_empty() => {
                detail.versions.iter().map(|v| v.version).collect()
            }
            _ => vec![self.head_version(spec)],
        }
    }

    /// The chip's click: open the list over the viewed row, or close it. Opening takes the
    /// picker's focus so the next keystroke is the list's. `pub(crate)` for AppState's
    /// driver seam — the window's own actions, reached past the window.
    pub(crate) fn toggle_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.picker.take().is_some() {
            cx.notify();
            return;
        }
        let viewed = self.active_doc().map(|spec| self.shown_version(spec));
        let highlight = self
            .active_doc()
            .map(|spec| {
                self.version_list(spec)
                    .iter()
                    .position(|v| Some(*v) == viewed)
                    .unwrap_or(0)
            })
            .unwrap_or(0);
        self.picker = Some(VersionPicker {
            filter: String::new(),
            highlight,
        });
        self.picker_focus.focus(window, cx);
        cx.notify();
    }

    /// A pick — the list's row or a footer click on the live head. Picking the head is
    /// `None` internally: following live again is not "viewing v{N}", it is watching the
    /// version move. `pub(crate)` for AppState's driver seam.
    pub(crate) fn pick_version(&mut self, version: u64, cx: &mut Context<Self>) {
        let head = self.active_doc().map(|spec| self.head_version(spec));
        self.view_version = (Some(version) != head).then_some(version);
        self.picker = None;
        self.page = 1;
        self.page_end = None;
        self.shown = None;
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
                    .child(if is_active {
                        // The active tab's version is the picker's door — and it shows the
                        // version ON SCREEN, which the head only matches while nothing older
                        // is being browsed. Clicking it is not a tab pin, so it stops here.
                        let shown = self.shown_version(spec);
                        let browsing = self.view_version.is_some();
                        div()
                            .id(ElementId::Name(doc_version_id(&spec.doc_id).into()))
                            .text_xs()
                            .px(px(5.))
                            .rounded(px(4.))
                            .cursor_pointer()
                            .text_color(if browsing {
                                theme.accent
                            } else {
                                theme.muted_foreground
                            })
                            .when(browsing, |chip| chip.bg(theme.secondary))
                            .child(format!("v{shown} ▾"))
                            .on_mouse_down(
                                gpui::MouseButton::Left,
                                cx.listener(|this, _, window, cx| {
                                    cx.stop_propagation();
                                    this.toggle_picker(window, cx);
                                }),
                            )
                            .into_any_element()
                    } else {
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(format!("v{}", spec.version))
                            .into_any_element()
                    })
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

    /// The open version list under the tab strip: the filter line on top, the chain's rows
    /// newest first under it, the viewed row marked. Its keys live on `picker_focus` — the
    /// filter is a line of text, not an input, because every keystroke already arrives at
    /// the popup's handler and a fake field can show them exactly.
    fn version_picker(
        &self,
        spec: &OfficeDocSpec,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(picker) = self.picker.as_ref() else {
            return div().into_any_element();
        };
        let head = self.head_version(spec);
        let viewed = self.shown_version(spec);
        let rows = picker.filtered(&self.version_list(spec), head);

        let mut list = v_flex()
            .id(ElementId::Name("office-version-picker".into()))
            .w(px(230.))
            .rounded(px(8.))
            .border_1()
            .border_color(theme.border)
            .bg(theme.background)
            .shadow_lg()
            .track_focus(&self.picker_focus)
            .on_key_down(
                cx.listener(|this, event: &gpui::KeyDownEvent, _window, cx| {
                    let Some(spec) = this.active_doc().cloned() else {
                        return;
                    };
                    let rows = this
                        .picker
                        .as_ref()
                        .map(|picker| {
                            picker.filtered(&this.version_list(&spec), this.head_version(&spec))
                        })
                        .unwrap_or_default();
                    // Modified keys are commands, not filter text — Cmd+V is paste, not a
                    // "v" somebody meant to filter by.
                    let mods = &event.keystroke.modifiers;
                    let ch = if mods.control || mods.alt || mods.platform {
                        None
                    } else {
                        event
                            .keystroke
                            .key_char
                            .as_deref()
                            .and_then(|s| s.chars().next())
                    };
                    let outcome = this
                        .picker
                        .as_mut()
                        .map(|picker| picker.press(&event.keystroke.key, ch, &rows));
                    match outcome {
                        Some(PickerKey::Pick(version)) => this.pick_version(version, cx),
                        Some(PickerKey::Close) => {
                            this.picker = None;
                            cx.notify();
                        }
                        _ => cx.notify(),
                    }
                }),
            )
            .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation());

        list = list.child(
            h_flex()
                .h(px(30.))
                .px(px(10.))
                .items_center()
                .border_b_1()
                .border_color(theme.border)
                .child(
                    div()
                        .text_xs()
                        .text_color(if picker.filter.is_empty() {
                            theme.muted_foreground
                        } else {
                            theme.foreground
                        })
                        .child(if picker.filter.is_empty() {
                            "Filter versions…".to_string()
                        } else {
                            format!("{}▏", picker.filter)
                        }),
                ),
        );

        for (index, version) in rows.iter().enumerate() {
            let version = *version;
            let highlighted = index == picker.highlight;
            let label = if version == head {
                format!("v{version} · latest")
            } else {
                format!("v{version}")
            };
            list = list.child(
                h_flex()
                    .id(ElementId::Name(doc_version_row_id(version).into()))
                    .h(px(28.))
                    .px(px(10.))
                    .items_center()
                    .justify_between()
                    .cursor_pointer()
                    .when(highlighted, |row| row.bg(theme.secondary))
                    .child(div().text_xs().text_color(theme.foreground).child(label))
                    .when(version == viewed, |row| {
                        row.child(div().text_xs().text_color(theme.accent).child("viewing"))
                    })
                    .on_mouse_down(
                        gpui::MouseButton::Left,
                        cx.listener(move |this, _, _, cx| {
                            cx.stop_propagation();
                            this.pick_version(version, cx);
                        }),
                    ),
            );
        }
        if rows.is_empty() {
            list = list.child(
                div()
                    .px(px(10.))
                    .h(px(28.))
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child("No versions match"),
            );
        }
        div()
            .absolute()
            .top(px(48.))
            .right(px(12.))
            .child(list)
            .into_any_element()
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
        let shown_version = active
            .as_ref()
            .map(|spec| self.shown_version(spec))
            .unwrap_or(0);

        // The page area: the fetched page fitted to the window, or the reason it is not
        // there — a doc whose kind cannot render yet, a fetch that failed, or a doc still
        // on its way.
        let page_area: AnyElement = match (active.as_ref(), &self.shown) {
            (Some(spec), Some((id, version, page, image)))
                if id == &spec.doc_id && *version == shown_version && *page == self.page =>
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
                            .map(|spec| match self.view_version {
                                Some(viewed) => format!(
                                    "{} · v{viewed} (live v{})",
                                    spec.path,
                                    self.head_version(spec)
                                ),
                                None => {
                                    format!("{} · v{}", spec.path, self.head_version(spec))
                                }
                            })
                            .unwrap_or_default(),
                    ),
            )
            .child(
                h_flex()
                    .gap(px(6.))
                    .items_center()
                    .when(self.view_version.is_some(), |row| {
                        // Back to the head: the picker's "latest" row as a one-click way
                        // out of the past.
                        let head = active
                            .as_ref()
                            .map(|spec| self.head_version(spec))
                            .unwrap_or(0);
                        row.child(
                            Button::new(SharedString::from(doc_version_latest_id()))
                                .label(format!("v{head} live"))
                                .ghost()
                                .small()
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.pick_version(head, cx);
                                })),
                        )
                    })
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
            .relative()
            .bg(theme.background)
            // Any click the popup's own stop didn't swallow is a click outside it — the
            // combobox's dismiss, the way a real menu's scrim works.
            .on_mouse_down(
                gpui::MouseButton::Left,
                cx.listener(|this, _, _, cx| {
                    if this.picker.take().is_some() {
                        cx.notify();
                    }
                }),
            )
            .child(self.tabs(&theme, cx))
            .child(page_area)
            .children(self.proposals(&theme))
            .child(footer)
            .children(
                active
                    .as_ref()
                    .filter(|_| self.picker.is_some())
                    .map(|spec| self.version_picker(spec, &theme, cx)),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::{PickerKey, VersionPicker};

    /// The chain the window lists — newest first, as `detail.versions` arrives.
    const CHAIN: &[u64] = &[5, 3, 2, 1, 0];

    /// Arrows move one highlight through the filtered rows, clamped at both ends, and
    /// Enter picks the row it rests on — the combobox the person asked for.
    #[test]
    fn arrows_move_one_highlight_and_enter_picks_it() {
        let mut picker = VersionPicker::default();
        assert_eq!(picker.press("down", None, CHAIN), PickerKey::Handled);
        assert_eq!(picker.highlight, 1);
        assert_eq!(picker.press("down", None, CHAIN), PickerKey::Handled);
        assert_eq!(picker.highlight, 2);
        assert_eq!(picker.press("up", None, CHAIN), PickerKey::Handled);
        assert_eq!(picker.highlight, 1);
        assert_eq!(picker.press("up", None, CHAIN), PickerKey::Handled);
        // The top clamps rather than wrapping — v5 is the first row, always.
        assert_eq!(picker.press("up", None, CHAIN), PickerKey::Handled);
        assert_eq!(picker.highlight, 0);
        assert_eq!(picker.press("enter", None, CHAIN), PickerKey::Pick(5));
    }

    /// Typing narrows the rows to matches — and the head's "latest" label is part of its
    /// row, so it is found by its word as well as its number.
    #[test]
    fn typing_filters_and_resets_the_highlight_to_the_first_match() {
        let mut picker = VersionPicker::default();
        picker.press("down", None, CHAIN);
        picker.press("down", None, CHAIN);
        assert_eq!(picker.filtered(CHAIN, 5).len(), 5);
        picker.press("2", Some('2'), CHAIN);
        assert_eq!(picker.filter, "2");
        assert_eq!(picker.filtered(CHAIN, 5), vec![2]);
        assert_eq!(picker.highlight, 0, "a fresh filter starts at the top");
        picker.press("backspace", None, CHAIN);
        picker.press("l", Some('l'), CHAIN);
        picker.press("a", Some('a'), CHAIN);
        assert_eq!(picker.filtered(CHAIN, 5), vec![5], "'lat…' finds latest");
        assert_eq!(picker.press("enter", None, &[5]), PickerKey::Pick(5));
    }

    /// Enter on a list the filter emptied is swallowed — a picker's key never reaches the
    /// window behind it — and Escape closes whatever the state.
    #[test]
    fn enter_on_no_matches_and_escape_are_safe() {
        let mut picker = VersionPicker::default();
        assert_eq!(picker.press("enter", None, &[]), PickerKey::Handled);
        picker.press("9", Some('9'), CHAIN);
        assert!(picker.filtered(CHAIN, 5).is_empty());
        assert_eq!(picker.press("escape", None, CHAIN), PickerKey::Close);
    }
}
