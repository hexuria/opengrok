// Public because the agent host rebuilds the open panel's rows from the very same sources, so
// the id it hands a driver is the id the row on screen answers to.
pub mod sources;
#[macro_use]
mod sync_macros;

pub use sources::{AppCommand, BUILTIN_TOOLS, ComposerPick, TokenKind, function_tags_in, tags_in};

use crate::actions::{Library, NewChat, OpenSettings, Projects, ToggleTheme};
use crate::audio::AudioInput;
use crate::chrome::COMPOSER_ICON_PX;
use crate::components::composer_editor::ComposerEditor;
use crate::components::composer_panel::{ComposerPanel, ComposerPanelEvent, ComposerPanelRow};
use crate::components::voice_wave::VoiceWave;
use crate::icons::NativeIcon;
use crate::opengrok::{RecipeParameter, RecipeParameterKind};
use crate::state::{ActiveRecipe, ActiveSkill, AppState, ReplyTo, SubmitChord};
use sources::{ParameterSource, SkillLibrary, SlashSource, ToolSource, ValueSource};
use std::ops::Range;
use std::path::{Path, PathBuf};

use gpui_kit::InteractiveElement;
use gpui_kit::component::{
    ActiveTheme, Icon, IconName, Sizable, Size as ComponentSize,
    button::{Button, ButtonVariants},
    h_flex,
    input::InputEvent,
    tooltip::Tooltip,
    v_flex,
};
use gpui_kit::prelude::*;
use gpui_kit::*;

actions!(
    chat,
    [
        SubmitMessage,
        /// Send the draft, from the field or from the panel standing over it. See
        /// `MessageInput::send_draft` for why the send needs an action of its own.
        SendDraft,
        /// ⌘⇧↵: send the draft now, even over a running turn. The turn is stopped at its
        /// next step and this message goes ahead of anything queued behind it.
        SendDraftSteer
    ]
);

/// The text, whether the person asked for it to go now (⌘⇧↵) rather than queue, and the files
/// already uploaded for it.
type SubmitCallback =
    Box<dyn Fn(String, bool, Vec<crate::opengrok::Attachment>, &mut Context<MessageInput>)>;

/// How a notice that the send is waiting on uploads begins, so settling the last upload can
/// replace it.
const WAITING: &str = "Not sent:";

/// A file on the draft (#90). It is uploaded the moment it is picked, so a file the server
/// refuses says so on its tile while the draft is still being written, and sending names what
/// is already there.
#[derive(Clone, Debug, PartialEq)]
pub struct DraftFile {
    /// Unique on this draft: an upload's answer lands on the tile it was started for, even when
    /// the same file was removed and picked again meanwhile (review of #135).
    pub key: u64,
    pub path: PathBuf,
    /// The file's size on disk when it was picked.
    pub size: u64,
    pub name: String,
    pub mime: String,
    pub state: FileState,
}

#[derive(Clone, Debug, PartialEq)]
pub enum FileState {
    Uploading,
    Ready(crate::opengrok::Attachment),
    /// The server's sentence, or why the file could not be read.
    Failed(String),
}

impl FileState {
    /// The word a driver reads for it.
    pub fn word(&self) -> &'static str {
        match self {
            FileState::Uploading => "uploading",
            FileState::Ready(_) => "ready",
            FileState::Failed(_) => "failed",
        }
    }
}

/// The type a picked file is sent as, from its extension, or `None` for a kind the server does
/// not take. The server takes images, videos, PDFs and `text/*` (opengrok-server#259); a JSON or
/// source file is text to the model, so it goes as `text/plain` rather than being refused.
pub fn file_mime(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "md" | "markdown" => "text/markdown",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "txt" | "log" | "json" | "yaml" | "yml" | "toml" | "xml" | "rs" | "py" | "js" | "ts"
        | "swift" | "go" | "sh" | "sql" => "text/plain",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        _ => return None,
    })
}

/// What the server does with a file, said on the composer before the message goes, so nobody
/// learns it from the bot's reply. From opengrok-server `docs/setup/nativechat.md` ("Attachments:
/// what the server accepts and what the model sees").
pub fn file_caveat(files: &[DraftFile]) -> Option<String> {
    const SHOWN: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp"];
    const PICTURE_MAX: u64 = 10 * 1024 * 1024;
    let pdf = files.iter().any(|file| file.mime == "application/pdf");
    let video = files.iter().any(|file| file.mime.starts_with("video/"));
    let named_picture = files.iter().any(|file| {
        file.mime.starts_with("image/")
            && (!SHOWN.contains(&file.mime.as_str()) || file.size > PICTURE_MAX)
    });
    // The pictures the model is shown, in order, until 8 of them or 20 MiB between them: the
    // server's per-turn budget (`docs/setup/nativechat.md`). The rest go by name.
    const TURN_BUDGET: u64 = 20 * 1024 * 1024;
    let shown: Vec<&DraftFile> = files
        .iter()
        .filter(|file| SHOWN.contains(&file.mime.as_str()) && file.size <= PICTURE_MAX)
        .collect();
    let pictures = shown.len();
    let mut spent = 0u64;
    let over_budget = shown.iter().take(8).any(|file| {
        spent += file.size;
        spent > TURN_BUDGET
    });
    let mut lines = Vec::new();
    if pdf {
        lines.push("The bot sees a PDF's name, not its text yet.");
    }
    if files.iter().any(|file| {
        file.mime
            .starts_with("application/vnd.openxmlformats-officedocument.")
    }) {
        lines.push("A Word, Excel or PowerPoint file is worked on in the bot's own computer.");
    }
    if video {
        lines.push("The bot sees a video's name, not the video.");
    }
    if named_picture {
        lines.push(
            "The bot is shown PNG, JPEG, GIF and WebP pictures up to 10 MB; others go by name.",
        );
    }
    if pictures > 8 {
        lines.push("The bot is shown 8 pictures a message; the rest go by name.");
    }
    if over_budget {
        lines.push("The bot is shown 20 MB of pictures a message; the rest go by name.");
    }
    if files.iter().any(|file| file.mime.starts_with("text/")) {
        lines.push("A text file is read up to its first 20,000 characters.");
    }
    (!lines.is_empty()).then(|| lines.join(" "))
}

/// Which list the open panel is showing, and therefore what a picked row means.
///
/// Public because [`AppState`] keeps a copy of it: the panel itself belongs to this view, and
/// anything outside the view — the agent host, which is built from the state alone — can only
/// tell that `/` opened something if the state says so.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PanelMode {
    /// The "+" button: attach files, teach a task.
    Plus,
    /// `@` with no recipe on the draft: the bot's tools and apps.
    Tools,
    /// `/`: the recipes, workflows and skills the bot can be pointed at, and the app's own
    /// actions.
    Slash,
    /// `@` with a recipe on the draft: what that recipe needs told.
    Parameters,
    /// One parameter of the active recipe, by its place in the declaration, being given a value.
    Value { parameter: usize },
}

/// A chip in the message: what it stands for, and where its text sits.
///
/// The chip is text in the field, because the text field cannot host an element mid-line (see
/// `MessageInput::chip_fills`). This is what makes it more than text: the kind and the id are
/// kept beside it so the message can be sent as structured data rather than re-parsed out of a
/// string that anyone could have typed by hand.
#[derive(Clone, Debug, PartialEq)]
pub struct ComposerToken {
    pub kind: TokenKind,
    /// What the thing is called where it lives: a tool's name, a recipe's id.
    pub id: String,
    /// What the chip reads as in the message: the recipe's name, without the `/` that opened
    /// the panel, because that was how it was asked for and not part of what is being said.
    pub text: String,
    /// Where that text sits, in bytes. Kept true across edits by `resync_tokens`.
    pub range: Range<usize>,
}

pub struct MessageInput {
    input_state: Entity<ComposerEditor>,
    on_submit: Option<SubmitCallback>,
    voice_mode: bool,
    voice_wave: Option<Entity<VoiceWave>>,
    audio_input: Option<AudioInput>,
    state: Entity<AppState>,
    // Cached state to avoid re-rendering on every AppState change
    is_voice_mode_open: bool,
    is_app_settings_open: bool,
    submit_chord: SubmitChord,
    reply_to: Option<ReplyTo>,
    coworker_name: String,
    /// The one wide panel, shared by the "+" button and by the `@` and `/` triggers.
    panel: Entity<ComposerPanel>,
    /// Which list the panel is showing, when it is open.
    panel_mode: Option<PanelMode>,
    /// What each row of the open panel stands for, by row id. The panel only says which row was
    /// picked; this is how the composer knows what to do about it.
    picks: Vec<(SharedString, ComposerPick)>,
    /// Where the caret was when the panel opened, which is where a chip goes.
    caret: usize,
    /// The chips in the message, in the order they appear.
    tokens: Vec<ComposerToken>,
    /// The recipe the message runs, cached off [`AppState`] for the sake of drawing. Every
    /// decision reads the state itself, so a value filled in a moment ago is never missed.
    active_recipe: Option<ActiveRecipe>,
    /// Images to send with the message, shown as thumbnails above the text.
    attachments: Vec<DraftFile>,
    next_file_key: u64,
    /// A line above the field for something the person needs told: a file that was not an image,
    /// a picker that would not open.
    notice: Option<String>,
    /// Where the mouse went down when a click outside shut the panel, so the click on the "+"
    /// that shut it is not also taken as a click to open it again.
    dismissed_at: Option<Point<Pixels>>,
    /// The open thread has a turn in flight, which is what turns the send button into a stop
    /// button. Cached off [`AppState`] like the rest, so the composer draws without reading the
    /// state on every frame.
    turn_in_flight: bool,
}

impl MessageInput {
    pub fn new(window: &mut Window, state: Entity<AppState>, cx: &mut Context<Self>) -> Self {
        let input_state = cx.new(|cx| {
            ComposerEditor::new(window, cx)
                .placeholder(format!("Message {}", composer_bot_name(state.read(cx))))
                .auto_grow(1, 20)
        });
        let panel = cx.new(|cx| ComposerPanel::new(window, cx));

        // Cache initial values from AppState
        let app_state = state.read(cx);
        let is_voice_mode_open = app_state.is_voice_mode_open;
        let is_app_settings_open = app_state.is_app_settings_open;
        let active_recipe = app_state.active_recipe.clone();
        let submit_chord = app_state.submit_chord;
        let reply_to = app_state.reply_to.clone();
        let coworker_name = composer_bot_name(app_state);
        let turn_in_flight = app_state.is_turn_in_flight();

        let this = Self {
            state: state.clone(),
            input_state: input_state.clone(),
            is_voice_mode_open,
            is_app_settings_open,
            submit_chord,
            reply_to,
            coworker_name: coworker_name.clone(),
            on_submit: None,
            voice_mode: false,
            voice_wave: None,
            audio_input: None,
            panel: panel.clone(),
            panel_mode: None,
            picks: Vec::new(),
            caret: 0,
            tokens: Vec::new(),
            active_recipe,
            attachments: Vec::new(),
            next_file_key: 0,
            notice: None,
            dismissed_at: None,
            turn_in_flight,
        };

        // Subscribe to state changes to update cached values and notify only when relevant
        // fields change. It watches with the window, because rows built here have to be able to
        // ask the window what keys are bound, the same as rows built when the panel opened.
        cx.observe_in(&state, window, |this: &mut Self, state, window, cx| {
            let mut changed = false;
            // A driver's attach: the paths it would have picked in the OS picker.
            let requested = state.update(cx, |state, _| std::mem::take(&mut state.attach_requests));
            if !requested.is_empty() {
                this.add_attachments(requested, cx);
            }
            // A modal opened over the composer: its list goes with it.
            let close = state.update(cx, |state, _| {
                std::mem::take(&mut state.composer_panel_close_requested)
            });
            if close {
                this.close_panel(false, window, cx);
            }
            // A driver's ✕, by the file's place on the draft.
            let detached = state.update(cx, |state, _| std::mem::take(&mut state.detach_requests));
            if !detached.is_empty() {
                let mut detached = detached;
                detached.sort_unstable();
                detached.dedup();
                for index in detached.into_iter().rev() {
                    if index < this.attachments.len() {
                        this.attachments.remove(index);
                        this.notice = None;
                    }
                }
                this.publish_files(cx);
            }
            {
                let state = state.read(cx);
                sync_field_copy!(this, state, is_voice_mode_open, changed);
                sync_field_copy!(this, state, is_app_settings_open, changed);
                sync_field_clone!(this, state, reply_to, changed);
                sync_field_clone!(this, state, active_recipe, changed);
                if this.submit_chord != state.submit_chord {
                    this.submit_chord = state.submit_chord;
                    changed = true;
                }
                let name = composer_bot_name(state);
                if this.coworker_name != name {
                    this.coworker_name = name;
                    changed = true;
                }
                // Not a field, so not one of the macros: whether a turn is in flight is a
                // question about the open thread's live turn, which only the state can answer.
                let running = state.is_turn_in_flight();
                if this.turn_in_flight != running {
                    this.turn_in_flight = running;
                    changed = true;
                }
            }

            // Edit on a queued bubble is settled here, not where it was clicked: what is
            // already typed in this field is the one part of the draft the state cannot see.
            if let Some(id) = state.read(cx).pending_edit().map(str::to_string) {
                let draft = this.input_state.read(cx).value().to_string();
                let taken = state.update(cx, |state, cx| {
                    state.take_queued_send_for_edit(&id, &draft, cx)
                });
                match taken {
                    Ok(refill) => {
                        this.input_state.update(cx, |input, cx| {
                            input.set_value(refill.content.clone(), window, cx);
                        });
                        if let Some(skill) = refill.skill {
                            match held_skill_chip(&refill.content, &skill) {
                                // The words that were the chip become the chip again.
                                Some(chip) => {
                                    this.input_state.update(cx, |input, cx| {
                                        input.chip_over(chip.range, chip.kind, chip.id, cx);
                                    });
                                    this.sync_tokens(cx);
                                }
                                None => {
                                    this.caret = 0;
                                    this.insert_token(
                                        TokenKind::Skill,
                                        skill.id,
                                        skill.name,
                                        window,
                                        cx,
                                    );
                                }
                            }
                        }
                        this.notice = refill.notice;
                        this.focus(window, cx);
                    }
                    Err(notice) => this.notice = Some(notice),
                }
                changed = true;
            }

            // Recipes and skills that were still being fetched when `/` opened the panel land
            // here, each as it arrives: they are two listings from two routes, and the panel
            // fills in twice rather than waiting for the slower of them.
            if this.panel_mode == Some(PanelMode::Slash) {
                let mut rows = {
                    let state = state.read(cx);
                    SlashSource.rows(&state.recipes, &your_skills(state))
                };
                apply_shortcuts(&mut rows, window);
                this.remember_picks(&rows);
                let rows: Vec<ComposerPanelRow> = rows.into_iter().map(|(row, _)| row).collect();
                this.panel.update(cx, |panel, cx| panel.set_rows(rows, cx));
            }

            // Installs and this Bot's tools that land while "@" is open fill it in.
            if this.panel_mode == Some(PanelMode::Tools) {
                let rows = ToolSource::of(state.read(cx)).rows();
                this.remember_picks(&rows);
                let rows: Vec<ComposerPanelRow> = rows.into_iter().map(|(row, _)| row).collect();
                this.panel.update(cx, |panel, cx| panel.set_rows(rows, cx));
            }

            // The open list of parameters shows each value as it is filled in, and shuts if the
            // recipe it is about is dropped out from under it.
            if this.panel_mode == Some(PanelMode::Parameters) {
                match state.read(cx).active_recipe.clone() {
                    Some(recipe) => {
                        let rows = ParameterSource.rows(&recipe);
                        this.remember_picks(&rows);
                        let rows: Vec<ComposerPanelRow> =
                            rows.into_iter().map(|(row, _)| row).collect();
                        this.panel.update(cx, |panel, cx| panel.set_rows(rows, cx));
                    }
                    None => this.close_panel(false, window, cx),
                }
            }

            if changed {
                let send_on_enter = this.submit_chord == SubmitChord::Enter;
                this.input_state.update(cx, |input, cx| {
                    input.set_submit_on_enter(send_on_enter, cx);
                });
                cx.notify();
            }
        })
        .detach();

        cx.subscribe_in(
            &input_state,
            window,
            |this, _state, event, window, cx| match event {
                InputEvent::PressEnter { secondary, shift } => {
                    let send = match this.submit_chord {
                        SubmitChord::Enter => !shift && !secondary,
                        SubmitChord::CommandEnter => *secondary,
                    };
                    if send {
                        this.trigger_submit(false, window, cx);
                    }
                }
                InputEvent::Change => {
                    // Undo and redo can bring back a chip whose recipe or skill has since been
                    // taken off the draft. A chip that runs nothing must not look as if it does,
                    // so it goes back to being its words (review of #133).
                    if this
                        .input_state
                        .update(cx, |input, _| input.take_restored())
                    {
                        this.unchip_the_unattached(cx);
                    }
                    this.sync_tokens(cx);
                    this.drop_recipe_without_its_chip(window, cx);
                    this.drop_skill_without_its_chip(cx);
                    cx.notify();
                }
                _ => {}
            },
        )
        .detach();

        cx.subscribe_in(
            &panel,
            window,
            |this, _panel, event, window, cx| match event {
                ComposerPanelEvent::Selected(id) => this.pick_row(id.clone(), window, cx),
                ComposerPanelEvent::Submitted(typed) => {
                    this.submit_typed_value(typed.to_string(), window, cx)
                }
                ComposerPanelEvent::Dismissed { at } => {
                    this.dismissed_at = *at;
                    // A click outside meant to land somewhere else; only Escape hands the caret back.
                    this.close_panel(at.is_none(), window, cx);
                }
            },
        )
        .detach();

        this
    }

    pub fn on_submit(
        mut self,
        handler: impl Fn(String, bool, Vec<crate::opengrok::Attachment>, &mut Context<Self>) + 'static,
    ) -> Self {
        self.on_submit = Some(Box::new(handler));
        self
    }

    /// Put the caret where typing goes: the message, or the open panel's search while `/` or `@`
    /// has one open. A person's keys go to that search the moment the panel opens; a caret put
    /// back in the message under an open panel sends Enter, the arrows and Escape to a field that
    /// ignores them while the panel waits (#94: a driver's `key composer Enter` did exactly that).
    pub fn focus(&self, window: &mut Window, cx: &mut App) {
        if self.panel.read(cx).is_open() {
            self.panel
                .update(cx, |panel, cx| panel.focus_search(window, cx));
            return;
        }
        self.input_state.update(cx, |state, cx| {
            state.focus_handle(cx).focus(window, cx);
        });
    }

    /// The chips in the draft, for whoever sends it. Nothing reads this yet: the message still
    /// goes to the server as text, and carrying the chips as data is the next step.
    pub fn tokens(&self) -> &[ComposerToken] {
        &self.tokens
    }

    /// The images waiting on the draft. Nothing sends them yet — see `trigger_submit`.
    pub fn attachments(&self) -> &[DraftFile] {
        &self.attachments
    }

    /// The send chord, from wherever the caret is.
    ///
    /// ↵ and ⌘↵ already reach the field as [`InputEvent::PressEnter`], and which of them sends
    /// is the person's own setting. Neither reaches the composer while the panel is open: the
    /// panel holds the focus, and inside it ↵ fills the highlighted parameter in — which is
    /// what it should do, and is why the send needs a chord of its own rather than a share of
    /// that one. A key listener would be too late, because GPUI dispatches a keybinding's
    /// action before any listener sees the key, so [`SendDraft`] is bound to ⌘↵ in `main.rs`
    /// — in the composer's context and in the panel's — and answered here.
    ///
    /// The panel goes first. Sending is a decision about the message, not about the list, and
    /// leaving a picker standing over a composer that has just emptied reads as if nothing
    /// happened.
    fn send_draft(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.close_panel(true, window, cx);
        self.trigger_submit(false, window, cx);
    }

    fn send_draft_steer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.close_panel(true, window, cx);
        self.trigger_submit(true, window, cx);
    }

    fn trigger_submit(&mut self, steer: bool, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.input_state.read(cx).value();
        let trimmed = text.trim();
        // A file still going up, or one the server refused, holds the send: the message would
        // otherwise leave without it and nothing would say so.
        let uploading = self
            .attachments
            .iter()
            .filter(|file| file.state == FileState::Uploading)
            .count();
        if uploading > 0 {
            // Said as what it is: nothing is sent later on its own, the person sends again.
            self.notice = Some(if uploading == 1 {
                format!("{WAITING} a file is still uploading. Send again when it is ready.")
            } else {
                format!(
                    "{WAITING} {uploading} files are still uploading. Send again when they are ready."
                )
            });
            cx.notify();
            return;
        }
        if self
            .attachments
            .iter()
            .any(|file| matches!(file.state, FileState::Failed(_)))
        {
            self.notice = Some("Remove the file that did not upload, then send.".to_string());
            cx.notify();
            return;
        }
        let files: Vec<crate::opengrok::Attachment> = self
            .attachments
            .iter()
            .filter_map(|file| match &file.state {
                FileState::Ready(uploaded) => Some(uploaded.clone()),
                _ => None,
            })
            .collect();
        // Files cannot wait in the queue behind a running turn: the server's queue holds words
        // only, and files kept in this session alone would be lost to a restart. The draft stays
        // as it is (review of #135).
        if !files.is_empty() && self.state.read(cx).would_queue(steer) {
            self.notice = Some(
                "Files cannot wait in the queue. Send them when the bot is done, or now with ⌘⇧↵."
                    .to_string(),
            );
            cx.notify();
            return;
        }
        if !trimmed.is_empty() || !files.is_empty() {
            // A recipe that has not been told what it needs cannot run, and the server would
            // refuse the turn. Say which parameter here, before anything is sent and while the
            // draft is still on screen to fix.
            let missing = self
                .state
                .read(cx)
                .active_recipe
                .as_ref()
                .and_then(missing_note);
            if let Some(note) = missing {
                self.notice = Some(note);
                cx.notify();
                return;
            }
            if let Some(handler) = &self.on_submit {
                (handler)(trimmed.to_string(), steer, files, cx);
            }
            self.input_state.update(cx, |state, cx| {
                state.set_value("".to_string(), window, cx);
            });
            self.tokens.clear();
            // `set_value` above emits no Change, so this is the only thing that puts the
            // difference on record: without it the next keystroke would be read against the
            // message that has just gone.
            self.sync_tokens(cx);
            // The recipe belonged to the message that has just gone, not to the next one.
            self.state
                .update(cx, |state, cx| state.clear_active_recipe(cx));
            // The skill did too. The draft's own door takes it as the turn is built (see
            // `AppState::send_draft`), so this is already done in the ordinary case; it is here
            // for the one where nothing was sent at all — an empty draft, or a handler that is
            // not wired — which would otherwise leave a skill on a draft whose chip has just
            // been cleared away.
            self.state
                .update(cx, |state, cx| state.clear_active_skill(cx));
            // The files went with the message (#90).
            self.attachments.clear();
            self.notice = None;
            self.publish_files(cx);
            cx.notify();
            // Focus is handled by the input state usually, or we might need to re-focus
        }
    }

    fn toggle_voice_mode(&mut self, cx: &mut Context<Self>) {
        if self.voice_mode {
            self.voice_mode = false;
            self.audio_input = None;
            self.voice_wave = None;
        } else {
            let amplitude = self.state.read(cx).amplitude.clone();
            match AudioInput::new(amplitude.clone()) {
                Ok(input) => {
                    self.voice_mode = true;
                    self.audio_input = Some(input);
                    self.voice_wave = Some(VoiceWave::new(amplitude, self.state.clone(), cx));
                }
                Err(e) => {
                    eprintln!("Failed to start audio input: {}", e);
                }
            }
        }
        cx.notify();
    }

    fn confirm_voice_input(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.voice_mode = false;
        self.audio_input = None;
        self.voice_wave = None;
        cx.notify();

        // Mock transcription
        let mock_text = "This is a simulated transcription of your voice.";
        self.input_state.update(cx, |state, cx| {
            state.set_value(mock_text.to_string(), window, cx);
        });
        // What was in the message went with it. `set_value` writes the field behind its own
        // back — no Change event — so nothing else here would have noticed: the chips kept the
        // ranges they had, which are now bytes of the transcription, and the fills painted over
        // somebody's dictated words while the skill behind them still rode out on the turn.
        self.tokens.clear();
        self.sync_tokens(cx);
        self.drop_recipe_without_its_chip(window, cx);
        self.drop_skill_without_its_chip(cx);
    }

    // --- The panel -------------------------------------------------------------------------

    fn field_focused(&self, window: &Window, cx: &App) -> bool {
        self.input_state
            .read(cx)
            .focus_handle(cx)
            .is_focused(window)
    }

    fn remember_picks(&mut self, rows: &[(ComposerPanelRow, ComposerPick)]) {
        self.picks = rows
            .iter()
            .map(|(row, pick)| (row.id.clone(), pick.clone()))
            .collect();
    }

    fn show_panel(
        &mut self,
        mode: PanelMode,
        rows: Vec<(ComposerPanelRow, ComposerPick)>,
        placeholder: &str,
        hint: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // Read the caret before the search field takes the focus, so a chip lands where the
        // person was typing rather than at the start of the message.
        self.caret = self.input_state.read(cx).cursor();
        self.panel_mode = Some(mode);
        // Say on the state which list is open. The panel is drawn from this view and nothing
        // outside it can read the view, so this is the only place an agent driver — which sees
        // the state and nothing else — can learn that a `/` did anything.
        self.state
            .update(cx, |state, cx| state.set_composer_panel(Some(mode), cx));
        self.dismissed_at = None;
        self.remember_picks(&rows);
        let rows: Vec<ComposerPanelRow> = rows.into_iter().map(|(row, _)| row).collect();
        self.panel.update(cx, |panel, cx| {
            panel.open_with(rows, placeholder, hint, window, cx);
        });
        cx.notify();
    }

    fn close_panel(&mut self, refocus: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.panel_mode.is_none() {
            return;
        }
        self.panel_mode = None;
        self.state
            .update(cx, |state, cx| state.set_composer_panel(None, cx));
        self.picks.clear();
        self.panel.update(cx, |panel, cx| panel.close(cx));
        if refocus {
            self.focus(window, cx);
        }
        cx.notify();
    }

    fn toggle_plus_panel(
        &mut self,
        event: &ClickEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let dismissed = self.dismissed_at.take();
        if self.panel_mode == Some(PanelMode::Plus) {
            self.close_panel(true, window, cx);
            return;
        }
        // This click is the one that shut the panel a moment ago, not a new one.
        if mouse_down_at(event).is_some_and(|at| dismissed == Some(at)) {
            return;
        }
        let rows = vec![
            (
                ComposerPanelRow::new(
                    "attach",
                    "icons/clip.svg",
                    "Attach files",
                    "Images from this Mac — PNG, JPEG, WebP or GIF",
                )
                .element_id("composer-attach"),
                ComposerPick::AttachFiles,
            ),
            (
                ComposerPanelRow::new(
                    "teach",
                    "icons/monitor.svg",
                    "Teach a task",
                    // Not "as a recipe" any more: stopping the tape asks which of three things
                    // to make of it, and only one of the three is a recipe.
                    "Show the bot on its screen, and keep what it saw",
                )
                .element_id("composer-teach"),
                ComposerPick::TeachTask,
            ),
        ];
        self.show_panel(
            PanelMode::Plus,
            rows,
            "Search",
            "⌘1–9 picks a row. Type @ for the bot's tools, / for its recipes, workflows and \
             skills.",
            window,
            cx,
        );
    }

    fn open_tools_panel(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // The installs are asked for if this session has not read them, so a later `@` lists them.
        // And this Bot's tools, which "@name:" lists the functions from.
        self.state.update(cx, |state, cx| {
            if state.plugin_market.installations.is_none() {
                state.read_installations(cx);
            }
            let listed_for_this_bot = matches!(
                &state.coworker_tools,
                Some((bot, _)) if Some(bot) == state.active_coworker_id.as_ref()
            );
            if !listed_for_this_bot {
                state.refresh_coworker_tools(cx);
            }
        });
        let rows = ToolSource::of(self.state.read(cx)).rows();
        self.show_panel(
            PanelMode::Tools,
            rows,
            "Search, or name:function",
            "↑↓ to move, ↵ to put it in the message, type : after a name for its functions, esc to close.",
            window,
            cx,
        );
    }

    fn open_slash_panel(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // An empty list may only mean the recipes have never been fetched in this session; ask
        // for them, and the observer above fills the open panel when they land. The skills are
        // a second route and so a second ask, on the same rule.
        if self.state.read(cx).recipes.is_empty() {
            self.state.update(cx, |state, cx| state.refresh_recipes(cx));
        }
        // The skills are asked for every time, not only when the list is empty. One `/` is one
        // small request, a library changes while the app is open — somebody writes one on
        // another machine, or a colleague shares one — and a list that was only ever fetched
        // once is a list that is wrong for the rest of the session. What has already arrived
        // stays on screen while the answer is on its way, so nothing flickers.
        self.state
            .update(cx, |state, cx| state.refresh_your_skills(cx));
        let mut rows = {
            let state = self.state.read(cx);
            SlashSource.rows(&state.recipes, &your_skills(state))
        };
        apply_shortcuts(&mut rows, window);
        self.show_panel(
            PanelMode::Slash,
            rows,
            "Search recipes, workflows, skills and actions",
            "↑↓ to move, ⌘1–9 to take one straight away, ↵ to run it or put it in the message, esc to close.",
            window,
            cx,
        );
    }

    /// What the recipe on the draft still needs told: what `@` offers in place of the tools.
    fn open_parameters_panel(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(recipe) = self.state.read(cx).active_recipe.clone() else {
            return;
        };
        let rows = ParameterSource.rows(&recipe);
        let placeholder = format!("Search what {} needs", recipe.name);
        self.show_panel(
            PanelMode::Parameters,
            rows,
            &placeholder,
            &parameters_hint(&recipe),
            window,
            cx,
        );
    }

    /// One parameter's value: the choices its declaration allows, or the panel's own field for
    /// a parameter the declaration leaves open.
    fn open_value_panel(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(recipe) = self.state.read(cx).active_recipe.clone() else {
            return;
        };
        let Some(parameter) = recipe.parameters.get(index) else {
            return;
        };
        let filled = recipe.value(&parameter.name);
        let rows = ValueSource.rows(parameter, filled);
        let placeholder = match filled {
            Some(value) => format!("{} is {value}", parameter.name),
            None => format!("Value for {}", parameter.name),
        };
        self.show_panel(
            PanelMode::Value { parameter: index },
            rows,
            &placeholder,
            &value_hint(parameter),
            window,
            cx,
        );
    }

    fn pick_row(&mut self, id: SharedString, window: &mut Window, cx: &mut Context<Self>) {
        let Some(pick) = self
            .picks
            .iter()
            .find(|(row, _)| *row == id)
            .map(|(_, pick)| pick.clone())
        else {
            return;
        };
        // Which list this row came out of, before closing the panel forgets it: a value only
        // means anything beside the parameter whose panel was open.
        let mode = self.panel_mode;
        self.close_panel(true, window, cx);
        match pick {
            ComposerPick::AttachFiles => self.attach_files(cx),
            ComposerPick::TeachTask => self.teach_task(cx),
            // Every pick goes in at the caret, as part of the sentence. A tool or a plugin used to
            // be a chip under the field that stayed for every message after and was never sent,
            // so `@cloudflare` meant nothing to the Bot (6 Oct 2026). In the message it is this
            // message's, gone with Backspace, and read off the words when the turn leaves
            // (`AppState::turn_tags`).
            ComposerPick::Token { kind, id, text } => match kind {
                TokenKind::Tool | TokenKind::Plugin => {
                    self.insert_token(kind, id, text, window, cx);
                }
                // A workflow goes the same way a recipe does, and on purpose: both are what the
                // turn runs, both declare their parameters on the same field of the same row,
                // and a second path through here would be the first one copied with one word
                // changed. What the two differ in is what they are called, which is on the chip
                // and on the bar.
                TokenKind::Recipe | TokenKind::Workflow => {
                    // A recipe picked from `/` is not only a word in the sentence: it is what
                    // the turn runs, so it goes on the draft as well as into the message. One
                    // recipe to a message, so picking another takes the first one's chip out
                    // rather than leaving a word standing for a recipe that is not running.
                    let replacing = self
                        .state
                        .read(cx)
                        .active_recipe
                        .as_ref()
                        .is_some_and(|active| active.id != id);
                    if replacing {
                        self.drop_recipe(window, cx);
                    }
                    self.state
                        .update(cx, |state, cx| state.start_recipe(&id, cx));
                    self.insert_token(kind, id, text, window, cx);
                    // A recipe that cannot run until it is told something asks now, rather
                    // than leaving it behind an `@` nobody has been told about: picking it is
                    // the one moment the person is certainly thinking about this recipe, and
                    // a bar reading "needed" beside a name is a puzzle, not an instruction.
                    if self
                        .state
                        .read(cx)
                        .active_recipe
                        .as_ref()
                        .is_some_and(opens_on_pick)
                    {
                        self.open_parameters_panel(window, cx);
                    }
                }
                // A skill is prose the bot reads before it works, so it is not the message's
                // mode: no bar, no parameters, nothing to be told. The chip is the whole of
                // what it looks like, and the id behind the chip is what the turn carries.
                TokenKind::Skill => {
                    // Picking the one that is already there again is nothing happening. It is
                    // already attached and its chip is already in the message, and a second
                    // word standing for the same skill is one the person would have to delete
                    // twice to be rid of it.
                    if skill_chip(&self.tokens, &id).is_some() {
                        return;
                    }
                    let held = self
                        .state
                        .read(cx)
                        .active_skill
                        .as_ref()
                        .map(|skill| skill.id.clone());
                    // The pick is resolved before anything is taken away. `start_skill` refuses
                    // an id the library no longer holds — which the refresh on every `/` makes
                    // reachable, with a listing landing between the rows being built and the
                    // Enter that takes one — and a draft that had already been emptied for it
                    // would leave the person with no skill, no chip, and nothing said about it.
                    if !self
                        .state
                        .update(cx, |state, cx| state.start_skill(&id, cx))
                    {
                        return;
                    }
                    // One skill to a message, because the turn names one id: the one that was
                    // there goes, chip and all, rather than leaving a word in the message
                    // standing for a skill that is not going anywhere.
                    if let Some(held) = held {
                        self.remove_skill_chip(&held, window, cx);
                    }
                    self.insert_token(kind, id, text, window, cx);
                }
            },
            ComposerPick::Command(command) => self.run_command(command, window, cx),
            ComposerPick::Parameter { index } => self.open_value_panel(index, window, cx),
            ComposerPick::Value(value) => {
                let Some(PanelMode::Value { parameter }) = mode else {
                    return;
                };
                self.fill_parameter(parameter, value, window, cx);
            }
            ComposerPick::Nothing => {}
        }
    }

    /// What was typed into the value panel's field, offered as the open parameter's value.
    ///
    /// A value the declaration would not take is refused under the field it was typed into,
    /// with the panel still open and the words still there, so it can be corrected rather than
    /// asked for again. The server checks it too and is the authority; this is only early.
    fn submit_typed_value(&mut self, typed: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(PanelMode::Value { parameter }) = self.panel_mode else {
            return;
        };
        let typed = typed.trim().to_string();
        let refusal = self
            .state
            .read(cx)
            .active_recipe
            .as_ref()
            .and_then(|recipe| recipe.parameters.get(parameter))
            .map(|declared| declared.reject(&typed));
        match refusal {
            Some(Some(refusal)) => {
                self.panel
                    .update(cx, |panel, cx| panel.set_hint(refusal, cx));
            }
            Some(None) => self.fill_parameter(parameter, Some(typed), window, cx),
            None => {}
        }
    }

    /// Give a parameter a value, or take its value away, and go back to the list so the next
    /// one can be filled in without asking for it again.
    fn fill_parameter(
        &mut self,
        index: usize,
        value: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(name) = self
            .state
            .read(cx)
            .active_recipe
            .as_ref()
            .and_then(|recipe| recipe.parameters.get(index))
            .map(|parameter| parameter.name.clone())
        else {
            return;
        };
        self.set_parameter_value(&name, value, cx);
        self.close_panel(false, window, cx);
        self.open_parameters_panel(window, cx);
    }

    fn set_parameter_value(&mut self, name: &str, value: Option<String>, cx: &mut Context<Self>) {
        self.state
            .update(cx, |state, cx| state.set_recipe_value(name, value, cx));
    }

    /// Take the recipe off the draft, and its chip out of the message with it: one pick put
    /// both there, so undoing it undoes both. This is what the `×` on the bar does.
    ///
    /// [`Self::drop_recipe_without_its_chip`] is the same rule read the other way round.
    fn drop_recipe(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(recipe) = self.state.read(cx).active_recipe.clone() else {
            return;
        };
        self.state
            .update(cx, |state, cx| state.clear_active_recipe(cx));
        if let Some(index) = self
            .tokens
            .iter()
            .position(|token| token.kind.is_mode() && token.id == recipe.id)
        {
            self.remove_chip(index, cx);
        }
        let _ = window;
        cx.notify();
    }

    /// Take the recipe off the draft once its chip is no longer in the message, whether it was
    /// backspaced over or typed away a letter at a time.
    ///
    /// This reverses what the recipe mode was first built with. The rule then was that editing
    /// the chip away left the recipe running, on the reasoning that a mode set on purpose
    /// should not fall off because of a keystroke in the text. In use that turned out to be
    /// the worse half of the bargain: deleting the chip left a bar still demanding
    /// `search_term`, with nothing anywhere in the message to say where that demand came from
    /// or how to be rid of it. The rule is symmetric now — one pick puts the recipe and its
    /// chip there, and losing either takes both away — which is the reading a person arrives
    /// at on their own, and the `×` on the bar still goes the other way round.
    ///
    /// Everything the recipe was told goes with it, because the values live inside the recipe
    /// and nothing outside it remembers them; picking the same recipe again starts empty
    /// rather than resuming a run that was abandoned.
    fn drop_recipe_without_its_chip(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self
            .state
            .read(cx)
            .active_recipe
            .as_ref()
            .map(|recipe| recipe.id.clone())
        else {
            return;
        };
        if self
            .tokens
            .iter()
            .any(|token| token.kind.is_mode() && token.id == id)
        {
            return;
        }
        self.state
            .update(cx, |state, cx| state.clear_active_recipe(cx));
        // A list of what to tell a recipe that is no longer on the draft is a list about
        // nothing. The parameter list closes itself when the recipe goes (see the observer in
        // `new`); the value panel under it has to be told.
        if matches!(self.panel_mode, Some(PanelMode::Value { .. })) {
            self.close_panel(false, window, cx);
        }
        cx.notify();
    }

    /// Take one skill's chip out of the message, with the space that went in beside it.
    ///
    /// Only the draft's own state says which skill is attached, and that is not touched here:
    /// the one caller replaces the attachment first and then clears away the word standing for
    /// what it replaced. There is no `×` to press either, because a skill has no bar, having
    /// nothing to be told and nothing to show.
    fn remove_skill_chip(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(index) = skill_chip(&self.tokens, id) else {
            return;
        };
        self.remove_chip(index, cx);
        let _ = window;
        cx.notify();
    }

    /// Take the skill off the draft once its chip is no longer in the message, whether it was
    /// backspaced over or typed away a letter at a time.
    ///
    /// The same rule a recipe follows ([`Self::drop_recipe_without_its_chip`]) and for a
    /// stronger reason: the chip is the only place the app says this message carries a skill. A
    /// draft that kept the skill after the word was deleted would be sending something with the
    /// message that nothing on screen mentions.
    fn drop_skill_without_its_chip(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self
            .state
            .read(cx)
            .active_skill
            .as_ref()
            .map(|skill| skill.id.clone())
        else {
            return;
        };
        if skill_chip(&self.tokens, &id).is_some() {
            return;
        }
        self.state
            .update(cx, |state, cx| state.clear_active_skill(cx));
        cx.notify();
    }

    fn run_command(&mut self, command: AppCommand, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(action) = command_action(command) {
            window.dispatch_action(action, cx);
            return;
        }
        match command {
            AppCommand::SettingsTab(tab) => {
                self.state
                    .update(cx, |state, cx| state.open_app_settings(tab, cx));
            }
            AppCommand::Recipes => self.state.update(cx, |state, cx| state.open_recipes(cx)),
            AppCommand::Settings
            | AppCommand::NewChat
            | AppCommand::ToggleTheme
            | AppCommand::Collections
            | AppCommand::Groups => {}
        }
    }

    fn teach_task(&mut self, cx: &mut Context<Self>) {
        self.state.update(cx, |state, cx| state.teach_task(cx));
    }

    // --- Chips -----------------------------------------------------------------------------

    /// Put a chip at the caret the panel was opened from, and leave the caret after it.
    fn insert_token(
        &mut self,
        kind: TokenKind,
        id: String,
        text: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let caret = self.caret.min(self.input_state.read(cx).value().len());
        // The chip is one object in the field (#40): it goes in whole, with a space after it
        // so typing carries on beside it rather than into it.
        self.input_state.update(cx, |input, cx| {
            input.set_selected_range(caret..caret, cx);
            input.insert_chip(kind, id, text, cx);
        });
        self.sync_tokens(cx);
        self.focus(window, cx);
        cx.notify();
    }

    /// Read the chips back from the field. The field keeps each chip as one object, so where a
    /// chip is, and whether it is still there, is simply what the field says: nothing has to be
    /// worked out from the difference between two texts any more.
    fn sync_tokens(&mut self, cx: &mut Context<Self>) {
        let input = self.input_state.read(cx);
        self.tokens = input
            .plain_chips()
            .into_iter()
            .filter_map(|placed| {
                let chip = input.chips().get(placed.index)?;
                Some(ComposerToken {
                    kind: chip.kind,
                    id: chip.id.clone(),
                    text: chip.label.clone(),
                    range: placed.range,
                })
            })
            .collect();
        let chips = self
            .tokens
            .iter()
            .map(|token| (token.kind, token.text.clone()))
            .collect();
        self.state
            .update(cx, |state, cx| state.set_composer_chips(chips, cx));
    }

    /// Turn every recipe, workflow or skill chip whose thing is not on the draft back into words.
    fn unchip_the_unattached(&mut self, cx: &mut Context<Self>) {
        let (recipe, skill) = {
            let state = self.state.read(cx);
            (
                state.active_recipe.as_ref().map(|recipe| recipe.id.clone()),
                state.active_skill.as_ref().map(|skill| skill.id.clone()),
            )
        };
        let chips = self.input_state.read(cx).chips().to_vec();
        for (index, chip) in chips.iter().enumerate().rev() {
            let attached = match chip.kind {
                kind if kind.is_mode() => recipe.as_deref() == Some(chip.id.as_str()),
                TokenKind::Skill => skill.as_deref() == Some(chip.id.as_str()),
                _ => true,
            };
            if !attached {
                self.input_state
                    .update(cx, |input, cx| input.unchip(index, cx));
            }
        }
    }

    /// Take the chip at `index` out of the field, with the space it came with, and keep the
    /// caret the open panel will put its chip at in its place among the words.
    fn remove_chip(&mut self, index: usize, cx: &mut Context<Self>) {
        let Some(range) = self.tokens.get(index).map(|token| token.range.clone()) else {
            return;
        };
        let text = self.input_state.read(cx).value();
        let end = match text.get(range.end..) {
            Some(rest) if rest.starts_with(' ') => range.end + 1,
            _ => range.end,
        };
        self.input_state
            .update(cx, |input, cx| input.remove_chip(index, cx));
        self.caret = caret_after_cut(self.caret, range.start..end);
        self.sync_tokens(cx);
    }

    /// `@` and `/` open the panel instead of being typed.
    ///
    /// Returns whether the key was taken. A trigger only counts at the start of a token — at the
    /// very start of the message or right after a space — so an email address types its `@`.
    fn trigger_panel(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.voice_mode || self.panel_mode.is_some() || !self.field_focused(window, cx) {
            return false;
        }
        let modifiers = event.keystroke.modifiers;
        if modifiers.control || modifiers.alt || modifiers.platform || modifiers.function {
            return false;
        }
        let mode = match event.keystroke.key_char.as_deref() {
            Some("@") => PanelMode::Tools,
            Some("/") => PanelMode::Slash,
            _ => return false,
        };
        let (text, caret, selection) = {
            let input = self.input_state.read(cx);
            (
                input.value().to_string(),
                input.cursor(),
                input.selected_range(),
            )
        };
        // Typing over a selection replaces it, which is the field's business and not a trigger.
        if selection.start != selection.end || !starts_token(&text, caret) {
            return false;
        }
        match mode {
            // Once a recipe is on the draft, `@` is for what that recipe needs told. The turn
            // is already a recipe run, and a roster of the bot's tools is not what is missing
            // from it — which is exactly what someone who has just picked a recipe finds when
            // the list they are shown is tools.
            PanelMode::Tools if self.state.read(cx).active_recipe.is_some() => {
                self.open_parameters_panel(window, cx)
            }
            PanelMode::Tools => self.open_tools_panel(window, cx),
            PanelMode::Slash => self.open_slash_panel(window, cx),
            PanelMode::Plus | PanelMode::Parameters | PanelMode::Value { .. } => {}
        }
        true
    }

    /// The text field. Its chips are drawn by the field itself, each with its icon (#40).
    fn field(&self, _theme: &gpui_kit::component::Theme, _cx: &App) -> AnyElement {
        div()
            .w_full()
            .child(self.input_state.clone())
            .into_any_element()
    }

    // --- The recipe on the draft -------------------------------------------------------------

    /// The bar that says which recipe the message runs, what it still needs, and how to drop it.
    ///
    /// The chip in the message is not this, and cannot be. A chip is text: it can be typed over
    /// or deleted like any other word, and the message has to stay exactly what the person
    /// wrote, so nothing that must be true about the turn can be read off it. The bar is also
    /// the only place a parameter's value can be shown — a value is not prose, and putting it in
    /// the sentence would change what was said.
    fn recipe_bar(
        &self,
        theme: &gpui_kit::component::Theme,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let recipe = self.active_recipe.clone()?;
        let secondary = theme.secondary;
        let muted_foreground = theme.muted_foreground;
        let secondary_foreground = theme.secondary_foreground;
        let border = theme.border;
        let danger = theme.danger;
        let has_parameters = !recipe.parameters.is_empty();
        let chips: Vec<AnyElement> = recipe
            .parameters
            .iter()
            .enumerate()
            .map(|(index, parameter)| {
                let name = parameter.name.clone();
                let filled = recipe.value(&name).map(str::to_string);
                let needed = parameter.required && filled.is_none();
                let label = match &filled {
                    Some(value) => format!("{name}: {}", chip_value(value)),
                    None if parameter.required => format!("{name} (needed)"),
                    None => name.clone(),
                };
                let tip = SharedString::from(chip_tooltip(parameter));
                let clear_name = name.clone();
                h_flex()
                    .id(SharedString::from(format!("composer-recipe-param-{name}")))
                    .items_center()
                    .gap_1()
                    .px(px(6.))
                    .py(px(1.))
                    .rounded_md()
                    .border_1()
                    .border_color(if needed { danger } else { border })
                    .when(filled.is_some(), |this| this.bg(secondary))
                    .text_size(px(11.))
                    .text_color(if needed { danger } else { secondary_foreground })
                    .cursor_pointer()
                    .hover(move |style| style.bg(secondary))
                    .tooltip(move |window, cx| Tooltip::new(tip.clone()).build(window, cx))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        cx.stop_propagation();
                        this.open_value_panel(index, window, cx);
                    }))
                    .child(div().child(label))
                    .when(filled.is_some(), |this| {
                        this.child(
                            div()
                                .id(SharedString::from(format!(
                                    "composer-recipe-param-clear-{clear_name}"
                                )))
                                .size(px(12.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .cursor_pointer()
                                .child(
                                    Icon::new(NativeIcon::Close)
                                        .size(px(8.))
                                        .text_color(secondary_foreground),
                                )
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    cx.stop_propagation();
                                    this.set_parameter_value(&clear_name, None, cx);
                                })),
                        )
                    })
                    .into_any_element()
            })
            .collect();
        Some(
            h_flex()
                .id("composer-recipe-bar")
                .w_full()
                .items_start()
                .justify_between()
                .gap_2()
                .px_1()
                .pb_1()
                .child(
                    v_flex()
                        .min_w_0()
                        .flex_1()
                        .gap(px(3.))
                        .child(
                            h_flex()
                                .items_center()
                                .gap_1()
                                .child(
                                    Icon::default()
                                        .path(recipe.kind.icon())
                                        .size(px(11.))
                                        .text_color(muted_foreground),
                                )
                                .child(
                                    div()
                                        .text_xs()
                                        .font_weight(gpui_kit::FontWeight::MEDIUM)
                                        .text_color(muted_foreground)
                                        .truncate()
                                        // The noun is the thing's own, never "Recipe" for both:
                                        // the bar is the one place that says what the next
                                        // message runs, and a tree and a tape are not the same
                                        // promise.
                                        .child(format!(
                                            "{} · {}",
                                            recipe.kind.label(),
                                            recipe.name
                                        )),
                                )
                                .child(div().text_xs().text_color(muted_foreground).child(
                                    if has_parameters {
                                        "— @ fills these in"
                                    } else {
                                        "— it needs nothing told"
                                    },
                                )),
                        )
                        .when(has_parameters, |this| {
                            this.child(
                                h_flex()
                                    .id("composer-recipe-parameters")
                                    .w_full()
                                    .flex_wrap()
                                    .gap_1()
                                    .children(chips),
                            )
                        }),
                )
                .child(
                    div()
                        .id("composer-recipe-drop")
                        .size(px(22.))
                        .flex_shrink_0()
                        .rounded_full()
                        .flex()
                        .items_center()
                        .justify_center()
                        .cursor_pointer()
                        .hover(move |style| style.bg(secondary))
                        .tooltip({
                            let drop =
                                SharedString::from(format!("Drop the {}", recipe.kind.word()));
                            move |window, cx| Tooltip::new(drop.clone()).build(window, cx)
                        })
                        .child(
                            Icon::new(IconName::Close)
                                .size(px(12.))
                                .text_color(secondary_foreground),
                        )
                        .on_click(cx.listener(|this, _, window, cx| {
                            cx.stop_propagation();
                            this.drop_recipe(window, cx);
                        })),
                )
                .into_any_element(),
        )
    }

    // --- Attachments -----------------------------------------------------------------------

    fn attach_files(&mut self, cx: &mut Context<Self>) {
        let answer = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: Some("Attach".into()),
        });
        cx.spawn(async move |this, cx| {
            let chosen = answer.await;
            let _ = this.update(cx, |this, cx| {
                match chosen {
                    Ok(Ok(Some(paths))) => this.add_attachments(paths, cx),
                    Ok(Ok(None)) => {}
                    Ok(Err(error)) => {
                        this.notice = Some(format!("The file picker would not open: {error}"));
                    }
                    Err(_) => {}
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// Take the files the server can take, upload each at once, and say so when something else
    /// was picked: the prompt cannot be told which kinds to offer, so this is where the answer is
    /// narrowed.
    fn add_attachments(&mut self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
        let mut refused = 0;
        for path in paths {
            // A file already on the draft is not added twice; one that failed is tried again.
            if let Some(at) = self.attachments.iter().position(|file| file.path == path) {
                if matches!(self.attachments[at].state, FileState::Failed(_)) {
                    self.attachments.remove(at);
                } else {
                    continue;
                }
            }
            let Some(mime) = file_mime(&path) else {
                refused += 1;
                continue;
            };
            let name = path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| "file".to_string());
            // A file whose size cannot be read is not read either: reading it whole is exactly
            // what the size check exists to avoid.
            let size = std::fs::metadata(&path).map(|meta| meta.len());
            self.next_file_key += 1;
            let key = self.next_file_key;
            // Over the server's cap the file is refused here, before it is read into memory: a
            // screen recording can be gigabytes (review of #135).
            let state = match &size {
                Err(error) => FileState::Failed(format!("The file could not be read: {error}")),
                Ok(size) if *size > crate::opengrok::MAX_ATTACHMENT_BYTES as u64 => {
                    FileState::Failed("artifacts must be under 25 MiB".to_string())
                }
                Ok(_) => FileState::Uploading,
            };
            let size = size.unwrap_or(0);
            let upload = state == FileState::Uploading;
            self.attachments.push(DraftFile {
                key,
                path: path.clone(),
                size,
                name,
                mime: mime.to_string(),
                state,
            });
            if upload {
                self.upload(key, path, mime, cx);
            }
        }
        self.notice = (refused > 0).then(|| {
            if refused == 1 {
                "That kind of file cannot be attached: images, videos, PDFs and text files can."
                    .to_string()
            } else {
                format!(
                    "{refused} of those cannot be attached: images, videos, PDFs and text files can."
                )
            }
        });
        self.publish_files(cx);
        cx.notify();
    }

    /// Upload one picked file to the open thread. The answer lands on that file's tile, found
    /// by its path, since other files may have been added or removed meanwhile.
    fn upload(&mut self, key: u64, path: PathBuf, mime: &'static str, cx: &mut Context<Self>) {
        let (client, thread) = {
            let state = self.state.read(cx);
            (state.opengrok.clone(), state.active_conversation_id.clone())
        };
        let (Some(client), Some(thread)) = (client, thread) else {
            self.settle_file(
                key,
                FileState::Failed("Sign in and open a bot first.".into()),
            );
            return;
        };
        let read = {
            let path = path.clone();
            cx.background_executor()
                .spawn(async move { std::fs::read(&path) })
        };
        cx.spawn(async move |this, cx| {
            let outcome = match read.await {
                Err(error) => FileState::Failed(format!("The file could not be read: {error}")),
                Ok(bytes) => {
                    let name = path
                        .file_name()
                        .map(|name| name.to_string_lossy().to_string())
                        .unwrap_or_else(|| "file".to_string());
                    match client.upload_attachment(&thread, &name, mime, &bytes).await {
                        Ok(uploaded) => FileState::Ready(uploaded),
                        Err(error) => FileState::Failed(error.message),
                    }
                }
            };
            let _ = this.update(cx, |this, cx| {
                this.settle_file(key, outcome);
                this.publish_files(cx);
                cx.notify();
            });
        })
        .detach();
    }

    /// Put an upload's answer on the tile it was started for. When the last upload lands, a
    /// "not sent" notice is replaced by what to do next: the send is the person's to press again.
    fn settle_file(&mut self, key: u64, state: FileState) {
        if let Some(file) = self
            .attachments
            .iter_mut()
            .find(|file| file.key == key && file.state == FileState::Uploading)
        {
            file.state = state;
        }
        let uploading = self
            .attachments
            .iter()
            .any(|file| file.state == FileState::Uploading);
        if !uploading
            && self
                .notice
                .as_deref()
                .is_some_and(|notice| notice.starts_with(WAITING))
        {
            self.notice = Some(
                if self
                    .attachments
                    .iter()
                    .any(|file| matches!(file.state, FileState::Failed(_)))
                {
                    "A file did not upload. Remove it, then send."
                } else {
                    "The files are ready. Press Send."
                }
                .to_string(),
            );
        }
    }

    /// Say on the state what the draft is carrying, for a driver: the draft is this view's.
    fn publish_files(&self, cx: &mut Context<Self>) {
        let files = self
            .attachments
            .iter()
            .map(|file| (file.name.clone(), file.state.word()))
            .collect();
        self.state
            .update(cx, |state, cx| state.set_composer_files(files, cx));
    }

    fn thumbnails(&self, theme: &gpui_kit::component::Theme, cx: &mut Context<Self>) -> AnyElement {
        let caveat = file_caveat(&self.attachments);
        v_flex()
            .id("composer-attachments")
            .w_full()
            .gap(px(4.))
            .child(
                h_flex()
                    .w_full()
                    .flex_wrap()
                    .gap(px(8.))
                    .px(px(2.))
                    .pb(px(2.))
                    .children(self.attachments.iter().enumerate().map(|(index, file)| {
                        let group = SharedString::from(format!("composer-attachment-{index}"));
                        let failed = matches!(file.state, FileState::Failed(_));
                        // Drawn as a thumbnail only when the image can be decoded here; HEIC and SVG
                        // are named tiles.
                        let picture = ["image/png", "image/jpeg", "image/gif", "image/webp"]
                            .contains(&file.mime.as_str());
                        div()
                            .id(SharedString::from(format!("composer-attachment-{index}")))
                            .group(group.clone())
                            .relative()
                            .h(px(56.))
                            .when(picture, |this| this.w(px(56.)))
                            .when(!picture, |this| this.max_w(px(180.)).px(px(10.)))
                            .flex_shrink_0()
                            .rounded(px(10.))
                            .overflow_hidden()
                            .border_1()
                            .border_color(if failed { theme.danger } else { theme.border })
                            .bg(theme.secondary)
                            .when_some(
                                match &file.state {
                                    FileState::Failed(why) => Some(why.clone()),
                                    _ => None,
                                },
                                |this, why| {
                                    this.tooltip(move |window, cx| {
                                        gpui_kit::component::tooltip::Tooltip::new(why.clone())
                                            .build(window, cx)
                                    })
                                },
                            )
                            .when(picture, |this| {
                                this.child(
                                    img(file.path.clone())
                                        .size_full()
                                        .object_fit(ObjectFit::Cover)
                                        .rounded(px(10.)),
                                )
                            })
                            .when(!picture, |this| {
                                this.child(
                                    v_flex()
                                        .h_full()
                                        .justify_center()
                                        .child(
                                            div()
                                                .text_xs()
                                                .text_color(theme.secondary_foreground)
                                                .truncate()
                                                .child(file.name.clone()),
                                        )
                                        .child(
                                            div()
                                                .text_xs()
                                                .text_color(theme.muted_foreground)
                                                .child(kind_word(&file.mime)),
                                        ),
                                )
                            })
                            .when(file.state == FileState::Uploading, |this| {
                                this.child(
                                    div()
                                        .absolute()
                                        .inset_0()
                                        .bg(theme.background.opacity(0.55))
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .text_xs()
                                        .text_color(theme.muted_foreground)
                                        .child("Uploading…"),
                                )
                            })
                            .child(
                                div()
                                    .id(SharedString::from(format!(
                                        "composer-attachment-remove-{index}"
                                    )))
                                    .absolute()
                                    .top(px(2.))
                                    .right(px(2.))
                                    .size(px(18.))
                                    .rounded_full()
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .bg(theme.background.opacity(0.85))
                                    .cursor_pointer()
                                    .opacity(if failed { 1. } else { 0. })
                                    .group_hover(group, |style| style.opacity(1.))
                                    .child(
                                        Icon::new(NativeIcon::Close)
                                            .size(px(10.))
                                            .text_color(theme.secondary_foreground),
                                    )
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        cx.stop_propagation();
                                        if index < this.attachments.len() {
                                            this.attachments.remove(index);
                                            this.notice = None;
                                            this.publish_files(cx);
                                            cx.notify();
                                        }
                                    })),
                            )
                    })),
            )
            .when_some(caveat, |this, caveat| {
                this.child(
                    div()
                        .id("composer-attachments-caveat")
                        .px(px(2.))
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(caveat),
                )
            })
            .into_any_element()
    }
}

/// A file's kind in a word, for its tile.
fn kind_word(mime: &str) -> &'static str {
    if mime == "application/pdf" {
        "PDF"
    } else if mime.starts_with("video/") {
        "Video"
    } else if mime.starts_with("image/") {
        "Image"
    } else {
        "Text"
    }
}

/// The action one of the app's own commands dispatches, for the commands that have one. The
/// rest reach the app through [`AppState`] instead, and so have no chord to show or to send.
/// One table serves both, so a row can never advertise a key that runs something else.
fn command_action(command: AppCommand) -> Option<Box<dyn Action>> {
    match command {
        AppCommand::Settings => Some(Box::new(OpenSettings)),
        AppCommand::NewChat => Some(Box::new(NewChat)),
        AppCommand::ToggleTheme => Some(Box::new(ToggleTheme)),
        AppCommand::Collections => Some(Box::new(Library)),
        AppCommand::Groups => Some(Box::new(Projects)),
        AppCommand::SettingsTab(_) | AppCommand::Recipes => None,
    }
}

/// Put the real chord on every row that stands for one of the app's commands, read from the
/// keymap the app registered rather than written out beside the row. A row whose command has no
/// binding — and there are several — keeps its empty chord and shows no keys at all.
fn apply_shortcuts(rows: &mut [(ComposerPanelRow, ComposerPick)], window: &Window) {
    for (row, pick) in rows {
        let ComposerPick::Command(command) = pick else {
            continue;
        };
        let Some(action) = command_action(*command) else {
            continue;
        };
        let Some(binding) = window.highest_precedence_binding_for_action(action.as_ref()) else {
            continue;
        };
        let chord = binding
            .keystrokes()
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(" ");
        if !chord.is_empty() {
            row.shortcut = Some(chord.into());
        }
    }
}

/// Whether picking this recipe should open the list of what it needs there and then, instead of
/// waiting for an `@` nobody has said is coming: it declares something required that nobody has
/// filled in, so it cannot run as it stands. A recipe that declares nothing, and one whose
/// required parameters all arrived with defaults, has nothing to ask about and opens nothing —
/// a panel over a composer that was ready to send is a step backwards.
fn opens_on_pick(recipe: &ActiveRecipe) -> bool {
    !recipe.missing().is_empty()
}

/// What the recipe still needs before the message can be sent, named, or nothing when it can
/// go. Naming them is the point: "fill in the required fields" leaves someone hunting.
fn missing_note(recipe: &ActiveRecipe) -> Option<String> {
    let missing = recipe.missing();
    if missing.is_empty() {
        return None;
    }
    Some(format!(
        "{} needs {} before this can be sent.",
        recipe.name,
        join_names(&missing)
    ))
}

/// The chord that sends the draft, spelled as the keyboard shows it. It is written out here
/// rather than read back from the keymap because it stands in a line of prose beside ↵ and esc,
/// which are written the same way; the binding it names is [`SendDraft`], in `main.rs`.
const SEND_CHORD: &str = "⌘↵";

/// The line under the list of parameters: what is still stopping the message, or — once nothing
/// is — that it can go, and on which keys.
///
/// The send is worth naming here and nowhere else in the panel. Someone who has just filled in
/// the last thing a recipe needed is done, and the panel they are looking at has no row left
/// that says so; being told the keys beats closing the panel to find out whether it worked.
fn parameters_hint(recipe: &ActiveRecipe) -> String {
    match missing_note(recipe) {
        Some(note) => format!("{note} ↵ fills one in, esc closes."),
        None if recipe.unfilled().is_empty() => {
            format!("{SEND_CHORD} sends the message, esc closes.")
        }
        None => format!(
            "The rest is optional — {SEND_CHORD} sends the message. ↵ fills one in, esc closes."
        ),
    }
}

/// The line under one parameter's value: whether it is picked from a list or typed.
fn value_hint(parameter: &RecipeParameter) -> String {
    match (parameter.allowed(), parameter.kind) {
        (Some(allowed), _) => format!("One of: {}. ↵ takes it, esc closes.", allowed.join(", ")),
        (None, RecipeParameterKind::Boolean) => {
            "Pick the yes or the no. ↵ takes it, esc closes.".to_string()
        }
        (None, RecipeParameterKind::Number) => "Type a number and press ↵. esc closes.".to_string(),
        (None, RecipeParameterKind::Text) => "Type it and press ↵. esc closes.".to_string(),
    }
}

/// What a parameter's chip says when the pointer rests on it, which is the room the chip itself
/// does not have: what the parameter is for, and what it takes.
fn chip_tooltip(parameter: &RecipeParameter) -> String {
    let said = parameter.description.trim();
    let takes = match parameter.allowed() {
        Some(allowed) => format!("one of: {}", allowed.join(", ")),
        None => parameter.kind.label().to_string(),
    };
    let standing = if parameter.required {
        "required"
    } else {
        "optional"
    };
    if said.is_empty() {
        format!("{} — {standing} {takes}", parameter.name)
    } else {
        format!("{said} — {standing} {takes}")
    }
}

/// A value that would push the drop button off the end of the bar is cut: the chip is there to
/// say the parameter is filled, and the whole of a long value can be read where it was typed.
fn chip_value(value: &str) -> String {
    const MOST: usize = 18;
    if value.chars().count() <= MOST {
        return value.to_string();
    }
    let kept: String = value.chars().take(MOST - 1).collect();
    format!("{kept}…")
}

/// Several names as a person would say them: "a", "a and b", "a, b and c".
fn join_names(names: &[&str]) -> String {
    match names {
        [] => String::new(),
        [one] => (*one).to_string(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// The library `/` offers, as the state has it: this person's skills, and how that listing is
/// getting on. Never [`AppState::skills`], which is whichever side of the Settings toggle was
/// last looked at.
fn your_skills(state: &AppState) -> SkillLibrary<'_> {
    SkillLibrary {
        skills: &state.your_skills,
        loading: state.your_skills_loading,
        error: state.your_skills_error.as_deref(),
    }
}

/// Where the chip for one skill sits in the message, if it is still there.
///
/// The chip is the whole of what the app says about a skill on the draft, so this is the
/// question behind both halves of the rule: whether a pick has anything left to do, and whether
/// an attachment still has something on screen standing for it.
fn skill_chip(tokens: &[ComposerToken], id: &str) -> Option<usize> {
    tokens
        .iter()
        .position(|token| token.kind == TokenKind::Skill && token.id == id)
}

/// The chip for a skill that was picked into a message before it was held. The pick already
/// put the skill's name in the words, so the chip goes over the name rather than in beside it.
///
/// The first place the name appears is taken, and a message that also says the name in its
/// own prose ahead of the chip gets the chip on that earlier word: the hold keeps the words,
/// not where the chip sat in them.
fn held_skill_chip(text: &str, skill: &ActiveSkill) -> Option<ComposerToken> {
    let start = text.find(&skill.name)?;
    Some(ComposerToken {
        kind: TokenKind::Skill,
        id: skill.id.clone(),
        text: skill.name.clone(),
        range: start..start + skill.name.len(),
    })
}

/// Where the caret sits once the bytes in `cut` have been taken out: back by as much as was
/// removed before it, and at the cut itself when it was inside what went.
fn caret_after_cut(caret: usize, cut: Range<usize>) -> usize {
    if caret <= cut.start {
        return caret;
    }
    if caret >= cut.end {
        return caret - (cut.end - cut.start);
    }
    cut.start
}

/// Whether a trigger character sits at the start of a token: the start of the message, or right
/// after a space. `me@example.com` therefore types its `@` rather than opening the panel.
fn starts_token(text: &str, caret: usize) -> bool {
    let caret = caret.min(text.len());
    text[..caret]
        .chars()
        .next_back()
        .is_none_or(char::is_whitespace)
}

/// Where a click's own mouse down was, for telling one click from another. A click from the
/// keyboard has no such place, and is never the one that shut a panel.
fn mouse_down_at(event: &ClickEvent) -> Option<Point<Pixels>> {
    match event {
        ClickEvent::Mouse(mouse) => Some(mouse.down.position),
        _ => None,
    }
}

impl Render for MessageInput {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let state_model = self.state.clone();
        let placeholder = format!("Message {}", self.coworker_name);
        self.input_state.update(cx, |input, cx| {
            input.set_placeholder(placeholder, window, cx);
        });

        let theme = cx.theme().clone();
        let secondary = theme.secondary;
        let secondary_foreground = theme.secondary_foreground;
        let muted_foreground = theme.muted_foreground;
        let foreground = theme.foreground;
        let background = theme.background;
        let border = theme.border;

        // Check if any modal is open using cached state
        let any_modal_open = self.is_voice_mode_open || self.is_app_settings_open;
        let draft = self.input_state.read(cx).value();
        let compact = !self.voice_mode
            && self.attachments.is_empty()
            && self.notice.is_none()
            && self.active_recipe.is_none()
            && !draft.contains('\n');
        let panel_open = self.panel_mode.is_some();
        let thumbnails = (!self.attachments.is_empty()).then(|| self.thumbnails(&theme, cx));

        // ChatGPT-style: centered container with max-width
        h_flex().w_full().justify_center().child(
            v_flex()
                .relative()
                .max_w(px(crate::chrome::CHAT_CONTENT_MAX))
                .w_full()
                // `@` and `/` never reach the field: the panel opens instead, and nothing is
                // typed. Capture, because the field would otherwise have the character first.
                .capture_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                    if this.trigger_panel(event, window, cx) {
                        cx.stop_propagation();
                    }
                }))
                // ⌘↵ sends, from the field or from the panel. This listener sits outside both
                // on purpose: the panel is a deferred child of this element, so an action
                // dispatched while it holds the focus bubbles out through here.
                .on_action(cx.listener(|this, _: &SendDraft, window, cx| {
                    this.send_draft(window, cx);
                }))
                .on_action(cx.listener(|this, _: &SendDraftSteer, window, cx| {
                    this.send_draft_steer(window, cx);
                }))
                .when(panel_open, |this| {
                    this.child(
                        deferred(
                            // Above the composer and the width of it: `bottom: 100%` puts the
                            // panel's bottom edge on the composer's top edge.
                            div()
                                .absolute()
                                .left_0()
                                .right_0()
                                .bottom(relative(1.))
                                .mb(px(8.))
                                .child(self.panel.clone()),
                        )
                        .with_priority(3),
                    )
                })
                .child(
                    // Input container - rounded pill shape with shadow
                    v_flex()
                        .key_context("MessageInput")
                        // A file dropped on the composer is picked, the way the + picks one.
                        .on_drop(cx.listener(|this, paths: &ExternalPaths, _, cx| {
                            this.add_attachments(paths.paths().to_vec(), cx);
                        }))
                        .w_full()
                        .gap_2()
                        .when(compact, |this| this.px_3().py(px(6.)))
                        .when(!compact, |this| this.px_4().py_3())
                        .bg(background) // Match chat background (white in light mode)
                        .border_1()
                        .border_color(border)
                        .rounded(px(26.0)) // Rounded pill shape
                        .shadow_sm()
                        .when_some(self.reply_to.clone(), |this, reply| {
                            let preview = reply.preview.clone();
                            this.child(
                                h_flex()
                                    .id("reply-bar")
                                    .w_full()
                                    .items_center()
                                    .justify_between()
                                    .gap_2()
                                    .px_1()
                                    .pb_1()
                                    .child(
                                        v_flex()
                                            .min_w_0()
                                            .flex_1()
                                            .child(
                                                div()
                                                    .text_xs()
                                                    .font_weight(gpui_kit::FontWeight::MEDIUM)
                                                    .text_color(muted_foreground)
                                                    .child("Replying"),
                                            )
                                            .child(
                                                div()
                                                    .text_xs()
                                                    .text_color(muted_foreground)
                                                    .truncate()
                                                    .child(preview),
                                            ),
                                    )
                                    .child(
                                        div()
                                            .id("reply-dismiss")
                                            .size(px(22.))
                                            .rounded_full()
                                            .flex()
                                            .items_center()
                                            .justify_center()
                                            .cursor_pointer()
                                            .hover(move |s| s.bg(secondary))
                                            .child(
                                                Icon::new(IconName::Close)
                                                    .size(px(12.))
                                                    .text_color(secondary_foreground),
                                            )
                                            .on_click({
                                                let state_model = state_model.clone();
                                                move |_, _, cx| {
                                                    cx.stop_propagation();
                                                    state_model.update(cx, |state, cx| {
                                                        state.clear_reply_to(cx);
                                                    });
                                                }
                                            }),
                                    ),
                            )
                        })
                        .children(self.recipe_bar(&theme, cx))
                        .when_some(self.notice.clone(), |this, notice| {
                            this.child(
                                h_flex()
                                    .id("composer-notice")
                                    .w_full()
                                    .items_center()
                                    .justify_between()
                                    .gap_2()
                                    .px_1()
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w_0()
                                            .text_xs()
                                            .text_color(muted_foreground)
                                            .child(notice),
                                    )
                                    .child(
                                        div()
                                            .id("composer-notice-dismiss")
                                            .size(px(18.))
                                            .rounded_full()
                                            .flex()
                                            .items_center()
                                            .justify_center()
                                            .cursor_pointer()
                                            .hover(move |s| s.bg(secondary))
                                            .child(
                                                Icon::new(IconName::Close)
                                                    .size(px(10.))
                                                    .text_color(secondary_foreground),
                                            )
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.notice = None;
                                                cx.notify();
                                            })),
                                    ),
                            )
                        })
                        .children(thumbnails)
                        .when(!compact, |this| {
                            this.child(
                                // Top: Input field (grows to fill space)
                                div().flex_grow(1.).child(if self.voice_mode {
                                    if let Some(voice_wave) = &self.voice_wave {
                                        voice_wave.clone().into_any_element()
                                    } else {
                                        div().into_any_element()
                                    }
                                } else {
                                    self.field(&theme, cx)
                                }),
                            )
                        })
                        .child(
                            // Bottom: Toolbar (and the field, when the composer is one line)
                            h_flex()
                                .when(compact, |this| this.items_center().gap_1())
                                .when(!compact, |this| {
                                    this.justify_between().items_start().gap_2()
                                })
                                .child(
                                    // The one wide panel, for everything the composer offers.
                                    Button::new("add-app")
                                        .icon(IconName::Plus)
                                        .with_size(ComponentSize::Large)
                                        .size(px(32.))
                                        .ghost()
                                        .rounded_full()
                                        .when(!any_modal_open, |this| this.cursor_pointer())
                                        .on_click(cx.listener(
                                            |this, event: &ClickEvent, window, cx| {
                                                this.toggle_plus_panel(event, window, cx);
                                            },
                                        )),
                                )
                                .when(!compact, |this| {
                                    this.child(
                                        // Bottom Row
                                        div()
                                            .flex()
                                            .flex_1() // Allow this section to shrink/grow
                                            .min_w_0() // Allow shrinking below content size to force wrapping
                                            .flex_wrap() // Allow wrapping
                                            .items_center()
                                            .gap_2()
                                            .child(div()),
                                    )
                                })
                                .when(compact, |this| {
                                    this.child(
                                        div()
                                            .id("composer-field")
                                            .flex_1()
                                            .min_w_0()
                                            .w_full()
                                            .child(self.field(&theme, cx)),
                                    )
                                })
                                .child(
                                    // Right: Action Icons
                                    h_flex()
                                        .flex_none() // Prevent this section from shrinking
                                        .gap_1()
                                        .items_center()
                                        .when(self.voice_mode, |this| {
                                            // Voice Mode: Cancel (X) and Confirm (Check)
                                            this.child({
                                                let mut cancel_btn = div()
                                                    .id("cancel-voice-btn")
                                                    .on_click(cx.listener(|this, _, _, cx| {
                                                        this.toggle_voice_mode(cx);
                                                    }))
                                                    .w(px(36.0))
                                                    .h(px(36.0))
                                                    .flex()
                                                    .items_center()
                                                    .justify_center()
                                                    .rounded_full()
                                                    .bg(gpui_kit::transparent_black())
                                                    .text_color(secondary_foreground)
                                                    .hover(move |style| style.bg(secondary))
                                                    .tooltip(|w, cx| {
                                                        Tooltip::new("Cancel").build(w, cx)
                                                    })
                                                    .child(
                                                        Icon::new(NativeIcon::Close)
                                                            .text_color(secondary_foreground),
                                                    );

                                                if !any_modal_open {
                                                    cancel_btn = cancel_btn.cursor_pointer();
                                                }

                                                cancel_btn
                                            })
                                            .child({
                                                let mut confirm_btn = div()
                                                    .id("confirm-voice-btn")
                                                    .on_click(cx.listener(|this, _, window, cx| {
                                                        this.confirm_voice_input(window, cx);
                                                    }))
                                                    .w(px(36.0))
                                                    .h(px(36.0))
                                                    .flex()
                                                    .items_center()
                                                    .justify_center()
                                                    .rounded_full()
                                                    .bg(foreground) // Black/White
                                                    .text_color(background) // White/Black
                                                    .hover(move |style| {
                                                        style.bg(foreground.opacity(0.8))
                                                    })
                                                    .tooltip(|w, cx| {
                                                        Tooltip::new("Done").build(w, cx)
                                                    })
                                                    .child(
                                                        Icon::new(IconName::Check)
                                                            .text_color(background),
                                                    );

                                                if !any_modal_open {
                                                    confirm_btn = confirm_btn.cursor_pointer();
                                                }

                                                confirm_btn
                                            })
                                        })
                                        .when(!self.voice_mode, |this| {
                                            // Text Mode: Mic and Send/Headphone
                                            this.child({
                                                let mut mic_btn = div()
                                                    .id("dictate")
                                                    .on_click(cx.listener(|this, _, _, cx| {
                                                        this.toggle_voice_mode(cx);
                                                    }))
                                                    .w(px(36.0))
                                                    .h(px(36.0))
                                                    .flex()
                                                    .items_center()
                                                    .justify_center()
                                                    .rounded_full()
                                                    .bg(gpui_kit::transparent_black()) // Transparent/White by default
                                                    .text_color(secondary_foreground)
                                                    .hover(move |style| style.bg(secondary)) // Gray on hover
                                                    .tooltip(|w, cx| {
                                                        Tooltip::new("Dictate").build(w, cx)
                                                    })
                                                    .child(
                                                        svg()
                                                            .path("icons/mic.svg")
                                                            .size(px(COMPOSER_ICON_PX))
                                                            .text_color(secondary_foreground),
                                                    );

                                                if !any_modal_open {
                                                    mic_btn = mic_btn.cursor_pointer();
                                                }

                                                mic_btn
                                            })
                                            .child(
                                                if self.turn_in_flight {
                                                    // The same round button in the same place, so the
                                                    // composer does not move under the hand that is
                                                    // about to press it. The square is drawn rather than
                                                    // brought in as an icon: it is a square.
                                                    let mut stop_btn = div()
                                                        .id("stop-btn")
                                                        .on_click(cx.listener(|this, _, _, cx| {
                                                            this.state.update(cx, |state, cx| {
                                                                state.stop_turn(cx);
                                                            });
                                                        }))
                                                        .w(px(36.0))
                                                        .h(px(36.0))
                                                        .flex()
                                                        .items_center()
                                                        .justify_center()
                                                        .rounded_full()
                                                        .bg(foreground)
                                                        .text_color(background)
                                                        .hover(move |style| {
                                                            style.bg(foreground.opacity(0.8))
                                                        })
                                                        .tooltip(|w, cx| {
                                                            Tooltip::new("Stop").build(w, cx)
                                                        })
                                                        .child(
                                                            div()
                                                                .w(px(11.0))
                                                                .h(px(11.0))
                                                                .rounded(px(2.0))
                                                                .bg(background),
                                                        );

                                                    if !any_modal_open {
                                                        stop_btn = stop_btn.cursor_pointer();
                                                    }

                                                    stop_btn
                                                } else if self.input_state.read(cx).is_empty() {
                                                    // Empty state: Sparkles icon - opens voice mode modal
                                                    let mut sparkles_btn = div()
                                                        .id("voice-mode")
                                                        .on_click(cx.listener(|this, _, _, cx| {
                                                            this.state.update(cx, |state, cx| {
                                                                state.start_voice_mode(cx);
                                                            });
                                                        }))
                                                        .w(px(36.0))
                                                        .h(px(36.0))
                                                        .flex()
                                                        .items_center()
                                                        .justify_center()
                                                        .rounded_full()
                                                        .bg(gpui_kit::transparent_black())
                                                        .text_color(secondary_foreground)
                                                        .hover(move |style| style.bg(secondary))
                                                        .tooltip(|w, cx| {
                                                            Tooltip::new("Voice Mode").build(w, cx)
                                                        })
                                                        .child(
                                                            svg()
                                                                .path("icons/sparkles.svg")
                                                                .size(px(COMPOSER_ICON_PX))
                                                                .text_color(secondary_foreground),
                                                        );

                                                    if !any_modal_open {
                                                        sparkles_btn =
                                                            sparkles_btn.cursor_pointer();
                                                    }

                                                    sparkles_btn
                                                } else {
                                                    // Typing state: Send button (Black bg, White arrow)
                                                    let mut send_btn = div()
                                                        .id("send-btn")
                                                        .on_click(cx.listener(
                                                            |this, _, window, cx| {
                                                                this.trigger_submit(
                                                                    false, window, cx,
                                                                );
                                                            },
                                                        ))
                                                        .w(px(36.0))
                                                        .h(px(36.0))
                                                        .flex()
                                                        .items_center()
                                                        .justify_center()
                                                        .rounded_full()
                                                        .bg(foreground) // Theme-aware foreground (Black in light, White in dark)
                                                        .text_color(background) // Theme-aware background (White in light, Black in dark)
                                                        .hover(move |style| {
                                                            style.bg(foreground.opacity(0.8))
                                                        })
                                                        .tooltip(|w, cx| {
                                                            Tooltip::new("Send message")
                                                                .build(w, cx)
                                                        })
                                                        .child(
                                                            Icon::new(IconName::ArrowUp)
                                                                .size(px(COMPOSER_ICON_PX))
                                                                .text_color(background),
                                                        );

                                                    if !any_modal_open {
                                                        send_btn = send_btn.cursor_pointer();
                                                    }

                                                    send_btn
                                                },
                                            )
                                        }),
                                ),
                        ),
                ),
        )
    }
}

fn composer_bot_name(state: &AppState) -> String {
    state
        .active_coworker_id
        .as_ref()
        .and_then(|id| state.coworkers.iter().find(|c| &c.id == id))
        .map(|c| c.name.clone())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "bot".into())
}

#[cfg(test)]
mod tests {
    use super::{
        ComposerToken, TokenKind, held_skill_chip, join_names, missing_note, opens_on_pick,
        parameters_hint, skill_chip, starts_token,
    };
    use crate::opengrok::RecipeSummary;
    use crate::state::ActiveRecipe;
    use std::path::PathBuf;

    /// A chip for a skill, where the words sit in the message.
    fn chip(id: &str, text: &str, at: usize) -> ComposerToken {
        ComposerToken {
            kind: TokenKind::Skill,
            id: id.to_string(),
            text: text.to_string(),
            range: at..at + text.len(),
        }
    }

    fn picked(declaration: serde_json::Value) -> ActiveRecipe {
        let recipe: RecipeSummary = serde_json::from_value(declaration).unwrap();
        ActiveRecipe::from_summary(&recipe)
    }

    /// A held message's words already hold the skill's name, so Edit's chip lands over it.
    #[test]
    fn a_held_skill_is_chipped_where_its_name_already_sits() {
        let skill = crate::state::ActiveSkill {
            id: "skl_1".to_string(),
            name: "expense-report".to_string(),
        };
        assert_eq!(
            held_skill_chip("file this expense-report today", &skill),
            Some(chip("skl_1", "expense-report", 10))
        );
        assert_eq!(held_skill_chip("file this today", &skill), None);
    }

    #[test]
    fn a_recipe_that_cannot_run_as_it_stands_opens_its_list_on_the_pick() {
        assert!(
            opens_on_pick(&picked(serde_json::json!({
                "id": "rcp_1", "name": "youtube",
                "parameters": [{ "name": "search_term", "required": true, "kind": "text" }]
            }))),
            "there is a required parameter with nothing in it, so the pick has left the \
             message unsendable and the list is what to do about that"
        );
        assert!(
            !opens_on_pick(&picked(serde_json::json!({
                "id": "rcp_2", "name": "digest",
                "parameters": [
                    { "name": "since", "required": true, "kind": "text", "default": "monday" },
                    { "name": "tone", "required": false, "kind": "text" }
                ]
            }))),
            "every required parameter came with a default standing in its field, so the \
             recipe would run as picked and a panel over it is a step backwards"
        );
        assert!(
            !opens_on_pick(&picked(
                serde_json::json!({ "id": "rcp_3", "name": "Mail" })
            )),
            "a recipe that declares nothing has nothing to ask about"
        );
    }

    #[test]
    fn the_hint_names_the_send_chord_once_nothing_is_stopping_the_message() {
        let mut recipe = picked(serde_json::json!({
            "id": "rcp_1", "name": "youtube",
            "parameters": [
                { "name": "search_term", "required": true, "kind": "text" },
                { "name": "count", "required": false, "kind": "number" }
            ]
        }));
        assert!(
            !parameters_hint(&recipe).contains(super::SEND_CHORD),
            "a chord that will only be refused is not worth offering while something \
             required is still missing"
        );

        recipe.set_value("search_term", Some("mundo".to_string()));
        assert!(
            parameters_hint(&recipe).contains(super::SEND_CHORD),
            "nothing stops the message now, and the optional one left does not"
        );

        recipe.set_value("count", Some("5".to_string()));
        let hint = parameters_hint(&recipe);
        assert!(
            hint.contains(super::SEND_CHORD),
            "the empty state's only row says there is nothing to do, so the line under it \
             has to say what to do instead, and it read {hint:?}"
        );
    }

    #[test]
    fn a_message_is_refused_by_the_name_of_what_is_missing() {
        let recipe: RecipeSummary = serde_json::from_value(serde_json::json!({
            "id": "rcp_1",
            "name": "youtube",
            "parameters": [
                { "name": "search_term", "required": true, "kind": "text" },
                { "name": "channel", "required": true, "kind": "text" },
                { "name": "count", "required": false, "kind": "number" }
            ]
        }))
        .unwrap();
        let mut recipe = ActiveRecipe::from_summary(&recipe);
        assert_eq!(
            missing_note(&recipe).as_deref(),
            Some("youtube needs search_term and channel before this can be sent."),
            "a refusal that does not name the parameter leaves someone hunting for it"
        );
        recipe.set_value("search_term", Some("mundo".to_string()));
        assert_eq!(
            missing_note(&recipe).as_deref(),
            Some("youtube needs channel before this can be sent.")
        );
        recipe.set_value("channel", Some("anything".to_string()));
        assert_eq!(
            missing_note(&recipe),
            None,
            "nothing required is missing, so the message goes; count was never required"
        );
    }

    #[test]
    fn names_are_joined_the_way_they_are_said() {
        assert_eq!(join_names(&["a"]), "a");
        assert_eq!(join_names(&["a", "b"]), "a and b");
        assert_eq!(join_names(&["a", "b", "c"]), "a, b and c");
    }

    #[test]
    fn a_trigger_only_counts_at_the_start_of_a_token() {
        assert!(starts_token("", 0), "the start of an empty message");
        assert!(starts_token("ask ", 4), "right after a space");
        assert!(starts_token("one\n", 4), "right after a newline");
        assert!(
            !starts_token("me", 2),
            "mid-word, which is where an email address would open the panel"
        );
        assert!(!starts_token("path/to", 7), "mid-word for a path too");
    }

    /// The caret the panel puts its chip at moves with the text: picking a second skill takes
    /// the first one's chip out from under it.
    #[test]
    fn the_caret_comes_back_by_what_was_taken_out_in_front_of_it() {
        // "expense-report " out of "expense-report hello", with the caret at the end.
        assert_eq!(super::caret_after_cut(20, 0..15), 5);
        assert_eq!(super::caret_after_cut(0, 5..9), 0, "it sat before the cut");
        assert_eq!(
            super::caret_after_cut(7, 5..9),
            5,
            "it sat inside what went, so it is where that was"
        );
    }

    /// Picking the skill that is already on the draft is nothing happening: the chip is already
    /// in the message, and a second word for the same skill is one to delete twice.
    #[test]
    fn a_skill_already_in_the_message_is_found_before_a_second_chip_goes_in() {
        let tokens = vec![
            ComposerToken {
                kind: TokenKind::Recipe,
                id: "rcp_1".into(),
                text: "Weekly report".into(),
                range: 0..13,
            },
            chip("skl_1", "expense-report", 14),
        ];
        assert_eq!(skill_chip(&tokens, "skl_1"), Some(1));
        assert_eq!(
            skill_chip(&tokens, "rcp_1"),
            None,
            "a recipe's chip is not a skill's, whatever the id says"
        );
        assert_eq!(skill_chip(&tokens, "skl_2"), None);
    }

    /// A picked file goes as the type the server reads, and a kind it does not take is refused
    /// here, before an upload that could only fail.
    #[test]
    fn a_picked_file_goes_as_a_type_the_server_takes() {
        use super::file_mime;
        for (name, mime) in [
            ("shot.PNG", Some("image/png")),
            ("photo.jpeg", Some("image/jpeg")),
            ("q3.pdf", Some("application/pdf")),
            ("notes.md", Some("text/markdown")),
            ("data.json", Some("text/plain")),
            ("clip.mov", Some("video/quicktime")),
            (
                "report.docx",
                Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
            ),
            (
                "book.xlsx",
                Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
            ),
            (
                "deck.pptx",
                Some("application/vnd.openxmlformats-officedocument.presentationml.presentation"),
            ),
            ("archive.zip", None),
            ("noextension", None),
        ] {
            assert_eq!(file_mime(&PathBuf::from(name)), mime, "{name}");
        }
    }

    /// What the server will not show the bot is said on the composer before sending.
    #[test]
    fn what_the_bot_will_not_see_is_said_first() {
        use super::{DraftFile, FileState, file_caveat};
        let file = |name: &str, mime: &str| DraftFile {
            key: 0,
            size: 1,
            path: PathBuf::from(name),
            name: name.into(),
            mime: mime.into(),
            state: FileState::Uploading,
        };
        assert_eq!(file_caveat(&[file("a.png", "image/png")]), None);
        let said = file_caveat(&[file("q3.pdf", "application/pdf")]).unwrap();
        assert!(said.contains("PDF's name"), "{said}");
        let many: Vec<DraftFile> = (0..9)
            .map(|i| file(&format!("{i}.png"), "image/png"))
            .collect();
        assert!(file_caveat(&many).unwrap().contains("8 pictures"));
        // A picture the model is not shown is said to be named (review of #135).
        let heic = file_caveat(&[file("photo.heic", "image/heic")]).unwrap();
        assert!(heic.contains("go by name"), "{heic}");
        let big = DraftFile {
            size: 11 * 1024 * 1024,
            ..file("big.png", "image/png")
        };
        assert!(file_caveat(&[big]).unwrap().contains("up to 10 MB"));
        assert!(
            file_caveat(&[file("n.txt", "text/plain")])
                .unwrap()
                .contains("20,000")
        );
        // Three 8 MB pictures pass the 20 MB a message; the third goes by name (Cursor on #135).
        let eight_mb = |name: &str| DraftFile {
            size: 8 * 1024 * 1024,
            ..file(name, "image/png")
        };
        let two = file_caveat(&[eight_mb("a.png"), eight_mb("b.png")]);
        assert!(
            two.as_deref().is_none_or(|said| !said.contains("20 MB")),
            "{two:?}"
        );
        let three =
            file_caveat(&[eight_mb("a.png"), eight_mb("b.png"), eight_mb("c.png")]).unwrap();
        assert!(three.contains("20 MB of pictures"), "{three}");
    }
}
