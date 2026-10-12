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

/// A page's cache key: `(version, page)`. The document id is not in it — one window only ever
/// holds its `owner`, so a key here can never name another file's page.
type PageKey = (u64, u32);

/// How many rendered pages the window keeps. Past it the oldest-inserted page leaves — the
/// one on screen never does. At a few hundred KB a PNG, 64 pages is tens of MB at most.
const PAGE_CACHE_MAX: usize = 64;

/// Insert a fetched page, evicting oldest-inserted past the cap — `protected` (the page on
/// screen) is never evicted: evicting it would blank the window under the person's eyes.
/// Generic and free of `&mut self` so the policy runs in a test without a window or an
/// image pipeline.
fn cache_page<T>(
    pages: &mut std::collections::BTreeMap<PageKey, T>,
    order: &mut std::collections::VecDeque<PageKey>,
    protected: Option<PageKey>,
    key: PageKey,
    image: T,
) {
    if !pages.contains_key(&key) {
        order.push_back(key);
    }
    pages.insert(key, image);
    while pages.len() > PAGE_CACHE_MAX {
        let Some(oldest) = order.pop_front() else {
            break;
        };
        if Some(oldest) == protected {
            order.push_back(oldest);
            continue;
        }
        pages.remove(&oldest);
    }
}

/// The version a page of the asked version is filed under. Asking for the live head can be
/// answered with a different version — the server stands its newest kept copy in when the box
/// is gone — and the page then lives under what it IS. The window keeps asking for the head
/// and finds the answer here; filed under the asked version instead, the answer was never
/// found, nothing was marked failed, and the same page was asked for again, forever.
fn filed_version(stand_ins: &std::collections::BTreeMap<u64, u64>, asked: u64) -> u64 {
    stand_ins.get(&asked).copied().unwrap_or(asked)
}

/// The last page after "no page at `page`". The server's count wins when it sent one — a
/// version with fewer slides than the pointer is past says where its end is, not one page
/// back. Without a count (an older server's 404) the end is at most the page before, and
/// never past an end already known.
fn bound_after_missing(page: u32, page_count: Option<u32>, known: Option<u32>) -> u32 {
    match page_count {
        Some(count) => count.max(1),
        None => {
            let before = page.saturating_sub(1);
            known.map_or(before, |known| known.min(before)).max(1)
        }
    }
}

/// What the page area says when a page could not be drawn: the server's own words, except
/// for the one refusal that is not a failure — a Word document has no page preview yet
/// (`DocxLayoutNotWired`, a 422 without a page count), which a person should read as a fact
/// about the format, not as something broken.
fn page_failure_text(kind: &str, status: Option<u16>, message: &str) -> String {
    if kind == "docx" && status == Some(422) {
        "Word documents don't have a page preview yet. The file itself is fine — save a copy \
         to open it."
            .to_string()
    } else {
        message.to_string()
    }
}

/// The window. Its state is a cache of AppState's — never `app.read` in `render`, because
/// `open_window` paints before the lease that opened it ends (the same constraint
/// `ComputerScreen` documents).
pub struct OfficeDocWindow {
    app: Entity<AppState>,
    /// The one document this window exists for: one window holds one file, so a turn that
    /// touches two files puts each in its own frame — a `-v2`-named sibling can never sit
    /// beside the original posing as its history (AppState keys `office_windows` on it).
    owner: String,
    client: Option<OpenGrokClient>,
    /// The tab strip, first-touched order — always a strip of one, `owner`.
    docs: Vec<OfficeDocSpec>,
    /// The doc the newest frame touched, kept only to dot the tab while the turn works on
    /// it — this window's doc is active whether the turn is on it or not.
    live: Option<String>,
    /// Always `owner`: pinning is how a shared strip chose a doc; this strip has one.
    pinned: Option<String>,
    /// The page of the active doc on screen, one-based like the fetch route.
    page: u32,
    /// `(version, page, image)` of what is on screen — kept painted while the next page
    /// loads, the way a deck keeps slide N visible until N+1 is ready.
    shown: Option<(u64, u32, Arc<gpui_kit::Image>)>,
    /// Pages already fetched, keyed `(version, page)` — a visited or prepared page paints
    /// on the frame the key says it exists, which is what makes the pager feel like
    /// PowerPoint instead of a renderer.
    pages: std::collections::BTreeMap<PageKey, Arc<gpui_kit::Image>>,
    /// Insertion order for `pages`, so the oldest entry leaves when the cache is full.
    order: std::collections::VecDeque<PageKey>,
    /// Page fetches in flight, deduped — the shown page and the next one's prefetch can be
    /// out at the same time.
    fetching: std::collections::BTreeSet<PageKey>,
    /// The last page each version answered, learned from `x-office-pages` or a page that
    /// came back 404 — Next turns off at it instead of clicking into the deck's error.
    page_ends: std::collections::BTreeMap<u64, u32>,
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
    /// This window's own handle, kept for `refresh`: the root view is not registered in
    /// the window's draw-time access tracking, so a `cx.notify` on it queues observers
    /// without marking the window dirty — the window would then only paint when the OS
    /// happened to ask. Every mutation here must end by refreshing the window itself.
    window: gpui::AnyWindowHandle,
    /// The `(version, page)` fetches that already failed — an error is an answer too, so
    /// without this the next notify would ask the same question again, forever. A set:
    /// the shown page and its prefetch can each have an answer.
    failed: std::collections::BTreeSet<PageKey>,
    /// The `(doc, version)` whose detail fetch already failed — the page's gate is a
    /// different key shape, so the detail's retry gets its own.
    detail_failed: Option<(String, u64)>,
    /// Asked version → the version the server answered with in its place (`filed_version`).
    stand_ins: std::collections::BTreeMap<u64, u64>,
    /// Versions the server could only draw from a kept copy (`x-office-stale`) — the footer
    /// says "offline copy" for these even before the detail catches up.
    stale_versions: std::collections::BTreeSet<u64>,
    /// A page answer and the detail's `boxLive` disagree — the box died, or came back,
    /// since the detail was read — so the detail is fetched again.
    detail_refresh: bool,
}

impl OfficeDocWindow {
    /// `docs`, `live` and `client` come in by value — the caller reads them off AppState
    /// before `open_window` starts: the first paint happens inside `open_window`'s nested
    /// flush, where a deferred read still sees the pre-open state and a `cx.notify` from a
    /// sync that lands inside the same flush never schedules another frame. That left a
    /// window stuck on "No documents yet" while its `docs` already held the doc.
    pub fn new(
        app: Entity<AppState>,
        owner: String,
        docs: Vec<OfficeDocSpec>,
        live: Option<String>,
        client: Option<OpenGrokClient>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
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
            pinned: Some(owner.clone()),
            client,
            docs: docs.into_iter().filter(|doc| doc.doc_id == owner).collect(),
            owner,
            live,
            page: 1,
            shown: None,
            pages: std::collections::BTreeMap::new(),
            order: std::collections::VecDeque::new(),
            fetching: std::collections::BTreeSet::new(),
            page_ends: std::collections::BTreeMap::new(),
            detail: None,
            detail_fetching: None,
            failure: None,
            view_version: None,
            picker: None,
            picker_focus: cx.focus_handle(),
            window: window.window_handle(),
            failed: std::collections::BTreeSet::new(),
            detail_failed: None,
            stand_ins: std::collections::BTreeMap::new(),
            stale_versions: std::collections::BTreeSet::new(),
            detail_refresh: false,
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

    /// Mark this window dirty and schedule its next frame directly: `cx.notify` on this
    /// view only reaches the window's invalidator when the draw recorded the entity, and
    /// the root view is updated rather than read — so a notify alone can leave a change
    /// invisible until the OS happens to redraw. `window.refresh` is unconditional.
    fn repaint(&self, cx: &mut Context<Self>) {
        let _ = self.window.update(cx, |_, window, _| window.refresh());
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
        // One window, one file: AppState keeps every touched doc, this window keeps its own.
        self.docs = docs
            .into_iter()
            .filter(|doc| doc.doc_id == self.owner)
            .collect();
        self.live = live.filter(|id| *id == self.owner);
        self.client = client;
        let after = self.active_doc_id().map(str::to_string);
        if before != after {
            // A different document is live: its page numbering restarts, a page fetched
            // for the old one is not its page, and a version browsed on it is not this
            // one's history. Unreachable while `owner` filters the strip to one doc —
            // kept so a change of doc can never leak the old one's pages or bounds.
            self.page = 1;
            self.page_ends.clear();
            self.pages.clear();
            self.order.clear();
            self.fetching.clear();
            self.shown = None;
            self.detail = None;
            self.failed.clear();
            self.detail_failed = None;
            self.stand_ins.clear();
            self.stale_versions.clear();
            self.detail_refresh = false;
            self.view_version = None;
            self.picker = None;
        }
        self.ensure_surfaces(cx);
        cx.notify();
        self.repaint(cx);
    }

    /// A card's Open lands here: this document on the page the card named — the first when
    /// the change said nothing about pages. Any other doc_id means the caller asked the
    /// wrong window; the one-window-one-file rule says ignore it rather than repaint.
    pub(crate) fn show_doc(&mut self, doc_id: &str, page: u32, cx: &mut Context<Self>) {
        if doc_id != self.owner {
            return;
        }
        self.page = page.max(1);
        self.shown = None;
        self.detail = None;
        self.failed.clear();
        self.detail_failed = None;
        self.view_version = None;
        self.picker = None;
        self.ensure_surfaces(cx);
        cx.notify();
        self.repaint(cx);
    }

    /// The chevrons' shared turn — `next` is +1 and `prev` is -1 whether the click came
    /// off the button or off the driver's `office.page.*` verb. A learned end stops the
    /// pointer the way the disabled button stops a hand; on a server without
    /// `x-office-pages` a step past the last page still lands on the 404 path, which
    /// learns the end and steps back.
    pub(crate) fn step_page(&mut self, delta: i64, cx: &mut Context<Self>) {
        let end = self.known_end();
        let mut page = (i64::from(self.page) + delta).max(1);
        if let Some(end) = end {
            page = page.min(i64::from(end));
        }
        let Ok(page) = u32::try_from(page) else {
            return;
        };
        if page != self.page {
            self.page = page;
            self.ensure_surfaces(cx);
            cx.notify();
            self.repaint(cx);
        }
    }

    /// The mirror the agent's tree reads: a document window is a second window, so
    /// `from_state`'s one read of AppState cannot see its pager. The window publishes
    /// (page, learned end) on every change — deferred, because some paths that end here
    /// (the driver's step among them) are already inside an AppState update and a nested
    /// one would panic.
    fn publish_pager(&self, cx: &mut Context<Self>) {
        let end = self.known_end();
        let app = self.app.clone();
        let owner = self.owner.clone();
        let page = self.page;
        cx.defer(move |cx| {
            app.update(cx, |state, _| {
                state.office_pager.insert(owner, (page, end));
            });
        });
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
        self.publish_pager(cx);
        let Some(client) = self.client.clone() else {
            return;
        };
        let Some(spec) = self.active_doc().cloned() else {
            return;
        };
        // Fetches are keyed by the version ASKED for — that is the question, and its failure
        // gate. What came back is filed under the version it is, so the cache and the bound
        // are read through `filed`.
        let asked = self.shown_version(&spec);
        let filed = filed_version(&self.stand_ins, asked);
        // A pointer past a bound already learned snaps back onto real content — a deep link
        // or a fast double-click can land there even though Next greys out at the end.
        if let Some(end) = self.page_ends.get(&filed)
            && self.page > *end
        {
            self.page = (*end).max(1);
        }
        let key = (asked, self.page);
        let filed_key = (filed, self.page);
        // A page already fetched paints on the spot — this is the whole deck-flip feel.
        if let Some(image) = self.pages.get(&filed_key).cloned() {
            if self.shown.as_ref().map(|(v, p, _)| (*v, *p)) != Some(filed_key) {
                self.shown = Some((filed_key.0, filed_key.1, image));
            }
            self.failure = None;
        }
        let shown_current = self
            .shown
            .as_ref()
            .is_some_and(|(v, p, _)| (*v, *p) == filed_key);
        // A failure is an answer too: without `failed` the resolve's own notify would ask
        // the same 401 again — a loop a dead session turned into tens of thousands of hits.
        if !shown_current && !self.failed.contains(&key) && !self.fetching.contains(&key) {
            self.fetch_page(&client, key, cx);
        }
        // The next page arrives before it is asked for: sequential flips — the pager's
        // common case — are cache hits. On a server without `x-office-pages` this probe is
        // also how the bound is learned: its answer writes `page_ends` instead of surfacing.
        let next = (asked, self.page + 1);
        let next_known_past = self.page_ends.get(&filed).is_some_and(|end| next.1 > *end);
        if !next_known_past
            && !self.pages.contains_key(&(filed, next.1))
            && !self.failed.contains(&next)
            && !self.fetching.contains(&next)
        {
            self.fetch_page(&client, next, cx);
        }
        // Detail is current when it carries a head at least as new as the spec's: a restored
        // card can name a version behind the server's (the detail then still answers it),
        // while a live frame bumping the spec ahead refetches for the new proposals. A page
        // answer that disagrees with its `boxLive` makes it old too.
        let dkey = (spec.doc_id.clone(), spec.version);
        let detail_current = !self.detail_refresh
            && self
                .detail
                .as_ref()
                .is_some_and(|detail| detail.doc_id == dkey.0 && detail.version >= spec.version);
        let detail_failed = self.detail_failed.as_ref() == Some(&dkey);
        if !detail_current && !detail_failed && self.detail_fetching.as_ref() != Some(&dkey) {
            self.detail_refresh = false;
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
                        // card's word on it, the detail area says nothing more. The window
                        // still gets told — the failure is painted, not swallowed — and the
                        // gate stops the same ask from firing on every later notify.
                        Err(error) => {
                            this.failure = Some(error.message.clone());
                            this.detail_failed = Some(dkey.clone());
                        }
                    }
                    cx.notify();
                    this.repaint(cx);
                });
            })
            .detach();
        }
    }

    /// One page fetch: the shown page's ask and the next page's prefetch are the same
    /// request — what differs is only what its answer may touch. A landing page goes into
    /// `pages` either way; `shown`, the pointer and `failure` move only when the answer is
    /// for what the window is still pointing at, so a stale prefetch can never paint over
    /// the page the person actually turned to.
    fn fetch_page(&mut self, client: &OpenGrokClient, key: PageKey, cx: &mut Context<Self>) {
        self.fetching.insert(key);
        let id = self.owner.clone();
        let at = self.view_version;
        let page_client = client.clone();
        cx.spawn(async move |this, cx| {
            let fetched = page_client.office_doc_page(&id, key.1, at).await;
            let _ = this.update(cx, |this, cx| {
                this.fetching.remove(&key);
                let asked_now = this.active_doc().map(|spec| this.shown_version(spec));
                let is_current = key.1 == this.page && Some(key.0) == asked_now;
                // Only a head ask can be answered with another version on purpose; an older
                // version is asked by number and comes back as itself or not at all.
                let note_stand_in = |this: &mut Self, served: u64| {
                    if at.is_none() && served != key.0 {
                        this.stand_ins.insert(key.0, served);
                    }
                };
                match fetched {
                    Ok(crate::opengrok::OfficeDocPageAnswer::Page(fetched_page)) => {
                        // The served version is the truth of the bytes — a head that moved
                        // mid-fetch, or a kept copy standing in for a dead box, lands under
                        // the version it actually is, not the one asked.
                        let served = fetched_page.version.unwrap_or(key.0);
                        note_stand_in(this, served);
                        if fetched_page.stale {
                            this.stale_versions.insert(served);
                        }
                        let detail_offline = this
                            .detail
                            .as_ref()
                            .is_some_and(|detail| detail.box_live == Some(false));
                        if at.is_none() && fetched_page.stale != detail_offline {
                            this.detail_refresh = true;
                        }
                        if let Some(count) = fetched_page.page_count {
                            this.page_ends.insert(served, count.max(1));
                        }
                        let image = Arc::new(gpui_kit::Image::from_bytes(
                            gpui_kit::ImageFormat::Png,
                            fetched_page.bytes,
                        ));
                        this.insert_cached((served, key.1), image.clone());
                        let filed_now =
                            asked_now.map(|asked| filed_version(&this.stand_ins, asked));
                        if key.1 == this.page && filed_now == Some(served) {
                            this.shown = Some((served, key.1, image));
                            this.failure = None;
                        }
                    }
                    // No page there — remembered so the pager can stop instead of asking
                    // again, and the pointer lands on the last real page when this was the
                    // one on screen. A count from the server is where that is; a version
                    // with fewer slides than the pointer was on snaps to its own end. Page 1
                    // has nowhere to land: a missing first page is a missing document.
                    Ok(crate::opengrok::OfficeDocPageAnswer::Missing {
                        version,
                        page_count,
                    }) => {
                        this.failed.insert(key);
                        let served = version.unwrap_or(key.0);
                        note_stand_in(this, served);
                        let bound = bound_after_missing(
                            key.1,
                            page_count,
                            this.page_ends.get(&served).copied(),
                        );
                        this.page_ends.insert(served, bound);
                        if is_current {
                            if key.1 > bound {
                                this.page = bound;
                            } else {
                                this.failure = Some("the document has no pages".into());
                            }
                        }
                    }
                    Err(error) => {
                        this.failed.insert(key);
                        if is_current {
                            let kind = this
                                .active_doc()
                                .map(|spec| spec.kind.clone())
                                .unwrap_or_default();
                            this.failure =
                                Some(page_failure_text(&kind, error.status, &error.message));
                        }
                    }
                }
                this.ensure_surfaces(cx);
                cx.notify();
                this.repaint(cx);
            });
        })
        .detach();
    }

    /// `pages` is bounded so a long deck cannot grow the window without limit: past
    /// PAGE_CACHE_MAX the oldest-inserted page leaves — the one on screen never does.
    fn insert_cached(&mut self, key: PageKey, image: Arc<gpui_kit::Image>) {
        let protected = self.shown.as_ref().map(|(v, p, _)| (*v, *p));
        cache_page(&mut self.pages, &mut self.order, protected, key, image);
    }

    /// A tab click pins the strip on that doc — a no-op while the strip is one doc, kept so
    /// the click's other half (a foreign doc's id) still says no rather than repaint.
    fn pin(&mut self, doc_id: &str, cx: &mut Context<Self>) {
        if doc_id != self.owner {
            return;
        }
        if self.pinned.as_deref() != Some(doc_id) {
            self.pinned = Some(doc_id.to_string());
            self.page = 1;
            self.shown = None;
            self.detail = None;
            self.view_version = None;
            self.picker = None;
            self.ensure_surfaces(cx);
            cx.notify();
            self.repaint(cx);
        }
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

    /// The version the page on screen actually is — the shown version, unless the server
    /// answered it with a kept copy of another (`filed_version`).
    fn filed_shown_version(&self, spec: &OfficeDocSpec) -> u64 {
        filed_version(&self.stand_ins, self.shown_version(spec))
    }

    /// The active doc's last page as far as anything has said — the pager's bound.
    fn known_end(&self) -> Option<u32> {
        self.active_doc()
            .map(|spec| self.filed_shown_version(spec))
            .and_then(|version| self.page_ends.get(&version).copied())
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
            window.refresh();
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
        window.refresh();
    }

    /// A pick — the list's row or a footer click on the live head. Picking the head is
    /// `None` internally: following live again is not "viewing v{N}", it is watching the
    /// version move. `pub(crate)` for AppState's driver seam.
    pub(crate) fn pick_version(&mut self, version: u64, cx: &mut Context<Self>) {
        let head = self.active_doc().map(|spec| self.head_version(spec));
        self.view_version = (Some(version) != head).then_some(version);
        self.picker = None;
        self.page = 1;
        self.shown = None;
        // Picking a version is the person asking again — a page that failed once gets to
        // answer differently this time. `page_ends` stays: a version's bound is still true.
        self.failed.clear();
        self.ensure_surfaces(cx);
        cx.notify();
        self.repaint(cx);
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
                            .relative()
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
                            // The list hangs from the chip's own bottom-left — anchored
                            // measures off this element, so the menu opens where the click
                            // happened instead of the window's corner.
                            .when(self.picker.is_some(), |chip| {
                                chip.child(
                                    div().absolute().bottom_0().left_0().h(px(0.)).child(
                                        deferred(
                                            anchored()
                                                .position_mode(AnchoredPositionMode::Local)
                                                .position(point(px(0.), px(0.)))
                                                .child(self.version_picker(spec, theme, cx)),
                                        )
                                        .with_priority(4),
                                    ),
                                )
                            })
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
        list.into_any_element()
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
        let filed_version = active
            .as_ref()
            .map(|spec| self.filed_shown_version(spec))
            .unwrap_or(0);
        let known_end = self.page_ends.get(&filed_version).copied();

        // The page area: the page the pointer names when it is fetched — out of the cache
        // on the frame, no wait — else the failure it earned, else the last page stays up
        // while the new one loads (a deck does not blank slide N while it draws N+1), else
        // the reason there is nothing yet. Cached pages are filed under the version they
        // are; failures under the version asked.
        let current_key = (filed_version, self.page);
        let asked_key = (shown_version, self.page);
        let page_area: AnyElement = match active.as_ref() {
            Some(spec) => {
                let placeholder = |title: String, note: String, spec: &OfficeDocSpec| {
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
                };
                if let Some(image) = self.pages.get(&current_key) {
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
                } else if self.failed.contains(&asked_key) {
                    placeholder(
                        "This page could not be shown".to_string(),
                        self.failure
                            .clone()
                            .unwrap_or_else(|| "this page could not be fetched".to_string()),
                        spec,
                    )
                } else if let Some((_, _, image)) = &self.shown {
                    let image = image.clone();
                    div()
                        .flex_1()
                        .w_full()
                        .flex()
                        .items_center()
                        .justify_center()
                        .p(px(24.))
                        .child(img(image).size_full().object_fit(ObjectFit::Contain))
                        .into_any_element()
                } else if self.fetching.contains(&asked_key) {
                    placeholder(
                        format!("Rendering {}…", spec.file_name()),
                        "The computer is drawing this page.".to_string(),
                        spec,
                    )
                } else {
                    placeholder(
                        format!("No page to show for {}", spec.file_name()),
                        "This document may not render yet — DOCX page layout is still being \
                         wired on the server."
                            .to_string(),
                        spec,
                    )
                }
            }
            None => v_flex()
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
                            .map(|spec| {
                                // A doc whose box is gone still renders — the server serves
                                // the last kept snapshot — so the footer says which copy the
                                // person is looking at instead of letting it pose as live:
                                // the version the page IS, and that it is a kept copy,
                                // whichever of the detail and the page said so first.
                                let offline = self.stale_versions.contains(&filed_version)
                                    || self
                                        .detail
                                        .as_ref()
                                        .is_some_and(|detail| detail.box_live == Some(false));
                                let live = if offline { " · offline copy" } else { "" };
                                let head = self.head_version(spec);
                                if self.view_version.is_some() || filed_version != head {
                                    format!("{} · v{filed_version} (live v{head}){live}", spec.path)
                                } else {
                                    format!("{} · v{head}{live}", spec.path)
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
                    .child(
                        Button::new(SharedString::from(doc_page_prev_id()))
                            .label("‹")
                            .ghost()
                            .small()
                            .disabled(self.page <= 1)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.step_page(-1, cx);
                            })),
                    )
                    .child(div().text_xs().text_color(theme.muted_foreground).child(
                        match known_end {
                            Some(end) if end > 0 => format!("{} / {}", self.page, end),
                            _ => format!("{}", self.page),
                        },
                    ))
                    .child(
                        Button::new(SharedString::from(doc_page_next_id()))
                            .label("›")
                            .ghost()
                            .small()
                            .disabled(known_end.is_some_and(|end| self.page >= end))
                            .on_click(cx.listener(|this, _, _, cx| {
                                // The end learned from a page response greys this button
                                // out, but a click can still land faster than the bound —
                                // step_page's clamp is the second gate.
                                this.step_page(1, cx);
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

    /// The cache evicts oldest-inserted past the cap — a deck longer than the cache still
    /// fits in it — and two versions of the same page are different entries, so browsing
    /// a kept version can never show the head's render.
    #[test]
    fn the_page_cache_evicts_oldest_and_keeps_versions_apart() {
        use super::{PAGE_CACHE_MAX, PageKey, cache_page};
        use std::collections::{BTreeMap, VecDeque};

        let mut pages: BTreeMap<PageKey, usize> = BTreeMap::new();
        let mut order: VecDeque<PageKey> = VecDeque::new();
        for page in 1..=(PAGE_CACHE_MAX as u32 + 2) {
            cache_page(&mut pages, &mut order, None, (0, page), page as usize);
        }
        assert_eq!(pages.len(), PAGE_CACHE_MAX);
        assert!(
            !pages.contains_key(&(0, 1)) && !pages.contains_key(&(0, 2)),
            "the two oldest pages left"
        );
        assert!(pages.contains_key(&(0, PAGE_CACHE_MAX as u32 + 2)));

        // A same-numbered page under another version is its own entry, never the head's.
        cache_page(&mut pages, &mut order, None, (3, 5), 999);
        assert_ne!(pages.get(&(0, 5)), pages.get(&(3, 5)));
        assert_eq!(pages[&(3, 5)], 999);
    }

    /// The page on screen survives eviction even as the oldest entry — evicting it would
    /// blank the window mid-read.
    #[test]
    fn the_shown_page_is_never_evicted() {
        use super::{PAGE_CACHE_MAX, PageKey, cache_page};
        use std::collections::{BTreeMap, VecDeque};

        let mut pages: BTreeMap<PageKey, usize> = BTreeMap::new();
        let mut order: VecDeque<PageKey> = VecDeque::new();
        let on_screen: PageKey = (0, 1);
        cache_page(&mut pages, &mut order, Some(on_screen), on_screen, 1);
        for page in 2..=(PAGE_CACHE_MAX as u32 + 1) {
            cache_page(
                &mut pages,
                &mut order,
                Some(on_screen),
                (0, page),
                page as usize,
            );
        }
        assert_eq!(pages.len(), PAGE_CACHE_MAX);
        assert!(pages.contains_key(&on_screen), "the shown page stayed");
        assert!(!pages.contains_key(&(0, 2)), "the next-oldest went instead");
    }

    /// The head asked, a kept copy answered: the window keeps asking for the head (v3) and
    /// must find the page under the version it is (v1). Filed under the ask instead, the
    /// lookup missed every time and the page was fetched again in a loop.
    #[test]
    fn a_stand_in_answer_is_found_under_the_version_asked() {
        let mut stand_ins = std::collections::BTreeMap::new();
        assert_eq!(
            super::filed_version(&stand_ins, 3),
            3,
            "no stand-in: itself"
        );
        stand_ins.insert(3, 1);
        assert_eq!(super::filed_version(&stand_ins, 3), 1);
        assert_eq!(
            super::filed_version(&stand_ins, 2),
            2,
            "other versions untouched"
        );
    }

    /// The server's count is the bound, wherever the pointer was: a new version with three
    /// slides, asked for slide 7, ends at 3 — not at 6. Without a count the bound is at
    /// most the page before, never past one already known.
    #[test]
    fn past_the_end_lands_on_the_last_real_page() {
        assert_eq!(super::bound_after_missing(7, Some(3), None), 3);
        assert_eq!(super::bound_after_missing(13, Some(12), Some(12)), 12);
        assert_eq!(
            super::bound_after_missing(5, None, None),
            4,
            "older server: one back"
        );
        assert_eq!(
            super::bound_after_missing(5, None, Some(2)),
            2,
            "a known end holds"
        );
        assert_eq!(
            super::bound_after_missing(1, None, None),
            1,
            "page 1 has nowhere to go"
        );
        assert_eq!(super::bound_after_missing(1, Some(0), None), 1);
    }

    /// A Word document's missing preview reads as a fact about the format; every other
    /// failure keeps the server's own words.
    #[test]
    fn a_word_documents_missing_preview_is_not_an_error_message() {
        let docx = super::page_failure_text("docx", Some(422), "the page could not be rendered");
        assert!(
            docx.contains("Word documents don't have a page preview yet"),
            "{docx}"
        );
        assert_eq!(
            super::page_failure_text("pptx", Some(422), "the page could not be rendered"),
            "the page could not be rendered"
        );
        assert_eq!(
            super::page_failure_text("docx", Some(503), "the computer could not be woken"),
            "the computer could not be woken"
        );
    }
}
