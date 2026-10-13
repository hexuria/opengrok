//! The coworker's screen (noVNC) in its own window. macOS only: the page is a
//! `wry` WebView laid over the GPUI window; other platforms never build this.
//!
//! The window has a strip of its own above the screen — the WebView is a
//! native child view, so nothing GPUI draws can sit on top of it — with the
//! "Teach a task" control, Open the screen **Needs your attention** (Skip /
//! I'm done) when a handoff is live, and it answers the window keys itself:
//! ⌘W and ⌘Q close this window only, ⌘M minimizes it, ⌘H hides the app.
//!
//! A stopped tape is written to disk and offered on a sheet under the title bar: named, and told
//! which of three things to become, it goes up as a recipe (`POST /recipes`) or as a skill
//! (`POST /skills/from-tape`, where a model reads it into prose). The third outcome is offered
//! and says plainly that it cannot be made yet; see [`TeachOutcome`] for what it is missing.
//!
//! THE SERVER KEEPS NO TAPE. It takes one, makes what it was asked for, and keeps what it made,
//! so this window holds the only copies there are: the events on the sheet and the file
//! [`save_tape`] wrote. A refusal therefore leaves the tape where it is and offers to send it
//! again — a recording is minutes of somebody's work, and pressing Teach a task twice does not
//! get it back.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::InputState;
use gpui_kit::component::{ActiveTheme, Disableable, Icon, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use raw_window_handle::HasWindowHandle;
use wry::{
    Rect, WebViewBuilder,
    dpi::{LogicalPosition, LogicalSize, Position, Size},
};

use crate::actions::{CloseWindow, Hide, Minimize, Quit};
use crate::components::computer::computer_attention_banner;
use crate::components::fields::field_input;
use crate::opengrok::{CoworkerComputer, Failure};
use crate::opengrok::{
    computer_window_attention_done_id, computer_window_attention_id,
    computer_window_attention_skip_id, thin_tape,
};
use crate::state::{AfterRefusal, AppState, TaughtSkill, WRITING_A_LESSON};

/// The title bar the window paints for itself: tall enough for the traffic lights and a
/// button, and the part the person drags the window by.
const TITLE_BAR_HEIGHT: f32 = 44.;
/// Past the traffic lights.
const TITLE_BAR_LEFT_PAD: f32 = 80.;

/// Tells the window when noVNC has painted its first picture, so the window can stop covering
/// the page: until then a viewer is black, and says nothing (#386). noVNC sizes its canvas to the
/// box's screen once the first framebuffer arrives; before that it is empty or the browser's
/// default size, both far smaller than a box's screen. Runs again on every load of the page.
const FRAME_SCRIPT: &str = r#"
(() => {
  const painted = () => {
    const c = document.querySelector('canvas');
    return c && c.width >= 640 && c.height >= 400;
  };
  const tick = () => {
    if (painted()) {
      try { window.ipc.postMessage(JSON.stringify({kind: 'frame'})); } catch (_) {}
      return;
    }
    setTimeout(tick, 250);
  };
  tick();
})();
"#;

/// How long the window covers a page that has not painted, while the server says the screen is
/// ready. Past it the page shows whatever noVNC itself is saying (a refused password, a dropped
/// connection) rather than a cover that never lifts.
const CONNECT_PATIENCE: Duration = Duration::from_secs(15);

/// What the window says over its page, or `None` to show the page: the server's sentence while
/// the screen is not ready, then "Connecting…" until noVNC paints, for `CONNECT_PATIENCE`.
pub fn window_cover(
    computer: Option<&CoworkerComputer>,
    painted: bool,
    waited: Duration,
    name: &str,
) -> Option<String> {
    if let Some(text) = computer.and_then(CoworkerComputer::screen_overlay) {
        return Some(text.to_string());
    }
    (!painted && waited < CONNECT_PATIENCE).then(|| format!("Connecting to {name}'s screen…"))
}

/// What the page reports while a task is being taught: every pointer and key
/// event on the noVNC canvas, in the screen's own 1280×800 coordinates. This is
/// the RAW tape (v1); filtering it into steps and editing them come later.
const TEACH_SCRIPT: &str = r#"
(() => {
  if (window.__ncTeachInstalled) return;
  window.__ncTeachInstalled = true;
  window.__ncTeach = false;
  const post = (payload) => {
    try { window.ipc.postMessage(JSON.stringify(payload)); } catch (_) {}
  };
  const canvas = () => document.querySelector('canvas');
  const scale = (e) => {
    const c = canvas();
    if (!c) return null;
    const r = c.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return {
      x: Math.round((e.clientX - r.left) * 1280 / r.width),
      y: Math.round((e.clientY - r.top) * 800 / r.height),
    };
  };
  const on = (type, handler) => document.addEventListener(type, (e) => {
    if (!window.__ncTeach) return;
    const at = Date.now();
    handler(e, at);
  }, true);
  on('mousedown', (e, at) => { const p = scale(e); if (p) post({kind: 'down', button: e.button, at, ...p}); });
  on('mouseup',   (e, at) => { const p = scale(e); if (p) post({kind: 'up', button: e.button, at, ...p}); });
  on('mousemove', (e, at) => { const p = scale(e); if (p) post({kind: 'move', at, ...p}); });
  on('wheel',     (e, at) => { const p = scale(e); if (p) post({kind: 'wheel', dx: Math.round(e.deltaX), dy: Math.round(e.deltaY), at, ...p}); });
  on('keydown',   (e, at) => post({kind: 'keydown', key: e.key, code: e.code, at}));
  on('keyup',     (e, at) => post({kind: 'keyup', key: e.key, code: e.code, at}));

  // Modifiers the page has sent DOWN to the box must go UP before the page loses the keyboard:
  // a ⌘W or ⌘Q closes this window with Meta still held in the box's X server, and every
  // letter after that is a shortcut there (Alt+F opens Chromium's menu, Super+E the files).
  // noVNC sends a key-up for each key it holds when it sees the matching keyup event.
  const releaseModifiers = () => {
    const c = canvas();
    if (!c) return;
    for (const [key, code] of [
      ['Meta', 'MetaLeft'], ['Meta', 'MetaRight'],
      ['Alt', 'AltLeft'], ['Alt', 'AltRight'],
      ['Control', 'ControlLeft'], ['Control', 'ControlRight'],
      ['Shift', 'ShiftLeft'], ['Shift', 'ShiftRight'],
    ]) {
      c.dispatchEvent(new KeyboardEvent('keyup', { key, code, bubbles: true, cancelable: true }));
    }
  };
  window.__ncRelease = releaseModifiers;
  window.addEventListener('blur', releaseModifiers);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseModifiers(); });

  // The page's own background — the letterbox around the 1280×800 screen — in the colour the
  // app asks for (see `paint_page`), so it follows the app's theme rather than noVNC's dark.
  window.__ncPaint = (bg) => {
    const css = document.getElementById('nc-theme')
      || Object.assign(document.createElement('style'), {id: 'nc-theme'});
    css.textContent = `html, body, #noVNC_container, #noVNC_screen, .noVNC_canvas, #noVNC_fallback_error { background: ${bg} !important; }`;
    if (!css.parentNode) (document.head || document.documentElement).appendChild(css);
    if (document.body) document.body.style.background = bg;
  };
})();
"#;

/// What a stopped tape can become.
///
/// Three outcomes, three prices, and two of them can be made today. They are all offered because
/// the choice is the point — a person who has just taught something knows which of the three
/// they meant, and a menu that offers one of them silently decides for them — and the one that
/// cannot be made says so on the sheet instead of being quietly unavailable.
///
/// A RECIPE and a SKILL are made from one recording by two different routes, and they are not
/// two names for one thing: a recipe replays the clicks, a skill is the lesson a model writes
/// from watching them. The sheet is the one screen in the app where somebody has to tell the two
/// apart, which is what every word on it is for.
///
/// WHAT THE THIRD IS WAITING FOR, precisely:
///
/// - A WORKFLOW is a decision tree. The server stores and walks one now (`POST /workflows`), and
///   it takes a TREE — named steps, branches, a question for Jev at each fork. A tape is none of
///   that: it is a list of clicks with nothing in it that ever decided anything, and no filter
///   turns one into the other. It needs either something that proposes a tree from a recording,
///   or an editor in this app to write one by hand. Sending a one-step tree that only plays the
///   recipe would be a workflow in name — a tape with a longer route to the same box — which is
///   worse than saying not yet.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum TeachOutcome {
    /// The tape, filtered into steps. What Save has always made, and the default: it is free to
    /// run and instant, where writing a lesson costs a model call and a wait.
    #[default]
    Recipe,
    /// A lesson: written notes on how the task is done, which the model reads before it works.
    /// A model writes them from the tape, and nobody may use them until a person has read them.
    Skill,
    /// A decision tree that drives recipes.
    Workflow,
}

impl TeachOutcome {
    /// The three, in the order the sheet offers them: cheapest to run first.
    pub const ALL: [TeachOutcome; 3] = [Self::Recipe, Self::Skill, Self::Workflow];

    /// What this outcome is called where a person reads it.
    pub fn label(self) -> &'static str {
        match self {
            Self::Recipe => "Recipe",
            Self::Skill => "Skill",
            Self::Workflow => "Workflow",
        }
    }

    /// The id its button answers to, so a driver can pick one by name.
    pub fn element_id(self) -> &'static str {
        match self {
            Self::Recipe => "teach-make-recipe",
            Self::Skill => "teach-make-skill",
            Self::Workflow => "teach-make-workflow",
        }
    }

    /// What this outcome is, in one line, for the person choosing between three things they
    /// have never had to tell apart before.
    ///
    /// The line says what will HAPPEN, not what the thing is called. The two that can be made
    /// are made in different ways — one is a filter, the other is a model reading the tape and
    /// taking its time about it — and the difference in the waiting is as much a part of the
    /// choice as the difference in the result.
    pub fn summary(self) -> &'static str {
        match self {
            Self::Recipe => "The tape, filtered into steps. Your bot replays it exactly.",
            Self::Skill => {
                "Your bot reads the tape and writes the lesson, in words. It stays switched off \
                 until you have read it."
            }
            Self::Workflow => "A decision tree that looks, chooses, and plays recipes.",
        }
    }

    /// Why this outcome cannot be made yet, in the words the sheet shows, or `None` when it can.
    ///
    /// A sentence rather than a flag, because "not yet" on its own is a dead end: what is asked
    /// for here is what somebody would have to build next, named on the screen where the wish
    /// occurs.
    pub fn blocked(self) -> Option<&'static str> {
        match self {
            // A tape filtered into steps, and a tape read into prose: two routes, both built.
            Self::Recipe | Self::Skill => None,
            Self::Workflow => Some(
                "Not yet — the server stores and walks a tree, but nothing turns a tape into \
                 decisions. It needs a tree: proposed from the recording, or written by hand.",
            ),
        }
    }
}

/// A task being taught: when it started and what the page has reported so far.
struct Teaching {
    started_at_ms: i64,
    events: Rc<RefCell<Vec<serde_json::Value>>>,
}

/// What became of the last tape: the line the title bar shows, and what it became, so that line
/// is a way through to the thing rather than a notice.
struct SavedTape {
    line: String,
    went: Option<SavedInto>,
}

/// What the last tape became, and therefore what a click on its line opens. Both pages belong
/// to the main window; this window draws none.
#[derive(Clone)]
enum SavedInto {
    Recipe(String),
    /// The skill's id. It is switched off until somebody reads it, which is the reason this
    /// line is worth clicking rather than only worth reading.
    Skill(String),
}

impl SavedInto {
    /// The line's id, which says which of the two it leads to: a driver reading "saved" off this
    /// window has to be able to tell a recipe from a skill without matching on the copy.
    fn element_id(&self) -> &'static str {
        match self {
            Self::Recipe(_) => "teach-saved-recipe",
            Self::Skill(_) => "teach-saved-skill",
        }
    }
}

/// Why the last Save did not happen, and what there is to do about it.
struct SaveRefusal {
    /// What was said. The server's own sentence where the server spoke, never reworded: it is
    /// the only part that says which of the things went wrong. Where the server said nothing at
    /// all — see [`MAY_HAVE_LANDED`] — this is the app's own, because somebody has to say
    /// something and only the app knows what happened.
    said: String,
    /// What there is to do about it, which decides which control the sheet draws. See
    /// [`after_refusal`]: what the words say is the server's business, whether a button that
    /// cannot work is put under them is this app's.
    next: AfterRefusal,
    /// The tape went out, as against a refusal this app made before sending anything. Only the
    /// first raises the question "is my recording gone".
    sent: bool,
}

impl SaveRefusal {
    /// A refusal this app made itself, with nothing sent: a tape with no name, no session, an
    /// outcome nothing can make. Pressing anything again changes none of them.
    fn here(said: impl Into<String>) -> Self {
        Self {
            said: said.into(),
            next: AfterRefusal::Nothing,
            sent: false,
        }
    }

    /// What the server said about a tape that went out, or what the app says for the tape whose
    /// answer never arrived.
    fn from_server(outcome: TeachOutcome, error: &crate::opengrok::OpenGrokError) -> Self {
        let next = after_refusal(error);
        Self {
            said: match next {
                AfterRefusal::LookFirst => may_have_landed(outcome),
                _ => error.message.clone(),
            },
            next,
            sent: true,
        }
    }
}

/// A stopped tape waiting on Save or Discard: the events, and where the local copy went.
///
/// It is held until Save is taken or Discard is pressed — a refusal leaves it here, because the
/// server keeps no tape and this is one of the only two copies of somebody's minutes of work.
struct PendingTape {
    started_at_ms: i64,
    events: Vec<serde_json::Value>,
    /// Where the copy on this Mac went, or why there is none. Kept apart rather than as one
    /// sentence, because the two are opposite news and the line that reassures somebody their
    /// recording survived cannot be the line that tells them it did not.
    backup: Result<String, String>,
    /// When the tape stopped, which is what the name this sheet writes for itself is dated by.
    /// Kept rather than read off the clock again, so the name does not change under somebody
    /// while they are looking at it.
    stopped_at: chrono::DateTime<chrono::Local>,
}

pub struct ComputerScreen {
    /// The page, or why there is none. A WebView that would not build must not
    /// take the app down with it: the window says what went wrong instead.
    webview: Result<Rc<wry::WebView>, String>,
    coworker_id: String,
    /// The Bot's name, for what the window says while its screen is not up.
    name: String,
    /// The page loaded now: a screen back from a restart or an update is loaded again.
    url: String,
    /// The server's word on the computer, from the app (#386); `None` until the first answer.
    computer: Option<CoworkerComputer>,
    /// noVNC has painted since the page last loaded (`FRAME_SCRIPT`).
    painted: Rc<Cell<bool>>,
    /// Since when the window has been waiting for a picture.
    waiting_since: Instant,
    /// "<name>'s Computer", painted in the title bar.
    title: String,
    focus: FocusHandle,
    /// The page's reports land here whether or not a task is being taught; the
    /// script only posts while `__ncTeach` is on.
    tape: Rc<RefCell<Vec<serde_json::Value>>>,
    teaching: Option<Teaching>,
    /// What became of the last tape, in the title bar: the recipe or skill it was saved as, or
    /// that it was let go.
    last_saved: Option<SavedTape>,
    /// The app: its client uploads a tape, its Recipes and Skills lists are refreshed after,
    /// and it carries what is happening to the window that draws those pages.
    app: Entity<AppState>,
    /// Open-the-screen strip. Copied in — `render` must not `app.read` while
    /// Take over still holds the AppState lease (`open_window` draws before it
    /// returns; a nested read is `double_lease_panic`).
    handoff_attention: Option<(String, String)>,
    /// A stopped tape waiting on Save or Discard, with the sheet under the title bar.
    pending: Option<PendingTape>,
    /// Which of the three things the tape on the sheet is to become.
    outcome: TeachOutcome,
    name_input: Entity<InputState>,
    description_input: Entity<InputState>,
    /// An upload is on its way. For a skill that is a model call, and long enough that the
    /// sheet has to say so rather than look idle.
    saving: bool,
    /// Why the last Save did not happen; the sheet stays open with it, still holding the tape.
    save_error: Option<SaveRefusal>,
}

impl ComputerScreen {
    pub fn new(
        url: &str,
        (coworker_id, name): (&str, &str),
        title: &str,
        app: Entity<AppState>,
        handoff_attention: Option<(String, String)>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        // Theme + handoff: do not `app.read` here or in `render`. `open_window`
        // draws before Take over's AppState update ends. Refresh attention on
        // a spawn so the read runs after that lease is dropped.
        cx.observe(&app, |_this, app, cx| {
            // Theme can repaint now. Do not `app.read` here: this observer can
            // run in `open_window`'s nested flush while Take over still holds
            // the AppState lease.
            cx.notify();
            let app = app.downgrade();
            cx.spawn(async move |this, cx| {
                let _ = this.update(cx, |this, cx| {
                    if let Some(app) = app.upgrade() {
                        let (attention, taught) = {
                            let app = app.read(cx);
                            (app.computer_window_attention(), app.taught_skill.clone())
                        };
                        this.set_handoff_attention(attention, cx);
                        this.follow_taught_skill(taught.as_ref(), cx);
                    }
                    cx.notify();
                });
            })
            .detach();
        })
        .detach();
        // Every render paints the page, but the page may not have loaded by the first one;
        // paint it once more when it has had time to.
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(1500))
                .await;
            let _ = this.update(cx, |this, cx| this.paint_page(cx));
        })
        .detach();
        let tape: Rc<RefCell<Vec<serde_json::Value>>> = Rc::new(RefCell::new(Vec::new()));
        let sink = tape.clone();
        let painted = Rc::new(Cell::new(false));
        let saw_frame = painted.clone();
        let webview = window
            .window_handle()
            .map_err(|error| format!("the window has no native handle: {error}"))
            .and_then(|handle| {
                WebViewBuilder::new()
                    .with_url(url)
                    .with_initialization_script(TEACH_SCRIPT)
                    .with_initialization_script(FRAME_SCRIPT)
                    .with_ipc_handler(move |request: wry::http::Request<String>| {
                        if let Ok(event) = serde_json::from_str::<serde_json::Value>(request.body())
                        {
                            // The first picture is the window's to know, not a step of a tape.
                            if event["kind"] == "frame" {
                                saw_frame.set(true);
                            } else {
                                sink.borrow_mut().push(event);
                            }
                        }
                    })
                    .build_as_child(&handle)
                    .map_err(|error| format!("the screen could not be loaded: {error}"))
            })
            .map(Rc::new);
        if let Err(error) = &webview {
            eprintln!("NativeChat computer: {error}");
        }
        let name_input = cx.new(|cx| InputState::new(window, cx).placeholder("Name this task"));
        let description_input =
            cx.new(|cx| InputState::new(window, cx).placeholder("What it does (optional)"));
        let focus = cx.focus_handle();
        focus.focus(window, cx);
        cx.spawn(async move |this, cx| Self::watch_for_a_picture(this, cx).await)
            .detach();
        Self {
            webview,
            coworker_id: coworker_id.to_string(),
            name: name.to_string(),
            url: url.to_string(),
            computer: None,
            painted,
            waiting_since: Instant::now(),
            title: title.to_string(),
            focus,
            tape,
            teaching: None,
            last_saved: None,
            app,
            handoff_attention,
            pending: None,
            outcome: TeachOutcome::default(),
            name_input,
            description_input,
            saving: false,
            save_error: None,
        }
    }

    /// Keep the line this window is showing about a skill it taught in step with what has
    /// become of that skill since.
    ///
    /// "Switched off until you read it" stops being true the moment somebody reads it and
    /// switches it on — which happens on a page in ANOTHER window, and this line is the only
    /// thing left on screen still saying it. The app carries the fact, so this window follows
    /// it rather than keeping what was true when the lesson landed.
    fn follow_taught_skill(&mut self, taught: Option<&TaughtSkill>, cx: &mut Context<Self>) {
        let (
            Some(SavedTape {
                line,
                went: Some(SavedInto::Skill(showing)),
            }),
            Some(TaughtSkill::Written { id, name, enabled }),
        ) = (self.last_saved.as_mut(), taught)
        else {
            return;
        };
        if showing != id {
            return;
        }
        let said = taught_line(name, *enabled);
        if *line != said {
            *line = said;
            cx.notify();
        }
    }

    pub(crate) fn set_handoff_attention(
        &mut self,
        attention: Option<(String, String)>,
        cx: &mut Context<Self>,
    ) {
        if self.handoff_attention == attention {
            return;
        }
        self.handoff_attention = attention;
        cx.notify();
    }

    /// Let go of every modifier the page holds in the box before this window stops receiving
    /// keys — the keyup for the ⌘ that closed or hid the window would otherwise never arrive.
    fn release_keys(&self) {
        if let Ok(webview) = &self.webview {
            let _ = webview.evaluate_script("window.__ncRelease && window.__ncRelease();");
        }
    }

    /// The page's own background — the letterbox around the 1280×800 screen — in the app's
    /// background colour, so it is light in the light theme and dark in the dark one rather
    /// than noVNC's dark whatever the theme. A no-op until the page has loaded.
    /// Repaint while the window is waiting for its first picture: the page's word arrives on its
    /// own thread of events, not through `cx`, and the cover lifts on the next render after it.
    async fn watch_for_a_picture(this: WeakEntity<Self>, cx: &mut AsyncApp) {
        let mut was = false;
        loop {
            cx.background_executor()
                .timer(Duration::from_millis(250))
                .await;
            let Ok(now) = this.update(cx, |this, cx| {
                let now = this.painted.get();
                if now != was || this.cover().is_some() {
                    cx.notify();
                }
                now
            }) else {
                return;
            };
            was = now;
        }
    }

    /// The server's word on this Bot's computer, from the app. A screen going away (a restart, a
    /// reset, an update) is covered until a new picture; one coming back, or on a new address, is
    /// loaded again, since the page still holds the connection that dropped.
    pub fn set_computer(&mut self, computer: CoworkerComputer, cx: &mut Context<Self>) {
        let was_ready = self.screen_ready();
        let url = computer.vnc_url().map(str::to_string);
        self.computer = Some(computer);
        let ready = self.screen_ready();
        if !ready {
            self.painted.set(false);
        }
        if let (true, Some(url)) = (ready, url)
            && (!was_ready || url != self.url)
        {
            if let Ok(webview) = &self.webview {
                let _ = webview.load_url(&url);
            }
            self.url = url;
            self.painted.set(false);
            self.waiting_since = Instant::now();
        }
        cx.notify();
    }

    /// The Bot was renamed: the title bar, the window's own title and what it says while the
    /// screen comes up take the new name.
    pub fn rename(&mut self, name: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.name = name.to_string();
        self.title = crate::state::computer_window_title(name);
        window.set_window_title(&self.title);
        cx.notify();
    }

    fn screen_ready(&self) -> bool {
        self.computer
            .as_ref()
            .is_none_or(|computer| computer.screen_overlay().is_none())
    }

    fn cover(&self) -> Option<String> {
        let waited = self.waiting_since.elapsed();
        window_cover(
            self.computer.as_ref(),
            self.painted.get(),
            waited,
            &self.name,
        )
    }

    fn paint_page(&self, cx: &App) {
        if let Ok(webview) = &self.webview {
            let gpui::Rgba { r, g, b, .. } = cx.theme().background.into();
            let css = format!(
                "rgb({}, {}, {})",
                (r * 255.).round() as u8,
                (g * 255.).round() as u8,
                (b * 255.).round() as u8
            );
            let _ =
                webview.evaluate_script(&format!("window.__ncPaint && window.__ncPaint('{css}');"));
        }
    }

    fn set_teaching(&mut self, on: bool) {
        if let Ok(webview) = &self.webview {
            let _ = webview.evaluate_script(if on {
                "window.__ncTeach = true;"
            } else {
                "window.__ncTeach = false;"
            });
        }
    }

    /// Start a tape, for someone who asked for one from elsewhere — the composer's Teach a task.
    /// A tape that is already running is left alone, so the ask never stops one by accident.
    pub fn start_teaching(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.teaching.is_some() {
            return;
        }
        self.toggle_teaching(window, cx);
    }

    /// Start a tape, or stop the running one: write the local copy and open the save sheet.
    fn toggle_teaching(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match self.teaching.take() {
            None => {
                // A tape still on the sheet is not thrown away by a new one.
                if self.pending.is_some() || self.saving {
                    return;
                }
                self.tape.borrow_mut().clear();
                self.last_saved = None;
                // The app is carrying what became of the LAST tape, for the window that draws
                // the Skills page. A new recording makes that a stale answer.
                //
                // ON A SPAWN, not here. A tape asked for from the composer starts this from
                // inside an update of the AppState — `open_computer_window` calls
                // `start_teaching` while it holds the lease — and touching that entity again
                // from in here is `double_lease_panic`. The same reason the handoff strip is
                // refreshed on a spawn in `new`.
                let app = self.app.downgrade();
                cx.spawn(async move |_, cx| {
                    if let Some(app) = app.upgrade() {
                        app.update(cx, |state, cx| state.set_taught_skill(None, cx));
                    }
                })
                .detach();
                self.set_teaching(true);
                self.teaching = Some(Teaching {
                    started_at_ms: chrono::Utc::now().timestamp_millis(),
                    events: self.tape.clone(),
                });
            }
            Some(session) => {
                self.set_teaching(false);
                let events = session.events.borrow().clone();
                // The file is the backup; the upload is what a page shows.
                let backup = save_tape(&self.coworker_id, session.started_at_ms, &events);
                let stopped_at = chrono::Local::now();
                // Each tape is asked about on its own. A choice left standing from the last one
                // would decide this one silently, which is the thing the choice exists to stop.
                self.outcome = TeachOutcome::default();
                let name = default_tape_name(self.outcome, &stopped_at);
                self.name_input.update(cx, |input, cx| {
                    input.set_value(name, window, cx);
                });
                self.description_input.update(cx, |input, cx| {
                    input.set_value(String::new(), window, cx);
                });
                self.last_saved = None;
                self.save_error = None;
                self.pending = Some(PendingTape {
                    started_at_ms: session.started_at_ms,
                    events,
                    backup,
                    stopped_at,
                });
            }
        }
        cx.notify();
    }

    /// Which of the three the tape is to become. The button for a blocked one is still there to
    /// be pressed: reading why it cannot be made is the only thing it has to offer, and a button
    /// that refuses to be pressed cannot say it.
    ///
    /// The name the sheet wrote for ITSELF changes with the choice, because the two outcomes
    /// name things differently — see [`default_tape_name`]. A name somebody typed is theirs and
    /// is left exactly as typed, whichever of the three they then pick.
    fn choose_outcome(
        &mut self,
        outcome: TeachOutcome,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.saving || self.outcome == outcome {
            return;
        }
        if let Some(pending) = self.pending.as_ref() {
            let ours = default_tape_name(self.outcome, &pending.stopped_at);
            let theirs = default_tape_name(outcome, &pending.stopped_at);
            if self.name_input.read(cx).value().as_ref() == ours.as_str() {
                self.name_input
                    .update(cx, |input, cx| input.set_value(theirs, window, cx));
            }
        }
        self.outcome = outcome;
        // The refusal from an earlier Save was about the outcome that was picked then. It goes
        // from the app with it, or the Try again the app is offering elsewhere outlives the one
        // on this sheet — and points at a refusal nobody is being shown.
        if self.save_error.take().is_some() {
            self.app
                .update(cx, |state, cx| state.set_taught_skill(None, cx));
        }
        cx.notify();
    }

    /// Put a refusal on the sheet AND on the app, which is the only way the two surfaces can
    /// agree about one tape.
    ///
    /// Every refusal comes through here. Four of them used to be written straight onto the
    /// sheet — no name, no session, an outcome nothing can make — leaving the app still showing
    /// the server's older refusal about the same tape, with its own Try again under it.
    ///
    /// Only a SKILL is mirrored, because the app's note is about a lesson; anything else takes
    /// the note away rather than leaving a stale one standing.
    fn refuse(&mut self, refusal: SaveRefusal, cx: &mut Context<Self>) {
        let mirror = (self.outcome == TeachOutcome::Skill).then(|| TaughtSkill::Refused {
            why: refusal.said.clone(),
            next: refusal.next,
            coworker: self.coworker_id.clone(),
        });
        self.save_error = Some(refusal);
        self.app
            .update(cx, |state, cx| state.set_taught_skill(mirror, cx));
        cx.notify();
    }

    /// Save, from the sheet's one button: the tape goes up as whichever of the three it was
    /// told to become.
    ///
    /// An outcome that cannot be made is refused here as well as being unpressable on the sheet,
    /// because this is where the work is: a guard on the button alone is a guard on one of the
    /// ways in.
    fn save(&mut self, cx: &mut Context<Self>) {
        if self.saving {
            return;
        }
        if let Some(why) = self.outcome.blocked() {
            self.refuse(SaveRefusal::here(why), cx);
            return;
        }
        match self.outcome {
            TeachOutcome::Recipe => self.save_recipe(cx),
            TeachOutcome::Skill => self.save_skill(cx),
            // Refused above: nothing turns a tape into a tree.
            TeachOutcome::Workflow => {}
        }
    }

    /// The same bytes again, after a refusal that could come out differently. `false` when this
    /// window has no such tape, so a caller that cannot see the sheet — the driver, through
    /// [`AppState`] — can be told rather than left thinking it sent something.
    ///
    /// THE WHOLE TAPE GOES AGAIN, unchanged. The server keeps no handle to a recording it
    /// refused: there is nothing to reference, nothing to resume, and no way to send the part
    /// that failed. That is the contract, and it is why the events are still in
    /// [`PendingTape`] rather than dropped when the answer came back.
    ///
    /// The server's own refusals end by saying the recording was not consumed and that the same
    /// tape can be sent again — with one exception, which is why [`can_send_again`] exists: a
    /// skill that was written and kept and only then failed to come back names its id, and that
    /// tape IS spent. Sending it again writes a second skill from one recording.
    pub fn retry_save(&mut self, cx: &mut Context<Self>) -> bool {
        let sendable = self
            .save_error
            .as_ref()
            .is_some_and(|refusal| refusal.next == AfterRefusal::SendAgain);
        if self.saving || self.pending.is_none() || !sendable || self.outcome.blocked().is_some() {
            return false;
        }
        self.save(cx);
        true
    }

    /// Upload the tape on the sheet as a recipe. The sheet stays, with the reason and the tape,
    /// when the server refuses it; on success the title bar says what it became.
    fn save_recipe(&mut self, cx: &mut Context<Self>) {
        let Some(pending) = self.pending.as_ref() else {
            return;
        };
        let name = self.name_input.read(cx).value().trim().to_string();
        if name.is_empty() {
            self.refuse(SaveRefusal::here("Give the task a name."), cx);
            return;
        }
        let description = self.description_input.read(cx).value().trim().to_string();
        let Some(client) = self.app.read(cx).opengrok.clone() else {
            self.refuse(SaveRefusal::here("Not connected to OpenGrok."), cx);
            return;
        };
        let raw = upload_tape(&pending.events, pending.started_at_ms);
        self.saving = true;
        self.save_error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = client.create_recipe(&name, &description, &raw).await;
            let _ = this.update(cx, |this, cx| {
                this.saving = false;
                match result {
                    Ok(detail) => {
                        // The server's filtered steps are what a bot will play.
                        let filtered = detail
                            .versions
                            .iter()
                            .find(|version| version.kind == "filtered")
                            .or_else(|| detail.runnable_version());
                        let (version, steps) = filtered
                            .map(|version| (version.version, version.body.steps.len()))
                            .unwrap_or((2, 0));
                        this.pending = None;
                        this.last_saved = Some(SavedTape {
                            line: format!("Saved as {name} · v{version} has {steps} steps"),
                            went: Some(SavedInto::Recipe(detail.recipe.id.clone())),
                        });
                        this.app.update(cx, |state, cx| state.refresh_recipes(cx));
                    }
                    // The tape stays on the sheet, whatever there is to do about it.
                    Err(error) => {
                        let refusal = SaveRefusal::from_server(TeachOutcome::Recipe, &error);
                        this.refuse(refusal, cx);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// Upload the tape on the sheet as a skill: the server hands it to a model, which reads it
    /// and writes the lesson. `save_recipe`'s shape — the same tape, thinned the same way, the
    /// same coworker, the same sheet left standing with the server's sentence on it — for a
    /// call that takes long enough that the waiting has to be drawn.
    ///
    /// WHAT LANDS IS SWITCHED OFF. A lesson a model wrote is not one anybody has read, and the
    /// server refuses a switched-off skill even to the person who owns it. That is not a detail
    /// of the row: it is the whole of what the person has to be told, so it is in the line the
    /// title bar keeps and in what the app carries to the Skills page.
    fn save_skill(&mut self, cx: &mut Context<Self>) {
        let Some(pending) = self.pending.as_ref() else {
            return;
        };
        // No name at all is a request for one: the server mints `taught-<hex>`. The field is
        // filled for exactly that reason (see `default_tape_name`), so this is somebody who
        // emptied it on purpose.
        let name = self.name_input.read(cx).value().trim().to_string();
        let description = self.description_input.read(cx).value().trim().to_string();
        let Some(client) = self.app.read(cx).opengrok.clone() else {
            self.refuse(SaveRefusal::here("Not connected to OpenGrok."), cx);
            return;
        };
        let coworker_id = self.coworker_id.clone();
        let raw = upload_tape(&pending.events, pending.started_at_ms);
        self.saving = true;
        self.save_error = None;
        // The Skills page is in the other window and the driver sees only that one: this is how
        // either of them knows a lesson is being written.
        self.app.update(cx, |state, cx| {
            state.set_taught_skill(Some(TaughtSkill::Writing), cx);
        });
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = client
                .create_skill_from_tape(&coworker_id, &name, &description, &raw)
                .await;
            let _ = this.update(cx, |this, cx| {
                this.saving = false;
                match result {
                    Ok(detail) => {
                        // The server's name, not the one that was typed: it mints one when
                        // nothing was typed, and it is the word that has to be typed after a
                        // slash for this skill to be used at all.
                        let name = detail.skill.name.clone();
                        let id = detail.skill.id.clone();
                        let enabled = detail.skill.enabled;
                        this.pending = None;
                        this.last_saved = Some(SavedTape {
                            line: taught_line(&name, enabled),
                            went: Some(SavedInto::Skill(id.clone())),
                        });
                        this.app.update(cx, |state, cx| {
                            state.set_taught_skill(
                                Some(TaughtSkill::Written { id, name, enabled }),
                                cx,
                            );
                        });
                    }
                    Err(error) => {
                        // The tape stays on the sheet. Nothing about a model that would not
                        // write a lesson makes a recording worth throwing away, and the server
                        // kept no copy of it.
                        let refusal = SaveRefusal::from_server(TeachOutcome::Skill, &error);
                        this.refuse(refusal, cx);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// Let the tape go; the local copy stays where it is.
    fn discard_tape(&mut self, cx: &mut Context<Self>) {
        if let Some(pending) = self.pending.take() {
            self.last_saved = Some(SavedTape {
                line: format!("Not saved · {}", backup_note(&pending.backup)),
                went: None,
            });
        }
        self.save_error = None;
        // With the tape gone there is nothing left to send again, and a Try again the app was
        // still offering elsewhere would be a button with no bytes behind it.
        self.app
            .update(cx, |state, cx| state.set_taught_skill(None, cx));
        cx.notify();
    }

    /// The strip under the title bar after Stop: which of the three to make, a name, a
    /// description, Save and Discard, and what the tape holds or why it cannot go up.
    ///
    /// After a refusal it carries one thing more — Try again, and the line saying the recording
    /// is still here. That is the first question a failed upload raises and the app is the only
    /// thing that can answer it: the server kept no copy.
    fn save_sheet(
        &self,
        pending: &PendingTape,
        theme: &gpui_kit::component::Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let saving = self.saving;
        let blocked = self.outcome.blocked();
        // Three different questions: did something go wrong, is the recording still here, and
        // what — if anything — is worth doing about it.
        let refusal = self.save_error.as_ref();
        let sent = refusal.is_some_and(|refusal| refusal.sent);
        let next = refusal.map(|refusal| refusal.next);
        let outcome = self.outcome;
        // What the line under the sheet says, in the order it matters: a refusal from the last
        // Save, then an outcome that cannot be made at all, then what was taped. The chosen
        // outcome's own line goes beside it, because "what is this" and "why can it not be
        // made" are two different things to be reading.
        let (note, note_color) = match (refusal, blocked) {
            (Some(refusal), _) => (refusal.said.clone(), theme.danger),
            (None, Some(why)) => (why.to_string(), theme.muted_foreground),
            (None, None) => (
                format!(
                    "{} · {} events · {}",
                    self.outcome.summary(),
                    pending.events.len(),
                    backup_note(&pending.backup)
                ),
                theme.muted_foreground,
            ),
        };
        let choices: Vec<AnyElement> = TeachOutcome::ALL
            .into_iter()
            .map(|outcome| {
                let picked = outcome == self.outcome;
                let button = Button::new(outcome.element_id())
                    .small()
                    .label(outcome.label())
                    .disabled(saving)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.choose_outcome(outcome, window, cx)
                    }));
                if picked { button.primary() } else { button }.into_any_element()
            })
            .collect();
        h_flex()
            .id("teach-save-sheet")
            .w_full()
            .flex_shrink_0()
            .flex_wrap()
            .px(px(12.))
            .py(px(8.))
            .gap(px(8.))
            .items_center()
            .bg(theme.sidebar)
            .text_color(theme.foreground)
            .border_b_1()
            .border_color(theme.border)
            // What to make of it comes first, because it is the question the rest of the sheet
            // is answering: a name and a description are a name and a description for something.
            .child(
                h_flex()
                    .id("teach-make")
                    .flex_shrink_0()
                    .items_center()
                    .gap(px(4.))
                    .children(choices),
            )
            .child(
                div().w(px(240.)).child(
                    field_input(&self.name_input)
                        .id("teach-save-name")
                        .disabled(saving),
                ),
            )
            .child(
                div().flex_1().min_w(px(180.)).child(
                    field_input(&self.description_input)
                        .id("teach-save-description")
                        .disabled(saving),
                ),
            )
            .child(
                Button::new("teach-save")
                    .small()
                    .primary()
                    .label(saving_label(self.outcome, saving))
                    // An outcome nothing can make is not a Save waiting to happen, and a button
                    // that looks ready would be the half-wired thing this sheet is avoiding.
                    .disabled(saving || blocked.is_some())
                    .on_click(cx.listener(|this, _, _, cx| this.save(cx))),
            )
            // Only where sending the same bytes again could come out differently — see
            // [`can_send_again`]. Somebody who changed the name presses Save; somebody whose
            // upload met a busy machine presses this. The label promises nothing about the
            // second try, because the sentence beside it is what says how likely it is.
            .when(next == Some(AfterRefusal::SendAgain), |this| {
                this.child(
                    Button::new("teach-retry")
                        .small()
                        .label("Try again")
                        .disabled(saving)
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.retry_save(cx);
                        })),
                )
            })
            // Nothing answered, so nobody knows whether it was written. The one thing to do is
            // look, and this is the way to the page it would be on — sending the tape again
            // before looking is how one recording becomes two skills.
            .when(next == Some(AfterRefusal::LookFirst), |this| {
                this.child(
                    Button::new("teach-check-library")
                        .small()
                        .label(match outcome {
                            TeachOutcome::Skill => "Check Skills",
                            TeachOutcome::Recipe | TeachOutcome::Workflow => "Check Recipes",
                        })
                        .on_click({
                            let app = self.app.clone();
                            move |_, _, cx| {
                                app.update(cx, |state, cx| match outcome {
                                    TeachOutcome::Skill => {
                                        state.show_skill_in_main_window(None, cx)
                                    }
                                    TeachOutcome::Recipe | TeachOutcome::Workflow => {
                                        state.show_recipes_in_main_window(None, cx)
                                    }
                                });
                            }
                        }),
                )
            })
            .child(
                Button::new("teach-discard")
                    .small()
                    .label("Discard")
                    .disabled(saving)
                    .on_click(cx.listener(|this, _, _, cx| this.discard_tape(cx))),
            )
            .child(div().text_xs().text_color(note_color).child(note))
            // Whether or not there is anything to press, the recording is still here and the
            // file is named: a tape refused for a reason no retry can change is still minutes
            // of somebody's work, and they may want the bytes.
            .when(sent, |this| {
                this.child(
                    div()
                        .id("teach-tape-kept")
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(tape_survived_line(&pending.backup)),
                )
            })
            .into_any_element()
    }
}

/// The name the sheet writes for itself when a tape stops, for what that tape is to become.
///
/// TWO SHAPES, because the two are named for different things. A recipe is a row in a list and
/// is named in words. A SKILL's name is what somebody types after a slash — lowercase letters,
/// digits and dashes — and "Task taught on Sep 22, 2026" is not one: the server would refuse it,
/// and the refusal would be the first thing anybody teaching a skill ever saw.
///
/// Neither is left empty, though the route takes an empty one and mints `taught-<hex>` for it.
/// Two tapes stopped close together are minted the same name, and the second comes back as "you
/// already have a skill called that" about a skill nobody named. A field that is already filled
/// is also the easiest one to replace, which is the thing to encourage: the name is what this
/// skill will be invoked by, and the person is the only one who knows what to call it.
///
/// The second is in it for that same reason. Two tapes stopped inside one minute are two tapes
/// with one name, which is the collision this is written to keep clear of.
fn default_tape_name<Tz: chrono::TimeZone>(
    outcome: TeachOutcome,
    stopped_at: &chrono::DateTime<Tz>,
) -> String
where
    Tz::Offset: std::fmt::Display,
{
    match outcome {
        TeachOutcome::Skill => stopped_at
            .format("taught-%b-%-d-%H%M%S")
            .to_string()
            .to_lowercase(),
        TeachOutcome::Recipe | TeachOutcome::Workflow => {
            format!("Task taught on {}", stopped_at.format("%b %-d, %Y"))
        }
    }
}

/// What the Save button says, which is also how long the person is being asked to wait.
///
/// "Saving…" is what an upload is. Writing a lesson is a model reading a recording, which takes
/// long enough that a button saying "Saving…" reads as stuck — so it says what is happening
/// instead, and says who is doing it.
fn saving_label(outcome: TeachOutcome, saving: bool) -> String {
    match (saving, outcome) {
        (true, TeachOutcome::Skill) => WRITING_A_LESSON.to_string(),
        (true, _) => "Saving…".to_string(),
        (false, outcome) => format!("Save as {}", outcome.label().to_lowercase()),
    }
}

/// What the title bar says about a tape that became a skill.
///
/// It arrives switched off, and that is the whole of the review: a model wrote it, nobody has
/// read it, and the server will not let it reach a turn or a colleague until somebody does. The
/// line says so and is a way through to the skill, because reading it is the next thing to do.
fn taught_line(name: &str, enabled: bool) -> String {
    if enabled {
        format!("Wrote the skill {name} · read it")
    } else {
        format!("Wrote the skill {name} · switched off until you read it")
    }
}

/// What there is to do about a refused tape, which is not the same question as what went wrong.
///
/// The wording of a refusal is the server's and is never touched. The BUTTON under it is this
/// app's to offer or withhold, and one that cannot work is worse than none: it tells somebody to
/// press again for a spend cap that will refuse them every time, and it contradicts the sentence
/// right above it.
///
/// NOTHING ANSWERED AT ALL is the dangerous one, and it is why this is three answers and not
/// two. The model call takes most of a minute, so a connection that drops on the way back — a
/// laptop that slept, a VPN re-key, a body that would not decode — is as likely to be a skill
/// the server WROTE and could not report as one it never made. There is no idempotency key on
/// this route, so a second send of a tape that did land writes a second skill from one
/// recording, and the server cannot collapse them. Until there is a key, the honest answer is
/// to say so and send nobody back to the library blind.
///
/// Otherwise it is the kind of failure, not the number. A VERDICT is a decision about this
/// recording, these words or this account — a model that would not write this one down, a model
/// that overran, a spend cap, a name already taken — and the same bytes earn the same decision.
/// OUT OF REACH is a machine that never got to decide: the one status the server uses for
/// "another recording of yours is already being written" is the exception it carves out by hand,
/// because shortly is exactly when to try that one again.
fn after_refusal(error: &crate::opengrok::OpenGrokError) -> AfterRefusal {
    // A skill the server wrote and kept before it failed: named in the sentence, because the
    // reply has nowhere else to put it. Delete this and [`names_a_skill`] when the route takes
    // an idempotency key — that is the real fix, and this stands in for it.
    if names_a_skill(&error.message) {
        return AfterRefusal::Nothing;
    }
    if error.status.is_none() {
        return AfterRefusal::LookFirst;
    }
    if error.status == Some(TOO_MANY_RECORDINGS) {
        return AfterRefusal::SendAgain;
    }
    match error.failure() {
        Failure::OutOfReach(_) => AfterRefusal::SendAgain,
        Failure::Verdict | Failure::SignedOut => AfterRefusal::Nothing,
    }
}

/// One recording at a time per account, and another is already going. The one refusal about
/// this tape that says nothing about this tape.
const TOO_MANY_RECORDINGS: u16 = 429;

/// What the app says when nothing answered at all, in place of a sentence the server never got
/// to write. The transport's own words ("error decoding response body") are for a log.
fn may_have_landed(outcome: TeachOutcome) -> String {
    let (it, page) = match outcome {
        TeachOutcome::Skill => ("your bot may have written the skill", "your skills"),
        TeachOutcome::Recipe | TeachOutcome::Workflow => {
            ("the recipe may have been saved", "your recipes")
        }
    };
    format!(
        "The connection dropped before the answer came back, and {it} anyway. Look at {page} \
         before you send this recording again."
    )
}

/// Whether a refusal names a skill the server has already kept — how it says the tape was used
/// up despite the failure.
///
/// The id is what is matched, never the words around it: `skl_` is what the server mints, and it
/// is the one part of that sentence which cannot be reworded without breaking every other thing
/// that reads an id. A name somebody chose cannot set this off — the server takes no underscores
/// in one — and the cost of a false match is one button, where the cost of a miss is a second
/// skill. Goes when the route takes an idempotency key.
fn names_a_skill(said: &str) -> bool {
    said.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .any(|word| word.starts_with("skl_") && word.len() > "skl_".len())
}

/// Where the copy on this Mac went, in the summary line that lists what the tape holds.
fn backup_note(backup: &Result<String, String>) -> String {
    match backup {
        Ok(path) => format!("kept at {path}"),
        Err(why) => format!("no local copy: {why}"),
    }
}

/// What the sheet says under a refusal, answering the question a refusal raises.
///
/// The recording is not gone. The server takes a tape, makes what it was asked for and keeps
/// what it made — it stores no tapes — so the only copies are the one this sheet is holding and
/// the file on this Mac. Somebody who thinks minutes of their work went with a failed upload
/// records the whole task again.
///
/// TWO SENTENCES WHEN THERE IS NO FILE, because one of them is bad news and the old single line
/// read "Your recording is still here · no local copy" — which contradicts itself in the one
/// place written to stop somebody re-recording their work.
fn tape_survived_line(backup: &Result<String, String>) -> String {
    match backup {
        Ok(path) => format!("Your recording is still here · kept at {path}"),
        Err(why) => format!(
            "Your recording is still here, and this window is holding the only copy of it. \
             Nothing could be written to disk: {why}"
        ),
    }
}

/// The tape as it goes up: `at` counted from when teaching started rather than the page's
/// clock, and the moves thinned.
fn upload_tape(events: &[serde_json::Value], started_at_ms: i64) -> Vec<serde_json::Value> {
    let rebased: Vec<serde_json::Value> = events
        .iter()
        .cloned()
        .map(|mut event| {
            if let Some(object) = event.as_object_mut()
                && let Some(at) = object.get("at").and_then(serde_json::Value::as_i64)
            {
                object.insert(
                    "at".to_string(),
                    serde_json::json!((at - started_at_ms).max(0)),
                );
            }
            event
        })
        .collect();
    thin_tape(&rebased)
}

/// The raw tape (v1) as a JSON file under the app's data directory:
/// `teach/<coworker>/<started>.raw.json`.
fn save_tape(
    coworker_id: &str,
    started_at_ms: i64,
    events: &[serde_json::Value],
) -> Result<String, String> {
    let dir = crate::config::Config::data_dir()
        .join("teach")
        .join(coworker_id);
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let path = dir.join(format!("{started_at_ms}.raw.json"));
    let tape = serde_json::json!({
        "version": 1,
        "coworkerId": coworker_id,
        "startedAtMs": started_at_ms,
        "screen": { "width": 1280, "height": 800 },
        "events": events,
    });
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&tape).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Ok(path.display().to_string())
}

impl Render for ComputerScreen {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.paint_page(cx);
        let theme = cx.theme().clone();
        let teaching = self.teaching.is_some();
        // The sheet holds a tape until it is saved or let go; no new tape until then.
        let waiting = self.pending.is_some() || self.saving;
        let count = self.tape.borrow().len();
        // What became of the last tape. Once it is something, the line is the way to it: the
        // main window opens that page and comes forward. For a skill that is the point of the
        // line rather than a courtesy — it is switched off until somebody reads it, and this is
        // the way to the reading.
        let saved = self.last_saved.as_ref().map(|saved| match &saved.went {
            Some(went) => {
                let (id, app, went) = (went.element_id(), self.app.clone(), went.clone());
                div()
                    .id(id)
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .cursor_pointer()
                    .hover(|s| s.text_color(theme.foreground))
                    .on_click(move |_, _, cx| {
                        app.update(cx, |state, cx| match &went {
                            SavedInto::Recipe(recipe) => {
                                state.show_recipes_in_main_window(Some(recipe.clone()), cx);
                            }
                            SavedInto::Skill(skill) => {
                                state.show_skill_in_main_window(Some(skill.clone()), cx);
                            }
                        });
                    })
                    .child(saved.line.clone())
                    .into_any_element()
            }
            None => div()
                .id("teach-saved")
                .text_xs()
                .text_color(theme.muted_foreground)
                .child(saved.line.clone())
                .into_any_element(),
        });
        let header = h_flex()
            .id("computer-window-header")
            .w_full()
            .h(px(TITLE_BAR_HEIGHT))
            .flex_shrink_0()
            .pl(px(TITLE_BAR_LEFT_PAD))
            .pr(px(12.))
            .items_center()
            .gap(px(10.))
            .bg(theme.background)
            .text_color(theme.foreground)
            .border_b_1()
            .border_color(theme.border)
            // The name and the empty run of the bar: the part that drags the window.
            .child(
                div()
                    .id("computer-window-drag")
                    .flex_1()
                    .h_full()
                    .flex()
                    .items_center()
                    .text_sm()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(self.title.clone())
                    .on_mouse_down(MouseButton::Left, |_, window, _| window.start_window_move()),
            )
            .when_some(saved, |this, note| this.child(note))
            .when(teaching, |this| {
                this.child(
                    div()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(format!("Recording · {count} events")),
                )
            })
            // This window draws no pages: the Recipes page belongs to the main window, and
            // this asks that window for it.
            .child(
                Button::new("screen-recipes")
                    .small()
                    .label("Recipes")
                    .icon(
                        Icon::default()
                            .path("icons/library.svg")
                            .size(px(14.))
                            .text_color(theme.foreground),
                    )
                    .on_click({
                        let app = self.app.clone();
                        move |_, _, cx| {
                            app.update(cx, |state, cx| {
                                state.show_recipes_in_main_window(None, cx);
                            });
                        }
                    }),
            )
            .child({
                let button = Button::new("teach-task")
                    .small()
                    .label(if teaching {
                        "Stop teaching"
                    } else {
                        "Teach a task"
                    })
                    .icon(
                        Icon::default()
                            .path("icons/record.svg")
                            .size(px(14.))
                            .text_color(if teaching {
                                gpui::red()
                            } else {
                                theme.foreground
                            }),
                    )
                    .disabled(waiting)
                    .on_click(cx.listener(|this, _, window, cx| this.toggle_teaching(window, cx)));
                if teaching { button.primary() } else { button }
            });
        let sheet = self
            .pending
            .as_ref()
            .map(|pending| self.save_sheet(pending, &theme, cx));
        // Cached copy from new() / observe spawn — never `self.app.read` here.
        let attention = self.handoff_attention.clone();
        let cover = self.cover();
        if let Ok(webview) = &self.webview {
            // The page is a native view over the window: nothing drawn here can sit on top of it,
            // so it is hidden while the window says what the screen is doing.
            let _ = webview.set_visible(cover.is_none());
        }
        let body = match &self.webview {
            Ok(_) if cover.is_some() => div()
                .id("computer-window-screen")
                .relative()
                .size_full()
                .bg(rgb(0x1c1c1e))
                .when_some(cover, |this, text| {
                    this.child(crate::components::computer::screen_status_cover(
                        "computer-window-status",
                        text,
                    ))
                })
                .into_any_element(),
            Ok(webview) => {
                let webview = webview.clone();
                div()
                    .id("computer-window-screen")
                    .size_full()
                    .child(
                        canvas(
                            move |bounds, _, _| {
                                let _ = webview.set_bounds(Rect {
                                    position: Position::Logical(LogicalPosition::new(
                                        f64::from(bounds.origin.x.as_f32()),
                                        f64::from(bounds.origin.y.as_f32()),
                                    )),
                                    size: Size::Logical(LogicalSize::new(
                                        f64::from(bounds.size.width.as_f32()),
                                        f64::from(bounds.size.height.as_f32()),
                                    )),
                                });
                            },
                            |_, _, _, _| {},
                        )
                        .size_full(),
                    )
                    .into_any_element()
            }
            Err(error) => div()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .bg(theme.background)
                .text_color(theme.muted_foreground)
                .text_sm()
                .child(error.clone())
                .into_any_element(),
        };
        v_flex()
            .id("computer-window")
            .track_focus(&self.focus)
            .key_context("ComputerScreen")
            .size_full()
            // This window's keys: close or quit close only this window; the app stays. Each
            // first lets go of the modifiers the page holds in the box (see `release_keys`).
            .on_action(cx.listener(|this, _: &Quit, window, _cx| {
                this.release_keys();
                window.remove_window();
            }))
            .on_action(cx.listener(|this, _: &CloseWindow, window, _cx| {
                this.release_keys();
                window.remove_window();
            }))
            .on_action(cx.listener(|this, _: &Minimize, window, _cx| {
                this.release_keys();
                window.minimize_window();
            }))
            .on_action(cx.listener(|this, _: &Hide, _window, cx| {
                this.release_keys();
                cx.hide();
            }))
            .child(header)
            .when_some(attention, |this, (key, instruction)| {
                this.child(computer_attention_banner(
                    computer_window_attention_id(),
                    computer_window_attention_skip_id(&key),
                    computer_window_attention_done_id(&key),
                    key,
                    instruction,
                    true,
                    self.app.clone(),
                    cx,
                ))
            })
            .when_some(sheet, |this, sheet| this.child(sheet))
            .child(body)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AfterRefusal, CONNECT_PATIENCE, TeachOutcome, after_refusal, default_tape_name,
        may_have_landed, saving_label, tape_survived_line, taught_line, window_cover,
    };
    use crate::opengrok::{CoworkerComputer, OpenGrokError};
    use std::time::Duration;

    fn computer(status: &str, text: &str) -> CoworkerComputer {
        serde_json::from_value(serde_json::json!({
            "agentId": "cw_1", "state": "running", "vncUrl": "http://x/vnc.html",
            "screenStatus": status, "screenStatusText": text,
        }))
        .expect("a computer")
    }

    /// The window covers its page with what the screen is doing until it is ready, then with
    /// "Connecting…" until noVNC paints, and gives up covering after `CONNECT_PATIENCE` so that
    /// noVNC's own word (a refused password) is not hidden for good (#386).
    #[test]
    fn the_window_says_what_the_screen_is_doing_until_its_first_picture() {
        let restarting = computer("restarting", "Restarting Ada's computer…");
        let ready = computer("ready", "");
        let soon = Duration::from_secs(1);
        assert_eq!(
            window_cover(Some(&restarting), true, soon, "Ada").as_deref(),
            Some("Restarting Ada's computer…"),
            "a picture from before the restart is not the screen"
        );
        assert_eq!(
            window_cover(Some(&ready), false, soon, "Ada").as_deref(),
            Some("Connecting to Ada's screen…")
        );
        assert_eq!(window_cover(Some(&ready), true, soon, "Ada"), None);
        assert_eq!(
            window_cover(Some(&ready), false, CONNECT_PATIENCE, "Ada"),
            None,
            "past its patience the page shows what noVNC is saying"
        );
        assert_eq!(
            window_cover(None, false, soon, "Ada").as_deref(),
            Some("Connecting to Ada's screen…"),
            "a server that says nothing still gets Connecting"
        );
    }

    /// A fixed moment, so a name dated by the clock can be read in a test.
    fn stopped_at() -> chrono::DateTime<chrono::Utc> {
        use chrono::TimeZone as _;
        chrono::Utc
            .with_ymd_and_hms(2026, 9, 22, 14, 32, 5)
            .single()
            .expect("a real moment")
    }

    /// Stopping a tape asks which of three to make, and the answer a person gives has to mean
    /// something: two of them do the work, and the one that cannot be made says what it is
    /// waiting for rather than failing later.
    #[test]
    fn stopping_a_tape_offers_three_outcomes_and_two_can_be_made_today() {
        assert_eq!(
            TeachOutcome::ALL
                .iter()
                .map(|outcome| outcome.label())
                .collect::<Vec<_>>(),
            vec!["Recipe", "Skill", "Workflow"],
            "the three words are the vocabulary, in the order they cost to run"
        );
        assert_eq!(
            TeachOutcome::default(),
            TeachOutcome::Recipe,
            "the cheapest and the quickest is what Save still makes when nobody says otherwise"
        );
        assert!(
            TeachOutcome::Recipe.blocked().is_none(),
            "a tape filtered into steps is what the server has always taken"
        );
        assert!(
            TeachOutcome::Skill.blocked().is_none(),
            "a tape read into prose has a route of its own now, and the sheet must not go on \
             saying a lesson has nowhere to be kept"
        );
    }

    /// The Skill line has to say what will HAPPEN: a model writes it, and what it writes is off
    /// until somebody reads it. Both are surprises, and the sheet is where they belong — the
    /// first is why this one takes a while, the second is why the thing cannot be used yet.
    #[test]
    fn the_skill_outcome_says_who_writes_it_and_that_it_arrives_switched_off() {
        let skill = TeachOutcome::Skill.summary();
        assert!(
            skill.contains("Your bot") && skill.contains("writes"),
            "the model is your bot, and it is the thing doing the writing: {skill:?}"
        );
        assert!(
            skill.contains("switched off") && skill.contains("read it"),
            "born off, and read before it can be used: {skill:?}"
        );
        assert!(
            !skill.contains("replays"),
            "replaying clicks is what a RECIPE does, and the two words are the one thing this \
             sheet exists to keep apart: {skill:?}"
        );
        assert!(
            TeachOutcome::Recipe.summary().contains("replays"),
            "and a recipe is still the tape played back exactly"
        );
    }

    /// The one outcome that cannot be made. Saying "no" on its own would be a dead end: it names
    /// what is missing, on the screen where somebody is wishing for it.
    #[test]
    fn an_outcome_that_cannot_be_made_says_what_it_is_waiting_for() {
        let workflow = TeachOutcome::Workflow
            .blocked()
            .expect("a tape is not a tree, and nothing turns one into the other");
        assert!(workflow.starts_with("Not yet"), "{workflow}");
        assert!(
            workflow.contains("tree"),
            "the server stores a tree and this has none, which is the whole of the reason, \
             and it read {workflow:?}"
        );
        assert_eq!(
            TeachOutcome::ALL
                .iter()
                .filter(|outcome| outcome.blocked().is_some())
                .count(),
            1,
            "one left, and it is the workflow"
        );
    }

    /// The buttons a driver picks between, each answering to its own name.
    #[test]
    fn each_outcome_has_an_id_of_its_own() {
        let ids: Vec<&str> = TeachOutcome::ALL
            .iter()
            .map(|outcome| outcome.element_id())
            .collect();
        assert_eq!(
            ids,
            vec![
                "teach-make-recipe",
                "teach-make-skill",
                "teach-make-workflow"
            ]
        );
    }

    /// A skill's name is what gets typed after a slash. The sentence a recipe is named with is
    /// not one, and sending it would be refused by the server the first time anybody taught a
    /// skill — so the sheet writes a different default for it.
    #[test]
    fn a_skill_is_not_named_the_way_a_recipe_is() {
        let at = stopped_at();
        assert_eq!(
            default_tape_name(TeachOutcome::Recipe, &at),
            "Task taught on Sep 22, 2026",
            "a recipe is a row in a list and is named in words"
        );
        assert_eq!(
            default_tape_name(TeachOutcome::Workflow, &at),
            "Task taught on Sep 22, 2026"
        );
        let skill = default_tape_name(TeachOutcome::Skill, &at);
        assert_eq!(
            skill, "taught-sep-22-143205",
            "down to the second, because two tapes stopped inside one minute would otherwise \
             be two tapes with one name, and the second is refused as a name already taken"
        );
        assert!(
            skill
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
            "what can be typed after a slash, and nothing else: {skill:?}"
        );
        assert!(
            !skill.is_empty(),
            "not left empty either: the server mints a name for an empty one, and two tapes \
             stopped close together are minted the same name"
        );
    }

    /// Writing a lesson is a model reading a recording, and it takes long enough that a button
    /// saying "Saving…" reads as stuck. It says what is happening, and who is doing it.
    #[test]
    fn the_button_says_a_bot_is_writing_rather_than_that_something_is_saving() {
        assert_eq!(
            saving_label(TeachOutcome::Skill, true),
            "Your bot is writing it…"
        );
        assert_eq!(saving_label(TeachOutcome::Recipe, true), "Saving…");
        assert_eq!(
            saving_label(TeachOutcome::Skill, false),
            "Save as skill",
            "and before it is pressed it names what it will make"
        );
        assert_eq!(saving_label(TeachOutcome::Recipe, false), "Save as recipe");
    }

    /// What lands is switched off, and the line says so rather than reporting a save and leaving
    /// somebody to find out that nothing can use it. The `enabled` it is told is the server's.
    #[test]
    fn a_taught_skill_is_reported_as_needing_to_be_read() {
        let off = taught_line("invoice-lookup", false);
        assert!(
            off.contains("invoice-lookup"),
            "named by what has to be typed after the slash: {off:?}"
        );
        assert!(
            off.contains("switched off") && off.contains("read it"),
            "off, and what makes it not off, in the one line the title bar keeps: {off:?}"
        );
        assert!(
            taught_line("invoice-lookup", true).contains("read it"),
            "a server that sent one already on is still a lesson nobody has read"
        );
        assert!(
            !taught_line("invoice-lookup", true).contains("switched off"),
            "but it must not say off about a skill that is on"
        );
    }

    /// Refusals differ in what there is to DO about them, and the control under the sentence is
    /// the app's answer to that. A Try again under a spend cap contradicts the sentence above it
    /// and puts somebody in a loop that sentence has already said will not end.
    #[test]
    fn what_to_do_about_a_refusal_follows_the_kind_of_failure_not_the_number() {
        // Worth sending again: the one status that says another recording of this account's is
        // already going, and anything the server reports as a machine it could not reach.
        assert_eq!(
            after_refusal(&OpenGrokError::status(429, "one recording at a time")),
            AfterRefusal::SendAgain
        );
        assert_eq!(
            after_refusal(&OpenGrokError::from_server(
                Some(502),
                "the model gateway could not be reached"
            )),
            AfterRefusal::SendAgain,
            "nothing ran, so the same tape may well go through"
        );

        // Not worth it: every verdict about this tape, these words or this account — including
        // the 5xx this route answers itself, which is a decision and not a hop that failed.
        for (status, said) in [
            (402, "This coworker is over its spend limit."),
            (422, "The recording has four actions in it."),
            (409, "You already have a skill called invoice-lookup."),
            (
                400,
                "A skill's name is lowercase letters, digits and dashes.",
            ),
            (413, "That description is 4001 characters."),
            (
                502,
                "Your bot would not write this one down: the recording shows a password.",
            ),
            (
                504,
                "Your bot did not finish in time. Teach a shorter task.",
            ),
        ] {
            assert_eq!(
                after_refusal(&OpenGrokError::status(status, said)),
                AfterRefusal::Nothing,
                "{status} decides about what was sent, and it is unchanged"
            );
        }
    }

    /// The dangerous one. A model call takes most of a minute, so a connection that drops on the
    /// way back is as likely to be a skill the server WROTE and could not report as one it never
    /// made — and the route has no idempotency key, so sending the same tape again would write a
    /// second skill from one recording.
    #[test]
    fn an_answer_that_never_arrived_sends_nobody_back_with_the_same_tape() {
        let dropped = OpenGrokError::message("error decoding response body");
        assert_eq!(after_refusal(&dropped), AfterRefusal::LookFirst);
        assert!(
            dropped.status.is_none(),
            "the case is the missing status, not the words: a transport failure has no sentence"
        );

        let said = may_have_landed(TeachOutcome::Skill);
        assert!(
            said.contains("may have written the skill"),
            "it says what nobody knows rather than reporting a failure: {said:?}"
        );
        assert!(
            said.contains("Look at your skills"),
            "and where to look, because looking is the only thing that answers it: {said:?}"
        );
        assert!(
            may_have_landed(TeachOutcome::Recipe).contains("your recipes"),
            "the same tape saved as a recipe is on the other page"
        );
    }

    /// The one refusal where the tape is spent: the lesson was written and kept, and only the
    /// read-back failed. Sending the same bytes again would write a second skill from one
    /// recording, so the status alone is not enough — the reply names the skill, and that is
    /// the one thing in it worth matching on.
    #[test]
    fn a_refusal_that_names_a_kept_skill_is_not_sent_again() {
        assert_eq!(
            after_refusal(&OpenGrokError::from_server(
                Some(502),
                "The skill skl_7 was written and kept; the gateway could not be reached on the \
                 way back. Do not send this recording again."
            )),
            AfterRefusal::Nothing,
            "a refusal that would otherwise be worth another try, and is not"
        );
        assert_eq!(
            after_refusal(&OpenGrokError::message(
                "skl_7 is on the server; the tape is spent"
            )),
            AfterRefusal::Nothing,
            "and a dropped wire that still managed to name what it kept"
        );
        assert_eq!(
            after_refusal(&OpenGrokError::from_server(
                Some(503),
                "the model gateway could not be reached"
            )),
            AfterRefusal::SendAgain,
            "a refusal that names no skill left nothing behind"
        );
        assert_eq!(
            after_refusal(&OpenGrokError::from_server(
                Some(503),
                "skl_ is not an id and the gateway could not be reached"
            )),
            AfterRefusal::SendAgain,
            "the prefix on its own is not an id"
        );
    }

    /// The question a refused upload raises is whether the recording went with it. It did not:
    /// the server keeps no tape, so the sheet is holding one of the only two copies there are,
    /// and the other is named.
    #[test]
    fn a_refusal_says_the_recording_is_still_here() {
        let kept = tape_survived_line(&Ok("/tmp/teach/cw_1/17.raw.json".to_string()));
        assert!(kept.starts_with("Your recording is still here"), "{kept}");
        assert!(
            kept.contains("/tmp/teach/cw_1/17.raw.json"),
            "and where the file is, for somebody who closes the window: {kept}"
        );

        // The line that reassures somebody cannot be the line that tells them there is no copy.
        // "Your recording is still here · no local copy" contradicted itself in the one place
        // written to stop them recording the whole task a second time.
        let only = tape_survived_line(&Err("Permission denied".to_string()));
        assert!(only.starts_with("Your recording is still here"), "{only}");
        assert!(
            only.contains("only copy") && only.contains("Permission denied"),
            "it says where the one copy is and why there is not a second: {only}"
        );
        assert!(
            !only.contains("· no local copy"),
            "and never in the same breath as the reassurance: {only}"
        );
    }
}
