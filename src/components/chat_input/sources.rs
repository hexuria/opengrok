//! Where the composer's panels get their rows.
//!
//! Every list sits behind one small type, so the rows can come from the server later without
//! the panel or the composer changing: `ToolSource` answers from a hardcoded roster of the
//! server's built-in tools until the composer can ask for the real one, and `SlashSource`
//! answers from the recipes, workflows and skills the app has already loaded and a fixed roster
//! of the app's own actions.
//!
//! FOUR WORDS, ONE THING EACH. A RECIPE is a taped sequence, replayed exactly by the box alone.
//! A WORKFLOW is a decision tree that drives recipes, walked by the server, which asks Jev at
//! each branch. A SKILL is a lesson — written notes on how a task is done, which the model reads.
//! An ACTION is something the app itself does. The `/` list holds three of the four, and the
//! label on each row is which one it is; they are priced differently enough that a person has to
//! be able to tell them apart at a glance — a recipe is free and instant, a skill costs the model
//! some reading, a workflow costs a model call per decision.
//!
//! `ParameterSource` and `ValueSource` are the two the composer shows once a recipe is on the
//! draft: what that recipe needs told, and what one of those things may be told.

use gpui_kit::SharedString;

use crate::components::composer_panel::ComposerPanelRow;
use crate::opengrok::{
    PluginSkill, RecipeParameter, RecipeParameterKind, RecipeSummary, SkillSummary,
};
use crate::state::{ActiveRecipe, AppSettingsTab};

/// What a picked row stands for. The panel only says which row it was; this says what to do
/// about it, and it is the composer that does it.
#[derive(Clone, Debug, PartialEq)]
pub enum ComposerPick {
    /// The native picker, for images to put above the message.
    AttachFiles,
    /// The bot's screen, with a tape running.
    TeachTask,
    /// A chip, in the message, at the caret.
    Token {
        kind: TokenKind,
        /// What the thing is called where it lives: a tool's name, a recipe's id.
        id: String,
        /// The chip's own words: `Weekly report` for a recipe, which is what goes into the
        /// message, and `@shell` for a tool, which is what the chip beside the "+" is named
        /// after. The `/` a person typed to open the panel is how they asked, not part of what
        /// they are saying, so a recipe's chip does not carry it; the kind rides along in
        /// [`TokenKind`] instead.
        text: String,
    },
    /// One of the app's own commands, run now.
    Command(AppCommand),
    /// One parameter of the active recipe, by its place in the declaration, to be given a value.
    Parameter { index: usize },
    /// What the parameter whose panel is open is worth. `None` takes its value away.
    Value(Option<String>),
    /// A row that only says something.
    Nothing,
}

/// What a chip in the message stands for, kept beside the chip so the next step can send the
/// message as structured data rather than as a string someone has to parse back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenKind {
    Tool,
    /// One of the person's installed plugins, tagged `@name` in the message: the turn carries it
    /// as `mentionedPlugins`, which gives the Bot that plugin for that message (#359).
    Plugin,
    /// A taped sequence the box replays exactly. It was called a skill here until the four
    /// words were settled, which left the one noun standing for two very different prices.
    Recipe,
    /// A decision tree that drives recipes. It is its own kind rather than a recipe with a flag
    /// because the chip in the message is read by a person, and a person who picked a tree must
    /// not be shown the word for a tape.
    Workflow,
    /// Prose the model reads before it works. Not the tape above under an older name: what the
    /// turn carries for one of these is an id the server reads a lesson out of, and the turn
    /// still runs whatever the person wrote.
    Skill,
}

impl TokenKind {
    /// Whether this chip is what the message RUNS, rather than something said about it. Both a
    /// recipe and a workflow become the message's mode — one pick puts the chip in the message
    /// and the thing itself on the draft — so everything that keeps those two in step asks this
    /// rather than naming one kind and quietly forgetting the other.
    ///
    /// A skill goes on the draft too and is still not a mode: it is read before the work rather
    /// than being the work, it has nothing to be told, and the bar over the composer — which is
    /// about what is running and what it is still missing — has nothing to say about one.
    pub fn is_mode(self) -> bool {
        matches!(self, Self::Recipe | Self::Workflow)
    }
}

/// One of the app's own commands. The ones that have an action in [`crate::actions`] are
/// dispatched as that action, so they go the same way as the menu bar and the keyboard; the
/// rest call the state method the rest of the app calls.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppCommand {
    Settings,
    SettingsTab(AppSettingsTab),
    NewChat,
    ToggleTheme,
    Recipes,
    Collections,
    Groups,
}

/// The names a message tags with `@`, of the ones `known` takes, each once and in the order they
/// come. A tag starts the message or follows a space or an opening bracket, and ends where a name
/// can no longer go on: `me@cloudflare.com` tags nothing, `@cloudflare,` tags cloudflare. The
/// composer's chip reads `@name` in the message, so a tag survives a draft, a queued send and a
/// retry as the words do, and one typed by hand counts the same.
pub fn tags_in(text: &str, known: impl Fn(&str) -> bool) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    let mut before: Option<char> = None;
    for (at, c) in text.char_indices() {
        let starts = before.is_none_or(|b| b.is_whitespace() || "([{\"'".contains(b));
        before = Some(c);
        if c != '@' || !starts {
            continue;
        }
        let rest = &text[at + 1..];
        let end = rest
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
            .unwrap_or(rest.len());
        let name = rest[..end].to_ascii_lowercase();
        // A dot with more name after it is an address or a file, not a tag.
        let after = &rest[end..];
        let dotted =
            after.starts_with('.') && after[1..].starts_with(|c: char| c.is_ascii_alphanumeric());
        if !name.is_empty() && !dotted && known(&name) && !tags.contains(&name) {
            tags.push(name);
        }
    }
    tags
}

/// The `@name:function` tags in `text`, each once, in order: `name` lowercased as [`tags_in`]
/// reads it, `function` as typed. A tag with nothing after its colon is a bare tag.
pub fn function_tags_in(text: &str) -> Vec<(String, String)> {
    let mut tags: Vec<(String, String)> = Vec::new();
    let mut before: Option<char> = None;
    for (at, c) in text.char_indices() {
        let starts = before.is_none_or(|b| b.is_whitespace() || "([{\"'".contains(b));
        before = Some(c);
        if c != '@' || !starts {
            continue;
        }
        let rest = &text[at + 1..];
        let word = |s: &str| {
            s.find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
                .unwrap_or(s.len())
        };
        let end = word(rest);
        let Some(after) = rest[end..].strip_prefix(':') else {
            continue;
        };
        let function = &after[..word(after)];
        let tag = (rest[..end].to_ascii_lowercase(), function.to_string());
        if !tag.0.is_empty() && !function.is_empty() && !tags.contains(&tag) {
            tags.push(tag);
        }
    }
    tags
}

/// One function under a tag: what "@name:" lists. `id` is what goes after the colon, `title` what
/// a person reads (the server's title, else the name), `about` the tool's own words.
#[derive(Clone, Debug, PartialEq)]
pub struct TagFunction {
    pub id: String,
    pub title: String,
    pub about: String,
}

/// What `@` offers (#184, #359): each installed plugin once, then the built-in tool groups
/// (Routines, Plugins), then the services signed in to that are no plugin's. Built-in tools that
/// are on anyway (`shell`, `read_file`…) are not offered: tagging one adds nothing, and they are
/// switched in the Tools modal (6 Oct 2026, the owner's call).
///
/// "@name:" lists that tag's functions in place of the list, from the Bot's own tools listing
/// (`GET /coworkers/{id}/tools`): a plugin's tools carry `plugin`, a group's row its `tools`. A
/// plugin this Bot has not reached yet has none listed, and its tag still works bare.
///
/// ONE ROW PER THING. A plugin's own account is the plugin's, not an app beside it: listed again
/// as a "Connected app", Cloudflare showed twice (6 Oct 2026). No row says "off": a tag is how a
/// Bot with the switch off uses it.
/// `(name, what it is, its functions)` for each tool group.
pub(crate) type Groups = Vec<(String, String, Vec<TagFunction>)>;
/// Each plugin's functions, by plugin.
pub(crate) type Functions = std::collections::BTreeMap<String, Vec<TagFunction>>;

pub struct ToolSource {
    /// `(name, what it does, needs an account first)`.
    pub plugins: Vec<(String, String, bool)>,
    pub apps: Vec<(String, String)>,
    /// `(name, what it is, its functions)`: Routines, Plugins.
    pub groups: Groups,
    /// Each plugin's functions, by plugin.
    pub functions: Functions,
}

impl ToolSource {
    /// The plugins, groups and apps of `state`, for its open Bot.
    pub fn of(state: &crate::state::AppState) -> Self {
        let installs = state
            .plugin_market
            .installations
            .as_ref()
            .and_then(crate::state::Loaded::ready);
        let plugins = installs
            .map(|installs| {
                installs
                    .iter()
                    .map(|install| {
                        let about = install
                            .bundle
                            .manifest
                            .description
                            .clone()
                            .unwrap_or_default();
                        // An install whose services have no account yet: its tag asks for one.
                        let accountless =
                            !install.connectors.is_empty() && install.accounts.is_empty();
                        (install.name.clone(), about, accountless)
                    })
                    .collect()
            })
            .unwrap_or_default();
        let mut apps: Vec<(String, String)> = Vec::new();
        for row in state.connections.own_rows() {
            // A plugin's own account (a pasted key or a sign-in at its server) is the plugin's row.
            let plugins_own = matches!(
                row.kind,
                crate::opengrok::ConnectionKind::Token | crate::opengrok::ConnectionKind::Mcp
            );
            if !plugins_own && !apps.iter().any(|(name, _)| *name == row.connector) {
                apps.push((
                    row.connector.clone(),
                    state.connections.connector_label(&row.connector),
                ));
            }
        }
        let listed = match &state.coworker_tools {
            Some((bot, crate::state::ToolList::Listed(tools)))
                if Some(bot) == state.active_coworker_id.as_ref() =>
            {
                tools.as_slice()
            }
            _ => &[],
        };
        let (groups, functions) = Self::functions_of(listed);
        Self {
            plugins,
            apps,
            groups,
            functions,
        }
    }

    /// The groups and each plugin's functions as "@name:" lists them, from the Bot's tool
    /// listing. A tool this Bot has at Never is left out: it can't be preferred for a message, and
    /// its page is where it is switched back on.
    pub(crate) fn functions_of(listed: &[crate::opengrok::CoworkerTool]) -> (Groups, Functions) {
        let offered = |tool: &&crate::opengrok::CoworkerTool| tool.mode.as_deref() != Some("never");
        let function = |tool: &crate::opengrok::CoworkerTool, id: String| TagFunction {
            title: tool.title.clone().unwrap_or_else(|| id.clone()),
            about: tool
                .description
                .lines()
                .next()
                .unwrap_or_default()
                .to_string(),
            id,
        };
        let groups = listed
            .iter()
            .filter(|tool| !tool.tools.is_empty())
            .map(|group| {
                let members = group
                    .tools
                    .iter()
                    .filter(offered)
                    .map(|tool| function(tool, tool.name.clone()))
                    .collect();
                (group.name.clone(), group.description.clone(), members)
            })
            .collect();
        let mut functions: std::collections::BTreeMap<String, Vec<TagFunction>> =
            std::collections::BTreeMap::new();
        for tool in listed.iter().filter(offered) {
            if let (Some(plugin), Some(qualified)) = (&tool.plugin, &tool.qualified) {
                let short = qualified
                    .rsplit('.')
                    .next()
                    .unwrap_or(qualified)
                    .to_string();
                functions
                    .entry(plugin.clone())
                    .or_default()
                    .push(function(tool, short));
            }
        }
        (groups, functions)
    }

    pub fn rows(&self) -> Vec<(ComposerPanelRow, ComposerPick)> {
        let mut rows: Vec<(ComposerPanelRow, ComposerPick)> = Vec::new();
        let functions_of = |name: &str, kind: TokenKind, list: &[TagFunction]| {
            list.iter()
                .map(|function| {
                    (
                        ComposerPanelRow::new(
                            format!("fn:{name}:{}", function.id),
                            "icons/wrench.svg",
                            function.title.clone(),
                            function.about.clone(),
                        )
                        .label(name.to_string())
                        .scope(name.to_string()),
                        ComposerPick::Token {
                            kind,
                            id: format!("{name}:{}", function.id),
                            text: format!("@{name}:{}", function.id),
                        },
                    )
                })
                .collect::<Vec<_>>()
        };
        for (name, about, accountless) in &self.plugins {
            let line = if *accountless {
                "Needs an account — you'll be asked to add one".to_string()
            } else {
                about.clone()
            };
            let count = self.functions.get(name).map_or(0, Vec::len);
            let label = if count == 0 {
                "Plugin".to_string()
            } else {
                format!("Plugin · {count}")
            };
            rows.push((
                ComposerPanelRow::new(
                    format!("plugin:{name}"),
                    "icons/plugins.svg",
                    name.clone(),
                    line,
                )
                .label(label),
                ComposerPick::Token {
                    kind: TokenKind::Plugin,
                    id: name.clone(),
                    text: format!("@{name}"),
                },
            ));
            if let Some(list) = self.functions.get(name) {
                rows.extend(functions_of(name, TokenKind::Plugin, list));
            }
        }
        for (name, about, members) in &self.groups {
            rows.push((
                ComposerPanelRow::new(
                    format!("group:{name}"),
                    "icons/wrench.svg",
                    name.clone(),
                    about.clone(),
                )
                .label(format!("Tools · {}", members.len())),
                ComposerPick::Token {
                    kind: TokenKind::Tool,
                    id: name.clone(),
                    text: format!("@{name}"),
                },
            ));
            rows.extend(functions_of(name, TokenKind::Tool, members));
        }
        for (name, label) in &self.apps {
            rows.push((
                ComposerPanelRow::new(
                    format!("app:{name}"),
                    "icons/plugins.svg",
                    label.clone(),
                    "Connected app",
                )
                .label("Connector"),
                ComposerPick::Token {
                    kind: TokenKind::Tool,
                    id: name.clone(),
                    text: format!("@{name}"),
                },
            ));
        }
        if self.plugins.is_empty() && self.apps.is_empty() && self.groups.is_empty() {
            rows.push((
                ComposerPanelRow::new(
                    "tool:plugins",
                    "icons/plugins.svg",
                    "Plugins and connectors",
                    "None yet — add them from Plugins in the sidebar",
                )
                .note(),
                ComposerPick::Nothing,
            ));
        }
        rows
    }
}

/// The server's built-in tools: what each is called, its icon, and one line on what it does.
pub const BUILTIN_TOOLS: &[(&str, &str, &str)] = &[
    (
        "shell",
        "icons/wrench.svg",
        "Run a command on the bot's computer",
    ),
    (
        "read_file",
        "icons/library.svg",
        "Read a file on the bot's computer",
    ),
    (
        "write_file",
        "icons/pencil.svg",
        "Write a file on the bot's computer",
    ),
    ("open_url", "icons/globe.svg", "Open a page in the browser"),
    (
        "computer",
        "icons/monitor.svg",
        "See and work the bot's screen",
    ),
    (
        "run_recipe",
        "icons/record.svg",
        "Play a task the bot has been taught",
    ),
];

/// What `/` lists: the recipes, workflows and skills the app has, and the app's own commands.
///
/// Named after the key that opens it, the way [`crate::components::chat_input::PanelMode::Plus`]
/// is named after the button, because what it lists is several kinds of thing and no one noun
/// covers them.
///
/// ONE LIST, ONE FETCH. Recipes and workflows arrive on the same listing, told apart by the
/// `kind` on each row, and they are shown in one panel with one search field over them. Two
/// fetches would mean two flights in the air while somebody is reading the list, and a panel
/// that shows recipes now and workflows a moment later reads as a workflow that has gone.
///
/// Skills are the exception, and cannot be otherwise: they are a different route on the server
/// (`/skills`, not `/recipes`) and a different kind of thing, so they arrive on their own. What
/// the rule still buys here is that both listings are asked for as `/` opens and the panel is
/// refilled as each lands, rather than the list being held back until both are in.
pub struct SlashSource;

impl SlashSource {
    /// Recipes first, because they are what `/` is mostly for, then workflows, then the skills,
    /// then the app's own actions.
    ///
    /// Grouped by kind rather than left in the server's order, so a list someone is arrowing
    /// through does not alternate between two things that cost wildly different amounts to run.
    pub fn rows(
        &self,
        recipes: &[RecipeSummary],
        skills: &SkillLibrary<'_>,
    ) -> Vec<(ComposerPanelRow, ComposerPick)> {
        let mut rows: Vec<(ComposerPanelRow, ComposerPick)> = recipes
            .iter()
            .filter(|recipe| !recipe.is_workflow())
            .chain(recipes.iter().filter(|recipe| recipe.is_workflow()))
            .map(|recipe| {
                let name = recipe_name(recipe);
                (
                    ComposerPanelRow::new(
                        format!("recipe:{}", recipe.id),
                        recipe.kind.icon(),
                        name.clone(),
                        described(recipe),
                    )
                    .label(recipe.kind.label()),
                    ComposerPick::Token {
                        kind: if recipe.is_workflow() {
                            TokenKind::Workflow
                        } else {
                            TokenKind::Recipe
                        },
                        id: recipe.id.clone(),
                        text: name,
                    },
                )
            })
            .collect();
        rows.extend(skill_rows(skills));
        rows.extend(
            APP_COMMANDS
                .iter()
                .map(|(key, icon, title, description, command)| {
                    (
                        // The chord is left empty here and filled in from the keymap the app
                        // registered, so a row shows the keys that really work or none at all.
                        ComposerPanelRow::new(format!("action:{key}"), *icon, *title, *description)
                            .label("Action"),
                        ComposerPick::Command(*command),
                    )
                }),
        );
        rows
    }
}

/// What the recipe on the draft needs told. This is what `@` offers in place of the bot's
/// tools while a recipe is active: a turn that is already a recipe run is not looking for a
/// tool, it is looking for the things the recipe cannot run without.
pub struct ParameterSource;

impl ParameterSource {
    pub fn rows(&self, recipe: &ActiveRecipe) -> Vec<(ComposerPanelRow, ComposerPick)> {
        let unfilled = recipe.unfilled();
        if unfilled.is_empty() {
            return vec![nothing_left(recipe)];
        }
        unfilled
            .into_iter()
            .map(|(index, parameter)| {
                (
                    ComposerPanelRow::new(
                        format!("param:{}", parameter.name),
                        parameter_icon(parameter),
                        parameter.name.clone(),
                        parameter_state(parameter),
                    )
                    .element_id(format!("composer-param-{}", parameter.name))
                    .label(parameter_label(parameter)),
                    ComposerPick::Parameter { index },
                )
            })
            .collect()
    }
}

/// The one row a recipe with nothing left to fill in shows. A panel with no rows at all reads
/// as a list that failed to load, so the good news is said outright instead — and the two ways
/// of having nothing to do are told apart, because "there was never anything to tell it" and
/// "you have told it everything" are different things to have just learned.
fn nothing_left(recipe: &ActiveRecipe) -> (ComposerPanelRow, ComposerPick) {
    let (title, standing) = if recipe.parameters.is_empty() {
        (
            format!("{} needs nothing told", recipe.name),
            "Write the message and send it",
        )
    } else {
        (
            format!("{} has everything it needs", recipe.name),
            "Every value is in the bar below, where it can still be changed",
        )
    };
    (
        ComposerPanelRow::new("param:none", "icons/check.svg", title, standing)
            .element_id("composer-param-none")
            .note(),
        ComposerPick::Nothing,
    )
}

/// What one parameter may be told: the values its declaration allows, the yes and the no of a
/// boolean, and a way to leave it unfilled again. A parameter the declaration does not narrow
/// is typed into the panel's own field, and the row there only says so.
pub struct ValueSource;

impl ValueSource {
    pub fn rows(
        &self,
        parameter: &RecipeParameter,
        filled: Option<&str>,
    ) -> Vec<(ComposerPanelRow, ComposerPick)> {
        let mut rows: Vec<(ComposerPanelRow, ComposerPick)> = Vec::new();
        match (parameter.allowed(), parameter.kind) {
            (Some(allowed), _) => rows.extend(allowed.iter().enumerate().map(|(index, value)| {
                (
                    ComposerPanelRow::new(
                        format!("value:{value}"),
                        "icons/check.svg",
                        value.clone(),
                        format!("Use this for {}", parameter.name),
                    )
                    .element_id(format!("composer-value-choice-{index}")),
                    ComposerPick::Value(Some(value.clone())),
                )
            })),
            (None, RecipeParameterKind::Boolean) => {
                rows.extend([("Yes", "true"), ("No", "false")].into_iter().map(
                    |(title, value)| {
                        (
                            ComposerPanelRow::new(
                                format!("value:{value}"),
                                "icons/check.svg",
                                title,
                                format!("Set {} to {value}", parameter.name),
                            )
                            .element_id(format!("composer-value-choice-{value}")),
                            ComposerPick::Value(Some(value.to_string())),
                        )
                    },
                ));
            }
            (None, _) => rows.push((
                ComposerPanelRow::new(
                    "value:typed",
                    "icons/pencil.svg",
                    format!("Type the value for {}, then press ↵", parameter.name),
                    typed_hint(parameter),
                )
                .element_id("composer-value-typed")
                .always()
                .note(),
                ComposerPick::Nothing,
            )),
        }
        if filled.is_some() {
            rows.push((
                ComposerPanelRow::new(
                    "value:clear",
                    "icons/trash.svg",
                    format!("Clear {}", parameter.name),
                    "Leave it unfilled",
                )
                .element_id("composer-value-clear"),
                ComposerPick::Value(None),
            ));
        }
        rows
    }
}

/// Where a parameter stands, said outright rather than left to be worked out from what is
/// missing: a required one nobody has filled in is the thing stopping the message being sent.
/// Every row in this list is unfilled, so there is no third case to say.
fn parameter_state(parameter: &RecipeParameter) -> String {
    let said = parameter.description.trim();
    let standing = if parameter.required {
        "Not filled in yet"
    } else {
        "Optional"
    };
    if said.is_empty() {
        standing.to_string()
    } else {
        format!("{standing} — {said}")
    }
}

fn parameter_label(parameter: &RecipeParameter) -> String {
    if parameter.required {
        format!("Required · {}", parameter.kind.label())
    } else {
        parameter.kind.label().to_string()
    }
}

fn parameter_icon(parameter: &RecipeParameter) -> &'static str {
    if parameter.required {
        "icons/report.svg"
    } else {
        "icons/pencil.svg"
    }
}

/// What the field under a free parameter will and will not take.
fn typed_hint(parameter: &RecipeParameter) -> String {
    match parameter.kind {
        RecipeParameterKind::Number => "Digits only — letters are not a number".to_string(),
        _ => "Anything you like".to_string(),
    }
}

/// The skills a person can invoke, and how that listing is getting on.
///
/// The three are one argument because a list with nothing in it means nothing on its own: empty
/// is "write your first one" while a fetch is in flight and "the server would not say" when one
/// has failed, and a `/` that reads the first of those out over either of the others sends
/// somebody off to write a skill they already have.
pub struct SkillLibrary<'a> {
    pub skills: &'a [SkillSummary],
    pub loading: bool,
    pub error: Option<&'a str>,
    /// The open Bot's plugin skills, listed after the person's own. Only the open Bot's: a
    /// plugin skill's id names its Bot and the server refuses it on any other.
    pub plugin_skills: Vec<&'a PluginSkill>,
}

/// The skills the library holds, as rows of the `/` list.
///
/// A skill that cannot be invoked is here and cannot be taken. The server refuses an id it will
/// not run, so a row that put one in the message would be a chip whose mistake costs a round
/// trip to find out about; it is a notice instead — shown, dimmed, never picked — the same as
/// the plugins line above the tools. There are two ways to be one, and the row says both when
/// both are true, because the ways out are different: a draft has to be written, and a skill
/// switched off has to be switched back on.
///
/// Rows beat news. A library that has arrived is shown while the next fetch runs, rather than
/// replaced by a line about fetching.
fn skill_rows(library: &SkillLibrary<'_>) -> Vec<(ComposerPanelRow, ComposerPick)> {
    let mut rows = own_skill_rows(library);
    rows.extend(plugin_skill_rows(&library.plugin_skills));
    rows
}

/// The person's own skills, or the one notice that stands where they would be. A notice gives
/// way to plugin skills: "No skills yet" over a list with skills in it is wrong, and rows beat
/// news.
fn own_skill_rows(library: &SkillLibrary<'_>) -> Vec<(ComposerPanelRow, ComposerPick)> {
    if library.skills.is_empty() {
        if plugin_skill_rows(&library.plugin_skills).next().is_some() {
            return Vec::new();
        }
        return vec![match (library.loading, library.error) {
            (true, _) => skill_notice("Loading your skills", "One moment"),
            (false, Some(why)) => skill_notice("Your skills could not be loaded", why),
            (false, None) => no_skills_yet(),
        }];
    }
    let mut sorted: Vec<&SkillSummary> = library.skills.iter().collect();
    // By name, not in the order the server listed them. The panel is arrowed through and typed
    // at, and a list whose order is nobody's is a list that has to be read from the top every
    // time; the server's order is its own business and has changed under this before.
    sorted.sort_by_key(|skill| skill_name(skill).to_lowercase());
    sorted
        .into_iter()
        .map(|skill| {
            let name = skill_name(skill);
            let row = ComposerPanelRow::new(
                format!("skill:{}", skill.id),
                "icons/study.svg",
                name.clone(),
                skill_described(skill),
            )
            .label("Skill");
            if why_not(skill).is_some() {
                return (row.note(), ComposerPick::Nothing);
            }
            (
                row,
                ComposerPick::Token {
                    kind: TokenKind::Skill,
                    // The id, not the name. Two skills may be called the same thing, and the
                    // turn names one of them; nothing anywhere resolves a name back to an id.
                    id: skill.id.clone(),
                    text: name,
                },
            )
        })
        .collect()
}

/// The open Bot's plugin skills, as rows after the person's own: named by the skill, saying
/// which plugin it is from. One switched off, or from a server that sends no id to name it by,
/// is not listed — there is nothing it could be picked as.
fn plugin_skill_rows<'a>(
    rows: &'a [&'a PluginSkill],
) -> impl Iterator<Item = (ComposerPanelRow, ComposerPick)> + 'a {
    rows.iter()
        .filter(|row| row.on && !row.id.is_empty())
        .map(|row| {
            let name = plugin_skill_name(row);
            let said = row.description.trim();
            let description = if said.is_empty() {
                format!("From {}", row.plugin)
            } else {
                format!("From {} — {said}", row.plugin)
            };
            (
                ComposerPanelRow::new(
                    format!("skill:{}", row.id),
                    "icons/study.svg",
                    name.clone(),
                    description,
                )
                .label("Skill"),
                ComposerPick::Token {
                    kind: TokenKind::Skill,
                    id: row.id.clone(),
                    text: name,
                },
            )
        })
}

/// A plugin skill's name as `/` shows it and the chip says it.
pub(crate) fn plugin_skill_name(row: &PluginSkill) -> String {
    let name = row.skill.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        "Untitled skill".to_string()
    } else {
        name
    }
}

/// The one row a library with nothing in it shows.
///
/// A `/` list with no skill in it at all reads as a list that failed to load, and the word is
/// worth keeping in front of someone who has never written one: `/` is where a skill is used,
/// and the row says where one is made.
fn no_skills_yet() -> (ComposerPanelRow, ComposerPick) {
    skill_notice(
        "No skills yet",
        "Prose your bot reads before it works — write one in Settings → Skills",
    )
}

/// The one row that stands where the skills would be: nothing yet, nothing so far, or nothing
/// the server would give. One id, because it is one row in one place and a driver asserting on
/// it is asking the same question each time; what it says is the answer.
fn skill_notice(
    title: &'static str,
    standing: impl Into<SharedString>,
) -> (ComposerPanelRow, ComposerPick) {
    (
        ComposerPanelRow::new("skill:none", "icons/study.svg", title, standing)
            .element_id("composer-skills-none")
            .label("Skill")
            .note(),
        ComposerPick::Nothing,
    )
}

/// A skill with no name still has to be readable in a list, and it is called the same thing
/// here as on the Skills page.
///
/// The run of spaces is collapsed for the same reason a recipe's is: the name becomes a chip in
/// the message, and a chip is one token.
pub(crate) fn skill_name(skill: &SkillSummary) -> String {
    let name = skill.name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        "Untitled skill".to_string()
    } else {
        name
    }
}

/// The line under a skill's name: why it cannot be taken, if it cannot, and then what it is
/// for.
///
/// Both halves, not one. What the skill is for is the half the search reads, and it is exactly
/// what somebody hunting for the one they need to go and fix is typing; a row that dropped its
/// description to make room for its excuse could not be found at all. The excuse comes first
/// because it is why the row will not take.
fn skill_described(skill: &SkillSummary) -> String {
    let said = skill.description.trim();
    match (why_not(skill), said.is_empty()) {
        (None, true) => "Prose your bot reads before it works".to_string(),
        (None, false) => said.to_string(),
        (Some(why), true) => why.to_string(),
        (Some(why), false) => format!("{why} — {said}"),
    }
}

/// Why this skill cannot be invoked, when it cannot. Both reasons when both hold: writing the
/// prose into a draft that is also switched off leaves it switched off, and a row that named one
/// reason would send somebody back a second time.
fn why_not(skill: &SkillSummary) -> Option<&'static str> {
    match (skill.draft, skill.enabled) {
        (true, true) => Some("No prose in it yet"),
        (true, false) => Some("No prose in it yet, and switched off"),
        (false, false) => Some("Switched off, so nothing may run it"),
        (false, true) => None,
    }
}

/// A recipe with no name still has to be readable in a list.
fn recipe_name(recipe: &RecipeSummary) -> String {
    let name = recipe.name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        format!("Untitled {}", recipe.kind.word())
    } else {
        name
    }
}

/// The line under a row's name: what its owner wrote, or — for one nobody described — what this
/// kind of thing is, which is the more useful of the two things a stranger to the row needs.
fn described(recipe: &RecipeSummary) -> String {
    let said = recipe.description.trim();
    if !said.is_empty() {
        return said.to_string();
    }
    if recipe.is_workflow() {
        "A decision tree that picks which recipe to play".to_string()
    } else {
        "A task one of your bots was taught".to_string()
    }
}

/// The app's own commands, as the person meets them: what it is called, where it lives, and
/// which command it is.
const APP_COMMANDS: &[(&str, &str, &str, &str, AppCommand)] = &[
    (
        "settings",
        "icons/wrench.svg",
        "Settings",
        "Open the app's settings",
        AppCommand::Settings,
    ),
    (
        "settings-general",
        "icons/wrench.svg",
        "Settings: General",
        "Settings",
        AppCommand::SettingsTab(AppSettingsTab::General),
    ),
    (
        "settings-profile",
        "icons/account_settings.svg",
        "Settings: Profile",
        "Settings",
        AppCommand::SettingsTab(AppSettingsTab::Profile),
    ),
    (
        "settings-appearance",
        "icons/sun.svg",
        "Settings: Appearance",
        "Settings",
        AppCommand::SettingsTab(AppSettingsTab::Appearance),
    ),
    (
        "settings-shortcuts",
        "icons/session.svg",
        "Settings: Keyboard shortcuts",
        "Settings",
        AppCommand::SettingsTab(AppSettingsTab::Shortcuts),
    ),
    (
        "settings-computer",
        "icons/monitor.svg",
        "Settings: Computer",
        "Settings",
        AppCommand::SettingsTab(AppSettingsTab::Computer),
    ),
    (
        "settings-logins",
        "icons/account_settings.svg",
        "Settings: Logins",
        "Saved site logins",
        AppCommand::SettingsTab(AppSettingsTab::Logins),
    ),
    (
        "new-chat",
        "icons/apps.svg",
        "New chat",
        "Start a chat with a bot",
        AppCommand::NewChat,
    ),
    (
        "toggle-theme",
        "icons/moon.svg",
        "Toggle theme",
        "Switch between light and dark",
        AppCommand::ToggleTheme,
    ),
    (
        "recipes",
        "icons/record.svg",
        "Recipes",
        "The tasks your bots have been taught",
        AppCommand::Recipes,
    ),
    (
        "collections",
        "icons/collections.svg",
        "Collections",
        "Your saved things",
        AppCommand::Collections,
    ),
    (
        "groups",
        "icons/groups.svg",
        "Groups",
        "Bots that work together",
        AppCommand::Groups,
    ),
];

#[cfg(test)]
mod tests {
    use super::{
        ComposerPanelRow, ComposerPick, ParameterSource, SkillLibrary, SlashSource, TagFunction,
        TokenKind, ToolSource, ValueSource, function_tags_in, tags_in,
    };
    use crate::opengrok::{RecipeParameter, RecipeSummary, SkillSummary};
    use crate::state::ActiveRecipe;

    /// A library that has arrived, for a panel waiting on nothing.
    fn listed(skills: &[SkillSummary]) -> SkillLibrary<'_> {
        SkillLibrary {
            skills,
            loading: false,
            error: None,
            plugin_skills: Vec::new(),
        }
    }

    /// A library with one of each thing a row can be: two that can be taken, a draft with no
    /// prose in it, and one somebody switched off.
    fn library() -> Vec<SkillSummary> {
        serde_json::from_value(serde_json::json!([
            {
                "id": "skl_1", "name": "expense-report",
                "description": "File a receipt the way the firm wants it"
            },
            {
                "id": "skl_2", "name": "standup-notes",
                "description": "Write up what the team said"
            },
            { "id": "skl_3", "name": "half-written", "description": "", "draft": true },
            { "id": "skl_4", "name": "retired", "description": "Was used", "enabled": false }
        ]))
        .expect("the listing `/skills` sends")
    }

    /// The recipe the owner hit this on: one required text parameter and nothing else.
    fn youtube() -> ActiveRecipe {
        let recipe: RecipeSummary = serde_json::from_value(serde_json::json!({
            "id": "rcp_1",
            "name": "youtube",
            "parameters": [
                { "name": "search_term", "description": "What to search YouTube for",
                  "required": true, "kind": "text", "default": null, "values": null },
                { "name": "count", "description": "How many to bring back",
                  "required": false, "kind": "number", "default": null, "values": null }
            ]
        }))
        .expect("the declaration the server sends");
        ActiveRecipe::from_summary(&recipe)
    }

    /// The two rows `/` now holds, declared the same way on purpose: the server writes a
    /// workflow's parameters on the same field of the same row a recipe's ride on, so a test
    /// that declared them differently would be testing a shape the server does not send.
    fn one_of_each() -> Vec<RecipeSummary> {
        serde_json::from_value(serde_json::json!([
            {
                "id": "rcp_tape", "name": "Weekly report", "kind": "recipe",
                "description": "Open the dashboard and export it",
                "parameters": [{ "name": "since", "required": true, "kind": "text" }]
            },
            {
                "id": "rcp_tree", "name": "Search and retry", "kind": "workflow",
                "description": "Look first, then search once",
                "parameters": [{ "name": "since", "required": true, "kind": "text" }]
            }
        ]))
        .expect("the listing the server sends now carries `kind` on every row")
    }

    /// The whole point of the four words: the one list says which of them each row is.
    #[test]
    fn the_slash_list_calls_a_tape_a_recipe_and_a_tree_a_workflow() {
        let rows = SlashSource.rows(&one_of_each(), &listed(&[]));
        let (tape, tape_pick) = &rows[0];
        let (tree, tree_pick) = &rows[1];
        assert_eq!(tape.title, "Weekly report");
        assert_eq!(tape.label.as_deref(), Some("Recipe"));
        assert_eq!(tree.title, "Search and retry");
        assert_eq!(
            tree.label.as_deref(),
            Some("Workflow"),
            "a decision tree under the word for a tape is the thing this list is for fixing"
        );
        assert_ne!(
            tape.icon, tree.icon,
            "the two cost wildly different amounts to run, so they do not share a glyph either"
        );
        assert_eq!(
            *tape_pick,
            ComposerPick::Token {
                kind: TokenKind::Recipe,
                id: "rcp_tape".into(),
                text: "Weekly report".into(),
            }
        );
        assert_eq!(
            *tree_pick,
            ComposerPick::Token {
                kind: TokenKind::Workflow,
                id: "rcp_tree".into(),
                text: "Search and retry".into(),
            },
            "picking a workflow leaves the same chip a recipe does, under its own kind"
        );
        // Both are what the message RUNS, which is what makes either one the message's mode.
        for pick in [tape_pick, tree_pick] {
            let ComposerPick::Token { kind, .. } = pick else {
                panic!("both rows are chips: {pick:?}");
            };
            assert!(kind.is_mode(), "{kind:?} is what the next message runs");
        }
    }

    /// Grouped rather than interleaved: the server's order mixes the two, and a list someone is
    /// arrowing through should not alternate between free-and-instant and a model call a step.
    #[test]
    fn the_recipes_come_before_the_workflows_whatever_order_they_arrived_in() {
        let mut listing = one_of_each();
        listing.reverse();
        let rows = SlashSource.rows(&listing, &listed(&[]));
        assert_eq!(
            rows.iter()
                .take(2)
                .map(|(row, _)| row.label.as_deref().unwrap_or(""))
                .collect::<Vec<_>>(),
            vec!["Recipe", "Workflow"]
        );
    }

    /// A workflow declares what it needs told exactly as a recipe does, so the `@` panel it
    /// drives is the same panel, row for row. This is the claim that let the parameter flow be
    /// reused rather than copied: if it ever stops holding, the copy is what it will cost.
    #[test]
    fn a_workflows_parameters_drive_the_at_panel_the_way_a_recipes_do() {
        let declaration = serde_json::json!([
            { "name": "term", "description": "What to search for", "required": true,
              "kind": "text" },
            { "name": "tries", "description": "How many times", "required": false,
              "kind": "number" }
        ]);
        let tape: RecipeSummary = serde_json::from_value(serde_json::json!({
            "id": "rcp_1", "name": "search", "kind": "recipe", "parameters": declaration
        }))
        .unwrap();
        let tree: RecipeSummary = serde_json::from_value(serde_json::json!({
            "id": "rcp_2", "name": "search", "kind": "workflow", "parameters": declaration
        }))
        .unwrap();
        assert!(tree.is_workflow() && !tape.is_workflow());

        let from_tape = ParameterSource.rows(&ActiveRecipe::from_summary(&tape));
        let from_tree = ParameterSource.rows(&ActiveRecipe::from_summary(&tree));
        assert_eq!(
            from_tape, from_tree,
            "the same declaration asks for the same things in the same order, whichever kind \
             of row it arrived on"
        );

        // And the value panel under it, for the one that narrows what it takes.
        let mut active = ActiveRecipe::from_summary(&tree);
        active.set_value("term", Some("mundo".to_string()));
        assert_eq!(
            ParameterSource.rows(&active)[0].0.title,
            "tries",
            "a filled-in parameter leaves the list on a tree the way it does on a tape"
        );
    }

    #[test]
    fn with_nothing_to_tag_the_notice_is_all_there_is() {
        let none = ToolSource {
            plugins: Vec::new(),
            apps: Vec::new(),
            groups: Vec::new(),
            functions: Default::default(),
        };
        let rows = none.rows();
        assert_eq!(rows.len(), 1, "built-in tools are not offered on @");
        let notice = rows.last().expect("the plugins notice closes the list");
        assert_eq!(notice.1, ComposerPick::Nothing);
        assert!(!notice.0.selectable);
        // Installed plugins and connected apps are offered (each plugin's row:
        // `each_plugin_is_one_row_and_none_is_off`).
        let rows = ToolSource {
            plugins: vec![("cloudflare".into(), "Build on Cloudflare".into(), false)],
            apps: vec![("gmail".into(), "Gmail".into())],
            groups: Vec::new(),
            functions: Default::default(),
        }
        .rows();
        assert!(rows.iter().any(|(row, _)| row.id == "app:gmail"));
        assert!(
            rows.iter().all(|(row, _)| row.id != "tool:plugins"),
            "no notice once there are some"
        );
    }

    #[test]
    fn a_recipe_becomes_a_chip_named_after_it_without_the_slash() {
        let recipe: RecipeSummary =
            serde_json::from_value(serde_json::json!({ "id": "rec_1", "name": "Weekly  report" }))
                .expect("a recipe needs nothing but an id and a name");
        let rows = SlashSource.rows(&[recipe], &listed(&[]));
        assert_eq!(
            rows[0].1,
            ComposerPick::Token {
                kind: TokenKind::Recipe,
                id: "rec_1".into(),
                // The run of spaces in the name is collapsed: a chip is one token. The `/` that
                // opened the panel is how it was asked for, not part of the name.
                text: "Weekly report".into(),
            }
        );
        assert_eq!(
            rows[0].0.label.as_deref(),
            Some("Recipe"),
            "a taped sequence is a recipe; calling it a skill left one noun standing for two \
             very different things to buy"
        );
    }

    #[test]
    fn the_app_commands_come_after_the_recipes_and_say_so() {
        let rows = SlashSource.rows(&[], &listed(&[]));
        let commands: Vec<_> = rows
            .iter()
            .skip_while(|(row, _)| !row.id.starts_with("action:"))
            .collect();
        assert!(
            commands
                .iter()
                .all(|(row, _)| row.id.starts_with("action:"))
        );
        assert!(
            commands
                .iter()
                .all(|(row, _)| row.label.as_deref() == Some("Action")),
            "a command is an Action, so the list says which rows do something to the app"
        );
        assert!(
            commands.iter().all(|(row, _)| row.shortcut.is_none()),
            "the chord comes from the keymap the app registered, not from this table"
        );
    }

    #[test]
    fn a_parameter_row_says_what_it_is_and_whether_it_is_still_needed() {
        let recipe = youtube();
        let rows = ParameterSource.rows(&recipe);
        let (search, pick) = &rows[0];
        assert_eq!(search.title, "search_term");
        assert!(
            search.description.starts_with("Not filled in yet"),
            "a required parameter nobody has filled in has to read as unfilled at a glance, \
             and this one read {:?}",
            search.description
        );
        assert!(search.description.contains("What to search YouTube for"));
        assert_eq!(search.label.as_deref(), Some("Required · text"));
        assert_eq!(*pick, ComposerPick::Parameter { index: 0 });
        assert_eq!(
            rows[1].0.label.as_deref(),
            Some("number"),
            "one that is not required says what it takes and nothing about being needed"
        );
        assert_eq!(rows[1].0.description, "Optional — How many to bring back");
    }

    /// The list is what is left to do. A value that has been given is shown in the bar over the
    /// composer, and repeating it here only pads the list someone is reading to find their next
    /// move; the pick that is left still points at the parameter's place in the declaration.
    #[test]
    fn a_filled_parameter_leaves_the_list_and_the_rest_keep_their_places() {
        let mut recipe = youtube();
        recipe.set_value("search_term", Some("mundo".to_string()));
        let rows = ParameterSource.rows(&recipe);
        assert_eq!(
            rows.iter()
                .map(|(row, _)| row.title.as_ref())
                .collect::<Vec<_>>(),
            vec!["count"],
            "the one that was told something has nothing left to ask"
        );
        assert_eq!(
            rows[0].1,
            ComposerPick::Parameter { index: 1 },
            "count is still the second parameter declared, wherever it sits in the list"
        );
    }

    #[test]
    fn what_is_required_is_asked_for_before_what_is_optional() {
        let recipe: RecipeSummary = serde_json::from_value(serde_json::json!({
            "id": "rcp_3",
            "name": "report",
            "parameters": [
                { "name": "format", "required": false, "kind": "text" },
                { "name": "since", "required": true, "kind": "text" },
                { "name": "tone", "required": false, "kind": "text" },
                { "name": "until", "required": true, "kind": "text" }
            ]
        }))
        .unwrap();
        let rows = ParameterSource.rows(&ActiveRecipe::from_summary(&recipe));
        assert_eq!(
            rows.iter()
                .map(|(row, _)| row.title.as_ref())
                .collect::<Vec<_>>(),
            vec!["since", "until", "format", "tone"],
            "what stops the message being sent comes first, and the declaration's own order \
             holds within each group so the list does not reshuffle as values come in"
        );
    }

    #[test]
    fn a_recipe_that_needs_nothing_says_so_rather_than_showing_an_empty_list() {
        let recipe: RecipeSummary =
            serde_json::from_value(serde_json::json!({ "id": "rcp_2", "name": "Mail" })).unwrap();
        let rows = ParameterSource.rows(&ActiveRecipe::from_summary(&recipe));
        assert_eq!(rows.len(), 1);
        assert!(!rows[0].0.selectable, "there is nothing there to pick");
        assert!(rows[0].0.title.contains("needs nothing"));
    }

    #[test]
    fn a_recipe_told_everything_says_so_rather_than_showing_an_empty_list() {
        let mut recipe = youtube();
        recipe.set_value("search_term", Some("mundo".to_string()));
        recipe.set_value("count", Some("5".to_string()));
        let rows = ParameterSource.rows(&recipe);
        assert_eq!(rows.len(), 1, "an empty panel reads as a list that broke");
        assert!(!rows[0].0.selectable, "there is nothing there to pick");
        assert!(
            rows[0].0.title.contains("has everything it needs"),
            "being done is different from never having been asked, and this one read {:?}",
            rows[0].0.title
        );
        assert!(
            rows[0].0.description.contains("bar below"),
            "the values did not vanish, and the row says where they went"
        );
    }

    #[test]
    fn a_value_is_picked_from_the_declared_set_and_typed_when_there_is_none() {
        let narrowed: RecipeParameter = serde_json::from_value(serde_json::json!({
            "name": "lang", "kind": "text", "values": ["en", "es"]
        }))
        .unwrap();
        let rows = ValueSource.rows(&narrowed, None);
        assert_eq!(
            rows.iter()
                .map(|(row, _)| row.title.as_ref())
                .collect::<Vec<_>>(),
            vec!["en", "es"],
            "a narrowed parameter is chosen from, so the allowed values are the rows"
        );
        assert_eq!(rows[1].1, ComposerPick::Value(Some("es".to_string())));

        let flag: RecipeParameter =
            serde_json::from_value(serde_json::json!({"name": "shorts", "kind": "boolean"}))
                .unwrap();
        let rows = ValueSource.rows(&flag, Some("true"));
        assert_eq!(
            rows.iter()
                .map(|(row, _)| row.title.as_ref())
                .collect::<Vec<_>>(),
            vec!["Yes", "No", "Clear shorts"],
            "a yes or no is a choice rather than a field to type into"
        );
        assert_eq!(
            rows[2].1,
            ComposerPick::Value(None),
            "a value that has been given can be taken away again"
        );

        let free: RecipeParameter =
            serde_json::from_value(serde_json::json!({"name": "search_term", "kind": "text"}))
                .unwrap();
        let rows = ValueSource.rows(&free, None);
        assert_eq!(rows.len(), 1);
        assert!(
            !rows[0].0.selectable,
            "the row is the instruction, not a value"
        );
        assert!(
            rows[0].0.always,
            "the line telling someone to type a value must not vanish as they type one"
        );
    }

    /// The whole of what this change is for: a skill in the library is a row in `/`, and taking
    /// it leaves a chip whose id is what the turn will name.
    #[test]
    fn a_skill_is_a_row_and_picking_it_yields_a_skill_chip() {
        let rows = SlashSource.rows(&[], &listed(&library()));
        let (row, pick) = rows
            .iter()
            .find(|(row, _)| row.id == "skill:skl_1")
            .expect("the skill the library holds is offered");
        assert_eq!(row.title, "expense-report");
        assert_eq!(row.description, "File a receipt the way the firm wants it");
        assert_eq!(
            row.label.as_deref(),
            Some("Skill"),
            "prose the bot reads is a Skill; the tape it replays is a Recipe, and the list has \
             to say which of the two a row is"
        );
        assert!(row.selectable);
        assert_eq!(
            *pick,
            ComposerPick::Token {
                kind: TokenKind::Skill,
                id: "skl_1".into(),
                // The `/` that opened the panel is how it was asked for, not part of the name.
                text: "expense-report".into(),
            }
        );
        let ComposerPick::Token { kind, .. } = pick else {
            panic!("a skill row is a chip: {pick:?}");
        };
        assert!(
            !kind.is_mode(),
            "a skill is read before the work, not the work: it must not put itself on the bar \
             or open the list of what a recipe needs told"
        );
    }

    /// Two skills of one name are two rows. Nothing resolves a name back to an id — the pick
    /// carries the id — so the one that was taken is the one that goes.
    #[test]
    fn two_skills_of_one_name_are_two_rows_under_two_ids() {
        let twins: Vec<SkillSummary> = serde_json::from_value(serde_json::json!([
            { "id": "skl_1", "name": "expenses", "description": "Ours" },
            { "id": "skl_2", "name": "expenses", "description": "The one Ada shared" }
        ]))
        .unwrap();
        let rows = SlashSource.rows(&[], &listed(&twins));
        let picks: Vec<&ComposerPick> = rows
            .iter()
            .filter(|(row, _)| row.id.starts_with("skill:"))
            .map(|(_, pick)| pick)
            .collect();
        assert_eq!(
            picks,
            vec![
                &ComposerPick::Token {
                    kind: TokenKind::Skill,
                    id: "skl_1".into(),
                    text: "expenses".into(),
                },
                &ComposerPick::Token {
                    kind: TokenKind::Skill,
                    id: "skl_2".into(),
                    text: "expenses".into(),
                },
            ],
            "both are listed and neither is chosen for the person"
        );
    }

    /// The search over `/` reads a row's name and the line under it, and a skill's line is the
    /// description its author wrote — which is the half somebody who remembers "the expenses
    /// one" is remembering.
    #[test]
    fn a_query_finds_a_skill_by_its_name_or_by_what_it_is_for() {
        let rows = SlashSource.rows(&[], &listed(&library()));
        let matching = |needle: &str| -> Vec<&str> {
            rows.iter()
                .filter(|(row, _)| row.id.starts_with("skill:") && row.matches(needle))
                .map(|(row, _)| row.title.as_ref())
                .collect()
        };
        assert_eq!(matching("expense"), vec!["expense-report"]);
        assert_eq!(
            matching("receipt"),
            vec!["expense-report"],
            "what the skill is for is worth searching, not just what it is called"
        );
        assert_eq!(matching("standup"), vec!["standup-notes"]);
        assert!(matching("nothing like it").is_empty());
    }

    /// The server refuses an id it will not run, so a row that cannot be run cannot be taken:
    /// a chip whose mistake only shows up as a refused turn is worse than a row that says now.
    #[test]
    fn a_draft_and_a_switched_off_skill_are_shown_and_cannot_be_taken() {
        let rows = SlashSource.rows(&[], &listed(&library()));
        let refused = |id: &str| -> &(ComposerPanelRow, ComposerPick) {
            rows.iter()
                .find(|(row, _)| row.id == id)
                .expect("every skill in the library is in the list")
        };
        let (draft, draft_pick) = refused("skill:skl_3");
        assert!(!draft.selectable, "there is no prose in it to read");
        assert_eq!(*draft_pick, ComposerPick::Nothing);
        assert!(
            draft.description.contains("No prose in it yet"),
            "the row says which of the two ways it cannot be used it is, because writing it \
             and switching it back on are different things to go and do: {:?}",
            draft.description
        );
        let (off, off_pick) = refused("skill:skl_4");
        assert!(!off.selectable);
        assert_eq!(*off_pick, ComposerPick::Nothing);
        assert!(
            off.description.contains("Switched off"),
            "{:?}",
            off.description
        );
    }

    /// A list with nothing in it means nothing on its own. "No skills yet" over a fetch that is
    /// still running is a lie on the first `/` of every session, and over one that failed it
    /// sends somebody with twenty skills off to write their first.
    #[test]
    fn an_empty_slash_list_says_which_kind_of_empty_it_is() {
        let notice = |library: SkillLibrary<'_>| -> ComposerPanelRow {
            SlashSource
                .rows(&[], &library)
                .into_iter()
                .find(|(row, _)| row.id == "skill:none")
                .expect("the one row that stands where the skills would be")
                .0
        };
        let waiting = notice(SkillLibrary {
            skills: &[],
            loading: true,
            error: None,
            plugin_skills: Vec::new(),
        });
        assert_eq!(waiting.title, "Loading your skills");
        let refused = notice(SkillLibrary {
            skills: &[],
            loading: false,
            error: Some("the server would not say"),
            plugin_skills: Vec::new(),
        });
        assert!(refused.title.contains("could not be loaded"), "{refused:?}");
        assert_eq!(
            refused.description, "the server would not say",
            "the server's own sentence, not a sentence about it"
        );
        assert_eq!(notice(listed(&[])).title, "No skills yet");

        // Rows beat news: a library that has arrived is not replaced by a line about fetching.
        let rows = SlashSource.rows(
            &[],
            &SkillLibrary {
                skills: &library(),
                loading: true,
                error: Some("an older refusal"),
                plugin_skills: Vec::new(),
            },
        );
        assert!(rows.iter().all(|(row, _)| row.id != "skill:none"));
        assert!(rows.iter().any(|(row, _)| row.id == "skill:skl_1"));
    }

    /// The open Bot's plugin skills, as `GET /coworkers/{id}/plugin-skills` lists them: one on
    /// with its id, one switched off, and one from a server too old to send an id.
    fn plugin_rows() -> Vec<crate::opengrok::PluginSkill> {
        serde_json::from_value(serde_json::json!([
            {
                "id": "plugin/cw_1/bir/server/file-tax", "plugin": "bir", "source": "server",
                "skill": "file-tax", "description": "File a BIR return", "on": true
            },
            {
                "id": "plugin/cw_1/bir/server/amend", "plugin": "bir", "source": "server",
                "skill": "amend", "description": "Amend a return", "on": false
            },
            { "plugin": "demo", "skill": "triage", "description": "Triage", "on": true }
        ]))
        .expect("the rows the server sends")
    }

    /// A plugin skill the open Bot has on is a row of `/` after the person's own, named by the
    /// skill and saying which plugin it is from; its pick is the id the turn names. One switched
    /// off, or one with no id to name, is not listed at all.
    #[test]
    fn the_slash_list_offers_the_open_bots_plugin_skills_after_your_own() {
        let yours = library();
        let plugins = plugin_rows();
        let rows = SlashSource.rows(
            &[],
            &SkillLibrary {
                skills: &yours,
                loading: false,
                error: None,
                plugin_skills: plugins.iter().collect(),
            },
        );
        let at = |id: &str| rows.iter().position(|(row, _)| row.id == id);
        let tax = at("skill:plugin/cw_1/bir/server/file-tax").expect("the plugin skill is listed");
        assert!(
            at("skill:skl_1").is_some_and(|own| own < tax),
            "your own come first"
        );
        let (row, pick) = &rows[tax];
        assert_eq!(row.title, "file-tax");
        assert!(row.selectable);
        assert!(
            row.description.contains("From bir") && row.description.contains("File a BIR return"),
            "{:?}",
            row.description
        );
        assert_eq!(
            *pick,
            ComposerPick::Token {
                kind: TokenKind::Skill,
                id: "plugin/cw_1/bir/server/file-tax".to_string(),
                text: "file-tax".to_string(),
            }
        );
        assert!(at("skill:plugin/cw_1/bir/server/amend").is_none(), "off");
        assert!(
            rows.iter()
                .all(|(row, _)| !row.title.as_ref().contains("triage")),
            "a row with no id cannot be picked, so it is not offered"
        );
    }

    /// "No skills yet" only when there is neither: plugin skills alone are a list, not news.
    #[test]
    fn no_skills_yet_only_when_there_are_no_plugin_skills_either() {
        let plugins = plugin_rows();
        let rows = SlashSource.rows(
            &[],
            &SkillLibrary {
                skills: &[],
                loading: false,
                error: None,
                plugin_skills: plugins.iter().collect(),
            },
        );
        assert!(rows.iter().all(|(row, _)| row.id != "skill:none"));
        assert!(
            rows.iter()
                .any(|(row, _)| row.id == "skill:plugin/cw_1/bir/server/file-tax")
        );
        let none = SlashSource.rows(&[], &listed(&[]));
        assert!(
            none.iter()
                .any(|(row, _)| row.id == "skill:none" && row.title == "No skills yet")
        );
        // Only rows that cannot be offered is the same as none.
        let off: Vec<_> = plugins
            .iter()
            .filter(|row| !row.on || row.id.is_empty())
            .collect();
        let rows = SlashSource.rows(
            &[],
            &SkillLibrary {
                skills: &[],
                loading: false,
                error: None,
                plugin_skills: off,
            },
        );
        assert!(
            rows.iter()
                .any(|(row, _)| row.id == "skill:none" && row.title == "No skills yet")
        );
    }

    /// Both reasons when both hold, and the description kept either way: what a skill is for is
    /// the half the search reads, and it is exactly what somebody hunting for the one they have
    /// to go and fix is typing.
    #[test]
    fn a_row_that_will_not_take_says_why_and_still_says_what_it_is_for() {
        let awkward: Vec<SkillSummary> = serde_json::from_value(serde_json::json!([
            {
                "id": "skl_5", "name": "both", "description": "File a receipt",
                "draft": true, "enabled": false
            }
        ]))
        .unwrap();
        let rows = SlashSource.rows(&[], &listed(&awkward));
        let (row, pick) = rows
            .iter()
            .find(|(row, _)| row.id == "skill:skl_5")
            .expect("the row is listed");
        assert!(!row.selectable);
        assert_eq!(*pick, ComposerPick::Nothing);
        assert!(
            row.description.contains("No prose in it yet")
                && row.description.contains("switched off"),
            "writing the prose would leave it switched off, so one reason is half an answer: \
             {:?}",
            row.description
        );
        assert!(
            row.matches("receipt"),
            "and the search still finds it by what it is for: {:?}",
            row.description
        );
    }

    /// By name, not in whatever order the server listed them: the panel is arrowed through, and
    /// an order that is nobody's has to be read from the top every time.
    #[test]
    fn the_skills_are_listed_by_name() {
        let jumbled: Vec<SkillSummary> = serde_json::from_value(serde_json::json!([
            { "id": "skl_1", "name": "zebra" },
            { "id": "skl_2", "name": "Apple" },
            { "id": "skl_3", "name": "mango" }
        ]))
        .unwrap();
        let rows = SlashSource.rows(&[], &listed(&jumbled));
        assert_eq!(
            rows.iter()
                .filter(|(row, _)| row.id.starts_with("skill:"))
                .map(|(row, _)| row.title.as_ref())
                .collect::<Vec<_>>(),
            vec!["Apple", "mango", "zebra"],
            "and the case a name was typed in is not where it belongs in the list"
        );
    }

    /// A library with nothing in it says so rather than leaving the word out of the list
    /// altogether: `/` is where a skill is used, so it is where someone learns there are none.
    #[test]
    fn an_empty_library_is_a_notice_rather_than_no_rows_at_all() {
        let rows = SlashSource.rows(&[], &listed(&[]));
        let (row, pick) = rows
            .iter()
            .find(|(row, _)| row.id == "skill:none")
            .expect("the `/` list says there are none rather than saying nothing");
        assert_eq!(row.label.as_deref(), Some("Skill"));
        assert!(!row.selectable, "there is nothing there to take");
        assert_eq!(*pick, ComposerPick::Nothing);
        assert!(
            row.description.contains("Settings → Skills"),
            "the row has to say where one is written, and it read {:?}",
            row.description
        );
        assert!(
            !SlashSource
                .rows(&[], &listed(&library()))
                .iter()
                .any(|(row, _)| row.id == "skill:none"),
            "a library with something in it has no reason to say it is empty"
        );
    }

    /// Skills sit between the workflows and the app's own actions, so the `/` list runs from
    /// what the bot does to what the app does without doubling back.
    #[test]
    fn the_skills_come_after_the_workflows_and_before_the_actions() {
        let rows = SlashSource.rows(&one_of_each(), &listed(&library()));
        let kinds: Vec<&str> = rows
            .iter()
            .map(|(row, _)| match row.id.split(':').next().unwrap_or("") {
                "recipe" => "recipe",
                "skill" => "skill",
                _ => "action",
            })
            .collect();
        let first_skill = kinds.iter().position(|kind| *kind == "skill").unwrap();
        let first_action = kinds.iter().position(|kind| *kind == "action").unwrap();
        let last_recipe = kinds.iter().rposition(|kind| *kind == "recipe").unwrap();
        assert!(last_recipe < first_skill && first_skill < first_action);
    }

    /// A tag is `@name` where a word starts, ended where a name cannot go on; an address, a file,
    /// a name nobody installed, and a second tag of the same name tag nothing more.
    #[test]
    fn tags_are_names_where_a_word_starts_and_nowhere_else() {
        let known = |name: &str| ["cloudflare", "shell", "my-tool"].contains(&name);
        let said = "@Cloudflare, list zones (@shell) for me@cloudflare.com, see @cloudflare.yaml, \
                    @nope, @my-tool and @cloudflare again";
        assert_eq!(tags_in(said, known), ["cloudflare", "shell", "my-tool"]);
        assert!(tags_in("mail me@cloudflare", known).is_empty());
        assert_eq!(tags_in("@cloudflare.", known), ["cloudflare"]);
    }

    /// One row per installed plugin, picked as a plugin tag; one still without an account says it
    /// will be asked for, and none says it is off (#359).
    #[test]
    fn each_plugin_is_one_row_and_none_is_off() {
        let source = ToolSource {
            plugins: vec![
                ("cloudflare".into(), "Cloudflare's API".into(), false),
                ("linear".into(), "Issues".into(), true),
            ],
            apps: vec![("gmail".into(), "Gmail".into())],
            groups: Vec::new(),
            functions: Default::default(),
        };
        let rows = source.rows();
        let plugin = |name: &str| {
            rows.iter()
                .filter(|(row, _)| row.id.as_ref() == format!("plugin:{name}"))
                .collect::<Vec<_>>()
        };
        let cloudflare = plugin("cloudflare");
        assert_eq!(cloudflare.len(), 1);
        assert_eq!(
            cloudflare[0].1,
            ComposerPick::Token {
                kind: TokenKind::Plugin,
                id: "cloudflare".into(),
                text: "@cloudflare".into()
            }
        );
        assert!(
            plugin("linear")[0]
                .0
                .description
                .contains("Needs an account")
        );
        assert!(
            rows.iter()
                .all(|(row, _)| !row.description.contains("Off for"))
        );
    }

    /// "@" offers plugins and tool groups, never the built-in tools that are on anyway; a group is
    /// labelled Tools with its count, and its functions are rows scoped to it, each picked as
    /// "@routines:create_routine".
    #[test]
    fn built_in_tools_leave_the_list_and_groups_bring_their_functions() {
        let make = |id: &str| TagFunction {
            id: id.into(),
            title: id.into(),
            about: String::new(),
        };
        let source = ToolSource {
            plugins: vec![("cloudflare".into(), "Cloudflare's API".into(), false)],
            apps: Vec::new(),
            groups: vec![(
                "routines".into(),
                "Routines".into(),
                vec![make("create_routine"), make("run_routine")],
            )],
            functions: [("cloudflare".to_string(), vec![make("execute")])].into(),
        };
        let rows = source.rows();
        assert!(
            rows.iter().all(|(row, _)| !row.id.starts_with("tool:")),
            "no built-in tool rows"
        );
        let row = |id: &str| rows.iter().find(|(row, _)| row.id.as_ref() == id).unwrap();
        assert_eq!(row("group:routines").0.label.as_deref(), Some("Tools · 2"));
        assert_eq!(
            row("plugin:cloudflare").0.label.as_deref(),
            Some("Plugin · 1")
        );
        let create = row("fn:routines:create_routine");
        assert_eq!(create.0.scope.as_deref(), Some("routines"));
        assert_eq!(
            create.1,
            ComposerPick::Token {
                kind: TokenKind::Tool,
                id: "routines:create_routine".into(),
                text: "@routines:create_routine".into()
            }
        );
        assert_eq!(
            row("fn:cloudflare:execute").1,
            ComposerPick::Token {
                kind: TokenKind::Plugin,
                id: "cloudflare:execute".into(),
                text: "@cloudflare:execute".into()
            }
        );
    }

    /// A tool at Never stays on its page but leaves "@name:": the group and the plugin list only
    /// what the Bot can be asked to use.
    #[test]
    fn a_tool_at_never_is_not_offered_after_the_colon() {
        use crate::opengrok::CoworkerTool;
        let tool = |name: &str, mode: &str| CoworkerTool {
            name: name.into(),
            mode: Some(mode.into()),
            ..Default::default()
        };
        let listed = vec![
            CoworkerTool {
                name: "routines".into(),
                tools: vec![tool("create_routine", "ask"), tool("run_routine", "never")],
                ..Default::default()
            },
            CoworkerTool {
                plugin: Some("cloudflare".into()),
                qualified: Some("cloudflare.cloudflare.search".into()),
                ..tool("cloudflare_cloudflare_search", "always")
            },
            CoworkerTool {
                plugin: Some("cloudflare".into()),
                qualified: Some("cloudflare.cloudflare.execute".into()),
                ..tool("cloudflare_cloudflare_execute", "never")
            },
        ];
        let (groups, functions) = ToolSource::functions_of(&listed);
        let ids = |list: &[TagFunction]| list.iter().map(|f| f.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids(&groups[0].2), ["create_routine"]);
        assert_eq!(ids(&functions["cloudflare"]), ["search"]);
    }

    #[test]
    fn a_function_tag_is_its_name_and_function() {
        let said = "@cloudflare:execute then @routines:create_routine, mail me@x.com, @routines";
        assert_eq!(
            function_tags_in(said),
            [
                ("cloudflare".to_string(), "execute".to_string()),
                ("routines".to_string(), "create_routine".to_string())
            ]
        );
    }
}
