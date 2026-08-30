import { z } from "zod";
import { GITHUB_EVENT_KINDS, LINEAR_EVENT_CASES, PAGERDUTY_EVENT_CASES, SENTRY_EVENT_CASES } from "../../../shared/automations.js";
import { slugifyWorkflowName } from "../../../shared/workflow-model.js";
import { stateWriteOk, type StateWriteResult } from "../agent-state.js";
import { defineCommunicateTool } from "./communicate-tool.js";
import { SandToolInputError } from "./tool-input-error.js";

export const SAND_UPDATE_STATE_TOOL_NAME = "update_state";
export const OPERATIONS = {
  memory: {
    write: 'save a durable fact (fact, tier, optional scope). scope "agent" (default) is your own memory; "user" is shared user-memory every assistant should know; "project" needs project=<slug> and writes your shard in that project. tier "profile" is foundational and kept in mind every turn; "log" (default) is dated history; "note" fades fast. Facts are deduped.',
    forget: "drop a fact by its EXACT recorded text (fact, same scope/project). Pair with a write for the corrected version.",
  },
  routine: {
    create: "save a standing order (name, prompt, and either schedule or trigger). prompt is what you do each time it fires, written to your future self.",
    update: "rewrite an existing one in place (id, plus any of name/prompt/schedule/trigger/enabled you mean to change). Omitted fields keep their current values; it keeps its history.",
    pause: "(id) disarm one the user wants back later.",
    resume: "(id) rearm a paused one.",
    delete: "(id) remove a finite watch as soon as it has done its job.",
  },
  workflow: {
    write: 'save or rewrite a reusable skill (name, description, body; id to rewrite). The description is REQUIRED and is what a reader uses to decide whether the skill applies, so write it as "use this when …". A workflow has no trigger — a saved task that runs on a schedule is a routine.',
    delete: "(id). Cursor-managed skills can't be edited or deleted.",
  },
  profile: { set: "your name and/or description. For your picture use target avatar." },
  settings: { set: "hidden_from_sidebar, notify_on_updates. Only the fields you pass change." },
  channel: { disconnect: "(platform). The connector closes the live connection within a few seconds." },
  project: {
    create: "(project slug, name, optional description). Creates the folder + project.md and joins it; if the slug already exists this is create-is-join.",
    join: "(project slug).",
    leave: "(project slug).",
  },
  avatar: {
    set: "(path to an image on your box or the host — write/download it first, then install it here; a box path under /workspace is fine).",
    clear: "back to the default picture.",
  },
} as const;

export type SandStateTarget = keyof typeof OPERATIONS;
export type SandStateAction = { [T in SandStateTarget]: keyof typeof OPERATIONS[T] }[SandStateTarget];
export const TARGETS = Object.keys(OPERATIONS) as SandStateTarget[];
export const ACTIONS = [...new Set(Object.values(OPERATIONS).flatMap((actions) => Object.keys(actions)))] as SandStateAction[];

export type StoredTrigger = Readonly<Record<string, unknown>>;
export interface SandStateUpdate {
  readonly target: SandStateTarget;
  readonly action: SandStateAction;
  readonly fact?: string;
  readonly tier?: "profile" | "log" | "note";
  readonly scope?: "agent" | "user" | "project";
  readonly project?: string;
  readonly id?: string;
  readonly name?: string;
  readonly prompt?: string;
  readonly schedule?: string;
  readonly trigger?: StoredTrigger | readonly StoredTrigger[];
  readonly enabled?: boolean;
  readonly description?: string;
  readonly body?: string;
  readonly hidden_from_sidebar?: boolean;
  readonly notify_on_updates?: boolean;
  readonly platform?: string;
  readonly path?: string;
}

const cronTriggerSchema = z.object({
  type: z.literal("cron"),
  schedule: z.string().trim().min(1).describe(`A 5-field cron expression in the user's local time ("0 7 * * *"), or a shorthand (@hourly/@daily/@weekly/@monthly, "@every 30m"). An hour with no minute takes the current minute off the <timestamp>: asked at 1:32, "daily at 2" is "32 2 * * *".`),
});
const slackTriggerSchema = z.object({
  type: z.literal("slack"),
  channel: z.string().trim().min(1).describe('A channel ("#eng"), a DM ("@dana"), or "*" for anywhere.'),
  match: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("mention") }),
    z.object({ kind: z.literal("keyword"), keyword: z.string().trim().min(1) }),
    z.object({ kind: z.literal("message") }),
    z.object({
      kind: z.literal("reaction"),
      emoji: z.array(z.string().trim().min(1)).optional().describe('Normalized short names without colons ("eyes", "white_check_mark"). Absent or empty means any emoji.'),
      bySelf: z.boolean().optional().describe("When true, only the user's own reactions fire it — not a colleague's."),
    }),
  ]).describe("What makes a message count as a match."),
});
const githubTriggerSchema = z.object({
  type: z.literal("github"),
  repo: z.string().trim().min(1).describe('One concrete "owner/name" repo. No wildcards.'),
  events: z.array(z.enum(GITHUB_EVENT_KINDS)).min(1).describe("Which GitHub events fire this routine."),
  userAllowlist: z.array(z.string().trim().min(1)).optional().describe('Git usernames that may fire this listener ("alice", "@bob"). Absent or empty means anyone. Does not apply to ci-passed/ci-failed — CI is never user-gated.'),
  ciBranch: z.string().trim().min(1).optional().describe('REQUIRED when events includes ci-passed or ci-failed: the one branch whose settled checks fire them ("main"). Since userAllowlist cannot narrow CI, a CI listener without it would fire for every pull request in the repo, so it is dropped instead. It fires when CI settles on a push or merge to that branch, not on pull-request checks.'),
});
const microsoftTeamsTriggerSchema = z.object({
  type: z.literal("microsoftTeams"),
  tenantId: z.string().trim().min(1).describe("The Microsoft Entra tenant ID."),
  teamId: z.string().optional().describe("One Microsoft Teams Graph API team ID. At least one of teamId or teamIds is required."),
  teamIds: z.array(z.string()).optional().describe("Microsoft Teams Graph API team IDs. At least one of teamId or teamIds is required."),
  channelIds: z.array(z.string()).optional().describe("Optional channel filter using Microsoft Teams Graph API channel IDs. Empty or absent means every channel."),
  messageContains: z.string().optional().describe("Optional message text filter. Empty or absent means any message."),
  messageContainsIsRegex: z.boolean().optional().describe("Whether messageContains is a regular expression."),
  blockUnauthenticatedTeamsUsers: z.boolean().optional().describe("When true, messages from unauthenticated Microsoft Teams users do not fire it."),
});
const linearTriggerSchema = z.object({
  type: z.literal("linear"),
  event: z.discriminatedUnion("case", [
    z.object({ case: z.literal(LINEAR_EVENT_CASES[0]).describe("Fire when a Linear issue is created.") }),
    z.object({ case: z.literal(LINEAR_EVENT_CASES[1]).describe("Fire when a Linear issue changes status."), statusIds: z.array(z.string()).optional().describe("Optional narrowing filter using Linear status UUIDs. Empty or absent means any status.") }),
    z.object({ case: z.literal(LINEAR_EVENT_CASES[2]).describe("Fire when a Linear cycle ends."), cycleIds: z.array(z.string()).optional().describe("Optional narrowing filter using Linear cycle UUIDs. Empty or absent means any cycle.") }),
  ]).describe("Which Linear event fires this routine."),
  projectIds: z.array(z.string()).optional().describe("Optional narrowing filter using Linear project UUIDs. Empty or absent means any project."),
  teamIds: z.array(z.string()).optional().describe("Optional narrowing filter using Linear team UUIDs. Empty or absent means any team."),
});
const sentryTriggerSchema = z.object({
  type: z.literal("sentry"),
  event: z.object({ case: z.enum(SENTRY_EVENT_CASES).describe("Which Sentry issue event fires the routine.") }).describe("The Sentry event to watch."),
  projectIds: z.array(z.string()).optional().describe("Optional project ID filter. Empty or absent means any Sentry project."),
});
const pagerdutyTriggerSchema = z.object({
  type: z.literal("pagerduty"),
  event: z.object({ case: z.enum(PAGERDUTY_EVENT_CASES).describe("Which PagerDuty incident event fires the routine.") }).describe("The PagerDuty event to watch."),
  serviceIds: z.array(z.string()).optional().describe("Optional service ID filter. Empty or absent means any PagerDuty service."),
});
const triggerMemberSchema = z.discriminatedUnion("type", [cronTriggerSchema, slackTriggerSchema, githubTriggerSchema, microsoftTeamsTriggerSchema, linearTriggerSchema, sentryTriggerSchema, pagerdutyTriggerSchema]);
const triggerSchema = z.union([
  z.discriminatedUnion("type", [
    cronTriggerSchema, slackTriggerSchema, githubTriggerSchema, microsoftTeamsTriggerSchema,
    linearTriggerSchema, sentryTriggerSchema, pagerdutyTriggerSchema,
    z.object({ type: z.literal("group"), listeners: z.array(triggerMemberSchema).min(1).describe("Any one of these fires the same prompt; cron members and listeners mix freely.") }),
  ]),
  z.array(triggerMemberSchema).min(1).describe("Bare-array shorthand for the group form: any one member fires the prompt."),
]).describe("What fires the routine. Prefer an event listener (Slack, GitHub, Microsoft Teams, Linear, Sentry, PagerDuty) over polling on a cron when the event you care about is one of the listed shapes; never pass both this and the schedule argument.");

export const sandUpdateStateParameters = z.object({
  target: z.enum(TARGETS as [SandStateTarget, ...SandStateTarget[]]).describe("Which part of your own state to change."),
  action: z.enum(ACTIONS as [SandStateAction, ...SandStateAction[]]).describe(`What to do. ${Object.entries(OPERATIONS).map(([target, actions]) => `${target}: ${Object.keys(actions).join(" | ")}`).join(". ")}.`),
  fact: z.string().trim().min(1).optional().describe("memory only. The fact, one self-contained sentence. For forget, the EXACT text of the recorded fact (read or grep the relevant memory folder first)."),
  tier: z.enum(["profile", "log", "note"]).optional().describe("memory write only. Defaults to log. Keep profile small."),
  scope: z.enum(["agent", "user", "project"]).optional().describe("memory only. Defaults to agent (your own memory)."),
  project: z.string().trim().min(1).optional().describe('Project slug. Required for memory when scope is "project", and for every project action.'),
  id: z.string().trim().min(1).optional().describe("The routine's folder or the workflow's id. Required for every routine action except create, and for workflow delete. Omit on a workflow write to create a new one."),
  name: z.string().trim().min(1).optional().describe("routine/workflow/project create: its name. Required on create and on a workflow write; on routine update, omit to keep the current name. profile: your new name."),
  prompt: z.string().trim().min(1).optional().describe("routine only. What you should do each time it fires, written to your future self. Write it as an INTENT, not a frozen tool recipe: a connector's schema can change between fires, so describe the goal and let each run look the tool up. Required on create; on update, omit to keep the current prompt."),
  schedule: z.string().trim().min(1).optional().describe(`routine only. Shorthand for a cron trigger \u2014 "0 7 * * *", "@daily", "@every 2h" \u2014 interpreted in the user's local time. An hour with no minute takes the current minute off the <timestamp>: asked at 1:32, "daily at 2" is "32 2 * * *". Use this OR trigger, never both. On update, omit (with trigger) to keep the current fire condition.`),
  trigger: triggerSchema.optional(),
  enabled: z.boolean().optional().describe("routine create/update only. On create, defaults to true. On update, omit to leave the current arming alone (use pause/resume to toggle)."),
  description: z.string().trim().optional().describe("workflow write: REQUIRED. One line on when to use the skill. profile: your new description. project create: optional summary."),
  body: z.string().trim().min(1).optional().describe("workflow write only. The recipe, in markdown."),
  hidden_from_sidebar: z.boolean().optional().describe("settings set only. Removes your row from the user's sidebar; you stay fully functional and reachable through Cmd-K and the Hidden chats manager."),
  notify_on_updates: z.boolean().optional().describe('settings set only. The "Notify me about this assistant" toggle.'),
  platform: z.string().trim().min(1).optional().describe("channel disconnect only. The platform to disconnect."),
  path: z.string().trim().min(1).optional().describe("avatar set only. Absolute path to an image you already have (write or download it first, with Shell on your own computer or ExternalShell on the user's, then install it here). A path on your box under /workspace is fine — no CopyFromBox needed. png/jpg/webp/gif/svg under 5 MB."),
});

export interface AutomationRecord {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly trigger: StoredTrigger;
  readonly isEnabled: boolean;
}
export interface WorkflowRecord { readonly id: string; readonly name: string; readonly body: string }
export interface AutomationSpec { readonly name: string; readonly prompt: string; readonly trigger: StoredTrigger; readonly isEnabled?: boolean }
export interface AutomationReview {
  readonly operation: "create" | "update" | "workflow_body";
  readonly id?: string;
  readonly spec: AutomationSpec;
  readonly referencedWorkflows: readonly WorkflowRecord[];
  readonly referencingRoutines?: readonly Pick<AutomationRecord, "id" | "name" | "prompt">[];
}

type Outcome = StateWriteResult<string>;
export interface SandStateWriter {
  writeMemory(args: { content: string; tier: string; scope: string; project?: string }): Promise<Outcome>;
  removeMemory(args: { content: string; scope: string; project?: string }): Promise<Outcome>;
  createAutomation(args: { spec: AutomationSpec }): Promise<Outcome>;
  updateAutomation(args: { id: string; spec: AutomationSpec }): Promise<Outcome>;
  setAutomationEnabled(args: { id: string; isEnabled: boolean }): Promise<Outcome>;
  deleteAutomation(args: { id: string }): Promise<Outcome>;
  writeWorkflow(args: { id?: string; name: string; description: string; body: string }): Promise<Outcome>;
  deleteWorkflow(args: { id: string }): Promise<Outcome>;
  updateProfile(args: { name?: string; description?: string }): Promise<Outcome>;
  updateSettings(args: { hiddenFromSidebar?: boolean; notifyOnAgentUpdates?: boolean }): Promise<Outcome>;
  disconnectChannel(args: { platform: string }): Promise<Outcome>;
  createProject(args: { slug: string; name: string; description?: string }): Promise<Outcome>;
  joinProject(args: { slug: string }): Promise<Outcome>;
  leaveProject(args: { slug: string }): Promise<Outcome>;
  setAvatar(args: { path: string }): Promise<Outcome>;
  clearAvatar(): Promise<Outcome>;
}

export interface SandStateDependencies {
  readonly state: SandStateWriter;
  readonly toolCallId?: string;
  readonly automationStore?: { list(): readonly AutomationRecord[] };
  readonly workflowStore?: { list(): readonly WorkflowRecord[] };
  readonly parseTrigger?: (trigger: StoredTrigger | readonly StoredTrigger[]) => StoredTrigger | null;
  readonly reviewAutomationWrite?: (review: AutomationReview, toolCallId?: string) => Promise<{ readonly allowed: boolean; readonly reason: string } | undefined>;
  readonly onListenerRoutineSaved?: (trigger: StoredTrigger) => Promise<string | undefined>;
  readonly assertNoPendingAutoReviewApproval?: () => void;
}

function need<T>(value: T | null | undefined, field: string, args: SandStateUpdate): T {
  if (value == null) throw new SandToolInputError(`'${field}' is required for ${args.target} ${args.action}.`);
  return value;
}

function cronTrigger(schedule: string): StoredTrigger { return { type: "cron", schedule }; }

export function resolveTrigger(args: SandStateUpdate, deps: SandStateDependencies, fallback?: StoredTrigger): StoredTrigger {
  if (args.schedule != null && args.trigger != null) throw new SandToolInputError("pass either 'schedule' (a cron routine) or 'trigger' (an event-driven one), never both.");
  if (args.schedule != null) return cronTrigger(args.schedule);
  if (args.trigger != null) {
    const fallbackTrigger: StoredTrigger = Array.isArray(args.trigger)
      ? { type: "group", listeners: args.trigger }
      : args.trigger as StoredTrigger;
    const parsed = deps.parseTrigger === undefined
      ? fallbackTrigger
      : deps.parseTrigger(args.trigger);
    if (parsed == null) throw new SandToolInputError(`that trigger isn't usable \u2014 check the channel, repo (one concrete "owner/name"), event names, the ciBranch a ci-passed/ci-failed listener needs, and the tenantId plus at least one team id a microsoftTeams trigger needs.`);
    return parsed;
  }
  return need(fallback, "schedule' or 'trigger", args);
}

function promptReferencesWorkflow(prompt: string, workflow: Pick<WorkflowRecord, "id" | "name">): boolean {
  const lower = prompt.toLowerCase();
  return lower.includes(workflow.id.toLowerCase()) || lower.includes(workflow.name.toLowerCase());
}

function referencedWorkflows(prompt: string, deps: SandStateDependencies): WorkflowRecord[] {
  return [...(deps.workflowStore?.list() ?? [])].filter((workflow) => promptReferencesWorkflow(prompt, workflow));
}

async function writeAutomation(args: SandStateUpdate, deps: SandStateDependencies): Promise<Outcome> {
  const isUpdate = args.action === "update";
  const id = isUpdate ? need(args.id, "id", args) : undefined;
  const existing = id == null ? undefined : deps.automationStore?.list().find((routine) => routine.id === id);
  if (isUpdate && deps.automationStore != null && existing == null) throw new SandToolInputError(`no routine with folder "${id}" exists — list the automations folder, then pass its id.`);
  const spec: AutomationSpec = {
    name: args.name ?? need(existing?.name, "name", args),
    prompt: args.prompt ?? need(existing?.prompt, "prompt", args),
    trigger: resolveTrigger(args, deps, existing?.trigger),
    ...(args.enabled != null ? { isEnabled: args.enabled } : isUpdate ? {} : { isEnabled: true }),
  };
  const review = await deps.reviewAutomationWrite?.({
    operation: isUpdate ? "update" : "create",
    ...(id == null ? {} : { id }), spec, referencedWorkflows: referencedWorkflows(spec.prompt, deps),
  }, deps.toolCallId);
  if (review != null && !review.allowed) return { ok: false, reason: review.reason };
  const outcome = id == null ? await deps.state.createAutomation({ spec }) : await deps.state.updateAutomation({ id, spec });
  if (!outcome.ok) return outcome;
  const note = await deps.onListenerRoutineSaved?.(spec.trigger);
  return note == null ? outcome : stateWriteOk(`${outcome.detail}\n${note}`);
}

async function writeWorkflow(args: SandStateUpdate, deps: SandStateDependencies): Promise<Outcome> {
  const name = need(args.name, "name", args);
  const body = need(args.body, "body", args);
  const description = need(args.description, "description", args);
  const existing = args.id == null ? undefined : deps.workflowStore?.list().find((workflow) => workflow.id === args.id);
  const workflowId = args.id ?? existing?.id ?? slugifyWorkflowName(name);
  const mentions = [{ id: workflowId, name }, ...(existing != null && existing.name !== name ? [{ id: existing.id, name: existing.name }] : [])];
  const referencing = (deps.automationStore?.list() ?? []).filter((routine) => mentions.some((target) => promptReferencesWorkflow(routine.prompt, target)));
  if (referencing.length > 0) {
    const anchor = referencing[0];
    if (anchor == null) throw new Error();
    const review = await deps.reviewAutomationWrite?.({
      operation: "workflow_body", ...(args.id == null ? {} : { id: args.id }),
      spec: { name, prompt: body, trigger: anchor.trigger, isEnabled: referencing.some((routine) => routine.isEnabled) },
      referencedWorkflows: [{ id: workflowId, name, body }],
      referencingRoutines: referencing.map(({ id, name: routineName, prompt }) => ({ id, name: routineName, prompt })),
    }, deps.toolCallId);
    if (review != null && !review.allowed) return { ok: false, reason: review.reason };
  }
  return deps.state.writeWorkflow({ ...(args.id == null ? {} : { id: args.id }), name, description, body });
}

export function isSandStateRoute(value: string): boolean {
  const [target, action] = value.split(".");
  return target != null && action != null && target in OPERATIONS && action in OPERATIONS[target as SandStateTarget];
}

function optionalProject(args: SandStateUpdate): { project?: string } {
  return args.project == null ? {} : { project: args.project };
}

export async function applySandStateUpdate(args: SandStateUpdate, deps: SandStateDependencies): Promise<Outcome> {
  const key = `${args.target}.${args.action}`;
  if (!isSandStateRoute(key)) throw new SandToolInputError(`'${args.action}' is not an action on ${args.target}. ${args.target} takes: ${Object.keys(OPERATIONS[args.target]).join(" | ")}.`);
  switch (key) {
    case "memory.write": return deps.state.writeMemory({ content: need(args.fact, "fact", args), tier: args.tier ?? "log", scope: args.scope ?? "agent", ...optionalProject(args) });
    case "memory.forget": return deps.state.removeMemory({ content: need(args.fact, "fact", args), scope: args.scope ?? "agent", ...optionalProject(args) });
    case "routine.create": case "routine.update": return writeAutomation(args, deps);
    case "routine.pause": return deps.state.setAutomationEnabled({ id: need(args.id, "id", args), isEnabled: false });
    case "routine.resume": return deps.state.setAutomationEnabled({ id: need(args.id, "id", args), isEnabled: true });
    case "routine.delete": return deps.state.deleteAutomation({ id: need(args.id, "id", args) });
    case "workflow.write": return writeWorkflow(args, deps);
    case "workflow.delete": return deps.state.deleteWorkflow({ id: need(args.id, "id", args) });
    case "profile.set": return deps.state.updateProfile({ ...(args.name == null ? {} : { name: args.name }), ...(args.description == null ? {} : { description: args.description }) });
    case "settings.set": return deps.state.updateSettings({ ...(args.hidden_from_sidebar == null ? {} : { hiddenFromSidebar: args.hidden_from_sidebar }), ...(args.notify_on_updates == null ? {} : { notifyOnAgentUpdates: args.notify_on_updates }) });
    case "channel.disconnect": return deps.state.disconnectChannel({ platform: need(args.platform, "platform", args) });
    case "project.create": return deps.state.createProject({ slug: need(args.project, "project", args), name: need(args.name, "name", args), ...(args.description == null ? {} : { description: args.description }) });
    case "project.join": return deps.state.joinProject({ slug: need(args.project, "project", args) });
    case "project.leave": return deps.state.leaveProject({ slug: need(args.project, "project", args) });
    case "avatar.set": return deps.state.setAvatar({ path: need(args.path, "path", args) });
    case "avatar.clear": return deps.state.clearAvatar();
    default: throw new Error();
  }
}

export function describeStateUpdate(args: SandStateUpdate): string {
  if (args.target === "memory") return args.scope === "user" ? "user memory" : args.scope === "project" ? `project ${args.project ?? "memory"}` : "memory";
  if (args.target === "avatar") return "avatar";
  return args.name ?? args.project ?? args.id ?? args.platform ?? args.target;
}

export function createSandStateTool(deps: SandStateDependencies) {
  const operationLines = Object.entries(OPERATIONS).flatMap(([target, actions]) => Object.entries(actions).map(([action, text]) => `- ${target} ${action}: ${text}`));
  const description = [
    "Change your OWN durable state: what you remember (own, shared user, or project), the routines you run, the workflows you save, your profile and settings, which channels you're connected to, which projects you've joined, and your picture. Prefer this over editing those files with the shell — you still use shell tools to read and grep them.",
    "",
    "target + action:",
    ...operationLines,
    "",
    "Just do it and mention it in passing — don't narrate a save or ask permission for an ordinary one. Creating or changing a ROUTINE may ask the user to confirm, since it's the one change that acts while they're away; if it does, they'll see a card and you'll get their answer back as the tool result.",
  ].join("\n");
  return defineCommunicateTool(deps, {
    id: "PLATFORM_ACTION", name: SAND_UPDATE_STATE_TOOL_NAME,
    description,
    parameters: sandUpdateStateParameters,
    describeActivity: (args: SandStateUpdate) => ({ detail: describeStateUpdate(args) }),
    execute: async (_ctx, args: SandStateUpdate, runtime) => {
      runtime.assertNoPendingAutoReviewApproval?.();
      const outcome = await applySandStateUpdate(args, runtime);
      return outcome.ok ? outcome.detail : `Not saved — ${outcome.reason}`;
    },
  });
}
