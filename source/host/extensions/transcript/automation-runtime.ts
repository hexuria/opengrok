import {
  AUTOMATION_PROMPT_GUIDANCE_VERSION,
  AUTOMATION_UI_LIMIT,
  type AutomationRecord,
  type AutomationSpec,
} from "../../automations/automation.js";
import { stableAutomationId } from "../../automations/automation-id.js";
import {
  compileCronMatcher,
  computeNextRunAt,
  normalizeSchedule,
  parseEveryIntervalMs,
  wallClockOfInstant,
} from "../../../shared/automation-schedule.js";
import { isDeliveryOwed, REPLY_NUDGE_PROMPT } from "./turn-runtime.js";
import { AutomationEventFires } from "./automation-event-fires.js";
import {
  AutomationRunPath,
  type FireAutomationArgs,
  type FireAutomationOutcome,
} from "./automation-run-path.js";
import {
  snapshotAutomations,
  diffAutomationAction,
  type AutomationSnapshot,
} from "./automation-snapshot.js";
import { AutomationSpendGuardRuntime } from "./automation-spend-guard-runtime.js";
import type { TranscriptManagerLike } from "./transcript-hub.js";

type AutomationLifecycleSource =
  "agent" | "automations_ui" | "workflow_ui" | "spend_guard";
type AutomationAction =
  "created" | "updated" | "enabled" | "disabled" | "deleted";

function summarizeSchedule(
  schedule: string,
  timeZone: string | undefined,
  startMs: number,
): {
  scheduledFiresNext7Days: number;
  firesOnWeekend: boolean;
  firesOvernight: boolean;
} {
  const deadline = startMs + 7 * 24 * 60 * 60_000;
  const normalized = normalizeSchedule(schedule);
  const intervalMs = parseEveryIntervalMs(normalized);
  const cronMatcher =
    intervalMs == null ? compileCronMatcher(normalized) : null;
  const intervalFireCount =
    intervalMs == null
      ? undefined
      : Math.floor((deadline - startMs) / intervalMs);
  if (intervalMs != null && intervalMs < 60_000) {
    const count = intervalFireCount ?? 0;
    return {
      scheduledFiresNext7Days: count,
      firesOnWeekend: count > 0,
      firesOvernight: count > 0,
    };
  }
  let cursor = startMs;
  let count = 0;
  let firesOnWeekend = false;
  let firesOvernight = false;
  while (true) {
    const next =
      intervalMs != null
        ? cursor + intervalMs
        : cronMatcher != null
          ? computeNextRunAt(normalized, cursor, timeZone)
          : null;
    if (next == null || next > deadline || next <= cursor) break;
    const wall = wallClockOfInstant(next, cronMatcher?.timeZone ?? timeZone);
    count += 1;
    firesOnWeekend ||= wall.dayOfWeek === 0 || wall.dayOfWeek === 6;
    firesOvernight ||= wall.hour < 7 || wall.hour >= 22;
    cursor = next;
  }
  return {
    scheduledFiresNext7Days: intervalFireCount ?? count,
    firesOnWeekend,
    firesOvernight,
  };
}

export class AutomationRuntime {
  watchedAutomations: any;
  readonly lastKnownAutomations = new Map<
    string,
    Map<string, AutomationSnapshot>
  >();
  readonly automationLifecycleMutationChains = new Map<string, Promise<void>>();
  readonly spendGuard: AutomationSpendGuardRuntime;
  readonly eventFires: AutomationEventFires;
  readonly runPath: AutomationRunPath;

  constructor(readonly tm: TranscriptManagerLike) {
    this.spendGuard = new AutomationSpendGuardRuntime(tm, this);
    this.eventFires = new AutomationEventFires(tm);
    this.runPath = new AutomationRunPath(tm, this.spendGuard, this.eventFires);
  }

  get pendingEventFireBatches() {
    return this.eventFires.pendingEventFireBatches;
  }
  notifyAutomationConfigChanged(): void {
    this.tm.automationConfigChanged?.();
  }

  watchSessionAutomations(session: any): void {
    if (this.watchedAutomations === session.automations) return;
    this.watchedAutomations?.setOnChange(undefined);
    this.watchedAutomations = session.automations;
    this.seedKnownAutomations(session);
    session.automations.setOnChange(() => {
      void this.enqueueAutomationLifecycleMutation({
        agentId: session.id,
        mutation: () => {
          this.recordAutomationChangeEvents(session, "agent");
          this.emitAutomations(session);
          this.notifyAutomationConfigChanged();
        },
      });
    });
  }

  seedKnownAutomations(session: any): void {
    if (!this.lastKnownAutomations.has(session.id)) {
      this.lastKnownAutomations.set(
        session.id,
        snapshotAutomations(session.automations.listDefinitions()),
      );
    }
  }

  recordAutomationChangeEvents(
    session: any,
    source: AutomationLifecycleSource,
  ): void {
    if (this.tm.sessions.activeSession?.id !== session.id) return;
    const current = snapshotAutomations(session.automations.listDefinitions());
    const previous = this.lastKnownAutomations.get(session.id);
    this.lastKnownAutomations.set(session.id, current);
    if (previous == null) return;
    for (const [id, after] of current) {
      const before = previous.get(id);
      const action: AutomationAction | null =
        before == null ? "created" : diffAutomationAction(before, after);
      if (action != null)
        this.emitAutomationChange({
          agentId: session.id,
          action,
          automationId: id,
          automationName: after.name,
          automation: after,
          source,
        });
    }
    for (const [id, before] of previous) {
      if (!current.has(id))
        this.emitAutomationChange({
          agentId: session.id,
          action: "deleted",
          automationId: id,
          automationName: before.name,
          automation: before,
          source,
        });
    }
  }

  enqueueAutomationLifecycleMutation<T>(args: {
    agentId: string;
    mutation(): T | Promise<T>;
  }): Promise<T> {
    const previous =
      this.automationLifecycleMutationChains.get(args.agentId) ??
      Promise.resolve();
    const result = previous.then(args.mutation, args.mutation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.automationLifecycleMutationChains.set(args.agentId, settled);
    void settled.then(() => {
      if (this.automationLifecycleMutationChains.get(args.agentId) === settled)
        this.automationLifecycleMutationChains.delete(args.agentId);
    });
    return result;
  }

  enqueueAutomationMutation<T>(args: {
    agentId: string;
    activeMutation(session: any): T;
    inactiveMutation(): T;
  }): Promise<T> {
    return this.enqueueAutomationLifecycleMutation({
      agentId: args.agentId,
      mutation: () => {
        const active = this.tm.sessions.activeSession;
        let after: T;
        if (active?.id === args.agentId) {
          this.recordAutomationChangeEvents(active, "agent");
          after = args.activeMutation(active);
          this.recordAutomationChangeEvents(active, "automations_ui");
        } else {
          const before = this.tm.sessionStore.listAgentAutomations(
            args.agentId,
          ) as AutomationRecord[];
          this.recordInactiveAutomationChanges({
            agentId: args.agentId,
            before,
            after: before,
            source: "agent",
          });
          after = args.inactiveMutation();
          this.recordInactiveAutomationChanges({
            agentId: args.agentId,
            before,
            after: after as AutomationRecord[],
            source: "automations_ui",
          });
        }
        this.publishAutomations(args.agentId, after);
        return after;
      },
    });
  }

  recordInactiveAutomationChanges(args: {
    agentId: string;
    before: AutomationRecord[];
    after: AutomationRecord[];
    source: AutomationLifecycleSource;
  }): void {
    const previous =
      this.lastKnownAutomations.get(args.agentId) ??
      snapshotAutomations(args.before);
    const current = snapshotAutomations(args.after);
    this.lastKnownAutomations.set(args.agentId, current);
    for (const [id, automation] of current) {
      const prior = previous.get(id);
      const action: AutomationAction | null =
        prior == null ? "created" : diffAutomationAction(prior, automation);
      if (action != null)
        this.emitAutomationLifecycle({
          agentId: args.agentId,
          action,
          automation,
          source: args.source,
        });
    }
    for (const [id, automation] of previous) {
      if (!current.has(id))
        this.emitAutomationLifecycle({
          agentId: args.agentId,
          action: "deleted",
          automation,
          source: args.source,
        });
    }
  }

  emitAutomationChange(args: {
    agentId: string;
    action: AutomationAction;
    automationId: string;
    automationName: string;
    automation: AutomationSnapshot;
    source: AutomationLifecycleSource;
  }): void {
    this.tm.emitTimelineEvent(args.agentId, {
      type: "automation-changed",
      action: args.action,
      automationId: args.automationId,
      automationName: args.automationName,
    });
    this.emitAutomationLifecycle(args);
  }

  emitAutomationLifecycle(args: {
    agentId: string;
    action: AutomationAction;
    automation: AutomationSnapshot;
    source: AutomationLifecycleSource;
  }): void {
    const now = Date.now();
    const schedule =
      args.automation.triggerType === "cron"
        ? summarizeSchedule(
            args.automation.schedule,
            this.tm.sessionStore.getUserTimeZone(),
            now,
          )
        : undefined;
    const ageMs = Math.max(0, now - args.automation.createdAt);
    const automationId = stableAutomationId({
      agentId: args.agentId,
      localId: args.automation.id,
    });
    this.tm.telemetry.reportAutomationLifecycle({
      conversationId: args.agentId,
      automationId,
      action: args.action,
      source: args.source,
      triggerType: args.automation.triggerType,
      ...(schedule == null ? {} : schedule),
      ageMs,
      recordedRunCount: args.automation.recordedRunCount,
    });
    this.tm.productAnalytics.trackEvent("sand.automation.lifecycle", {
      agent_id: args.agentId,
      automation_id: automationId,
      action: args.action,
      source: args.source,
      trigger_type: args.automation.triggerType,
      ...(schedule == null
        ? {}
        : {
            scheduled_fires_next_7_days: schedule.scheduledFiresNext7Days,
            fires_on_weekend: schedule.firesOnWeekend,
            fires_overnight: schedule.firesOvernight,
          }),
      age_ms: ageMs,
      recorded_run_count: args.automation.recordedRunCount,
      guidance_version: AUTOMATION_PROMPT_GUIDANCE_VERSION,
    });
  }

  emitAutomations(session: any): void {
    if (
      this.tm.sessions.activeSession?.id === session.id &&
      this.tm.shouldEmitAutomations()
    ) {
      this.publishAutomations(
        session.id,
        session.automations.list().slice(0, AUTOMATION_UI_LIMIT),
      );
    }
  }
  publishAutomations(agentId: string, automations: unknown): void {
    if (this.tm.shouldEmitAutomations())
      this.tm.roster.emitter.emit("automations", { agentId, automations });
  }
  subscribeAutomations(listener: (value: unknown) => void): () => void {
    this.tm.roster.emitter.on("automations", listener);
    return () => this.tm.roster.emitter.off("automations", listener);
  }

  async getAgentAutomations(agentId: string): Promise<AutomationRecord[]> {
    const active = this.tm.sessions.activeSession;
    return active?.id === agentId
      ? active.automations.list().slice(0, AUTOMATION_UI_LIMIT)
      : this.tm.sessionStore.listAgentAutomations(agentId);
  }
  async listAllAutomations(): Promise<AutomationRecord[]> {
    return this.tm.sessionStore.listAllAutomations();
  }
  async listAllAutomationDefinitions(): Promise<AutomationRecord[]> {
    return this.tm.sessionStore.listAllAutomationDefinitions();
  }

  async setAgentAutomationEnabled(
    agentId: string,
    automationId: string,
    isEnabled: boolean,
  ): Promise<AutomationRecord[]> {
    try {
      return await this.enqueueAutomationMutation({
        agentId,
        activeMutation: (active) => {
          active.automations.setEnabled(automationId, isEnabled);
          return active.automations.list().slice(0, AUTOMATION_UI_LIMIT);
        },
        inactiveMutation: () =>
          this.tm.sessionStore.setAgentAutomationEnabled(
            agentId,
            automationId,
            isEnabled,
          ),
      });
    } finally {
      this.notifyAutomationConfigChanged();
    }
  }
  async createAgentAutomation(
    agentId: string,
    spec: AutomationSpec,
  ): Promise<AutomationRecord[]> {
    try {
      return await this.enqueueAutomationMutation({
        agentId,
        activeMutation: (active) => {
          active.automations.upsert(spec);
          return active.automations.list().slice(0, AUTOMATION_UI_LIMIT);
        },
        inactiveMutation: () =>
          this.tm.sessionStore.createAgentAutomation(agentId, spec),
      });
    } finally {
      this.notifyAutomationConfigChanged();
    }
  }
  async updateAgentAutomation(
    agentId: string,
    automationId: string,
    spec: AutomationSpec,
  ): Promise<AutomationRecord[]> {
    try {
      return await this.enqueueAutomationMutation({
        agentId,
        activeMutation: (active) => {
          active.automations.update(automationId, spec);
          return active.automations.list().slice(0, AUTOMATION_UI_LIMIT);
        },
        inactiveMutation: () =>
          this.tm.sessionStore.updateAgentAutomation(
            agentId,
            automationId,
            spec,
          ),
      });
    } finally {
      this.notifyAutomationConfigChanged();
    }
  }
  async deleteAgentAutomation(
    agentId: string,
    automationId: string,
  ): Promise<AutomationRecord[]> {
    try {
      return await this.enqueueAutomationMutation({
        agentId,
        activeMutation: (active) => {
          active.automations.remove(automationId);
          return active.automations.list().slice(0, AUTOMATION_UI_LIMIT);
        },
        inactiveMutation: () =>
          this.tm.sessionStore.removeAgentAutomation(agentId, automationId),
      });
    } finally {
      this.notifyAutomationConfigChanged();
    }
  }

  async runAgentAutomationNow(
    agentId: string,
    automationId: string,
  ): Promise<void> {
    const active = this.tm.sessions.activeSession;
    const automation =
      active?.id === agentId
        ? active.automations.get(automationId)
        : ((await this.tm.sessionStore.listAgentAutomations(agentId)).find(
            (entry: AutomationRecord) => entry.id === automationId,
          ) ?? null);
    if (automation != null)
      await this.fireAutomation({ agentId, automation, trigger: "manual" });
  }
  runServerScheduledAutomation(args: {
    agentId: string;
    automation: AutomationRecord;
    runUuid: string;
    scheduledForMs?: number;
  }): Promise<FireAutomationOutcome> {
    return this.fireAutomation({
      agentId: args.agentId,
      automation: args.automation,
      trigger: "schedule",
      runUuid: args.runUuid,
      ...(args.scheduledForMs === undefined
        ? {}
        : { scheduledForMs: args.scheduledForMs }),
    });
  }
  runAutomationForEvent(
    agentId: string,
    automation: AutomationRecord,
    event: Record<string, unknown>,
  ) {
    return this.eventFires.enqueueEventAutomationFire({
      agentId,
      automation,
      event,
    });
  }
  runServerAutomationForEvent(args: {
    agentId: string;
    automation: AutomationRecord;
    event: Record<string, unknown>;
    runUuid: string;
  }) {
    return this.eventFires.enqueueEventAutomationFire(args);
  }
  fireAutomation(args: FireAutomationArgs): Promise<FireAutomationOutcome> {
    return this.runPath.fireAutomation(args);
  }
  handleSpendGuardWidgetAnswer(args: any): Promise<string | null> {
    return this.spendGuard.handleWidgetAnswer(args);
  }
  async ensureHiddenTurnReply(runner: any): Promise<boolean> {
    const retry = await runner.run(REPLY_NUDGE_PROMPT, { hidden: true });
    return !retry.aborted && !isDeliveryOwed(retry);
  }
}
