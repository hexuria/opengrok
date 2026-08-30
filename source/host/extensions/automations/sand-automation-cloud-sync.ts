import { ConnectError, Code } from "@connectrpc/connect";
import {
  CreateAutomationRequest,
  CronTrigger,
  DeleteAutomationRequest,
  GitCICompletedEvent,
  GitCICompletionCondition,
  GitIssueAssignedEvent,
  GitPullRequestAction,
  GitPullRequestEvent,
  GitPullRequestReviewCommentEvent,
  GitPullRequestReviewEvent,
  GitPullRequestReviewRequestedEvent,
  GitReviewThreadEvent,
  GitTrigger,
  GitTrigger as ProtoGitTrigger,
  ListSandAutomationsRequest,
  Prompt,
  SlackAnyReactionAddedTrigger,
  SlackMentionTrigger,
  SlackReactionAddedTrigger,
  SlackTrigger,
  Trigger,
  UpdateAutomationRequest,
  Workflow,
} from "../../../packages/proto/generated/aiserver/v1/automations_pb.js";
import { expandCronAlias, splitScheduleTimeZone } from "../../../shared/automation-schedule.js";
import {
  isGithubCiEventKind,
  triggerCronSchedules,
  triggerEventTriggers,
  triggerListeners,
  type AutomationTrigger,
  type EventTrigger,
  type GithubTrigger,
} from "../../../shared/automations.js";
import { findSystemErrno } from "../../../shared/system-errno.js";
import { stableAutomationId } from "../../automations/automation-id.js";
import { sha256Hex } from "../../sha256.js";
import { backendCloudTrigger, type BackendCloudTrigger } from "./sand-automation-cloud-trigger.js";

export const SAND_SHADOW_MARKER_PREFIX = "sand-shadow:";
const NO_DESIRED_CLOUD_AUTOMATION_IDS = new Set<string>();

export interface ScheduledCloudAutomation {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly isEnabled: boolean;
  readonly trigger: AutomationTrigger;
}

export function isServerSchedulable(automation: { readonly trigger: AutomationTrigger }): boolean {
  return !triggerListeners(automation.trigger).some(
    (listener) => listener.type === "slack" && listener.channel.startsWith("@"),
  );
}

function remoteShadowAutomationsById(response: RemoteList): Map<string, RemoteAutomation> {
  return new Map(
    response.workflows.flatMap((entry) => {
      const automation = entry.workflow;
      return !automation?.description?.startsWith(SAND_SHADOW_MARKER_PREFIX)
        ? []
        : [[automation.automationId, automation] as const];
    }),
  );
}

function enabledRemoteAutomationIds(response: RemoteList): Set<string> {
  return new Set(
    response.workflows.flatMap((entry) => {
      const automation = entry.workflow;
      return automation?.enabled ? [automation.automationId] : [];
    }),
  );
}

function sameIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}

function sameSchedulingAuthority(
  left: SchedulingAuthority | undefined,
  right: SchedulingAuthority,
): boolean {
  return left !== undefined
    && sameIds(left.desiredCloudAutomationIds, right.desiredCloudAutomationIds)
    && sameIds(left.enabledRemoteAutomationIds, right.enabledRemoteAutomationIds);
}

function isConverged(
  remoteByAutomationId: ReadonlyMap<string, RemoteAutomation>,
  desiredByAutomationId: ReadonlyMap<string, CloudDefinition>,
): boolean {
  if (remoteByAutomationId.size !== desiredByAutomationId.size) return false;
  for (const [automationId, desired] of desiredByAutomationId) {
    const remote = remoteByAutomationId.get(automationId);
    if (remote === undefined || remote.description !== desired.marker || remote.enabled !== desired.enabled) return false;
  }
  return true;
}

function errorIdentity(error: unknown): { errorType: string; errorCode?: string } {
  const errorType = error instanceof Error ? error.constructor.name : typeof error;
  const errorCode = error instanceof ConnectError ? Code[error.code] : findSystemErrno(error);
  return errorCode === undefined ? { errorType } : { errorType, errorCode };
}

function slackTrigger(
  listener: Extract<EventTrigger, { type: "slack" }>,
  emojiName?: string,
): BackendCloudTrigger {
  const channels = [listener.channel];
  switch (listener.match.kind) {
    case "mention":
      return new Trigger({ trigger: { case: "slackMention", value: new SlackMentionTrigger({ channels }) } }) as unknown as BackendCloudTrigger;
    case "reaction": {
      const onlyOwnerReactions = listener.match.bySelf === true;
      return new Trigger({
        trigger: {
          case: emojiName === undefined ? "slackAnyReactionAdded" : "slackReactionAdded",
          value: emojiName === undefined
            ? new SlackAnyReactionAddedTrigger({ channels, onlyOwnerReactions })
            : new SlackReactionAddedTrigger({ channels, emojiName, onlyOwnerReactions }),
        },
      }) as unknown as BackendCloudTrigger;
    }
    case "keyword":
      return new Trigger({ trigger: { case: "slackTrigger", value: new SlackTrigger({ channels, messageContains: listener.match.keyword, topLevelOnly: false }) } }) as unknown as BackendCloudTrigger;
    case "message":
      return new Trigger({ trigger: { case: "slackTrigger", value: new SlackTrigger({ channels, topLevelOnly: false }) } }) as unknown as BackendCloudTrigger;
  }
}

function githubTrigger(listener: GithubTrigger, event: string): BackendCloudTrigger {
  const repos = [`https://github.com/${listener.repo}`];
  const userAllowlist = [...listener.userAllowlist ?? []];
  let value: ProtoGitTrigger["event"];
  switch (event) {
    case "pr-opened": value = { case: "pullRequest", value: new GitPullRequestEvent({ repos, prAction: GitPullRequestAction.OPENED }) }; break;
    case "pr-pushed": value = { case: "pullRequest", value: new GitPullRequestEvent({ repos, prAction: GitPullRequestAction.PUSHED }) }; break;
    case "pr-merged": value = { case: "pullRequest", value: new GitPullRequestEvent({ repos, prAction: GitPullRequestAction.MERGED }) }; break;
    case "pr-comment": value = { case: "pullRequest", value: new GitPullRequestEvent({ repos, prAction: GitPullRequestAction.COMMENTED }) }; break;
    case "review-requested": value = { case: "pullRequestReviewRequested", value: new GitPullRequestReviewRequestedEvent({ repos }) }; break;
    case "review-approved": value = { case: "pullRequestReview", value: new GitPullRequestReviewEvent({ repos, onApproved: true }) }; break;
    case "review-changes-requested": value = { case: "pullRequestReview", value: new GitPullRequestReviewEvent({ repos, onChangesRequested: true }) }; break;
    case "review-commented": value = { case: "pullRequestReview", value: new GitPullRequestReviewEvent({ repos, onCommented: true }) }; break;
    case "inline-review-comment": value = { case: "pullRequestReviewComment", value: new GitPullRequestReviewCommentEvent({ repos }) }; break;
    case "review-thread-resolved": value = { case: "reviewThread", value: new GitReviewThreadEvent({ repos, onResolved: true }) }; break;
    case "review-thread-unresolved": value = { case: "reviewThread", value: new GitReviewThreadEvent({ repos, onUnresolved: true }) }; break;
    case "issue-assigned": value = { case: "issueAssigned", value: new GitIssueAssignedEvent({ repos }) }; break;
    default: value = { case: undefined };
  }
  return new Trigger({ trigger: { case: "git", value: new GitTrigger({ event: value, userAllowlist }) } }) as unknown as BackendCloudTrigger;
}

function githubCiTrigger(args: { repo: string; branch: string; condition: GitCICompletionCondition }): BackendCloudTrigger {
  return new Trigger({
    trigger: {
      case: "git",
      value: new GitTrigger({
        event: { case: "ciCompleted", value: new GitCICompletedEvent({ repos: [`https://github.com/${args.repo}`], condition: args.condition, branch: args.branch }) },
      }),
    },
  }) as unknown as BackendCloudTrigger;
}

function ciCompletionCondition(events: readonly string[]): GitCICompletionCondition | null {
  const passed = events.includes("ci-passed");
  const failed = events.includes("ci-failed");
  if (passed && failed) return GitCICompletionCondition.GIT_CI_COMPLETION_CONDITION_ANY;
  if (passed) return GitCICompletionCondition.GIT_CI_COMPLETION_CONDITION_SUCCESS;
  if (failed) return GitCICompletionCondition.GIT_CI_COMPLETION_CONDITION_FAILURE;
  return null;
}

function nonCiEvents(listener: GithubTrigger): string[] {
  return listener.events.filter((event) => !isGithubCiEventKind(event));
}

function githubCiTriggers(listener: GithubTrigger): BackendCloudTrigger[] {
  const condition = ciCompletionCondition(listener.events);
  if (listener.ciBranch === undefined || listener.ciBranch === "" || condition === null) return [];
  return [githubCiTrigger({ repo: listener.repo, branch: listener.ciBranch, condition })];
}

function githubNonCiTriggers(
  listener: GithubTrigger,
  allowlistForEvent?: (event: string) => readonly string[],
): BackendCloudTrigger[] {
  return nonCiEvents(listener).map((event) => githubTrigger(
    allowlistForEvent === undefined
      ? listener
      : { ...listener, userAllowlist: [...allowlistForEvent(event)] },
    event,
  ));
}

function listenerTriggers(listener: EventTrigger): BackendCloudTrigger[] {
  switch (listener.type) {
    case "slack": {
      const emojis = listener.match.kind === "reaction" ? listener.match.emoji ?? [] : [];
      return emojis.length === 0 ? [slackTrigger(listener)] : emojis.map((emoji) => slackTrigger(listener, emoji));
    }
    case "github": return [...githubNonCiTriggers(listener), ...githubCiTriggers(listener)];
    case "microsoftTeams":
    case "linear":
    case "sentry":
    case "pagerduty":
      return [backendCloudTrigger(listener)];
  }
}

function unionAllowlists(existing: string[] | null, addition: string[] | null): string[] | null {
  if (existing === null || addition === null) return null;
  const merged = [...existing];
  for (const login of addition) {
    if (!merged.some((entry) => entry.toLowerCase() === login.toLowerCase())) merged.push(login);
  }
  return merged;
}

function groupListenerTriggers(listeners: readonly EventTrigger[]): BackendCloudTrigger[] {
  const mergedListeners: EventTrigger[] = [];
  const githubEventsByRepo = new Map<string, string[]>();
  const githubAllowlistsByRepo = new Map<string, Map<string, string[] | null>>();
  const ciEventsByRepoBranch = new Map<string, { repo: string; branch: string; events: string[] }>();
  for (const listener of listeners) {
    if (listener.type !== "github") {
      mergedListeners.push(listener);
      continue;
    }
    const repoKey = listener.repo.toLowerCase();
    const ciEvents = listener.events.filter(isGithubCiEventKind);
    if (listener.ciBranch !== undefined && listener.ciBranch !== "" && ciEvents.length > 0) {
      const branchKey = `${repoKey}\0${listener.ciBranch}`;
      const entry = ciEventsByRepoBranch.get(branchKey) ?? { repo: listener.repo, branch: listener.ciBranch, events: [] };
      for (const event of ciEvents) if (!entry.events.includes(event)) entry.events.push(event);
      ciEventsByRepoBranch.set(branchKey, entry);
    }
    const restriction = listener.userAllowlist !== undefined && listener.userAllowlist.length > 0 ? [...listener.userAllowlist] : null;
    const allowlistByEvent = githubAllowlistsByRepo.get(repoKey) ?? new Map<string, string[] | null>();
    githubAllowlistsByRepo.set(repoKey, allowlistByEvent);
    const listenerEvents = nonCiEvents(listener);
    for (const event of listenerEvents) {
      allowlistByEvent.set(event, allowlistByEvent.has(event) ? unionAllowlists(allowlistByEvent.get(event) ?? null, restriction) : restriction);
    }
    const existingEvents = githubEventsByRepo.get(repoKey);
    if (existingEvents !== undefined) {
      for (const event of listenerEvents) if (!existingEvents.includes(event)) existingEvents.push(event);
      continue;
    }
    githubEventsByRepo.set(repoKey, [...listenerEvents]);
    mergedListeners.push({ ...listener, events: [...listenerEvents] });
  }
  const ciTriggers: BackendCloudTrigger[] = [];
  for (const { repo, branch, events } of ciEventsByRepoBranch.values()) {
    const condition = ciCompletionCondition(events);
    if (condition !== null) ciTriggers.push(githubCiTrigger({ repo, branch, condition }));
  }
  return [
    ...mergedListeners.flatMap((listener) => {
      if (listener.type !== "github") return listenerTriggers(listener);
      const allowlistByEvent = githubAllowlistsByRepo.get(listener.repo.toLowerCase());
      return githubNonCiTriggers(listener, (event) => allowlistByEvent?.get(event) ?? []);
    }),
    ...ciTriggers,
  ];
}

function cronCloudTrigger(args: { schedule: string; timeZone?: string | undefined }): BackendCloudTrigger {
  const { schedule: expression, timeZone: pinnedZone } = splitScheduleTimeZone(args.schedule);
  const expanded = expandCronAlias(expression).replace(/^@every\b/i, "@every");
  const zone = pinnedZone ?? args.timeZone;
  const cron = zone !== undefined && !expanded.startsWith("@every") ? `CRON_TZ=${zone} ${expanded}` : expanded;
  return new Trigger({ trigger: { case: "cron", value: new CronTrigger({ cron }) } }) as unknown as BackendCloudTrigger;
}

function listenerCloudTriggers(listeners: readonly EventTrigger[]): BackendCloudTrigger[] {
  const [onlyListener] = listeners;
  if (onlyListener === undefined) return [];
  if (listeners.length === 1) return listenerTriggers(onlyListener);
  return groupListenerTriggers(listeners);
}

export function cloudTriggers(trigger: AutomationTrigger, timeZone?: string | undefined): BackendCloudTrigger[] | null {
  if (triggerListeners(trigger).some((listener) => listener.type === "slack" && listener.channel.startsWith("@"))) return null;
  return [
    ...triggerCronSchedules(trigger).map((schedule) => cronCloudTrigger({ schedule, timeZone })),
    ...listenerCloudTriggers(triggerEventTriggers(trigger)),
  ];
}

export interface CloudDefinition {
  readonly automationId: string;
  readonly enabled: boolean;
  readonly hash: string;
  readonly localId: string;
  readonly marker: string;
  readonly name: string;
  readonly workflow: Workflow;
}

export function sandCloudDefinition(args: { agentId: string; automation: ScheduledCloudAutomation; timeZone?: string | undefined }): CloudDefinition | null {
  const triggers = cloudTriggers(args.automation.trigger, args.timeZone);
  if (triggers === null) return null;
  const workflow = new Workflow({ triggers: [...triggers] as Trigger[], prompts: [new Prompt({ prompt: args.automation.prompt })] });
  const githubSubscriptionVersion = workflow.triggers.some((trigger) => trigger.trigger?.case === "git") ? "github-subscriptions-v1\0" : "";
  const prefix = Buffer.from(`${githubSubscriptionVersion}${args.automation.id}\0${args.automation.name}\0${String(args.automation.isEnabled)}\0`);
  const hash = sha256Hex(Buffer.concat([prefix, Buffer.from(workflow.toBinary())]));
  return {
    automationId: stableAutomationId({ agentId: args.agentId, localId: args.automation.id }),
    enabled: args.automation.isEnabled && isServerSchedulable(args.automation),
    hash,
    localId: args.automation.id,
    marker: `${SAND_SHADOW_MARKER_PREFIX}${hash}`,
    name: args.automation.name,
    workflow,
  };
}

export interface RemoteAutomation {
  readonly automationId: string;
  readonly description?: string;
  readonly enabled: boolean;
}
interface RemoteList { readonly workflows: readonly { readonly workflow?: RemoteAutomation }[] }
export interface CloudSyncClient {
  listSandAutomations(request: ListSandAutomationsRequest): Promise<RemoteList>;
  createSandAutomation(request: CreateAutomationRequest): Promise<unknown>;
  updateSandAutomation(request: UpdateAutomationRequest): Promise<unknown>;
  deleteSandAutomation(request: DeleteAutomationRequest): Promise<unknown>;
}
interface SchedulingEvidence { readonly kind: "known"; readonly enabledRemoteAutomationIds: Set<string> }
interface UnknownSchedulingEvidence { readonly kind: "unknown" }
type AnySchedulingEvidence = SchedulingEvidence | UnknownSchedulingEvidence;
interface SchedulingAuthority { readonly desiredCloudAutomationIds: Set<string>; readonly enabledRemoteAutomationIds: Set<string> }

export class SandAutomationCloudSync {
  private inFlight: Promise<void> | undefined;
  private rerun = false;
  private readonly lastSuccessfulFingerprintByAgent = new Map<string, string>();
  private readonly schedulingEvidenceByAgent = new Map<string, AnySchedulingEvidence>();
  private readonly lastNotifiedSchedulingAuthorityByAgent = new Map<string, SchedulingAuthority>();
  private readonly failedAgentIds = new Set<string>();
  private readonly pendingAgentDeletions = new Set<string>();
  private settings: { getUserTimeZone: () => string | undefined };

  constructor(private readonly deps: {
    readonly client: CloudSyncClient;
    readonly hasCredential: () => boolean;
    readonly listAgentIds: () => Promise<readonly string[]>;
    readonly listAutomations: () => Promise<readonly { agentId: string; automation: ScheduledCloudAutomation }[]>;
    readonly getTimeZone?: () => string | undefined;
    readonly inspectLocalDefinitions?: (agentId: string) => { state?: string; validDefinitionCount?: number } | undefined;
    readonly reportShadowPrune?: (report: Record<string, unknown>) => void;
    readonly onFailure: (failure: { agentId?: string; operation: string; error: unknown }) => void;
    readonly onRecovery: (agentId: string) => void;
    readonly onSchedulingAuthorityChanged: (agentId: string) => void;
    readonly reportDiagnostic?: (diagnostic: Record<string, unknown>) => void;
  }) {
    this.settings = { getUserTimeZone: deps.getTimeZone ?? (() => undefined) };
  }

  setSettings(settings: { getUserTimeZone: () => string | undefined }): void { this.settings = settings; }

  shouldScheduleLocally({ agentId, automation }: { agentId: string; automation: { readonly id?: string; readonly trigger: AutomationTrigger } }): boolean {
    if (!isServerSchedulable(automation)) return true;
    if (triggerListeners(automation.trigger).length === 0) return false;
    if (automation.id === undefined) return true;
    const evidence = this.schedulingEvidenceByAgent.get(agentId);
    if (evidence?.kind !== "known") return false;
    return !evidence.enabledRemoteAutomationIds.has(stableAutomationId({ agentId, localId: automation.id }));
  }

  reconcileNow(): Promise<void> {
    if (this.inFlight !== undefined) {
      this.rerun = true;
      return this.inFlight;
    }
    this.inFlight = this.reconcile().catch((error) => { this.recordFailure({ operation: "reconcile", error }); }).finally(() => {
      this.inFlight = undefined;
      if (this.rerun) {
        this.rerun = false;
        void this.reconcileNow();
      }
    });
    return this.inFlight;
  }

  async deleteAgent(agentId: string): Promise<boolean> {
    this.pendingAgentDeletions.add(agentId);
    const initial = await this.listRemote(agentId);
    if (initial === undefined) return false;
    const remoteAutomations = initial.workflows.flatMap((entry) => entry.workflow === undefined ? [] : [entry.workflow]);
    if (remoteAutomations.length === 0) {
      this.publishKnownSchedulingEvidence(agentId, initial, NO_DESIRED_CLOUD_AUTOMATION_IDS);
      this.finishAgentDeletion(agentId);
      return true;
    }
    let mutationFailed = false;
    for (const automation of remoteAutomations) {
      const succeeded = await this.runMutation(agentId, "delete", () => this.deps.client.deleteSandAutomation(new DeleteAutomationRequest({ automationId: automation.automationId })));
      mutationFailed ||= !succeeded;
    }
    const readback = await this.listRemote(agentId);
    if (readback === undefined) return false;
    this.publishKnownSchedulingEvidence(agentId, readback, NO_DESIRED_CLOUD_AUTOMATION_IDS);
    if (readback.workflows.some((entry) => entry.workflow !== undefined)) {
      if (!mutationFailed) this.recordFailure({ agentId, operation: "verify", error: new Error("Remote automation deletion did not converge") });
      return false;
    }
    this.finishAgentDeletion(agentId);
    return true;
  }

  private async retryPendingAgentDeletions(): Promise<void> {
    for (const agentId of [...this.pendingAgentDeletions]) await this.deleteAgent(agentId);
  }

  private async reconcile(): Promise<void> {
    if (!this.deps.hasCredential()) return;
    await this.retryPendingAgentDeletions();
    let scheduled: readonly { agentId: string; automation: ScheduledCloudAutomation }[];
    try { scheduled = await this.deps.listAutomations(); } catch (error) { this.recordFailure({ operation: "list-local", error }); return; }
    let listedAgentIds: readonly string[];
    try { listedAgentIds = await this.deps.listAgentIds(); } catch (error) { this.recordFailure({ operation: "list-agents", error }); return; }
    const agentIds = new Set(listedAgentIds);
    const desiredByAgent = new Map<string, Map<string, CloudDefinition>>();
    const timeZone = this.settings.getUserTimeZone();
    for (const { agentId, automation } of scheduled) {
      agentIds.add(agentId);
      const desired = sandCloudDefinition({ agentId, automation, timeZone });
      if (desired === null) continue;
      const byAutomationId = desiredByAgent.get(agentId) ?? new Map<string, CloudDefinition>();
      byAutomationId.set(desired.automationId, desired);
      desiredByAgent.set(agentId, byAutomationId);
    }
    for (const agentId of agentIds) {
      const desired = desiredByAgent.get(agentId) ?? new Map<string, CloudDefinition>();
      const fingerprint = [...desired.values()].sort((a, b) => a.automationId.localeCompare(b.automationId)).map((definition) => `${definition.automationId}:${definition.marker}`).join("\0");
      if (this.lastSuccessfulFingerprintByAgent.get(agentId) === fingerprint) continue;
      try {
        if (await this.reconcileAgent(agentId, desired)) this.lastSuccessfulFingerprintByAgent.set(agentId, fingerprint);
      } catch (error) { this.recordFailure({ agentId, operation: "reconcile", error }); }
    }
  }

  private async reconcileAgent(agentId: string, desiredByAutomationId: Map<string, CloudDefinition>): Promise<boolean> {
    const desiredCloudAutomationIds = new Set(desiredByAutomationId.keys());
    const initial = await this.listRemote(agentId);
    if (initial === undefined) return false;
    const remoteByAutomationId = remoteShadowAutomationsById(initial);
    if (isConverged(remoteByAutomationId, desiredByAutomationId)) {
      this.publishKnownSchedulingEvidence(agentId, initial, desiredCloudAutomationIds);
      this.recordRecovery(agentId);
      return true;
    }
    let mutationFailed = false;
    const localInspection = this.deps.inspectLocalDefinitions?.(agentId);
    for (const [automationId, remote] of remoteByAutomationId) {
      if (desiredByAutomationId.has(automationId)) continue;
      const succeeded = await this.runMutation(agentId, "delete", () => this.deps.client.deleteSandAutomation(new DeleteAutomationRequest({ automationId: remote.automationId })));
      mutationFailed ||= !succeeded;
      this.deps.reportShadowPrune?.({ conversationId: agentId, automationId, outcome: succeeded ? "deleted" : "failed", localDefinitionState: localInspection?.state ?? "unknown", localDefinitionCount: localInspection?.validDefinitionCount ?? desiredByAutomationId.size, desiredCount: desiredByAutomationId.size, remoteShadowCount: remoteByAutomationId.size });
    }
    for (const [automationId, desired] of desiredByAutomationId) {
      const remote = remoteByAutomationId.get(automationId);
      if (remote === undefined) {
        const succeeded = await this.runMutation(agentId, "create", () => this.deps.client.createSandAutomation(new CreateAutomationRequest({ description: desired.marker, name: desired.name, workflow: desired.workflow, enabled: desired.enabled, sandAgentId: agentId, sandAutomationId: automationId })));
        mutationFailed ||= !succeeded;
      } else if (remote.description !== desired.marker || remote.enabled !== desired.enabled) {
        const succeeded = await this.runMutation(agentId, "update", () => this.update(remote.automationId, desired));
        mutationFailed ||= !succeeded;
      }
    }
    const readback = await this.listRemote(agentId);
    if (readback === undefined) return false;
    this.publishKnownSchedulingEvidence(agentId, readback, desiredCloudAutomationIds);
    const converged = isConverged(remoteShadowAutomationsById(readback), desiredByAutomationId);
    if (!converged) {
      if (!mutationFailed) this.recordFailure({ agentId, operation: "verify", error: new Error("Remote automation reconciliation did not converge") });
      return false;
    }
    this.recordRecovery(agentId);
    return true;
  }

  private async update(automationId: string, desired: CloudDefinition): Promise<void> {
    await this.deps.client.updateSandAutomation(new UpdateAutomationRequest({ automationId, description: desired.marker, name: desired.name, workflow: desired.workflow, enabled: desired.enabled }));
  }

  private async listRemote(agentId: string): Promise<RemoteList | undefined> {
    try { return await this.deps.client.listSandAutomations(new ListSandAutomationsRequest({ sandAgentId: agentId })); }
    catch (error) { this.recordFailure({ agentId, operation: "list-remote", error }); return undefined; }
  }

  private async runMutation(agentId: string, operation: string, mutation: () => Promise<unknown>): Promise<boolean> {
    this.schedulingEvidenceByAgent.set(agentId, { kind: "unknown" });
    try { await mutation(); return true; }
    catch (error) { this.recordFailure({ agentId, operation, error }); return false; }
  }

  private publishKnownSchedulingEvidence(agentId: string, response: RemoteList, desiredCloudAutomationIds: Set<string>): void {
    const enabledIds = enabledRemoteAutomationIds(response);
    this.schedulingEvidenceByAgent.set(agentId, { kind: "known", enabledRemoteAutomationIds: enabledIds });
    const schedulingAuthority = { desiredCloudAutomationIds, enabledRemoteAutomationIds: enabledIds };
    const previous = this.lastNotifiedSchedulingAuthorityByAgent.get(agentId);
    if (sameSchedulingAuthority(previous, schedulingAuthority)) return;
    this.lastNotifiedSchedulingAuthorityByAgent.set(agentId, schedulingAuthority);
    try { this.deps.onSchedulingAuthorityChanged(agentId); }
    catch (error) { this.logCallbackFailure("onSchedulingAuthorityChanged", agentId, error); }
  }

  private recordFailure(failure: { agentId?: string; operation: string; error: unknown }): void {
    if (failure.agentId !== undefined) this.failedAgentIds.add(failure.agentId);
    this.deps.reportDiagnostic?.({ extension: "automation_cloud_sync", operation: failure.operation, agentId: failure.agentId, ...errorIdentity(failure.error) });
    if (!this.deps.hasCredential()) return;
    try { this.deps.onFailure(failure); }
    catch (error) { this.logCallbackFailure("onFailure", failure.agentId, error); }
  }

  private recordRecovery(agentId: string): void {
    if (!this.failedAgentIds.delete(agentId)) return;
    try { this.deps.onRecovery(agentId); }
    catch (error) { this.logCallbackFailure("onRecovery", agentId, error); }
  }

  private finishAgentDeletion(agentId: string): void {
    this.pendingAgentDeletions.delete(agentId);
    this.lastSuccessfulFingerprintByAgent.delete(agentId);
    this.recordRecovery(agentId);
    this.schedulingEvidenceByAgent.delete(agentId);
    this.lastNotifiedSchedulingAuthorityByAgent.delete(agentId);
  }

  private logCallbackFailure(callback: string, agentId: string | undefined, error: unknown): void {
    this.deps.reportDiagnostic?.({ extension: "automation_cloud_sync", operation: callback, agentId, ...errorIdentity(error) });
  }
}
