//! The plugin marketplace (hexuria/nativechat#184), in the Grok Bot layout: search, the
//! marketplace's own categories in two columns, Add and Added, an installed count that opens what
//! is installed, and a detail with the plugin's accounts, skills, tools, apps and facts.
//!
//! Every row and every fact is the server's: the catalog opengrok-server reads from
//! xai-org/plugin-marketplace, the person's installs, the services this server signs in to, and the
//! sign-ins still waiting. Nothing here is ranked, invented or counted where the server says
//! nothing; an absent fact is not shown. The window and the gpui-agent driver read the same rows.

use crate::components::connections;
use crate::components::monitor_modal::{MarketPage, MonitorModal, PluginSelection};
use crate::opengrok::{ConnectionKind, PluginDetail};
use crate::state::{AppState, ConnectorList, Loaded, ToolCeiling, ToolList};

/// How many rows a category shows on the browse page before View all, as two lines of two.
pub(crate) const PER_SECTION: usize = 4;

pub(crate) const SEARCH: &str = "market-search";
pub(crate) const INSTALLED: &str = "market-installed";
pub(crate) const STATUS: &str = "market-status";
pub(crate) const EMPTY: &str = "market-empty";
pub(crate) const DETAIL: &str = "market-detail";
pub(crate) const DETAIL_ACTION: &str = "market-detail-action";
pub(crate) const DETAIL_REFUSAL: &str = "market-detail-refusal";
pub(crate) const UNINSTALL_YES: &str = "market-uninstall-confirm";
pub(crate) const UNINSTALL_NO: &str = "market-uninstall-cancel";
/// What a plugin the server loaded from its own folder says in place of Uninstall.
pub(crate) const SERVER_INSTALLED: &str = "Installed on this server";
pub(crate) const SOURCE: &str = "market-source";
pub(crate) const TOOLS: &str = "market-tools";
pub(crate) const TOKEN_FIELD: &str = "market-token-field";
pub(crate) const TOKEN_SAVE: &str = "market-token-save";
pub(crate) const TOKEN_CANCEL: &str = "market-token-cancel";
pub(crate) const TOKEN_REFUSAL: &str = "market-token-refusal";
pub(crate) const REMOVE_YES: &str = "market-account-remove-confirm";
pub(crate) const REMOVE_NO: &str = "market-account-remove-cancel";

/// A row's Add, by what it opens.
pub(crate) fn add_id(selection: &PluginSelection) -> String {
    format!("{}-add", selection.detail_id())
}

/// A category's View all.
pub(crate) fn view_all_id(category: &str) -> String {
    format!("market-view-all-{category}")
}

/// Add Another Account, under a service's accounts.
pub(crate) fn add_account_id(connector: &str) -> String {
    format!("market-add-account-{connector}")
}

/// A waiting sign-in's Reopen, and its Remove.
pub(crate) fn reopen_id(attempt: &str) -> String {
    format!("market-reopen-{attempt}")
}
pub(crate) fn dismiss_id(attempt: &str) -> String {
    format!("market-dismiss-{attempt}")
}

/// An account's Remove, and a pasted account's new token.
pub(crate) fn remove_account_id(id: &str) -> String {
    format!("market-account-remove-{id}")
}
pub(crate) fn replace_token_id(id: &str) -> String {
    format!("market-replace-token-{id}")
}

/// An account's Bots button, the list's filter, and one Bot's row in it.
pub(crate) fn bots_id(id: &str) -> String {
    format!("market-account-bots-{id}")
}
pub(crate) const BOTS_SEARCH: &str = "market-bots-search";
pub(crate) fn bot_row_id(bot: &str) -> String {
    format!("market-bot-{bot}")
}

/// One Bot in an account's Bots list: whether it may use the account, and whether that can change.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BotRow {
    /// This Bot uses the account without asking: its default for the service.
    pub default: bool,
    pub id: String,
    pub name: String,
    pub on: bool,
    pub live: bool,
    pub note: Option<String>,
}

/// The person's Bots for an account's Bots list, filtered by what is typed, by name.
pub(crate) fn bot_rows(state: &AppState, connection_id: &str, query: &str) -> Vec<BotRow> {
    let connections = &state.connections;
    let own = connections.own_rows();
    let Some(row) = own.iter().find(|r| r.id == connection_id) else {
        return Vec::new();
    };
    let changing = connections.is_changing(&row.id);
    let query = query.trim().to_lowercase();
    // A plugin's own account is picked per Bot, never lent: its switch is "this Bot uses it".
    let picked = matches!(row.kind, ConnectionKind::Token | ConnectionKind::Mcp);
    state
        .coworkers
        .iter()
        .filter(|bot| query.is_empty() || bot.name.to_lowercase().contains(&query))
        .map(|bot| {
            if picked {
                BotRow {
                    default: false,
                    id: bot.id.clone(),
                    name: bot.name.clone(),
                    on: connections.shown_pick(&bot.id, &row.connector)
                        == Some(Some(row.id.clone())),
                    live: !changing && !connections.is_picking(&bot.id, &row.connector),
                    note: connections
                        .pick_refusal(&bot.id, &row.connector)
                        .map(str::to_string),
                }
            } else {
                BotRow {
                    default: connections.shown_pick(&bot.id, &row.connector)
                        == Some(Some(row.id.clone())),
                    id: bot.id.clone(),
                    name: bot.name.clone(),
                    on: connections.shows_lent(row, &bot.id),
                    live: !changing,
                    note: connections
                        .lend_refusal(&row.id, &bot.id)
                        .map(str::to_string),
                }
            }
        })
        .collect()
}

/// What a row's button says and does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum RowAction {
    /// Add: installs a plugin, or starts a service's first sign-in. Dead while another is with the
    /// server.
    Add { live: bool },
    /// The install, or the sign-in page, is with the server.
    Adding,
    /// Installed, or a service the person has an account of.
    Added,
    /// The server will not install it, and says why in the detail.
    Unavailable,
    /// A built-in tool in the Tools window: its switch for the open Bot, and whether a click
    /// would send it.
    Switch { on: bool, live: bool },
    /// A count the row opens onto, as a login's "2 Bots".
    Count(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MarketRow {
    pub selection: PluginSelection,
    pub title: String,
    pub description: String,
    pub category: Option<String>,
    pub action: RowAction,
    /// A built-in tool's symbol for its tile, in place of a letter.
    pub icon: Option<&'static str>,
    /// A row whose page holds more (a tool group): drawn with a "›".
    pub opens_page: bool,
    /// Its name is the tool's own, drawn in monospace as chat shows tool calls.
    pub mono: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Section {
    pub id: String,
    pub title: String,
    pub rows: Vec<MarketRow>,
    /// The category its View all opens, when it has more than it shows.
    pub view_all: Option<String>,
}

/// The marketplace's word for a category, as a heading: its own spelling, capitalised.
pub(crate) fn category_title(category: &str) -> String {
    let mut chars = category.chars();
    match chars.next() {
        Some(first) => first
            .to_uppercase()
            .chain(chars)
            .collect::<String>()
            .replace('-', " "),
        None => String::new(),
    }
}

/// The services this server signs in to, then the marketplace's plugins in its order, then any
/// install the marketplace no longer lists.
pub(crate) fn all_rows(state: &AppState) -> Vec<MarketRow> {
    let market = &state.plugin_market;
    let connections = &state.connections;
    let mut rows = Vec::new();
    if let Some(ConnectorList::Listed(services)) = &connections.connectors {
        let own = connections.own_rows();
        for service in services.iter().filter(|s| s.plugin.is_none()) {
            let label = connections.connector_label(&service.name);
            let action = if own.iter().any(|row| row.connector == service.name) {
                RowAction::Added
            } else if connections.opening.as_deref() == Some(service.name.as_str()) {
                RowAction::Adding
            } else {
                RowAction::Add {
                    live: connections.opening.is_none(),
                }
            };
            rows.push(MarketRow {
                selection: PluginSelection::Service(service.name.clone()),
                description: format!("Sign in with your {label} accounts"),
                title: label,
                category: None,
                action,
                icon: None,
                opens_page: false,
                mono: false,
            });
        }
    }
    let installs = market.installations.as_ref().and_then(Loaded::ready);
    let installed = |name: &str| installs.is_some_and(|rows| rows.iter().any(|i| i.name == name));
    let catalog = market.catalog.as_ref().and_then(Loaded::ready);
    if let Some(catalog) = catalog {
        for entry in &catalog.plugins {
            let action = if installed(&entry.name) {
                RowAction::Added
            } else if market.changing.as_ref() == Some(&(entry.name.clone(), true)) {
                RowAction::Adding
            } else if entry.unavailable_reason.is_some() {
                RowAction::Unavailable
            } else {
                RowAction::Add {
                    live: market.changing.is_none(),
                }
            };
            rows.push(MarketRow {
                selection: PluginSelection::Plugin(entry.name.clone()),
                title: entry.name.clone(),
                description: entry.description.clone(),
                category: entry.category.clone(),
                action,
                icon: None,
                opens_page: false,
                mono: false,
            });
        }
    }
    for install in installs.into_iter().flatten() {
        let listed = catalog.is_some_and(|c| c.plugins.iter().any(|e| e.name == install.name));
        if !listed {
            rows.push(MarketRow {
                selection: PluginSelection::Plugin(install.name.clone()),
                title: install.name.clone(),
                description: install
                    .bundle
                    .manifest
                    .description
                    .clone()
                    .unwrap_or_default(),
                category: None,
                action: RowAction::Added,
                icon: None,
                opens_page: false,
                mono: false,
            });
        }
    }
    rows
}

/// How well a row answers a search, best first: its name or title exactly, starting with what
/// was typed, a word of it starting so, containing it, and last only its description or category
/// having every word. `None` when nothing does (7 Oct 2026: a word deep in a description used to
/// rank with an exact name, in the list's own order).
pub(crate) fn match_rank(row: &MarketRow, query: &str) -> Option<u8> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Some(0);
    }
    let name = match &row.selection {
        PluginSelection::Tool(name)
        | PluginSelection::Plugin(name)
        | PluginSelection::Service(name) => name.to_lowercase(),
        _ => String::new(),
    };
    let title = row.title.to_lowercase();
    // What a tool is also called: the screen tool is "cua", a computer use agent.
    let alias = match name.as_str() {
        "computer" => "cua computer use agent",
        _ => "",
    };
    let names = [title.as_str(), name.as_str(), alias];
    let words = |s: &str| {
        s.split(|c: char| !c.is_alphanumeric())
            .filter(|w| !w.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>()
    };
    if names.iter().any(|n| !n.is_empty() && *n == q) {
        Some(0)
    } else if names.iter().any(|n| !n.is_empty() && n.starts_with(&q)) {
        Some(1)
    } else if names
        .iter()
        .any(|n| words(n).iter().any(|w| w.starts_with(&q)))
    {
        Some(2)
    } else if names.iter().any(|n| n.contains(&q)) {
        Some(3)
    } else if matches(row, query) {
        Some(4)
    } else {
        None
    }
}

/// Where each word of `query` shows in `text`, ignoring case, as byte ranges to mark. Text whose
/// lower case changes its length (some non-Latin letters) is left unmarked rather than marked
/// in the wrong place.
pub(crate) fn matched_spans(text: &str, query: &str) -> Vec<std::ops::Range<usize>> {
    let lower = text.to_lowercase();
    if lower.len() != text.len() {
        return Vec::new();
    }
    let mut spans: Vec<std::ops::Range<usize>> = Vec::new();
    for term in query.split_whitespace().map(str::to_lowercase) {
        let mut from = 0;
        while let Some(at) = lower[from..].find(&term) {
            let start = from + at;
            spans.push(start..start + term.len());
            from = start + term.len().max(1);
        }
    }
    spans.sort_by_key(|r| r.start);
    // Overlapping words ("co comp") are one mark.
    let mut merged: Vec<std::ops::Range<usize>> = Vec::new();
    for span in spans {
        match merged.last_mut() {
            Some(last) if span.start <= last.end => last.end = last.end.max(span.end),
            _ => merged.push(span),
        }
    }
    merged
}

/// `rows` that answer `query`, best first; equally good ones keep their order.
fn ranked(rows: Vec<MarketRow>, query: &str) -> Vec<MarketRow> {
    let mut found: Vec<(u8, MarketRow)> = rows
        .into_iter()
        .filter_map(|row| match_rank(&row, query).map(|rank| (rank, row)))
        .collect();
    found.sort_by_key(|(rank, _)| *rank);
    found.into_iter().map(|(_, row)| row).collect()
}

fn matches(row: &MarketRow, query: &str) -> bool {
    let haystack = format!(
        "{} {} {}",
        row.title,
        row.description,
        row.category.as_deref().unwrap_or_default()
    )
    .to_lowercase();
    query
        .split_whitespace()
        .all(|term| haystack.contains(&term.to_lowercase()))
}

/// The sections the open page shows, in order. A search shows every match, from every page.
pub(crate) fn sections(state: &AppState) -> Vec<Section> {
    let Some(modal) = state.monitor_modal.as_ref() else {
        return Vec::new();
    };
    sections_for(state, modal)
}

/// The Tools window's rows: the open Bot's built-in tools and tool groups, each with its switch.
/// Plugins are not among them: they are switched in the Plugins window.
pub(crate) fn tool_rows(state: &AppState) -> Vec<MarketRow> {
    let Some(card) = state.ceiling_card() else {
        return Vec::new();
    };
    let summaries: Vec<(String, Option<String>)> = match &card.ceiling {
        ToolCeiling::Read(read) => read
            .rows
            .iter()
            .map(|row| (row.name.clone(), row.summary.clone()))
            .collect(),
        _ => Vec::new(),
    };
    let listed = match state.coworker_tools.as_ref() {
        Some((bot, ToolList::Listed(all))) if state.active_coworker_id.as_ref() == Some(bot) => {
            all.as_slice()
        }
        _ => &[],
    };
    crate::components::agent_settings::shown_ceiling_rows(&card)
        .into_iter()
        .filter(|row| row.builtin)
        .map(|row| {
            let group = is_tool_group(&row.name);
            // A group is on while any of its tools is allowed, as its page says (#359); the
            // ceiling's own flag means all of them.
            // A group's switch is its own (7 Oct 2026), as the server says it.
            let on = match group {
                true => listed
                    .iter()
                    .find(|t| t.name == row.name)
                    .and_then(|t| t.enabled)
                    .unwrap_or(row.on),
                false => row.on,
            };
            // The server's sentence for people where it gives one; the model's first line, which
            // is written in its capitals, only on a server from before it (#359).
            let summary = summaries
                .iter()
                .find(|(name, _)| *name == row.name)
                .and_then(|(_, summary)| summary.clone());
            MarketRow {
                icon: tool_icon(&row.name),
                opens_page: group,
                mono: !group,
                selection: PluginSelection::Tool(row.name),
                title: row.title,
                description: summary.unwrap_or(row.first_line),
                category: None,
                action: RowAction::Switch { on, live: row.live },
            }
        })
        .collect()
}

/// Your saved logins as rows: the site, the name, and how many of your Bots may use it.
pub(crate) fn login_rows(state: &AppState) -> Vec<MarketRow> {
    state
        .site_logins
        .iter()
        .map(|login| {
            let bots = state
                .site_login_shares
                .values()
                .filter(|ids| ids.contains(&login.id))
                .count();
            MarketRow {
                selection: PluginSelection::Login(login.id.clone()),
                title: login.origin.clone(),
                description: login.username.clone(),
                category: None,
                action: RowAction::Count(if bots == 1 {
                    "1 Bot".to_string()
                } else {
                    format!("{bots} Bots")
                }),
                icon: Some("icons/key.svg"),
                opens_page: true,
                mono: false,
            }
        })
        .collect()
}

pub(crate) const LOGINS: &str = "market-logins";
/// "Share with all my Bots" on the Logins page: every saved login, every Bot of the person's.
pub(crate) const LOGINS_ALL_BOTS: &str = "market-logins-all-bots";

/// A login's Bots page switch for one Bot.
pub(crate) fn login_bot_switch_id(login: &str, bot: &str) -> String {
    format!("market-login-bot-{login}-{bot}")
}

/// The ceiling rows that stand for a group of tools, each of which has its own page.
pub(crate) fn is_tool_group(name: &str) -> bool {
    matches!(name, "routines" | "plugins" | "manage_computer")
}

/// A built-in tool's symbol (the server sends none); a tool the app does not know gets its
/// letter.
pub(crate) fn tool_icon(name: &str) -> Option<&'static str> {
    Some(match name {
        "shell" | "user_machine_shell" => "icons/session.svg",
        "read_file" => "icons/library.svg",
        "write_file" => "icons/pencil.svg",
        "open_url" => "icons/globe.svg",
        "computer" => "icons/monitor.svg",
        "request_user_form" => "icons/list.svg",
        "run_recipe" => "icons/play.svg",
        "message_bot" => "icons/message-circle.svg",
        "routines" => "icons/clock.svg",
        "plugins" => "icons/plugins.svg",
        "manage_computer" => "icons/power.svg",
        _ => return None,
    })
}

pub(crate) fn sections_for(state: &AppState, modal: &MonitorModal) -> Vec<Section> {
    let query = modal.query.trim();
    if modal.kind == crate::components::monitor_modal::MonitorKind::Tools {
        let rows = ranked(tool_rows(state), query);
        if rows.is_empty() {
            return Vec::new();
        }
        return vec![Section {
            id: "market-section-tools".into(),
            title: if query.is_empty() {
                "Built in"
            } else {
                "Results"
            }
            .into(),
            rows,
            view_all: None,
        }];
    }
    // Your saved logins: each opens its Bots page. Searched here, not with the plugins.
    if modal.page == MarketPage::Logins {
        let rows = ranked(login_rows(state), query);
        if rows.is_empty() {
            return Vec::new();
        }
        return vec![Section {
            id: "market-section-logins".into(),
            title: if query.is_empty() {
                "Logins"
            } else {
                "Results"
            }
            .into(),
            rows,
            view_all: None,
        }];
    }
    let rows = all_rows(state);
    if !query.is_empty() {
        let found = ranked(rows, query);
        return if found.is_empty() {
            Vec::new()
        } else {
            vec![Section {
                id: "market-section-results".into(),
                title: "Results".into(),
                rows: found,
                view_all: None,
            }]
        };
    }
    let is_plugin_in_catalog = |row: &MarketRow| {
        matches!(row.selection, PluginSelection::Plugin(_))
            && state
                .plugin_market
                .catalog
                .as_ref()
                .and_then(Loaded::ready)
                .is_some_and(|c| {
                    c.plugins
                        .iter()
                        .any(|e| PluginSelection::Plugin(e.name.clone()) == row.selection)
                })
    };
    match &modal.page {
        // Answered above, before the plugins are read.
        MarketPage::Logins => Vec::new(),
        MarketPage::Installed => {
            let installed: Vec<_> = rows
                .into_iter()
                .filter(|row| row.action == RowAction::Added)
                .collect();
            if installed.is_empty() {
                return Vec::new();
            }
            vec![Section {
                id: "market-section-installed".into(),
                title: "Installed".into(),
                rows: installed,
                view_all: None,
            }]
        }
        MarketPage::Category(category) => {
            let rows: Vec<_> = rows
                .into_iter()
                .filter(|row| row.category.as_deref() == Some(category.as_str()))
                .collect();
            vec![Section {
                id: format!("market-section-{category}"),
                title: category_title(category),
                rows,
                view_all: None,
            }]
        }
        MarketPage::Browse => {
            let mut sections = Vec::new();
            let services: Vec<_> = rows
                .iter()
                .filter(|row| matches!(row.selection, PluginSelection::Service(_)))
                .cloned()
                .collect();
            if !services.is_empty() {
                sections.push(Section {
                    id: "market-section-apps".into(),
                    title: "Apps".into(),
                    rows: services,
                    view_all: None,
                });
            }
            let mut order: Vec<String> = Vec::new();
            for row in rows.iter().filter(|row| is_plugin_in_catalog(row)) {
                if let Some(category) = &row.category
                    && !order.contains(category)
                {
                    order.push(category.clone());
                }
            }
            for category in order {
                // Installed first, so a category's few shown always include yours.
                let mut all: Vec<_> = rows
                    .iter()
                    .filter(|row| is_plugin_in_catalog(row))
                    .filter(|row| row.category.as_deref() == Some(category.as_str()))
                    .cloned()
                    .collect();
                all.sort_by_key(|row| row.action != RowAction::Added);
                let more = all.len() > PER_SECTION;
                sections.push(Section {
                    id: format!("market-section-{category}"),
                    title: category_title(&category),
                    rows: all.into_iter().take(PER_SECTION).collect(),
                    view_all: more.then(|| category.clone()),
                });
            }
            let unfiled: Vec<_> = rows
                .iter()
                .filter(|row| is_plugin_in_catalog(row) && row.category.is_none())
                .cloned()
                .collect();
            if !unfiled.is_empty() {
                sections.push(Section {
                    id: "market-section-more".into(),
                    title: "More plugins".into(),
                    rows: unfiled,
                    view_all: None,
                });
            }
            sections
        }
    }
}

/// Every row the open page shows, in the order Up and Down move through them.
pub(crate) fn visible_rows(state: &AppState) -> Vec<MarketRow> {
    sections(state)
        .into_iter()
        .flat_map(|section| section.rows)
        .collect()
}

pub(crate) fn row_exists(state: &AppState, selection: &PluginSelection) -> bool {
    all_rows(state)
        .iter()
        .any(|row| &row.selection == selection)
}

/// How many things are installed: plugins, and services the person has an account of.
pub(crate) fn installed_count(state: &AppState) -> usize {
    all_rows(state)
        .iter()
        .filter(|row| row.action == RowAction::Added)
        .count()
}

/// Why the marketplace cannot show everything it would, in the server's words.
pub(crate) fn status_lines(state: &AppState) -> Vec<String> {
    let tools = state
        .monitor_modal
        .as_ref()
        .is_some_and(|m| m.kind == crate::components::monitor_modal::MonitorKind::Tools);
    if tools {
        return match state.ceiling_card().map(|card| card.ceiling) {
            None | Some(ToolCeiling::Loading) => vec![connections::ASKING.to_string()],
            Some(ToolCeiling::Unavailable(why)) => vec![why],
            Some(ToolCeiling::Read(_)) => Vec::new(),
        };
    }
    let market = &state.plugin_market;
    let mut lines = Vec::new();
    match &market.catalog {
        None | Some(Loaded::Loading) => lines.push("Reading the plugin marketplace…".into()),
        Some(Loaded::Failed(why)) => lines.push(why.clone()),
        Some(Loaded::Ready(_)) => {}
    }
    if let Some(Loaded::Failed(why)) = &market.installations {
        lines.push(why.clone());
    }
    if let Some(ConnectorList::Unavailable(why)) = &state.connections.connectors {
        lines.push(why.clone());
    }
    lines
}

/// One of a plugin's tools on its page, for the open Bot (#359): its dotted name (what the
/// choice is set on), what it is called, and the Bot's choice for it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DetailTool {
    pub qualified: String,
    pub title: String,
    pub mode: String,
}

/// A tool's choice in the words of "Use your network from …" (`LocalExecMode::label`).
pub(crate) fn mode_label(mode: &str) -> &'static str {
    match mode {
        "ask" => "Ask every time",
        "never" => "Never allow",
        _ => "Always allow",
    }
}

/// What a tool's switch turns it back on to: Ask every time for one that asks by rule (a delete,
/// an uninstall, a removal), Always allow for the rest (opengrok-tools `Executor::ASK_BY_RULE`).
pub(crate) fn on_mode(tool: &str) -> &'static str {
    match tool {
        "delete_routine"
        | "uninstall_plugin"
        | "remove_plugin_account"
        | "reset_computer"
        | "update_computer"
        | "set_network" => "ask",
        _ => "always",
    }
}

/// One account in a detail's Accounts card.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AccountLine {
    /// The connection's id, or a waiting sign-in's.
    pub id: String,
    pub label: String,
    pub status: AccountStatus,
    pub renaming: Option<String>,
    pub can_rename: bool,
    /// Reconnect (a sign-in page), Reopen (a waiting sign-in) or a new token (a pasted account).
    pub action: Option<(String, AccountAction, bool)>,
    /// Remove can be pressed.
    pub removable: bool,
    /// How many of the person's Bots may use it (an OAuth account's loans), and whether its Bots
    /// list can change them now.
    pub lent: Option<(usize, bool)>,
    pub note: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum AccountStatus {
    Connected,
    /// A sign-in the service has not connected: waiting, or refused with why.
    NeedsAuth(Option<String>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AccountAction {
    Reconnect,
    Reopen,
    ReplaceToken,
    /// Sign in again at an installed plugin's own provider (#364).
    PluginReconnect,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AccountsCard {
    pub connector: String,
    pub title: String,
    pub lines: Vec<AccountLine>,
    /// Add Another Account can be pressed.
    pub can_add: bool,
    /// Its sign-in page is being asked for.
    pub adding: bool,
    pub add_refusal: Option<String>,
    /// Add opens a token field rather than a sign-in page.
    pub pasted: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum DetailAction {
    Add { live: bool },
    Adding,
    Uninstall { live: bool },
    Uninstalling,
    Unavailable(String),
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct MarketDetail {
    pub title: String,
    pub description: String,
    /// "owner/repo" and the address of the pinned source.
    pub source: Option<(String, String)>,
    pub action: Option<DetailAction>,
    pub refusal: Option<String>,
    pub accounts: Vec<AccountsCard>,
    /// Why the bundle's parts are not shown, while they are read or when they cannot be.
    pub parts_status: Option<String>,
    pub skills: Vec<String>,
    pub servers: Vec<String>,
    /// The open Bot's switch for the plugin, and the tools it has from it.
    pub bot_switch: Option<(bool, bool, Option<String>)>,
    /// Whether to ask "Use it in <Bot>?": the plugin has an account, the open Bot's switch is off
    /// and can be moved, and the person has not said Not now this session (#359). Setup is
    /// install, then an account, then the Bots; the third step is one tap here.
    pub use_prompt: bool,
    pub tools: Vec<DetailTool>,
    pub tools_status: Option<String>,
    pub apps: Vec<String>,
    pub unsupported: Vec<(String, String)>,
    pub info: Vec<(&'static str, String)>,
    pub question: Option<String>,
    /// A built-in tool's page: its switch for the open Bot in the header, in place of Add —
    /// `(name, on, live)`.
    pub header_switch: Option<(String, bool, bool)>,
    /// A built-in tool's own choice for the open Bot, on a page with no Tools section.
    pub choice: Option<DetailTool>,
    /// The line under a built-in tool's name: "Built in", and for a group how many of its tools
    /// are allowed.
    pub subtitle: Option<String>,
}

/// A built-in tool's page, the plugin page reused: its switch in the header, what it does, its
/// tools when it is a group (Routines, Plugins), else its own choice, and what it is.
fn tool_detail(state: &AppState, name: &str) -> Option<MarketDetail> {
    let card = state.ceiling_card()?;
    let row = crate::components::agent_settings::shown_ceiling_rows(&card)
        .into_iter()
        .find(|row| row.builtin && row.name == name)?;
    let listed = match state.coworker_tools.as_ref() {
        Some((bot, ToolList::Listed(all))) if state.active_coworker_id.as_ref() == Some(bot) => {
            all.as_slice()
        }
        _ => &[],
    };
    let described = |list: &[crate::opengrok::CoworkerTool]| {
        list.iter()
            .find(|tool| tool.name == name)
            .map(|tool| tool.description.clone())
            .filter(|words| !words.trim().is_empty())
    };
    let ToolCeiling::Read(read) = &card.ceiling else {
        return None;
    };
    let description = described(listed)
        .or_else(|| {
            read.rows
                .iter()
                .find(|r| r.name == name)
                .and_then(|r| r.description.clone())
        })
        .unwrap_or(row.first_line.clone());
    let tools = crate::components::agent_settings::group_tools(listed, name);
    let choice = (tools.is_empty() && row.on)
        .then(|| listed.iter().find(|tool| tool.name == name))
        .flatten()
        .map(|tool| DetailTool {
            qualified: tool.name.clone(),
            title: row.title.clone(),
            mode: tool.mode.clone().unwrap_or_else(|| "always".into()),
        });
    // A group is on while any of its tools is allowed: one tool at Never does not turn the
    // whole group off (#359).
    let allowed = tools.iter().filter(|t| t.mode != "never").count();
    // The group's own switch, as the server says it; its tools keep their choices either way.
    let on = if tools.is_empty() {
        row.on
    } else {
        listed
            .iter()
            .find(|t| t.name == name)
            .and_then(|t| t.enabled)
            .unwrap_or(row.on)
    };
    let subtitle = match (tools.is_empty(), on) {
        (true, _) => "Built in".to_string(),
        (false, true) => format!("Built in · {allowed} of {} allowed", tools.len()),
        (false, false) => format!(
            "Built in · Off — {allowed} of {} allowed when on",
            tools.len()
        ),
    };
    Some(MarketDetail {
        title: row.title.clone(),
        description,
        subtitle: Some(subtitle),
        header_switch: Some((row.name.clone(), on, row.live)),
        tools,
        choice,
        tools_status: row.unavailable.map(str::to_string),
        refusal: row.note.clone(),
        ..Default::default()
    })
}

fn short(revision: &str) -> String {
    revision.chars().take(7).collect()
}

fn service_card(state: &AppState, connector: &str) -> AccountsCard {
    let connections = &state.connections;
    let market = &state.plugin_market;
    let modal = state.monitor_modal.as_ref();
    let removing = modal.is_some_and(|modal| modal.removing);
    let renaming = modal.and_then(|modal| modal.renaming.as_ref());
    let bot = state.active_coworker_id.as_deref().unwrap_or_default();
    let mut lines: Vec<AccountLine> = connections
        .own_rows()
        .into_iter()
        .filter(|row| row.connector == connector)
        .map(|row| {
            let changing = connections.is_changing(&row.id);
            let oauth = row.kind == ConnectionKind::Oauth;
            AccountLine {
                id: row.id.clone(),
                label: connections.shown_label(row),
                status: AccountStatus::Connected,
                renaming: renaming
                    .filter(|(about, _)| *about == row.id)
                    .map(|(_, typed)| typed.clone()),
                can_rename: !changing && !removing,
                action: oauth.then(|| {
                    let live = !changing && !removing && connections.opening.is_none();
                    let label = if connections.reconnecting.as_deref() == Some(row.id.as_str()) {
                        "Opening…"
                    } else {
                        "Reconnect"
                    };
                    (label.to_string(), AccountAction::Reconnect, live)
                }),
                removable: !changing && !removing,
                lent: oauth.then(|| {
                    let count = state
                        .coworkers
                        .iter()
                        .filter(|b| connections.shows_lent(row, &b.id))
                        .count();
                    (count, !changing && !removing)
                }),
                note: connections
                    .not_renamed
                    .get(&row.id)
                    .cloned()
                    .or_else(|| connections.lend_refusal(&row.id, bot).map(str::to_string))
                    .or_else(|| connections.disconnect_refusal(&row.id).map(str::to_string))
                    .or_else(|| {
                        connections
                            .reconnect_refused
                            .as_ref()
                            .filter(|(about, _)| *about == row.id)
                            .map(|(_, why)| why.clone())
                    }),
            }
        })
        .collect();
    for attempt in market.attempts_for(connector) {
        let changing = market.attempt_changing.as_deref() == Some(attempt.id.as_str());
        let failed = attempt.status == "failed";
        lines.push(AccountLine {
            id: attempt.id.clone(),
            label: attempt.label.clone(),
            status: AccountStatus::NeedsAuth(if failed { attempt.error.clone() } else { None }),
            renaming: renaming
                .filter(|(about, _)| *about == attempt.id)
                .map(|(_, typed)| typed.clone()),
            can_rename: !changing && !removing,
            action: Some((
                if changing { "Opening…" } else { "Reopen" }.to_string(),
                AccountAction::Reopen,
                !changing && market.attempt_changing.is_none() && connections.opening.is_none(),
            )),
            removable: !changing && market.attempt_changing.is_none(),
            lent: None,
            note: market.attempt_refusals.get(&attempt.id).cloned(),
        });
    }
    AccountsCard {
        connector: connector.to_string(),
        title: "Accounts".into(),
        lines,
        can_add: connections.opening.is_none() && !removing,
        adding: connections.reconnecting.is_none()
            && connections.opening.as_deref() == Some(connector),
        add_refusal: connections
            .connect_refused
            .as_ref()
            .filter(|(service, _)| *service == connector)
            .map(|(_, why)| why.clone()),
        pasted: false,
    }
}

fn token_card(state: &AppState, plugin: &str, connector: &str, several: bool) -> AccountsCard {
    let connections = &state.connections;
    let market = &state.plugin_market;
    let modal = state.monitor_modal.as_ref();
    let removing = modal.is_some_and(|modal| modal.removing);
    let renaming = modal.and_then(|modal| modal.renaming.as_ref());
    let key = crate::state::sign_in_key(plugin, connector);
    // How the service adds an account (#364): at its own provider, or a pasted token. Until the
    // server says, Add waits rather than guess.
    let method = market.sign_in.get(&key);
    let oauth = matches!(method, Some(Loaded::Ready(m)) if m == "oauth");
    let known = matches!(method, Some(Loaded::Ready(_) | Loaded::Failed(_)));
    let bound: Vec<&str> = market
        .installation(plugin)
        .map(|install| {
            install
                .accounts
                .iter()
                .filter(|a| a.connector == connector)
                .map(|a| a.connection_id.as_str())
                .collect()
        })
        .unwrap_or_default();
    let saving = market.token.as_ref().is_some_and(|form| form.saving);
    let busy = market.authorizing.is_some();
    let mut lines: Vec<AccountLine> = connections
        .own_rows()
        .into_iter()
        .filter(|row| bound.contains(&row.id.as_str()))
        .map(|row| {
            let changing = connections.is_changing(&row.id);
            let action = if row.kind == ConnectionKind::Mcp {
                let opening = market.authorizing.as_deref() == Some(row.id.as_str());
                (
                    if opening { "Opening…" } else { "Reconnect" }.to_string(),
                    AccountAction::PluginReconnect,
                    !changing && !busy && !removing,
                )
            } else {
                (
                    "New token".into(),
                    AccountAction::ReplaceToken,
                    !changing && !saving,
                )
            };
            AccountLine {
                id: row.id.clone(),
                label: connections.shown_label(row),
                status: AccountStatus::Connected,
                renaming: renaming
                    .filter(|(about, _)| *about == row.id)
                    .map(|(_, typed)| typed.clone()),
                can_rename: !changing && !removing,
                action: Some(action),
                removable: !changing && !removing,
                // The Bots that use it by pick: a plugin account is never lent, it is picked
                // per Bot (#359), and its Bots page switches those picks.
                lent: Some((
                    connections.pinned_bots(&row.id).len(),
                    !changing && !removing,
                )),
                note: connections
                    .not_renamed
                    .get(&row.id)
                    .cloned()
                    .or_else(|| market.authorize_refusals.get(&row.id).cloned())
                    .or_else(|| connections.disconnect_refusal(&row.id).map(str::to_string)),
            }
        })
        .collect();
    for attempt in market.plugin_attempts(plugin, connector) {
        let changing = market.attempt_changing.as_deref() == Some(attempt.id.as_str());
        let failed = attempt.status == "failed";
        lines.push(AccountLine {
            id: attempt.id.clone(),
            label: attempt.label.clone(),
            status: AccountStatus::NeedsAuth(if failed { attempt.error.clone() } else { None }),
            renaming: renaming
                .filter(|(about, _)| *about == attempt.id)
                .map(|(_, typed)| typed.clone()),
            can_rename: !changing && !removing,
            action: Some((
                if changing { "Opening…" } else { "Reopen" }.to_string(),
                AccountAction::Reopen,
                !changing && market.attempt_changing.is_none() && !busy,
            )),
            removable: !changing && market.attempt_changing.is_none(),
            lent: None,
            note: market.attempt_refusals.get(&attempt.id).cloned(),
        });
    }
    AccountsCard {
        connector: connector.to_string(),
        title: if several {
            format!("Accounts · {connector}")
        } else {
            "Accounts".into()
        },
        lines,
        can_add: known && !saving && !removing && !busy,
        adding: market.authorizing.as_deref() == Some(key.as_str()),
        add_refusal: market
            .authorize_refusals
            .get(&key)
            .cloned()
            .or_else(|| match method {
                Some(Loaded::Failed(why)) => Some(why.clone()),
                _ => None,
            }),
        pasted: !oauth,
    }
}

fn removal_question(state: &AppState, id: &str) -> Option<String> {
    let connections = &state.connections;
    let own = connections.own_rows();
    let row = own.iter().find(|row| row.id == id)?;
    let name_of = |id: &str| {
        state
            .coworkers
            .iter()
            .find(|bot| bot.id == id)
            .map(|bot| bot.name.clone())
    };
    Some(connections::confirm_question(connections, row, name_of))
}

pub(crate) fn detail(state: &AppState, selection: &PluginSelection) -> Option<MarketDetail> {
    let modal = state.monitor_modal.as_ref()?;
    let question = |plugin_question: Option<String>| {
        if !modal.confirming {
            return None;
        }
        match &modal.removal {
            Some(id) => removal_question(state, id),
            None => plugin_question,
        }
    };
    match selection {
        PluginSelection::Service(name) => {
            let connections = &state.connections;
            let label = connections.connector_label(name);
            let listed = matches!(&connections.connectors, Some(ConnectorList::Listed(rows)) if rows.iter().any(|r| &r.name == name && r.plugin.is_none()));
            if !listed {
                return None;
            }
            Some(MarketDetail {
                header_switch: None,
                choice: None,
                subtitle: None,
                title: label.clone(),
                description: format!(
                    "Sign in with your {label} accounts through this server. Each Bot uses the \
                     account you pick for it, or asks each time."
                ),
                source: None,
                action: None,
                refusal: None,
                accounts: vec![service_card(state, name)],
                parts_status: None,
                skills: Vec::new(),
                servers: Vec::new(),
                bot_switch: None,
                use_prompt: false,
                tools: Vec::new(),
                tools_status: None,
                apps: vec![name.clone()],
                unsupported: Vec::new(),
                info: vec![(
                    "Sign-in",
                    "Through this server; the app never sees a token".into(),
                )],
                question: question(None),
            })
        }
        PluginSelection::Plugin(name) => {
            let market = &state.plugin_market;
            let catalog = market.catalog.as_ref().and_then(Loaded::ready);
            let entry = catalog.and_then(|c| c.plugins.iter().find(|e| &e.name == name));
            let install = market.installation(name);
            if entry.is_none() && install.is_none() {
                return None;
            }
            let read = market.details.get(name);
            let parts_detail: Option<&PluginDetail> = read.and_then(Loaded::ready);
            // The parts installed when installed (what runs), else the pinned bundle's.
            let parts = install
                .map(|i| i.bundle.parts.clone())
                .or_else(|| parts_detail.map(|d| d.parts.clone()))
                .unwrap_or_default();
            let connectors = install
                .map(|i| i.connectors.clone())
                .or_else(|| parts_detail.map(|d| d.connectors.clone()))
                .unwrap_or_default();
            let parts_status = if install.is_some() || parts_detail.is_some() {
                None
            } else {
                match read {
                    Some(Loaded::Failed(why)) => Some(why.clone()),
                    _ => Some("Reading what this plugin brings…".into()),
                }
            };
            let changing = market.changing.as_ref().filter(|(n, _)| n == name);
            // The server loaded it from its own folder: nothing here adds or removes it.
            let from_server = install.is_some_and(|i| i.from_server());
            let action = match (install, changing) {
                (_, Some((_, true))) => DetailAction::Adding,
                (_, Some((_, false))) => DetailAction::Uninstalling,
                (Some(_), None) => DetailAction::Uninstall {
                    live: market.changing.is_none() && !modal.removing,
                },
                (None, None) => match entry.and_then(|e| e.unavailable_reason.clone()) {
                    Some(why) => DetailAction::Unavailable(why),
                    None => DetailAction::Add {
                        live: market.changing.is_none(),
                    },
                },
            };
            let (repository, revision) = match (install, entry) {
                (Some(i), _) => (i.repository.clone(), i.revision.clone()),
                (None, Some(e)) => (e.repository.clone(), e.revision.clone()),
                (None, None) => (String::new(), String::new()),
            };
            let path = entry.map(|e| e.path.clone()).unwrap_or_default();
            // The registry adapter reads GitHub sources only, so `repository` is `owner/repo` there.
            let source = (!repository.is_empty() && repository.contains('/')).then(|| {
                let mut url = format!("https://github.com/{repository}/tree/{revision}");
                if !path.is_empty() {
                    url.push('/');
                    url.push_str(&path);
                }
                (repository.clone(), url)
            });
            let accounts = if install.is_some() {
                connectors
                    .iter()
                    .map(|c| token_card(state, name, c, connectors.len() > 1))
                    .collect()
            } else {
                Vec::new()
            };
            let bot = state.active_bot_name();
            let switch = crate::components::monitor_modal::plugin_switches(state)
                .into_iter()
                .find(|s| &s.name == name);
            let (tools, tools_status) = match state.coworker_tools.as_ref() {
                Some((_, ToolList::Listed(list))) => (
                    list.iter()
                        .filter(|t| t.plugin.as_deref() == Some(name.as_str()))
                        .map(|t| {
                            let qualified = t.qualified.clone().unwrap_or_else(|| t.name.clone());
                            let short = qualified
                                .rsplit('.')
                                .next()
                                .unwrap_or(&qualified)
                                .to_string();
                            DetailTool {
                                title: t.title.clone().unwrap_or(short),
                                mode: t.mode.clone().unwrap_or_else(|| "always".into()),
                                qualified,
                            }
                        })
                        .collect::<Vec<_>>(),
                    None,
                ),
                Some((_, ToolList::Unavailable(why))) => (Vec::new(), Some(why.said.clone())),
                _ => (Vec::new(), Some(connections::ASKING.to_string())),
            };
            let tools_status = tools_status.or_else(|| {
                (install.is_some() && tools.is_empty())
                    .then(|| format!("{bot} has no tools from it right now."))
            });
            let manifest = install
                .map(|i| &i.bundle.manifest)
                .or_else(|| parts_detail.and_then(|d| d.manifest.as_ref()));
            let mut info = Vec::new();
            // What it brings, counted from its parts as the server read them.
            let count = |n: usize, one: &str| match n {
                0 => None,
                1 => Some(format!("1 {one}")),
                n => Some(format!("{n} {one}s")),
            };
            let skills_n = parts
                .iter()
                .filter(|p| p.kind == "skill" && p.supported)
                .count();
            let servers_n = parts
                .iter()
                .filter(|p| p.kind == "mcp" && p.supported)
                .count();
            let capabilities: Vec<String> = [
                count(connectors.len(), "app"),
                count(servers_n, "server"),
                count(skills_n, "skill"),
            ]
            .into_iter()
            .flatten()
            .collect();
            if !capabilities.is_empty() {
                info.push(("Capabilities", capabilities.join(", ")));
            }
            if let Some(author) = manifest.and_then(|m| m.author.as_ref()) {
                info.push(("Developer", author.name.clone()));
            }
            if let Some(category) = entry.and_then(|e| e.category.as_deref()) {
                info.push(("Category", category_title(category)));
            }
            let website = entry
                .and_then(|e| e.homepage.clone())
                .or_else(|| manifest.and_then(|m| m.homepage.clone()));
            if let Some(site) = website {
                let shown = site
                    .trim_start_matches("https://")
                    .trim_start_matches("http://")
                    .trim_end_matches('/')
                    .to_string();
                info.push(("Website", shown));
            }
            info.push((
                "Availability",
                match entry {
                    _ if from_server => SERVER_INSTALLED.into(),
                    None => "No longer listed in the marketplace".into(),
                    Some(e) if e.unavailable_reason.is_some() => {
                        "Not installable on this server".into()
                    }
                    Some(_) => "Public".into(),
                },
            ));
            if let Some(version) = manifest.and_then(|m| m.version.clone()) {
                info.push(("Version", version));
            }
            if !revision.is_empty() {
                info.push(("Pinned commit", short(&revision)));
            }
            let accounts_bound = install.map(|i| i.accounts.len()).unwrap_or(0);
            Some(MarketDetail {
                header_switch: None,
                choice: None,
                subtitle: from_server.then(|| SERVER_INSTALLED.to_string()),
                title: name.clone(),
                description: entry
                    .map(|e| e.description.clone())
                    .filter(|d| !d.is_empty())
                    .or_else(|| install.and_then(|i| i.bundle.manifest.description.clone()))
                    .unwrap_or_default(),
                source,
                action: (!from_server).then_some(action),
                refusal: market.refusals.get(name).cloned(),
                accounts,
                parts_status,
                skills: {
                    let mut skills: Vec<String> = parts
                        .iter()
                        .filter(|p| p.kind == "skill" && p.supported)
                        .map(|p| p.name.clone())
                        .collect();
                    // A server plugin's bundle need not list its parts: its skills are the ones
                    // the Bot's plugin skills name for it.
                    if from_server {
                        for row in state.plugin_skills.iter().filter(|r| &r.plugin == name) {
                            if !skills.contains(&row.skill) {
                                skills.push(row.skill.clone());
                            }
                        }
                    }
                    skills
                },
                servers: parts
                    .iter()
                    .filter(|p| p.kind == "mcp" && p.supported)
                    .map(|p| p.name.clone())
                    .collect(),
                use_prompt: install.is_some_and(|install| !install.accounts.is_empty())
                    && switch.as_ref().is_some_and(|s| !s.on && s.live)
                    && state.active_coworker_id.as_ref().is_some_and(|bot| {
                        !market.use_declined.contains(&(name.clone(), bot.clone()))
                    }),
                bot_switch: install.and(switch).map(|s| (s.on, s.live, s.note)),
                tools,
                tools_status,
                apps: connectors.clone(),
                unsupported: parts
                    .iter()
                    .filter(|p| !p.supported)
                    .map(|p| {
                        (
                            format!("{} · {}", p.name, p.kind),
                            p.reason
                                .clone()
                                .unwrap_or_else(|| "Not run by this server".into()),
                        )
                    })
                    .collect(),
                info,
                // A title and the line under it, split on the line break when drawn: what goes
                // is every account of the plugin with its secrets in the vault, which is what the
                // server's uninstall does (`installed::uninstall`).
                question: question((!from_server).then(|| match accounts_bound {
                    0 => format!(
                        "Uninstall {name}?\nEvery Bot stops using it. Installing it again starts \
                         from the catalog."
                    ),
                    n => format!(
                        "Uninstall {name}?\nIts {n} account{} deleted, with their keys and sign-ins \
                         in the vault, and every Bot stops using it. Installing it again starts with \
                         no accounts.",
                        if n == 1 { " is" } else { "s are" }
                    ),
                })),
            })
        }
        PluginSelection::Tool(name) => tool_detail(state, name),
        PluginSelection::NewSkill
        | PluginSelection::PluginSkill(..)
        | PluginSelection::Login(_) => None,
        PluginSelection::Connection(_) | PluginSelection::Skill(_) => None,
    }
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

use crate::components::fields::field_input;
use crate::components::switch::Switch;
use gpui_kit::component::input::InputState;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::{Icon, IconName, Theme, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;

gpui_kit::actions!(
    nativechat,
    [
        MoveMarketPrevious,
        MoveMarketNext,
        MoveMarketLeft,
        MoveMarketRight,
        OpenMarketHighlight,
        FlipMarketHighlight,
        FlipMarketHighlightBySpace
    ]
);

/// The search field's context, nested in gpui's Input context, so these bindings take the arrows
/// and Enter before the field's own caret keys (the model picker's pattern, #190).
const SEARCH_CONTEXT: &str = "MarketSearch";
const SEARCH_INPUT_CONTEXT: &str = "MarketSearch > Input";

pub fn init(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("up", MoveMarketPrevious, Some(SEARCH_INPUT_CONTEXT)),
        KeyBinding::new("down", MoveMarketNext, Some(SEARCH_INPUT_CONTEXT)),
        KeyBinding::new("ctrl-p", MoveMarketPrevious, Some(SEARCH_INPUT_CONTEXT)),
        KeyBinding::new("ctrl-n", MoveMarketNext, Some(SEARCH_INPUT_CONTEXT)),
        KeyBinding::new("enter", OpenMarketHighlight, Some(SEARCH_INPUT_CONTEXT)),
        // Along a row of the grid; with words typed they are the caret's again.
        // The field's own ⌘[ / ⌘] (outdent, indent) mean nothing in one line of search, and
        // took Back and Forward whenever the caret was still in it, as it is after a search and
        // Enter (7 Oct 2026).
        KeyBinding::new("cmd-[", crate::actions::NavBack, Some(SEARCH_INPUT_CONTEXT)),
        KeyBinding::new(
            "cmd-]",
            crate::actions::NavForward,
            Some(SEARCH_INPUT_CONTEXT),
        ),
        KeyBinding::new("cmd-enter", FlipMarketHighlight, Some(SEARCH_INPUT_CONTEXT)),
        // Space flips only while nothing is typed; in a search it is a space.
        KeyBinding::new(
            "space",
            FlipMarketHighlightBySpace,
            Some(SEARCH_INPUT_CONTEXT),
        ),
        KeyBinding::new("left", MoveMarketLeft, Some(SEARCH_INPUT_CONTEXT)),
        KeyBinding::new("right", MoveMarketRight, Some(SEARCH_INPUT_CONTEXT)),
    ]);
}

/// The inputs the marketplace draws, owned by the modal view.
pub(crate) struct MarketInputs<'a> {
    pub search: &'a Entity<InputState>,
    /// The New skill page's fields; they outlive the page, so what was typed is kept as a draft.
    pub new_skill: Option<&'a crate::components::skills::AddSheetInputs>,
    /// Your own skill's page: its Name, Description and Instructions fields.
    pub skill: Option<(
        &'a Entity<InputState>,
        &'a Entity<InputState>,
        &'a Entity<gpui_kit::component::input::TextareaState>,
    )>,
    pub bots: Option<&'a Entity<InputState>>,
    pub token: Option<&'a Entity<InputState>>,
    pub rename: Option<&'a Entity<InputState>>,
}

/// Where each visible row sits among the scroll list's children, so Up and Down can bring the
/// highlighted one into view.
pub(crate) struct Laid {
    /// The scroll list's children.
    pub blocks: Vec<AnyElement>,
    /// For each visible row, in order, the index of the scroll list's child that holds it.
    pub row_blocks: Vec<usize>,
}

fn pill(
    id: impl Into<String>,
    text: impl Into<SharedString>,
    live: bool,
    theme: &Theme,
    on_click: impl Fn(&mut App) + 'static,
) -> Stateful<Div> {
    let id = id.into();
    let selector = id.clone();
    div()
        .id(SharedString::from(id))
        .debug_selector(move || selector)
        .flex_shrink_0()
        .px(px(14.))
        .py(px(6.))
        .rounded_full()
        .bg(theme.secondary)
        .text_color(theme.secondary_foreground)
        .text_sm()
        .font_weight(FontWeight::MEDIUM)
        .when(live, |this| {
            this.cursor_pointer().hover(|style| style.bg(theme.muted))
        })
        .when(!live, |this| this.opacity(0.5))
        .on_mouse_down(MouseButton::Left, move |_, _, cx| {
            cx.stop_propagation();
            if live {
                on_click(cx);
            }
        })
        .child(text.into())
}

/// [`pill`] for what cannot be undone: the danger color on the text and the edge, so the one
/// button that deletes is told apart from Cancel at a glance.
fn danger_pill(
    id: impl Into<String>,
    text: impl Into<SharedString>,
    live: bool,
    theme: &Theme,
    on_click: impl Fn(&mut App) + 'static,
) -> Stateful<Div> {
    pill(id, text, live, theme, on_click)
        .bg(theme.danger.opacity(0.1))
        .text_color(theme.danger)
        .border_1()
        .border_color(theme.danger.opacity(0.5))
}

/// One tool with this Bot's choice for it: its name, then one pop-up button that says the choice
/// ("Ask every time ▾") and opens a menu of the three, as System Settings does. A tool at Never is
/// greyed and stays listed, so its page is the way back on.
pub(crate) fn tool_row(
    app: &Entity<AppState>,
    tool: &DetailTool,
    changing: Option<&str>,
    open: bool,
    bot: &str,
    theme: &Theme,
) -> Stateful<Div> {
    let busy = changing.is_some();
    let toggle = app.clone();
    let (name, title, mode) = (
        tool.qualified.clone(),
        tool.title.clone(),
        tool.mode.clone(),
    );
    let color = match tool.mode.as_str() {
        "ask" => theme.warning,
        "never" => theme.muted_foreground,
        _ => theme.foreground,
    };
    let button = h_flex()
        .id(SharedString::from(format!(
            "market-tool-mode-{}",
            tool.qualified
        )))
        .debug_selector({
            let id = format!("market-tool-mode-{}", tool.qualified);
            move || id
        })
        .flex_shrink_0()
        .gap(px(4.))
        .items_center()
        .px(px(10.))
        .py(px(4.))
        .rounded(px(7.))
        .border_1()
        .border_color(theme.border)
        .bg(theme.background)
        .text_sm()
        .text_color(color)
        .when(busy, |this| this.opacity(0.5))
        .when(!busy, |this| {
            this.cursor_pointer()
                .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                    cx.stop_propagation();
                    let (name, title, mode) = (name.clone(), title.clone(), mode.clone());
                    toggle.update(cx, |state, cx| {
                        if open {
                            state.close_tool_mode(cx)
                        } else {
                            state.open_tool_mode(name, title, mode, cx)
                        }
                    })
                })
        })
        .child(mode_label(&tool.mode))
        .child(
            Icon::new(IconName::ChevronDown)
                .size(px(12.))
                .text_color(theme.muted_foreground),
        );
    let menu = open.then(|| tool_mode_menu(app, &tool.qualified, &tool.mode, bot, theme));
    card_row(theme, false)
        .id(SharedString::from(format!(
            "market-tool-{}",
            tool.qualified
        )))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .text_sm()
                .when(tool.mode == "never", |this| {
                    this.text_color(theme.muted_foreground)
                })
                .child(tool.title.clone()),
        )
        .child(
            div()
                .relative()
                .child(button)
                .when_some(menu, |this, menu| this.child(menu)),
        )
}

/// The menu a tool's pop-up button opens, under the button: the three choices, each with what it
/// means for this Bot, the current one ticked. A press anywhere else closes it.
fn tool_mode_menu(
    app: &Entity<AppState>,
    tool: &str,
    current: &str,
    bot: &str,
    theme: &Theme,
) -> AnyElement {
    let by_rule = on_mode(tool) == "ask";
    let options: [(&'static str, String); 3] = [
        (
            "always",
            if by_rule {
                format!("{bot} does it without asking. It can't be undone.")
            } else {
                format!("{bot} uses it without asking.")
            },
        ),
        ("ask", "A card asks you first, each time.".to_string()),
        ("never", format!("{bot} can't use it.")),
    ];
    let mut list = v_flex()
        .id("tool-mode-dialog")
        .debug_selector(|| "tool-mode-dialog".into())
        .w(px(260.))
        .py(px(4.))
        .bg(theme.popover)
        .border_1()
        .border_color(theme.border)
        .rounded(px(10.))
        .shadow_lg()
        .on_mouse_down_out({
            let close = app.clone();
            move |_, _, cx| close.update(cx, |state, cx| state.close_tool_mode(cx))
        });
    for (mode, detail) in options {
        let pick = app.clone();
        let tool = tool.to_string();
        let id = format!("tool-mode-{mode}");
        list = list.child(
            h_flex()
                .id(SharedString::from(id.clone()))
                .debug_selector(move || id)
                .w_full()
                .items_start()
                .gap(px(8.))
                .px(px(10.))
                .py(px(6.))
                .cursor_pointer()
                .hover(|s| s.bg(theme.list_hover))
                .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                    cx.stop_propagation();
                    pick.update(cx, |state, cx| state.set_tool_mode(tool.clone(), mode, cx));
                })
                .child(
                    div()
                        .w(px(14.))
                        .text_sm()
                        .child(if mode == current { "✓" } else { "" }),
                )
                .child(
                    v_flex()
                        .flex_1()
                        .min_w(px(0.))
                        .child(div().text_sm().child(mode_label(mode)))
                        .child(
                            div()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child(detail),
                        ),
                ),
        );
    }
    // A zero-size holder at the button's bottom-right corner; the menu hangs from it, its own
    // top-right corner there, so it opens under the button and lines up with its right edge.
    div()
        .absolute()
        .top_full()
        .right_0()
        .size_0()
        .child(
            deferred(
                anchored()
                    .position_mode(AnchoredPositionMode::Local)
                    .position(point(px(0.), px(4.)))
                    .anchor(Anchor::TopRight)
                    .snap_to_window_with_margin(px(8.))
                    .child(list),
            )
            .with_priority(2),
        )
        .into_any_element()
}

fn link(
    id: impl Into<String>,
    text: impl Into<SharedString>,
    live: bool,
    color: Hsla,
    on_click: impl Fn(&mut App) + 'static,
) -> Stateful<Div> {
    let id = id.into();
    let selector = id.clone();
    div()
        .id(SharedString::from(id))
        .debug_selector(move || selector)
        .flex_shrink_0()
        .text_sm()
        .text_color(color)
        .when(live, |this| {
            this.cursor_pointer().hover(|s| s.opacity(0.75))
        })
        .when(!live, |this| this.opacity(0.45))
        .on_mouse_down(MouseButton::Left, move |_, _, cx| {
            cx.stop_propagation();
            if live {
                on_click(cx);
            }
        })
        .child(text.into())
}

/// A plugin's tile: its initial on a neutral square, as Grok Bot draws a plugin with no icon of
/// its own. No plugin's mark is guessed at.
fn tile(title: &str, size: f32, theme: &Theme) -> Div {
    let initial = title
        .chars()
        .find(|c| c.is_alphanumeric())
        .map(|c| c.to_uppercase().to_string())
        .unwrap_or_default();
    div()
        .flex_shrink_0()
        .size(px(size))
        .rounded(px(size * 0.24))
        .bg(theme.secondary)
        .border_1()
        .border_color(theme.border)
        .flex()
        .items_center()
        .justify_center()
        .text_color(theme.muted_foreground)
        .text_size(px(size * 0.4))
        .font_weight(FontWeight::SEMIBOLD)
        .child(initial)
}

/// A 32×32 icon button with its words in a tooltip: an account's Reconnect and Remove.
fn icon_button(
    id: impl Into<String>,
    icon: &'static str,
    tip: String,
    live: bool,
    color: Hsla,
    theme: &Theme,
    on_click: impl Fn(&mut App) + 'static,
) -> Stateful<Div> {
    let id = id.into();
    let selector = id.clone();
    div()
        .id(SharedString::from(id))
        .debug_selector(move || selector)
        .flex_shrink_0()
        .size(px(32.))
        .rounded(px(8.))
        .flex()
        .items_center()
        .justify_center()
        .tooltip(move |window, cx| Tooltip::new(tip.clone()).build(window, cx))
        .when(!live, |this| this.opacity(0.4))
        .when(live, |this| {
            this.cursor_pointer()
                .hover(|s| s.bg(theme.list_hover))
                .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                    cx.stop_propagation();
                    on_click(cx)
                })
        })
        .child(svg().path(icon).size(px(16.)).text_color(color))
}

/// A tile holding a tool's symbol, the size of a plugin's letter tile.
fn icon_tile(icon: &'static str, size: f32, theme: &Theme) -> Div {
    div()
        .flex_shrink_0()
        .size(px(size))
        .rounded(px(size * 0.24))
        .bg(theme.secondary)
        .border_1()
        .border_color(theme.border)
        .flex()
        .items_center()
        .justify_center()
        .child(
            svg()
                .path(icon)
                .size(px(size * 0.42))
                .text_color(theme.foreground.opacity(0.75)),
        )
}

fn row_element(
    app: &Entity<AppState>,
    row: &MarketRow,
    highlighted: bool,
    query: Option<&str>,
    theme: &Theme,
) -> AnyElement {
    let wide = query.is_some();
    let marked = |text: &str| -> AnyElement {
        let spans = query.map(|q| matched_spans(text, q)).unwrap_or_default();
        if spans.is_empty() {
            return div().child(text.to_string()).into_any_element();
        }
        StyledText::new(SharedString::from(text.to_string()))
            .with_highlights(spans.into_iter().map(|range| {
                (
                    range,
                    HighlightStyle {
                        background_color: Some(gpui_kit::yellow().opacity(0.45)),
                        ..Default::default()
                    },
                )
            }))
            .into_any_element()
    };
    let open_app = app.clone();
    let add_app = app.clone();
    let selection = row.selection.clone();
    let add_selection = row.selection.clone();
    let id = row.selection.detail_id();
    let selector = id.clone();
    let action: AnyElement = match &row.action {
        RowAction::Add { live } => pill(add_id(&row.selection), "Add", *live, theme, move |cx| {
            add_app.update(cx, |state, cx| match &add_selection {
                PluginSelection::Plugin(name) => state.install_market_plugin(name.clone(), cx),
                PluginSelection::Service(name) => state.connect_service(name.clone(), cx),
                _ => {}
            })
        })
        .into_any_element(),
        RowAction::Adding => div()
            .id(SharedString::from(add_id(&row.selection)))
            .text_sm()
            .text_color(theme.muted_foreground)
            .child("Adding…")
            .into_any_element(),
        RowAction::Added => h_flex()
            .id(SharedString::from(add_id(&row.selection)))
            .gap(px(4.))
            .items_center()
            .text_sm()
            .text_color(theme.muted_foreground)
            .child(
                Icon::new(IconName::Check)
                    .size(px(14.))
                    .text_color(theme.success),
            )
            .child("Added")
            .into_any_element(),
        RowAction::Count(words) => div()
            .text_xs()
            .px(px(8.))
            .py(px(2.))
            .rounded_full()
            .border_1()
            .border_color(theme.border)
            .text_color(theme.muted_foreground)
            .child(words.clone())
            .into_any_element(),
        RowAction::Unavailable => div()
            .id(SharedString::from(add_id(&row.selection)))
            .text_sm()
            .text_color(theme.muted_foreground)
            .child("Unavailable")
            .into_any_element(),
        RowAction::Switch { on, live } => {
            let switch = app.clone();
            let name = match &row.selection {
                PluginSelection::Tool(name) => name.clone(),
                _ => String::new(),
            };
            Switch::new(ElementId::Name(row.selection.switch_id().into()))
                .checked(*on)
                .small()
                .disabled(!live)
                .accessibility_label(format!("Use {} in this Bot", row.title))
                .on_click(move |on, _, cx| {
                    // A group's switch is its own: the server keeps its tools' choices.
                    switch.update(cx, |state, cx| {
                        state.switch_ceiling_tool(name.clone(), *on, cx)
                    })
                })
                .into_any_element()
        }
    };
    h_flex()
        .id(SharedString::from(id))
        .debug_selector(move || selector)
        // Equal columns whatever the text: a half-full last line keeps a full line's widths.
        .flex_1()
        .flex_basis(px(0.))
        .min_w(px(0.))
        .gap(px(14.))
        .items_center()
        .px(px(12.))
        .py(px(10.))
        .rounded(px(14.))
        .cursor_pointer()
        .when(highlighted, |this| this.bg(theme.list_hover))
        .hover(|style| style.bg(theme.list_hover))
        .on_mouse_down(MouseButton::Left, move |_, _, cx| {
            open_app.update(cx, |state, cx| {
                state.open_market_detail(selection.clone(), cx)
            });
        })
        .child(match row.icon {
            Some(icon) => icon_tile(icon, 44., theme),
            None => tile(&row.title, 44., theme),
        })
        .child(
            v_flex()
                .flex_1()
                .min_w(px(0.))
                .gap(px(2.))
                .child(
                    div()
                        .text_base()
                        .font_weight(FontWeight::MEDIUM)
                        .when(row.mono, |this| this.font_family("Menlo").text_sm())
                        .truncate()
                        .child(marked(&row.title)),
                )
                .child(
                    div()
                        .text_sm()
                        .text_color(theme.muted_foreground)
                        .when(!wide, |this| this.truncate())
                        .when(wide, |this| this.whitespace_normal())
                        .child(marked(&row.description)),
                ),
        )
        .when(row.opens_page, |this| {
            this.child(
                Icon::new(IconName::ChevronRight)
                    .size(px(14.))
                    .text_color(theme.muted_foreground),
            )
        })
        // A fixed column, so every row's control lines up whatever its text. A press on it is
        // the control's alone: it never also opens the row's page.
        .child(
            h_flex()
                .flex_shrink_0()
                .min_w(px(48.))
                .min_h(px(28.))
                .justify_end()
                .items_center()
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(action),
        )
        .into_any_element()
}

/// The marketplace pages: header, search, then the sections as the scroll list's children.
pub(crate) fn browse(
    app: &Entity<AppState>,
    modal: &MonitorModal,
    inputs: &MarketInputs,
    columns: usize,
    theme: &Theme,
    cx: &App,
) -> (AnyElement, Laid) {
    let state = app.read(cx);
    // A search lists its results one to a line, best first, each the window's width with its
    // description whole; the grid is for looking around (7 Oct 2026).
    let searching = !modal.query.trim().is_empty();
    let columns = if searching { 1 } else { columns };
    let installed_app = app.clone();
    let tools = modal.kind == crate::components::monitor_modal::MonitorKind::Tools;
    let count = installed_count(state);
    // Under the bar: the installed shortcut, on the right (the owner's call, 7 Oct 2026). The
    // page's title and its Back are in the window's bar.
    let logins_app = app.clone();
    let all_bots_app = app.clone();
    let all_bots = state.logins_for_all_bots;
    let all_bots_changing = state.logins_for_all_bots_changing;
    let header = h_flex()
        .w_full()
        .h(px(28.))
        .justify_end()
        .items_center()
        .gap(px(16.))
        // One switch shares every saved login with every Bot of the person's, the way their Bots
        // share one computer (9 Oct 2026).
        .when(modal.page == MarketPage::Logins && !tools, |this| {
            this.child(
                h_flex()
                    .items_center()
                    .gap(px(8.))
                    .text_size(px(13.))
                    .text_color(theme.muted_foreground)
                    .child("Share with all my Bots")
                    .child(
                        Switch::new(LOGINS_ALL_BOTS)
                            .checked(all_bots == Some(true))
                            .small()
                            .disabled(all_bots.is_none() || all_bots_changing)
                            .accessibility_label("Share every saved login with all my Bots")
                            .on_click(move |on, _, cx| {
                                all_bots_app
                                    .update(cx, |state, cx| state.set_logins_for_all_bots(*on, cx))
                            }),
                    ),
            )
        })
        // Your saved logins and which Bots may use them, beside what is installed (8 Oct 2026).
        .when(modal.page == MarketPage::Browse && !tools, |this| {
            this.child(
                h_flex()
                    .id(LOGINS)
                    .debug_selector(|| LOGINS.into())
                    .items_center()
                    .gap(px(4.))
                    .cursor_pointer()
                    .text_size(px(13.))
                    .text_color(theme.muted_foreground)
                    .hover(|s| s.text_color(theme.foreground))
                    .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                        logins_app.update(cx, |state, cx| {
                            state.set_market_page(MarketPage::Logins, cx)
                        })
                    })
                    .child("Logins")
                    .child(Icon::new(IconName::ChevronRight).size(px(14.))),
            )
        })
        .when(modal.page == MarketPage::Browse && !tools, |this| {
            this.child(
                h_flex()
                    .id(INSTALLED)
                    .debug_selector(|| INSTALLED.into())
                    .items_center()
                    .gap(px(4.))
                    .cursor_pointer()
                    .text_size(px(13.))
                    .text_color(theme.muted_foreground)
                    .hover(|s| s.text_color(theme.foreground))
                    .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                        installed_app.update(cx, |state, cx| {
                            state.set_market_page(MarketPage::Installed, cx)
                        })
                    })
                    .child(format!("{count} installed"))
                    .child(Icon::new(IconName::ChevronRight).size(px(14.))),
            )
        });
    let move_up = app.clone();
    let move_down = app.clone();
    let move_left = app.clone();
    let move_right = app.clone();
    let flip = app.clone();
    let flip_by_space = app.clone();
    let open = app.clone();
    // ↑ ↓ move a whole row in the grid when it is one section; across sections and in results
    // they go one at a time.
    let one_section = sections_for(state, modal).len() == 1;
    let step = if one_section { columns as isize } else { 1 };
    let search = div()
        .id(SEARCH)
        .debug_selector(|| SEARCH.into())
        .w_full()
        .key_context(SEARCH_CONTEXT)
        .on_action(move |_: &MoveMarketPrevious, _, cx| {
            move_up.update(cx, |state, cx| state.move_market_highlight(-step, cx))
        })
        .on_action(move |_: &MoveMarketNext, _, cx| {
            move_down.update(cx, |state, cx| state.move_market_highlight(step, cx))
        })
        .on_action(move |_: &FlipMarketHighlight, _, cx| {
            flip.update(cx, |state, cx| state.flip_market_highlight(cx))
        })
        .on_action(move |_: &FlipMarketHighlightBySpace, _, cx| {
            if searching {
                cx.propagate();
            } else {
                flip_by_space.update(cx, |state, cx| state.flip_market_highlight(cx))
            }
        })
        .on_action(move |_: &MoveMarketLeft, _, cx| {
            if searching || columns < 2 {
                cx.propagate();
            } else {
                move_left.update(cx, |state, cx| state.move_market_highlight(-1, cx))
            }
        })
        .on_action(move |_: &MoveMarketRight, _, cx| {
            if searching || columns < 2 {
                cx.propagate();
            } else {
                move_right.update(cx, |state, cx| state.move_market_highlight(1, cx))
            }
        })
        .on_action(move |_: &OpenMarketHighlight, _, cx| {
            open.update(cx, |state, cx| state.open_market_highlight(cx))
        })
        .child(
            field_input(inputs.search)
                .h(px(36.))
                .rounded(px(8.))
                .prefix(
                    Icon::new(IconName::Search)
                        .size(px(16.))
                        .text_color(theme.muted_foreground),
                )
                .cleanable(true),
        );
    let top = v_flex()
        .w_full()
        .gap(px(12.))
        // The Logins page draws the bar too, for its "Share with all my Bots" switch.
        .when(
            matches!(modal.page, MarketPage::Browse | MarketPage::Logins) && !tools,
            |this| this.child(header),
        )
        .child(search)
        .into_any_element();

    let mut blocks: Vec<AnyElement> = Vec::new();
    let mut row_blocks = Vec::new();
    let status = status_lines(state);
    if !status.is_empty() {
        blocks.push(
            div()
                .id(STATUS)
                .debug_selector(|| STATUS.into())
                .text_sm()
                .text_color(theme.muted_foreground)
                .child(status.join("\n"))
                .into_any_element(),
        );
    }
    let sections = sections_for(state, modal);
    let mut index = 0usize;
    for section in &sections {
        let view_all = section.view_all.clone();
        let all_app = app.clone();
        let section_id = section.id.clone();
        blocks.push(
            h_flex()
                .id(SharedString::from(section_id.clone()))
                .debug_selector(move || section_id)
                .w_full()
                .pt(px(24.))
                .pb(px(4.))
                .items_center()
                .justify_between()
                .child(
                    div()
                        .text_size(px(13.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.foreground.opacity(0.85))
                        .child(section.title.clone()),
                )
                .when_some(view_all, |this, category| {
                    let id = view_all_id(&category);
                    this.child(link(
                        id,
                        "View all",
                        true,
                        theme.muted_foreground,
                        move |cx| {
                            all_app.update(cx, |state, cx| {
                                state.set_market_page(MarketPage::Category(category.clone()), cx)
                            })
                        },
                    ))
                })
                .into_any_element(),
        );
        for line in section.rows.chunks(columns.max(1)) {
            let mut line_el = h_flex().w_full().gap(px(16.));
            for row in line {
                // Lit only for the keyboard (or while a search is typed, where Enter opens it).
                let lit =
                    index == modal.highlight && (modal.keyed || !modal.query.trim().is_empty());
                let query = searching.then(|| modal.query.trim().to_string());
                line_el = line_el.child(row_element(app, row, lit, query.as_deref(), theme));
                row_blocks.push(blocks.len());
                index += 1;
            }
            // A last line of one keeps the column width of a full one.
            for _ in line.len()..columns.max(1) {
                line_el = line_el.child(div().flex_1().flex_basis(px(0.)).min_w(px(0.)));
            }
            blocks.push(line_el.into_any_element());
        }
    }
    // Your skills, then your org's, on the Installed page: each opens its own page and is
    // switched for the open Bot here. "+ New skill" opens the Write / Upload sheet, which used
    // to be on Settings → Skills.
    if modal.page == MarketPage::Installed && modal.query.trim().is_empty() {
        let (mine, org): (Vec<_>, Vec<_>) = state
            .skills_card()
            .map(|card| crate::components::agent_settings::shown_skill_rows(&card))
            .unwrap_or_default()
            .into_iter()
            .partition(|row| row.mine);
        let heading = |id: &'static str, words: &'static str| {
            div()
                .id(id)
                .debug_selector(move || id.into())
                .pt(px(24.))
                .pb(px(4.))
                .text_size(px(13.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(theme.foreground.opacity(0.85))
                .child(words)
        };
        let new_skill = app.clone();
        blocks.push(
            h_flex()
                .w_full()
                .justify_between()
                .items_end()
                .child(heading("market-section-skills", "Your skills"))
                .child(link(
                    SKILL_NEW,
                    "+ New skill",
                    true,
                    theme.muted_foreground,
                    move |cx| {
                        new_skill.update(cx, |state, cx| {
                            state.open_market_detail(PluginSelection::NewSkill, cx)
                        })
                    },
                ))
                .into_any_element(),
        );
        let first_org = org.first().map(|row| row.id.clone());
        let skills: Vec<_> = mine.into_iter().chain(org).collect();
        for row in skills {
            if first_org.as_deref() == Some(row.id.as_str()) {
                blocks.push(
                    heading("market-section-org-skills", "Your org's skills").into_any_element(),
                );
            }
            let selection = PluginSelection::Skill(row.id.clone());
            let id = selection.detail_id();
            let selector = id.clone();
            let open = app.clone();
            let switch = app.clone();
            let skill = row.id.clone();
            let subtitle = if row.switched_off {
                "Switched off for all Bots".to_string()
            } else {
                row.first_line.clone()
            };
            blocks.push(
                h_flex()
                    .id(SharedString::from(id))
                    .debug_selector(move || selector)
                    .w_full()
                    .gap(px(14.))
                    .items_center()
                    .px(px(12.))
                    .py(px(10.))
                    .rounded(px(14.))
                    .cursor_pointer()
                    .hover(|style| style.bg(theme.list_hover))
                    .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                        open.update(cx, |state, cx| {
                            state.open_market_detail(selection.clone(), cx)
                        })
                    })
                    .child(tile(&row.title, 44., theme))
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w(px(0.))
                            .child(
                                div()
                                    .text_base()
                                    .font_weight(FontWeight::MEDIUM)
                                    .truncate()
                                    .child(row.title.clone()),
                            )
                            .child(
                                div()
                                    .text_sm()
                                    .text_color(theme.muted_foreground)
                                    .truncate()
                                    .child(subtitle),
                            ),
                    )
                    .child(
                        // The switch's press is its own: it never also opens the skill's page.
                        h_flex()
                            .flex_shrink_0()
                            .min_w(px(48.))
                            .min_h(px(28.))
                            .justify_end()
                            .items_center()
                            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                            .child(
                                Switch::new(ElementId::Name(
                                    PluginSelection::Skill(row.id.clone()).switch_id().into(),
                                ))
                                .checked(row.on)
                                .small()
                                .disabled(!row.live)
                                .accessibility_label(format!(
                                    "Attach {} to {}",
                                    row.title,
                                    state.active_bot_name()
                                ))
                                .on_click(move |on, _, cx| {
                                    switch.update(cx, |state, cx| {
                                        state.switch_bot_skill(skill.clone(), *on, cx)
                                    })
                                }),
                            ),
                    )
                    .into_any_element(),
            );
        }
    }
    if sections.is_empty() && status.is_empty() && blocks.is_empty() {
        let words = if tools && !modal.query.trim().is_empty() {
            format!("No tools match “{}”.", modal.query.trim())
        } else if tools {
            "This Bot has no built-in tools to switch.".into()
        } else if !modal.query.trim().is_empty() {
            format!("No plugins match “{}”.", modal.query.trim())
        } else if modal.page == MarketPage::Installed {
            "Nothing is installed yet. Add a plugin from the marketplace.".into()
        } else {
            "The marketplace lists no plugins.".into()
        };
        blocks.push(
            div()
                .id(EMPTY)
                .debug_selector(|| EMPTY.into())
                .py(px(24.))
                .text_sm()
                .text_color(theme.muted_foreground)
                .child(words)
                .into_any_element(),
        );
    }
    (top, Laid { blocks, row_blocks })
}

/// A section's heading: 13px semibold in the text's own color, with room above it, so the
/// sections read apart from the rows under them.
fn section_label(text: impl Into<SharedString>, theme: &Theme) -> Div {
    div()
        .pt(px(24.))
        .pb(px(2.))
        .text_size(px(13.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(theme.foreground.opacity(0.85))
        .child(text.into())
}

fn card(theme: &Theme) -> Div {
    v_flex()
        .w_full()
        .rounded(px(14.))
        .bg(theme.secondary)
        .px(px(16.))
}

fn card_row(theme: &Theme, first: bool) -> Div {
    h_flex()
        .w_full()
        .min_h(px(52.))
        .py(px(10.))
        .gap(px(10.))
        .items_center()
        .when(!first, |this| this.border_t_1().border_color(theme.border))
}

#[allow(clippy::too_many_arguments)]
fn accounts_card(
    app: &Entity<AppState>,
    plugin: Option<&str>,
    card_model: &AccountsCard,
    inputs: &MarketInputs,
    theme: &Theme,
    cx: &App,
) -> AnyElement {
    let state = app.read(cx);
    let token = state.plugin_market.token.as_ref().filter(|form| {
        form.connector == card_model.connector && Some(form.plugin.as_str()) == plugin
    });
    let mut body = card(theme);
    let mut first = true;
    for line in &card_model.lines {
        let rename_app = app.clone();
        let rename_target = line.id.clone();
        let mut row = card_row(theme, first);
        first = false;
        let label: AnyElement = match (&line.renaming, inputs.rename) {
            (Some(_), Some(input)) => {
                let save = app.clone();
                let cancel = app.clone();
                h_flex()
                    .flex_1()
                    .gap(px(8.))
                    .items_center()
                    .child(
                        div()
                            .id(SharedString::from(
                                crate::components::monitor_modal::rename_field_id(&line.id),
                            ))
                            .debug_selector({
                                let id =
                                    crate::components::monitor_modal::rename_field_id(&line.id);
                                move || id
                            })
                            .flex_1()
                            .child(field_input(input)),
                    )
                    .child(pill(
                        "monitor-account-save",
                        "Save",
                        true,
                        theme,
                        move |cx| save.update(cx, |state, cx| state.save_account_rename(cx)),
                    ))
                    .child(link(
                        "monitor-account-cancel",
                        "Cancel",
                        true,
                        theme.muted_foreground,
                        move |cx| cancel.update(cx, |state, cx| state.cancel_account_rename(cx)),
                    ))
                    .into_any_element()
            }
            _ => h_flex()
                .flex_1()
                .min_w(px(0.))
                .gap(px(6.))
                .items_center()
                .child(
                    div()
                        .id(SharedString::from(
                            crate::components::monitor_modal::account_id(&line.id),
                        ))
                        .debug_selector({
                            let id = crate::components::monitor_modal::account_id(&line.id);
                            move || id
                        })
                        .text_base()
                        .truncate()
                        .child(line.label.clone()),
                )
                .child(
                    div()
                        .id(SharedString::from(
                            crate::components::monitor_modal::rename_id(&line.id),
                        ))
                        .debug_selector({
                            let id = crate::components::monitor_modal::rename_id(&line.id);
                            move || id
                        })
                        .when(line.can_rename, |this| this.cursor_pointer())
                        .when(!line.can_rename, |this| this.opacity(0.4))
                        .on_mouse_down(MouseButton::Left, {
                            let live = line.can_rename;
                            move |_, _, cx| {
                                cx.stop_propagation();
                                if live {
                                    rename_app.update(cx, |state, cx| {
                                        state.start_account_rename(rename_target.clone(), cx)
                                    });
                                }
                            }
                        })
                        .child(
                            svg()
                                .path("icons/pencil.svg")
                                .size(px(14.))
                                .text_color(theme.muted_foreground),
                        ),
                )
                .into_any_element(),
        };
        // Its state on a second line under the name, so the row's right side holds controls only.
        let status_line = line.renaming.is_none().then(|| match &line.status {
            AccountStatus::Connected => div()
                .text_xs()
                .text_color(theme.muted_foreground)
                .child("Connected"),
            AccountStatus::NeedsAuth(_) => div()
                .text_xs()
                .text_color(theme.warning)
                .child("Needs sign-in"),
        });
        row = row.child(
            v_flex()
                .flex_1()
                .min_w(px(0.))
                .gap(px(2.))
                .child(label)
                .children(status_line),
        );
        if line.renaming.is_none() {
            if let Some((count, live)) = line.lent {
                let open = app.clone();
                let id = line.id.clone();
                row = row.child(
                    h_flex()
                        .id(SharedString::from(bots_id(&line.id)))
                        .debug_selector({
                            let sel = bots_id(&line.id);
                            move || sel
                        })
                        .gap(px(6.))
                        .items_center()
                        .px(px(10.))
                        .py(px(4.))
                        .rounded_full()
                        .border_1()
                        .border_color(theme.border)
                        .text_sm()
                        .text_color(theme.muted_foreground)
                        .when(live, |this| {
                            this.cursor_pointer().hover(|s| s.bg(theme.muted))
                        })
                        .when(!live, |this| this.opacity(0.5))
                        .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                            cx.stop_propagation();
                            if live {
                                open.update(cx, |state, cx| {
                                    state.open_account_bots(Some(id.clone()), cx)
                                });
                            }
                        })
                        .child(
                            svg()
                                .path("icons/bot.svg")
                                .size(px(14.))
                                .text_color(theme.muted_foreground),
                        )
                        .child(format!("{count} Bot{}", if count == 1 { "" } else { "s" })),
                );
            }
            let needs_auth = matches!(line.status, AccountStatus::NeedsAuth(_));
            if let Some((text, action, live)) = &line.action {
                let act_app = app.clone();
                let id = line.id.clone();
                let action = *action;
                let plugin = plugin.map(str::to_string);
                let connector = card_model.connector.clone();
                let element_id = match action {
                    AccountAction::Reconnect => {
                        crate::components::monitor_modal::reconnect_id(&line.id)
                    }
                    AccountAction::Reopen => reopen_id(&line.id),
                    AccountAction::ReplaceToken => replace_token_id(&line.id),
                    AccountAction::PluginReconnect => {
                        crate::components::monitor_modal::reconnect_id(&line.id)
                    }
                };
                // One button that changes with the account: Reconnect while it is connected, Sign
                // in again (amber) while it needs it, New token for a pasted one.
                let (icon, tip) = match action {
                    AccountAction::ReplaceToken => ("icons/key.svg", "New token"),
                    _ if needs_auth => ("icons/refresh.svg", "Sign in again"),
                    _ => ("icons/refresh.svg", "Reconnect"),
                };
                let tip = if text.ends_with('…') {
                    text.clone()
                } else {
                    tip.to_string()
                };
                row = row.child(icon_button(
                    element_id,
                    icon,
                    tip,
                    *live,
                    if needs_auth {
                        theme.warning
                    } else {
                        theme.muted_foreground
                    },
                    theme,
                    move |cx| {
                        act_app.update(cx, |state, cx| match action {
                            AccountAction::Reconnect => state.reconnect_connection(id.clone(), cx),
                            AccountAction::Reopen => state.reopen_attempt(id.clone(), cx),
                            AccountAction::PluginReconnect => {
                                if let Some(plugin) = &plugin {
                                    state.authorize_plugin(
                                        plugin.clone(),
                                        connector.clone(),
                                        Some(id.clone()),
                                        cx,
                                    )
                                }
                            }
                            AccountAction::ReplaceToken => {
                                if let Some(plugin) = &plugin {
                                    state.start_market_token(
                                        plugin.clone(),
                                        connector.clone(),
                                        Some(id.clone()),
                                        cx,
                                    )
                                }
                            }
                        })
                    },
                ));
            }
            let remove_app = app.clone();
            let id = line.id.clone();
            let waiting = matches!(line.status, AccountStatus::NeedsAuth(_));
            let remove_id = if waiting {
                dismiss_id(&line.id)
            } else {
                remove_account_id(&line.id)
            };
            row = row.child(icon_button(
                remove_id,
                "icons/trash.svg",
                if waiting { "Dismiss" } else { "Remove account" }.to_string(),
                line.removable,
                theme.muted_foreground,
                theme,
                move |cx| {
                    remove_app.update(cx, |state, cx| {
                        if waiting {
                            state.dismiss_attempt(id.clone(), cx)
                        } else {
                            state.ask_account_remove(Some(id.clone()), cx)
                        }
                    })
                },
            ));
        }
        body = body.child(row);
        let why = match &line.status {
            AccountStatus::NeedsAuth(Some(why)) => Some(why.clone()),
            _ => None,
        };
        if let Some(note) = line.note.clone().or(why) {
            body = body.child(
                div()
                    .id(SharedString::from(
                        crate::components::monitor_modal::account_note_id(&line.id),
                    ))
                    .pb(px(8.))
                    .text_xs()
                    .text_color(theme.danger)
                    .child(note),
            );
        }
    }
    if let (Some(form), Some(input)) = (token, inputs.token) {
        let save = app.clone();
        let cancel = app.clone();
        let saving = form.saving;
        body = body.child(
            card_row(theme, first)
                .child(
                    div()
                        .id(TOKEN_FIELD)
                        .debug_selector(|| TOKEN_FIELD.into())
                        .flex_1()
                        .child(field_input(input)),
                )
                .child(pill(
                    TOKEN_SAVE,
                    if saving { "Saving…" } else { "Save" },
                    !saving,
                    theme,
                    move |cx| save.update(cx, |state, cx| state.save_market_token(cx)),
                ))
                .child(link(
                    TOKEN_CANCEL,
                    "Cancel",
                    !saving,
                    theme.muted_foreground,
                    move |cx| cancel.update(cx, |state, cx| state.cancel_market_token(cx)),
                )),
        );
        first = false;
        if let Some(why) = form.refusal.clone() {
            body = body.child(
                div()
                    .id(TOKEN_REFUSAL)
                    .debug_selector(|| TOKEN_REFUSAL.into())
                    .pb(px(8.))
                    .text_xs()
                    .text_color(theme.danger)
                    .child(why),
            );
        }
    }
    let add_app = app.clone();
    let connector = card_model.connector.clone();
    let pasted = card_model.pasted;
    let plugin_name = plugin.map(str::to_string);
    let add_id = add_account_id(&card_model.connector);
    let add_selector = add_id.clone();
    let live = card_model.can_add && token.is_none();
    body = body.child(
        card_row(theme, first)
            .id(SharedString::from(add_id))
            .debug_selector(move || add_selector)
            .when(live, |this| this.cursor_pointer())
            .when(!live, |this| this.opacity(0.5))
            .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                if !live {
                    return;
                }
                add_app.update(cx, |state, cx| match (&plugin_name, pasted) {
                    (Some(plugin), true) => {
                        state.start_market_token(plugin.clone(), connector.clone(), None, cx)
                    }
                    // An installed plugin whose server signs people in itself (#364).
                    (Some(plugin), false) => {
                        state.authorize_plugin(plugin.clone(), connector.clone(), None, cx)
                    }
                    (None, _) => state.connect_service(connector.clone(), cx),
                })
            })
            .child(
                Icon::new(IconName::Plus)
                    .size(px(14.))
                    .text_color(theme.muted_foreground),
            )
            .child(div().text_base().text_color(theme.muted_foreground).child(
                if card_model.adding {
                    "Opening sign-in…"
                } else if card_model.lines.is_empty() {
                    "Add Account"
                } else {
                    "Add Another Account"
                },
            )),
    );
    let mut out = v_flex()
        .id(SharedString::from(format!(
            "market-accounts-{}",
            card_model.connector
        )))
        .gap(px(6.))
        .child(section_label(card_model.title.clone(), theme))
        .child(body);
    if let Some(why) = card_model.add_refusal.clone() {
        out = out.child(
            div()
                .id(crate::components::monitor_modal::ADD_ACCOUNT_ERROR)
                .text_xs()
                .text_color(theme.danger)
                .child(why),
        );
    }
    // Which account the open Bot uses, once there is one to pick (#359).
    if card_model
        .lines
        .iter()
        .any(|l| l.status == AccountStatus::Connected)
    {
        out = out.child(picker(app, &card_model.connector, card_model, theme, cx));
    }
    out.into_any_element()
}

/// "Current Bot": which account the open Bot uses for this service without asking, as one row,
/// "Genie's default Gmail account", and a box that opens a menu of Always ask and the accounts
/// (opengrok-server #359's pins). Always ask is the default. The choices keep the picker's ids.
fn picker(
    app: &Entity<AppState>,
    connector: &str,
    card_model: &AccountsCard,
    theme: &Theme,
    cx: &App,
) -> AnyElement {
    let state = app.read(cx);
    let connections = &state.connections;
    let bot = state.active_coworker_id.as_deref().unwrap_or_default();
    let picked = connections.shown_pick(bot, connector);
    let live = picked.is_some() && !connections.is_picking(bot, connector);
    let note = match (connections.pick_refusal(bot, connector), &connections.pins) {
        (Some(why), _) => Some(why.to_string()),
        (None, None | Some(crate::state::PinList::Loading)) => {
            Some(connections::ASKING.to_string())
        }
        (None, Some(crate::state::PinList::Unavailable(why))) => Some(why.clone()),
        (None, Some(crate::state::PinList::Listed(_))) => None,
    };
    let accounts: Vec<(String, String)> = card_model
        .lines
        .iter()
        .filter(|l| l.status == AccountStatus::Connected)
        .map(|l| (l.id.clone(), l.label.clone()))
        .collect();
    let current = match &picked {
        Some(Some(id)) => accounts
            .iter()
            .find(|(a, _)| a == id)
            .map(|(_, label)| label.clone())
            .unwrap_or_else(|| id.clone()),
        _ => crate::components::monitor_modal::ASK_EACH_TIME.to_string(),
    };
    let open = state.account_menu.as_deref() == Some(connector);
    let service = state.connections.connector_label(connector);
    let toggle = app.clone();
    let service_key = connector.to_string();
    let button = h_flex()
        .id(crate::components::monitor_modal::PICKER)
        .debug_selector(|| crate::components::monitor_modal::PICKER.into())
        .w(px(240.))
        .h(px(32.))
        .px(px(10.))
        .justify_between()
        .items_center()
        .rounded(px(8.))
        .border_1()
        .border_color(theme.border)
        .bg(theme.background)
        .text_sm()
        .when(!live, |this| this.opacity(0.5))
        .when(live, |this| {
            this.cursor_pointer()
                .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                    cx.stop_propagation();
                    let next = (!open).then(|| service_key.clone());
                    toggle.update(cx, |state, cx| state.toggle_account_menu(next, cx))
                })
        })
        .child(div().truncate().child(current))
        .child(
            Icon::new(IconName::ChevronDown)
                .size(px(12.))
                .text_color(theme.muted_foreground),
        );
    let menu = open.then(|| {
        let mut list = v_flex()
            .w(px(240.))
            .py(px(4.))
            .bg(theme.popover)
            .border_1()
            .border_color(theme.border)
            .rounded(px(10.))
            .shadow_lg()
            .on_mouse_down_out({
                let close = app.clone();
                move |_, _, cx| close.update(cx, |state, cx| state.toggle_account_menu(None, cx))
            });
        let mut choices: Vec<(String, String, Option<String>)> = vec![(
            crate::components::monitor_modal::PICK_ASK.into(),
            crate::components::monitor_modal::ASK_EACH_TIME.into(),
            None,
        )];
        for (id, label) in &accounts {
            choices.push((
                crate::components::monitor_modal::pick_id(id),
                label.clone(),
                Some(id.clone()),
            ));
        }
        for (element, text, target) in choices {
            let chosen = picked.as_ref() == Some(&target);
            let app = app.clone();
            let service = connector.to_string();
            let selector = element.clone();
            list = list.child(
                h_flex()
                    .id(SharedString::from(element))
                    .debug_selector(move || selector)
                    .gap(px(8.))
                    .px(px(10.))
                    .py(px(6.))
                    .cursor_pointer()
                    .hover(|s| s.bg(theme.list_hover))
                    .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                        cx.stop_propagation();
                        app.update(cx, |state, cx| {
                            state.toggle_account_menu(None, cx);
                            state.pick_account(service.clone(), target.clone(), cx)
                        });
                    })
                    .child(
                        div()
                            .w(px(14.))
                            .text_sm()
                            .child(if chosen { "✓" } else { "" }),
                    )
                    .child(div().text_sm().truncate().child(text)),
            );
        }
        div().absolute().top_full().right_0().size_0().child(
            deferred(
                anchored()
                    .position_mode(AnchoredPositionMode::Local)
                    .position(point(px(0.), px(4.)))
                    .anchor(Anchor::TopRight)
                    .snap_to_window_with_margin(px(8.))
                    .child(list),
            )
            .with_priority(2),
        )
    });
    let mut out = v_flex()
        .gap(px(6.))
        .child(section_label("Current Bot", theme))
        .child(
            card(theme).child(
                card_row(theme, true)
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(0.))
                            .text_base()
                            .truncate()
                            .child(format!(
                                "{}'s default {service} account",
                                state.active_bot_name()
                            )),
                    )
                    .child(div().relative().child(button).children(menu)),
            ),
        );
    if let Some(note) = note {
        out = out.child(
            div()
                .id(crate::components::monitor_modal::PICKER_NOTE)
                .text_xs()
                .text_color(theme.muted_foreground)
                .child(note),
        );
    }
    out.into_any_element()
}

/// A plugin's or a service's detail, in the Grok Bot layout.
pub(crate) fn detail_view(
    app: &Entity<AppState>,
    modal: &MonitorModal,
    selection: &PluginSelection,
    inputs: &MarketInputs,
    theme: &Theme,
    cx: &App,
) -> AnyElement {
    let state = app.read(cx);
    // Back is in the window's pinned bar (`page_bar`), beside Close, so it never scrolls away.
    let back = div().id("market-detail-top");
    if let Some(account) = modal.bots_for.clone() {
        return bots_view(app, modal, &account, inputs, theme, cx);
    }
    if let PluginSelection::Skill(id) = selection {
        return skill_page(app, id, back, inputs, theme, cx);
    }
    if *selection == PluginSelection::NewSkill {
        return new_skill_page(inputs.new_skill, theme, cx);
    }
    if let PluginSelection::PluginSkill(plugin, skill) = selection {
        return plugin_skill_page(app, plugin, skill, back, theme, cx);
    }
    if let PluginSelection::Login(id) = selection {
        return login_bots_page(app, id, back, theme, cx);
    }
    let Some(model) = detail(state, selection) else {
        return v_flex()
            .id(DETAIL)
            .gap(px(12.))
            .child(back)
            .child(
                div()
                    .text_sm()
                    .text_color(theme.muted_foreground)
                    .child("This plugin is no longer listed or installed."),
            )
            .into_any_element();
    };
    let plugin = match selection {
        PluginSelection::Plugin(name) => Some(name.clone()),
        _ => None,
    };
    let action: Option<AnyElement> = model.action.as_ref().map(|action| {
        let act = app.clone();
        let name = plugin.clone().unwrap_or_default();
        match action {
            DetailAction::Add { live } => pill(DETAIL_ACTION, "Add", *live, theme, move |cx| {
                act.update(cx, |state, cx| {
                    state.install_market_plugin(name.clone(), cx)
                })
            })
            .into_any_element(),
            DetailAction::Uninstall { live } => pill(
                DETAIL_ACTION,
                "Uninstall",
                *live && !modal.confirming,
                theme,
                move |cx| act.update(cx, |state, cx| state.ask_market_uninstall(true, cx)),
            )
            .into_any_element(),
            DetailAction::Adding => {
                pill(DETAIL_ACTION, "Adding…", false, theme, |_| {}).into_any_element()
            }
            DetailAction::Uninstalling => {
                pill(DETAIL_ACTION, "Uninstalling…", false, theme, |_| {}).into_any_element()
            }
            DetailAction::Unavailable(_) => {
                pill(DETAIL_ACTION, "Unavailable", false, theme, |_| {}).into_any_element()
            }
        }
    });
    let source = model.source.clone();
    let header = h_flex()
        .w_full()
        .gap(px(16.))
        .items_center()
        .child(tile(&model.title, 64., theme))
        .child(
            v_flex()
                .flex_1()
                .min_w(px(0.))
                .gap(px(2.))
                .child(
                    div()
                        .text_xl()
                        .font_weight(FontWeight::SEMIBOLD)
                        .truncate()
                        .child(model.title.clone()),
                )
                .when_some(model.subtitle.clone(), |this, line| {
                    this.child(
                        div()
                            .text_sm()
                            .text_color(theme.muted_foreground)
                            .child(line),
                    )
                })
                .when_some(source, |this, (repository, url)| {
                    this.child(link(
                        SOURCE,
                        format!("View Source ↗  {repository}"),
                        true,
                        theme.muted_foreground,
                        move |cx| cx.open_url(&url),
                    ))
                }),
        )
        .when_some(action, |this, action| this.child(action))
        // A built-in tool's page has its switch where a plugin's has Add.
        .when_some(model.header_switch.clone(), |this, (name, on, live)| {
            let switch = app.clone();
            this.child(
                Switch::new(ElementId::Name(
                    format!("agent-ceiling-switch-{name}").into(),
                ))
                .checked(on)
                .disabled(!live)
                .accessibility_label(format!(
                    "Use {} in {}",
                    model.title,
                    state.active_bot_name()
                ))
                .on_click(move |on, _, cx| {
                    switch.update(cx, |state, cx| {
                        state.switch_ceiling_tool(name.clone(), *on, cx)
                    })
                }),
            )
        });
    let mut body = v_flex()
        .id(DETAIL)
        .debug_selector(|| DETAIL.into())
        .w_full()
        .gap(px(12.))
        .child(back)
        .child(header);
    if !model.description.is_empty() {
        body = body.child(
            div()
                .text_base()
                .text_color(theme.muted_foreground)
                .child(model.description.clone()),
        );
    }
    if let Some(DetailAction::Unavailable(why)) = &model.action {
        body = body.child(
            div()
                .id(DETAIL_REFUSAL)
                .text_sm()
                .text_color(theme.warning)
                .child(why.clone()),
        );
    }
    if let Some(why) = model.refusal.clone() {
        body = body.child(
            div()
                .id(DETAIL_REFUSAL)
                .debug_selector(|| DETAIL_REFUSAL.into())
                .text_sm()
                .text_color(theme.danger)
                .child(why),
        );
    }
    if model.use_prompt
        && let Some(name) = plugin.clone()
    {
        let bot = state.active_bot_name();
        let (on, later) = (app.clone(), app.clone());
        let (turn_on, not_now) = (name.clone(), name.clone());
        body = body.child(
            card(theme).child(
                card_row(theme, false)
                    .id(SharedString::from(format!("market-use-prompt-{name}")))
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap(px(2.))
                            .child(
                                div()
                                    .text_sm()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(format!("Use {} in {bot}?", model.title)),
                            )
                            .child(div().text_xs().text_color(theme.muted_foreground).child(
                                format!(
                                    "It's off for {bot}, which uses it only when you tag @{name}."
                                ),
                            )),
                    )
                    .child(
                        h_flex()
                            .gap(px(12.))
                            .items_center()
                            .child(link(
                                format!("market-use-prompt-not-now-{name}"),
                                "Not now",
                                true,
                                theme.muted_foreground,
                                move |cx| {
                                    later.update(cx, |state, cx| {
                                        state.decline_use_prompt(not_now.clone(), cx)
                                    })
                                },
                            ))
                            .child(pill(
                                format!("market-use-prompt-on-{name}"),
                                "Turn on",
                                true,
                                theme,
                                move |cx| {
                                    on.update(cx, |state, cx| {
                                        state.switch_ceiling_tool(turn_on.clone(), true, cx)
                                    })
                                },
                            )),
                    ),
            ),
        );
    }
    for accounts in &model.accounts {
        body = body.child(accounts_card(
            app,
            plugin.as_deref(),
            accounts,
            inputs,
            theme,
            cx,
        ));
    }
    if let Some(status) = model.parts_status.clone() {
        body = body.child(
            div()
                .text_sm()
                .text_color(theme.muted_foreground)
                .child(status),
        );
    }
    if plugin.is_some() && model.parts_status.is_none() {
        // Tools: the open Bot's switch for the plugin, and the tools it has from it right now.
        let toggle = app.clone();
        let open = modal.tools_open;
        let summary = if model.tools.is_empty() {
            format!(
                "{} server{}",
                model.servers.len(),
                if model.servers.len() == 1 { "" } else { "s" }
            )
        } else {
            let on = model.tools.iter().filter(|t| t.mode != "never").count();
            format!(
                "{on} of {} on for {}",
                model.tools.len(),
                state.active_bot_name()
            )
        };
        let mut tools = card(theme).child(
            card_row(theme, true)
                .id(TOOLS)
                .debug_selector(|| TOOLS.into())
                .cursor_pointer()
                .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                    toggle.update(cx, |state, cx| state.toggle_market_tools(cx))
                })
                .child(div().flex_1().text_base().child(summary))
                .when_some(model.bot_switch.clone(), |this, (on, live, _)| {
                    let name = plugin.clone().unwrap_or_default();
                    let switch = app.clone();
                    this.child(
                        h_flex()
                            .gap(px(6.))
                            .items_center()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(format!("Use in {}", state.active_bot_name()))
                            .child(
                                Switch::new(ElementId::Name(
                                    crate::components::monitor_modal::plugin_switch_id(&name)
                                        .into(),
                                ))
                                .checked(on)
                                .small()
                                .disabled(!live)
                                .accessibility_label(format!(
                                    "Use {name} in {}",
                                    state.active_bot_name()
                                ))
                                .on_click(move |on, _, cx| {
                                    switch.update(cx, |state, cx| {
                                        state.switch_ceiling_tool(name.clone(), *on, cx)
                                    })
                                }),
                            ),
                    )
                })
                .child(
                    Icon::new(if open {
                        IconName::ChevronUp
                    } else {
                        IconName::ChevronDown
                    })
                    .size(px(14.))
                    .text_color(theme.muted_foreground),
                ),
        );
        if open {
            for server in &model.servers {
                tools = tools.child(
                    card_row(theme, false)
                        .child(div().text_sm().child(format!("{server} · MCP server"))),
                );
            }
            let changing = state.tool_mode_changing.clone();
            let menu_for = state
                .tool_mode_dialog
                .as_ref()
                .map(|(tool, ..)| tool.clone());
            let bot = state.active_bot_name();
            for tool in &model.tools {
                let open = menu_for.as_deref() == Some(tool.qualified.as_str());
                tools = tools.child(tool_row(app, tool, changing.as_deref(), open, &bot, theme));
            }
            if let Some(status) = model.tools_status.clone() {
                tools = tools.child(
                    card_row(theme, false).child(
                        div()
                            .text_sm()
                            .text_color(theme.muted_foreground)
                            .child(status),
                    ),
                );
            }
        }
        // A read of the tools that failed is the ⚠ at the label's far side, and no line.
        let tools_label = h_flex()
            .w_full()
            .items_center()
            .rounded(px(6.))
            .map(|row| {
                crate::components::faults::ring(row, state.is_focused(crate::faults::Place::Tools))
            })
            .child(section_label("Tools", theme))
            .child(div().flex_1())
            .when(
                state.open_fault(crate::faults::Place::Tools).is_some(),
                |row| {
                    row.child(crate::components::faults::badge_element(
                        crate::faults::Place::Tools,
                        app.clone(),
                    ))
                },
            );
        body = body.child(tools_label).child(tools);
        if let Some((_, _, Some(note))) = model.bot_switch.clone() {
            let id = crate::components::monitor_modal::plugin_switch_note_id(
                plugin.as_deref().unwrap_or_default(),
            );
            body = body.child(
                div()
                    .id(SharedString::from(id))
                    .text_xs()
                    .text_color(theme.danger)
                    .child(note),
            );
        }
    }
    if matches!(selection, PluginSelection::Tool(_)) {
        let changing = state.tool_mode_changing.clone();
        let menu_for = state
            .tool_mode_dialog
            .as_ref()
            .map(|(tool, ..)| tool.clone());
        let bot = state.active_bot_name();
        let group_off = model.header_switch.as_ref().is_some_and(|(_, on, _)| !on);
        if !model.tools.is_empty() {
            // A group's tools, each with its choice, one row each; dimmed while the group is
            // off, still editable, since the group keeps them (7 Oct 2026).
            let mut c = card(theme).when(group_off, |this| this.opacity(0.55));
            for tool in &model.tools {
                let open = menu_for.as_deref() == Some(tool.qualified.as_str());
                c = c.child(tool_row(app, tool, changing.as_deref(), open, &bot, theme));
            }
            body = body
                .child(section_label(
                    format!("Tools  {}", model.tools.len()),
                    theme,
                ))
                .child(c);
            if group_off {
                body = body.child(
                    div()
                        .text_sm()
                        .text_color(theme.muted_foreground)
                        .child(format!("Turn on {} to use these.", model.title)),
                );
            }
        }
        if let Some(tool) = &model.choice {
            // A lone tool's choice, the same pop-up button a group's tools have.
            let open = menu_for.as_deref() == Some(tool.qualified.as_str());
            let row = DetailTool {
                title: "Choice".into(),
                ..tool.clone()
            };
            body = body
                .child(section_label(format!("For {bot}"), theme))
                .child(card(theme).child(tool_row(
                    app,
                    &row,
                    changing.as_deref(),
                    open,
                    &bot,
                    theme,
                )));
        }
        // A read of the tools that failed: the label with its ⚠, and no line about it.
        if state.open_fault(crate::faults::Place::Tools).is_some() && model.tools.is_empty() {
            body = body.child(
                h_flex()
                    .w_full()
                    .items_center()
                    .rounded(px(6.))
                    .map(|row| {
                        crate::components::faults::ring(
                            row,
                            state.is_focused(crate::faults::Place::Tools),
                        )
                    })
                    .child(section_label("Tools", theme))
                    .child(div().flex_1())
                    .child(crate::components::faults::badge_element(
                        crate::faults::Place::Tools,
                        app.clone(),
                    )),
            );
        }
        if let Some(why) = model.tools_status.clone() {
            body = body.child(
                div()
                    .text_sm()
                    .text_color(theme.muted_foreground)
                    .child(why),
            );
        }
        if let Some(why) = state.tool_mode_refusal.clone() {
            body = body.child(div().text_sm().text_color(theme.danger).child(why));
        }
    }
    let list_card =
        |label: String, rows: Vec<(String, Option<String>)>, icon: Option<&'static str>| {
            let mut c = card(theme);
            for (i, (title, sub)) in rows.into_iter().enumerate() {
                c = c.child(
                    card_row(theme, i == 0)
                        .when_some(icon, |this, icon| {
                            this.child(
                                svg()
                                    .path(icon)
                                    .size(px(16.))
                                    .text_color(theme.muted_foreground),
                            )
                        })
                        .child(
                            v_flex()
                                .flex_1()
                                .child(div().text_base().child(title))
                                .when_some(sub, |this, sub| {
                                    this.child(
                                        div()
                                            .text_sm()
                                            .text_color(theme.muted_foreground)
                                            .child(sub),
                                    )
                                }),
                        ),
                );
            }
            v_flex()
                .gap(px(6.))
                .child(section_label(label, theme))
                .child(c)
        };
    if !model.skills.is_empty() {
        // Each skill: its own switch for the open Bot, and the row opens its page (7 Oct 2026).
        let name = plugin.clone().unwrap_or_default();
        let bot = state.active_bot_name();
        let mut c = card(theme);
        for (i, skill) in model.skills.iter().enumerate() {
            let row = state
                .plugin_skills
                .iter()
                .find(|r| r.plugin == name && &r.skill == skill);
            let open = app.clone();
            let (p, s) = (name.clone(), skill.clone());
            c = c.child(
                card_row(theme, i == 0)
                    .id(SharedString::from(plugin_skill_row_id(&name, skill)))
                    .debug_selector({
                        let id = plugin_skill_row_id(&name, skill);
                        move || id
                    })
                    .cursor_pointer()
                    .hover(|this| this.bg(theme.secondary))
                    .on_click(move |_, _, cx| {
                        let selection = PluginSelection::PluginSkill(p.clone(), s.clone());
                        open.update(cx, |state, cx| state.open_market_detail(selection, cx))
                    })
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .child(div().text_base().child(skill.clone()))
                            .when_some(
                                row.map(|r| r.description.clone()).filter(|d| !d.is_empty()),
                                |this, d| {
                                    this.child(
                                        div()
                                            .text_sm()
                                            .text_color(theme.muted_foreground)
                                            .whitespace_normal()
                                            .child(d),
                                    )
                                },
                            ),
                    )
                    .when_some(row.map(|r| r.on), |this, on| {
                        this.child(
                            div()
                                .flex_none()
                                .child(plugin_skill_switch(app, &name, skill, on, &bot)),
                        )
                    })
                    .child(
                        Icon::new(IconName::ChevronRight)
                            .size(px(14.))
                            .text_color(theme.muted_foreground),
                    ),
            );
        }
        body = body
            .child(section_label(
                format!("Skills  {}", model.skills.len()),
                theme,
            ))
            .child(c);
    }
    if !model.apps.is_empty() {
        body = body.child(list_card(
            format!("Apps  {}", model.apps.len()),
            model
                .apps
                .iter()
                .map(|a| (a.clone(), Some("Connector".to_string())))
                .collect(),
            Some("icons/plugins.svg"),
        ));
    }
    if !model.unsupported.is_empty() {
        body = body.child(list_card(
            "Not run by this server".into(),
            model
                .unsupported
                .iter()
                .map(|(n, why)| (n.clone(), Some(why.clone())))
                .collect(),
            None,
        ));
    }
    if !model.info.is_empty() {
        let mut c = card(theme);
        for (i, (label, value)) in model.info.iter().enumerate() {
            c = c.child(
                card_row(theme, i == 0)
                    .child(div().flex_1().text_base().child(*label))
                    .child(
                        div()
                            .text_base()
                            .text_color(theme.muted_foreground)
                            .child(value.clone()),
                    ),
            );
        }
        body = body.child(section_label("Information", theme)).child(c);
    }
    body.into_any_element()
}

/// A plugin skill's row on its plugin's page, and its switch for the open Bot.
pub(crate) fn plugin_skill_row_id(plugin: &str, skill: &str) -> String {
    format!("market-plugin-skill-row-{plugin}-{skill}")
}
pub(crate) fn plugin_skill_switch_id(plugin: &str, skill: &str) -> String {
    format!("market-plugin-skill-switch-{plugin}-{skill}")
}

fn plugin_skill_switch(
    app: &Entity<AppState>,
    plugin: &str,
    skill: &str,
    on: bool,
    bot: &str,
) -> Switch {
    let switch = app.clone();
    let (p, s) = (plugin.to_string(), skill.to_string());
    Switch::new(ElementId::Name(
        plugin_skill_switch_id(plugin, skill).into(),
    ))
    .checked(on)
    .small()
    .accessibility_label(format!("Use {plugin}.{skill} in {bot}"))
    .on_click(move |on, _, cx| {
        switch.update(cx, |state, cx| {
            state.set_plugin_skill(p.clone(), s.clone(), *on, cx)
        })
    })
}

/// One saved login's Bots: a switch per Bot of yours, on when that Bot may use the login. The
/// password is never shown or copied; a switch is a permission (8 Oct 2026).
fn login_bots_page(
    app: &Entity<AppState>,
    id: &str,
    back: Stateful<Div>,
    theme: &Theme,
    cx: &App,
) -> AnyElement {
    let state = app.read(cx);
    let login = state.site_logins.iter().find(|row| row.id == id);
    let mut body = v_flex()
        .id(DETAIL)
        .debug_selector(|| DETAIL.into())
        .w_full()
        .gap(px(12.))
        .child(back);
    let Some(login) = login else {
        return body
            .child(
                div()
                    .text_sm()
                    .text_color(theme.muted_foreground)
                    .child("This login is no longer saved."),
            )
            .into_any_element();
    };
    body = body.child(
        v_flex()
            .child(
                div()
                    .text_xl()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(login.origin.clone()),
            )
            .child(
                div()
                    .text_sm()
                    .text_color(theme.muted_foreground)
                    .child(login.username.clone()),
            ),
    );
    body = body.child(
        div()
            .text_sm()
            .text_color(theme.muted_foreground)
            .child("A Bot that is switched on can fill this login on its sign-in cards, after your Touch ID. It never sees the password."),
    );
    // Under the all-Bots switch every Bot has every login: one Bot's switch would change nothing.
    let all_bots = state.logins_for_all_bots == Some(true);
    if all_bots {
        body = body.child(div().text_sm().child(
            "Shared with all your Bots. Turn that off on the Logins page to choose Bot by Bot.",
        ));
    }
    let mut list = card(theme);
    let bots: Vec<_> = state.coworkers.iter().collect();
    for (i, bot) in bots.iter().enumerate() {
        let known = state.site_login_shares.get(&bot.id);
        let on = known.is_some_and(|ids| ids.contains(id));
        let switch = app.clone();
        let (login_id, bot_id) = (id.to_string(), bot.id.clone());
        list = list.child(
            card_row(theme, i == 0)
                .child(div().flex_1().text_base().child(bot.name.clone()))
                .child(
                    Switch::new(ElementId::Name(login_bot_switch_id(id, &bot.id).into()))
                        .checked(on)
                        .small()
                        .disabled(known.is_none() || all_bots)
                        .accessibility_label(format!("Let {} use this login", bot.name))
                        .on_click(move |on, _, cx| {
                            switch.update(cx, |state, cx| {
                                state.set_login_shared(login_id.clone(), bot_id.clone(), *on, cx)
                            })
                        }),
                ),
        );
    }
    body = body
        .child(section_label(format!("Bots  {}", bots.len()), theme))
        .child(list);
    if let Some(why) = state.tool_mode_refusal.clone() {
        body = body.child(div().text_sm().text_color(theme.danger).child(why));
    }
    body.into_any_element()
}

/// A plugin's skill, read-only: the plugin owns its text, so the page has the skill's switch for
/// the open Bot and nothing to edit or delete.
fn plugin_skill_page(
    app: &Entity<AppState>,
    plugin: &str,
    skill: &str,
    back: Stateful<Div>,
    theme: &Theme,
    cx: &App,
) -> AnyElement {
    let state = app.read(cx);
    let bot = state.active_bot_name();
    let page = state
        .plugin_skill_page
        .as_ref()
        .filter(|p| p.plugin == plugin && p.skill == skill);
    let mut body = v_flex()
        .id(DETAIL)
        .debug_selector(|| DETAIL.into())
        .w_full()
        .gap(px(12.))
        .child(back)
        .child(
            h_flex()
                .items_center()
                .gap(px(12.))
                .child(
                    v_flex()
                        .flex_1()
                        .child(
                            div()
                                .text_xl()
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(skill.to_string()),
                        )
                        .child(
                            div()
                                .text_sm()
                                .text_color(theme.muted_foreground)
                                .child(format!("From {plugin}")),
                        ),
                )
                .when_some(page.map(|p| p.on), |this, on| {
                    this.child(
                        h_flex()
                            .gap(px(6.))
                            .items_center()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(format!("Use in {bot}"))
                            .child(plugin_skill_switch(app, plugin, skill, on, &bot)),
                    )
                }),
        );
    let Some(page) = page else {
        let words = state
            .tool_mode_refusal
            .clone()
            .unwrap_or_else(|| "Loading…".to_string());
        return body
            .child(
                div()
                    .text_sm()
                    .text_color(theme.muted_foreground)
                    .child(words),
            )
            .into_any_element();
    };
    if !page.description.is_empty() {
        body = body.child(
            div()
                .text_base()
                .text_color(theme.muted_foreground)
                .child(page.description.clone()),
        );
    }
    if let Some(why) = state.tool_mode_refusal.clone() {
        body = body.child(div().text_sm().text_color(theme.danger).child(why));
    }
    body.child(section_label("Instructions", theme))
        .child(
            card(theme).child(
                div()
                    .p(px(12.))
                    .text_sm()
                    .font_family("Menlo")
                    .whitespace_normal()
                    .child(page.body.clone().unwrap_or_default()),
            ),
        )
        .into_any_element()
}

pub(crate) const SKILL_PUBLISH: &str = "market-skill-publish";
pub(crate) const SKILL_DELETE: &str = "market-skill-delete";
pub(crate) const SKILL_NAME: &str = "market-skill-name";
pub(crate) const SKILL_DESCRIPTION: &str = "market-skill-description";
pub(crate) const SKILL_INSTRUCTIONS: &str = "market-skill-instructions";
pub(crate) const SKILL_SAVE: &str = "market-skill-save";
pub(crate) const SKILL_NEW: &str = "market-skill-new";
pub(crate) const SKILL_BOTS: &str = "market-skill-bots";
pub(crate) const SKILL_ENABLED: &str = "market-skill-enabled";
pub(crate) const SKILL_REVERT: &str = "market-skill-revert";
pub(crate) const SKILL_DELETE_YES: &str = "market-skill-delete-yes";
pub(crate) const SKILL_DELETE_NO: &str = "market-skill-delete-no";
/// Why Publish is greyed out: the server has no route that shares a skill yet.
pub(crate) const PUBLISH_NOT_YET: &str = "Publishing is not on this server yet.";

/// One skill's page in the Plugins window. Your own skill: Publish ▾ in the header, its Name,
/// Description and Instructions to edit, and Delete Skill, Revert and Save in the pinned footer
/// (`skill_footer`). A skill you don't own (your org's, a pack's): its switch for the open Bot in the
/// header, and the same three read-only.
fn skill_page(
    app: &Entity<AppState>,
    id: &str,
    back: Stateful<Div>,
    inputs: &MarketInputs,
    theme: &Theme,
    cx: &App,
) -> AnyElement {
    let state = app.read(cx);
    let row = state.skills_card().and_then(|card| {
        crate::components::agent_settings::shown_skill_rows(&card)
            .into_iter()
            .find(|row| row.id == id)
    });
    let Some(row) = row else {
        // The Bot's skills not read yet (a skill just taught opens here at once), or gone.
        let words = if state.skills_card().is_none() {
            "Loading…"
        } else {
            "This skill is no longer in your library."
        };
        return v_flex()
            .id(DETAIL)
            .gap(px(12.))
            .child(back)
            .child(
                div()
                    .text_sm()
                    .text_color(theme.muted_foreground)
                    .child(words),
            )
            .into_any_element();
    };
    if state
        .skill_bots
        .as_ref()
        .is_some_and(|b| b.skill_id == id && b.open)
    {
        return skill_bots_view(app, id, theme, cx);
    }
    let detail = state
        .skill_open
        .as_ref()
        .filter(|detail| detail.skill.id == id);
    let edit = state.skill_edit.as_ref().filter(|edit| edit.id == id);
    let mine = row.mine;
    // "N Bots": the Bots that have this skill, which opens its Bots page, one switch per Bot,
    // as an account's does (7 Oct 2026).
    let skill_bots = state.skill_bots.as_ref().filter(|b| b.skill_id == id);
    let count = skill_bots.map(|b| {
        state
            .coworkers
            .iter()
            .filter(|bot| b.attached(&bot.id) == Some(true))
            .count()
    });
    let open_bots = app.clone();
    let counter = h_flex()
        .id(SKILL_BOTS)
        .debug_selector(|| SKILL_BOTS.into())
        .gap(px(6.))
        .items_center()
        .px(px(10.))
        .h(px(28.))
        .rounded(px(6.))
        .border_1()
        .border_color(theme.border)
        .text_sm()
        .text_color(theme.muted_foreground)
        .when(count.is_some(), |this| {
            this.cursor_pointer()
                .hover(|s| s.bg(theme.list_hover))
                .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                    open_bots.update(cx, |state, cx| state.open_skill_bots(true, cx))
                })
        })
        .child(
            svg()
                .path("icons/bot.svg")
                .size(px(14.))
                .text_color(theme.muted_foreground),
        )
        .child(match count {
            None => "… Bots".to_string(),
            Some(0) => "No Bots".to_string(),
            Some(n) => format!("{n} Bot{}", if n == 1 { "" } else { "s" }),
        });
    let header_right: AnyElement = h_flex()
        .gap(px(10.))
        .items_center()
        .child(counter)
        .when(mine, |this| {
            this.child(
                pill(SKILL_PUBLISH, "Publish ▾", false, theme, |_| {})
                    .tooltip(|window, cx| Tooltip::new(PUBLISH_NOT_YET).build(window, cx)),
            )
        })
        .into_any_element();
    let header = h_flex()
        .w_full()
        .gap(px(16.))
        .items_center()
        .child(tile(&row.title, 64., theme))
        .child(
            v_flex()
                .flex_1()
                .min_w(px(0.))
                .gap(px(2.))
                .child(
                    div()
                        .text_xl()
                        .font_weight(FontWeight::SEMIBOLD)
                        .truncate()
                        .child(row.title.clone()),
                )
                .child(
                    div()
                        .text_sm()
                        .text_color(theme.muted_foreground)
                        .child(if mine {
                            "Private skill"
                        } else {
                            "Your org's skill"
                        }),
                ),
        )
        .child(header_right);
    let mut body = v_flex()
        .id(DETAIL)
        .debug_selector(|| DETAIL.into())
        .w_full()
        .gap(px(12.))
        .child(back)
        .child(header);
    let description = detail
        .map(|d| d.skill.description.clone())
        .unwrap_or_else(|| row.first_line.clone());
    // Your own skill shows its description in its field below, and only there.
    if !description.is_empty() && !mine {
        body = body.child(
            div()
                .text_base()
                .text_color(theme.muted_foreground)
                .child(description),
        );
    }
    if let Some(note) = row.note.clone() {
        body = body.child(div().text_sm().text_color(theme.danger).child(note));
    }
    let Some(detail) = detail else {
        // A read that failed is "—" with the ⚠ beside it, and nothing about why.
        let fault = state.open_fault(crate::faults::Place::Skill).is_some();
        let words = state.skill_error.clone().unwrap_or_else(|| {
            if fault {
                crate::state::NOTHING_READ
            } else {
                "Loading…"
            }
            .to_string()
        });
        return body
            .child(
                h_flex()
                    .w_full()
                    .items_center()
                    .rounded(px(6.))
                    .map(|row| {
                        crate::components::faults::ring(
                            row,
                            state.is_focused(crate::faults::Place::Skill),
                        )
                    })
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme.muted_foreground)
                            .child(words),
                    )
                    .child(div().flex_1())
                    .when(fault, |row| {
                        row.child(crate::components::faults::badge_element(
                            crate::faults::Place::Skill,
                            app.clone(),
                        ))
                    }),
            )
            .into_any_element();
    };
    let label = |text: &'static str| {
        div()
            .pt(px(6.))
            .text_size(px(13.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(theme.muted_foreground)
            .child(text)
    };
    if mine {
        // The library's own switch: off, and no Bot may use it; a skill taught on screen starts
        // off until it has been read.
        let library = app.clone();
        let skill = id.to_string();
        body = body.child(section_label("Library", theme)).child(
            card(theme).child(
                card_row(theme, true)
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w(px(0.))
                            .child(div().text_base().child("Switched on"))
                            .child(div().text_xs().text_color(theme.muted_foreground).child(
                                "Off, no Bot may use it. A skill taught on screen starts off \
                                 until you have read it.",
                            )),
                    )
                    .child(
                        Switch::new(ElementId::Name(SKILL_ENABLED.into()))
                            .checked(detail.skill.enabled)
                            .disabled(state.skill_enabling.is_some())
                            .accessibility_label("Switched on")
                            .on_click(move |on, _, cx| {
                                library.update(cx, |state, cx| {
                                    state.set_skill_enabled(skill.clone(), *on, cx);
                                    state.refresh_coworker_skills(cx);
                                })
                            }),
                    ),
            ),
        );
    }
    match (mine, inputs.skill) {
        (true, Some((name, description, instructions))) => {
            body = body
                .child(label("Name"))
                .child(
                    div()
                        .id(SKILL_NAME)
                        .debug_selector(|| SKILL_NAME.into())
                        .child(field_input(name)),
                )
                .child(label("Description"))
                .child(
                    div()
                        .id(SKILL_DESCRIPTION)
                        .debug_selector(|| SKILL_DESCRIPTION.into())
                        .child(field_input(description)),
                )
                .child(label("Instructions"))
                .child(
                    div()
                        .id(SKILL_INSTRUCTIONS)
                        .debug_selector(|| SKILL_INSTRUCTIONS.into())
                        .w_full()
                        .child(
                            gpui_kit::component::input::Textarea::new(instructions)
                                .appearance(false)
                                .w_full()
                                .rounded(px(12.))
                                .border_1()
                                .border_color(theme.input)
                                // One field style: white with a thin border, as Name and
                                // Description; markdown in monospace.
                                .bg(theme.background)
                                .font_family("Menlo")
                                .text_sm(),
                        ),
                );
            if let Some(why) = edit.and_then(|e| e.refusal.clone()) {
                body = body.child(div().text_sm().text_color(theme.danger).child(why));
            }
        }
        _ => {
            // Read-only: what the Bot reads, as the server holds it.
            let read_only = |text: String| {
                div()
                    .w_full()
                    .px(px(14.))
                    .py(px(10.))
                    .rounded(px(12.))
                    .bg(theme.secondary)
                    .text_base()
                    .child(text)
            };
            body = body
                .child(label("Name"))
                .child(read_only(detail.skill.name.clone()).id(SKILL_NAME))
                .child(label("Description"))
                .child(read_only(detail.skill.description.clone()).id(SKILL_DESCRIPTION))
                .child(label("Instructions"))
                .child(read_only(detail.body.clone()).id(SKILL_INSTRUCTIONS));
        }
    }
    body.into_any_element()
}

/// Whether `name` can be a skill's name: what is typed after the slash, lowercase letters,
/// digits, dots and dashes, not starting or ending with a dot or a dash.
pub(crate) fn skill_name_ok(name: &str) -> bool {
    let name = name.trim();
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
        && !name.starts_with(['.', '-'])
        && !name.ends_with(['.', '-'])
}

pub(crate) const NEW_SKILL_NAME: &str = "market-new-skill-name";
pub(crate) const NEW_SKILL_DESCRIPTION: &str = "market-new-skill-description";
pub(crate) const NEW_SKILL_INSTRUCTIONS: &str = "market-new-skill-instructions";
pub(crate) const NEW_SKILL_UPLOAD: &str = "market-new-skill-upload";
pub(crate) const NEW_SKILL_CANCEL: &str = "market-new-skill-cancel";
pub(crate) const NEW_SKILL_CREATE: &str = "market-new-skill-create";

/// "+ New skill": the skill page, before the skill exists, in the same card as every other page.
/// The tile takes the name's first letter once one is typed; the switch and Publish come with
/// the skill, after Create.
fn new_skill_page(
    inputs: Option<&crate::components::skills::AddSheetInputs>,
    theme: &Theme,
    cx: &App,
) -> AnyElement {
    let Some(inputs) = inputs else {
        return div().id(DETAIL).into_any_element();
    };
    let typed = inputs.name.read(cx).value().trim().to_string();
    let title = if typed.is_empty() {
        "New skill".to_string()
    } else {
        typed.clone()
    };
    let tile_el = if typed.is_empty() {
        div()
            .flex_shrink_0()
            .size(px(64.))
            .rounded(px(15.))
            .border_1()
            .border_dashed()
            .border_color(theme.border)
            .flex()
            .items_center()
            .justify_center()
            .text_color(theme.muted_foreground)
            .text_size(px(26.))
            .child("+")
    } else {
        tile(&typed, 64., theme)
    };
    let label = |text: &'static str| {
        div()
            .pt(px(6.))
            .text_size(px(13.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(theme.muted_foreground)
            .child(text)
    };
    let name_ok = typed.is_empty() || skill_name_ok(&typed);
    v_flex()
        .id(DETAIL)
        .debug_selector(|| DETAIL.into())
        .w_full()
        .gap(px(12.))
        .child(
            h_flex()
                .w_full()
                .gap(px(16.))
                .items_center()
                .child(tile_el)
                .child(
                    v_flex()
                        .flex_1()
                        .min_w(px(0.))
                        .gap(px(2.))
                        .child(
                            div()
                                .text_xl()
                                .font_weight(FontWeight::SEMIBOLD)
                                .when(typed.is_empty(), |this| {
                                    this.text_color(theme.muted_foreground)
                                })
                                .truncate()
                                .child(title),
                        )
                        .child(
                            div()
                                .text_sm()
                                .text_color(theme.muted_foreground)
                                .child("Private skill · not created yet"),
                        ),
                ),
        )
        .child(div().text_sm().text_color(theme.muted_foreground).child(
            "Instructions your Bot reads before it works. It reaches for one when the \
             description fits what it was asked to do.",
        ))
        .child(label("Name"))
        .child(
            div()
                .id(NEW_SKILL_NAME)
                .debug_selector(|| NEW_SKILL_NAME.into())
                .child(
                    field_input(&inputs.name)
                        .prefix(div().text_color(theme.muted_foreground).child("/")),
                ),
        )
        .child(
            div()
                .px(px(4.))
                .text_xs()
                .text_color(if name_ok {
                    theme.muted_foreground
                } else {
                    theme.danger
                })
                .child("Lowercase letters, digits, dots and dashes — it is typed after a slash."),
        )
        .child(label("Description"))
        .child(
            div()
                .id(NEW_SKILL_DESCRIPTION)
                .debug_selector(|| NEW_SKILL_DESCRIPTION.into())
                .child(field_input(&inputs.description)),
        )
        .child(label("Instructions"))
        .child(
            div()
                .id(NEW_SKILL_INSTRUCTIONS)
                .debug_selector(|| NEW_SKILL_INSTRUCTIONS.into())
                .w_full()
                .child(
                    gpui_kit::component::input::Textarea::new(&inputs.body)
                        .appearance(false)
                        .w_full()
                        .rounded(px(12.))
                        .border_1()
                        .border_color(theme.input)
                        .bg(theme.background)
                        .font_family("Menlo")
                        .text_sm(),
                ),
        )
        .into_any_element()
}

/// The New skill page's pinned footer: Upload SKILL.md… on the left, where an existing skill
/// has Delete; Cancel and a filled Create on the right, Create live once the name is valid and
/// there are instructions. A refusal is said here, left of Cancel, and the fields keep their
/// words.
pub(crate) fn new_skill_footer(
    app: &Entity<AppState>,
    inputs: Option<&crate::components::skills::AddSheetInputs>,
    theme: &Theme,
    cx: &App,
) -> Option<AnyElement> {
    let state = app.read(cx);
    let modal = state.monitor_modal.as_ref()?;
    if modal.selected != Some(PluginSelection::NewSkill) {
        return None;
    }
    let inputs = inputs?.clone();
    let name = inputs.name.read(cx).value().to_string();
    let body = inputs.body.read(cx).value().to_string();
    let saving = state.skill_saving;
    let ready = skill_name_ok(&name) && !body.trim().is_empty() && !saving;
    let refusal = state.skill_add_error.clone().or(state.skills_error.clone());
    let skills_fault = state.open_fault(crate::faults::Place::Skills).is_some();
    let (upload, cancel, create) = (app.clone(), app.clone(), app.clone());
    let create_button = pill(
        NEW_SKILL_CREATE,
        if saving { "Creating…" } else { "Create" },
        ready,
        theme,
        move |cx| {
            let (name, description, body) = (
                inputs.name.read(cx).value().to_string(),
                inputs.description.read(cx).value().to_string(),
                inputs.body.read(cx).value().to_string(),
            );
            create.update(cx, |state, cx| {
                state.create_skill(name, description, body, cx)
            })
        },
    )
    .when(ready, |this| {
        this.bg(theme.foreground).text_color(theme.background)
    })
    .when(!ready && !saving, |this| {
        this.tooltip(|window, cx| Tooltip::new("Needs a name and instructions").build(window, cx))
    });
    Some(
        h_flex()
            .w_full()
            .flex_shrink_0()
            .h(px(56.))
            .px(px(32.))
            .gap(px(12.))
            .items_center()
            .border_t_1()
            .border_color(theme.border)
            .child(link(
                NEW_SKILL_UPLOAD,
                "Upload SKILL.md…",
                !saving,
                theme.muted_foreground,
                move |cx| upload.update(cx, |state, cx| state.pick_skill_upload(cx)),
            ))
            .child(
                div()
                    .flex_1()
                    .min_w(px(0.))
                    .text_xs()
                    .text_color(theme.danger)
                    .truncate()
                    .children(refusal),
            )
            .when(skills_fault, |row| {
                row.child(crate::components::faults::badge_element(
                    crate::faults::Place::Skills,
                    app.clone(),
                ))
            })
            .child(link(
                NEW_SKILL_CANCEL,
                "Cancel",
                !saving,
                theme.muted_foreground,
                move |cx| cancel.update(cx, |state, cx| state.close_market_detail(cx)),
            ))
            .child(create_button)
            .into_any_element(),
    )
}

/// The Bots page's title, in the window's bar: "Bots using <account>".
pub(crate) fn bots_title(state: &AppState, account: &str) -> String {
    let label = state
        .connections
        .own_rows()
        .into_iter()
        .find(|r| r.id == account)
        .map(|r| state.connections.shown_label(r))
        .unwrap_or_default();
    format!("Bots using {label}")
}

/// A list page's title in the bar: the window's own name on its first page.
pub(crate) fn list_title(modal: &MonitorModal) -> String {
    match &modal.page {
        MarketPage::Browse
            if modal.kind == crate::components::monitor_modal::MonitorKind::Tools =>
        {
            "Tools".into()
        }
        MarketPage::Browse => "Plugins".into(),
        MarketPage::Installed => "Installed".into(),
        MarketPage::Logins => "Logins".into(),
        MarketPage::Category(category) => category_title(category),
    }
}

/// What a page is called in the pinned bar once its own heading has scrolled out of sight.
pub(crate) fn page_title(state: &AppState, selection: &PluginSelection) -> Option<String> {
    match selection {
        PluginSelection::NewSkill => Some("New skill".into()),
        PluginSelection::PluginSkill(_, skill) => Some(skill.clone()),
        PluginSelection::Login(id) => state
            .site_logins
            .iter()
            .find(|row| &row.id == id)
            .map(|row| format!("{} · Bots", row.origin)),
        PluginSelection::Skill(id) => state.skills_card().and_then(|card| {
            crate::components::agent_settings::shown_skill_rows(&card)
                .into_iter()
                .find(|row| &row.id == id)
                .map(|row| row.title)
        }),
        other => detail(state, other).map(|d| d.title),
    }
}

/// A 32×32 icon button, the sidebar's size: an 18px glyph, a background on hover.
fn bar_button(
    id: &'static str,
    icon: IconName,
    theme: &Theme,
    on_click: impl Fn(&mut App) + 'static,
) -> Stateful<Div> {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .size(px(32.))
        .rounded(px(6.))
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .hover(|s| s.bg(theme.list_hover))
        .on_mouse_down(MouseButton::Left, move |_, _, cx| on_click(cx))
        .child(
            Icon::new(icon)
                .size(px(18.))
                .text_color(theme.foreground.opacity(0.8)),
        )
}

/// The window's top bar, pinned and the same on every page: Back on the left when there is
/// somewhere to go back to, the page's title, and Close on the right, all on one centre line,
/// 52px tall. The buttons' boxes start 8px outside the content edge so their glyphs sit on it.
/// What the bar's Back does on a page.
pub(crate) type BackAction = Box<dyn Fn(&mut App) + 'static>;

pub(crate) fn page_bar(
    app: &Entity<AppState>,
    back: Option<BackAction>,
    title: Option<String>,
    hairline: bool,
    theme: &Theme,
) -> AnyElement {
    let close = app.clone();
    h_flex()
        .w_full()
        .flex_shrink_0()
        .h(px(52.))
        .px(px(24.))
        .gap(px(8.))
        .items_center()
        .when(hairline, |this| {
            this.border_b_1().border_color(theme.border)
        })
        // With no Back, the title starts on the content edge, as the content below it does.
        .when(back.is_none(), |this| this.pl(px(32.)))
        .when_some(back, |this, back| {
            this.child(bar_button(
                crate::components::monitor_modal::BACK,
                IconName::ChevronLeft,
                theme,
                back,
            ))
        })
        .child(
            div()
                .flex_1()
                .min_w(px(0.))
                .text_size(px(17.))
                .font_weight(FontWeight::SEMIBOLD)
                .truncate()
                .children(title),
        )
        .child(bar_button(
            crate::components::monitor_modal::CLOSE,
            IconName::Close,
            theme,
            move |cx| close.update(cx, |state, cx| state.close_monitor_modal(cx)),
        ))
        .into_any_element()
}

/// Your own skill's pinned footer: Delete Skill on the left, away from Publish; Revert and Save
/// on the right, Save filled once something changed. `None` on any other page.
pub(crate) fn skill_footer(app: &Entity<AppState>, theme: &Theme, cx: &App) -> Option<AnyElement> {
    let state = app.read(cx);
    let modal = state.monitor_modal.as_ref()?;
    let PluginSelection::Skill(id) = modal.selected.as_ref()? else {
        return None;
    };
    let mine = state.skills_card().is_some_and(|card| {
        crate::components::agent_settings::shown_skill_rows(&card)
            .iter()
            .any(|row| &row.id == id && row.mine)
    });
    let detail = state.skill_open.as_ref().filter(|d| &d.skill.id == id)?;
    if !mine {
        return None;
    }
    let edit = state.skill_edit.as_ref().filter(|e| &e.id == id);
    let saving = edit.is_some_and(|e| e.saving);
    let changed = edit.is_some_and(|e| e.changed(detail));
    let (ask, revert, save) = (app.clone(), app.clone(), app.clone());
    let save_button = pill(
        SKILL_SAVE,
        if saving { "Saving…" } else { "Save" },
        changed && !saving,
        theme,
        move |cx| save.update(cx, |state, cx| state.save_skill_page(cx)),
    )
    .when(changed && !saving, |this| {
        this.bg(theme.foreground).text_color(theme.background)
    });
    Some(
        h_flex()
            .w_full()
            .flex_shrink_0()
            .h(px(56.))
            .px(px(32.))
            .items_center()
            .justify_between()
            .border_t_1()
            .border_color(theme.border)
            .child(link(
                SKILL_DELETE,
                "Delete Skill",
                !saving,
                theme.danger,
                move |cx| ask.update(cx, |state, cx| state.ask_skill_page_delete(true, cx)),
            ))
            .child(
                h_flex()
                    .gap(px(10.))
                    .items_center()
                    .child(link(
                        SKILL_REVERT,
                        "Revert",
                        changed && !saving,
                        theme.muted_foreground,
                        move |cx| revert.update(cx, |state, cx| state.revert_skill_page(cx)),
                    ))
                    .child(save_button),
            )
            .into_any_element(),
    )
}

/// A skill's Bots page: every Bot of the person's, its switch whether that Bot has the skill.
/// The title and Back are in the window's bar.
fn skill_bots_view(app: &Entity<AppState>, id: &str, theme: &Theme, cx: &App) -> AnyElement {
    let state = app.read(cx);
    let Some(sb) = state.skill_bots.as_ref().filter(|b| b.skill_id == id) else {
        return div().id(DETAIL).into_any_element();
    };
    let bots: Vec<_> = state.coworkers.iter().collect();
    let on = bots
        .iter()
        .filter(|b| sb.attached(&b.id) == Some(true))
        .count();
    let mut list = card(theme);
    for (i, bot) in bots.iter().enumerate() {
        let attached = sb.attached(&bot.id);
        let live = attached.is_some() && sb.changing.is_none();
        let toggle = app.clone();
        let bot_id = bot.id.clone();
        let element = format!("market-skill-bot-{}", bot.id);
        let sel = element.clone();
        list = list.child(
            card_row(theme, i == 0)
                .id(SharedString::from(element))
                .debug_selector(move || sel)
                .when(live, |this| this.cursor_pointer())
                .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                    if live {
                        let next = attached != Some(true);
                        toggle.update(cx, |state, cx| {
                            state.set_skill_bot(bot_id.clone(), next, cx)
                        });
                    }
                })
                .child(tile(&bot.name, 32., theme))
                .child(
                    div()
                        .flex_1()
                        .text_base()
                        .truncate()
                        .child(bot.name.clone()),
                )
                .child(
                    Switch::new(ElementId::Name(
                        format!("market-skill-bot-switch-{}", bot.id).into(),
                    ))
                    .checked(attached == Some(true))
                    .small()
                    .disabled(!live),
                ),
        );
    }
    v_flex()
        .id(DETAIL)
        .debug_selector(|| DETAIL.into())
        .w_full()
        .gap(px(12.))
        .child(
            div()
                .text_sm()
                .text_color(theme.muted_foreground)
                .child(format!("{on} of {} Bots have this skill", bots.len())),
        )
        .child(list)
        .children(
            sb.refusal
                .clone()
                .map(|why| div().text_sm().text_color(theme.danger).child(why)),
        )
        .into_any_element()
}

/// "Delete <skill>?" over your own skill's page: the skill leaves your library and every Bot.
pub(crate) fn skill_delete_dialog(
    app: &Entity<AppState>,
    theme: &Theme,
    cx: &App,
) -> Option<AnyElement> {
    let state = app.read(cx);
    let edit = state.skill_edit.as_ref().filter(|e| e.confirming_delete)?;
    let name = state
        .skill_open
        .as_ref()
        .filter(|d| d.skill.id == edit.id)
        .map(|d| d.skill.name.clone())
        .unwrap_or_else(|| "this skill".into());
    let (yes, no, cancel) = (app.clone(), app.clone(), app.clone());
    Some(
        div()
            .id("market-skill-delete-overlay")
            .absolute()
            .inset_0()
            .rounded(px(18.))
            .flex()
            .items_center()
            .justify_center()
            .bg(gpui::black().opacity(0.32))
            .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                cancel.update(cx, |state, cx| state.ask_skill_page_delete(false, cx))
            })
            .child(
                v_flex()
                    .w(px(420.))
                    .gap(px(10.))
                    .px(px(32.))
                    .py(px(18.))
                    .rounded(px(14.))
                    .border_1()
                    .border_color(theme.border)
                    .bg(theme.popover)
                    .shadow_lg()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child(format!("Delete {name}?")))
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child("It leaves your library, and every Bot using it loses it. This cannot be undone."),
                    )
                    .child(
                        h_flex()
                            .w_full()
                            .justify_end()
                            .items_center()
                            .gap(px(14.))
                            .child(link(SKILL_DELETE_NO, "Cancel", true, theme.muted_foreground, move |cx| {
                                no.update(cx, |state, cx| state.ask_skill_page_delete(false, cx))
                            }))
                            .child(danger_pill(SKILL_DELETE_YES, "Delete", true, theme, move |cx| {
                                yes.update(cx, |state, cx| state.confirm_skill_page_delete(cx))
                            })),
                    ),
            )
            .into_any_element(),
    )
}

/// An account's Bots: every Bot of the person's, filtered by name, each allowed or not to use the
/// account with one press. A list scales to many Bots where a switch per Bot in the account's row
/// did not.
fn bots_view(
    app: &Entity<AppState>,
    modal: &MonitorModal,
    account: &str,
    inputs: &MarketInputs,
    theme: &Theme,
    cx: &App,
) -> AnyElement {
    let state = app.read(cx);
    let rows = bot_rows(state, account, &modal.bots_query);
    let all = bot_rows(state, account, "");
    let allowed = all.iter().filter(|r| r.on).count();
    let mut body = v_flex()
        .id("market-bots")
        .debug_selector(|| "market-bots".into())
        .w_full()
        .gap(px(12.))
        .child(
            div()
                .text_sm()
                .text_color(theme.muted_foreground)
                .child(format!(
                    "{allowed} of {} Bots can use this account",
                    all.len()
                )),
        );
    if let Some(input) = inputs.bots {
        body = body.child(
            div()
                .id(BOTS_SEARCH)
                .debug_selector(|| BOTS_SEARCH.into())
                .child(
                    field_input(input)
                        .rounded_full()
                        .prefix(
                            Icon::new(IconName::Search)
                                .size(px(16.))
                                .text_color(theme.muted_foreground),
                        )
                        .cleanable(true),
                ),
        );
    }
    let mut list = card(theme);
    for (i, row) in rows.iter().enumerate() {
        let toggle = app.clone();
        let account = account.to_string();
        let bot = row.id.clone();
        let (on, live) = (row.on, row.live);
        let id = bot_row_id(&row.id);
        let sel = id.clone();
        list = list.child(
            card_row(theme, i == 0)
                .id(SharedString::from(id))
                .debug_selector(move || sel)
                .when(live, |this| this.cursor_pointer())
                .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                    if live {
                        toggle.update(cx, |state, cx| {
                            let row = state
                                .connections
                                .own_rows()
                                .into_iter()
                                .find(|r| r.id == account)
                                .map(|r| (r.kind, r.connector.clone()));
                            match row {
                                Some((ConnectionKind::Token | ConnectionKind::Mcp, connector)) => {
                                    state.pick_account_for(
                                        bot.clone(),
                                        connector,
                                        (!on).then(|| account.clone()),
                                        cx,
                                    )
                                }
                                _ => state.set_connection_lent_to(
                                    account.clone(),
                                    bot.clone(),
                                    !on,
                                    cx,
                                ),
                            }
                        });
                    }
                })
                .child(tile(&row.name, 32., theme))
                .child(
                    h_flex()
                        .flex_1()
                        .min_w(px(0.))
                        .gap(px(8.))
                        .items_center()
                        .child(div().text_base().truncate().child(row.name.clone()))
                        // The Bot that uses this account without asking.
                        .when(row.default, |this| {
                            this.child(
                                div()
                                    .px(px(6.))
                                    .py(px(1.))
                                    .rounded(px(5.))
                                    .border_1()
                                    .border_color(theme.border)
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child("Default"),
                            )
                        }),
                )
                // A switch, so where it stands shows; the row's press is the switch's.
                .child(
                    Switch::new(ElementId::Name(
                        format!("market-bot-switch-{}", row.id).into(),
                    ))
                    .checked(on)
                    .small()
                    .disabled(!live),
                ),
        );
        if let Some(note) = row.note.clone() {
            list = list.child(
                div()
                    .pb(px(8.))
                    .text_xs()
                    .text_color(theme.danger)
                    .child(note),
            );
        }
    }
    if rows.is_empty() {
        list = list.child(
            card_row(theme, true).child(div().text_sm().text_color(theme.muted_foreground).child(
                if all.is_empty() {
                    "You have no Bots yet."
                } else {
                    "No Bots match."
                },
            )),
        );
    }
    body.child(list).into_any_element()
}

/// The dialog an Uninstall or an account's Remove asks in, over the whole Plugins window, or
/// nothing while neither is being asked.
pub(crate) fn remove_dialog(
    app: &Entity<AppState>,
    modal: &MonitorModal,
    theme: &Theme,
    cx: &App,
) -> Option<AnyElement> {
    let state = app.read(cx);
    let selection = modal.selected.as_ref()?;
    let model = detail(state, selection)?;
    let question = model.question.clone()?;
    let yes = app.clone();
    let no = app.clone();
    let account = modal.removal.is_some();
    // A dialog over the detail, as "Use your network from ..." is (layout.rs), never a line
    // under the button: what it deletes cannot be undone (6 Oct 2026, the owner's call).
    let (title, line) = match question.split_once('\n') {
        Some((title, line)) => (title.to_string(), Some(line.to_string())),
        None => (question.clone(), None),
    };
    let cancel = app.clone();
    Some(
        div()
            .id("monitor-plugin-remove-overlay")
            .absolute()
            .inset_0()
            .rounded(px(18.))
            .flex()
            .items_center()
            .justify_center()
            .bg(gpui::black().opacity(0.32))
            .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                cancel.update(cx, |state, cx| {
                    if account {
                        state.ask_account_remove(None, cx)
                    } else {
                        state.ask_market_uninstall(false, cx)
                    }
                })
            })
            .child(
                v_flex()
                    .id("monitor-plugin-remove-question")
                    .debug_selector(|| "monitor-plugin-remove-question".into())
                    .w(px(420.))
                    .gap(px(10.))
                    .px(px(32.))
                    .py(px(18.))
                    .rounded(px(14.))
                    .border_1()
                    .border_color(theme.border)
                    .bg(theme.popover)
                    .shadow_lg()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(title),
                    )
                    .when_some(line, |this, line| {
                        this.child(
                            div()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child(line),
                        )
                    })
                    .child(
                        h_flex()
                            .w_full()
                            .justify_end()
                            .items_center()
                            .gap(px(14.))
                            .child(link(
                                if account { REMOVE_NO } else { UNINSTALL_NO },
                                "Cancel",
                                true,
                                theme.muted_foreground,
                                move |cx| {
                                    no.update(cx, |state, cx| {
                                        if account {
                                            state.ask_account_remove(None, cx)
                                        } else {
                                            state.ask_market_uninstall(false, cx)
                                        }
                                    })
                                },
                            ))
                            .child(danger_pill(
                                if account { REMOVE_YES } else { UNINSTALL_YES },
                                if account { "Remove" } else { "Uninstall" },
                                !modal.removing,
                                theme,
                                move |cx| {
                                    yes.update(cx, |state, cx| {
                                        if account {
                                            state.remove_monitor_plugin(cx)
                                        } else {
                                            state.uninstall_market_plugin(cx)
                                        }
                                    })
                                },
                            )),
                    ),
            )
            .into_any_element(),
    )
}

#[cfg(test)]
mod tests {
    use super::{MarketRow, PluginSelection, RowAction, all_rows, matched_spans, ranked};
    use crate::state::ConnectorList;

    /// A search puts the best answer first: an exact or starting name before a word deep in a
    /// description, "cua" finds the screen tool, and a row nothing answers is left out (7 Oct
    /// 2026: results kept the list's own order, so "comp" led with Shell).
    #[test]
    fn a_search_ranks_names_before_descriptions() {
        let tool = |name: &str, title: &str, description: &str| MarketRow {
            selection: PluginSelection::Tool(name.into()),
            title: title.into(),
            description: description.into(),
            category: None,
            action: RowAction::Switch {
                on: true,
                live: true,
            },
            icon: None,
            opens_page: false,
            mono: true,
        };
        let rows = vec![
            tool("shell", "shell", "Runs commands, compiles code"),
            tool("read_file", "read_file", "Reads a file"),
            tool("manage_computer", "Manage computer", "Starts and stops it"),
            tool("computer", "computer", "Sees the screen"),
        ];
        let names = |q: &str| -> Vec<String> {
            ranked(rows.clone(), q)
                .into_iter()
                .map(|r| r.title)
                .collect()
        };
        assert_eq!(names("comp"), ["computer", "Manage computer", "shell"]);
        assert_eq!(names("cua"), ["computer"]);
        assert_eq!(names("read"), ["read_file"]);
        assert!(names("zzz").is_empty());
        assert_eq!(
            matched_spans("Runs commands, compiles code", "comp"),
            vec![std::ops::Range { start: 15, end: 19 }]
        );
        assert_eq!(
            matched_spans("Manage Computer", "co comp"),
            vec![std::ops::Range { start: 7, end: 11 }]
        );
        assert!(matched_spans("shell", "comp").is_empty());
    }

    /// An installed plugin's token service is listed by `GET /connectors` beside the sign-in
    /// apps; it is the plugin's, so it is not offered a second time as an app of its own.
    #[test]
    fn a_plugins_own_service_is_not_listed_again_as_an_app() {
        let mut state = crate::components::monitor_modal::tests::catalog();
        state.connections.connectors = Some(ConnectorList::Listed(
            serde_json::from_value(serde_json::json!([
                {"name":"gmail", "label":"Gmail"},
                {"name":"cloudflare", "label":"Cloudflare", "plugin":"cloudflare", "authentication":"token"}
            ]))
            .unwrap(),
        ));
        let rows = all_rows(&state);
        assert!(
            rows.iter()
                .any(|r| r.selection == PluginSelection::Service("gmail".into()))
        );
        assert!(
            rows.iter()
                .all(|r| r.selection != PluginSelection::Service("cloudflare".into()))
        );
    }
}
