//! Opt-in gpui-agent control plane (feature `agent`).
//!
//! Start NativeChat with `GPUI_AGENT=1` (and a token, or
//! `GPUI_AGENT_INSECURE_NO_TOKEN=1`). The TCP thread posts onto a mailbox;
//! [`RootView`](crate::root::RootView) drains it on the UI thread.
//!
//! Stable ids: `app-window`, `sidebar`, `sidebar-chat-list`, `nav-new-chat`,
//! `nav-toggle-sidebar`, `session-{id}`, `footer-theme`, `footer-account`,
//! `header-left-sidebar` (restore the hidden sidebar; absent while it is visible),
//! `nav-toggle-sidebar` (hide the visible sidebar). Native right-click changes Mini/Expanded
//! without opening a menu; the `sidebar.mini` action remains available to keyboard automation.
//! `header-right-sidebar` (chat's window-level pane toggle),
//! `header-monitor` (computer pane toggle while a bot is open),
//! `header-notifications` (the bell, before the monitor while a Bot is open; value = the open
//! Bot's unread notices; `selected` while its page is open), its page `notifications-pane` with
//! `notifications-unread-count`, the toolbar's `notifications-select-all` (value none/some/all),
//! with nothing ticked `notifications-filter-all`, `notifications-filter-unread` (`selected` on the
//! active one), `notifications-mark-all-read`, `notifications-delete-all`, and with rows ticked
//! `notifications-selected-count`, `notifications-mark-read`, `notifications-mark-unread`,
//! `notifications-delete-selected` (the other set is refused); each row `notification-{id}`
//! (value read/unread; a click opens it, `expanded`, with `notification-details-{id}` = where in
//! the source it was caught) with `notification-select-{id}`, `notification-copy-{id}`,
//! `notification-read-toggle-{id}` and `notification-delete-{id}`; `notifications-undo-bar` and
//! `notifications-undo` after a delete; `notifications-empty`, or `notifications-empty-unread`
//! with `notifications-show-all`; the toast
//! `notification-toast` (named `<Bot> · <place>`) with `notification-toast-said`,
//! `notification-toast-close`, `notification-toast-copy` and `notification-toast-open`. Invokes
//! (all take `bot` as an id or a name, the open Bot by default, `none` for none): `notices.list
//! {bot?, last?=20, all?}` → JSON rows, `notices.get {id}` → one with `copyText`, `notices.count
//! {bot?|"all"}` → `{total, unread}`, `notices.fake {bot?, place?, said?, raw?}` (a made-up one,
//! toast and all), `notices.copy {id}` (clipboard, and the text back), `notices.dismiss`,
//! `notices.open {bot?}`, `notices.read {bot?}`, `notices.clear {bot}`, `notices.clear-all`.
//! A fault notice's row also has `notification-go-{id}` (🎯, value = its place word: opens the
//! Bot and the card, ringed, `fault-focus` = the place while it is) and `notification-report-{id}`
//! (🐞). Each place with an unread fault has its ⚠ `fault-{place}` (`fault-usage`, `fault-tools`,
//! `fault-models`, `fault-server`, …); a click opens `fault-window` (value `1 of N`) with
//! `fault-bot`, `fault-request`, `fault-status`, `fault-raised-at`, `fault-count`, `fault-raw`
//! (the whole text as its value), `fault-newer`, `fault-older`, `fault-copy`, `fault-report`,
//! `fault-mark-read` and `fault-close`. 🐞 opens `report-sheet` (named by the issue's title) with
//! `report-body` (the issue body exactly as GitHub gets it; or, when the first gate decides the
//! fault is not worth a report, `report-verdict` (its words, value `noise` or `your-side`) with
//! `report-anyway`), `report-include-text` (checked when
//! the failure's own text goes too), `report-cancel` and `report-open-github`, which opens the
//! person's browser: `report.link` returns that link (`{url, clipboard, fingerprint}`) without
//! opening it.
//! `header-coworker` (the chip at the top of the chat, while a bot is open: label = its name; a
//! click opens the bot's settings, or, with state `goes-home` in one of its routines' threads,
//! goes back to the bot's own chat),
//! `composer`, `composer-panel`, `composer-panel-search`, `composer-recipe-bar`,
//! `composer-skill` (the skill the next message is sent with, value = the id the turn names;
//! in the tree only while one is on the draft),
//! `transcript` (the chat's transcript, a scroll node: value `following` while it keeps the
//! newest row in view, `detached` once the person has scrolled back up. Any step toward older
//! messages detaches it, however small, and only the person makes it follow again: a step to
//! the very bottom, a drag of the scrollbar to its end, Jump to latest, or a message of their
//! own. No op scrolls it: gpui-agent has no scroll op and this host no scroll invoke, so a live
//! check scrolls with the trackpad or the wheel and asserts the value),
//! `events-stream` (never visible, nothing on screen says it: where the account's events stream
//! stands, value `connecting` / `connected` / `reconnecting` / `unavailable`, from a server before
//! opengrok-server #348, / `signed-out`; while it is `connected`, a run the server starts shows in
//! the open thread and the open routine's Run history by itself, hexuria/nativechat #171),
//! `image-thumb-{n}`, `lightbox`, `user-form-{key}`, `user-form-field-{key}-{id}`,
//! `user-form-continue-{key}`, `user-form-dismiss-{key}`, `user-form-screen-{key}`,
//! `user-form-pill-{key}`, `computer-handoff-{key}`,
//! `computer-handoff-takeover-{key}`, `computer-handoff-done-{key}`,
//! `computer-handoff-skip-{key}`,
//! `save-login-{entry}`, `save-login-save-{entry}`, `save-login-skip-{entry}`,
//! `plugin-needs-{message}` (a tagged plugin that needs a choice, an account or an install,
//! #360) holding `plugin-needs-use-{message}-{account}` (label = the account, value = how it was
//! added), `plugin-needs-remember-{message}`, `plugin-needs-open-{message}-{plugin}` and
//! `plugin-needs-again-{message}`, each disabled once the card is not the thread's last turn,
//! `user-form-use-saved-{key}-{login}` (one per saved account for the card's site; a sign-in
//! that asks for the name and the password on two pages is two cards, each with a row per
//! password login, and on the password page the login picked on the name page in that thread
//! is the first row), `user-form-saved-note-{key}`, `user-form-saved-clear-{key}` (Change, on
//! the password row, or on the name row of a name page), and where a saved login cannot be used
//! for the card's Bot (checked before Touch ID) `user-form-saved-blocked-{key}` (value = the
//! reason, `shared-computer` or `shared-bot`), `user-form-all-bots-{key}` (shares every saved
//! login with all the person's Bots; only where the computer is their Bots' alone),
//! `user-form-own-computer-{key}` (gives the Bot a computer of its own; not on a shared-bot
//! card) and `user-form-by-hand-{key}`,
//! `settings-tab-logins`, `settings-logins-search` (value = the query), `settings-login-add`,
//! `settings-login-import`, `settings-logins-notice`, `settings-logins-error`,
//! `settings-logins-empty`, `settings-logins-group-passwords|passkeys|codes|security` (a
//! section of the list, value = its count; the three kinds are always there until a search
//! leaves one empty, Security only while a row has a `Security:` note) with its rows
//! `settings-login-row-{id}` under it (a row with a `Security:` note is under its kind and
//! under Security, one id twice; the picked one has state `selected`),
//! `settings-login-code-{id}` (a row's live code and the seconds left, on the pane and in
//! the list), `settings-login-add-error` while the Add sheet shows one,
//! `settings-login-notes-save-{id}` (the button that files an edited note),
//! `settings-login-detail-{id}` (the picked row's pane: `settings-login-username-{id}`,
//! `settings-login-website-{id}`, `settings-login-where-{id}`, `settings-login-notes-{id}`
//! (value = the notes), `settings-login-last-used-{id}`, `settings-login-delete-{id}`),
//! `settings-login-add-sheet` while the Add sheet is up (`settings-login-add-title`,
//! `settings-login-add-username`, `settings-login-add-password`, `settings-login-add-website`,
//! `settings-login-add-notes`, `settings-login-add-save`, `settings-login-add-cancel`),
//! `coworker-{id}` (a sidebar row: value = the last thing said in the bot's thread, state
//! `listed` when that thread came from the server's list and not this Mac),
//! `approval-{call}` (title = the card's own, states = reason, thread, tool),
//! `reply-steps` (the newest coworker reply's steps, a list with value = how many; in the tree
//! only while it has any) with `step-{call_id}` under it (label = the step row's own words,
//! value `running` / `ok` / `failed`, state `expanded` while its row is open, and state
//! `took-{time}`, e.g. `took-1s`, while the end of its row says how long the call took: Settings
//! → Show turn timing on, and a call this Mac timed from its arguments' end to its answer, which
//! a replay, a call answered together with another and a call that waited on a person never
//! are; a click opens or shuts it, and an open step holds its "N steps" line open),
//! `reply-reasoning` (value = how many Thought rows that reply has, in the tree only while it has
//! any; state `expanded` while all are open; a click opens them all, or shuts them once they all
//! are), with `reply-thought-{n}` underneath (name = Thinking, state `took-{time}` when that
//! segment was timed). `reply-timing` is the plain total under that reply, value = `10s total`;
//! in the tree only while Show turn timing is on and the run sent a total in `run-timing`.
//! It has no children or expanded state, and refuses clicks: durations belong to action rows,
//! not a second breakdown under the total.
//! `recipe-run` (on the open recipe: value = the bot it plays on, disabled while it cannot run
//! or a run is going; invoke `recipe.run {bot?}`), `recipe-run-result` (value `running` / `ok`
//! / `failed` / `interrupted`), `recipe-error` (what the page says went wrong, e.g. a
//! refused Run), `recipe-history-runs` (value = count) with
//! `recipe-history-run-{runId}` (value = `running` / `finished` / `interrupted`, state `ok`),
//! `settings-computer-{machine}-exec` (a connected computer's local-exec mode, value `ask` /
//! `bypass` / `never`, state `this-mac`) with `settings-computer-{machine}-exec-ask|bypass|never`,
//! `settings-tab-computer` (each computer's card is below, with the relay's), where this Mac's
//! standing rules sit under its mode:
//! `settings-local-rules-allow|deny` (a list, value = its count; in the tree only while it has a
//! rule on it) with its rows `settings-local-rule-allow|deny-{n}` (counted from 0 in the
//! server's order, value = the command exactly; state `inert` on an allow the server says can
//! never match, with `settings-local-rule-inert-allow-{n}` saying so and the server's reason as
//! its value; state `removing` while its Remove is with the server), and under each row
//! `settings-local-rule-remove-allow|deny-{n}` (dead while removing) and
//! `settings-local-rule-error-allow|deny-{n}` (why its last Remove did not go through);
//! `settings-local-rules-empty` while there are none, `settings-local-rules-error` while they
//! could not be read. Nothing for a machine that is not this Mac.
//! `settings-local-exec-stopped` (on `settings-tab-computer`, label = the page's words for why
//! this Mac stopped running commands for the server by itself: enrolling it did not go through,
//! or the server turned it away again after it enrolled again; in the tree only until the next
//! sign-in starts it again).
//! `routine-new`, `routine-{id}`, `routine-{id}-active` (the editor's Active switch: label
//! `Active`, or `Paused` while it is off; checked while the routine runs on its own; a click
//! asks for the other way), `routine-{id}-trigger-schedule`,
//! `routine-{id}-trigger-webhook`, `routine-{id}-webhook-url`,
//! `routine-{id}-webhook-key`, `routine-{id}-rotate`, `routine-{id}-test` (Test run, on a
//! routine the server has; disabled, and a click refused in the editor's words, on a server that
//! cannot run a routine on demand), `routine-{id}-run-{runId}` (one Run history line: label `Test
//! run` / `Webhook` / `Schedule`, or `Run by <name>` for a run a Bot started with its
//! `run_routine` tool, named as the server called it then (opengrok-server #337, built in #342),
//! value `running` / `waiting` / `ok` / `error`; a click opens the routine's thread and brings
//! that run into view once the thread has it),
//! `routine-{id}-skipped-{atMs}` (a Run history line for a firing the server skipped because the
//! Bot's own plan could not answer, opengrok-server #316, by when it was due: label as a run's,
//! value = the server's sentence for why, e.g. "Skipped: your computer was off, so your plan
//! couldn't answer", state `skipped`; it started no run, so a click is refused and opens nothing),
//! `routine-{id}-delete`.
//! While a routine is open in the Computer pane, its four icons are under `computer-pane`, each
//! acting on that routine. The window draws them at the right of the Active switch's row, the
//! size of `header-monitor` and `header-right-sidebar`, and not in the title row above, which
//! keeps only the back control, the title and the window's toggles: `routine-history-toggle`
//! (label `Run history`, or `Back to the routine` with state `selected` while the panel shows the
//! Run history alone in place of the routine's fields), `routine-open-thread`, `routine-run-now`
//! and `routine-delete`; one that cannot act is disabled, with the reason as its value, and a
//! click on it is refused.
//! "When to run" on the open routine, under `computer-pane`: `routine-wake-add` (+, disabled
//! while the routine has its one wake, the server's limit until opengrok-server#315, with the
//! reason as its value), `routine-wake-{i}` (a wake: label = what sets it off, in words, times on
//! the routine's own clock, in the zone the server reads its line in, opengrok-server #316; value
//! = what hovering the line says, which is all the window shows of its zone: the IANA zone where
//! it is not this computer's, then when it next runs in the person's own time, where the line can
//! be read in that zone, this computer's own or UTC, e.g. `UTC · Next run: Sun 4 Oct at 4:00 PM
//! your time`; no value on a webhook, or where there is nothing to say) holding
//! `routine-wake-edit-{i}` (opens the wake editor on it; disabled on a schedule where the server
//! cannot change a routine) and `routine-wake-delete-{i}` (disabled: a routine keeps its only
//! wake). While the wake editor is open, `routine-wake-editor`
//! (value = the open tab's word) holds `routine-wake-tab-every|daily|weekly|monthly|webhook|cron`
//! (state `selected` on the open one; disabled where the routine's kind rules it out, since a
//! schedule never becomes a webhook nor a webhook a schedule) and the open tab's controls: on
//! Every, `routine-wake-every` (a textbox; `set_value` writes it) with `routine-wake-every-up|down`
//! and `routine-wake-unit-minutes|hours|days` (state `selected`); on Daily, Weekly and Monthly,
//! `routine-wake-hour` and `routine-wake-minute` (textboxes, on a 12-hour clock) with their
//! `-up|down` (the hour by one round the clock, the minute by five), `routine-wake-am|pm` (state
//! `selected`) and `routine-wake-month-{1..12}` (checkboxes; none checked is every month); on
//! Weekly, `routine-wake-day-{0..6}` (Sunday is 0); on Monthly, `routine-wake-date-{1..31}`; on
//! Cron, `routine-wake-cron` (a textbox: five fields) and `routine-wake-cron-note` (while its days
//! of the week are numbers: how they count, standard cron's way, 0 and 7 Sunday, since
//! opengrok-server #331). Under them
//! `routine-wake-summary` (label = what was picked, in words), `routine-wake-zone` (label `<zone>
//! time`, value = the IANA zone, only where the routine's zone is not this computer's),
//! `routine-wake-next` (when it would next run, in the person's own time; only where the line can
//! be read here in the routine's zone, this computer's own or UTC), `routine-wake-error` (why it
//! cannot be saved),
//! `routine-wake-save` (label `Save`, or `Done` on a webhook; disabled while there is an error)
//! and `routine-wake-cancel`.
//! A click on `routine-delete` or `routine-{id}-delete` asks first, as a person's does:
//! `routine-delete-prompt` (a dialog over the whole window, label `Delete "<name>"?`, value =
//! what deleting it does, e.g. "It stops running. Its past runs and conversation stay.") with
//! `routine-delete-cancel` and `routine-delete-confirm`, in the tree only while it asks. Escape
//! answers Cancel in the window. Invoke `routine.delete` deletes outright, without asking.
//! What an older server cannot do with a routine (one from before opengrok-server 18656e3), each
//! in the tree only while it is so, label = the editor's words: `routine-{id}-cant-change` (it
//! cannot change a routine once it is made: the fields are dead, and `routine.edit` is refused),
//! `routine-{id}-cant-run` (it cannot run one on demand), `routine-{id}-runs-unavailable` (in the
//! Run history's place: it cannot list a routine's runs) and `routine-{id}-unsaved` (label `Not
//! saved`, value = what the person typed that it did not keep, one `Label: value` line each).
//! `routine-error` (under `computer-pane`, while a routine's editor is open and shows one: its red
//! line, the last refusal in the server's words or what the server answered when it said
//! nothing; never `request failed`).
//! `routine-{id}-thread` (Open thread, on a routine the server has); on a routine's thread the
//! chat carries `chat-routine-thread` (the line centred under the bot chip: label the routine's
//! name, value `schedule` / `webhook`) and `chat-routine-instructions` (value = how many bubbles
//! are labelled as the routine's instruction). There is no Back link: the way back to the bot's
//! own chat is `header-coworker`, in state `goes-home` there. Invoke `routine.thread {id}` opens
//! it.
//! Invoke `routine.run {id}` is Test run; `routine.edit {id, name?, prompt?}` saves an edit the
//! way the editor does (a `PATCH` of what changed).
//!
//! A routine's `{id}` is the server's schedule id. The two trigger ids are in the tree only
//! while the routine has no trigger, and the webhook's three only while it has one, so
//! `assert --exists false` answers "this one already fires" and "this one is not a webhook".
//!
//! The Computer pane: `computer-pane`, with `computer-status` (label `<state>; screen: yes|no`,
//! `endpoint missing` or `unknown`) and, under it, `computer-error` while the pane says why the
//! server could not give the bot a computer, in place of "No computer yet" (label = the server's
//! words as the pane shows them, value = the server's code for it, e.g. `provider_error`; a
//! status that names a box has none, so `assert --exists false` is "a computer was given").
//! Beside it, only then, `computer-get` (Get a computer: asks the server again; dead while an
//! ask is with the server). The overview row is `computer-recipes`, `computer-plugins`,
//! `computer-tools`, `route-traffic-this-computer`, `network-policy`, `computer-update`,
//! `computer-reset`, in that order, for every computer whoever it is shared with (#175, R-A).
//! `route-traffic-this-computer` (a switch: the host-wide reroute, `PUT /ag-ui/host-settings`, so it
//! applies to all the person's computers) and `network-policy` (disabled until the server sends
//! a rule; otherwise this computer's own rule, `PUT /coworkers/{id}/computer/egress-policy`, which opens the dialog that
//! picks it, `network-policy-close` shutting it).
//! Tools and Plugins open `monitor-modal`, shut by `monitor-modal-close` or Escape. Tools uses
//! the existing `agent-ceiling-switch-{name}` controls. Plugins lists the person's connections
//! (`agent-connection-lend-{id}`) and private skills (`agent-skills-switch-{id}`); each name opens
//! `monitor-connection-detail-{id}` or `monitor-skill-detail-{id}`. The detail's fields are
//! `monitor-plugin-source`, `monitor-plugin-transport`, `monitor-plugin-url`, `monitor-plugin-tools`
//! and `monitor-plugin-accounts`. `monitor-plugin-back` returns to Installed. Remove asks first:
//! `monitor-plugin-remove`, then `monitor-plugin-remove-confirm` or `monitor-plugin-remove-cancel`.
//! `monitor-plugin-add-account` opens sign-in for another account. Each account has
//! `monitor-account-rename-{id}`, `monitor-account-label-{id}` while editing, and
//! `monitor-account-reconnect-{id}` for OAuth accounts. Enter saves; Escape cancels.
//! `monitor-account-pick-{id}` picks that account, and `monitor-account-ask` clears the pin.
//! Missing connector metadata is stated as missing until the catalog supplies it (#184).
//!
//! Files (#90): `composer-file-{i}` under `composer` (label = the file's name, value `uploading`
//! / `ready` / `failed`); `message-file-{artId}` on the chat page for each file a message in the
//! open thread carried (label = filename, value = the message id). Invoke `composer.attach --arg
//! path=/absolute/path` attaches a file, as picking it with the + would; it uploads at once, and a
//! relative path or a kind the server does not take is refused. `composer.detach --arg index=N`
//! takes `composer-file-N` off the draft, as its ✕ would.
//!
//! The draft's chips: `composer-chip-{i}` under `composer`, in order (label = what the chip reads
//! as, value `tool` / `recipe` / `workflow` / `skill`). A chip is one object in the field (#40):
//! one Backspace after it removes it whole.
//!
//! Choice cards (the server's `form` tool) in the open thread: `choice-{messageId}` (value
//! `open` / `answered` / `not-answered` / `dismissed`; state `keyboard` on the one card a letter
//! answers). While open: `choice-{messageId}-{field}-{option}` (value = its keycap letter on a
//! one-question card, where a click sends the answer; state `selected` when picked),
//! `choice-{messageId}-dismiss`, and `choice-{messageId}-submit` on a card of several questions.
//! Answered: `choice-{messageId}-answer` (label = what was sent, title aside). `key
//! choice-{messageId} <letter>` takes the caret out of the composer and presses the letter at
//! the window, the way a person does after clicking the card. Only the card in state `keyboard`
//! takes it; a letter aimed at any other card is refused. A card the bot followed with another
//! card is `not-answered`: only the newest card asks.
//!
//! In the bot's settings: `agent-usage` (value = the Usage card's line: what the paid keys
//! charged for what the bot used this month and across how many models, as `$0.42 this month · 3
//! models`, or why the app cannot say) and `agent-usage-show` (`Show`, only while the server
//! reported models some of which answered a request), which opens the Usage modal (#138,
//! hexuria/nativechat#174).
//!
//! The Usage modal, over the whole window while it is open: `usage-modal` (a dialog named `Usage`,
//! valued by the server's word for the window it is on, `24h`, `7d` or `month`), holding
//! `usage-close` (✕), the chips `usage-window-24h`, `usage-window-7d` and `usage-window-month`
//! (buttons named `24h`, `7d` and `Month`, state `selected` on the window it is on; a click asks
//! the server for that window, `GET /coworkers/{id}/usage?window=`, and the modal says it is
//! asking until it is answered; the one it is on is refused), then one `usage-row-{i}` per model
//! that answered a request in the window (named by the model, valued `12 requests · $0.40`, and
//! `$0.00` on the person's own subscription, which the server prices at nothing) and
//! `usage-total` (`Total (paid keys)`, valued by what the paid keys charged for them, which a
//! model priced at nothing adds nothing to); where there are no rows, `usage-status` says why
//! (`Asking the server…`, the server's words, or `No requests in this window.`), with no total;
//! and `usage-note` (`Replies on your own subscription aren't counted here.`). Escape, ✕ and a
//! press beside the modal shut it; Show opens it on `month`, with what the card read on show at
//! once.
//!
//! The Tools card, which the bot's settings no longer draw (hexuria/nativechat#174: it opens from
//! the agent monitor, #175, so the app's tree holds none of these ids until it does):
//! `agent-tools` (value = the Tools card's first line, what the server's
//! `GET /coworkers/{id}/tools` says the bot is offered on its next turn: `2 built in · 1 from
//! plugins`, `Asking the server…`, or why there is no list), `agent-ceiling` (value = `3 of 8
//! allowed`, or why there are no switches; in the tree once the server has answered), and
//! `agent-tools-toggle` (Show / Hide, only while there is something to show). The Tools window
//! itself is the marketplace layout (#359): `market-tool-item-{name}` per built-in tool or group
//! with its switch `agent-ceiling-switch-{name}`, `market-search` ("Search tools"), and on a
//! tool's page that switch in the header, a group's tools as `market-tool-{name}` with
//! `market-tool-mode-{name}` and `market-tool-switch-{name}`, and a lone tool's chip
//! `market-tool-mode-{name}`. Visible while the card is open: the card's own lines, `agent-ceiling-read-only` (the server's words for a 403:
//! every switch is dead), `agent-ceiling-wait` (why every switch is dead for now: another Bot's
//! switch, or a read of this Bot's ceiling, is with the server) and `agent-ceiling-note` (the
//! server's words about the last switch when no row is the one they are about, as a 409's "the
//! tools changed since you looked"); and one `agent-ceiling-switch-{name}` per row of the bot's
//! tool ceiling (opengrok-server#268): a switch named by the row's heading (the label the
//! server gives the row, as `Routines` for the routine tools' one row, `routines`, else its
//! name), value `builtin` /
//! `plugin`, `checked` where it stands (where it was asked to go while that is with the server),
//! enabled only while a click would send it, states `switching` and `unavailable`. Under it:
//! `agent-ceiling-why-{name}` (why the server cannot offer it now),
//! `agent-ceiling-connector-{name}` (the connection a plugin uses) and
//! `agent-ceiling-error-{name}` (the server's words for a switch it did not take, or that nobody
//! knows whether it did). Every id under a row has
//! its fixed word (`switch`, `why`, `connector`, `error`) before the row's name and the card's
//! own ids have none, so no plugin's name makes one id another's. A click moves a live switch the
//! other way and sends the whole ceiling at once, with the version it was read at; one at a time,
//! so every switch is refused while any is with the server or the ceiling is being read, and a
//! plugin the server no longer loads is refused going back on. Where the ceiling could not be
//! read (a server without the route, a Bot this person does not own), the card lists what the
//! next turn is offered instead, read-only: `agent-tool-{name}` (value `builtin` / `plugin`).
//!
//! The Skills card, likewise (it moves to the monitor's Plugins modal): `agent-skills` (value =
//! the Skills card's line: `2
//! attached · 1 switched off`, `None attached`, `Asking the server…`, or why there are no
//! switches, as "Only this Bot's owner can change its skills."), and `agent-skills-toggle` (Show
//! / Hide, only while there are skills to show). Visible while the card is open: the card's own
//! lines, `agent-skills-read-only` (the server's words for a 403: every switch is dead),
//! `agent-skills-wait` (another Bot's skill switch, or a read of this Bot's skills, is with the
//! server) and `agent-skills-note` (the server's words about the last switch when no skill is the
//! one they are about: a 409's "the skills changed since you looked", or the 422 over the cap on
//! attached skills); one `agent-skills-switch-{id}` per skill of the account's library the owner
//! may attach (opengrok-server#270), by the skill's id and never its name, since one of the
//! owner's skills and a colleague's can share a name: a switch named by the skill's name, value
//! `mine` / `org`, `checked` while attached (where it was asked to go while that is with the
//! server), enabled only while a click would send it, states `switching` and `switched-off`.
//! Under it: `agent-skills-off-{id}` (switched off in Settings → Skills) and
//! `agent-skills-error-{id}` (the server's words for a switch it did not take, or that nobody
//! knows whether it did). And `agent-skills-shared` ("People who use this Bot can read its
//! attached skills."), only on a Bot the roster says is shared with the owner's organization.
//! Every id under a skill has its fixed word (`switch`, `off`, `error`) before the skill's id and
//! the card's own ids have none, so no skill's id makes one id another's. A click attaches or
//! detaches at once, sending every attached skill's id with the version the skills were read at;
//! one at a time, so every switch is refused while any skill switch is with the server or the
//! skills are being read, and a skill switched off in Settings → Skills is refused being
//! attached, though it can always be detached. The Tools card's switches and these are apart:
//! neither waits on the other.
//!
//! The Bot's model picker, on the Model card in the Bot's settings, which is the one place a
//! Bot's model is picked: the composer has no chip for it, and no `model-*` id outside the card
//! is the picker's. `agent-model-card`, in the tree while a Bot is open, is a button named as the
//! picker reads in a line (`GPT-6 Luna · Medium ⚡`, the effort being the level the slider is on,
//! which is the model's own while the Bot chose none, and nothing for a model that lists no
//! levels: `Grok 4.7`) and valued by the model the Bot's next turn runs on, with its door's wire
//! word as a state (`gateway` / `local_proxy`), `fast` while ⚡ is on, and `expanded` while its
//! popover is open; a click opens or shuts the popover, only while the settings are open. The
//! popover, `agent-model-pop`, visible while open, holds, in the window's order,
//! `agent-model-fast` (a switch, checked while on; dead, with why as its value, where the list
//! holds no fast version of the model or the account's plan model answers for every Bot),
//! `agent-model-open-list` (named by the model; it opens the list) and `agent-model-reset` (↺:
//! the effort back to `inherit`, so the slider is on the model's own level, and ⚡ off, the model
//! left alone; live while there is something to put back); then `agent-model-effort`, a slider
//! whose stops are the levels of effort the model itself lists, low to high. Its thumb snaps to
//! those stops during a pointer drag. Its large pill and thumb preview the named effort above
//! the model; the highest supported stop has a violet gradient and bright flecks, whether named
//! Max or Ultra. Pointer changes are saved only on release. The slider is not in
//! the tree at all where the model lists none: it is named by the level it is on (the model's
//! own while the Bot chose none, and `Effort` where the model names none as its own) and valued
//! by that level's own word (`medium` while the Bot chose none and the model's own level is
//! Medium, and no value where no level is lit), so a driver can write back what it reads;
//! `set_value` takes the value of one of the model's own levels (`medium`, or `ultra` where the
//! model lists it) and refuses any other in words that name them, and on a model with no
//! levels it refuses that there is no slider; it is dead, with why, from a server that keeps no
//! effort, one from before opengrok-server#271. Last, `agent-model-effort-note`, a line, not a
//! control: after a pick of a model that has no such level as the Bot's effort was on, which
//! the pick put back on `inherit`, it says `GPT-6 Luna has no Ultra, so it's on Medium, its own
//! level.`, for as long as that model is on the card and nothing else is changed. The model's
//! levels and own level are `GET /models`' `efforts` and `ownEffort` (opengrok-server #342 (main
//! 2136ffc): `Model::entry` in `crates/opengrok-core/src/catalogue.rs`).
//! While the list shows, those give way to `agent-model-open-list` as the heading back (state
//! `expanded`), `agent-model-search` (the search box at the top of the list, a textbox valued by
//! what is typed: `set_value` writes it, `type` adds to it, `key` takes Backspace, Up, Down,
//! Tab, Space and Enter; arrows and Tab move its active option, and Enter picks it; Ctrl+P and
//! Ctrl+N are the other previous/next keys; it filters both groups at once, whatever the case, by
//! a model's name and its raw id, and the list opens with it empty) and `agent-model-list`
//! (always in the tree, valued by how many
//! models the search leaves, all of them while nothing is typed). The list holds what its window
//! draws: at most five models at a time, an `agent-model-row-{source}-{id}` each, by its door's
//! wire word and the id a pick pins with ⚡ off (valued by its door's word, state `selected` on
//! the one that answers, `active` on the temporary keyboard highlight and `fast` where the list
//! holds its fast twin; the active highlight is separate from the saved-model checkmark; a click
//! puts the Bot on
//! it, fast where ⚡ is on and it has a twin, and goes back to the controls), with an
//! `agent-model-group-{source}` heading over each group's first model in view, which is not one
//! of the five: `agent-model-group-local_proxy` is "Subscription", the person's own plan, and
//! `agent-model-group-gateway` is "Gateway", the server's paid keys. The window opens at the top,
//! so the first five models of the first group show, and the wheel scrolls it; a model out of
//! view, or one the search leaves out, is refused, and the search box brings it into view. Over
//! the window, while nothing is typed and a model answers, the list pins that model under an
//! `agent-model-group-current` heading ("Current"), as an `agent-model-row-current` (named,
//! valued, `selected` and `fast` as its row in the window is, which may be in view too; a click
//! on it picks the model it already is, and goes back to the controls); it is not one of the
//! five, and a search takes both away, as does a list with no model answering. The three pickers
//! pin the same way, under their own ids (`settings-new-bots-row-current`,
//! `settings-plan-fallback-group-current`, and so on). Then `agent-model-plan` (on a
//! server whose rows carry no `source`, while the account is on the person's plan: the account's
//! plan model, which answers for every Bot there; a line, not a row, which the search leaves or
//! takes away as it would a row), `agent-model-no-match` ("No model matches", while the search
//! leaves nothing of a list that has some), `agent-model-routines` (on a Bot whose own door is
//! the person's plan, whatever it is pinned to: the line saying its routines run on that plan,
//! and one due while the plan cannot answer is skipped (opengrok-server #334), or, while the
//! person switched the relay off and the plan goes by their computer, that they run on the
//! Relay-off fallback or, with none set, are skipped (opengrok-server #332 (PR #338 at
//! 66b9f7b)); a line, not a row) and `agent-model-note` (the server's word on why the list is
//! not fuller).
//! `agent-model-error` is the server's words for the last change it refused. Every change is
//! saved on the Bot at once, `source`, `model` and `effort` on `PATCH /coworkers/{id}`
//! (opengrok-server main d6f640e (#307, after #304), pin bf99845). Invoke `model.picker`,
//! `model.picker.open` and `model.picker.close` work the popover, and a click on
//! `agent-model-dismiss` shuts it.
//!
//! In the bot's settings: `agent-settings-error` is the pane's red line under the Description: a
//! refused save or pick, in the server's words. There is no Save: Name, Label and Description
//! save as they are left (or on Enter, in the two single-line ones), each alone and only if it
//! changed, on `PATCH /coworkers/{id}` (`name`, `title`, `role`), with "Saved" beside the field's
//! heading for a moment; a refusal keeps the words in the field. The fields have no ids of their
//! own.
//!
//! Accounts are signed in to, renamed and removed in the Plugins marketplace (the `market-*` ids
//! below); Settings has no Connections page. A connection is named by the server's id and a
//! service by the name `GET /connectors` lists it under, and only the person's own are shown: a
//! Bot's own sign-in, the whole server's, or a scope this app does not know is not theirs.
//!
//! The Plugins marketplace (#184), opened by `footer-plugins` (or `computer-plugins` from the
//! Computer pane) inside `monitor-modal`: `market-search` (a textbox; Up and Down move the
//! highlighted row, state `selected`, Enter opens its detail and never installs, Backspace
//! deletes), `market-installed` (value = how many are installed) and `market-back`, one list per
//! section (`market-section-<category>`, `market-section-apps`, `market-section-results`,
//! `market-section-installed`), a row per plugin or app (`market-plugin-<name>`,
//! `market-service-<connector>`; label = its name, value = its description) with its
//! `<row id>-add` (Add, Adding…, Added or Unavailable), `market-view-all-<category>`,
//! `market-status` and `market-empty`. On Installed, the person's private skills keep
//! `monitor-skill-detail-<id>` and `agent-skills-switch-<id>`. A detail is `market-detail`
//! (label = its name, value = its description) behind `monitor-plugin-back`, with
//! `market-source`, `market-detail-action` (Add / Uninstall, which asks first:
//! `market-uninstall-confirm` / `market-uninstall-cancel`), `market-detail-refusal`, a list per
//! service `market-accounts-<connector>` holding per account `monitor-account-row-<id>` (value
//! = Connected, or Needs Auth with why), `monitor-account-rename-<id>` (opens
//! `monitor-account-label-<id>` with `monitor-account-save` / `monitor-account-cancel`),
//! `monitor-account-reconnect-<id>` (a sign-in, or an MCP account at its plugin's own provider,
//! #364), `market-reopen-<attempt>` and `market-dismiss-<attempt>` for a waiting sign-in,
//! `market-replace-token-<id>`, `market-account-remove-<id>` (asks first:
//! `market-account-remove-confirm` / `market-account-remove-cancel`),
//! `market-account-bots-<id>` (opens the account's Bots: `market-bots-search`,
//! `market-bot-<coworker>` checked while allowed, `market-bots-back`),
//! `market-use-prompt-<name>` once the plugin has an account while the open Bot's switch is off
//! (`market-use-prompt-on-<name>` switches it on, `market-use-prompt-not-now-<name>`),
//! `market-add-account-<connector>` (a sign-in page, or `market-token-field` with
//! `market-token-save` / `market-token-cancel` / `market-token-refusal`; the field's value is
//! dots, never the token), `monitor-account-pick-<id>` and `monitor-account-ask`; then
//! `market-tools` (expands its servers and tools), `monitor-plugin-switch-<name>`,
//! `market-logins` (Plugins' first page: your saved logins, each row `market-login-<id>` with
//! its Bots count, opening that login's Bots page with `market-login-bot-<login>-<bot>`
//! switches, disabled while every login is shared with all Bots; the page itself has the
//! `market-logins-all-bots` switch, "Share with all my Bots"), `market-plugin-skill-row-<plugin>-<skill>` (opens the skill's read-only page, Back returns to
//! the plugin) with `market-plugin-skill-switch-<plugin>-<skill>` (on or off for the open Bot, on
//! the plugin's page and the skill's), `market-app-*`, `market-unsupported-*` and `market-info-*`.
//!
//! A Bot's Connections card: `agent-connections` (value = the card's second line: `1 of 2 lent to
//! this Bot`, `Asking the server…`, or why there is nothing to count), and per connection
//! `agent-connection-lend-{id}` (a switch, label = its label, value = its service, checked while
//! it shows as lent to this bot; a click asks for the other way; dead and `changing` while a
//! change is with the server) and `agent-connection-error-{id}` (why a lend or a revoke of it to
//! this bot did not go through; another bot's is on that bot's card); `agent-connections-note`,
//! the card's sentence that a lent connection reaches a plugin only once the bot is allowed it in
//! its Tools (opengrok-server#268).
//!
//! General, Settings' first page: `settings-tab-general` (named `General`; refused while Settings
//! is shut). While Settings is open on it, its first section, over Chat, is
//! `settings-default-models` (named `Default models`; a section, not a control), which holds
//! `settings-new-bots`: Default for new Bots, where a newly hired Bot starts (opengrok-server
//! #322, on main c0bb6ae: the account's `newBotDefault` on `/account/inference-source`), which was
//! on Relay and kept its ids. It is live only where the server's read carries that key, `null` or
//! not. Otherwise (state `unavailable`) it holds `settings-new-bots-unavailable` ("Coming soon:
//! the server can't keep a default for new Bots yet.") and `settings-new-bots-card`, the picker's
//! card (a button named `No model`, disabled; a click is refused with why). Live,
//! `settings-new-bots-card` is the Bot's card and popover, every part of `agent-model-*` above
//! as `settings-new-bots-*`: the card (named as the default reads in a line, `None` while none
//! is set, valued by its model; states its door's word, `fast`, `expanded`, and `saving` while a
//! change is with the server), `settings-new-bots-pop`, `-fast`, `-effort` (`set_value` the
//! value of one of the model's levels; not in the tree while none is set, which is no model and
//! so no levels), `-effort-note`, `-reset`, `-open-list`, `-search` (`set_value`, `type`, `key`
//! as the Bot's), `-list`, `-group-{source}`, `-row-{source}-{id}`, `-no-match`, `-note` and
//! `-error` (the server's words for a refused change, or that nobody knows whether one was kept:
//! in the popover while open, under the card while shut). Over the list's models,
//! `settings-new-bots-none` (`None`, valued `the server's default`, state `selected` while
//! none is set; a click takes the kept default away). While none is set ⚡ is dead and says
//! why (a default starts with a model), and the slider is not in the tree: no model, no
//! levels. Every pick is kept on the account at once, whole, as `PUT
//! /account/inference-source` `{kind, newBotDefault}` with the kind the server keeps (None
//! sends `null`), one at a time: every control that sends one is dead while one is out.
//! `settings-new-bots-dismiss` shuts the popover, as `agent-model-dismiss` shuts the Bot's.
//! All of it is refused off General, saying to open it with `settings-tab-general`.
//!
//! Under it in Default models, `settings-plan-fallback`: the Relay-off fallback, "When Relay is
//! off, Subscription Bots use", what a Bot on the person's plan answers with while the relay is
//! off (opengrok-server #332 (PR #338 at 66b9f7b): the account's `planFallback`, `{model,
//! effort}` or `null`, on `/account/inference-source`). It is live only where the server's read
//! carries that key, `null` or not. Otherwise (state
//! `unavailable`) it holds `settings-plan-fallback-unavailable` ("Coming soon: the server can't
//! keep a Relay-off fallback yet.") and `settings-plan-fallback-card`, disabled and refused with
//! why. Live, it is the Bot's card and popover under `settings-plan-fallback-*` as Default for new
//! Bots' are under `settings-new-bots-*` (`-card`, `-pop`, `-fast`, `-effort`, `-effort-note`,
//! `-reset`, `-open-list`, `-search`, `-list`, `-no-match`, `-note`, `-error`), over the Gateway
//! group alone: `settings-plan-fallback-group-gateway` and its rows,
//! `settings-plan-fallback-row-gateway-{id}`, and none of the plan's models. Over them,
//! `settings-plan-fallback-none` (`None`, valued `no fallback`, state `selected` while none is
//! set; a click takes the kept fallback away). Every pick is kept on the account at once, whole,
//! as `PUT /account/inference-source` `{kind, planFallback}` with the kind the server keeps (None
//! sends `null`), one change of the account's at a time. `settings-plan-fallback-dismiss` shuts
//! the popover. All of it is refused off General.
//!
//! Under Debug on General, `settings-show-turn-timing` (a switch named `Show turn timing`, checked
//! and valued `on` while each reply shows the phases of its run, `off` while it does not): a click
//! flips it, kept on this computer at once. Refused off General.
//!
//! Your computers, on Settings → Computer (`settings-tab-computer`; refused while Settings is shut):
//! one card for each computer the person has enrolled, from `GET /local-exec/daemon`, with its own
//! Relay your plan switch (opengrok-server #342 (main 2136ffc): each computer has its own switch,
//! and the account's `relayEnabled` is read from them, never sent). Settings → Relay is gone, with its tab `settings-tab-reply-source`, its section
//! `settings-reply-source`, its card `settings-relay`, `settings-relay-switch`,
//! `settings-relay-switch-error` and `settings-relay-status`: none is on the tree, and a click on
//! one of them (or on any other id of `settings-relay-*` or `settings-reply-source-*` that the
//! computer's card does not draw: the plan on the server's own machine, a relay model, a radio) is
//! refused saying where the relay moved. While Settings is open on Computer, each computer is
//! `settings-computer-{machine}` (a group named by the computer's label; states `online` or
//! `offline`, `this-computer` on the one the app is running on, found by the machine id this app
//! stored when it enrolled, and `unsaved` on that one while a change to its opencodex fields waits
//! for Save; the list is in the roster's order, this computer first). Under it:
//! `settings-computer-{machine}-relay` (a switch named `Relay your plan`, checked while the
//! computer's relay is on, or where a click is taking it while the server is asked, disabled then;
//! a click asks for the other way, from any computer's card, as one `PATCH
//! /local-exec/daemon/{machine}` of `{relayEnabled}`, and once that is kept the same for each older
//! enrolment of the computer that the list folds into its card under the same label (never a
//! revoked one, and nothing is said of one the server no longer knows), and is refused with why
//! while its last switch is with the server; turning one on also points the account's way at the relay, once,
//! when it is not that already, as `PUT /account/inference-source` `{kind, via: "mac"}` with the
//! kind the server keeps, one change of the account's at a time, and a computer going off moves no
//! way; nothing this app sends of the account's setting ever carries `relayEnabled`),
//! `settings-computer-{machine}-status` (label `Relaying`, `Not relaying`, `Not relaying: opencodex
//! isn't answering on this computer (<address>)` or `On, but asleep: it can't answer right now`;
//! value `relaying`, `not-relaying`, `opencodex-silent` or `asleep`: relaying while the computer's
//! relay is on and the server holds its stream, asleep while it is on, not relaying and the server
//! cannot reach the computer, which is never said of the computer the app is running on, and
//! `opencodex-silent` on that computer alone, while its relay is on and nothing answers where its
//! relay asks opencodex, the address saved or else where opencodex listens by default, which the
//! label names: the server starts every computer's relay on, so a computer offers to relay only
//! where opencodex answers, and asks again every twenty seconds and when the address or the key
//! is saved)
//! and `settings-computer-{machine}-error` (under the switch, in the tree only while it has
//! something to say: the server's words for a refused switch, which went back, that nobody knows
//! whether one was kept, or that the server can't switch a computer's relay yet, or the server's
//! words for a refused change of the account's way that the switch sent; a line, not a control).
//! A computer the server lists as revoked is left out of the list, as it always was, so nothing of
//! it can be switched. Another computer's switch can be moved from this window; only this
//! computer's relay is run by it (hexuria/nativechat #156, opengrok-server #292): the server asks
//! the computer that opened its relay stream last of those that are on, and there is nothing to
//! order. A relay the server switched off, from here or from another computer, stops, does not
//! reconnect and waits for this computer's own row to read on again.
//!
//! This computer's card alone also holds what its relay needs of this computer, which were
//! Settings → Relay's and keep their ids: `settings-relay-detail` (under its status: why it is not
//! relaying, state `trouble`, or that it is opening its stream, or how to take the relay back from
//! another NativeChat on this computer), `settings-relay-addr` (named `opencodex address`, value =
//! opencodex's address on this computer; `set_value` and `type` write it; an address not on this
//! computer is refused by Save with a hint, an emptied one goes back to the default),
//! `settings-relay-key` (named `opencodex key (kept in this computer's secure storage)`, never
//! valued: states `set` while the Keychain holds a key, `typed` while one waits for Save, `retype`
//! when one typed was dropped with the page; `set_value` writes the whole key),
//! `settings-relay-key-remove` (while a key is kept: `Remove key`, or `Keep key` with state
//! `picked`), `settings-reply-source-error` (a read that failed, state `trouble`, or what the
//! Keychain said when it did not keep a key), `settings-reply-source-hint` (what Save waits for: an
//! opencodex address on this computer) and `settings-relay-save` (Save, named `Save`, enabled only
//! while a click would keep something; `settings-reply-source-save`, its id on Settings → Relay, is
//! refused saying where it is now). Until the setting has been read, on a server without reply sources, or when
//! it could not be read, they are replaced by `settings-reply-source-unavailable`, the line the card
//! draws (`Asking the server…` while it has state `asking`); from a server without the relay, by
//! `settings-relay-unavailable` (that this server can't take replies from a computer yet) and the
//! line under Save. Save keeps opencodex's address and key on this computer and sends the server
//! nothing; the address and key are kept on this computer, the key in the Keychain, and never sent
//! to the server. Every control is refused off the page, before this computer is on the list, and
//! before the setting is read, and Save while a read is out, saying what it waits for. The tab's
//! pages are `settings-tab-general` (Default models, and the Relay-off fallback that Subscription
//! Bots answer with while Relay is off, "When Relay is off, Subscription Bots use": there, unmoved),
//! this one, `settings-tab-updates`, `settings-tab-logins` and
//! `settings-tab-skills`. Default for new Bots is General's, above.
//!
//! `reply-source-{messageId}` is the badge of each reply in the open thread that wears one, as the
//! feed draws it (label `paid key` / `paid key · relay off` / `your plan` /
//! `your plan · computer`, with ` ⚡` after it where the model that answered is a fast twin; value
//! = the door, state `via-mac` (the wire's `via: "mac"`) on one the person's computer answered,
//! and `relay-off` on one the server's keys answered because the relay is off, as the run's frame
//! says in `fallbackFor: "relay_disabled"` (opengrok-server #332 (PR #338 at 66b9f7b))), holding
//! `reply-source-model-{messageId}` (label = the model the server named, which the badge shows on
//! hover) when it named one. A reply whose run
//! ended because the person's plan could not answer (a `RUN_ERROR` code: the relay's, where the
//! Mac could not, or `plan_unavailable`, where the person's own setting left the plan nothing to
//! answer with) keeps its line, and while it is the open thread's last turn the page holds
//! `run-error-send-on-server` (`Send this reply on Server instead`): a click sends the same turn
//! again on the server's paid keys, this once, as `retry-turn` does for a turn that never left. A
//! reply whose run ended `relay_disabled`, a Bot's reply to another skipped while the relay is
//! off with no fallback (opengrok-server #332 (PR #338 at 66b9f7b), only ever in the two Bots'
//! read-only pair thread), keeps its line and has neither. Under `composer-queued`, a
//! `queued-waiting-{messageId}` (`Waiting for your computer`) for each held message the server holds
//! for the person's computer (`heldFor: "relay_offline"`, never while the relay is switched off). In the bot's settings, while the Bot's
//! replies go through the person's plan, its own door or the account's that it follows,
//! `agent-usage-plan` (the Usage card does not count those replies).
//!
//! Named invokes (parity / gpui-agent): `UserFormContinue`, `UserFormDismiss`,
//! `UserFormOpenScreen`, `UserFormUseSaved`, `UserFormClearSaved` (also kebab
//! `user-form.continue` / `user-form.dismiss` / `user-form.screen` /
//! `user-form.use-saved --arg login_id=…` / `user-form.clear-saved`), `AddSiteLogin`
//! (`logins.add --arg origin= --arg username= --arg password= [--arg label= --arg notes=]`)
//! and `ImportSiteLogins` (`logins.import --arg path=`). Click ids above still work.
//!
//! Settings → Logins: `logins.list` (answers the rows — `id, kind, label, origin, username,
//! on_this_mac, last_used_at_ms`; never a password), `logins.search --arg q=…` (no `q`
//! clears; `set_value` / `type` / `key` on `settings-logins-search` do the same),
//! `logins.select --arg id=…` (no `id` clears the pick; a click on a row does the same),
//! `logins.notes --arg id=… --arg notes=…` (or `set_value` on `settings-login-notes-{id}`).
//! The Add sheet's fields are the window's own: `logins.add` carries the values instead.
//!
//! Routines: `routine.list` (answers with the open bot's rows —
//! `id, name, kind, cron, active, webhook_url, webhook_key`), `routine.create --arg
//! kind=cron|webhook --arg prompt=... [--arg cron=...]`, `routine.rotate --arg id=...`,
//! `routine.delete --arg id=...`.
//!
//! Typing goes in as GPUI keystrokes. `type`, `key` and `set_value` on the composer are
//! planned here ([`ComposePlan`]) and pressed by [`RootView`](crate::root::RootView), because
//! `/` and `@` are keys the composer takes before the text field ever sees them.
//!
//! `/` has no verb of its own: a row is taken the way a person takes it, by typing into
//! `composer-panel-search` and pressing Enter, which is the only path that puts the chip in the
//! message and the thing on the draft together. Two skills may share a name, and Enter takes
//! the first selectable row the search leaves: tell them apart by their description, which the
//! search reads too, or by counting rows under `composer-panel` and arrowing down to the one
//! wanted. `composer-skill`'s value says which of them was actually taken.

mod host;
#[cfg(target_os = "macos")]
mod macos_window;

pub use gpui_agent::mailbox::AgentMailbox;
pub use host::{Command, ComposePlan, NativeChatHost, ids};

use std::time::Duration;

use gpui_agent::security::from_env;
use gpui_agent::server::spawn_mailbox;

fn auth_banner(token_set: bool) -> &'static str {
    if token_set {
        "auth: required (GPUI_AGENT_TOKEN set; clients must send the same token)"
    } else {
        "auth: none (GPUI_AGENT_INSECURE_NO_TOKEN=1 — any local process can drive this host)"
    }
}

/// Start the localhost control plane when `GPUI_AGENT=1`.
pub fn maybe_start() -> Option<AgentMailbox> {
    match from_env() {
        Ok(None) => {
            eprintln!("agent control plane off (set GPUI_AGENT=1 to opt in)");
            None
        }
        Err(err) => {
            eprintln!("agent control plane refused: {err}");
            None
        }
        Ok(Some(config)) => {
            let mailbox = AgentMailbox::new();
            let auth = auth_banner(config.token.is_some());
            match spawn_mailbox(
                config.addr,
                config.token,
                mailbox.clone(),
                Duration::from_secs(30),
            ) {
                Ok((addr, _)) => {
                    eprintln!("gpui-agent listening on {addr} (platform=desktop, app=nativechat)");
                    eprintln!("opt-in: GPUI_AGENT=1 · bind via from_env · protocol v2");
                    eprintln!("{auth}");
                    eprintln!(
                        "screenshot: macOS writes this window via screencapture -l (Screen Recording)"
                    );
                    Some(mailbox)
                }
                Err(err) => {
                    eprintln!("gpui-agent failed to bind: {err}");
                    None
                }
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub fn screenshot_this_window(
    window: &gpui_kit::Window,
    path: Option<&str>,
) -> Result<gpui_agent::DispatchResult, String> {
    let path = gpui_agent::require_screenshot_path(path)?;
    let _dest = gpui_agent::confine_screenshot_path(path)?;
    let id = macos_window::cgwindow_id(window)?;
    gpui_agent::capture_window_via_screencapture(id, Some(path))
}

#[cfg(not(target_os = "macos"))]
pub fn screenshot_this_window(
    _window: &gpui_kit::Window,
    _path: Option<&str>,
) -> Result<gpui_agent::DispatchResult, String> {
    Err(gpui_agent::screenshot_unavailable(
        "desktop PNG of the app window is macOS-only (`screencapture -l`)",
    ))
}
