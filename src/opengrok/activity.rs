//! Live bot status, ported from OpenGrok `sand-activity.ts` + `agent-activity.ts`.
//! AG-UI events are the NativeChat input; the desktop paints the same facts from `/events`.

use serde_json::Value;

/// The label while a turn waits for the coworker's box to wake. The server sends a CUSTOM
/// `box-waking` frame right before the first box-bound tool of a turn starts a sleeping box, and
/// the footer turns it into "Waking {name}'s computer" (`bot_status_line`).
pub const WAKING_COMPUTER: &str = "Waking the computer";

/// The CUSTOM `name` the server sends before a turn wakes a sleeping box (opengrok-harness
/// `projection.rs` `box_waking`).
pub(crate) const BOX_WAKING: &str = "box-waking";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BotActivity {
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActivityTick {
    Set(BotActivity),
    Keep,
    Clear,
}

/// Per-call memory for the frames AG-UI splits: `TOOL_CALL_START` names the
/// tool but has no arguments, `TOOL_CALL_ARGS` has arguments but no name.
/// Fed every frame in order, each one labels correctly.
#[derive(Default)]
pub struct ToolCallTracker {
    names: std::collections::HashMap<String, String>,
    args: std::collections::HashMap<String, String>,
    /// Call ids as they first appeared: the maps say what each call was, this says in what order,
    /// which is what `deeds` needs to tell a turn's story.
    order: Vec<String>,
    /// The person's own messages, which a replay opens each run with (opengrok-server
    /// `agui/history.rs` `with_prompt_frames`). Only a message's opening names it as the
    /// person's, so the frames after it are known by its id.
    persons: super::gen_ui::PersonsText,
}

impl ToolCallTracker {
    /// The status one frame implies, given the frames before it.
    pub fn tick(&mut self, event: &Value) -> ActivityTick {
        // The person's words are the question, not the coworker writing: a run picked up by its
        // replay before the coworker has said anything is still Thinking.
        let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
        if kind.starts_with("TEXT_MESSAGE") && self.persons.is_persons(event) {
            return ActivityTick::Keep;
        }
        let call_id = event.get("toolCallId").and_then(Value::as_str);
        if let Some(id) = call_id {
            if !self.order.iter().any(|seen| seen == id) {
                self.order.push(id.to_string());
            }
            if let Some(name) = event.get("toolCallName").and_then(Value::as_str) {
                self.names.insert(id.to_string(), name.to_string());
            }
            if let Some(arguments) = event.get("arguments") {
                self.args.insert(id.to_string(), arguments.to_string());
            } else if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                self.args.entry(id.to_string()).or_default().push_str(delta);
            }
        }
        let args = call_id.and_then(|id| self.args.get(id)).map(String::as_str);
        let remembered = if event.get("toolCallName").is_none() {
            call_id.and_then(|id| self.names.get(id))
        } else {
            None
        };
        match remembered {
            Some(name) => {
                let mut named = event.clone();
                if let Some(object) = named.as_object_mut() {
                    object.insert("toolCallName".into(), name.clone().into());
                }
                activity_from_agui(&named, args)
            }
            None => activity_from_agui(event, args),
        }
    }

    /// What this turn did, each tool said once and in the order it was called.
    pub fn deeds(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for id in &self.order {
            let Some(name) = self.names.get(id) else {
                continue;
            };
            let Some(deed) = deed_from_tool(name, self.args.get(id).map(String::as_str)) else {
                continue;
            };
            if !out.contains(&deed) {
                out.push(deed);
            }
        }
        out
    }
}

/// Where a journaled run is right now: the last frame that set a status.
pub fn activity_from_replay(events: &[Value]) -> Option<BotActivity> {
    let mut tracker = ToolCallTracker::default();
    let mut current = None;
    for event in events {
        match tracker.tick(event) {
            ActivityTick::Keep => {}
            ActivityTick::Clear => current = None,
            ActivityTick::Set(activity) => current = Some(activity),
        }
    }
    current
}

/// What a journaled run did, for the turns rebuilt from the journal rather than watched live —
/// a run resumed after a permission card comes back this way.
pub fn deeds_from_replay(events: &[Value]) -> Vec<String> {
    let mut tracker = ToolCallTracker::default();
    for event in events {
        tracker.tick(event);
    }
    tracker.deeds()
}

/// How many deeds the stand-in names. A computer-use turn calls twenty tools; the transcript
/// wants a sentence, not a log.
const STANDIN_DEEDS: usize = 3;

/// The line a turn that acted but said nothing leaves in the transcript, e.g.
/// "[took a screenshot of my screen]". The coworker is shown its own transcript on every later
/// turn, so a wordless turn must still leave a memory of what it did.
pub fn tool_standin(deeds: &[String]) -> Option<String> {
    if deeds.is_empty() {
        return None;
    }
    let mut line = deeds
        .iter()
        .take(STANDIN_DEEDS)
        .cloned()
        .collect::<Vec<_>>()
        .join(", then ");
    if deeds.len() > STANDIN_DEEDS {
        line.push('…');
    }
    Some(format!("[{line}]"))
}

/// One tool call in the coworker's own voice, past tense, for the stand-in line. `describe_tool`
/// says what a call is doing now for the status strip; this says what it did, afterwards.
fn deed_from_tool(name: &str, args: Option<&str>) -> Option<String> {
    let parsed = args.and_then(|raw| serde_json::from_str::<Value>(raw).ok());
    let field = |key: &str| {
        parsed
            .as_ref()
            .and_then(|v| v.get(key).and_then(Value::as_str))
            .map(str::to_string)
    };
    let deed = match name {
        "" => return None,
        "Read" | "ExternalRead" | "BoxRead" | "readToolCall" | "read_file" => field("path")
            .as_deref()
            .and_then(file_basename)
            .map(|file| format!("read {file}"))
            .unwrap_or_else(|| "read a file".into()),
        "write_file" => field("path")
            .as_deref()
            .and_then(file_basename)
            .map(|file| format!("wrote {file}"))
            .unwrap_or_else(|| "wrote a file".into()),
        "WebSearch" | "webSearchToolCall" => "searched the web".into(),
        "WebFetch" | "webFetchToolCall" => "read a page on the web".into(),
        "GenerateImage" | "generateImageToolCall" => "made a picture".into(),
        "Shell" | "BoxShell" | "shellToolCall" | "ExternalShell" | "shell" => {
            "ran a shell command".into()
        }
        super::gen_ui::USER_MACHINE_SHELL => "ran a command on your computer".into(),
        super::gen_ui::USE_SKILL => field("name")
            .as_deref()
            .map(short_command)
            .filter(|name| !name.is_empty())
            .map(|name| format!("read the {name} skill"))
            .unwrap_or_else(|| "read a skill".into()),
        "run_recipe" => "ran a recipe".into(),
        super::gen_ui::RUN_ROUTINE => routine_named(parsed.as_ref())
            .map(|name| format!("ran the {name} routine"))
            .unwrap_or_else(|| "ran a routine".into()),
        "Computer" | "Screenshot" | "computerUseToolCall" => {
            "took a screenshot of my screen".into()
        }
        "computer" => match field("action").as_deref() {
            Some("type") => "typed on my screen".into(),
            Some("key") => "pressed a key on my screen".into(),
            Some("scroll") => "scrolled my screen".into(),
            Some("click" | "double_click" | "right_click" | "drag" | "move") => {
                "clicked on my screen".into()
            }
            _ => "took a screenshot of my screen".into(),
        },
        "open_url" => field("url")
            .map(|url| {
                let rest = url.split("://").nth(1).unwrap_or(&url).to_string();
                let host = rest.split('/').next().unwrap_or(&rest);
                format!("opened {host}")
            })
            .unwrap_or_else(|| "opened a page on my screen".into()),
        "request_user_form" | "request-user-form" | "user-form" => {
            "asked you to fill a form".into()
        }
        "form" | "show_form" | "show-form" | "render_form" | "render-form" => {
            "showed you a form".into()
        }
        "bar_chart" | "bar-chart" | "barchart" | "show_bar_chart" | "show-bar-chart"
        | "render_bar_chart" | "render-bar-chart" => "drew you a chart".into(),
        other if other.starts_with("office_") => office_deed(other, field("path").as_deref()),
        other => format!("used {other}"),
    };
    Some(deed)
}

/// The past-tense deed of an `office_*` call (opengrok-server `office_desk.rs`,
/// gol/betteroffice). `file` is the `path` basename; session verbs carry only an `odoc_`
/// handle nobody can read, so they say "a document".
fn office_deed(name: &str, file: Option<&str>) -> String {
    let file = || {
        file.map(|name| name.to_string())
            .unwrap_or_else(|| "a document".into())
    };
    match name.strip_prefix("office_").unwrap_or(name) {
        "files" => "looked for documents".into(),
        "create" => format!("created {}", file()),
        "open" => format!("opened {}", file()),
        "outline" => format!("read the outline of {}", file()),
        "grep" => format!("searched inside {}", file()),
        "read" | "cells" => format!("read {}", file()),
        "render" => format!("rendered {}", file()),
        "verify" => format!("checked {}", file()),
        "propose" | "propose_cells" => format!("drafted edits to {}", file()),
        "review" => format!("reviewed edits to {}", file()),
        "accept" => format!("applied edits to {}", file()),
        "reject" => format!("rejected edits to {}", file()),
        "export" => format!("exported {}", file()),
        "close" => format!("closed {}", file()),
        _ => "worked on a document".into(),
    }
}

/// The same call in the strip's present tense: "Creating report.docx".
fn office_label(name: &str, file: Option<&str>) -> String {
    let file = || {
        file.map(|name| name.to_string())
            .unwrap_or_else(|| "a document".into())
    };
    match name.strip_prefix("office_").unwrap_or(name) {
        "files" => "Looking for documents".into(),
        "create" => format!("Creating {}", file()),
        "open" => format!("Opening {}", file()),
        "outline" => format!("Reading the outline of {}", file()),
        "grep" => format!("Searching inside {}", file()),
        "read" | "cells" => format!("Reading {}", file()),
        "render" => format!("Rendering {}", file()),
        "verify" => format!("Checking {}", file()),
        "propose" | "propose_cells" => format!("Drafting edits to {}", file()),
        "review" => format!("Reviewing edits to {}", file()),
        "accept" => format!("Applying edits to {}", file()),
        "reject" => format!("Rejecting edits to {}", file()),
        "export" => format!("Exporting {}", file()),
        "close" => format!("Closing {}", file()),
        _ => "Working on a document".into(),
    }
}

pub fn activity_from_agui(event: &Value, tool_args: Option<&str>) -> ActivityTick {
    let Some(kind) = event.get("type").and_then(Value::as_str) else {
        return ActivityTick::Keep;
    };
    match kind {
        "RUN_STARTED"
        | "REASONING_START"
        | "REASONING_MESSAGE_START"
        | "REASONING_MESSAGE_CONTENT"
        | "REASONING_MESSAGE_CHUNK" => ActivityTick::Set(BotActivity {
            label: "Thinking".into(),
        }),
        "TEXT_MESSAGE_START" | "TEXT_MESSAGE_CONTENT" | "TEXT_MESSAGE_CHUNK" => {
            ActivityTick::Set(BotActivity {
                label: "Writing".into(),
            })
        }
        "TOOL_CALL_START" | "TOOL_CALL_ARGS" => {
            let name = event
                .get("toolCallName")
                .and_then(Value::as_str)
                .unwrap_or("");
            ActivityTick::Set(BotActivity {
                label: describe_tool(name, tool_args),
            })
        }
        "TOOL_CALL_END" => ActivityTick::Set(BotActivity {
            label: "Thinking".into(),
        }),
        "RUN_FINISHED" | "RUN_ERROR" => ActivityTick::Clear,
        "CUSTOM" => {
            if super::user_form::is_user_form_awaiting(event) {
                // A replayed park can carry its card's settlement (#139); a card that is
                // answered is not waiting on anyone.
                let settled = super::user_form::UserFormSpec::from_awaiting_event(event, None)
                    .is_some_and(|spec| !spec.is_unresolved() && !spec.live_computer_handoff());
                if settled {
                    ActivityTick::Clear
                } else {
                    ActivityTick::Set(BotActivity {
                        label: super::user_form::WAITING_FOR_YOU.into(),
                    })
                }
            } else if event.get("name").and_then(Value::as_str)
                == Some(super::gen_ui::RUN_AWAITING_APPROVAL)
            {
                ActivityTick::Set(BotActivity {
                    label: "Waiting for approval".into(),
                })
            } else if event.get("name").and_then(Value::as_str) == Some(BOX_WAKING) {
                ActivityTick::Set(BotActivity {
                    label: WAKING_COMPUTER.into(),
                })
            } else if super::user_form::is_user_form_event(
                event.get("name").and_then(Value::as_str).unwrap_or(""),
                event.get("value").unwrap_or(event),
            ) {
                let unresolved = super::user_form::UserFormSpec::from_custom_event(event)
                    .map(|spec| spec.is_unresolved())
                    .unwrap_or(true);
                if unresolved {
                    ActivityTick::Set(BotActivity {
                        label: super::user_form::WAITING_FOR_YOU.into(),
                    })
                } else {
                    // Settled: do not leave "Waiting for you" over the compact pill.
                    ActivityTick::Clear
                }
            } else {
                ActivityTick::Keep
            }
        }
        _ => ActivityTick::Keep,
    }
}

fn file_basename(path: &str) -> Option<&str> {
    path.split(['/', '\\']).rfind(|s| !s.is_empty())
}

/// First line of the command, cut so the status line stays one line.
fn short_command(command: &str) -> String {
    const MAX: usize = 48;
    let line = command.lines().next().unwrap_or("").trim();
    let mut out: String = line.chars().take(MAX).collect();
    if line.chars().count() > MAX || command.lines().nth(1).is_some() {
        out.push('…');
    }
    out
}

/// What a routine's id begins with on the server (`sched_` and a uuid, as `ScheduleId` mints it).
const ROUTINE_ID_PREFIX: &str = "sched_";

/// The routine a `run_routine` call is for, by the name the model wrote in its `routine`
/// argument, kept to one line: `None` when it wrote none, or wrote the routine's id, which
/// is not a name a person would know it by, or when what it wrote reads `«redacted»`. That is
/// what a call's step keeps of an id: a `sched_` and a uuid is one long run of key characters,
/// which the step hides by the approval card's rules (`gen_ui::step_arguments`), and the
/// placeholder names no routine.
fn routine_named(arguments: Option<&Value>) -> Option<String> {
    let routine = arguments?.get("routine")?.as_str()?.trim();
    let name = short_command(routine);
    let named = !name.is_empty()
        && !routine.starts_with(ROUTINE_ID_PREFIX)
        && routine != super::gen_ui::REDACTED;
    named.then_some(name)
}

/// What a call is doing, in a line: the status strip says it while the call runs, and the call's
/// step row in the reply says it afterwards.
pub(crate) fn describe_tool(name: &str, args: Option<&str>) -> String {
    let parsed = args.and_then(|raw| serde_json::from_str::<Value>(raw).ok());
    let path = parsed
        .as_ref()
        .and_then(|v| v.get("path").and_then(Value::as_str));
    let command = parsed
        .as_ref()
        .and_then(|v| v.get("command").and_then(Value::as_str));
    match name {
        // `read_file`, `write_file` and `shell` are opengrok-server's own names for the box's tools,
        // the ones every coworker is hired with; the capitalised names are the Grok Bot desktop
        // client's. A name with no arm here reads "Using <name>".
        "Read" | "ExternalRead" | "BoxRead" | "readToolCall" | "read_file" => path
            .and_then(file_basename)
            .map(|n| format!("Reading {n}"))
            .unwrap_or_else(|| "Reading file".into()),
        "write_file" => path
            .and_then(file_basename)
            .map(|n| format!("Writing {n}"))
            .unwrap_or_else(|| "Writing a file".into()),
        "WebSearch" | "webSearchToolCall" => "Searching the web".into(),
        "WebFetch" | "webFetchToolCall" => "Reading the web".into(),
        "GenerateImage" | "generateImageToolCall" => "Generating a photo".into(),
        "shell" | "Shell" | "BoxShell" | "shellToolCall" | "ExternalShell" => match command {
            Some(c) if c.contains('>') || c.contains("tee ") || c.contains("sed ") => {
                "Drafting the file".into()
            }
            Some(c) => format!("Running `{}`", short_command(c)),
            None => "Running commands".into(),
        },
        super::gen_ui::USER_MACHINE_SHELL => command
            .map(|c| format!("On your machine: {}", short_command(c)))
            .unwrap_or_else(|| "On your machine".into()),
        // A bot reading one of its attached skills (opengrok-server#270), by the skill's name,
        // which is what a person types after a slash for the same skill. Kept to a line, as a
        // command is: the model writes the name, and nothing holds it to the server's rules
        // until the server looks it up.
        super::gen_ui::USE_SKILL => parsed
            .as_ref()
            .and_then(|v| v.get("name").and_then(Value::as_str))
            .map(short_command)
            .filter(|name| !name.is_empty())
            .map(|name| format!("Reading the {name} skill"))
            .unwrap_or_else(|| "Reading a skill".into()),
        // A bot running one of its person's routines (opengrok-server #337, built in #342), by the
        // name the model wrote. The call's own result is `{runId, threadId}`, with no name in it,
        // and a routine's id says nothing to a person, so one named by its id is "a routine", and
        // so is one whose id its step keeps as `«redacted»`.
        super::gen_ui::RUN_ROUTINE => routine_named(parsed.as_ref())
            .map(|name| format!("Running the {name} routine"))
            .unwrap_or_else(|| "Running a routine".into()),
        "Computer" | "Screenshot" | "computerUseToolCall" => "On its computer".into(),
        "computer" => match parsed
            .as_ref()
            .and_then(|v| v.get("action").and_then(Value::as_str))
        {
            Some("screenshot") => "Looking at its screen".into(),
            Some("type") => "Typing on its computer".into(),
            Some("key") => "Pressing a key on its computer".into(),
            Some("scroll") => "Scrolling on its computer".into(),
            Some("click" | "double_click" | "right_click" | "drag" | "move") => {
                "Clicking on its computer".into()
            }
            _ => "On its computer".into(),
        },
        "open_url" => parsed
            .as_ref()
            .and_then(|v| v.get("url").and_then(Value::as_str))
            .and_then(|url| url.split("://").nth(1).or(Some(url)))
            .map(|rest| format!("Opening {}", rest.split('/').next().unwrap_or(rest)))
            .unwrap_or_else(|| "Opening a page on its computer".into()),
        "request_user_form" | "request-user-form" | "user-form" => {
            super::user_form::WAITING_FOR_YOU.into()
        }
        other if other.starts_with("office_") => office_label(other, path.and_then(file_basename)),
        "" => "Working".into(),
        other => format!("Using {other}"),
    }
}

/// A call's arguments as its opened step row shows them, by the tools [`describe_tool`] names:
/// a shell's command, a file tool's path and the skill a `use_skill` call reads, which are what
/// those calls mean, and any other call's arguments as JSON laid out to be read. Arguments that
/// do not parse — cut at the cap, or never JSON — are shown as they came. Nothing is decoded:
/// typed text the server has already kept off the wire reads `«redacted»` here as it does there.
pub(crate) fn describe_arguments(name: &str, args: &str) -> Option<String> {
    if args.trim().is_empty() {
        return None;
    }
    let Ok(parsed) = serde_json::from_str::<Value>(args) else {
        return Some(args.to_string());
    };
    let field = |key: &str| parsed.get(key).and_then(Value::as_str).map(str::to_string);
    let said = match name {
        "shell" | "Shell" | "BoxShell" | "shellToolCall" | "ExternalShell" => field("command"),
        super::gen_ui::USER_MACHINE_SHELL => field("command"),
        super::gen_ui::USE_SKILL => field("name"),
        "Read" | "ExternalRead" | "BoxRead" | "readToolCall" | "read_file" | "write_file" => {
            field("path")
        }
        // The session verbs carry `document` (an `odoc_` handle); the file verbs carry `path`.
        other if other.starts_with("office_") => field("path").or_else(|| field("document")),
        _ => None,
    };
    said.or_else(|| serde_json::to_string_pretty(&parsed).ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn thinking_and_writing() {
        let ev = json!({"type":"REASONING_MESSAGE_CONTENT","delta":"hmm"});
        assert_eq!(
            activity_from_agui(&ev, None),
            ActivityTick::Set(BotActivity {
                label: "Thinking".into()
            })
        );
        let ev = json!({"type":"TEXT_MESSAGE_CONTENT","delta":"Hi"});
        assert_eq!(
            activity_from_agui(&ev, None),
            ActivityTick::Set(BotActivity {
                label: "Writing".into()
            })
        );
        let ev = json!({"type":"RUN_FINISHED"});
        assert_eq!(activity_from_agui(&ev, None), ActivityTick::Clear);
    }

    /// The box's tools under the server's own names say what they do, not "Using shell": the
    /// command once its arguments are in, and a plain line before they are.
    #[test]
    fn the_servers_own_tool_names_say_what_they_do() {
        let label = |name: &str, args: Option<&str>| describe_tool(name, args);
        assert_eq!(
            label("shell", Some(r#"{"command":"cargo test"}"#)),
            "Running `cargo test`"
        );
        assert_eq!(label("shell", None), "Running commands");
        assert_eq!(
            label("read_file", Some(r#"{"path":"src/main.rs"}"#)),
            "Reading main.rs"
        );
        assert_eq!(
            label("write_file", Some(r#"{"path":"notes/todo.md"}"#)),
            "Writing todo.md"
        );
        assert_eq!(label("write_file", None), "Writing a file");
        for name in ["shell", "read_file", "write_file"] {
            assert!(!label(name, None).starts_with("Using "), "{name}");
        }
    }

    /// A bot reading one of its attached skills (opengrok-server#270) says which, in the status
    /// line and on its step, and a turn that did nothing else leaves that behind, not "Using
    /// use_skill". Before the name is in, or with none, it reads a skill; a name the model spread
    /// over lines or past the width of a line is kept to one.
    #[test]
    fn use_skill_says_which_skill_is_being_read() {
        let label = |args: Option<&str>| describe_tool("use_skill", args);
        assert_eq!(
            label(Some(r#"{"name":"triage"}"#)),
            "Reading the triage skill"
        );
        assert_eq!(label(None), "Reading a skill");
        assert_eq!(label(Some(r#"{"name":"  "}"#)), "Reading a skill");
        assert_eq!(label(Some(r#"{"skill":"triage"}"#)), "Reading a skill");
        let long = "x".repeat(80);
        let cut = label(Some(
            &json!({ "name": format!("{long}\nmore") }).to_string(),
        ));
        assert!(
            cut.starts_with("Reading the x") && cut.ends_with("… skill") && cut.len() < 80,
            "{cut}"
        );
        assert_eq!(
            describe_arguments("use_skill", r#"{"name":"triage"}"#).as_deref(),
            Some("triage"),
            "the opened step shows the skill, not the JSON around it"
        );

        let mut tracker = ToolCallTracker::default();
        tracker
            .tick(&json!({"type":"TOOL_CALL_START","toolCallId":"c1","toolCallName":"use_skill"}));
        tracker.tick(
            &json!({"type":"TOOL_CALL_ARGS","toolCallId":"c1","delta":r#"{"name":"triage"}"#}),
        );
        assert_eq!(
            tool_standin(&tracker.deeds()),
            Some("[read the triage skill]".into())
        );
        assert_eq!(
            deed_from_tool("use_skill", None).as_deref(),
            Some("read a skill")
        );
    }

    /// A bot running one of its person's routines (opengrok-server #337, built in #342:
    /// `run_routine`, by the routine's id or its name as `list_routines` gives it) says which, in
    /// the status line and on its step, and a turn that did nothing else leaves that behind, not
    /// "Using run_routine". A routine named by the name the model wrote is said by it; one named
    /// by its id, which is a `sched_` and a uuid and says nothing to a person, is "a routine", as
    /// is a call with no routine yet. A name the model spread over lines or past the width of a
    /// line is kept to one.
    #[test]
    fn run_routine_says_which_routine_is_being_run() {
        let label = |args: Option<&str>| describe_tool("run_routine", args);
        assert_eq!(
            label(Some(r#"{"routine":"Standup"}"#)),
            "Running the Standup routine"
        );
        let by_id = r#"{"routine":"sched_0199bb4e-0000-7000-8000-000000000005"}"#;
        assert_eq!(label(Some(by_id)), "Running a routine");
        assert_eq!(label(None), "Running a routine");
        assert_eq!(label(Some(r#"{"routine":"  "}"#)), "Running a routine");
        assert_eq!(label(Some(r#"{"name":"Standup"}"#)), "Running a routine");
        let long = "x".repeat(80);
        let cut = label(Some(
            &json!({ "routine": format!("{long}\nmore") }).to_string(),
        ));
        assert!(
            cut.starts_with("Running the x") && cut.ends_with("… routine") && cut.len() < 80,
            "{cut}"
        );

        let mut tracker = ToolCallTracker::default();
        tracker.tick(
            &json!({"type":"TOOL_CALL_START","toolCallId":"c1","toolCallName":"run_routine"}),
        );
        tracker.tick(
            &json!({"type":"TOOL_CALL_ARGS","toolCallId":"c1","delta":r#"{"routine":"Standup"}"#}),
        );
        assert_eq!(
            tool_standin(&tracker.deeds()),
            Some("[ran the Standup routine]".into())
        );
        assert_eq!(
            deed_from_tool("run_routine", Some(by_id)).as_deref(),
            Some("ran a routine")
        );
        assert_eq!(
            deed_from_tool("run_routine", None).as_deref(),
            Some("ran a routine")
        );
    }

    /// A routine named by its id reaches its step row as `«redacted»`: the id is a `sched_` and a
    /// uuid, one long run of key characters, and the step keeps a call's arguments by the approval
    /// card's rules, which hide anything shaped like a key (`gen_ui::step_arguments`, after
    /// opengrok-tools `review.rs` `looks_like_a_secret`). That placeholder is no routine's name: the
    /// row, the status line and the turn's stand-in say "a routine", as they do for the id itself,
    /// and never "the «redacted» routine".
    #[test]
    fn a_routine_whose_name_was_kept_off_the_step_reads_as_a_routine() {
        use super::super::gen_ui::{ChatPart, TurnAssembler};
        for hidden in [
            r#"{"routine":"«redacted»"}"#,
            r#"{"routine":" «redacted» "}"#,
        ] {
            assert_eq!(
                describe_tool("run_routine", Some(hidden)),
                "Running a routine"
            );
            assert_eq!(
                deed_from_tool("run_routine", Some(hidden)).as_deref(),
                Some("ran a routine")
            );
        }

        // The step row of the call the Bot made in the live run, by the routine's id.
        let mut turn = TurnAssembler::default();
        for frame in [
            json!({"type":"TOOL_CALL_START","toolCallId":"c1","toolCallName":"run_routine"}),
            json!({"type":"TOOL_CALL_ARGS","toolCallId":"c1",
                   "delta":r#"{"routine":"sched_0199bb4e-0000-7000-8000-000000000005"}"#}),
            json!({"type":"TOOL_CALL_END","toolCallId":"c1"}),
            json!({"type":"TOOL_CALL_RESULT","toolCallId":"c1","ok":true,
                   "content":r#"{"runId":"run_1","threadId":"sched_1"}"#}),
        ] {
            turn.push_event(&frame);
        }
        let (_, parts) = turn.snapshot();
        let step = parts
            .iter()
            .find_map(|part| match part {
                ChatPart::Step(step) => Some(step),
                _ => None,
            })
            .expect("the call's step");
        assert!(step.arguments.contains("«redacted»"), "{}", step.arguments);
        assert_eq!(step.label(), "Running a routine");
    }

    /// The same, from the frames the server sent for one `run_routine` call: the run the server
    /// replayed for
    /// `fixtures/wire/rest/GET__ag-ui_threads__thread_id_/200-a_bot_runs_a_routine_by_its_id_and_its_history_names_the_bot.json`,
    /// in which the Bot names the routine by its id. The status line says it runs a routine
    /// while the call is out, and a turn that did nothing else leaves "ran a routine" behind.
    #[test]
    fn a_run_routine_call_off_the_wire_reads_as_a_routine_being_run() {
        let path = format!(
            "{}/fixtures/wire/rest/GET__ag-ui_threads__thread_id_/200-a_bot_runs_a_routine_by_its_id_and_its_history_names_the_bot.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let fixture: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect(&path)).expect(&path);
        let events = fixture["body"]["runs"][0]["events"]
            .as_array()
            .expect("a run's frames");
        let mut tracker = ToolCallTracker::default();
        let mut said = Vec::new();
        for event in events {
            if let ActivityTick::Set(activity) = tracker.tick(event) {
                said.push(activity.label);
            }
        }
        assert!(
            said.iter().any(|label| label == "Running a routine"),
            "{said:?}"
        );
        assert!(
            said.iter().all(|label| !label.starts_with("Using ")),
            "{said:?}"
        );
        assert_eq!(tracker.deeds(), ["ran a routine"]);
    }

    /// The same, from the frames the server sent for one shell call: the start and the
    /// arguments of the `shell` call in the run the server replayed for
    /// `fixtures/wire/rest/GET__ag-ui_runs__run_id_/200-a_form_raised_after_an_answer_has_its_card_and_entry_id.json`.
    #[test]
    fn a_shell_call_off_the_wire_reads_as_the_command_it_runs() {
        let path = format!(
            "{}/fixtures/wire/rest/GET__ag-ui_runs__run_id_/200-a_form_raised_after_an_answer_has_its_card_and_entry_id.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let fixture: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect(&path)).expect(&path);
        let events = fixture["body"]["events"]
            .as_array()
            .expect("a replay's frames");
        let start = events
            .iter()
            .find(|frame| frame["type"] == "TOOL_CALL_START" && frame["toolCallName"] == "shell")
            .expect("the run opens a shell call");
        let args = events
            .iter()
            .find(|frame| {
                frame["type"] == "TOOL_CALL_ARGS" && frame["toolCallId"] == start["toolCallId"]
            })
            .expect("and sends its arguments");
        let mut tracker = ToolCallTracker::default();
        assert_eq!(
            tracker.tick(start),
            ActivityTick::Set(BotActivity {
                label: "Running commands".into()
            })
        );
        assert_eq!(
            tracker.tick(args),
            ActivityTick::Set(BotActivity {
                label: "Running `echo hi`".into()
            })
        );
    }

    #[test]
    fn read_and_shell_labels() {
        let ev = json!({"type":"TOOL_CALL_START","toolCallName":"Read"});
        assert_eq!(
            activity_from_agui(&ev, Some(r#"{"path":"/tmp/foo.rs"}"#)),
            ActivityTick::Set(BotActivity {
                label: "Reading foo.rs".into()
            })
        );
        let ev = json!({"type":"TOOL_CALL_START","toolCallName":"Shell"});
        assert_eq!(
            activity_from_agui(&ev, Some(r#"{"command":"cat > notes.md"}"#)),
            ActivityTick::Set(BotActivity {
                label: "Drafting the file".into()
            })
        );
        assert_eq!(
            activity_from_agui(&ev, Some(r#"{"command":"cargo test"}"#)),
            ActivityTick::Set(BotActivity {
                label: "Running `cargo test`".into()
            })
        );
        assert_eq!(
            activity_from_agui(&ev, None),
            ActivityTick::Set(BotActivity {
                label: "Running commands".into()
            })
        );
    }

    #[test]
    fn args_frame_is_labelled_by_the_name_from_its_start_frame() {
        let mut tracker = ToolCallTracker::default();
        let start = json!({"type":"TOOL_CALL_START","toolCallId":"c1","toolCallName":"Shell"});
        assert_eq!(
            tracker.tick(&start),
            ActivityTick::Set(BotActivity {
                label: "Running commands".into()
            })
        );
        let args = json!({"type":"TOOL_CALL_ARGS","toolCallId":"c1","delta":"{\"command\":\"cargo test\"}"});
        assert_eq!(
            tracker.tick(&args),
            ActivityTick::Set(BotActivity {
                label: "Running `cargo test`".into()
            })
        );
    }

    #[test]
    fn replay_status_is_the_last_frame_that_set_one() {
        let events = vec![
            json!({"type":"RUN_STARTED"}),
            json!({"type":"TOOL_CALL_START","toolCallId":"c1","toolCallName":"Shell"}),
            json!({"type":"TOOL_CALL_ARGS","toolCallId":"c1","arguments":{"command":"date"}}),
        ];
        assert_eq!(
            activity_from_replay(&events),
            Some(BotActivity {
                label: "Running `date`".into()
            })
        );
        let mut finished = events.clone();
        finished.push(json!({"type":"RUN_FINISHED"}));
        assert_eq!(activity_from_replay(&finished), None);
    }

    /// A replay opens each run with the person's own messages, right after `RUN_STARTED` and
    /// before anything the coworker said (opengrok-server `agui/history.rs` `with_prompt_frames`,
    /// recorded in `fixtures/wire/agui/TEXT_MESSAGE_START/a_fired_routine_reports_its_last_run_on_its_row.json`).
    /// They are the question, not the coworker writing: a run picked up by its replay before the
    /// coworker has said anything is still Thinking. Only a message's opening names it as the
    /// person's, so its words and its close are known by its id; a message of files alone, opened
    /// and closed on no words, moves nothing either.
    #[test]
    fn the_persons_own_message_in_a_replay_is_not_the_coworker_writing() {
        let asked = vec![
            json!({"type":"RUN_STARTED","runId":"r1"}),
            json!({"type":"TEXT_MESSAGE_START","messageId":"u1","role":"user"}),
            json!({"type":"TEXT_MESSAGE_CONTENT","messageId":"u1","delta":"What is on today?"}),
            json!({"type":"TEXT_MESSAGE_END","messageId":"u1"}),
            json!({"type":"TEXT_MESSAGE_START","messageId":"u2","role":"user"}),
            json!({"type":"TEXT_MESSAGE_END","messageId":"u2"}),
        ];
        assert_eq!(
            activity_from_replay(&asked),
            Some(BotActivity {
                label: "Thinking".into()
            })
        );
        let mut answering = asked.clone();
        answering.push(json!({"type":"TEXT_MESSAGE_START","messageId":"m1","role":"assistant"}));
        answering
            .push(json!({"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"Two meetings."}));
        assert_eq!(
            activity_from_replay(&answering),
            Some(BotActivity {
                label: "Writing".into()
            })
        );
    }

    #[test]
    fn screen_tools_say_what_the_bot_is_doing_on_its_computer() {
        let ev = json!({"type":"TOOL_CALL_START","toolCallName":"computer"});
        assert_eq!(
            activity_from_agui(&ev, Some(r#"{"action":"screenshot"}"#)),
            ActivityTick::Set(BotActivity {
                label: "Looking at its screen".into()
            })
        );
        assert_eq!(
            activity_from_agui(&ev, Some(r#"{"action":"click","coordinate":[1,2]}"#)),
            ActivityTick::Set(BotActivity {
                label: "Clicking on its computer".into()
            })
        );
        let ev = json!({"type":"TOOL_CALL_START","toolCallName":"open_url"});
        assert_eq!(
            activity_from_agui(&ev, Some(r#"{"url":"https://facebook.com/login"}"#)),
            ActivityTick::Set(BotActivity {
                label: "Opening facebook.com".into()
            })
        );
    }

    #[test]
    fn short_command_keeps_the_status_line_to_one_line() {
        assert_eq!(short_command("ls -la"), "ls -la");
        assert_eq!(short_command("  echo hi\nls"), "echo hi…");
        let long = "x".repeat(60);
        let cut = short_command(&long);
        assert_eq!(cut.chars().count(), 49);
        assert!(cut.ends_with('…'));
    }

    #[test]
    fn a_turn_that_only_looked_at_its_screen_leaves_that_behind() {
        let mut tracker = ToolCallTracker::default();
        tracker
            .tick(&json!({"type":"TOOL_CALL_START","toolCallId":"c1","toolCallName":"computer"}));
        tracker.tick(
            &json!({"type":"TOOL_CALL_ARGS","toolCallId":"c1","arguments":{"action":"screenshot"}}),
        );
        assert_eq!(
            tool_standin(&tracker.deeds()),
            Some("[took a screenshot of my screen]".into())
        );
    }

    #[test]
    fn a_turn_that_did_nothing_has_nothing_to_stand_in_for() {
        assert_eq!(tool_standin(&[]), None);
    }

    /// The stand-in tells the turn's story: every tool it called, in order, each said once, so a
    /// screen the bot looked at twenty times is still one clause.
    #[test]
    fn deeds_name_each_tool_once_and_in_the_order_it_was_called() {
        let events = vec![
            json!({"type":"TOOL_CALL_START","toolCallId":"c1","toolCallName":"open_url"}),
            json!({"type":"TOOL_CALL_ARGS","toolCallId":"c1","arguments":{"url":"https://example.com/login"}}),
            json!({"type":"TOOL_CALL_START","toolCallId":"c2","toolCallName":"computer"}),
            json!({"type":"TOOL_CALL_ARGS","toolCallId":"c2","arguments":{"action":"screenshot"}}),
            json!({"type":"TOOL_CALL_START","toolCallId":"c3","toolCallName":"computer"}),
            json!({"type":"TOOL_CALL_ARGS","toolCallId":"c3","arguments":{"action":"screenshot"}}),
        ];
        assert_eq!(
            tool_standin(&deeds_from_replay(&events)),
            Some("[opened example.com, then took a screenshot of my screen]".into())
        );
    }

    /// A turn that answered with a generative form and no words used to be written down as
    /// "[used form]" — the fallback for a tool nobody had named — which is what the thread
    /// showed for it ever after (Vamos, 21 Sep 2026). The stand-in says what the coworker did.
    #[test]
    fn a_generative_form_or_chart_is_remembered_as_shown_not_used() {
        let events = vec![
            json!({"type":"TOOL_CALL_START","toolCallId":"c1","toolCallName":"form"}),
            json!({"type":"TOOL_CALL_START","toolCallId":"c2","toolCallName":"bar_chart"}),
        ];
        assert_eq!(
            tool_standin(&deeds_from_replay(&events)),
            Some("[showed you a form, then drew you a chart]".into())
        );
    }

    /// The server says so with one frame before the first box-bound tool of a turn wakes a
    /// sleeping box; the footer must say what the wait is, not "working".
    #[test]
    fn a_box_being_woken_is_a_status() {
        let ev = json!({"type":"CUSTOM","name":"box-waking","coworkerId":"cw_1"});
        assert_eq!(
            activity_from_agui(&ev, None),
            ActivityTick::Set(BotActivity {
                label: WAKING_COMPUTER.into()
            })
        );
    }

    #[test]
    fn awaiting_approval_is_a_status() {
        let ev = json!({"type":"CUSTOM","name":"run-awaiting-approval"});
        assert_eq!(
            activity_from_agui(&ev, None),
            ActivityTick::Set(BotActivity {
                label: "Waiting for approval".into()
            })
        );
    }

    #[test]
    fn a_live_user_form_is_waiting_for_you_not_approval() {
        let ev = json!({
            "type": "CUSTOM",
            "name": "run-awaiting-approval",
            "runId": "run-1",
            "callId": "call-9",
            "tool": "request_user_form",
            "reason": "user-form",
            "why": "Waiting for you",
            "arguments": {
                "title": "Google account email",
                "fields": [{"id":"email","label":"Email","type":"email","required":true}]
            }
        });
        assert_eq!(
            activity_from_agui(&ev, None),
            ActivityTick::Set(BotActivity {
                label: "Waiting for you".into()
            })
        );
        let fixture = json!({
            "type": "CUSTOM",
            "name": "user-form",
            "value": {
                "entryId": "e1",
                "formRequest": {
                    "title": "Google account email",
                    "fields": [{"id":"email","label":"Email","type":"email","required":true}]
                }
            }
        });
        assert_eq!(
            activity_from_agui(&fixture, None),
            ActivityTick::Set(BotActivity {
                label: "Waiting for you".into()
            })
        );
        let settled = json!({
            "type": "CUSTOM",
            "name": "user-form",
            "value": { "entryId": "e1", "formResolution": "submitted" }
        });
        assert_eq!(activity_from_agui(&settled, None), ActivityTick::Clear);
        let tool = json!({"type":"TOOL_CALL_START","toolCallName":"request_user_form"});
        assert_eq!(
            activity_from_agui(&tool, None),
            ActivityTick::Set(BotActivity {
                label: "Waiting for you".into()
            })
        );
    }
}
