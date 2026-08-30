import { GITHUB_EVENT_KINDS, triggerCronSchedules, triggerEventTriggers, type AutomationTrigger } from "../../../shared/automations.js";
import { stableAutomationId } from "../../automations/automation-id.js";
import { createNotifyDrainGate } from "../../notify-drain-gate.js";
import { triggerMatchesEvent } from "../../automations/automation-trigger.js";
import { brandedErrno } from "../../../shared/errors/bounded.js";
import { SandError } from "../../../shared/errors/registry.js";
import { findSystemErrno } from "../../../shared/system-errno.js";
import { getSandBackendClientHeaders } from "../../../shared/node/sand-client-metadata.js";
import { createNoopSandTelemetry, sandErrorDetail } from "../../ports/telemetry.js";
import { isServerSchedulable, sandCloudDefinition, type ScheduledCloudAutomation } from "./sand-automation-cloud-sync.js";
export const ERROR_BACKOFF_MS = 30_000, MAX_NEXT_POLL_DELAY_MS = 60_000, MAX_REPORTED_REJECTED_FIRES = 256;
const ID_MAX = 200, TEXT_MAX = 4_000, TITLE_MAX = 400, URL_MAX = 600, STATUS_MAX = 200;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value != null && !Array.isArray(value);
function string(value: unknown, max: number): string | undefined { return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined; }
function oversized(value: Record<string, unknown>, fields: readonly [string, number][]): boolean { return fields.some(([name, max]) => typeof value[name] === "string" && value[name].length > max); }
export function parseFireTriggerEvent(value: unknown): Record<string, unknown> | null {
  if (!record(value)) return null; const timestampMs = typeof value.timestampMs === "number" ? value.timestampMs : Date.now();
  if (value.source === "slack") { if (typeof value.channel !== "string" || value.channel.length === 0) return null; return { source: "slack", channel: value.channel, sender: typeof value.sender === "string" ? value.sender : "someone", text: typeof value.text === "string" ? value.text : "", isMention: value.isMention === true, ...(value.isSelf === true ? { isSelf: true } : {}), ...(typeof value.reactionEmoji === "string" && value.reactionEmoji.length > 0 ? { reactionEmoji: value.reactionEmoji } : {}), ...(typeof value.ts === "string" && value.ts.length > 0 ? { ts: value.ts } : {}), ...(typeof value.threadTs === "string" && value.threadTs.length > 0 ? { threadTs: value.threadTs } : {}), timestampMs }; }
  if (value.source === "github") { if (typeof value.repo !== "string" || value.repo.length === 0 || typeof value.kind !== "string" || !(GITHUB_EVENT_KINDS as readonly string[]).includes(value.kind)) return null; return { source: "github", repo: value.repo, kind: value.kind, title: typeof value.title === "string" ? value.title : "", actor: typeof value.actor === "string" ? value.actor : "someone", ...(typeof value.url === "string" && value.url.length > 0 ? { url: value.url } : {}), ...(typeof value.detail === "string" && value.detail.length > 0 ? { detail: value.detail } : {}), ...(typeof value.prOwner === "string" && value.prOwner.length > 0 ? { prOwner: value.prOwner } : {}), ...(typeof value.branch === "string" && value.branch.length > 0 ? { branch: value.branch } : {}), timestampMs }; }
  if (value.source === "microsoftTeams") { if (oversized(value, [["tenantId",ID_MAX],["teamId",ID_MAX],["channelId",ID_MAX],["text",TEXT_MAX],["aadObjectId",ID_MAX],["activityId",ID_MAX],["rootMessageId",ID_MAX]])) return null; const tenantId = string(value.tenantId, ID_MAX), teamId = string(value.teamId, ID_MAX), channelId = string(value.channelId, ID_MAX); if (tenantId == null || teamId == null || channelId == null) return null; return { source: "microsoftTeams", tenantId, teamId, channelId, text: typeof value.text === "string" ? value.text : "", aadObjectId: string(value.aadObjectId, ID_MAX) ?? "unknown", activityId: string(value.activityId, ID_MAX) ?? "unknown", ...(string(value.rootMessageId, ID_MAX) == null ? {} : { rootMessageId: value.rootMessageId }), timestampMs }; }
  if (value.source === "linear") { if (!["issueCreated","statusChanged","endOfCycle"].includes(String(value.event)) || oversized(value, [["issueIdentifier",ID_MAX],["title",TITLE_MAX],["url",URL_MAX],["status",STATUS_MAX],["projectId",ID_MAX],["teamId",ID_MAX],["statusId",ID_MAX],["cycleId",ID_MAX],["cycleName",TITLE_MAX]])) return null; const result: Record<string, unknown> = { source: "linear", event: value.event, timestampMs }; for (const [name,max] of [["issueIdentifier",ID_MAX],["title",TITLE_MAX],["url",URL_MAX],["status",STATUS_MAX],["projectId",ID_MAX],["teamId",ID_MAX],["statusId",ID_MAX],["cycleId",ID_MAX],["cycleName",TITLE_MAX]] as const) { const field = string(value[name], max); if (field != null) result[name] = field; } return result; }
  if (value.source === "sentry") { if (!["issueCreated","issueResolved","issueAssigned","issueArchived","issueUnresolved"].includes(String(value.event)) || oversized(value, [["issueId",ID_MAX],["shortId",ID_MAX],["title",TITLE_MAX],["projectId",ID_MAX],["url",URL_MAX],["projectSlug",ID_MAX],["status",STATUS_MAX],["substatus",STATUS_MAX]])) return null; const issueId = string(value.issueId, ID_MAX), shortId = string(value.shortId, ID_MAX), title = string(value.title, TITLE_MAX); if (issueId == null || shortId == null || title == null) return null; return { source: "sentry", event: value.event, issueId, shortId, title, ...(string(value.projectId,ID_MAX) == null ? {} : { projectId: value.projectId }), ...(string(value.url,URL_MAX) == null ? {} : { url: value.url }), ...(string(value.projectSlug,ID_MAX) == null ? {} : { projectSlug: value.projectSlug }), ...(string(value.status,STATUS_MAX) == null ? {} : { status: value.status }), ...(string(value.substatus,STATUS_MAX) == null ? {} : { substatus: value.substatus }), timestampMs }; }
  if (value.source === "pagerduty") { if (!["incidentTriggered","incidentAcknowledged","incidentResolved","incidentEscalated"].includes(String(value.event)) || oversized(value, [["incidentId",ID_MAX],["title",TITLE_MAX],["status",STATUS_MAX],["serviceId",ID_MAX],["serviceName",ID_MAX],["url",URL_MAX]])) return null; const incidentId = string(value.incidentId,ID_MAX), title = string(value.title,TITLE_MAX), status = string(value.status,STATUS_MAX), serviceId = string(value.serviceId,ID_MAX); if (incidentId == null || title == null || status == null || serviceId == null) return null; return { source: "pagerduty", event: value.event, incidentId, title, status, serviceId, ...(string(value.serviceName,ID_MAX) == null ? {} : { serviceName: value.serviceName }), ...(string(value.url,URL_MAX) == null ? {} : { url: value.url }), timestampMs }; }
  return null;
}
export function admitsBareFire(trigger: AutomationTrigger, event: { scheduledForMs?: number }): boolean { const cron = triggerCronSchedules(trigger); return cron.length > 0 && (triggerEventTriggers(trigger).length === 0 || event.scheduledForMs !== undefined); }
export function fireEventMatchesTrigger(trigger: AutomationTrigger, parsed: Record<string, unknown>, wire: unknown): boolean { const options = { admitMissingSubject: true, platformMatched: true }; if (triggerMatchesEvent(trigger, parsed, options)) return true; if (parsed.source !== "slack" || !record(wire)) return false; const channelId = string(wire.channelId, ID_MAX); return channelId != null && channelId !== parsed.channel && triggerMatchesEvent(trigger, { ...parsed, channel: channelId }, options); }
type Completion = { readonly phase: "completed"; readonly status: "succeeded" | "failed"; readonly errorMessage?: string };
export function completionOfOutcome(outcome: string): Completion { return outcome === "ok" ? { phase: "completed", status: "succeeded" } : { phase: "completed", status: "failed", errorMessage: outcome === "interrupted" ? "Automation run was interrupted by a Sand host update; the box resumes it locally" : "Automation run failed on the Sand box" }; }
export class BackendStatusError extends Error { constructor(path: string, readonly status: number) { super(`sand automation relay ${path} returned ${status}`); } }
type DeliveryError = ReturnType<typeof SandError.backendHttpStatus> | ReturnType<typeof SandError.backendUnreachable> | ReturnType<typeof SandError.backendDeliveryFailed>;
function classifyDeliveryError(error: unknown): DeliveryError { if (error instanceof BackendStatusError) return SandError.backendHttpStatus({ httpStatus: error.status }); const errno = findSystemErrno(error); if (errno !== undefined) return SandError.backendUnreachable({ errno: brandedErrno(errno) }); return SandError.backendDeliveryFailed(); }
function coarseDeliveryErrorTypeAndCode(error: unknown): { errorType: string; errorCode?: string } { const errorCode = error instanceof BackendStatusError ? String(error.status) : findSystemErrno(error); return { errorType: error instanceof Error ? error.constructor.name : typeof error, ...(errorCode == null ? {} : { errorCode }) }; }
interface FireWire { readonly id: string; readonly sandAgentId: string; readonly automationId: string; readonly timestampMs: number; readonly definitionRevision?: string; readonly scheduledForMs?: number; readonly event?: unknown }
interface FireTarget { readonly agentId: string; readonly automation: ScheduledCloudAutomation & { readonly lastRunAt?: number | null; readonly runs?: readonly { id: string; coalescedRunIds?: readonly string[]; status: string; detail?: string }[] } }
export class SandAutomationFireConsumer {
  private readonly fetchImpl: typeof fetch;
  private readonly telemetry: { reportAutomationFireDropped(value: Record<string, unknown>): void; reportAgentError(value: Record<string, unknown>): void };
  private ticking = false;
  private stopped = false;
  private backoffUntil = 0;
  private pollNotBefore = 0;
  private drainedWhileUnschedulable = false;
  private readonly states = new Map<string, Completion | { phase: "running" | "reported" }>();
  private readonly reportedRejected = new Set<string>();
  private readonly notifyGate;

  constructor(private readonly deps: {
    readonly getAccessToken: (args: { backendUrl: string }) => Promise<string>;
    readonly getBackendUrl: () => string;
    readonly getTimeZone: () => string | undefined;
    readonly getBoxUptimeMs: () => number | undefined;
    readonly isReady: () => boolean | Promise<boolean>;
    readonly listAutomations: () => Promise<readonly FireTarget[]>;
    readonly fire: (args: { agentId: string; automation: FireTarget["automation"]; runUuid: string; scheduledForMs?: number }) => Promise<string | undefined>;
    readonly fireForEvent: (args: { agentId: string; automation: FireTarget["automation"]; event: Record<string, unknown>; runUuid: string }) => Promise<string | undefined>;
    readonly fetchImpl?: typeof fetch;
    readonly telemetry?: { reportAutomationFireDropped(value: Record<string, unknown>): void; reportAgentError?(value: Record<string, unknown>): void };
    readonly isNotifyConnected?: () => boolean;
    readonly isNotifySafetyPollEnabled?: () => boolean;
  }) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.telemetry = (deps.telemetry ?? createNoopSandTelemetry()) as { reportAutomationFireDropped(value: Record<string, unknown>): void; reportAgentError(value: Record<string, unknown>): void };
    this.notifyGate = createNotifyDrainGate({ isConnected: () => deps.isNotifyConnected?.() ?? false, isSafetyPollEnabled: () => deps.isNotifySafetyPollEnabled?.() ?? true, now: Date.now });
  }

  start(): void { this.stopped = false; this.drainedWhileUnschedulable = false; this.notifyGate.reset(); }
  stop(): void { this.stopped = true; this.backoffUntil = 0; this.pollNotBefore = 0; }
  resetPollDelay(): void { this.pollNotBefore = 0; }
  requestDrain(): void { this.notifyGate.recordNotify(); this.pollNotBefore = 0; void this.tick(); }

  async tick(): Promise<void> {
    if (this.ticking || this.stopped || Date.now() < this.backoffUntil) return;
    this.ticking = true;
    try {
      if (!await this.deps.isReady()) return;
      let observedServerSchedulable: boolean | undefined;
      if (this.states.size === 0) {
        if (Date.now() < this.pollNotBefore || !this.notifyGate.shouldDrain({ hasOwedWork: false })) return;
        observedServerSchedulable = (await this.deps.listAutomations()).some(({ automation }) => isServerSchedulable(automation));
        if (!observedServerSchedulable && this.drainedWhileUnschedulable) return;
      }
      const ackRunUuids = [...this.states].filter(([, state]) => state.phase === "reported").map(([id]) => id);
      const result = await this.callBackend("/sand/automation-events/poll", { ackRunUuids }) as { events?: FireWire[]; nextPollAfterMs?: number };
      const events = result.events ?? [];
      this.notifyGate.recordPoll();
      if (observedServerSchedulable !== undefined) this.drainedWhileUnschedulable = !observedServerSchedulable;
      const returned = new Set(events.map(({ id }) => id));
      for (const [id, state] of this.states) if (state.phase === "reported" && !returned.has(id)) this.states.delete(id);
      for (const event of events) if (!this.states.has(event.id)) { this.states.set(event.id, { phase: "running" }); void this.deliver(event); }
      for (const [id, state] of this.states) if (state.phase === "completed") await this.reportCompletion(id, state);
      this.pollNotBefore = events.length === 0 && this.states.size === 0 && typeof result.nextPollAfterMs === "number" && Number.isFinite(result.nextPollAfterMs) && result.nextPollAfterMs > 0 ? Date.now() + Math.min(result.nextPollAfterMs, MAX_NEXT_POLL_DELAY_MS) : 0;
    } catch (error) {
      this.backoffUntil = Date.now() + ERROR_BACKOFF_MS;
      this.telemetry.reportAgentError({ source: "automation_fire_poll", error: classifyDeliveryError(error), detail: sandErrorDetail(error) });
    } finally { this.ticking = false; }
  }

  private existing(target: FireTarget["automation"], id: string): Completion | undefined {
    const run = target.runs?.find((candidate) => candidate.id === id || candidate.coalescedRunIds?.includes(id) === true);
    if (run === undefined || run.status === "running") return undefined;
    return run.status === "ok" ? { phase: "completed", status: "succeeded" } : { phase: "completed", status: "failed", ...(run.detail === undefined ? {} : { errorMessage: run.detail }) };
  }

  private async deliver(event: FireWire): Promise<void> {
    let completed: Completion | undefined;
    try {
      const target = (await this.deps.listAutomations()).find((entry) => entry.agentId === event.sandAgentId && stableAutomationId({ agentId: entry.agentId, localId: entry.automation.id }) === event.automationId);
      if (this.stopped) { this.states.delete(event.id); return; }
      const existingRunCompletion = target === undefined ? undefined : this.existing(target.automation, event.id);
      if (target === undefined) completed = this.reject(event, "automation_missing", "Automation not found on the Sand box");
      else if (existingRunCompletion !== undefined) completed = existingRunCompletion;
      else if (!target.automation.isEnabled) completed = this.reject(event, "automation_disabled", "Automation is disabled on the Sand box");
      else if (event.definitionRevision === undefined && event.event == null && admitsBareFire(target.automation.trigger, event) && target.automation.lastRunAt !== null && target.automation.lastRunAt !== undefined && target.automation.lastRunAt >= event.timestampMs) completed = this.reject(event, "slot_already_covered", "Legacy automation fire was already covered on the Sand box");
      else if (event.definitionRevision !== undefined && sandCloudDefinition({ agentId: target.agentId, automation: target.automation, timeZone: this.deps.getTimeZone() })?.hash !== event.definitionRevision) completed = this.reject(event, "definition_changed", "Automation definition changed on the Sand box");
      else if (event.event != null) {
        const parsed = parseFireTriggerEvent(event.event);
        if (parsed === null) completed = this.reject(event, "event_unrecognized", "Event context not recognized by the Sand box");
        else if (!fireEventMatchesTrigger(target.automation.trigger, parsed, event.event)) completed = this.reject(event, "trigger_no_longer_matches", "Automation trigger no longer matches the event");
        else {
          const outcome = await this.deps.fireForEvent({ agentId: target.agentId, automation: target.automation, event: parsed, runUuid: event.id });
          if (outcome === undefined) { this.states.delete(event.id); return; }
          completed = completionOfOutcome(outcome);
        }
      } else if (!admitsBareFire(target.automation.trigger, event)) completed = this.reject(event, "missing_event_context", "Fire carried no event context on the Sand box", "event");
      else {
        const outcome = await this.deps.fire({ agentId: target.agentId, automation: target.automation, runUuid: event.id, ...(event.scheduledForMs === undefined ? {} : { scheduledForMs: event.scheduledForMs }) });
        if (outcome === undefined) { this.states.delete(event.id); return; }
        completed = completionOfOutcome(outcome);
      }
    } catch (error) {
      this.states.delete(event.id);
      this.reportRejected(event, "delivery_error", error);
      return;
    }
    this.states.set(event.id, completed!);
    await this.reportCompletion(event.id, completed!);
  }

  private reject(event: FireWire, reason: string, errorMessage: string, trigger?: "event" | "schedule"): Completion { this.reportRejected(event, reason, undefined, trigger); return { phase: "completed", status: "failed", errorMessage }; }

  private reportRejected(event: FireWire, reason: string, error?: unknown, trigger: "event" | "schedule" = event.event != null ? "event" : "schedule"): void {
    if (this.reportedRejected.has(event.id)) return;
    this.reportedRejected.add(event.id);
    while (this.reportedRejected.size > MAX_REPORTED_REJECTED_FIRES) {
      const oldest = this.reportedRejected.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.reportedRejected.delete(oldest);
    }
    const boxUptimeMs = this.deps.getBoxUptimeMs();
    this.telemetry.reportAutomationFireDropped({ conversationId: event.sandAgentId, trigger, reason, ...(event.scheduledForMs == null ? {} : { scheduledForMs: event.scheduledForMs, latenessMs: Math.max(0, Date.now() - event.scheduledForMs) }), runUuid: event.id, fireAgeMs: Math.max(0, Date.now() - event.timestampMs), hasDefinitionRevision: event.definitionRevision !== undefined, ...(boxUptimeMs === undefined ? {} : { boxUptimeMs }), ...(error === undefined ? {} : coarseDeliveryErrorTypeAndCode(error)) });
  }

  private async reportCompletion(id: string, completed: Completion): Promise<void> { try { await this.callBackend("/sand/automation-runs/complete", { runUuid: id, status: completed.status, errorMessage: completed.errorMessage }); this.states.set(id, { phase: "reported" }); } catch (error) { if (error instanceof BackendStatusError && (error.status === 409 || error.status === 404)) this.states.set(id, { phase: "reported" }); } }
  private async callBackend(path: string, body: unknown): Promise<unknown> { const backendUrl = this.deps.getBackendUrl(), token = await this.deps.getAccessToken({ backendUrl }), response = await this.fetchImpl(new URL(path, backendUrl).toString(), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...getSandBackendClientHeaders() }, body: JSON.stringify(body) }); if (!response.ok) throw new BackendStatusError(path, response.status); return await response.json(); }
}
