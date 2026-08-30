/**
 * MECHANICALLY RECOVERED from the 0.18 host bundle by scripts/recover-experiment-config.mjs.
 * Do not hand-edit registry values; regenerate them from the immutable evidence artifact.
 */

export type ValueParser<T> = ((value: unknown) => T) & { readonly enumValues?: readonly T[] };
export function parseEnum<const T extends readonly unknown[]>(enumValues: T): ValueParser<T[number]> {
  const parser = ((value: unknown) => { if (!enumValues.some((candidate) => candidate === value)) throw new Error(`Invalid value for enum: ${String(value)}, expected one of: ${enumValues.join(", ")}`); return value as T[number]; }) as ValueParser<T[number]>;
  Object.defineProperty(parser, "enumValues", { value: enumValues });
  return parser;
}
export function parseBoolean(value: unknown): boolean { if (typeof value !== "boolean") throw new Error(`Invalid value for boolean: ${String(value)}`); return value; }
export function parseString(value: unknown): string { if (typeof value !== "string") throw new Error(`Invalid value for string: ${String(value)}`); return value; }
export function parseNumber(value: unknown): number { if (typeof value !== "number") throw new Error(`Invalid value for number: ${String(value)}`); return value; }
export function parseNumberArray(value: unknown): number[] { if (!Array.isArray(value)) throw new Error(`Invalid value for number array: ${String(value)}`); return value.map(parseNumber); }
export function parseStringArray(value: unknown): string[] { if (!Array.isArray(value)) throw new Error(`Invalid value for string array: ${String(value)}`); return value.map(parseString); }

const DEFAULT_FIRST_WINDOW_REACTIVATION_INACTIVE_DAYS = 7;
const DEFAULT_ENVIRONMENT_SETUP_MAX_RESUME_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const AUTO_SPILLOVER_UI_DEFAULTS = {
  autoTitle: "Cursor Models", autoDescription: "Includes Cursor Grok 4.5 and Composer 2.5",
  apiTitle: "Other Models", apiDescription: "Consumed by named models.",
  autoBeyondLimitDescription: "Additional usage beyond limits consumes Other Models quota or on-demand spend.",
  autoUsageBarLabel: "your included total usage", apiUsageBarLabel: "your included API usage"
};

export const FLAGS = {
      agent_goal_continuation: {
        client: true,
        default: false
      },
      // Dispatch queued composer prompts as a fresh run (new request id / new
      // stream) at turn end instead of handing them to the live
      // conversation-action stream. The inline handoff reuses the current request
      // id for a brand-new user prompt, colliding request-id-keyed attribution
      // (completion logs, datagen snapshots, telemetry). Default-off ships the
      // legacy inline behavior until the gate is ramped.
      agent_queued_prompt_new_request_id: {
        client: true,
        default: false
      },
      // Dark-launch kill switch for the Org Billing Admin role (ENT-3122). Gates
      // whether `setOrganizationMemberRole` will assign `BILLING_ADMIN`; default OFF
      // so the role is unassignable until we intentionally enable it. `client: true`
      // so the portal org-members role picker can gate the "Billing Admin" option
      // on it; the backend still enforces the gate on assignment.
      org_billing_admin_role: {
        client: true,
        default: false
      },
      // Focus-gates the Glass local-agent PR lifecycle batch poll
      // (`PrLifecycleStore`, RPC `BatchGetPullRequestStatus`). When ON, the steady
      // 30s batch poll slows down while the window is unfocused and catches up with
      // one refresh on refocus; failure backoff is unaffected. Default OFF keeps
      // today's always-on cadence byte-for-byte. Read client-side (VS Code/Glass)
      // via `IExperimentService.checkFeatureGate`.
      focus_gate_local_agent_pr_poll: {
        client: true,
        default: true
      },
      // Client-side rollout gate for the response-comparison post-vote comment
      // prompt: after voting in the side-by-side "Which response is better?"
      // comparison, the vote button morphs into an optional inline comment box
      // and the comparison collapses after submit/skip instead of immediately.
      // Comments report as `agent.response_comparison.comment`, privacy-gated to
      // USAGE_CODEBASE_TRAINING_ALLOWED like the other comparison events. Default
      // OFF preserves the shipped instant-collapse behavior.
      response_comparison_comment_prompt: {
        client: true,
        default: false
      },
      // Client rollout of sand-mobile's Settings → Agent → Agent Computer console
      // (the pushed page stating disk and software facts about the one shared
      // computer, and its Update Computer action). When OFF (the default for
      // everyone) the Agent group omits the row and the `/settings/agent-computer`
      // route redirects, so a stale nav entry cannot reach the page either.
      sand_mobile_agent_computer_console: {
        client: true,
        default: false
      },
      // Client rollout of sand-mobile's Settings → Haptics page, which carries the
      // one switch for press haptics. When OFF (the default for everyone) Settings
      // omits the row and the `/settings/haptics` route redirects, so a stale nav
      // entry cannot reach the page either — and a press stays silent whatever the
      // stored switch says, so a reader who opted in during a rollout does not keep
      // buzzing after the gate goes back off. The press SCALE is ungated; only the
      // haptic rides this.
      sand_mobile_haptics_settings: {
        client: true,
        default: false
      },
      // Client rollout of where sand-mobile seats the unread signal. When ON, the
      // chat's own mark wears the unread / awaiting badge on its outline and the
      // trailing dot at the end of the roster row, the pinned tile and the hidden
      // chats row is gone. When OFF (the default for everyone) the mark stays
      // quiet and that trailing dot is the signal, exactly as it shipped. The two
      // seats are mutually exclusive on every surface, so the gate moves the
      // marker rather than adding a second one.
      sand_mobile_unread_on_avatar: {
        client: true,
        default: false
      },
      // KILL SWITCH for sand-mobile's in-product feedback (Settings → Send
      // Feedback, which POSTs `/sand/feedback` to the same handler desktop uses).
      // When ON, Settings omits the row and the `/settings/feedback` route
      // redirects, so a stale nav entry cannot reach the page either. Default OFF,
      // which is what makes the feature on for everyone without a rollout: an app
      // whose bootstrap has not landed, or predates this gate, reads OFF and keeps
      // the feature. Turning it ON takes feedback away with no app release.
      sand_mobile_feedback_kill_switch: {
        client: true,
        default: false
      },
      // Client rollout of sand-mobile's special Settings card (the inset group
      // above Agent that currently hosts Model). When OFF (the default
      // for everyone) the card and its fields are omitted from Settings — the
      // Model sub-page itself is not redirected by this gate. When ON, the card
      // mounts only if at least one field inside it has something to show (today:
      // Model, which also yields to `sand_model_selection`).
      sand_special_settings: {
        client: true,
        default: false
      },
      // Per-user rollout of Sand's multitask orchestration: the main 1:1 agent
      // becomes an always-available dispatcher that tracks work with TodoWrite and
      // delegates execution to hidden background "executor" subagents (one per
      // independent work stream, in parallel), so rapid-fire user messages get
      // timely replies instead of queueing behind long inline work. When ON, the
      // agent's system prompt teaches the orchestration pattern and the runner
      // offers TodoWrite plus the executor subagent type; when OFF (the default
      // for everyone) none of that surfaces and turns run inline exactly as
      // before. Evaluated in the Sand host via its SandExperimentService (read
      // live per turn so a rollout or kill applies without a runner rebuild).
      // Default OFF.
      sand_multitask: {
        client: true,
        default: true
      },
      // Per-user Sand rollout for the native SendMessage delivery scan. Default OFF
      // makes Sand skip historical hydration and keep generic empty-response
      // recovery eligible; callers that omit the AgentConfig field still scan.
      sand_send_message_delivery_owed: {
        client: true,
        default: false
      },
      grok_bot_dynamic_tools: {
        client: true,
        default: false
      },
      // Clean default-off rollout for Sand's replacement memory pipeline. The host
      // pins the first authenticated evaluation for its lifetime: control users
      // keep legacy extraction and treatment users get background synthesis.
      sand_memory_dreaming: {
        client: true,
        default: false
      },
      // Sand's append-only transcript journal. Assignment unit: userID. Control
      // keeps the production legacy mirror; treatment pins a conversation to the
      // turn-only journal. Once treatment claims a transcript, its durable mode
      // marker keeps that conversation on the journal even if this gate turns off.
      sand_new_transcript_journal: {
        client: true,
        default: false
      },
      sand_computer_use_playwright: {
        client: true,
        default: true
      },
      // How Sand's Computer tool types characters that have no key on the X keymap.
      // They go straight to `xdotool type`, which silently drops or mistypes them
      // (`Aprenderás` reached a live page as `Aprenders`, SAND-1271). When ON, a
      // keycode is bound for each one first, which delivers them exactly. Read live
      // per Computer tool call, so a rollout or a kill applies to the next action
      // with no box or runner restart. Default OFF.
      // NOTE: the gate does not exist in Statsig yet, so it reads false everywhere.
      // Create it before trying to enable this
      // (scripts/create-statsig-gate.sh sand_computer_use_unicode_typing); the
      // in-box Sand host evaluates it from the client bootstrap, which only carries
      // gates that exist in Statsig.
      sand_computer_use_unicode_typing: {
        client: true,
        default: false
      },
      // Sand's Settings → Usage & Billing page (non-enterprise accounts). When
      // OFF (the default) the section is hidden and the desktop's usage-summary
      // read returns null without touching the backend.
      sand_usage_page: {
        client: true,
        default: false
      },
      // Sand's browserUse subagent: DOM-level automation of the box browser over
      // loopback CDP (mirrors Glass's browser-use subagent), dispatched via Task.
      // Evaluated in the Sand host via its SandExperimentService (read live per
      // run so a rollout or kill applies without a runner rebuild). Default OFF.
      sand_browser_use_subagent: {
        client: true,
        default: false
      },
      sand_auto_update_when_idle: {
        client: true,
        default: false
      },
      // Server-controlled rollout of Sand's org chart (the agent-network view): the
      // Cmd-K palette's "Open Org Chart" command and the org-chart primary view that
      // draws the live agent/group graph. When OFF (the default for everyone) the
      // command is hidden and the org chart is unreachable; when ON it appears.
      // Evaluated in the Sand host via its SandExperimentService (read live so a
      // rollout takes effect without an app rebuild) and surfaced to the renderer
      // over the gateway. Default OFF.
      sand_agent_network: {
        client: true,
        default: false
      },
      // Server-controlled rollout of Sand's product-analytics pipeline (DAU / WAU,
      // messages-per-user, and the starter set of product events). When ON for the
      // signed-in Cursor user, the Sand host activates its analytics buffer and ships
      // events to AnalyticsService.TrackEvents; when OFF (the default for everyone)
      // the host holds then drops events and trackEvent is a no-op. Evaluated in the
      // Sand host via its SandExperimentService — a rollout/kill switch with no app
      // rebuild. Default OFF.
      sand_product_analytics: {
        client: true,
        default: true
      },
      // The Sand host's pressure-triggered CPU flight recorder; read live per
      // pressure window, so this doubles as the kill switch. Knobs live in
      // sand_pressure_cpu_profiler_config.
      sand_enable_pressure_cpu_profiler: {
        client: true,
        default: true
      },
      // Rollout of Sand's customer-facing action audit trail: when ON for the
      // signed-in Cursor user, the Sand host reports agent actions (stdio MCP tool
      // calls, shell commands, browser navigations, computer-use session summaries)
      // to DashboardService.RecordSandAuditEvents, and the backend emits
      // server-observed audit events for HTTP MCP calls inside ExecuteSandMcpTool.
      // Both land in the team audit log (customer_log -> audit_events). When OFF
      // (the default) the host drops events locally after writing its per-agent
      // audit.jsonl, and the backend emits nothing. Evaluated in the Sand host via
      // its SandExperimentService and re-checked server-side. Default OFF.
      sand_action_audit_logs: {
        client: true,
        default: false
      },
      // Per-user rollout of Sand's one-time stale checkpoint-root cleanup: on
      // session open, an existing store's superseded content-addressed
      // conversation roots (accumulated before fixed-slot checkpoint persistence)
      // are deleted once, keyed off a per-store version marker (see
      // SandAgentSessionStore.clearStaleCheckpointRootsOnce). Evaluated in the
      // Sand host via its SandExperimentService and pinned once at host startup
      // (the SAND_STALE_ROOT_GC env var still overrides it, as a dev switch /
      // kill switch). While OFF the cleanup does nothing and records no marker,
      // so stores clean up on their first open after the gate reaches them.
      // Default OFF.
      sand_stale_root_gc: {
        client: true,
        default: false
      },
      // Per-user rollout of Sand's one-time retirement of the frozen legacy
      // conversation blobs in an existing agent's store.db. Conversation blobs are
      // owned by the agent's worker in its own conversation-blobs.db; store.db's
      // `blobs` table is the pre-isolation copy nothing writes any more. When ON,
      // a session open asks the agent's worker to prove that dedicated database is
      // authoritative — adoption completed, the pointer's whole current graph
      // resolves there, every shared row is byte-identical, and every legacy-only
      // row is a provably superseded checkpoint root — and only then clears the
      // table and records a per-store version marker (see
      // SandAgentSessionStore.retireLegacyStoreBlobsOnce). Evaluated in the Sand
      // host via its SandExperimentService and pinned once at host startup. There
      // is deliberately no env override: this is the only switch. While OFF the
      // retirement does nothing and records no marker, so a store retires on its
      // first open after the gate reaches it. Default OFF.
      sand_legacy_store_blob_retirement: {
        client: true,
        default: false
      },
      // Sand conversation-bundle size limits: background reachability GC over
      // conversation-blobs.db past the soft threshold, plus the turn-start hard
      // cap that compacts and refuses turns when the bundle stays over the limit.
      grok_bot_conversation_gc: {
        client: true,
        default: false
      },
      // Per-user rollout of Sand cross-user sharing: share links for one agent,
      // owner-approved access grants, the shared per-agent transcript room, and
      // cross-user group chats — all relayed through the backend
      // (backend/server/src/sand/handleSandShareEndpoints.ts). Evaluated on the
      // backend for every sharing endpoint (fail closed) AND pinned at Sand host
      // startup, so the box's poll loop and the
      // renderer affordances only exist for gated-in users. Default OFF.
      sand_multiplayer: {
        client: true,
        default: false
      },
      // Per-user rollout of the Sand notify bus: the in-box host holds one
      // /sand/notify SSE stream and drains the relay queues (automation fires,
      // listener events, xuser events) on notify frames instead of short-polling
      // them every 4-15s. Evaluated in the Sand host via its
      // SandExperimentService; when OFF (the default) the host keeps the shipped
      // short-poll loops untouched, so every failure mode degrades to today's
      // behavior. Delivery correctness never depends on the stream: queues stay
      // durable and the host keeps a slow safety poll while connected.
      sand_notify_bus: {
        client: true,
        default: false
      },
      // Kill switch for the notify-connected pollers' 120s safety polls (the
      // periodic drains that cover a lost pub/sub publish while the /sand/notify
      // stream is up). KILL polarity: ON (the default) keeps the safety cadence;
      // turning it OFF makes a connected host drain only on notify frames,
      // (re)connect drain-alls, and owed acks — the zero-idle-poll end state.
      // Evaluated in the Sand host; gate-read failures degrade to ON, so every
      // failure mode keeps the safety net.
      sand_notify_safety_poll: {
        client: true,
        default: true
      },
      // Kill switch for the own-box tool surface of Sand cross-user shared-room
      // turns (the sand_multiplayer rollout's exec allowlist — the member's OWN
      // box tools plus SendMessage; SHARED_ROOM_TOOL_NAMES in
      // sand/src/host/runner/sand-agent-runner.ts is the authority). KILL polarity:
      // passing narrows a shared-room turn back to SendMessage only, so every
      // failure mode (gate not yet created in the console, anonymous or missing
      // bootstrap, gate-read error) degrades to the shipped tool surface.
      // Evaluated in the Sand host via its SandExperimentService, read live per
      // turn and combined with the SAND_SHARED_ROOM_BOX_TOOLS env override
      // (enabled = NOT this gate AND the env resolver). Default OFF.
      sand_shared_room_box_tools_kill_switch: {
        client: true,
        default: false
      },
      // Kill switch for the GrokAgent UA token stamped onto box Chrome browsing
      // (box-chrome's --user-agent suffix and the special-treatment CDP override,
      // including the opaque `(u:<owner>)` stamp). KILL polarity: passing makes
      // the Sand host write the /tmp/sand-ua-token-disabled marker, which drops
      // the token from new Chrome launches and from every new tab's CDP override;
      // every failure mode (gate not yet created in the console, anonymous or
      // missing bootstrap, gate-read error) degrades to the shipped stamped UA.
      // Evaluated in the Sand host via its SandExperimentService and reconciled
      // live to the marker, so flipping it needs no host restart. Default OFF.
      sand_browser_ua_token_kill_switch: {
        client: true,
        default: false
      },
      // Per-user rollout of Sand global search v2: the Cmd-K palette's
      // cross-conversation search (the Messages / Files / Links / Routines tabs and
      // their message/media hits, plus the jump-to-entry reveal) AND the host-side
      // FTS5 content-search index over every agent's chat + media that serves it.
      // Evaluated in the Sand host via its SandExperimentService and surfaced to the
      // renderer over the gateway (isGlobalSearchEnabled), the exact mirror of
      // sand_agent_network. When OFF (the default for everyone) the palette falls
      // back to its pre-search behavior (jump between agents/actions only), the FTS5
      // index is never built, populated, or queried, and the searchAgents/searchMedia
      // RPCs no-op — so gated-out users pay no disk/CPU cost. Default OFF.
      sand_global_search: {
        client: true,
        default: true
      },
      // Per-user rollout of Sand's `#` PR-reference menu: typing `#` in the composer
      // lists the PRs the conversation already references and picking one inserts a
      // titled chip, plus the matching `#<n>` decoration in the assistant's prose.
      // Evaluated in the Sand host via its SandExperimentService and read in the
      // renderer straight off the experiments snapshot (useSandPrMenuGate) — the
      // lightweight mirror of sand_auto_review, with no gateway RPC of its own. When
      // OFF (the default for everyone) the `#` suggestion plugin and its node schema
      // are never registered, so a typed `#<n>` stays plain text, and the known-PR
      // set stays empty so no prose `#<n>` resolves either. A chip in an
      // already-sent message still renders from its stored attrs. Default OFF.
      sand_pr_menu: {
        client: true,
        default: true
      },
      // Per-user rollout of Sand's automatic Disk Saver: when the box reports disk
      // pressure, the desktop provisions the Disk Saver agent (or asks an existing
      // idle one to re-audit) in the background, once per pressure episode, and the
      // low-disk banner becomes a pointer to that agent ("Go to Disk Saver")
      // instead of an offer to start one. Evaluated on the desktop's
      // SandExperimentService and read in the renderer straight off the experiments
      // snapshot (useSandAutoDiskSaverGate), the lightweight mirror of
      // sand_pr_menu. When OFF (the default for everyone) nothing launches on its
      // own and the banner keeps its manual "Open Disk Saver" behavior. Default OFF.
      sand_auto_disk_saver: {
        client: true,
        default: false
      },
      // Sand desktop's CLIENT-SIDE pause kill switch. ON replaces the whole window
      // with the paused-computer cover and stops the desktop from reaching any box:
      // the coordinator refuses to resolve a gateway connection (dropping the live
      // event stream) and Electron main's connector refuses connect/recreate, so no
      // EnsureSandBox and no in-box request is made. The desktop keeps polling
      // Statsig off the cursor backend while paused, so flipping this back OFF
      // releases every client on its own. Evaluated in Electron main's
      // SandExperimentService; the renderer reads it straight off the experiments
      // snapshot (useSandClientPauseGate). Distinct from the backend's own
      // SAND_BOX_BLOCKED refusal, which shows the same cover from the server side.
      // Default OFF, and every fail-closed state (no bootstrap, gate absent,
      // exception) resolves to "not paused".
      sand_client_pause: {
        client: true,
        default: false
      },
      // Sand desktop's "Get Grok Bot for iOS" account-menu row (opens the iOS
      // download page). When OFF (the default) the row is absent from the menu.
      sand_get_grok_bot_ios: {
        client: true,
        default: false
      },
      // Teach by demonstration in Sand: the box screen recorder (Teach entry
      // points, recording HUD, stop-and-learn synthetic message) and the
      // learn-from-demonstration managed skill both key off this one gate, so a
      // bad rollout is a single kill switch. Default OFF.
      sand_teach_by_demonstration: {
        client: true,
        default: false
      },
      // Rollout gate for Sand's window-focus staleness catch-up. OFF (the shipped
      // default, and what a Statsig-unknown gate resolves to) keeps the old edge:
      // every window focus runs the full noteReconnect. ON runs the pull-only
      // catch-up instead. The polarity puts every fail-closed state (no bootstrap,
      // gate absent from the console, exception) on the old behavior: roll out by
      // ramping ON; flipping back OFF is the kill switch.
      sand_focus_staleness_catch_up: {
        client: true,
        default: false
      },
      // Kill switch for routed-model disclosure under Smart Router. When ON, the
      // portal hides the team/group control, dashboard reads return false, writes
      // cannot enable it, and runtime disclosure ignores stored true values.
      // Client-facing because the portal reads it directly. Intentionally not
      // created in Statsig yet; the absent/default OFF state preserves disclosure.
      disable_smart_auto_show_routed_model: {
        client: true,
        default: false
      },
      migrate_default_model_config_to_auto_smart_cost: {
        client: true,
        default: false
      },
      // Enables the IDE setting that lets users keep their last-used model instead
      // of receiving product model nudges. Team-admin model resets remain active.
      model_nudge_opt_out_setting: {
        client: true,
        default: true
      },
      // Slows (and catches up on refocus) the window-scoped model-catalog refresh
      // poll in `modelCatalogRefreshService` while the app is unfocused, mirroring
      // the GetTeams unfocused slowdown. When OFF the client keeps the fixed
      // focus-agnostic ~5m/~30m timers; when ON it polls on the focused cadence
      // while focused, a slower cadence in the background, and refreshes on
      // refocus if stale. Default OFF.
      slow_model_catalog_refresh_when_unfocused: {
        client: true,
        default: true
      },
      // Gates the GitHub workflow-run triage and PR-review-comment autofix
      // automation templates (and their new trigger types) on the client. Off by
      // default so old clients that lack the new trigger UI never surface them;
      // enable per client app version once those builds ship. Web (portal) does not
      // gate these templates.
      new_automation_templates_slack_github_triggers: {
        client: true,
        default: true
      },
      // Client includes capped raw git stderr in exec throws. stderr can carry PII,
      // so this Statsig gate must stay scoped to internal devs.
      git_diff_collect_stderr: {
        client: true,
        default: false
      },
      glass_chat_switch_tracing: {
        client: true,
        default: false
      },
      // When on, cached-agent adopt after a chat switch is scheduled with
      // setTimeout(0) so the keydown turn can paint (sidebar highlight) before
      // remounting the transcript. Off keeps queueMicrotask (same-task flush).
      glass_chat_switch_macrotask_adopt: {
        client: true,
        default: false
      },
      // ON: closing a Glass agent workspace disposes its InstantiationService
      // after a 30s grace period. OFF keeps today's behavior: released containers
      // stay alive until window close. Read at close time.
      glass_dispose_workspace_on_release: {
        client: true,
        default: false
      },
      // Shows the Glass diff meter: the Git entry in the dev performance bar and the
      // diff-tab panel that record git ops sent to the git extension. Internal devs only.
      glass_git_diff_meter: {
        client: true,
        default: false
      },
      // After an agent on the empty Glass Home workspace creates a project via
      // create_project, auto-chain move_agent_to_root onto the new dir so search
      // stops walking $HOME. Off = the agent stays on Home until it re-roots itself.
      glass_auto_reroot_after_create_project: {
        client: true,
        default: false
      },
      // Strengthens move_agent_to_root guidance so agents always re-root before
      // changing files in a worktree instead of continuing from the main checkout.
      glass_agent_worktree_reroot_prompt: {
        client: true,
        default: true
      },
      // Gates the Glass cloud meta-agent surface: sidebar Agents section, Add Agent
      // entry, and the specialized Create Agent flow.
      glass_cloud_meta_agents: {
        client: true,
        default: false
      },
      // Sync Glass cloud-agent pins through the backend while preserving local-only
      // pins and legacy local cloud pins during rollout.
      glass_cloud_agent_pin_sync: {
        client: true,
        default: false
      },
      // Skip duplicate post-attach populate after CloudAgentLoader hydrates on a
      // fresh cloud-agent switch (seeds lastHydratedStateFingerprint so the
      // pipeline dedupe returns unchanged). Default OFF.
      dedupe_cloud_hydration_glass: {
        client: true,
        default: false
      },
      // When ON, Named Agent Slack routing collapses to a single conversation:
      // every matched Slack thread is delivered into the Named Agent's existing
      // home session instead of spawning a per-thread child session. If there is no
      // live home session, the router falls through to the default
      // per-thread behavior. Glass also uses this gate to replace the session list
      // with a single-session label, and the backend enables restricted parent
      // tool/delegation mode. Default OFF.
      named_agent_single_session: {
        client: true,
        default: false
      },
      // Gates the Glass empty-state / new-agent picker redesign.
      glass_empty_state_pickers_redesign: {
        client: true,
        default: true
      },
      // Gates searchable Files, Browser, Canvas, and Changes tab empty states.
      // When OFF, each tab keeps its existing non-searchable empty state.
      glass_searchable_empty_states: {
        client: true,
        default: false
      },
      // Gates branch availability labels, expanded branch sources, recents, and
      // submit-time branch materialization/publish sync in the redesigned Glass
      // branch picker.
      glass_branch_picker_redesign: {
        client: true,
        default: false
      },
      // Gates the unified anchored composer trays in Glass: the `/`, `@`, and `+`
      // composer menus render as full-width in-flow trays with a flat interleaved
      // item list (shared row chrome, virtualized, ranked empty state) instead of
      // the legacy floating popovers. When OFF (the default for everyone) the
      // composer keeps today's SlashMenu popover and Menu-based plus menu.
      unified_composer_trays: {
        client: true,
        default: false
      },
      // Gates the net-new `#` pull-request reference menu in the Glass composer.
      // Only takes effect when `unified_composer_trays` is also enabled.
      composer_pr_hash_menu: {
        client: true,
        default: false
      },
      // Shows type/provenance labels (for example User Skill, Repo Skill, Plugin
      // Skill, Built-in Action, Mode, Chat) in unified composer tray rows for
      // debugging. When OFF the tray shows no trailing labels; only functional
      // controls (MCP toggle, drill-in chevrons) remain. Default OFF.
      unified_composer_tray_debug: {
        client: true,
        default: false
      },
      // Gates remembering / seeding the New Agent environment + workspace
      // selection: inherit the source agent's repo + run-on target, and honor the
      // configurable default-environment setting. Default OFF preserves today's
      // local-biased New Agent behavior.
      glass_remember_new_agent_environment_selection: {
        client: true,
        default: true
      },
      // Mounts the Glass file-tab editor inside a shadow root so the document's
      // `:has()` rules can't trigger per-element style invalidation on Monaco's
      // per-frame token-span churn (large-file scroll jank). Evaluated at
      // editor-attach time, so it takes effect on reload. Off by default; ramp via
      // Statsig.
      glass_editor_shadow_isolation: {
        client: true,
        default: true
      },
      // When enabled, GlassShadowStyleMirror never calls _rebuild() synchronously
      // from its MutationObserver (style add/remove); it schedules via
      // RunOnceScheduler(0) instead so a large stylesheet can't burn tens of ms on
      // the agent-switch hot path. Off by default; ramp via Statsig.
      glass_defer_shadow_style_rebuild: {
        client: true,
        default: false
      },
      // Gates the Glass file tree's smoother scrolling affordances: sticky
      // ancestor headers and VS Code-style compact folder rows.
      glass_filetree_smooth: {
        client: true,
        default: false
      },
      // When enabled, Glass file tabs no longer open the file-tree sidebar by
      // default. Explicit user opens still expand the sidebar.
      glass_filetree_dont_show_default: {
        client: true,
        default: false
      },
      // Kill switch for the `limit_hit_ui_2026_06` experiment. When ON, the new
      // limit-hit tray/modal treatment is force-disabled (clients render today's
      // control UI) without ending the experiment. Default OFF so the experiment
      // controls assignment.
      limit_hit_ui_kill_switch: {
        client: true,
        default: false
      },
      // When ON, prompt-input mention chips drop their hover X (remove) button in
      // Glass. Default OFF so chips keep today's removable chrome.
      glass_no_x_on_chips: {
        client: true,
        default: false
      },
      // When ON, Glass keeps the follow-up TipTap/ProseMirror editor mounted across
      // agent switches and rehydrates composer draft content in place. When OFF
      // (default), the follow-up prompt remounts per followup session id.
      glass_retain_followup_prompt_editor: {
        client: true,
        default: false
      },
      // Gates all Portal Codebase surfaces, including app installation and
      // management.
      origin_repos: {
        client: true,
        default: false
      },
      // The in-client Origin pull-request experience (userID-bucketed). While
      // OFF, the Codebase repo Pull Requests tab links every repo kind to the
      // in-portal coming-soon teaser at /codebase/:team/:repo/pulls instead of
      // the review.cursor.com / portal review destinations.
      origin_pull_requests_enabled_in_client: {
        client: true,
        default: false
      },
      // Portal Origin Apps GA surfaces (create-app first; more Apps UI later).
      // Independent of origin_repos, which remains the Codebase Apps tab boundary.
      origin_apps_ga: {
        client: true,
        default: false
      },
      codebase_branches_redesign_in_progress: {
        client: true,
        default: false
      },
      // When ON, PR references in the Codebase (Origin) browse UI link to the
      // GitHub PR (for repos with a GitHub mirror) instead of review.cursor.com —
      // for early-access design partners who still work in GitHub PRs.
      use_github_pr_links_in_origin_browse: {
        client: true,
        default: false
      },
      // Lets the managed `automations` service account request reviewers on Origin
      // changes. When on, the Origin reviewer-candidate list + RequestReview
      // validation switch from caller-scoped to team-scoped for managed Cursor
      // service accounts (which have no org membership of their own), so an
      // automation can request any reviewer candidate of the repo-owner team.
      // Client exposure keeps the Automations editor aligned with this rollout.
      automations_origin_request_reviewers: {
        client: true,
        default: false
      },
      // Enables GitHub-style raw file links for Origin code browsing. The backend
      // Mint + client "View raw" button. Redemption uses the gate below.
      origin_raw_file_links: {
        client: true,
        default: false
      },
      // Sand Auto-review enforce rollout (Shell/ExternalShell/MCP/Computer).
      // Settings-on default is shadow for every reviewed surface. When this gate
      // is ON, those surfaces escalate to enforce. When OFF (default), they stay
      // in shadow. The Settings toggle remains the user kill switch (off ⇒ no
      // classifier). This gate is the only Statsig lever for enforce.
      // Local bring-up can still force a mode via SAND_AUTO_REVIEW_MODE.
      sand_auto_review: {
        client: true,
        default: false
      },
      // Master switch for Sand spotlighting: wrapping every tool result in the
      // <cursor_untrusted_data_1337> fence and teaching the agent, in its system
      // prompt, that fenced content is outside DATA that must not drive unrequested
      // actions. When OFF (the default for everyone) tool results reach the model
      // exactly as before and the prompt section is omitted. Evaluated in the Sand
      // host via its SandExperimentService and re-read per turn, so a rollout or
      // kill applies without a runner rebuild.
      //
      // The two halves MUST flip together, which is why one gate covers both: a
      // prompt that promises fences over unfenced results turns "no marker" into a
      // false trust signal, and fences with no prompt are unexplained noise.
      sand_spotlight: {
        client: true,
        default: true
      },
      smart_mode_classifier_shadow_mode: {
        client: true,
        default: false
      },
      ext_host_document_memory_estimates: {
        client: true,
        default: false
      },
      // Logs a structured `ext_host_cursor` warning (default off) when an extension
      // on the agent-exec isolated extension host touches a text-document API. Used
      // to verify agent-exec never needs document sync before we stop syncing
      // documents to it. Scoped to agent-exec only: retrieval and always-local
      // legitimately use these APIs, so tracking them would be pure noise.
      agent_exec_text_document_api_access_tracking: {
        client: true,
        default: false
      },
      // Default-off kill switch for the future cursor-agent-host topology. When ON,
      // the window-pinned workbench decision swaps the agent-exec fanout /
      // allowlist / dependency-backfill path over to cursor-agent-host so only one
      // of the pair is active in that window, regardless of workspace family.
      cursor_agent_host: {
        client: true,
        default: false
      },
      // Sub-feature under cursor_agent_host: when ON, move exec instantiation into
      // agent-host (host constructs once and injects into shared exec activate /
      // createAgentHost). When OFF (default), host-ON still uses the topology, but
      // exec keeps minting its local fallback when no gitExecutor is injected.
      // Reused for future exec migrations — not git-specific.
      cursor_agent_host_move_exec: {
        client: true,
        default: false
      },
      // Runs eligible Agent Host turns through the in-process agent loop.
      // Unsupported turns continue through backend NAL.
      agent_host_local_loop: {
        client: true,
        default: false
      },
      // Perf Loop (E3): default-off kill switch that defers activation of
      // anysphere.cursor-agent-exec from the eager "*" activation event to
      // "onStartupFinished". cursor-agent-exec dominates the eager-activation
      // window on Glass root cold boots (~800ms code-load + ~9ms activate call),
      // so moving it out of the startup-critical eager window reclaims that time.
      // OFF (default) = unchanged eager "*" behavior. ON = the client rewrites the
      // extension's activation event so it loads just after eager activation
      // settles instead of blocking it. Absent gate reads false (safe default), so
      // this can ship dark and be flipped remotely without a redeploy.
      defer_cursor_agent_exec_activation: {
        client: true,
        default: false
      },
      shell_exec_output_backpressure: {
        client: true,
        default: true
      },
      file_watcher_metrics: {
        client: true,
        default: false
      },
      glass_shared_application_storage: {
        client: true,
        default: true
      },
      // Single-pass stringify for reactive-storage saves (IDE-2278). Default off.
      reactivestorage_single_pass_stringify: {
        client: true,
        default: false
      },
      /**
       * Write agentData CacheStorageService TTL entries as `v2:<expiresAt>\n<value>`
       * instead of the legacy JSON envelope that JSON.stringifies the value.
       * Readers for V2 landed in #198092; keep default off and ramp via Statsig.
       */
      agentdata_cache_storage_v2_write: {
        client: true,
        default: false
      },
      slow_ipc_deserialize_sentry: {
        client: true,
        default: false
      },
      /**
       * Sync large (>5MB) documents to the extension host as binary content chunks
       * instead of a JSON lines array, avoiding giant JSON.stringify renderer
       * freezes and V8 max-string-length failures on document open.
       */
      chunked_document_open_sync: {
        client: true,
        default: true
      },
      ripgrep_invocation_monitor: {
        client: true,
        default: false
      },
      /**
       * Makes `.cursor/rules` discovery pass `.cursorignore` files to ripgrep
       * (`--cursor-ignore`), so negation patterns can re-include gitignored rule
       * files (DESK-9199).
       */
      rules_discovery_respect_cursorignore: {
        client: true,
        default: false
      },
      /**
       * Allows custom subagent directory symlinks to resolve outside the workspace
       * root, supporting shared agent-definition repositories (DESK-8355).
       */
      subagents_discovery_allow_external_symlinks: {
        client: true,
        default: false
      },
      grep_fallback_monitor: {
        client: true,
        default: false
      },
      crepe_lazy_external_git_index: {
        client: true,
        default: false
      },
      exthost_rpc_channel_history: {
        client: true,
        default: false
      },
      exthost_rpc_metrics: {
        client: true,
        default: false
      },
      remote_exthost_watchdog: {
        client: true,
        default: false
      },
      // Skips only remote extension-host workspace readiness healthchecks.
      disable_remote_workspace_reh_healthcheck: {
        client: true,
        default: false
      },
      // Gates the client-side auto-GC of orphaned agentKv blobs in cursorDiskKV
      // (see ComposerBlobGcContribution). Flip on in Statsig once we're ready.
      agent_kv_auto_gc: {
        client: true,
        default: false
      },
      // Service-account Repository Access modal: when on, the modal stops calling
      // `getTeamRepositoriesForServiceAccountScope` and instead fans out across
      // SCM providers via `useAllInstallations`. Default off keeps the legacy
      // aggregator path; flip on per cohort to roll out PR #124528.
      service_account_repo_scope_use_installation_fanout: {
        client: true,
        default: false
      },
      // Gates the MakeGithubRequest Connect RPC (CS-58 / CS-97). Per-user;
      // default off. When off the handler throws Unimplemented and IDE
      // clients fall back to their existing direct-fetch path. Ramp once
      // the handler impl (CS-98), workbench migration (CS-100), and
      // cursor-retrieval migration (CS-101) have all merged.
      ide_make_github_request_enabled: {
        client: true,
        default: false
      },
      // Gates the clickable detail disclosure in Customize -> Hooks execution log
      // rows. Off keeps the log read-only while Customize rolls out; on lets users
      // expand a row to inspect the captured hook input, output, and error output.
      customize_hooks_execution_log_detail: {
        client: true,
        default: true
      },
      dashboard_agent_requests_heatmap: {
        client: true,
        default: false
      },
      // Switches the teamless dashboard "Getting started" checklist to the
      // backend-owned WEB catalog, including per-item dismiss actions.
      dashboard_individual_onboarding_checklist: {
        client: true,
        default: true
      },
      bugbot_enable_bulk_rules_upload_in_portal: {
        client: true,
        default: false
      },
      // Portal team-rules UI: agent type picker (Cursor / Sand / Both) and list badges.
      // Backend agentType field stays available regardless; this gate only hides the
      // dashboard controls until rollout. Read via useGateValue in portal-website.
      team_rule_agent_type_ui: {
        client: true,
        default: false
      },
      advanced_setup_for_self_hosted_gitlab_available: {
        client: true,
        default: false
      },
      enable_bitbucket_data_center_onboarding: {
        client: true,
        default: true
      },
      // Top-level portal switch for the Bitbucket integration surfaces
      // (integrations list, installation fetches, managed-agents pickers). Read
      // via `useGateValue` in portal-website; registered here so the gate is not
      // a portal-only string constant.
      enable_bitbucket: {
        client: true,
        default: false
      },
      internal_team_user_profiles: {
        client: true,
        default: true
      },
      user_claim_handle_glass: {
        // Read by the Glass client to gate the in-client claim-handle / profile UI.
        client: true,
        default: false
      },
      user_profile_glass: {
        // Read by the Glass client to gate the profile UI (claim flows redirect to web).
        client: true,
        default: true
      },
      enable_cursor_agent_worker_extension: {
        client: true,
        default: false
      },
      automations_chain_prompts: {
        client: true,
        default: false
      },
      // Gates the website automations prompt model selector over to the
      // parameterized ModelPicker. When OFF (default), web automations keep the
      // legacy picker backed by the automations-scoped filtered model list.
      website_use_new_model_picker_for_automations: {
        client: true,
        default: true
      },
      green_dot_automation_status: {
        client: true,
        default: true
      },
      automations_validate_on_enable: {
        client: true,
        default: true
      },
      automations_retry_button: {
        client: true,
        default: false
      },
      managed_automations_team_revamp: {
        client: true,
        default: true
      },
      // Kill-switch / rollout for GitLab "extended" automation triggers beyond the
      // shipped baseline (lifecycle/push/comments): MR label changes and MR
      // approvals. When OFF (default), the matcher rejects these GitLab triggers and
      // the GitLab label fan-out is skipped, so behavior is byte-identical to before
      // (GitHub-only for these trigger kinds). Evaluated per the GitLab webhook's
      // repo-owner context on the backend, so it doubles as a gradual per-team
      // rollout. Exposed to the client (client: true) so the automations trigger
      // picker surfaces these GitLab triggers only when the backend will honor them
      // for the current user/team — keeping the UI from offering a trigger that
      // would silently never fire.
      automations_gitlab_extended_triggers: {
        client: true,
        default: true
      },
      // Kill-switch / rollout for Bitbucket "extended" automation triggers beyond the
      // shipped baseline (lifecycle/push/top-level comments): PR review approved /
      // changes-requested. When OFF (default), the matcher rejects the Bitbucket
      // pullRequestReview trigger and reviews stay a no-op, so behavior is
      // byte-identical to before. Evaluated per the Bitbucket webhook's repo-owner
      // context on the backend, so it doubles as a gradual per-team rollout. Exposed
      // to the client (client: true) so the trigger picker surfaces the Bitbucket
      // PR-review trigger only when the backend will honor it for the current
      // user/team. (Bitbucket has no PR labels, and inline comments can't be safely
      // pinned — only the mutable source head is in the comment payload — so neither
      // is included.)
      automations_bitbucket_extended_triggers: {
        client: true,
        default: false
      },
      // Forge-agnostic automations on Origin mirrors (single rollout flag for the
      // PRD in backend/server/src/automations/docs/origin-forge-agnostic-automations-prd.md):
      // GitHub-configured triggers also fire on the repo's Origin mirror, and
      // mirror-echo events (pushes / PR push/merge updates duplicated by mirroring)
      // run once from the source-of-truth forge with the skipped copy recorded as
      // a SKIPPED run. Supersedes automations_scm_alias_matching,
      // automations_scm_phase_routing, and automations_scm_dispatch_dedup — call
      // sites check "new flag OR old flag" until the old flags are deleted.
      // Client-visible: also gates the matching Automations UI (the Add Trigger
      // menu collapses the separate GitHub / Origin buckets into one
      // "Git trigger" entry). The repo-picker lock to the git trigger's
      // repository shipped ungated — pure-git launches always use the event's
      // repo, so the lock is accurate regardless of this flag.
      automations_forge_agnostic_mirrors: {
        client: true,
        default: false
      },
      managed_agents_enabled: {
        client: true,
        default: false
      },
      custom_agents_enabled: {
        client: true,
        default: false
      },
      agents_bugbot_bottom_upsell: {
        client: true,
        default: false
      },
      // Consolidated review-agents growth kit on the portal (shared enable CTAs,
      // From Cursor cards, deep links, invite-modal CTA, upsell destinations for
      // bugbot / security / pr-routing / self-driving). OFF: every Bugbot growth
      // surface runs its pre-kit code path byte-for-byte. ON: the wrapped
      // surfaces route through the agent-parameterized kit in
      // portal-website/apps/web/src/components/review-agents-growth/ (for Bugbot
      // the kit reproduces legacy behavior exactly; equality-tested).
      review_agents_shared_growth: {
        client: true,
        default: false
      },
      automations_org_scoped_triggers_ui: {
        client: true,
        default: false
      },
      /**
       * Gate rolling out no-repo cloud agents: when on, start requests that
       * set `DevcontainerStartingPoint.environment_id` with no repo URL and
       * no private worker are accepted and routed through the env-only
       * cloud-VM code path. When off, such requests are rejected with a
       * BadRequest. See the no-repo cloud agents plan for details.
       */
      cloud_agents_no_repo_enabled: {
        client: true,
        default: true
      },
      cloud_agent_resubmit_from_message: {
        client: true,
        default: true
      },
      /**
       * Glass-only ramp for forking a cloud agent from turn actions
       * (ForkBackgroundComposer). Portal uses `cloud_agent_fork_from_turn`.
       */
      glass_cloud_agent_fork_from_turn: {
        client: true,
        default: true
      },
      cloud_agent_use_prewarmed_pods: {
        client: true,
        default: true
      },
      /** Glass StreamConversation compact-blob filter gate. */
      glass_cloud_blob_prefetch_bloom_filter: {
        client: true,
        default: false
      },
      /**
       * IDE/Glass: when on, CloudAgentStream stops post-ready StreamConversation
       * reconnects on permanent Connect errors / terminal Aborted phrases. Default
       * off preserves historical reconnect-forever behavior for cautious rollout.
       */
      cloud_agent_stop_permanent_stream_reconnect: {
        client: true,
        default: false
      },
      /** Bounds renderer memory held by cloud agent transcript bodies. */
      cloud_agent_bounded_transcript_body_residency: {
        client: true,
        default: false
      },
      /** Plugin-backed slash commands, snapshot RPC, cloud-agent plugin MCP merge, and server VM manifest materialization. */
      cloud_agent_plugins: {
        client: true,
        default: true
      },
      /** Kill switch for speculative followup pod wakes (compose + ingress ping). */
      cloud_agent_speculative_followup_wake: {
        client: true,
        default: false
      },
      local_agent_subagent_state_blob_refs: {
        client: true,
        default: false
      },
      cloud_agent_env_setup_with_dockerfiles: {
        client: true,
        default: false
      },
      // Umbrella rollout for the generalized environment-setup experience.
      // Initially gates setup snapshots, fast Save reuse, and related portal UX;
      // future env-setup improvements can share the same coordinated rollout.
      generalized_env_setup: {
        client: true,
        default: false
      },
      // When ON, a blocking `ask_question` interaction for a cloud agent will
      // auto-answer (reject the questionnaire so the model proceeds with reasonable
      // defaults) after a configurable timeout instead of blocking indefinitely.
      // The timeout comes from the composer owner's user setting
      // (askQuestionAutoAnswerTimeoutMinutes: 0 = disabled, up to 1 hour), falling
      // back to the cloudAgentAskQuestionDefaultTimeoutMs persistent config. Also
      // gates the timeout picker in the portal Cloud Agents settings, which reads
      // it client-side via useGateValue, so this must be client-available. Default
      // OFF preserves indefinite blocking.
      cloud_agent_ask_question_auto_answer: {
        client: true,
        default: false
      },
      // Controls whether the user-facing "Auto-Answer Timeout" configuration
      // control shows up in the portal Cloud Agents settings (the Questions
      // section / timeout picker). Read client-side via useGateValue, so it must
      // be client-available. When OFF (the default for everyone) the picker is
      // hidden and the effective timeout falls back to the server default; when ON
      // the user can configure the ask_question auto-answer timeout themselves.
      // Independent from `cloud_agent_ask_question_auto_answer`, which enables the
      // underlying auto-answer behavior.
      cloud_agent_ask_question_auto_answer_timeout_setting: {
        client: true,
        default: false
      },
      cloud_agent_stale_environment_workflow: {
        client: true,
        default: true
      },
      // Gates the read-only environment builds dashboard in the portal (builds
      // tab on the environment detail page + build detail page) and its backing
      // ListEnvironmentBuilds / GetEnvironmentBuild RPCs.
      cloud_agent_builds_page: {
        client: true,
        default: true
      },
      // Portal-only: show the Builds-tab "Check with an agent" / "Run setup agent"
      // card that launches the migrate-to-builds setup agent. Independent of
      // cloud_agent_stale_environment_workflow so the card can be killed without
      // disabling builds / migrate skill / MCP tools. Default off.
      cloud_agent_migrate_to_builds_setup_agent_cta: {
        client: true,
        default: false
      },
      cloud_agent_transcript_reliability_controls: {
        client: true,
        default: true
      },
      local_agent_transcript_search_in_glass: {
        client: true,
        default: true
      },
      // Gates the model-visible SearchConversations tool separately from the index
      // and palette UI because transcript snippets cross a different boundary.
      agent_conversation_search_tool: {
        client: true,
        default: false
      },
      // Kill switch for cached-cloud FTS metadata and body indexing in Glass. Local
      // SQLite search and in-renderer cloud metadata matching remain active.
      disable_cloud_agent_transcript_indexing_in_glass: {
        client: true,
        default: false
      },
      nal_agent_retries: {
        client: true,
        default: true
      },
      cli_harness_telemetry: {
        client: true,
        default: false
      },
      cli_image_arg: {
        client: true,
        default: false
      },
      "x-chat-context": {
        client: true,
        default: false
      },
      referral_codes_v2: {
        client: true,
        default: true
      },
      p2p_referrals_v1: {
        client: true,
        default: true
      },
      disk_usage_monitor: {
        client: true,
        default: false
      },
      oom_crash_watcher: {
        client: true,
        default: false
      },
      local_request_tracing: {
        client: true,
        default: false
      },
      local_request_trace_dd_slogs: {
        client: true,
        default: false
      },
      /** @deprecated Retained for released clients; new clients use memory_monitor_config. */
      memory_pressure_profiling: {
        client: true,
        default: true
      },
      // Anysphere-internal-only CPU monitor: detects sustained high CPU usage
      // across the Cursor process tree and offers to capture and upload a process
      // snapshot (similar to the memory monitor's heap snapshot flow). The client
      // additionally requires the server-provided internal/dev flag, so enabling
      // this gate for external users has no effect. Default OFF; tuned via the
      // `cpu_monitor_config` dynamic config.
      cpu_monitor_process_snapshot: {
        client: true,
        default: false
      },
      issue_traces_enabled: {
        client: true,
        default: true
      },
      glass_automations_ui: {
        client: true,
        default: true
      },
      // Default OFF preserves the pre-change count-suffixed VirtualizedDiff group key.
      glass_stable_diff_group_keys: {
        client: true,
        default: false
      },
      local_automations: {
        client: true,
        default: false
      },
      local_automations_nav: {
        client: true,
        default: false
      },
      // Enables the opt-in agent confetti cannon in Glass settings and cursor-app-control MCP.
      // Intentionally not created in Statsig yet; local overrides are used during development.
      glass_agent_confetti_cannon: {
        client: true,
        default: false
      },
      glass_install_plugin_tool_enabled: {
        client: true,
        default: false
      },
      cursor_backend_control_automation_mcp: {
        client: true,
        default: true
      },
      glass_configure_multi_root_option: {
        client: true,
        default: true
      },
      glass_multi_root_workspace_editing: {
        client: true,
        default: false
      },
      // Enables same-workspace connection repair for Glass Remote SSH reconnects.
      glass_remote_ssh_workspace_repair: {
        client: true,
        default: true
      },
      // Enables replacing management connections after server-side token loss during Glass Remote SSH repair.
      glass_remote_ssh_management_connection_token_loss_repair: {
        client: true,
        default: true
      },
      // Enables in-place workspace connection repair for Glass cloud agent (background composer) reconnects,
      // including management-connection replacement after server-side reconnection-token loss.
      glass_cloud_agent_workspace_repair: {
        client: true,
        default: false
      },
      // Enables the Glass workspace transport reconcile loop: optimistic promotion from
      // resolver data, background transport probes, and automatic gated authority repair
      // while a remote workspace is reconnecting or disconnected.
      glass_workspace_transport_reconcile: {
        client: true,
        default: true
      },
      // Shows resolver progress phases and a Cancel affordance in the Glass editor
      // panel's connecting UI.
      glass_workspace_connecting_ui: {
        client: true,
        default: true
      },
      glass_cloud_agent_early_workspace_materialization: {
        client: true,
        default: false
      },
      // Do not create a cloud agent workspace until `workspaceFactory.load()` is
      // called. The subagent preview only needs transcript data.
      glass_defer_cloud_workspace_materialization: {
        client: true,
        default: false
      },
      glass_custom_theme_support: {
        client: true,
        default: false
      },
      environment_param_for_subagent: {
        client: true,
        default: false
      },
      glass_assistant_message_selection_feedback: {
        client: true,
        default: false
      },
      glass_editor_panel_tab_copy_link: {
        client: true,
        default: false
      },
      glass_peaky_file_trees: {
        client: true,
        default: false
      },
      enable_glass_supplemental_sidebar: {
        client: true,
        default: false
      },
      conversation_table_of_contents: {
        client: true,
        default: false
      },
      // Shows the Save CTA on Glass's environment-setup save-ready composer tray
      // (parity with web). Off by default for gradual rollout / metric impact.
      save_button_glass_env_setup: {
        client: true,
        default: false
      },
      glass_status_bar_environment_picker: {
        client: true,
        default: false
      },
      glass_status_bar_environment_picker_move_to_parity: {
        client: true,
        default: false
      },
      glass_agent_branch_status_picker: {
        client: true,
        default: false
      },
      glass_all_changes_diff_scope: {
        client: true,
        default: false
      },
      glass_scm_dynamic_base_branch: {
        client: true,
        default: false
      },
      glass_direct_github_connect: {
        client: true,
        default: false
      },
      scm_connect_in_app_ad: {
        client: true,
        default: false
      },
      scm_connect_in_app_ad_gitlab: {
        client: true,
        default: false
      },
      // Routes the connect-SCM ad's eligibility checks through the cheap, cached
      // GetScmConnectionStatus probe instead of skipCache GetGithubAccessTokenForRepos
      // token minting (sev-1340). OFF reproduces the legacy behavior exactly.
      scm_connect_ad_cheap_probe: {
        client: true,
        default: false
      },
      glass_last_turn_diff_scope: {
        client: true,
        default: false
      },
      import_cc_conversation: {
        client: true,
        default: true
      },
      /**
       * Empty-state CTA + import modal UI. Requires `import_cc_conversation` as
       * well; Settings / actual import stay on the underlying import gate alone.
       */
      import_cc_conversation_modal: {
        client: true,
        default: true
      },
      import_cc_conversation_default: {
        client: true,
        default: false
      },
      glass_drafts_quick_action_pill: {
        client: true,
        default: false
      },
      glass_sidebar_source_metadata: {
        client: true,
        default: false
      },
      glass_sidebar_recency_filter: {
        client: true,
        default: false
      },
      glass_sidebar_group_ordering: {
        client: true,
        default: false
      },
      /**
       * When grouping by Status, fold unread done agents into Needs Attention
       * (iOS-aligned). Flag off leaves unread done agents in Done.
       */
      glass_sidebar_status_unread_section: {
        client: true,
        default: false
      },
      glass_sidebar_scroll_active_row_if_needed: {
        client: true,
        default: true
      },
      /**
       * Top-level Archive icon in the Glass sidebar action strip (between customize
       * and Open Workspace). When off, Archived stays in the customize/filter menu.
       */
      glass_sidebar_archive_toggle: {
        client: true,
        default: false
      },
      glass_btw_side_question: {
        client: true,
        default: false
      },
      /**
       * Durable side chats in Glass: spin off a persistent, non-blocking side
       * conversation tied to the current agent (rendered as an editor-panel tab).
       * Supersedes the ephemeral `/btw` overlay when enabled.
       */
      glass_side_chats: {
        client: true,
        default: true
      },
      /**
       * Gates cloud `/side` creation and Glass rediscovery; existing chats
       * reappear when re-enabled.
       */
      cloud_agent_side_chats: {
        client: true,
        default: false
      },
      /**
       * Present durable Glass side chats as tabs in the agent conversation header
       * instead of editor-panel Side Chat tabs. `glass_side_chats` remains the
       * existence gate; this flag only changes presentation.
       */
      glass_chat_tabs: {
        client: true,
        default: false
      },
      /**
       * Markdown list editing in Glass prompt inputs: `- ` / `1. ` auto-convert
       * to bullet/numbered lists with native Tab/Shift-Tab indent handling and
       * plain-text list serialization on submit.
       */
      glass_composer_markdown_support: {
        client: true,
        default: false
      },
      /**
       * Freehand annotation on PromptInput attached images (Glass, composer
       * message edit, Cursor Review). When off, the image lightbox stays
       * available without a drawing canvas.
       */
      prompt_input_image_annotation: {
        client: true,
        default: false
      },
      /**
       * Split editor-panel tabs into tiles in Glass: each tile hosts its own tab
       * strip, tabs can be dragged out to create new tiles or between tiles.
       * When off, the persisted panel layout is ignored and tabs render flat.
       */
      glass_split_tabs: {
        client: true,
        default: false
      },
      /**
       * Keep the most recently selected Glass single-pane agent transcripts
       * mounted (hidden) across chat switches instead of unmounting the surface
       * on every switch.
       */
      glass_agent_surface_keepalive: {
        client: true,
        default: false
      },
      glass_lazy_file_tabs: {
        client: true,
        default: false
      },
      glass_agent_projects_ui: {
        client: true,
        default: false
      },
      /** Resume recently interrupted local Glass agents when the client relaunches. */
      glass_auto_continue_interrupted_agents: {
        client: true,
        default: true
      },
      /** Kill-switch for Glass relaunch subagent continue (background recover + preload so parent replay reattaches instead of spawning duplicates). */
      glass_auto_continue_interrupted_subagents: {
        client: true,
        default: true
      },
      glass_projects_enabled: {
        client: true,
        default: false
      },
      /**
       * Forces the Remote Control user toggle on (stored setting OR this gate).
       * Console-targeted at Cloud Projects users; team allow, allowlist, plan,
       * and worker-extension availability checks still apply downstream.
       */
      internal_cloud_project_remote_control: {
        client: true,
        default: false
      },
      /** Opens the Glass New Project creation flow as a full-screen page. */
      glass_new_project_fullscreen: {
        client: true,
        default: false
      },
      /**
       * Glass Chats-section rollout. Owns the one-time Chats reset (Updated
       * grouping + Updated agent sort, per-row Updated stamp off) and the Chats
       * presentation it resets into.
       *
       * Turning this on applies the reset once per profile and never again;
       * turning it back off does not undo it or re-arm it. Full rollout semantics
       * live in `vscode/.../glass-sidebar/chats-section-reset.ts`.
       */
      glass_chats_section_reset: {
        client: true,
        default: false
      },
      /**
       * Agents UI: present Glass Projects as Agents (sidebar section header, the
       * singular noun on the app tab and sidebar rail entry, and the create call to
       * action). Naming only — nothing about what a Project is or does changes, and
       * flags, storage keys, and telemetry keep the `Project` name.
       *
       * Every renamed surface is itself behind `glass_projects_enabled`, so this
       * gate is read on its own rather than ANDed with Projects; scope the rollout
       * to the Projects population in the console.
       */
      glass_projects_as_agents: {
        client: true,
        default: false
      },
      /**
       * Bubble-card presentation for Project send_message replies (card chrome,
       * opposed layout, per-message actions). Presentation only — tool exposure
       * and transcript normalization stay on when this is off.
       */
      glass_project_send_message_bubbles: {
        client: true,
        default: false
      },
      /**
       * Clickable "Create a project" empty state in the Glass Projects sidebar
       * section, shown when the section is enabled but has no project rows.
       */
      glass_projects_empty_state: {
        client: true,
        default: false
      },
      /** Unread divider and jump pill in Glass Project parent conversations. */
      glass_projects_unread_divider: {
        client: true,
        default: false
      },
      /**
       * Recents strip above the full file tree on the Glass Project Context tab.
       * When off, the existing tree is unchanged.
       */
      glass_project_context_recents: {
        client: true,
        default: false
      },
      /**
       * Gates the shared React fullscreen video player and cloud-agent video
       * annotations in Glass. When off, artifact videos use the legacy Solid
       * fullscreen player and skip annotation loading.
       */
      glass_video_player_parity: {
        client: true,
        default: true
      },
      agent_projects_prototype: {
        client: true,
        default: false
      },
      /**
       * Local interactive-child inbox: when an interactive parent-grounded child
       * (project thread, side chat) finishes a user-requested turn, the client
       * writes a result record into the parent's local Agent Inbox and surfaces
       * unseen entries as a path-only reminder on the parent's next real user
       * submit — the local mirror of the cloud resource-child inbox. Client-only.
       */
      local_interactive_child_inbox: {
        client: true,
        default: false
      },
      // Deprecated: fully launched. The VS Code client always treats this as
      // enabled; entry kept as a safety net for older clients.
      glass_diff_ci_tab: {
        client: true,
        default: true
      },
      managed_review_agent_skills_enabled: {
        client: true,
        default: false
      },
      // Deprecated: fully launched. The VS Code client always treats this as
      // enabled; entry kept as a safety net for older clients.
      glass_diff_commits_tab: {
        client: true,
        default: true
      },
      // Deprecated: fully launched. The VS Code client always treats this as
      // enabled; entry kept as a safety net for older clients.
      glass_diff_reviews_tab: {
        client: true,
        default: true
      },
      // Glass: offer Cloud / Remote Control as migration targets for worktree
      // agents ("Continue on" picker, /remote-control, mobile-initiated remote
      // control). The worktree-to-cloud pipeline strategy itself is not gated.
      glass_worktree_to_cloud: {
        client: true,
        default: true
      },
      // Local→cloud migration: if Git preparation fails for a single-repository
      // migration, allow the user to continue with conversation context only.
      // Default OFF preserves the existing hard-failure path.
      glass_local_to_cloud_git_transfer_fallback: {
        client: true,
        default: false
      },
      // Cloud→local migration: when the branch checkout still hard-fails after
      // the deterministic recoveries, land the migration and hand the failure to
      // the migrated agent as a simulated checkout-branch message instead of
      // failing the whole move.
      glass_agentic_migration_reconcile: {
        client: true,
        default: false
      },
      // Glass: offer worktrees as migration targets for cloud agents — the
      // "Continue on" picker gains a Worktree submenu (existing worktrees + New
      // Worktree) and "Move to" menus list the same targets. The
      // cloud-to-worktree pipeline strategy itself is not gated.
      glass_cloud_to_worktree: {
        client: true,
        default: true
      },
      // Per-file "Viewed" toggle in the Glass PR tab Files Changed list.
      glass_pr_viewed: {
        client: true,
        default: true
      },
      glass_pr_tab_v2: {
        client: true,
        default: false
      },
      glass_pr_realtime_updates: {
        client: true,
        default: false
      },
      // Read-only Glass PR stack navigator (`N of M` popover) plus the
      // `SCMService.GetPullRequestStack` fetch that feeds it. Default off so we can
      // disable both client UI/fetch and the backend endpoint if anything goes
      // wrong. Create via scripts/create-statsig-gate.sh glass_pr_stack_navigator.
      glass_pr_stack_navigator: {
        client: true,
        default: false
      },
      glass_cursor_tab: {
        client: true,
        default: true
      },
      glass_avoid_secondary_scanline: {
        client: true,
        default: false
      },
      /** Sub-flag: include skill-invocation pills in auto-suggested quick actions. */
      glass_auto_suggested_quick_actions_skills: {
        client: true,
        default: false
      },
      /** Show the skill-pinning ellipsis button in the Glass follow-up header. */
      glass_pinned_skills_ellipsis_button: {
        client: true,
        default: false
      },
      /** Suggest pinned skills from keywords typed in the Glass prompt. */
      glass_skill_keyword_nudges: {
        client: true,
        default: false
      },
      /** Glass follow-up pill to continue working after agent pauses (e.g., SSH disconnects). */
      glass_continue_working_pill: {
        client: true,
        default: true
      },
      glass_open_resource_tool_enabled: {
        client: true,
        default: true
      },
      open_github_pr_links_in_review_cursor: {
        client: true,
        default: false
      },
      // Phase-21 pr-page-portal-web migration gates. Client emitters (VS Code /
      // Glass) require BOTH to emit cursor.com portal PR links, matching the
      // portal-website emitter convention (useCursorPortalReviewLinksEnabled):
      // `cursor_com_review_redirects` is the migration kill switch (ships dark;
      // per-owner enablement rides on its Statsig targeting), and
      // `cursor_com_review_pages` alone is not a safe emitter condition because
      // that admission gate is already on for canary cohorts whose portal PR
      // routes do not render PRs yet.
      cursor_com_review_redirects: {
        client: true,
        default: false
      },
      cursor_com_review_pages: {
        client: true,
        default: false
      },
      show_cursor_review_early_access_ad: {
        client: true,
        default: false
      },
      smart_allowlist_required: {
        client: true,
        default: false
      },
      // Collapses the Bugbot dashboard setup into a single action for usage-based
      // (TOKEN) team admins: when ON, connecting GitHub (or clicking Enable when
      // already connected) enables the team plan + all repos in one step, with no
      // separate enable modal. Scoped to usage-based team admins; Pro individuals,
      // SEAT, and enterprise are out of scope and keep the explicit enable modal.
      // Read in the portal via useGateValue in bugbot/index.tsx. Default OFF so it
      // is dark-launchable. Bucket on teamID in the Statsig console.
      bugbot_connect_repo_implicit_enable: {
        client: true,
        default: false
      },
      // Team onboarding defaults — bucket on teamID in Statsig console.
      // Checked ONLY on the frontend (portal `useBugbotOnboardingDefaultsTreatment`)
      // so the experiment has a single exposure path; the portal forwards the
      // treatment decision to the backend (no backend `checkGate`). Pro/individual
      // users are out of scope. `client: true` so the portal client SDK serves it.
      bugbot_onboarding_high_effort_learning_defaults_team_v2: {
        client: true,
        default: true
      },
      bugbot_suggested_repos_banner: {
        client: true,
        default: true
      },
      // Growth experiment: let non-admin team members enable Bugbot on team-owned
      // repos via the per-repo enable path, instead of dead-ending on the
      // admin-only gate. GitHub-only (dotcom + GHE); GitLab/Azure/Bitbucket stay
      // admin-only because enable requires webhook/service-account setup. Only
      // relaxes when the team kill switch (bugbotTeamSettings.bugbotGloballyDisabled)
      // is off; admins keep the kill switch and installation-wide defaults stay
      // admin-only. Enterprise teams are excluded in code (kept on the admin-only
      // control). Read server-side in dashboardScmRepositoryHandlers (per-repo
      // enable authorization) and in the portal via useGateValue to switch the CTA
      // between enable and request. Default OFF (dark-launchable). Bucket on
      // teamID in the Statsig console.
      bugbot_non_admin_enablement: {
        client: true,
        default: true
      },
      use_model_parameters: {
        client: true,
        default: true
      },
      cloud_agent_default_model_picker: {
        client: true,
        default: true
      },
      // Exposes structured Auto Smart Optimize For variants in the Cloud Agent
      // default model picker. Runtime support must deploy before this gate rolls out.
      cloud_agent_default_auto_modes: {
        client: true,
        default: true
      },
      use_react_model_picker: {
        client: true,
        default: true
      },
      model_picker_max_badge: {
        client: true,
        default: false
      },
      model_picker_hover_options: {
        client: true,
        default: false
      },
      model_picker_hide_max_mode_token_users: {
        client: true,
        default: true
      },
      bugbot_auto_spawn_cloud_agent: {
        client: true,
        default: true
      },
      // Bugbot Frontier: a user-selectable mode that runs Bugbot as a diverse
      // multi-model ensemble (planner + richer context). Gated so it can be scoped
      // to specific teams via Statsig targeting (rule on the teamID custom field);
      // client:true so the dashboard can show the Frontier option.
      bugbot_frontier: {
        client: true,
        default: false
      },
      bugbot_fail_check_on_findings: {
        client: true,
        default: false
      },
      vscode_text_model_telemetry: {
        client: true,
        default: false
      },
      composer_auto_routing_result_display: {
        client: true,
        default: false
      },
      // Shared backend/portal rollout for economics-based Premium seat
      // recommendations. Evaluation supplies teamID as a custom ID so rules can
      // target teams; portal gate-off keeps the legacy page-scoped heuristic.
      seat_upgrade_economics_recommendations: {
        client: true,
        default: true
      },
      self_serve_team_tiered_pricing_conversion: {
        client: true,
        default: true
      },
      self_serve_team_tiered_pricing_manual_conversion: {
        client: true,
        default: true
      },
      self_serve_team_tiered_pricing_new_team_creator: {
        client: true,
        default: true
      },
      // Rollout gate for the combined tokens-and-tiered conversion of legacy
      // request-priced self-serve teams (teamID-targetable). When ON for a team,
      // the tiered-pricing preview/convert endpoints route it through the
      // combined path that persists pricing_strategy=tokens and enables tiered
      // pricing in one transaction; when OFF, those teams keep today's
      // "Only token-priced self-serve teams" rejection. `client: true` because
      // the Grok Bot onboarding wizard reads the same gate to decide between
      // offering the combined switch and showing the request-pricing blocker
      // without firing a doomed preview; the backend still enforces the gate
      // (plus the sand_onboarding request origin) on both endpoints.
      self_serve_team_tiered_pricing_legacy_conversion: {
        client: true,
        default: false
      },
      enable_spend_alerts_percentage_threshold: {
        client: true,
        default: true
      },
      composer_enable_bga_hydration_from_snapshot: {
        client: true,
        default: true
      },
      composer_header_typed_table: {
        client: true,
        default: true
      },
      composer_lazy_inline_checkpoints: {
        client: true,
        default: false
      },
      glass_composer_header_pagination: {
        client: true,
        default: false
      },
      cursor_blame: {
        client: true,
        default: false
      },
      cursor_skill_enabled: {
        client: true,
        default: false
      },
      onboard_skill_enabled: {
        client: true,
        default: false
      },
      ai_attribution_tool: {
        client: true,
        default: false
      },
      pr_metrics_admin_view_override: {
        client: true,
        default: false
      },
      portal_pr_code_tour: {
        client: true,
        default: false
      },
      portal_pr_activity: {
        client: true,
        default: false
      },
      enable_ex_hs: {
        client: true,
        default: true
      },
      stars_popup_ignore_dont_ask_again: {
        client: true,
        default: false
      },
      terminal_execution_service_2: {
        client: true,
        default: true
      },
      long_running_jobs: {
        client: true,
        default: true
      },
      background_nudge_2: {
        client: true,
        default: true
      },
      auto_background_foreground_tools_on_followup: {
        client: true,
        default: false
      },
      user_message_timestamps: {
        client: true,
        default: true
      },
      terminal_ui_2: {
        client: true,
        default: true
      },
      composer_protected_tooltip: {
        client: true,
        default: true
      },
      auto_open_review_during_plan_build: {
        client: true,
        default: false
      },
      analyze_query_intent: {
        client: true,
        default: false
      },
      mcp_allowlists: {
        client: true,
        default: true
      },
      allowlist_in_ask_every_time_mode: {
        client: true,
        default: false
      },
      analytics_output_channel: {
        client: true,
        default: false
      },
      // Raises the AnalyticsService eager-flush watermark (the queue length that
      // triggers an immediate microtask batch flush) from 3 to 10 when ON, coalescing
      // chatty sessions into ~3x fewer eager batch RPCs. The 60s flush timer is
      // unchanged, so freshness stays bounded. Default false = current behavior.
      analytics_batch_coalesce_watermark: {
        client: true,
        default: false
      },
      browser_features_access_control: {
        client: true,
        default: false
      },
      cli_sandbox_default_enable: {
        client: true,
        default: false
      },
      cli_auto_run_hint: {
        client: true,
        default: true
      },
      "cli.hints": {
        client: true,
        default: true
      },
      "cli.rewind": {
        client: true,
        default: true
      },
      cli_debug_mode: {
        client: true,
        default: true
      },
      cli_btw_side_question: {
        client: true,
        default: true
      },
      cli_model_picker: {
        client: true,
        default: true
      },
      // Zen mode in agent-cli: compact one-line tool call rendering. When the
      // gate is on, zen defaults on and /zen-mode toggles it; when off, zen is
      // forced off and the command/setting are hidden.
      cli_zen_mode_available: {
        client: true,
        default: false
      },
      // Inline image previews in agent-cli: render attached images and successful
      // GenerateImage results as real pictures in graphics-capable terminals
      // (kitty family / iTerm2). Acts as a kill switch — defaults on and falls back
      // to the `[Image #N]` text token wherever the protocol/terminal is unsupported.
      cli_show_images: {
        client: true,
        default: true
      },
      /**
       * Read-surface gate for the team-dashboard PR-metrics widgets (PR velocity,
       * PR cycle time, merged PRs by engineer). When ON for the caller, the
       * portal dashboard fetches the three /analytics/team/pr-metrics/* endpoints
       * and the backend widgets serve real data; when OFF, the frontend skips
       * the fetch and the backend short-circuits to an empty response. ANDed
       * with `github_webhook_analytics_enabled` (the ingestion master switch) on
       * both sides, so flipping either disables the read path. Previously a
       * Statsig-only gate read by the portal; registering here per the
       * `statsig-register-experiments-in-config` workspace rule so the backend
       * `checkGate` call typechecks against `FlagName`.
       */
      pr_analytics: {
        client: true,
        default: false
      },
      /**
       * Gates the Cursor Organization <-> xAI team billing link + credit
       * transfer integration (org admin xAI Console, the link/unlink/transfer
       * RPCs, and the start-link flow that mints callback states). When OFF: the
       * portal hides the integration and the RPCs reject, which also starves the
       * partner callback of valid states. Standard userID-style gate (email /
       * segment rules, like org_billing_admin_role) — not an organizationID
       * idType gate; the unsigned browser callback deliberately does not re-check
       * it. `client: true` because the portal reads it via useGateValue.
       */
      xai_team_link: {
        client: true,
        default: false
      },
      /** Gate loading of plugins from Claude Code. When off, CC plugin load returns empty. */
      enable_cc_plugin_import: {
        client: true,
        default: true
      },
      /** Show model picker contextual nudge (blue dot). InAppAdService tracks seen state. */
      model_picker_nudge: {
        client: true,
        default: false
      },
      terminal_ide_shell_exec: {
        client: true,
        default: true
      },
      cloud_agent_origin_repos: {
        client: true,
        default: false
      },
      // Agent-launch picker: New Project. Origin mint still requires
      // cloud_agent_origin_repos + team + a non-empty GetRepoNamespace.
      cloud_agent_new_project_entrypoint: {
        client: true,
        default: false
      },
      // Gates whether the public start RPC honors the client-supplied
      // `disable_pr_management_tool` flag (which drops the ManagePullRequest tool
      // from a codebase-only agent's tool surface). Off strips the flag fail-closed.
      codebase_browse_ask_cursor: {
        client: true,
        default: false
      },
      // Gates the unified-repo "Creation Provider" setting (which forge pull
      // requests are created on for repos mirrored between GitHub and Origin):
      // the dashboard setting's visibility/writes and whether the preference
      // affects PR creation and preferred-PR-host guidance. Repo pickers only
      // require cloud_agent_origin_repos for Origin to be selectable at all.
      enable_forge_source_pr_creation_setting: {
        client: true,
        default: false
      },
      // Pins the effective Creation Provider to Origin, overriding stored
      // user/team preferences. Read by the backend preference resolver (behavior)
      // and client-side by the dashboard Creation Provider cell (locks the
      // control). Only takes effect while
      // enable_forge_source_pr_creation_setting and cloud_agent_origin_repos are
      // also enabled.
      origin_dogfooding_cursor_creation_provider_override: {
        client: true,
        default: false
      },
      marketplace_origin_distribution: {
        client: true,
        default: false
      },
      // Multi MCP Auth. MUST stay off until the contract migration drops the
      // legacy (user_id, server_url) unique index; a second slot per server
      // violates it. client: true — Sand mirrors the gate.
      mcp_multi_account: {
        client: true,
        default: false
      },
      // Store the disabled state of global (non-project-managed) MCP servers in
      // profile-scoped storage shared across all workspaces and MCP services,
      // instead of per-workspace storage. Includes the one-time migration of
      // legacy workspace-scoped entries. Off keeps the legacy per-workspace
      // disabled state for all servers.
      mcp_profile_scoped_global_disabled_state: {
        client: true,
        default: false
      },
      team_mcps_in_ide: {
        client: true,
        default: false
      },
      team_mcps_in_cli: {
        client: true,
        default: false
      },
      remote_permissions_file_path_admin: {
        client: true,
        default: false
      },
      // Admin-managed shell command denylist. Initially targeted to NVIDIA via
      // the Statsig `teamID` custom ID; default-off for every other team.
      admin_command_denylist: {
        client: true,
        default: false
      },
      // Recovery lever for the Admin Command Denylist. Enforcement of stored
      // rules is deliberately NOT gated on the authoring flag above (a Statsig
      // outage must not fail open), so this inverted kill switch is the only
      // remote control over enforcement: OFF — the default, an unconfigured
      // gate, or an unreachable Statsig — means enforcement is active; turn it
      // ON to suspend denylist enforcement across all surfaces without shipping
      // a client.
      admin_command_denylist_enforcement_killswitch: {
        client: true,
        default: false
      },
      restrict_team_member_invite_button: {
        client: true,
        default: false
      },
      editor_bugbot: {
        client: true,
        default: true
      },
      bugbot_autorun_killswitch: {
        client: true,
        default: false
      },
      keybinding_migration_killswitch: {
        client: true,
        default: false
      },
      agent_review_fake_dev: {
        client: true,
        default: false
      },
      enable_moved_lines_treatment: {
        client: true,
        default: false
      },
      bugbot_editor_markers: {
        client: true,
        default: false
      },
      bugbot_editor_autorun_on_composer_finish: {
        client: true,
        default: false
      },
      ide_cmd_enter_submit: {
        client: true,
        default: true
      },
      ide_nal_migration: {
        client: true,
        default: false
      },
      ide_new_sidebar: {
        client: true,
        default: false
      },
      playwright_mcp_provider: {
        client: true,
        default: true
      },
      web_audit_events: {
        client: true,
        default: false
      },
      web_cloud_agent_followup_model_picker: {
        client: true,
        default: true
      },
      web_cloud_agent_new_model_picker: {
        client: true,
        default: false
      },
      // Gates landing the user directly in the new agent's run view on kickoff
      // (portal /agents composer) instead of staying on the list. Default-off.
      web_cloud_agent_kickoff_lands_in_run_view: {
        client: true,
        default: true
      },
      web_cloud_agent_external_source_attachment: {
        client: true,
        default: true
      },
      // Portal individual desktop-web onboarding v2 (/onboarding?source=web).
      // Read via useWebOnboardingV2Gate in portal-website; keep default-off until
      // the Statsig gate is created and ramped.
      web_individual_onboarding_v2: {
        client: true,
        default: false
      },
      "web.show_local_source_filter": {
        client: true,
        default: false
      },
      open_agent_window_bottom_convo: {
        client: true,
        default: false
      },
      open_agent_window_top: {
        client: true,
        default: true
      },
      "glass.enable_open_agent_in_window": {
        client: true,
        default: false
      },
      cloud_agent_best_of_n_disabled: {
        client: true,
        default: false
      },
      cloud_agent_prompt_upload_presign: {
        client: true,
        default: false
      },
      search_telemetry: {
        client: true,
        default: false
      },
      scim_require_user_directory_ui: {
        client: true,
        default: false
      },
      // Exception gate (Statsig unit teamID) that re-enables creating NEW legacy
      // billing groups from the unified Members | Groups UI. Default OFF: the
      // unified surface hides "Create new billing group" for everyone. When ON for
      // a team, the create option appears in the legacy Billing Groups section, but
      // ONLY for teams that already have >=1 billing group (both the portal and the
      // createGroup RPC enforce the existing-groups requirement). Managing/updating/
      // deleting existing billing groups does not depend on this gate. Read from the
      // portal client (useGateValue) and server-side in DashboardService.createGroup.
      allow_legacy_billing_group_creation: {
        client: true,
        default: false
      },
      new_file_ux: {
        client: true,
        default: true
      },
      internal_browser_evaluate: {
        client: true,
        default: false
      },
      // Deprecated: fully launched. The VS Code client always treats this as
      // enabled; entry kept as a safety net for older clients and for the
      // packages/agent-cli surfaces that still read it.
      browser_canvas: {
        client: true,
        default: true
      },
      composer_separate_shell_activity_groups: {
        client: true,
        default: false
      },
      show_grouped_edit_diff_stats: {
        client: true,
        default: false
      },
      composer_end_of_turn_summary: {
        client: true,
        default: false
      },
      // Shows agent-store Notes in a Project coordinator's reserved EOT footer.
      glass_project_notes_end_of_turn: {
        client: true,
        default: false
      },
      allowlist_toggle_menu: {
        client: true,
        default: true
      },
      slim_codeblock_render: {
        client: true,
        default: true
      },
      compact_terminal: {
        client: true,
        default: true
      },
      composer_sandbox_settings_visible: {
        client: true,
        default: true
      },
      sandbox_force_disable_win32: {
        client: true,
        default: true
      },
      admin_network_controls: {
        client: true,
        default: true
      },
      mcp_access_network_allowlist: {
        client: true,
        default: false
      },
      mcp_admin_only_servers: {
        client: true,
        default: false
      },
      mcp_admin_only_tools: {
        client: true,
        default: false
      },
      sandbox_mcp_servers: {
        client: true,
        default: false
      },
      // Client/IDE Agent Read Access (user-local System/Workspace + allowlist).
      sandbox_read_control_portal: {
        client: true,
        default: false
      },
      // Team-admin Agent Read Access in the dashboard. Off = panel hidden and
      // admin-settings won't persist the team boundary (client can still ship).
      sandbox_read_control_portal_ui: {
        client: true,
        default: false
      },
      mcp_network_allowlist: {
        client: true,
        default: false
      },
      mcp_settings_overhaul: {
        client: true,
        default: true
      },
      mcp_settings_overhaul_portal: {
        client: true,
        default: true
      },
      cloud_agent_environment_mcp_allowlist: {
        client: true,
        default: false
      },
      cursor_rules_batch_update: {
        client: true,
        default: true
      },
      agent_skills_batch_update: {
        client: true,
        default: true
      },
      mcp_structured_logging: {
        client: true,
        default: false
      },
      mcp_runtime_dedupe: {
        client: true,
        default: false
      },
      dedupe_mcp_servers: {
        client: true,
        default: true
      },
      mcp_oauth_unsafe_redirect_logging: {
        client: true,
        default: false
      },
      proper_well_known_for_mcp_scopes: {
        client: true,
        default: true
      },
      // Deprecated: fully launched. The VS Code client always treats this as
      // enabled; entry kept as a safety net for older clients.
      context_visualizer: {
        client: true,
        default: true
      },
      context_usage_canvas: {
        client: true,
        default: false
      },
      browser_mcp_chip: {
        client: true,
        default: true
      },
      playwright_autorun: {
        client: true,
        default: true
      },
      allow_download_prompts: {
        client: true,
        default: false
      },
      // Mid-run context injection (steering): client gate for the Steer /
      // Follow-up queue UI and admission; the server side checks the same gate.
      // See docs/rfcs/RFC-agent-active-context-injection.md.
      agent_context_injection: {
        client: true,
        default: false
      },
      // Independent client rollout control for auto-promoting active local root
      // Project follow-ups through the existing context-injection transport.
      project_followups_use_steering: {
        client: true,
        default: false
      },
      cloud_agent_docker_build_secrets_enabled: {
        client: true,
        default: true
      },
      clone_blob_upload: {
        client: true,
        default: true
      },
      internal_session_recording_status_bar: {
        client: true,
        default: false
      },
      // Routes Gemini video attachments through the presigned-PUT signed-URL
      // path (server-side mints S3 URL + uploads, IDE/Glass later moves to
      // direct PUT) instead of inline base64 in the agent request body. Off
      // by default until the Glass-side IDE-direct uploader lands; flipping
      // this gate today only changes where the bytes hit S3, not the 50MB
      // Fastify request-body ceiling.
      agent_video_signed_url_uploads: {
        // Read on the client too: the IDE/Glass video-attach send path branches
        // between inline bytes and the signed-URL PUT flow based on this gate.
        client: true,
        default: false
      },
      // Routes built-in Gemini video subagents through the Developer API Files
      // path, including the larger signed-URL attachment limit and Cursor's
      // Google AI Studio credential. Keep disabled until the backend and client
      // changes have landed.
      gemini_video_developer_api: {
        client: true,
        default: false
      },
      nal_task_tool: {
        client: true,
        default: true
      },
      explore_subagent: {
        client: true,
        default: true
      },
      enable_watch_video_in_ide: {
        client: true,
        default: true
      },
      shell_subagent: {
        client: true,
        default: true
      },
      enable_build_with_swarm: {
        client: true,
        default: false
      },
      explicit_subagent_models: {
        client: true,
        default: false
      },
      nal_trace: {
        client: true,
        default: false
      },
      ask_question_all_modes: {
        client: true,
        default: true
      },
      /**
       * Enables durable AskQuestion cloud delivery (tool-call-id resolution +
       * dual-key client submit). Default OFF: both server `checkGate` (fail-closes
       * false) and client FLAGS.default stay false when Statsig is unreachable, so
       * both halves agree on legacy query-id-only until the gate is explicitly ON.
       * Local bubble-native decision bugfixes stay always-on.
       */
      ask_question_durable_delivery: {
        client: true,
        default: false
      },
      disable_terminal_output_ui_streaming: {
        client: true,
        default: false
      },
      generate_user_instructions: {
        client: true,
        default: false
      },
      ide_nal_rdv: {
        client: true,
        default: false
      },
      use_nlb_for_nal: {
        client: true,
        default: true
      },
      "use-usw1-agent-for-nal": {
        client: true,
        default: false
      },
      retry_interceptor_disabled: {
        client: true,
        default: false
      },
      retry_interceptor_enabled_for_streaming: {
        client: true,
        default: true
      },
      bidi_append_fix: {
        client: true,
        default: true
      },
      bidi_append_binary_encoding: {
        client: true,
        default: false
      },
      http1_keepalive_disabled: {
        client: true,
        default: false
      },
      ws_reachability_probe: {
        client: true,
        default: true
      },
      ws_dark_durability_probe: {
        client: true,
        default: false
      },
      large_proto_logging_enabled: {
        client: true,
        default: false
      },
      // Throttles the client structured-log uploader (AnalyticsService.submitLogs):
      // when ON, chatty windows batch to a 150-entry high watermark and backgrounded
      // (unfocused) windows flush every 60s instead of 3s. Default OFF keeps the
      // legacy ~3s/10-entry cadence so the fleet stays on the safe path until this
      // is rolled out in Statsig. Read from the shared cursor-network path used by
      // both Glass and the classic IDE.
      submitlogs_flush_throttle: {
        client: true,
        default: true
      },
      // Throttles the client SubmitSpans flush cadence (TraceSpanService): when ON,
      // a backgrounded (unfocused) window stretches its periodic span flush from
      // ~30s to ~120s, cutting the per-window heartbeat fan-out across Glass + IDE
      // windows. Default OFF keeps every window on the fixed ~30s cadence until this
      // is rolled out in Statsig. Read client-side only (code gate).
      submitspans_flush_throttle: {
        client: true,
        default: false
      },
      // Internal-only access to the Agent SDK framework (packages/agent-serve,
      // published as @cursor/july). Default off = fail closed; target internal
      // teams in the Statsig console.
      agentkit_enabled: {
        client: true,
        default: false
      },
      enterprise_early_access: {
        client: true,
        default: false
      },
      // Gates per-model control within a BYOK provider section of the v2 model
      // allowlist (ENT-2904). When on, an admin who enables a BYOK section (e.g.
      // AWS Bedrock) can additionally restrict it to specific model identifiers via
      // `ModelAllowlistByokEntry.models`; the backend enforces that list in
      // `checkByokBlockedByAllowlist` and the dashboard surfaces the per-model
      // controls. When off (default), the `models` list is ignored and only the
      // section-level `enabled` toggle governs — the original all-or-nothing
      // behavior. `client: true` because the dashboard reads it via `useGateValue`
      // to show/hide the per-model controls. Default off to ramp via Statsig.
      use_byok_allowlist: {
        client: true,
        default: true
      },
      show_prerelease_release_track: {
        client: true,
        default: false
      },
      show_dogfood_release_track: {
        client: true,
        default: false
      },
      client_numeric_metrics: {
        client: true,
        default: true
      },
      solidjs_total_observers_metric: {
        client: true,
        default: false
      },
      renderer_heap_metrics: {
        client: true,
        default: false
      },
      /**
       * Enables the Glass React commit-churn collector's fiber walk and aggregate
       * event. The DevTools hook shim installs regardless of this gate, so the
       * rollout percentage doubles as the collector's sampling rate. Default off.
       */
      glass_react_commit_churn: {
        client: true,
        default: false
      },
      sand_renderer_heap_metrics: {
        client: true,
        default: false
      },
      collect_sample_for_unresponsive_ext_host: {
        client: true,
        default: false
      },
      unresponsive_ext_host_enhanced_attachments: {
        client: true,
        default: false
      },
      enable_project_layouts_in_system_prompt: {
        client: true,
        default: true
      },
      worktree_nal_only: {
        client: true,
        default: true
      },
      glass_precompute_diff_tokenization: {
        client: true,
        default: false
      },
      review_changes_fast_multi_diff: {
        client: true,
        default: false
      },
      cpp_perf_instrumentation: {
        client: true,
        default: true
      },
      hide_titlebar_default: {
        client: true,
        default: false
      },
      migrate_editor_mode: {
        client: true,
        default: true
      },
      show_dev_only_ttft_warning: {
        client: true,
        default: false
      },
      // Sole rollout gate for the review-CTA funnel: the Editor post-commit review
      // CTA (`first_commit_review_cta`) and the post-review Bugbot CTA
      // (`bugbot_github_pr_cta` / `glass_post_review_bugbot_cta` ads) on Glass and
      // Editor surfaces.
      // Server-checked in getCurrentInAppAd; replaces the retired experiment of
      // the same name and supersedes the former `first_commit_review_cta` gate
      // (Greg's allowlist-only rollout) and the never-created
      // `bugbot_github_pr_cta` gate.
      glass_local_review_first_bugbot_cta: {
        client: true,
        default: true
      },
      // Routes the Editor post-commit "Review my code" CTA through the managed
      // /review-bugbot skill. Off preserves the existing Agent Review flow.
      editor_review_cta_uses_review_bugbot: {
        client: true,
        default: false
      },
      // Emergency off switch for the always-on local-commit reflog watcher in
      // cursor-retrieval (`localCommitSignal.ts`), the producer for the post-commit
      // review CTA. Enabling it stops watcher registration on new windows and
      // suppresses `gitCommitWasRun` signals on live ones; worst case the CTA
      // simply never shows.
      local_commit_reflog_signal_killswitch: {
        client: true,
        default: false
      },
      /**
       * Cloud Agents: turn on progressive paged loading of GitLab installation
       * repos for the dashboard repo picker (per-page backend fetch + portal-side
       * `fetchNextPage` loop). Default off; flip per-team starting with large
       * GitLab Enterprise orgs (NVIDIA — see ASYNC-2148). Both backend and
       * frontend branches gate-check, so an off gate is a true no-op.
       */
      gitlab_progressive_repo_load_v1: {
        client: true,
        default: false
      },
      /**
       * Cloud Agents: turn on server-side repository search in the dashboard repo
       * picker (`SharedRepositoryPicker`). When on, typing in the picker's search
       * box fans the paginated `getInstallationRepos` RPC with the `search` term
       * across installations and merges the matches into the candidate list, so
       * users can find repos that haven't been loaded yet (e.g. a repo on page 40
       * of a multi-thousand-repo Azure DevOps org) without waiting for the full
       * list to load. Default off; the picker falls back to client-side filtering
       * of already-loaded repos when off, so an off gate is a true no-op. Roll out
       * per-team starting with large ADO / GitLab orgs (CSG).
       *
       * Caveat — this gate is provider-agnostic: when on it also makes the team's
       * GitHub picker search-first (page-1 + server search instead of load-all) and
       * fires a backend repo fetch per GitHub search keystroke. That is a no-op for
       * single-provider GitLab/ADO teams (the rollout targets — Agoda, Rivian, CSG)
       * because they have no GitHub installations to expand. Only flip it for a
       * mixed-provider team if they don't rely on GitHub scroll-to-find; otherwise
       * scope the load-stop to GitLab/ADO first (see PR #131859 discussion).
       */
      repo_picker_server_side_search_v1: {
        client: true,
        default: false
      },
      /**
       * Cloud Agents: search-first Azure DevOps repo picker. When on, the portal
       * warms each ADO installation by paging `getInstallationRepos` until
       * `hasMore: false`, persists the walk to IndexedDB (TTL + resume cursor)
       * so later sessions hydrate from disk, and stops listing ADO repos inline
       * in the repo dropdown — searches answer from the warmed local list
       * (capped at 100), with server-side search as the zero-local-results
       * fallback for repos created after the cached walk. Default off; flip
       * per-team starting with large ADO orgs. Disabling restores the legacy
       * fetch-all behavior, so an off gate is a true no-op.
       */
      azure_devops_progressive_repo_load_v1: {
        client: true,
        default: false
      },
      /**
       * Bugbot: controls whether Azure DevOps appears in Bugbot-specific settings
       * surfaces. Keep default off until ADO Bugbot webhooks/settings are ready; the
       * general Azure DevOps integration remains visible for Cloud Agents and
       * codebase-context use.
       */
      bugbot_azure_devops_settings: {
        client: true,
        default: false
      },
      meta_mcp_tool: {
        client: true,
        default: false
      },
      // Carry MCP tool input schemas as flat JSON strings (input_schema_json)
      // instead of recursive google.protobuf.Value trees in request context,
      // avoiding deep protobuf serialization stacks on the renderer main thread.
      mcp_input_schema_json: {
        client: true,
        default: true
      },
      ai_connect_stream_encode_yield: {
        client: true,
        default: false
      },
      ai_connect_stream_decode_yield: {
        client: true,
        default: false
      },
      agent_exec_decode_yield: {
        client: true,
        default: false
      },
      // Slim MCP meta-tool descriptors in request context: send only server
      // metadata plus tool names (no per-tool descriptions or input schemas).
      // Prompt construction and CallMcpTool routing only need names; GetMcpTools
      // fetches full definitions live via McpStateExecutor at discovery time.
      mcp_meta_tool_slim_descriptors: {
        client: true,
        default: true
      },
      // `client: true` so the Glass Subscriptions tab can gate its entry points.
      cloud_agent_event_subscriptions: {
        client: true,
        default: false
      },
      web_cloud_agent_conversation_quick_access_rail: {
        client: true,
        default: false
      },
      mcp_direct_client_tool_fetch: {
        client: true,
        default: false
      },
      mcp_always_expose_auth_tool: {
        client: true,
        default: false
      },
      glass_mcp_app_focus_on_type_guard: {
        client: true,
        default: true
      },
      // Focus/visibility-gate the CloudEnvironmentTemplateService background poll so
      // an unfocused/hidden window stops re-pulling the personal+team environment
      // templates, GitHub repos, and logical environments on the tight 10-min
      // cadence. Default OFF preserves today's unconditional 10-min setInterval
      // byte-for-byte. Mirrors the team-hooks focus-gate above.
      cloud_env_template_focus_poll: {
        client: true,
        default: false
      },
      shared_chats: {
        client: true,
        default: false
      },
      shared_canvases: {
        client: true,
        default: true
      },
      share_transcripts_include_plan: {
        client: true,
        default: false
      },
      shared_transcripts_bulk_download: {
        client: true,
        default: false
      },
      use_ide_browser_script: {
        client: true,
        default: false
      },
      plan_mode_build_in_cloud: {
        client: true,
        default: true
      },
      expose_babysit_pr_cloud_entrypoint: {
        client: true,
        default: false
      },
      expose_branch_mismatch_continue_in_cloud_entrypoint: {
        client: true,
        default: false
      },
      expose_plan_build_in_cloud_entrypoint: {
        client: true,
        default: false
      },
      new_plan_editor: {
        client: true,
        default: true
      },
      ai_code_tracking_format_detection: {
        client: true,
        default: true
      },
      ai_code_tracking_v2_scoring: {
        client: true,
        default: true
      },
      ai_code_tracking_assume_all_commits_ai: {
        client: true,
        default: false
      },
      ai_code_tracking_use_commit_timestamp_for_tracking_start: {
        client: true,
        default: false
      },
      ai_code_tracking_git_operations_binding_fix: {
        client: true,
        default: false
      },
      ai_code_tracking_extension_backend: {
        client: true,
        default: false
      },
      /** Per-user Slack default-worker rules (repo -> My Machines worker): launch-path injection, the `@Cursor worker` management command, and the dashboard "Default Workers" section (client-read for the portal UI gate). */
      cloud_agent_slack_default_worker: {
        client: true,
        default: false
      },
      enable_cloud_agent_timings: {
        client: true,
        default: false
      },
      subagent_support_interrupt: {
        client: true,
        default: true
      },
      web_cloud_agent_environment_defaults: {
        client: true,
        default: false
      },
      web_cloud_agent_no_repo_entrypoint: {
        client: true,
        default: false
      },
      // Glass New Agent "No Repo" + Cloud entrypoint (parity with the iOS/web
      // entrypoints). The backend independently enforces
      // cloud_agents_no_repo_enabled.
      glass_cloud_agent_no_repo_entrypoint: {
        client: true,
        default: false
      },
      agent_store_dashboard: {
        client: true,
        default: false
      },
      // Gates @ Past Chat / @bcId attachment for cloud agents. Backend attaches
      // selected past-chat traces; Glass/portal hide the Past Chats picker when off.
      cloud_agent_bc_id_attachment: {
        client: true,
        default: false
      },
      cloud_persistent_terminals: {
        client: true,
        default: true
      },
      cloud_glass_shared_sessions: {
        client: true,
        default: false
      },
      shared_terminal_env_setup: {
        client: true,
        default: false
      },
      instant_grep_indexing: {
        client: true,
        default: false
      },
      cli_instant_grep_indexing: {
        client: true,
        default: false
      },
      push_git_tracked_state_exp: {
        client: true,
        default: true
      },
      instant_grep_user_search: {
        client: true,
        default: false
      },
      parallel_agent_workflow: {
        client: true,
        default: false
      },
      enable_multitask_mode: {
        client: true,
        default: true
      },
      // Offers Multitask Mode on cloud agents. Separate from the base gate because
      // multitask forks the agent into an async subagent, which a cloud parent can
      // only do with first-class cloud subagents and task_resume_self_fork.
      cloud_multitask_mode: {
        client: true,
        default: false
      },
      // Route side-chat workspace and machine operations through the machine owner.
      // Off preserves per-chat workspace identity.
      cloud_guest_chats_no_workspace: {
        client: true,
        default: false
      },
      glass_subagent_followups: {
        client: true,
        default: false
      },
      // Gates skill-backed custom mode UI and reminder injection.
      glass_custom_modes: {
        client: true,
        default: false
      },
      cloud_custom_modes: {
        client: true,
        default: false
      },
      hide_async_subagent_task_notifications: {
        client: true,
        default: false
      },
      // Muted compact rows (and collapse groups) for unaddressed Slack thread
      // chatter in cloud agent conversations. Off (the default) renders every
      // Slack reply as a full user prompt card — the pre-muting behavior; enable
      // the gate in Statsig to roll the muted treatment out.
      cloud_agent_slack_chatter_muted_rows: {
        client: true,
        default: false
      },
      // Per-message sender attribution on cloud agent conversations in the
      // portal: renders the triggering user's name on human messages whose
      // sender differs from the viewer. Off (the default) keeps the pre-existing
      // unattributed message cards.
      cloud_agent_message_sender_attribution: {
        client: true,
        default: false
      },
      glass_subagent_tray_done_section: {
        client: true,
        default: false
      },
      enable_await_for_subagents: {
        client: true,
        default: false
      },
      fix_claude_subagent_await: {
        client: true,
        default: true
      },
      // Extends the SEV-1252 AwaitShell subagent-wait mitigation to Grok 4.6,
      // which vacuously slept on AwaitShell instead of ending its turn to collect
      // background Task subagent results (same failure mode Fable had).
      fix_grok_subagent_await: {
        client: true,
        default: false
      },
      enable_grind_mode: {
        client: true,
        default: true
      },
      public_leaderboard_web: {
        client: true,
        default: false
      },
      enable_cloud_agent_repo_selector: {
        client: true,
        default: false
      },
      route_ent_trial_to_model: {
        client: true,
        default: false
      },
      debug_mode_autorun_support_enabled: {
        client: true,
        default: false
      },
      analytics_conversation_classification: {
        client: true,
        default: false
      },
      use_cursor_github_app_id: {
        client: true,
        default: true
      },
      // Deprecated: legacy gate for early push-to-cloud UI.
      // Replaced by: send_to_cloud_on_followup, midturn_move_to_cloud_ads.
      push_local_agent_to_cloud: {
        client: true,
        default: false
      },
      send_to_cloud_on_followup: {
        client: true,
        default: false
      },
      midturn_move_to_cloud_ads: {
        client: true,
        default: false
      },
      cloud_agent_checkout_convert_to_local: {
        client: true,
        default: false
      },
      show_browser_popup: {
        client: true,
        default: false
      },
      agent_layout_show_diffs_quick_settings: {
        client: true,
        default: false
      },
      skip_git_telemetry_computations: {
        client: true,
        default: false
      },
      // Limits the throttling disable to remote workspaces so local turns retain Electron background throttling.
      composer_background_throttling_remote_only: {
        client: true,
        default: false
      },
      composer_gc_handles: {
        client: true,
        default: true
      },
      // Expensive structural byte walks on the composer retention metrics tick /
      // solidLeakStats probe (toolFormerData, conversationState, per-bubble
      // checkpoints, appliedDiffs). Off by default — dogfood freeze incident
      // (#204626 / RendererBlocked on cyclic graphs introduced by #203007).
      // Keep a kill switch even after the iterative `seen`-set estimator fix.
      composer_retention_structural_byte_metrics: {
        client: true,
        default: false
      },
      // Responsive, content-hugging user-message speech bubbles in Glass and the
      // classic IDE. Control retains each host's existing full-width treatment.
      composer_user_message_bubbles: {
        client: true,
        default: false
      },
      // Incremental (grammar-state) tokenization for streaming transcript code
      // blocks via the VS Code TextMate tokenizer (Glass only).
      tokenize_stream_code_blocks: {
        client: true,
        default: false
      },
      composer_react_transcript_working_indicator: {
        client: true,
        default: false
      },
      // Dedupes Solid signal subscriptions in the composer transcript virtualizer,
      // tool-bubble retention, and subagent tray so opening/revisiting very large
      // chats no longer fans out O(bubbles) observers and freezes the renderer.
      optimize_tab_switch: {
        client: true,
        default: false
      },
      diff_tab_viewport_virtualization: {
        client: true,
        default: false
      },
      private_cloud_workers: {
        client: true,
        default: false
      },
      allow_shared_private_worker_assignment: {
        client: true,
        default: true
      },
      private_workers_label_filtering: {
        client: true,
        default: false
      },
      skip_github_app_for_private_worker: {
        client: true,
        default: false
      },
      update_use_localhost: {
        client: true,
        default: false
      },
      hide_inline_changed_files: {
        client: true,
        default: false
      },
      wysiwyg_markdown_default: {
        client: true,
        default: false
      },
      markdown_embedded_project_databases: {
        client: true,
        default: false
      },
      skill_icon_color: {
        client: true,
        default: false
      },
      opt_devs_into_experimental_model_toggle: {
        client: true,
        default: false
      },
      default_on_chat_editors: {
        client: true,
        default: false
      },
      /**
       * Internal Anysphere: default tsgo on for engineers who have not previously
       * installed native-preview. When on, installs `typescriptteam.native-preview`
       * when missing and sets `js/ts.experimental.useTsgo` at user scope. Scoped
       * to team 1 in Statsig; client also guards with `isAnysphereUser()`.
       */
      default_tsgo_internal: {
        client: true,
        default: false
      },
      // CLI-to-desktop thread messaging bridge (internal rollout).
      desktop_bridge: {
        client: true,
        default: false
      },
      disable_no_title_bar: {
        client: true,
        default: false
      },
      show_debug_aux_pane_border: {
        client: true,
        default: false
      },
      // Glass typography refresh. Client-only styling gate; default off so control
      // renders today's typography. When on: (1) compressed chat markdown heading
      // scale in the React transcript only (h1 down to today's h2 size,
      // smooth gradient, em-based vertical rhythm), and (2) app-wide de-washed
      // full-opacity primary text color.
      glass_typography_refresh: {
        client: true,
        default: true
      },
      browser_subagent: {
        client: true,
        default: true
      },
      browser_subagent_gating: {
        client: true,
        default: false
      },
      browser_cpp_telemetry: {
        client: true,
        default: true
      },
      network_access_control: {
        client: true,
        default: true
      },
      git_snapshot_indexing: {
        client: true,
        default: true
      },
      cpp_telem_chunking: {
        client: true,
        default: true
        // Default: no chunking (original behavior)
      },
      // Deprecated: fully launched. The VS Code client always treats this as
      // enabled; entry kept as a safety net for older clients.
      marketplaces_enabled: {
        client: true,
        default: true
      },
      customize_page: {
        client: true,
        default: false
      },
      customize_page_leaderboard_enabled: {
        client: true,
        default: false
      },
      customize_manage_scope_multiselect: {
        client: true,
        default: false
      },
      customize_global_search: {
        client: true,
        default: false
      },
      customize_plugin_detail_mcp_management: {
        client: true,
        default: false
      },
      web_agent_pilled_page: {
        client: true,
        default: false
      },
      team_marketplace_mcps: {
        client: true,
        default: true
      },
      /**
       * Gates the Customize "Publish Skill" and "Unpublish Skill" row actions.
       * Publish packs a personal `~/.cursor/skills` skill, publishes it to the team
       * marketplace via `DashboardService.PublishPlugin`, and trashes the local copy
       * once the published commit is confirmed loaded from the plugin cache;
       * unpublish restores the skill to `~/.cursor/skills` and deletes that plugin.
       * Off means the skill row's overflow menu offers neither, so nothing
       * client-side can reach either RPC. The two share one gate so it can never
       * leave someone with a published skill and no way to take it back.
       */
      publish_user_skills: {
        client: true,
        default: false
      },
      /**
       * Portal Edit MCP unification: when on, marketplace / picker / dashboard
       * edit flows use PluginAwareMcpServerModal (free vs configure-variables vs
       * read-only managed). When off, keep EditMcpFormView / McpServerModal with
       * isPluginManaged locking.
       */
      plugin_aware_mcp_edit_modal: {
        client: true,
        default: true
      },
      plugin_marketplace_allowlisted_publisher: {
        client: true,
        default: false
      },
      prompt_suggestion: {
        client: true,
        default: false
      },
      extension_signature_verification: {
        client: true,
        default: false
      },
      extension_gallery_query_chunking: {
        client: true,
        default: false
      },
      subagents_client_side_vscode: {
        client: true,
        default: true
      },
      // Sampling gate for MCP coalesce/throttle/debounce metrics.
      // Controls whether clients emit detailed mcp.coalescer.*, mcp.refresh_caches,
      // and mcp.instructions_for_composer metrics. Use rollout % to control volume.
      mcp_coalesce_metrics_sampling: {
        client: true,
        default: false
      },
      mcp_shared_process_transports: {
        client: true,
        default: false
      },
      // Per-box kill switch for the in-box egress tunnel: when on for the box owner,
      // the backend exposes the tunnel port and stamps the enable/bearer env so the
      // in-pod supervisor launches sand-egress-tunnel (workload egress can then exit
      // through an authenticated client, fail-open when none). Default off; the box
      // is byte-for-byte unchanged when off. client:true so the Sand desktop can read
      // it to gate the Beta-tab "route egress through this desktop" toggle (the box
      // is still stamped server-side, keyed to the owner, in sandBoxServer.ts).
      sand_box_egress_tunnel: {
        client: true,
        default: false
      },
      task_card_tips_enabled: {
        client: true,
        default: false
      },
      // Controls whether Codebase Telemetry V2 is enabled on the client.
      codebase_telemetry_v2: {
        client: true,
        default: true
      },
      // Controls whether Git history capture is enabled in Codebase Telemetry V2.
      codebase_telemetry_v2_git_history: {
        client: true,
        default: true
      },
      // Controls whether agent dotdirs other than `~/.cursor` are included
      // by Codebase Telemetry V2.
      codebase_telemetry_v2_agent_dot_dirs: {
        client: true,
        default: true
      },
      // Gates the gradual deprecation of Codebase Telemetry V1.
      codebase_telemetry_v1_deprecation: {
        client: true,
        default: false
      },
      // Gates Codebase Telemetry in the Sand host.
      sand_codebase_telemetry: {
        client: true,
        default: false
      },
      // Kill switch for client-side codebase index building. When ON, the client
      // sends `x-codebase-indexing-enabled: false` on the indexing RPCs for ALL
      // users (semantic indexers included), so the server skips building/updating a
      // queryable Turbopuffer index while the client keeps syncing and emitting
      // training telemetry. Hides only semantic-index UI in IndexingView — do not
      // hide the Indexing & Docs settings tab (Docs / .cursorignore stay reachable).
      // Default OFF (indexing on); the client fails open so a Statsig outage never
      // silently disables indexing.
      disable_codebase_indexing: {
        client: true,
        default: true
      },
      // Client kill switch to hide @Docs mentions/settings ahead of deprecation.
      // Pair with disable_docs_server_usage for the backend turbopuffer no-op.
      // Default OFF so docs stay available until we intentionally disable them.
      disable_docs_client_usage: {
        client: true,
        default: true
      },
      composer_promo_expiration_reminder: {
        client: true,
        default: true
      },
      enable_plugin_nudge: {
        client: true,
        default: false
      },
      import_3p_plugins: {
        client: true,
        default: true
      },
      enable_local_3p_plugin_imports: {
        client: true,
        default: true
      },
      enable_new_team_member_usage_boost: {
        client: true,
        default: true
      },
      disable_push_request_context: {
        client: true,
        default: false
      },
      enable_ide_enterprise_plan_usage: {
        client: true,
        default: true
      },
      // Merged-PR scan ("we found a bug you merged" upsell). Master gate defaults
      // off; force-dry-run and circuit-breaker default on so the first enabled
      // ticks cannot send email until both are explicitly configured in Statsig.
      bugbot_merged_pr_scan: {
        client: true,
        default: true
      },
      windows_linux_update_auth_headers: {
        client: true,
        default: false
      },
      glass_focus_outline: {
        client: true,
        default: false
      },
      glass_inline_assistant_turn_actions_bar: {
        client: true,
        default: true
      },
      // Skips the synchronous whole-file LCS diff that `addDecorationsOnlyDiff`
      // runs per streamed file change in Glass, where inline diff decorations are
      // always suppressed. The diff is computed on the first read instead.
      inline_diff_defer_hidden_diff_state: {
        client: true,
        default: false
      },
      enable_marketplace_plugin_logging: {
        client: true,
        default: true
      },
      // Rollout of sparse partial clones + subprocess kill budgets for plugin
      // repos, so plugins in large monorepos install without hitting the legacy
      // 30s full-clone timeout. See @anysphere/cursor-plugins.
      enable_sparse_plugin_clones: {
        client: true,
        default: true
      },
      /**
       * Kill-switch for running cursor-always-local in glass agent workspaces
       * (PR #89691). When ON, cursor-always-local loads in glass non-BC agent
       * workspaces (SSH remotes, devboxes) via the shared connect transport.
       * When OFF, the extension only loads in the glass root workspace — the
       * pre-PR behavior.
       */
      glass_always_local_agent_workspace: {
        client: true,
        default: true
      },
      /**
       * When ON, Glass local agent workspaces do not automatically start codebase
       * indexing. Explicit Compute/Sync index requests remain available.
       */
      glass_disable_eager_indexing_for_local_sessions: {
        client: true,
        default: false
      },
      /**
       * Kill-switch for allowlisting mechatroner.rainbow-csv in Glass root and
       * agent workspaces. When OFF, rainbow-csv remains filtered out.
       */
      glass_rainbow_csv_extension: {
        client: true,
        default: false
      },
      retry_hydration_optimization: {
        client: true,
        default: false
      },
      full_self_driving: {
        client: true,
        default: false
      },
      full_self_driving_glass: {
        client: true,
        default: false
      },
      full_self_driving_glass_pr_tab: {
        client: true,
        default: false
      },
      shutdown_hang_watchdog_darwin_sigkill: {
        client: true,
        default: true
      },
      cursor_shared_session_file_watcher: {
        client: true,
        default: false
      },
      cursor_update_supervisor: {
        client: true,
        default: false
      },
      cursor_private_inference_download_prompt: {
        client: true,
        default: false
      },
      cursor_cli_private_inference_download_prompt: {
        client: true,
        default: false
      },
      disable_sqlite_storage_backup: {
        client: true,
        default: true
      },
      /**
       * Client-driven Agent Store surfaces: the IDE / local CLI sync runtimes,
       * backend RPC enablement for those non-credentialed callers
       * (`isAgentStoreBackendEnabled`), and the cloud prompt's mounted-store
       * block. Deliberately NOT composed into private-worker sync
       * (`agent_store_sync_private_worker`) or cloud in-pod FUSE delivery
       * (`agent_store_fuse_in_pod`) — those surfaces carry their own kill
       * switches, and their post-mint RPCs pass the backend gate via verified
       * agent-store credentials.
       */
      agent_store_sync_client: {
        client: true,
        default: false
      },
      /** Auto-mount durable USER and TEAM stores for local IDE agents. */
      agent_store_principal_local_mounts: {
        client: true,
        default: false
      },
      /**
       * Agent-store conflict notices. Same Statsig key as the remote/workflow gate
       * from #173261; `client: true` so local-sync drain / barrier / eager can read
       * it (was `client: false` for server-only). Composes with
       * `agent_store_sync_client` and in-pod fuse eligibility for remote delivery.
       */
      agent_store_conflict_notices: {
        client: true,
        default: false
      },
      /**
       * Kill switch for the write-path force barrier only. Journal drain /
       * turn-end / eager stay under `agent_store_conflict_notices`.
       */
      agent_store_sync_on_write: {
        client: true,
        default: true
      },
      /** Kill switch / rollout for the proxy-agent TLS SecureContext cache (read in the ext host). */
      proxy_agent_secure_context_cache: {
        client: true,
        default: false
      },
      /**
       * Rollout for the client auto-disabling models unused past the backend's
       * disable_unused_models_after_n_hours threshold. When off, the client still
       * tracks last-used timestamps and logs what it would disable (dry run)
       * without writing the disable.
       */
      auto_disable_unused_models: {
        client: true,
        default: false
      },
      // When enabled, drops all user/project/team-customized prompt context — rules
      // (workspace .mdc, AGENTS.md, team/knowledge-base rules), skills, and MCP
      // (prompt instructions + tools) — from the agent prompt so the model runs
      // against a minimal, static prompt. Used for internal prompt experiments /
      // baselines. Default OFF preserves the full customized context.
      drop_custom_prompt_context: {
        client: true,
        default: false
      },
      // Reuses the ComposerEditorInput already installed in an editor group instead
      // of constructing a duplicate that is never disposed and leaks its SolidJS
      // effects. Default OFF until the rollout confirms tab open/close/replace
      // behavior is unchanged.
      composer_reuse_editor_input: {
        client: true,
        default: false
      }
    };
export type FeatureFlagName = keyof typeof FLAGS;
export const FEATURE_FLAGS = Object.keys(FLAGS) as FeatureFlagName[];

export const EXPERIMENTS = {
      /* BEGIN_EXPERIMENT_CONFIG */
      // User-level FinalizationRegistry safety-net cadence (60s control vs 1s
      // treatment). Fallback keeps the 60s default until the experiment is live.
      composer_gc_safety_net_1s: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      // Internal Anysphere user-level tsgo memory experiment. Control preserves
      // auto imports; treatment disables their default and restarts native-preview.
      tsgo_disable_auto_imports_internal: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      // Sand "Sand Model Selection" experiment (client-only; read by the Sand app).
      // The `enabled` parameter is the arm signal: Control = false, Test = true.
      // Fallback (not started / unallocated) is `enabled: false`, which — combined
      // with Sand keying "experiment active" off the Statsig group name rather than
      // this flag — means Sand behaves exactly as today until Jacob starts it.
      sand_model_selection: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      // New stage-based limit-hit experience (notice bubble above the composer +
      // Get More Usage / Adjust on-demand limit modals), in both Glass and Classic.
      // Control keeps today's usage-limit banners. Exposure is logged only once the
      // user is actually in a limit-hit stage (shared eligibility for both arms).
      // Also gated by the `limit_hit_ui_kill_switch` flag for instant rollback.
      limit_hit_ui_2026_06: {
        client: true,
        fallbackValues: {
          group: "control"
        },
        parseValue: {
          group: parseEnum(["control", "treatment"])
        }
      },
      // Original proactive third-party-usage nudge experiment. Keep registered
      // after the follow-up launches so existing Statsig results remain intact.
      third_party_usage_nudge_2026_07: {
        client: true,
        fallbackValues: {
          group: "control"
        },
        parseValue: {
          group: parseEnum(["control", "treatment"])
        }
      },
      // Follow-up policy experiment (see ExperimentParamTypes above). Backend-read
      // only, but marked client-facing because it drives a VS Code surface.
      third_party_usage_nudge_policy_2026_07: {
        client: true,
        fallbackValues: {
          policy: "none"
        },
        parseValue: {
          policy: parseEnum(["none", "90", "75_90"])
        }
      },
      // On-demand nudge experiment (see ExperimentParamTypes above). Backend-read
      // only, but marked client-facing because it drives a VS Code surface.
      third_party_on_demand_nudge_2026_08: {
        client: true,
        fallbackValues: {
          group: "control",
          copy: "cursor_models"
        },
        parseValue: {
          group: parseEnum(["control", "treatment"]),
          copy: parseEnum(["cursor_models", "grok_45"])
        }
      },
      // Controls whether the Automations entrypoint row is shown in the editor/IDE
      // agents sidebar. Treatment (`enabled: true`) renders the row; control hides
      // it. Read on the client via `createExposedExperimentBoolean`.
      automations_button_in_ide: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      // Glass-only "Local agents interruption" move-to-cloud tray. Control keeps
      // today's behavior (nothing); treatment shows a tray above the composer when
      // a generating local agent is interrupted by laptop sleep or a bad
      // connection, offering to continue the run in the cloud. Exposure is logged
      // at the shared eligibility boundary (interruption detected for an eligible
      // local agent, 24h cooldown elapsed) so both arms are counted symmetrically.
      local_agent_interruption_move_to_cloud_glass: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      // Glass-only "parallel local work" cloud nudge. Control keeps today's
      // behavior (nothing); `try_cloud` shows a toast with a "Try Cloud" routing
      // CTA; `educational` shows the same body copy with a single "Got It" button
      // and no routing (permanently suppresses on click). Exposure is logged at
      // the shared eligibility boundary (pattern held for the debounce window,
      // repo URL resolvable, 7-day cooldown elapsed) so all arms are counted
      // symmetrically.
      parallel_agents_try_cloud_nudge_glass: {
        client: true,
        fallbackValues: {
          variant: "control"
        },
        parseValue: {
          variant: parseEnum(["control", "try_cloud", "educational"])
        }
      },
      long_running_local_agent_cloud_nudge_glass: {
        client: true,
        fallbackValues: {
          variant: "control"
        },
        parseValue: {
          variant: parseEnum(["control", "try_cloud"])
        }
      },
      glass_sidebar_one_repo_environment_grouping: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      // Unit: userID. Extends the "Getting started" user checklist to enterprise
      // members. Default control (enabled:false) = no checklist for enterprise.
      dashboard_user_checklist_enterprise: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      // Unit: teamID. Extends the "Team Setup" admin checklist to enterprise admins.
      // Default control (enabled:false) = no checklist for enterprise admins.
      dashboard_admin_setup_enterprise: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      // Unit: teamID. Replaces the existing non-enterprise team-admin dashboard
      // checklist with the team-wide onboarding treatment. Default control keeps
      // the shipped checklist unchanged.
      dashboard_team_admin_onboarding_checklist: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      new_team_admin_setup_wizard: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      new_team_add_teammates_callout: {
        client: true,
        fallbackValues: {
          group: "control"
        },
        parseValue: {
          group: parseEnum(["control", "callout"])
        }
      },
      new_team_name_prefill: {
        client: true,
        fallbackValues: {
          group: "control"
        },
        parseValue: {
          group: parseEnum(["control", "domain_brand"])
        }
      },
      dashboard_member_remove_modal: {
        client: true,
        fallbackValues: {
          group: "control"
        },
        parseValue: {
          group: parseEnum([
            "control",
            "treatment_info",
            "treatment_warning"
          ])
        }
      },
      push_mcps: {
        client: true,
        fallbackValues: {
          group: "control"
        },
        parseValue: {
          group: parseEnum(["control", "enabled"])
        }
      },
      glass_setup_cloud_pill: {
        client: true,
        fallbackValues: {
          enabled: false,
          variant: "ghost"
        },
        parseValue: {
          enabled: parseBoolean,
          variant: parseEnum(["ghost", "primary"])
        }
      },
      // Unit: userID. Control restores the persisted active chat; treatment opens
      // New Agent without deleting the last-chat selection. Eligibility requires
      // an initial app start, an authoritative assignment, and a persisted active
      // chat. Explicit IDE launch intents are excluded.
      glass_start_on_new_chat: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      glass_individual_onboarding_checklist: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      send_to_cloud_composer_glass: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      connect_repo_env_setup_pill_glass: {
        client: true,
        fallbackValues: {
          variant: "control"
        },
        parseValue: {
          variant: parseEnum([
            "control",
            "primary",
            "secondary",
            "tertiary"
          ])
        }
      },
      branch_mismatch_move_to_cloud_glass: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      plan_build_cloud_button: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      ide_connect_git_repos_start: {
        client: true,
        fallbackValues: {
          variant: "control"
        },
        parseValue: {
          variant: parseEnum([
            "control",
            "primary",
            "secondary",
            "tertiary"
          ])
        }
      },
      ide_steer_from_cloud_start: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      cloud_agent_steer_from_phone_glass: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      glass_account_menu_ios_download: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      glass_account_menu_usage_remaining: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      glass_agent_demos_setup_pill: {
        client: true,
        fallbackValues: {
          enabled: false,
          variant: "ghost",
          cloud_target_only: false
        },
        parseValue: {
          enabled: parseBoolean,
          variant: parseEnum(["ghost", "primary"]),
          cloud_target_only: parseBoolean
        }
      },
      cloud_setup_cta_glass_running_agent_session: {
        client: true,
        fallbackValues: {
          variant: "control"
        },
        parseValue: {
          variant: parseEnum(["control", "chat_title", "composer_pill"])
        }
      },
      set_up_env_pill_glass: {
        client: true,
        fallbackValues: {
          variant: "control"
        },
        parseValue: {
          variant: parseEnum([
            "control",
            "primary",
            "secondary",
            "tertiary"
          ])
        }
      },
      agent_desktop_glass_env_setup: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      glass_automations_sidebar_new_tag: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      new_tag_cloud_runtime_glass: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      runtime_picker_discovery_nudge_glass: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      remote_control_runtime_picker_glass: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      default_web_users_cloud_in_glass: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      cloud_setup_cta_web_running_agent_session: {
        client: true,
        fallbackValues: {
          variant: "control"
        },
        parseValue: {
          variant: parseEnum([
            "control",
            "primary",
            "secondary",
            "tertiary"
          ])
        }
      },
      suggested_prompts: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      suggested_mode_switch: {
        client: true,
        fallbackValues: {
          group: "control"
        },
        parseValue: {
          group: parseEnum(["control", "nudge"])
        }
      },
      plugin_keyword_nudge_rollout: {
        client: true,
        fallbackValues: {
          group: "control"
        },
        parseValue: {
          group: parseEnum(["control", "treatment"])
        }
      },
      plugin_keyword_nudge_latency: {
        client: true,
        fallbackValues: {
          group: "control"
        },
        parseValue: {
          group: parseEnum(["control", "debounce_50ms", "debounce_0ms"])
        }
      },
      plugin_keyword_nudge_inline: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      marketplace_tab_customize_label: {
        client: true,
        fallbackValues: {
          group: "control"
        },
        parseValue: {
          group: parseEnum(["control", "treatment"])
        }
      },
      customize_default_manage_tab: {
        client: true,
        fallbackValues: {
          tab: "plugins"
        },
        parseValue: {
          tab: parseEnum(["plugins", "mcps"])
        }
      },
      customize_migration: {
        client: true,
        fallbackValues: {
          stage: "control"
        },
        parseValue: {
          stage: parseEnum(["control", "cta", "banner", "full"])
        }
      },
      marketplace_card_install_cta_ab: {
        client: true,
        fallbackValues: {
          group: "control"
        },
        parseValue: {
          group: parseEnum(["control", "card_cta"])
        }
      },
      marketplace_detail_authenticate_cta_ab: {
        client: true,
        fallbackValues: {
          group: "control"
        },
        parseValue: {
          group: parseEnum(["control", "detail_auth_cta"])
        }
      },
      marketplace_try_in_chat_prompt_ab: {
        client: true,
        fallbackValues: {
          group: "control"
        },
        parseValue: {
          group: parseEnum(["control", "concrete_use_case_prompt"])
        }
      },
      composer_run_button_style: {
        client: true,
        fallbackValues: {
          buttonStyle: "primary"
        },
        parseValue: {
          buttonStyle: parseEnum(["primary", "secondary"])
        }
      },
      new_placeholder: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      cursor_launch_at_login: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      subscription_only_degraded_extended_usage: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      onboarding_default_layout_agent: {
        client: true,
        fallbackValues: {
          enabled: "false"
        },
        parseValue: {
          enabled: parseString
        }
      },
      onboarding_left_right_chat: {
        client: true,
        fallbackValues: {
          enabled: "left"
        },
        parseValue: {
          enabled: parseEnum(["left", "right"])
        }
      },
      separate_auto_and_api_usage_bars_for_individuals: {
        client: true,
        fallbackValues: {
          group: "control"
        },
        parseValue: {
          group: parseEnum(["control", "test"])
        }
      },
      onboarding_skip_post_login: {
        client: true,
        fallbackValues: {
          enabled: "control"
        },
        parseValue: {
          enabled: parseEnum(["control", "remove_features"])
        }
      },
      /**
       * A/B test for which model the locked free-user model picker is pinned to.
       * See type definition for variant semantics. Free-user lock UX itself is
       * always on (the `locked_picker` arm of the predecessor experiment shipped);
       * this experiment varies only the pinned model.
       *
       * Statsig ops: ramp via experiment allocation only (0% = off). No separate
       * gate. Fallback is honest control: a Statsig outage or 0% allocation keeps
       * today's "Auto"-pinned behavior.
       */
      free_user_locked_model_2026_05: {
        client: true,
        fallbackValues: {
          variant: "control"
        },
        parseValue: {
          variant: parseEnum([
            "control",
            "composer_2_5_fast",
            "composer_2_5"
          ])
        }
      },
      free_user_composer_grok_picker_2026_07: {
        client: true,
        fallbackValues: {
          group: "control"
        },
        parseValue: {
          group: parseEnum(["control", "treatment"])
        }
      },
      /**
       * Client-side model picker layout experiment allocated through the
       * `model_picker_experiments` layer. See the type definition for arm
       * semantics. Fallback is honest control: a Statsig outage keeps today's
       * layout.
       */
      model_picker_promote_first_party: {
        client: true,
        fallbackValues: {
          variant: "control"
        },
        parseValue: {
          variant: parseEnum([
            "control",
            "grok_primary",
            "pinned_selection"
          ])
        }
      },
      // v3 in `model_picker_experiments`. Console groups set layer param
      // `promote_first_party_variant` to `control` / `grouped_auto_expand`.
      model_picker_promote_first_party_v3: {
        client: true,
        fallbackValues: {
          variant: "control"
        },
        parseValue: {
          variant: parseEnum(["control", "grouped_auto_expand"])
        }
      },
      model_picker_usage_display_2026_08: {
        client: true,
        fallbackValues: {
          group: "control"
        },
        parseValue: {
          group: parseEnum(["control", "show_labels"])
        }
      },
      free_user_usage_summary_display_mode: {
        client: true,
        fallbackValues: {
          group: "control"
        },
        parseValue: {
          group: parseEnum(["control", "always_show_percentage"])
        }
      },
      pro_auto_mode_new_users: {
        client: true,
        fallbackValues: {
          group: "control"
        },
        parseValue: {
          group: parseEnum([
            "control",
            "pro_and_auto_default_auto",
            "pro_and_auto_default_pro"
          ])
        }
      },
      pro_auto_mode_existing_users: {
        client: true,
        fallbackValues: {
          group: "control"
        },
        parseValue: {
          group: parseEnum([
            "control",
            "pro_and_auto_default_auto_with_nudge"
          ])
        }
      },
      premium_auto_mode: {
        client: true,
        fallbackValues: {
          group: "control"
        },
        parseValue: {
          group: parseEnum(["control", "premium_auto_option"])
        }
      },
      terminal_tip: {
        client: true,
        fallbackValues: {
          enabled: false,
          message: "Install Cursor CLI?",
          action: "curl https://cursor.com/install -fsS | bash",
          show_every_hours: 0,
          show_count: 0
        },
        parseValue: {
          enabled: parseBoolean,
          message: parseString,
          action: parseString,
          show_every_hours: parseNumber,
          show_count: parseNumber
        }
      },
      /**
       * Experiment for the CLI install in-app ad.
       * Shows an ad to users who have claude/codex CLI but not Cursor agent CLI.
       * This is a separate experiment from terminal_tip to keep assignment close to exposure.
       */
      cli_install_ad: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      /**
       * Experiment for the CLI install in-app ad v2.
       * Tests different timing strategies for showing the ad to users with competing CLIs.
       * - control: No ad shown
       * - minutes_delay: Show ad 5 minutes after first detecting a competing CLI
       * - day_delay: Show ad 24 hours after first detecting a competing CLI
       */
      cli_install_ad_v2: {
        client: true,
        fallbackValues: {
          variant: "control"
        },
        parseValue: {
          variant: parseEnum(["control", "minutes_delay", "day_delay"])
        }
      },
      /** A/B test for agent backend selection.
       * - control: Users see normal behavior (cursor-agent by default)
       * - hometown: cursor-agent backend with model switching disabled while the test is active
       * - ombre: claude-code backend with model switching disabled for the conversation
       */
      agent_backend_ab_test_1: {
        client: true,
        fallbackValues: {
          // null (not undefined): native Statsig rejects undefined getValue fallbacks.
          group: null
        },
        parseValue: {
          group: parseEnum(["hometown", "ombre"])
        }
      },
      agent_backend_ab_test_2: {
        client: true,
        fallbackValues: {
          group: null
        },
        parseValue: {
          group: parseEnum(["hometown", "ombre"])
        }
      },
      new_chat_auto_switch: {
        client: true,
        fallbackValues: {
          group: "control"
        },
        parseValue: {
          group: parseEnum(["control", "popup", "inline_banner"])
        }
      },
      new_teams_pricing_cancellation_flow: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      team_pending_cancellation_cancel_now: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      yearly_upgrade_inplace: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      cloud_agent_remove_on_demand_requirement: {
        client: true,
        fallbackValues: {
          variant: "control"
        },
        parseValue: {
          variant: parseEnum([
            "control",
            "treatment_suggest_switch",
            "treatment_no_warning"
          ])
        }
      },
      dashboard_user_menu_view_plans: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      dashboard_create_team_sidebar_cta: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      sidebar_bottom_section_cta: {
        client: true,
        fallbackValues: {
          group: "control"
        },
        parseValue: {
          group: parseEnum(["control", "create_team", "upgrade_to_pro"])
        }
      },
      free_user_create_team_cta: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      dashboard_free_overview_cleanup: {
        client: true,
        fallbackValues: {
          group: "control"
        },
        parseValue: {
          group: parseEnum([
            "control",
            "used_percentage",
            "remaining_percentage"
          ])
        }
      },
      download_bottom_dashboard: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      web_mobile_ios_launch_ad: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      web_cloud_agents_agent_window_ad: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      router_settings_disabled_info: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      onboarding_redirect_git_to_login_deep_control: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      dashboard_invite_modal_version: {
        client: true,
        fallbackValues: {
          variant: "v2"
        },
        parseValue: {
          variant: parseEnum(["v2", "v3", "v3-contacts"])
        }
      },
      // Concluded (shipped `tertiary`); kept registered so deployed clients still
      // resolve it. Superseded on the pill by completely_free_env_setup_glass_and_web.
      set_up_env_pill_web: {
        client: true,
        fallbackValues: {
          variant: "control"
        },
        parseValue: {
          variant: parseEnum([
            "control",
            "primary",
            "secondary",
            "tertiary"
          ])
        }
      },
      completely_free_env_setup_glass_and_web: {
        client: true,
        fallbackValues: {
          variant: "control"
        },
        parseValue: {
          variant: parseEnum([
            "control",
            "primary",
            "secondary",
            "tertiary"
          ])
        }
      },
      env_setup_free_callout_web: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      completely_free_env_setup_glass: {
        client: true,
        fallbackValues: {
          variant: "control"
        },
        parseValue: {
          variant: parseEnum(["control", "treatment"])
        }
      },
      dynamic_automation_templates: {
        client: true,
        fallbackValues: {
          group: "control"
        },
        parseValue: {
          group: parseEnum(["control", "treatment"])
        }
      },
      team_pinned_marketplace_plugins: {
        client: true,
        fallbackValues: {
          group: "control"
        },
        parseValue: {
          group: parseEnum(["control", "treatment"])
        }
      },
      glass_new_chat_header: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      glass_ftux_wizard: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      glass_ftux_first_action: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      glass_ftux_app_scan: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      glass_recommended_actions: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      glass_start_onboarding_pill: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      terminal_agent_integration: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      ide_update_ux_exp: {
        client: true,
        fallbackValues: {
          variant: "control"
        },
        parseValue: {
          variant: parseEnum(["control", "sidebar", "non_sidebar"])
        }
      },
      vega_launch_broadcast: {
        client: true,
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      effort_first_model_picker: {
        client: true,
        fallbackValues: {
          variant: "control"
        },
        parseValue: {
          variant: parseEnum(["control", "treatment"])
        }
      },
      effort_first_grouped_models_2026_08: {
        client: true,
        // Honest control: a Statsig outage or 0% allocation keeps the plain
        // effort-first submenu.
        fallbackValues: {
          enabled: false
        },
        parseValue: {
          enabled: parseBoolean
        }
      },
      slash_menu_team_discovery_ranking: {
        client: true,
        fallbackValues: {
          policy: "strict_tiers",
          half_life_ms: 7 * 24 * 60 * 60 * 1e3,
          team_pseudocount_cap: 0.8,
          team_min_sample_count: 5,
          team_min_score: 0.05,
          discovery_personal_recency_window_ms: 28 * 24 * 60 * 60 * 1e3,
          visible_item_count: 5,
          discovery_slot_positions: [4, 5],
          protected_top_count: 3,
          max_discovery_score_deficit: 0.25,
          discovery_seed: ""
        },
        parseValue: {
          policy: parseEnum([
            "strict_tiers",
            "blended",
            "floating_team_slots"
          ]),
          half_life_ms: parseNumber,
          team_pseudocount_cap: parseNumber,
          team_min_sample_count: parseNumber,
          team_min_score: parseNumber,
          discovery_personal_recency_window_ms: parseNumber,
          visible_item_count: parseNumber,
          discovery_slot_positions: parseNumberArray,
          protected_top_count: parseNumber,
          max_discovery_score_deficit: parseNumber,
          discovery_seed: parseString
        }
      }
      /* END_EXPERIMENT_CONFIG */
    };
export type ExperimentName = keyof typeof EXPERIMENTS;
export const EXPERIMENT_NAMES = Object.keys(EXPERIMENTS) as ExperimentName[];

export const DYNAMIC_CONFIGS = {
      /* BEGIN_DYNAMIC_CONFIGS */
      mobile_iap_products: {
        client: true,
        fallbackValues: {
          products: {
            "co.anysphere.cursor.pro.monthly": "pro",
            "co.anysphere.cursor.proplus.monthly": "pro_plus",
            "co.anysphere.cursor.ultra.monthly": "ultra",
            "co.anysphere.sand.ultra.monthly": "ultra"
          }
        }
      },
      remote_workspace_readiness_config: {
        client: true,
        fallbackValues: {
          healthcheck_timeout_ms: 3e3,
          remote_extension_host_startup_grace_ms: 3e3
        }
      },
      ai_code_tracking_poll: {
        client: true,
        fallbackValues: {
          interval_ms: 6e5
        }
      },
      solidjs_stack_trace_limit: {
        client: true,
        fallbackValues: {
          stackTraceLimitFloor: 0
        }
      },
      idle_extension_host_killer_config: {
        client: true,
        fallbackValues: {
          idleMinutesToKillExtensionHost: 0,
          freeMemoryPercentageToKillExtensionHost: 0,
          killUserExtensionHost: false
        }
      },
      marketplace_listing_config: {
        client: true,
        fallbackValues: {
          rpcTimeoutMs: 15e3
        }
      },
      editor_bugbot_config: {
        client: true,
        fallbackValues: {
          model: "claude-4-5-sonnet-20250929",
          iterations: 0,
          agentic_iterations: 1,
          agentic_model: "claude-4.5-haiku",
          context_lines: 10
        }
      },
      client_speculative_summarization_config: {
        client: true,
        fallbackValues: {
          tokenUsageThresholdPercentage: 70,
          tolerancePercentage: 5,
          inflightMaxAgeMinutes: 5,
          speculativeStreamTimeoutMinutes: 5
        }
      },
      new_conversation_ux_config: {
        client: true,
        fallbackValues: {
          enable: true,
          enabled_models: [],
          force_enable_on_all_models: true,
          group_text: true,
          group_thinking: true,
          group_todos: true,
          group_edits: false,
          smooth_stream_enable: false,
          grouped_text_max_length: 100,
          grouped_text_max_length_composer_family: 88,
          tool_summary_mode: "single_word",
          nest_tool_blocks: false
        }
      },
      meta_agent_config: {
        client: true,
        fallbackValues: {
          meta_parent_model: "claude-4.6-opus-high-fast",
          allow_subagent_followups: true,
          enable_notes: false
        }
      },
      task_card_tips: {
        client: true,
        fallbackValues: {
          startup_tips: [
            {
              id: "cloud-subagents",
              text: "Use /in-cloud for cloud subagents"
            }
          ]
        }
      },
      product_tips_config: {
        client: true,
        fallbackValues: {
          tips: [],
          config: {
            intervalMs: 8e3,
            minClientVersion: ""
          }
        }
      },
      composer_sandboxing_promo: {
        client: true,
        fallbackValues: {
          version: 0
        }
      },
      playwright_log_configs: {
        client: true,
        fallbackValues: {
          logSizeThreshold: 25e3,
          logPreviewLines: 25,
          logPreviewChars: 25e3
        }
      },
      privacy_mode_acknowledgement_onboarding: {
        client: true,
        fallbackValues: {
          mode: "on"
        }
      },
      tools_concurrency_config: {
        client: true,
        fallbackValues: {
          tools: {
            RIPGREP_RAW_SEARCH: {
              ttl: 1e4,
              maxConcurrent: 5
            },
            RIPGREP_SEARCH: {
              ttl: 1e4,
              maxConcurrent: 5
            }
          },
          defaultTtl: 1e4,
          defaultMaxConcurrent: 999999
          // Effectively unlimited
        }
      },
      client_rg: {
        client: true,
        fallbackValues: {
          num_threads: 4,
          fallback_num_threads: 4,
          use_batch_executor: false,
          batch_executor_wait_ms: 50
        }
      },
      http2_ping_config: {
        client: true,
        fallbackValues: {
          enabled: [],
          pingIdleConnection: null,
          pingIntervalMs: null,
          pingTimeoutMs: null,
          idleConnectionTimeoutMs: null
        }
      },
      http2_agent_connection_pool_config: {
        client: true,
        fallbackValues: {
          poolSize: 4
        }
      },
      http1_keepalive_config: {
        client: true,
        fallbackValues: {
          keepAliveInitialDelayMs: null
        }
      },
      ws_dark_durability_probe_config: {
        client: true,
        // SAFE defaults == today's hardcoded client constants. The client clamps
        // each value before use, so these also document the intended baseline.
        fallbackValues: {
          idleHoldMs: 3e4,
          echoTimeoutMs: 5e3,
          concurrency: 4
        }
      },
      abort_controller_logging_config: {
        client: true,
        fallbackValues: {
          sampling_rate: 1
        }
      },
      hooks_client_config: {
        client: true,
        fallbackValues: {
          hooks_ready_timeout_ms: 2e3
        }
      },
      composer_hang_detection_config: {
        client: true,
        fallbackValues: {
          thresholds_ms: [
            2e3,
            4e3,
            6e3,
            8e3,
            1e4,
            12e3,
            14e3,
            16e3,
            32e3
          ]
        }
      },
      composer_errors_without_button_support: {
        client: true,
        fallbackValues: {
          error_type_denylist: []
        }
      },
      nal_stall_detector_timeout_config: {
        client: true,
        fallbackValues: {
          advisoryTimeoutMs: 20 * 1e3,
          failTimeoutMs: 30 * 1e3
        }
      },
      nal_request_context_blob_transport_config: {
        client: true,
        fallbackValues: {
          mode: "legacy",
          max_blob_bytes: 15 * 1024 * 1024,
          max_inline_dynamic_bytes: 1024 * 1024
        }
      },
      simulated_thinking_error_timeout: {
        client: true,
        fallbackValues: {
          timeout_ms: 15 * 1e3
        }
      },
      agent_loop_phase_display: {
        client: true,
        fallbackValues: {
          enabled: false,
          min_display_threshold_ms: 0
        }
      },
      in_app_ads_dev_override_config: {
        client: true,
        fallbackValues: {
          ad_id_to_show: ""
        }
      },
      in_app_ads_quiet_period_config: {
        client: true,
        fallbackValues: {
          quiet_period_ms: 6e5,
          // 10m between ads; bypass triggers + dev override
          first_launch_quiet_period_ms: 864e5
          // 24h after firstSessionDate; 0 disables
        }
      },
      environment_setup_resume_config: {
        client: true,
        fallbackValues: {
          max_resume_age_ms: DEFAULT_ENVIRONMENT_SETUP_MAX_RESUME_AGE_MS
        }
      },
      perf_monitor_control: {
        client: true,
        fallbackValues: {
          enabled: false,
          subsample_polling_rate_sec: 0,
          sample_polling_rate_min: 0
        }
      },
      glass_reactivated_user_routing_config: {
        // Client-readable so the IDE can mirror routing knobs to APPLICATION storage
        // for offline first-window reactivation (one boot behind).
        client: true,
        fallbackValues: {
          user_routing_enabled: false,
          inactive_days: DEFAULT_FIRST_WINDOW_REACTIVATION_INACTIVE_DAYS,
          ch_timeout_ms: 500,
          ch_cache_ttl_seconds: 86400,
          local_routing_enabled: true
        }
      },
      retry_interceptor_config: {
        client: true,
        fallbackValues: {
          retriableErrors: [
            {
              code: "Unavailable"
            },
            {
              code: "Internal"
            },
            {
              code: "DeadlineExceeded"
            }
          ]
        }
      },
      retry_interceptor_params_config: {
        client: true,
        fallbackValues: {
          maxRetries: null,
          baseDelayMs: null,
          maxDelayMs: null
        }
      },
      text_delta_pacing_config: {
        client: true,
        fallbackValues: {
          targetCharsPerFrame: 0,
          maxLagFrames: 8,
          barrierMaxWaitMs: 0
        }
      },
      extension_monitor_control: {
        client: true,
        fallbackValues: {
          local_enabled: false,
          backend_reporting_enabled: false,
          network_diagnostics_reporting_enabled: false,
          subsample_polling_rate_sec: 0,
          sample_polling_rate_min: 0
        }
      },
      agent_memory_pressure_monitor: {
        client: true,
        fallbackValues: {
          monitor_enabled: false,
          low_memory_sustained_sec: 30,
          min_agent_process_age_sec: 0,
          low_memory_available_pct: 10,
          low_memory_available_abs_gb: 3,
          cpu_high_pct: 90,
          cpu_high_sustained_sec: 30,
          min_reported_cpu_pct: 5
        }
      },
      sand_process_metrics: {
        client: true,
        fallbackValues: {
          local_enabled: false,
          backend_reporting_enabled: false,
          subsample_polling_rate_sec: 0,
          sample_polling_rate_min: 0
        }
      },
      // Fail-closed like the IDE's traceConfig (sampleRate ?? 0.0): tracing stays
      // off until this config enables it, and the 0.01 ratio mirrors the IDE
      // ext-host fallback so flipping `enabled` alone starts at a safe volume.
      sand_rpc_tracing: {
        client: true,
        fallbackValues: {
          enabled: false,
          sample_ratio: 0.01
        }
      },
      gc_trace_control: {
        client: true,
        fallbackValues: {
          enabled: false,
          drain_interval_sec: 120
        }
      },
      disable_infinite_cloud_agent_stream_retries: {
        client: true,
        fallbackValues: {
          enabled: false
        }
      },
      cloud_agent_shared_blob_cache: {
        client: true,
        fallbackValues: {
          max_bytes: 128 * 1024 * 1024
        }
      },
      sand_min_client_version: {
        client: true,
        fallbackValues: {
          min_version: "",
          backend_min_version: ""
        }
      },
      sand_mobile_version_support: {
        client: true,
        fallbackValues: {
          min_recommended_build: 0,
          min_allowed_build: 0,
          update_url: ""
        }
      },
      sand_computer_use_playwright_config: {
        client: true,
        fallbackValues: {
          modelId: "claude-opus-4-8",
          maxMode: false,
          parameters: [
            { id: "thinking", value: "false" },
            { id: "effort", value: "low" }
          ]
        }
      },
      sand_browser_use_model: {
        client: true,
        // Mirrors the computer-use fallback's low-latency profile: DOM automation
        // is the same tight see-act loop, so per-step thinking is traded away and
        // effort pinned low (an absent effort would fill from the non-max catalog
        // default, high, and undo the win).
        fallbackValues: {
          modelId: "claude-opus-4-8",
          maxMode: false,
          parameters: [
            { id: "thinking", value: "false" },
            { id: "effort", value: "low" }
          ]
        }
      },
      grok_bot_conversation_size_limits: {
        client: true,
        fallbackValues: {
          soft_limit_mb: 256,
          hard_limit_mb: 1024
        }
      },
      sand_model_filter: {
        client: true,
        fallbackValues: {
          allowedModelIds: [],
          defaultParameters: {}
        }
      },
      sand_default_model: {
        client: true,
        // The routed `default` tier (Auto), parameterless and non-max — exactly the
        // request the retired `sand_default_model_auto` gate produced while ON,
        // which is where every allocated treatment user sits today. Keeping it as
        // the fallback is what makes the gate→config migration inert: a console
        // config that does not exist yet, or an evaluation that has not landed,
        // resolves to the same bytes the gate did. Routed ids take no parameters
        // (resolveLegacySlugFromMcidAndParams flags any as unexpected), so this
        // must stay parameterless.
        fallbackValues: {
          modelId: "default",
          maxMode: false,
          parameters: []
        }
      },
      sand_automations_model: {
        client: true,
        // The same routed `default` tier (Auto) `sand_default_model` falls back to,
        // which is where every allocated treatment user's automations sit today.
        // Keeping the two fallbacks identical is what makes shipping this config
        // inert: with nothing published, an automation run resolves to the same
        // bytes it resolves to now. Routed ids take no parameters
        // (resolveLegacySlugFromMcidAndParams flags any as unexpected), so this
        // must stay parameterless.
        //
        // OPERATOR NOTE: this config REPLACES `sand_default_model` for automation
        // runs rather than layering on it, so the two slots move independently in
        // both directions — publishing (or rolling back) one leaves the other where
        // it was. Nothing forks by turn source in code: an automation run diverges
        // only where an operator published a divergence here.
        fallbackValues: {
          modelId: "default",
          maxMode: false,
          parameters: []
        }
      },
      agent_store_sync_client_config: {
        client: true,
        fallbackValues: {
          // Mirrors AGENT_STORE_SYNC_CLIENT_CONFIG_DEFAULTS in
          // packages/agent-store-sync/src/sync-client-config.ts.
          sync_debounce_ms: 5e3,
          sync_backoff_base_ms: 5e3,
          sync_backoff_max_ms: 6e4,
          passive_retry_interval_ms: 5e3,
          passive_index_poll_interval_ms: 2e3,
          max_file_size_bytes: 100 * 1024 * 1024,
          token_refresh_buffer_ms: 6e4,
          rpc_retry_max_attempts: 3,
          rpc_retry_base_delay_ms: 250,
          rpc_retry_max_delay_ms: 5e3,
          rpc_retry_multiplier: 2,
          rpc_timeout_ms: 6e4,
          blob_idle_timeout_ms: 6e4,
          sync_round_timeout_ms: 3e5,
          sync_round_unwind_timeout_ms: 3e4,
          lock_release_failure_threshold: 3,
          resume_gap_threshold_ms: 12e4,
          dirty_passive_stalled_threshold_ms: 12e4,
          s3_concurrency: 8,
          list_concurrency: 4,
          hash_concurrency: 4,
          presign_concurrency: 4,
          multipart_upload_threshold_bytes: 64 * 1024 * 1024,
          multipart_part_size_bytes: 16 * 1024 * 1024,
          multipart_presign_window_size: 8,
          pull_presign_window_size: 500,
          multipart_complete_max_attempts: 3,
          multipart_max_restarts: 1,
          multipart_max_conflict_renames: 1,
          multipart_max_expiry_refreshes: 1,
          write_barrier_timeout_ms: 2e3,
          scoped_reserved_slots: 1,
          path_sync_request_poll_ms: 250,
          path_sync_request_wait_poll_ms: 50,
          surfaces: {}
        }
      },
      gemini_video_attachment_config: {
        client: true,
        fallbackValues: {
          maxBytes: 30 * 1024 * 1024,
          inlineMaxBytes: 15 * 1024 * 1024,
          signedUrlMaxBytes: 15 * 1024 * 1024,
          cloudMaxVideoAttachmentsPerRequest: 5,
          cloudMaxDocumentAttachmentsPerRequest: 5,
          localMaxVideoAttachmentsPerRequest: 5,
          localMaxTotalInlineVideoBytesPerRequest: 35 * 1024 * 1024
        }
      },
      agent_layout_migration: {
        client: true,
        fallbackValues: {
          showSettings: false,
          keepIsland: false,
          sidebarLocation: "noop"
        }
      },
      default_diff_mode: {
        client: true,
        fallbackValues: {
          default_diff_mode: "diffs"
        }
      },
      switch_mode_tool_config: {
        client: true,
        fallbackValues: {
          enabledForNal: false,
          enabledForOal: false,
          fromModes: [],
          targetModes: []
        }
      },
      mcp_auth_status_copy_config: {
        client: true,
        fallbackValues: {
          authToolDescription: "Authenticate this MCP server so its tools can be used. Call this tool through your MCP tool-calling interface when STATUS.md indicates this server needs authentication.",
          errorStatusMessage: "The MCP server errored. If this server is important for completing the task, concisely inform the user and ask them to check the MCP status in Cursor's Customize page > MCPs; otherwise continue with a different approach.",
          needsAuthStatusMessageWithAuthTool: 'The MCP server needs authentication. Authenticate it by calling the `{authToolName}` tool for server "{serverIdentifier}" through your MCP tool-calling interface using an empty arguments object. If this server is important for completing the task, authenticate it first; otherwise continue with a different approach.'
        }
      },
      mcp_reconnect_config: {
        client: true,
        fallbackValues: {
          fastRetryBaseDelayMs: 5e3,
          fastRetryMaxDelayMs: 6e4,
          fastRetryMaxAttempts: 5,
          periodicRetryBaseDelayMs: 5 * 6e4,
          periodicRetryMaxDelayMs: 30 * 6e4,
          maxPeriodicCycles: null,
          focusRetryCooldownMs: 5 * 6e4,
          inlineReconnectCooldownMs: 5 * 6e4,
          oauthBackendRefreshHydrationPollIntervalMs: 500,
          streamableHttpSession404TombstoneThreshold: 5,
          healthProbeTimeoutMs: 1e4,
          // AQ-1514: keep bounded timeouts on by default; set false to revert to 1h hard timeout.
          toolCallBoundedTimeoutEnabled: true,
          toolCallIdleTimeoutMs: 12e4,
          toolCallMaxTotalTimeoutMs: 60 * 6e4,
          degradedProbeDelayMs: 3e4,
          maxDegradedProbeFailures: 3,
          keepaliveProbeDelayMs: 5 * 6e4,
          keepaliveJitterMs: 3e4,
          stabilityThresholdMs: 3e4,
          stdioConnectFailuresAreNonRetryable: true,
          retryNonRetryableOnWake: false,
          nonRetryableWakeRetryCooldownMs: 5 * 6e4,
          retryNonRetryableAutomatically: false,
          networkResumeReconnectEnabled: false,
          networkResumeReconnectDebounceMs: 5e3,
          overrides: null
        }
      },
      mcp_oauth_sweep_config: {
        client: true,
        fallbackValues: {
          oauthAttemptTtlMs: 36e5,
          refreshLockTtlMs: null,
          refreshLockMaxHoldMs: 12e4,
          registrationLockTtlMs: null
        }
      },
      mcp_oauth_refresh_policy: {
        client: true,
        fallbackValues: {
          classifyBeforeWipe: false
        }
      },
      mcp_oauth_loopback_redirect: {
        client: true,
        fallbackValues: {
          enabled: false,
          denylist: []
        }
      },
      mcp_oauth_backend_redis_lock_config: {
        client: true,
        fallbackValues: {
          operations: ["refresh"],
          executorKinds: ["backendHttpMcp", "cloudAgent"],
          providerAllowlist: [],
          fallbackMode: "fail_open",
          refreshLockTtlMs: 3e4,
          registrationLockTtlMs: 3e4,
          waitPollIntervalMs: 250,
          waitJitterMs: 100,
          maxWaitMs: 3e4
        }
      },
      sand_pressure_cpu_profiler_config: {
        client: true,
        // Conservative first deployment; tune via Statsig without a host roll.
        fallbackValues: {
          sustainedPressureWindowMs: 15e4,
          profileDurationMs: 15e3,
          minIntervalMs: 216e5,
          maxRetainedProfiles: 3
        }
      },
      inline_diff_performance_config: {
        client: true,
        fallbackValues: {
          maxDecorations: 100
        }
      },
      tray_refresh_config: {
        client: true,
        fallbackValues: {
          enableMainProcessCloudRefresh: false,
          activeIntervalMs: 15e3,
          idleIntervalMs: 6e4,
          emptyIntervalMs: 3e5,
          engagementThrottleMs: 5e3,
          menuCap: 25,
          enablePoll: true,
          enableEngagement: true,
          enablePower: true
        }
      },
      performance_events_config: {
        client: true,
        fallbackValues: {
          enabled: false,
          flushIntervalMs: 3e4,
          sampleRate: 0,
          maxScriptsPerLoaf: 10,
          maxBatchBytes: 32 * 1024,
          // We only need enough LoAFs to correlate with RendererBlocked reports,
          // not exhaustive capture: only frames at least this long are recorded,
          // and at most maxEventsPerFlush LoAFs are kept per flush window.
          loafThresholdMs: 1e3,
          maxEventsPerFlush: 20
        }
      },
      background_composer_list_limit: {
        client: true,
        fallbackValues: {
          limit: 32
        }
      },
      switch_to_model_slug_config: {
        client: true,
        fallbackValues: {
          modelSlug: "",
          modelIdWithParams: {
            modelId: "",
            params: []
          }
        }
      },
      debug_mode_ui_instructions_config: {
        client: true,
        fallbackValues: {
          proceed_instructions: "Issue reproduced, please proceed",
          mark_fixed_instructions: "The issue has been fixed. Please clean up the instrumentation."
        }
      },
      user_intent_config: {
        client: true,
        fallbackValues: {
          maxChatsToRead: 100,
          maxProjectsToGroup: 5,
          model: "claude-4.5-opus-high-thinking",
          promptTemplate: `You are analyzing conversation transcripts to identify repeated user behaviors.

## Transcript Location
Transcripts are stored at: {{agentTranscriptsPath}}

## Transcript Format
Each '.txt' file is a human-readable conversation transcript with this structure:
- 'user:' sections contain user messages (often wrapped in '<user_query>' tags)
- 'assistant:' sections contain assistant responses
- '[Tool call]' blocks show which tools were invoked
- '[Tool result]' blocks show tool outputs

Files can be large. Focus on extracting the '<user_query>' sections which contain the actual user requests. Do NOT try to read the entire file contents because it will pollute your context.

## How to Read Transcripts
1. Use Glob to list files: "{{agentTranscriptsPath}}/*.txt"
2. For each file, extract just the '<user_query>' blocks - these show what users asked for
3. You can use Grep to search for '<user_query>' patterns across files

## Task
Analyze the {{maxChatsToRead}} most recent conversations (by file modification time). Be thorough and do not bias towards recency when analyzing conversations. Ignore trivial conversations and conversations where nothing concrete happened.

Your goal is to understand how the user interacts with the agent. Focus especially on the corrections that the user makes repeatedly. Focus on common terminal commands/workflows the user instructs the agent to do, changes, and other very stable patterns.

## Evidence Standards
When making claims about what the agent SHOULD or SHOULD NOT do, only cite conversations where:
- The user explicitly corrected the agent for doing something wrong
- The user undid or rejected an agent action
- The user gave an explicit instruction ('don\\'t do X', 'always do Y')

Do NOT infer 'don\\'t do X' from:
- The user asking a question about X (e.g., 'should we add tests?' does not mean 'don\\'t add tests proactively')
- The user doing X themselves (doesn't mean the agent shouldn't)
- Absence of the agent doing X

For each claim, ask: 'Is there a conversation where the user pushed back on the agent for doing this?' If not, don't include it as a guideline. For each piece of information you discern, you must cite 4 conversations. For each citation, verify that the conversation actually backs up your claim. Never include direct quotes from user messages; summarize at a high level.

These are the sections to cover. Do not overlap these with existing user and project rules; if there is overlap or conflict always go with the existing rules.

- Developer profile: How does the user interact with the agent. Focus on how much autonomy they like to give the agent vs. how much they would like to oversee the changes the agent is making. What is their workflow for getting tasks done. What kind of tasks do they often work on. Verify across many conversations, and do not extrapolate too hard.
- Frequented areas of the codebase: Parts of the codebase the user primarily works in, and what kinds of tasks correspond to each part of the codebase.
- Important terminal commands: Terminal commands/workflows the user runs repeatedly that are unique to the project/user workflow, and when they should be used. Focus on test, lint, and build commands. Do not include git commands.

Do not write any files in this step. You will be asked in a follow-up message to write the final user profile to disk.`,
          secondStepPromptTemplate: `Turn your analysis into a concise 'index.md' markdown file that will be shown to all agents in the future.

Write the file contents to: {{userIntentDirPath}}
(This is a temporary file path and will be atomically moved to {{finalUserIntentDirPath}}.)

Requirements:
- Do not cite user messages or transcripts directly (no quotes)
- Avoid overly specific task details; focus on stable patterns and preferences
- Keep it reasonably short
- For each guideline/claim, include 4 conversation citations and verify that each citation supports the claim`
        }
      },
      browser_default_url_config: {
        client: true,
        fallbackValues: {
          defaultUrl: "https://cursor.com"
        }
      },
      glass_per_app_tabs_config: {
        client: true,
        fallbackValues: {
          agentTabSelectionTTL: 3e4
        }
      },
      glass_tiling_config: {
        client: true,
        fallbackValues: {
          showDraftsInSidebar: false
        }
      },
      glass_fsd_launch_pill_config: {
        client: true,
        fallbackValues: {
          pillLabel: "Autopilot PR",
          tooltip: "Fix CI, conflicts, and comments with full self driving",
          dropdownAriaLabel: "Autopilot PR runtime",
          cloudOptionLabel: "Run in Cloud",
          localOptionLabel: "Run locally in a Worktree",
          fixCiPillSingleLabel: "Debug CI Failure",
          fixCiPillPluralLabelTemplate: "Debug {count} CI Failures",
          fixCiPillLoadingLabel: "Debugging CI",
          fixCiPillLoadingProgressLabel: "Debugging CI",
          fsdFixCiPillSingleLabel: "Fix CI with FSD",
          fsdFixCiPillPluralLabelTemplate: "Fix {count} CI Failures with FSD",
          fsdFixCiPillLoadingLabel: "Fixing CI with FSD",
          fsdFixCiPillLoadingProgressLabel: "Fixing CI with FSD"
        }
      },
      glass_btw_side_question_prompt_config: {
        client: true,
        fallbackValues: {
          promptTemplate: [
            "You are answering a single ephemeral question about the user's current work. Use the provided conversation as context and respond directly in one answer. Do not ask follow-up questions, do not request mode switches, and do not mention tool limitations unless absolutely necessary.",
            "If the conversation does not contain enough to answer, say so briefly.",
            "",
            "{{question}}"
          ].join("\n")
        }
      },
      // Per-repository LRU cap for Glass loaded agents; default 5 matches the previously hardcoded cap.
      glass_loaded_agent_lru_cap: {
        client: true,
        fallbackValues: {
          max_loaded_agents: 5
        }
      },
      // Datadog reporting of Glass workspace lifecycle; disabled until the Statsig config turns it on.
      glass_workspace_lifecycle_metrics: {
        client: true,
        fallbackValues: {
          enabled: false,
          sweep_interval_ms: 6e4,
          retained_after_close_threshold_ms: 45e3
        }
      },
      glass_pr_operations_polling_config: {
        client: true,
        fallbackValues: {
          prChecksPollIntervalMs: 3e4,
          prChecksPollMaxBackoffMs: 18e4,
          prChecksErrorBackoffMultiplier: 1.5,
          // Intentionally 15m (not legacy 60s): bounds Redis hits; Glass may force provider reads via skipCache.
          prChecksCacheTtlSeconds: 900,
          scmPrMetadataCacheTtlSeconds: 60 * 60,
          scmPrDetailedStatusCacheTtlSeconds: 60,
          scmPrForBranchCacheTtlWhenPrsSeconds: 60,
          scmPrForBranchCacheTtlWhenEmptySeconds: 10,
          scmPrCodeownersCacheTtlSeconds: 300,
          scmPrCommitsCacheTtlSeconds: 300,
          scmPrTimelineEventsCacheTtlSeconds: 300,
          scmPrDiscussionsCacheTtlSeconds: 300,
          scmPrCheckLogExcerptOkTtlSeconds: 120,
          scmPrCheckLogExcerptNegativeTtlSeconds: 30,
          detailedPrStatusChecksScopedAuthBreakerTtlSeconds: 15 * 60,
          scmGitlabEmojiReactionCacheTtlSeconds: 30 * 60,
          localAgentPrHeaderBatchPollIntervalMs: 3e4,
          localAgentPrStatePollIntervalMs: 10 * 6e4,
          localAgentPrBurstBumpOffsetsMs: [
            3e3,
            6e3,
            9e3,
            15e3,
            2e4,
            25e3,
            3e4
          ],
          cloudAgentPrStatePollIntervalMs: 6e4,
          cloudAgentPrBurstBumpOffsetsMs: [
            3e3,
            6e3,
            9e3,
            15e3,
            2e4,
            25e3,
            3e4
          ],
          cloudAgentPrStatePollMaxBackoffMs: 3e5,
          cloudAgentPrErrorBackoffMultiplier: 1.5
        }
      },
      cloud_agent_stream_reattach: {
        client: true,
        fallbackValues: {
          enabled: true,
          rehydrateAfterMs: 12e4
        }
      },
      tool_limits_config: {
        client: true,
        fallbackValues: {
          readFilesToolMaxFileSizeInBytes: 2e6,
          editFileToolMaxFileSizeInChars: 15e4,
          fileSearchToolMaxResults: 10,
          listDirV2ClientSideCharacterBudget: 1e3,
          readFileV2ToolMaxFileSizeInBytes: 2e8,
          composerDiffMaxComputationTimeMs: 2e3
        }
      },
      /** Update prompt configuration for controlling frequency and throttling */
      update_prompt_config: {
        client: true,
        fallbackValues: {
          min_hours_between_prompts: 48,
          max_prompts_per_version: 3,
          max_prompts_per_day: 1,
          snooze_duration_hours: 72
        }
      },
      internal_release_track_override: {
        client: true,
        fallbackValues: {
          releaseTrack: "",
          statsigUrl: "",
          unlockInternalTracks: false
        }
      },
      sand_internal_release_track_override: {
        client: true,
        fallbackValues: {
          releaseTrack: "",
          unlockInternalTracks: false
        }
      },
      /** Configuration for giant JSON.stringify detection */
      giant_json_stringify_config: {
        client: true,
        fallbackValues: {
          sentry_threshold_bytes: 1e7,
          attach_content: false
        }
      },
      /** Configuration for giant buffer retention detection */
      giant_buffer_retention_config: {
        client: true,
        fallbackValues: {
          allocation_threshold_bytes: 32 * 1024 * 1024,
          blob_url_threshold_bytes: 32 * 1024 * 1024,
          retention_age_ms: 5 * 6e4,
          sweep_interval_ms: 6e4
        }
      },
      /** Configuration for giant JSON.parse detection */
      giant_json_parse_config: {
        client: true,
        fallbackValues: {
          sentry_threshold_bytes: 1e9
        }
      },
      /** Configuration for giant VSBuffer decode (TextDecoder) detection */
      giant_vsbuffer_decode_config: {
        client: true,
        fallbackValues: {
          sentry_threshold_bytes: 2e7
        }
      },
      /** MCP IPC timeouts (ms) */
      mcp_ipc_timeouts: {
        client: true,
        fallbackValues: {
          metadata_timeout_ms: 1e4,
          lifecycle_timeout_ms: 1e4,
          dashboard_timeout_ms: 1e4,
          recovery_per_retry_timeout_ms: 1e4
        }
      },
      /** Configuration for the agent-backend override - list of models eligible for the claude-code backend */
      cc_override_models_config: {
        client: true,
        fallbackValues: {
          models: []
        }
      },
      sentry_session_recording_config: {
        client: true,
        fallbackValues: {
          replays_session_sample_rate: 0
        }
      },
      /**
       * ⚠️ SECURITY WARNING: Extension Signature Verification Bypass List ⚠️
       *
       * Extensions in this list bypass ALL signature verification checks.
       * This is a TEMPORARY workaround for extensions that lack proper OpenVSX signatures.
       *
       * RETIRE THIS CONFIG once upstream signatures exist for all listed extensions.
       * Each extension here represents a potential attack vector if compromised.
       */
      extension_signature_verification_bypass_list: {
        client: true,
        fallbackValues: {
          extensionIds: [
            // Extensions without proper OpenVSX signatures - REMOVE as they get signed
            "nromanov.dotrush",
            "ms-python.python",
            "typescriptteam.native-preview",
            "typespec.typespec-vscode",
            "ms-toolsai.jupyter",
            "k3ndr1ckfu.tcl-language-support-for-vscode",
            "amiq.dvt"
          ],
          remoteVerificationMinVersion: "2.25.0"
        }
      },
      /** Server-controlled default network allowlist for sandboxed commands */
      sandbox_default_network_allowlist: {
        client: true,
        fallbackValues: {
          allowlist: []
        }
      },
      /** UI labels for the auto spillover 2-bar UI in the spending tab */
      auto_spillover_ui_config: {
        client: true,
        fallbackValues: AUTO_SPILLOVER_UI_DEFAULTS
      },
      portal_outage_alert: {
        client: true,
        fallbackValues: {
          enabled: false,
          title: "",
          description: ""
        }
      },
      slack_mcp_client_id: {
        client: true,
        fallbackValues: {
          clientId: "3660753192626.8903469228982"
        }
      },
      file_watcher_metrics_config: {
        client: true,
        fallbackValues: { flush_delay_ms: 3e4 }
      },
      file_watcher_forwarded_storm_config: {
        client: true,
        fallbackValues: {
          window_ms: 1e4,
          min_events: 2500,
          report_throttle_ms: 5 * 6e4,
          top_buckets: 8
        }
      },
      statsig_dummy_gauge_config: {
        client: true,
        fallbackValues: { dummy: 0 }
      },
      /** @deprecated Retained for released clients; new clients use memory_monitor_config. */
      memory_monitor_user_toast_config: {
        client: true,
        fallbackValues: { heap_percent: 80 }
      },
      cpu_monitor_config: {
        client: true,
        fallbackValues: {
          total_cpu_percent: 250,
          process_cpu_percent: 95,
          sustained_seconds: 60,
          check_interval_seconds: 15,
          cooldown_seconds: 1800,
          include_system_processes: true
        }
      },
      /** @deprecated Retained for released clients; new clients use memory_monitor_config. */
      memory_pressure_profiling_config: {
        client: true,
        fallbackValues: {
          trigger_heap_percent: 70,
          duration_seconds: 30,
          sampling_interval_bytes: 4096,
          cooldown_seconds: 300
        }
      },
      memory_monitor_config: {
        client: true,
        fallbackValues: {
          base_threshold_mb: 1536,
          critical_offset_mb: 512,
          show_status_entry: false,
          show_internal_warning_popup: false,
          show_user_toast: true,
          user_toast_heap_percent: 80,
          emit_heap_usage_metric: false,
          emergency_profiling_enabled: true,
          emergency_profiling_trigger_heap_percent: 70,
          emergency_profiling_duration_seconds: 30,
          emergency_profiling_sampling_interval_bytes: 4096,
          emergency_profiling_cooldown_seconds: 300
        }
      },
      plugin_onboarding_by_job_role: {
        client: true,
        fallbackValues: {
          byJobRole: {},
          recommendedPluginNamesByJobRole: {}
        }
      },
      leaked_disposables_tracker: {
        client: true,
        fallbackValues: {
          enabled: false,
          reportIntervalMs: 6e4
        }
      },
      solidjs_memo_audit_config: {
        client: true,
        fallbackValues: {
          enabled: false,
          sampleRate: 1,
          maxEventsPerFlush: 5e4,
          reportIntervalMs: 6e4,
          deepProbe: false,
          deepProbeSampleRate: 0.01,
          deepProbeMaxBytes: 16384,
          stackAttribution: false,
          stackCreationSampleRate: 0.02,
          stackRedundantThreshold: 2,
          maxTrackedCreationStacks: 500,
          maxStackReportsPerSession: 10,
          maxStackBytes: 4e3
        }
      },
      solidjs_listener_stacks_config: {
        client: true,
        fallbackValues: {
          enabled: false,
          sampleRate: 1,
          observerThreshold: 2e3,
          maxTrackedSources: 500,
          maxReportsPerSession: 10,
          maxStackBytes: 4e3,
          totalObserverThreshold: 0,
          totalTriggeredSourceFloor: 200,
          totalTriggeredMaxReports: 20
        }
      },
      shell_exec_output_backpressure_config: {
        client: true,
        fallbackValues: {
          outputSuppressionWindowMs: 6e4,
          outputSuppressionThresholdCharsPerSecond: 64 * 1024,
          outputSuppressionMinChars: 256 * 1024,
          outputLimiterFlushIntervalMs: 50,
          outputLimiterMaxBufferedBytes: 256 * 1024,
          extHostMinBatchIntervalMs: 50,
          extHostMaxBatchIntervalMs: 500,
          extHostBytesPerIntervalStep: 1e4
        }
      },
      canvas_prompt_text_config: {
        client: true,
        fallbackValues: {
          skillDescription: "A Cursor Canvas is a live React app that the user can open beside the chat. You MUST use a canvas when the agent produces a standalone analytical artifact \u2014 quantitative analyses, billing investigations, security audits, architecture reviews, data-heavy content, timelines, charts, tables, interactive explorations, repeatable tools, or any response that benefits from visual layout. Especially prefer a canvas when presenting results from MCP tools (Datadog, Databricks, Linear, Sentry, Slack, etc.) where the data is the deliverable \u2014 render it in a rich canvas rather than dumping it into a markdown table or code block. If you catch yourself about to write a markdown table, stop and use a canvas instead. You MUST also read this skill whenever you create, edit, or debug any .canvas.tsx file.",
          errorFixPromptTemplate: [
            "The canvas at `{canvasPath}` has the following error:",
            "",
            '"""',
            "{errorMessage}",
            '"""',
            "",
            "Check if the canvas SDK has changed since this canvas was created.",
            "Update the canvas to use the latest SDK components according to the supplied documentation in the canvas skill."
          ].join("\n"),
          welcomePageEnabled: true,
          marketplaceCategoryKey: "canvas-featured",
          marketplaceMaxCards: 4
        }
      },
      glass_start_onboarding_pill_config: {
        client: true,
        fallbackValues: {
          label: "Start onboarding",
          icon: "sparkles"
        }
      },
      glass_ftux_first_action_config: {
        client: true,
        fallbackValues: {
          byJobRole: {}
        }
      },
      shutdown_hang_watchdog_config: {
        client: true,
        fallbackValues: {
          per_joiner_warn_ms: 2e3,
          fire_on_will_shutdown_total_ms: 3e3,
          process_exit_total_ms: 5e3
        }
      },
      update_diagnostics: {
        client: true,
        fallbackValues: {
          enabled: false,
          restart_time_threshold_seconds: 30,
          attach_ship_it_log: true,
          max_attachment_bytes: 5e6
        }
      },
      startup_diagnostics: {
        client: true,
        fallbackValues: {
          enabled: false,
          timer_name: "ellapsedLoadMainBundle",
          threshold_ms: 3e4
        }
      },
      renderer_ping_config: {
        client: true,
        fallbackValues: {
          enabled: false,
          ping_interval_ms: 5e3,
          block_threshold_ms: 15e3,
          collect_stack_traces: true,
          report_rpc_drain: false
        }
      },
      editor_input_latency_metrics_config: {
        client: true,
        fallbackValues: {
          enabled: false,
          sample_rate: 0.01,
          window_duration_ms: 6e4
        }
      },
      editor_tokenization_metrics_config: {
        client: true,
        fallbackValues: {
          enabled: false,
          sample_rate: 0.01,
          time_limit_ms: 500
        }
      },
      ripgrep_invocation_monitor_config: {
        client: true,
        fallbackValues: {
          window_ms: 1e4,
          threshold: 50,
          max_records: 100,
          cooldown_ms: 3e5,
          report_to_sentry: true,
          report_initialize_caches: false
        }
      },
      grep_fallback_monitor_config: {
        client: true,
        fallbackValues: {
          window_ms: 6e4,
          min_samples: 20,
          fallback_ratio_threshold: 0.5,
          cooldown_ms: 3e5,
          report_to_sentry: true
        }
      },
      instant_grep_indexing_config: {
        client: true,
        fallbackValues: {
          max_in_memory_documents: null
        }
      },
      git_diff_reply_limit_config: {
        client: true,
        fallbackValues: {
          enabled: true,
          max_reply_bytes: 31457280
        }
      },
      renderer_slow_interaction_sentry_config: {
        client: true,
        fallbackValues: {
          enabled: false,
          threshold_ms: 1e3
        }
      },
      glass_fps_monitor_config: {
        client: true,
        fallbackValues: {
          enabled: false,
          min_fps: 30,
          max_drops_per_interval: 3,
          interval_sec: 60,
          baseline_interval_sec: null,
          baseline_sample_rate: null
        }
      }
      /* END_DYNAMIC_CONFIGS */
    };
export type DynamicConfigName = keyof typeof DYNAMIC_CONFIGS;
export const DYNAMIC_CONFIGS_KEYS = Object.keys(DYNAMIC_CONFIGS) as DynamicConfigName[];

export const LAYERS = {
      /* BEGIN_LAYER_CONFIG */
      model_picker_experiments: {
        client: true,
        fallbackValues: {
          promote_first_party_variant: "control",
          effort_first_variant: "control",
          effort_first_compact_model_ids: ["grok-4.5", "grok-4.6"]
        },
        parseValue: {
          promote_first_party_variant: parseEnum([
            "control",
            "grok_primary",
            "pinned_selection",
            "grouped_auto_expand"
          ]),
          effort_first_variant: parseEnum(["control", "treatment"]),
          effort_first_compact_model_ids: parseStringArray
        }
      }
      /* END_LAYER_CONFIG */
    };
