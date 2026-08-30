import {
  areAgentActivitiesEqual,
  type SandAgentActivity,
} from "../../../shared/agents/agents.js";
import {
  INITIAL_NAMED_ACTIVITY_HOLD_STATE,
  NAMED_ACTIVITY_MAX_HOLD_MS,
  SEND_MESSAGE_TOOL_CALL_OUTLINE_NAME,
  resolveNamedActivityHold,
  type ActivityTransition,
  type ActivityUpdate,
  type NamedActivityHoldState,
} from "../../sand-activity.js";
import { SandRunScheduler, type RunLane } from "./run-scheduler.js";
import type { TranscriptManagerLike } from "./transcript-hub.js";

export function isRunSchedulerDisabled(): boolean {
  return process.env.SAND_DISABLE_RUN_SCHEDULER === "1";
}
export function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim().length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
export const RUN_WATCHDOG_DEFAULT_MS = 120_000;
export const RUN_WATCHDOG_GRACE_DEFAULT_MS = 30_000;

export class RunLifecycle {
  readonly inFlightRunCounts = new Map<any, number>();
  readonly runWindowStartedAt = new Map<any, number>();
  readonly turnWorthyBeginCounts = new Map<any, number>();
  activeRunSession: any = null;
  readonly runChains = new Map<string, Promise<void>>();
  readonly runScheduler: SandRunScheduler | null;
  readonly composingMessageSessionIds = new Set<string>();
  readonly retryingSessionIds = new Set<string>();
  readonly sessionActivities = new Map<string, SandAgentActivity>();
  readonly sessionActivityHolds = new Map<string, NamedActivityHoldState>();
  readonly lastRequestIdBySession = new Map<string, string>();
  readonly turnRequestIdsBySession = new Map<string, Set<string>>();
  readonly turnEndedSeqBySession = new Map<string, number>();

  constructor(readonly tm: TranscriptManagerLike) {
    this.runScheduler = isRunSchedulerDisabled()
      ? null
      : new SandRunScheduler({
          watchdogMs: envPositiveInt(
            "SAND_RUN_WATCHDOG_MS",
            RUN_WATCHDOG_DEFAULT_MS,
          ),
          watchdogGraceMs: envPositiveInt(
            "SAND_RUN_WATCHDOG_GRACE_MS",
            RUN_WATCHDOG_GRACE_DEFAULT_MS,
          ),
          interruptWedgedRun: (agentId) =>
            this.tm.runnerRegistry.interruptWedgedRunForWatchdog(agentId),
          telemetry: {
            onAccepted: (event) =>
              this.tm.telemetry.reportQueueAccepted({
                conversationId: event.agentId,
                lane: event.lane,
                source: event.source,
                position: event.position,
                depthUser: event.depthUser,
                depthAgent: event.depthAgent,
                depthBackground: event.depthBackground,
                hasActive: event.hasActive,
              }),
            onDequeued: (event) =>
              this.tm.telemetry.reportQueueDequeued({
                conversationId: event.agentId,
                lane: event.lane,
                source: event.source,
                queueWaitMs: event.queueWaitMs,
                ...(event.acceptedToRunMs == null
                  ? {}
                  : { acceptedToRunMs: event.acceptedToRunMs }),
                jumpedBackground: event.jumpedBackground,
                depthUser: event.depthUser,
                depthAgent: event.depthAgent,
                depthBackground: event.depthBackground,
              }),
            onWatchdog: (event) => {
              if (event.stage === "escape")
                this.tm.ackObligations.retireAckRunToken(
                  event.agentId,
                  event.ackToken,
                );
              this.tm.telemetry.reportQueueWatchdog({
                conversationId: event.agentId,
                stage: event.stage,
                activeLane: event.activeLane,
                activeSource: event.activeSource,
                activeRuntimeMs: event.activeRuntimeMs,
                ...(event.waitingUserAgeMs == null
                  ? {}
                  : { waitingUserAgeMs: event.waitingUserAgeMs }),
                ...(event.interrupted == null
                  ? {}
                  : { interrupted: event.interrupted }),
              });
            },
          },
          onRunStart: (agentId) =>
            this.tm.sendPipeline.sendAttachmentBatchIds.delete(agentId),
        });
  }

  async recordRequestId(
    requestId: string,
    session: any,
    source?: string,
  ): Promise<void> {
    if (session == null) return;
    try {
      session.db.recordRequestId(
        requestId,
        Date.now(),
        this.tm.turnRuntime.activeRequestPrompts.get(session.id),
        source ?? this.tm.turnRuntime.activeRequestSources.get(session.id),
      );
      await this.tm.roster.emitAgentUpdate(session.id);
    } catch {}
  }

  trackTurnRequestId(sessionId: string, requestId: string): void {
    const trimmed = requestId.trim();
    if (trimmed.length === 0) return;
    const ids = this.turnRequestIdsBySession.get(sessionId);
    if (ids == null)
      this.turnRequestIdsBySession.set(sessionId, new Set([trimmed]));
    else ids.add(trimmed);
  }

  reportTurnUsage(session: any, usage: unknown): void {
    const requestIds = this.turnRequestIdsBySession.get(session.id);
    this.turnRequestIdsBySession.delete(session.id);
    const turnEndedSeq = (this.turnEndedSeqBySession.get(session.id) ?? 0) + 1;
    this.turnEndedSeqBySession.set(session.id, turnEndedSeq);
    this.tm.telemetry.reportTurnUsage({
      conversationId: session.id,
      source:
        this.tm.turnRuntime.activeRequestSources.get(session.id) ?? "turn",
      usage,
      requestId: requestIds?.values().next().value,
      requestIdCount: requestIds?.size ?? 0,
      turnEndedSeq,
    });
  }

  enqueueExclusiveRun(
    agentId: string,
    task: () => Promise<void>,
    options: {
      lane: RunLane;
      source: string;
      acceptedAtMs?: number;
      ackToken?: string;
    },
  ): Promise<void> {
    if (this.runScheduler != null)
      return this.runScheduler.enqueue(agentId, task, options);
    const previous = this.runChains.get(agentId) ?? Promise.resolve();
    const result = previous.then(() => {
      this.tm.sendPipeline.sendAttachmentBatchIds.delete(agentId);
      return task();
    });
    this.runChains.set(
      agentId,
      Promise.allSettled([result]).then(() => undefined),
    );
    return result;
  }

  async drainExclusiveRuns(agentId: string): Promise<void> {
    if (this.runScheduler != null) await this.runScheduler.drain(agentId);
    else await this.runChains.get(agentId);
  }

  getRunQueueDiagnostics(): readonly unknown[] {
    if (this.runScheduler == null) return [];
    const now = Date.now();
    const byAgent = new Map<string, Record<string, unknown>>();
    for (const queue of this.runScheduler.getDiagnostics())
      byAgent.set(queue.agentId as string, { ...queue, ackOutstanding: false });
    for (const obligation of this.tm.ackObligationStore?.list() ?? []) {
      const existing = byAgent.get(obligation.agentId) ?? {
        agentId: obligation.agentId,
        depthUser: 0,
        depthAgent: 0,
        depthBackground: 0,
        depthTotal: 0,
        ackOutstanding: false,
      };
      byAgent.set(obligation.agentId, {
        ...existing,
        ackOutstanding: true,
        ackAgeMs: now - obligation.createdAtMs,
        ackCoalescedCount: obligation.coalescedCount,
      });
    }
    return [...byAgent.values()];
  }

  beginSessionRun(
    session: any,
    options?: { isGroupMemberTurn?: boolean },
  ): void {
    const inFlight = this.inFlightRunCounts.get(session) ?? 0;
    if (inFlight === 0) this.runWindowStartedAt.set(session, Date.now());
    if (options?.isGroupMemberTurn !== true)
      this.turnWorthyBeginCounts.set(
        session,
        (this.turnWorthyBeginCounts.get(session) ?? 0) + 1,
      );
    this.inFlightRunCounts.set(session, inFlight + 1);
    this.tm.sessions.liveSessions.set(session.id, session);
    this.activeRunSession = session;
    void this.tm.roster.emitAgentUpdate(session.id);
  }

  endSessionRun(session: any): void {
    this.setSessionComposing(session.id, false);
    this.setSessionRetrying(session.id, false);
    this.setSessionActivity(session.id, undefined);
    this.sessionActivityHolds.delete(session.id);
    const remaining = (this.inFlightRunCounts.get(session) ?? 1) - 1;
    if (remaining > 0) {
      this.inFlightRunCounts.set(session, remaining);
      return;
    }
    this.inFlightRunCounts.delete(session);
    this.recordTurnCompleted(session);
    this.tm.turnRuntime.activeRequestPrompts.delete(session.id);
    this.tm.turnRuntime.activeRequestSources.delete(session.id);
    this.turnRequestIdsBySession.delete(session.id);
    this.turnEndedSeqBySession.delete(session.id);
    this.tm.sendPipeline.sendAttachmentBatchIds.delete(session.id);
    if (this.activeRunSession === session) this.activeRunSession = null;
    this.tm.ackObligations.scheduleAckRedriveAfterIdle(session.id);
    void this.retireSession(session);
    void this.tm.roster.emitAgentUpdate(session.id);
  }

  recordTurnCompleted(session: any): void {
    const startedAt = this.runWindowStartedAt.get(session);
    this.runWindowStartedAt.delete(session);
    const turnWorthyBegins = this.turnWorthyBeginCounts.get(session) ?? 0;
    this.turnWorthyBeginCounts.delete(session);
    if (turnWorthyBegins === 0) return;
    this.tm.productAnalytics.trackEvent("sand.turn.completed", {
      agent_id: session.id,
      source:
        this.tm.turnRuntime.activeRequestSources.get(session.id) ?? "turn",
      is_group: this.tm.groupChat.isGroupSession(session),
      duration_ms: startedAt == null ? 0 : Date.now() - startedAt,
    });
  }

  async retireSession(session: any): Promise<void> {
    if (session == null) return;
    const pending = this.tm.sessions.pendingSessionOpens.get(session.id);
    const ownsPendingOpen =
      pending != null &&
      (await this.tm.sessions.settledOpen(pending)) === session;
    if (
      session === this.tm.sessions.activeSession ||
      this.inFlightRunCounts.has(session)
    )
      return;
    if (this.tm.sessions.liveSessions.get(session.id) === session) {
      this.tm.runnerRegistry.runners
        .get(session.id)
        ?.expireAutoReviewApprovals();
      this.tm.sessions.liveSessions.delete(session.id);
      this.tm.runnerRegistry.runners.delete(session.id);
    }
    if (
      ownsPendingOpen &&
      this.tm.sessions.pendingSessionOpens.get(session.id) === pending
    )
      this.tm.sessions.pendingSessionOpens.delete(session.id);
    await session.agentStore.dispose();
    session.db.close();
  }

  runningAgentIds(): Set<string> {
    return new Set(
      [...this.inFlightRunCounts.keys()].map((session) => session.id),
    );
  }
  liveRunningAgentIds(): Set<string> {
    const running = this.runningAgentIds();
    for (const agentId of this.tm.roster.liveSubagentParentIds())
      running.add(agentId);
    return running;
  }

  withRunStates<T extends Record<string, any>>(agents: readonly T[]): T[] {
    const running = this.runningAgentIds();
    const subagentParents = this.tm.roster.liveSubagentParentIds();
    return agents.map((agent) => {
      const isRunningTurn = running.has(agent.id);
      const isRunning = isRunningTurn || subagentParents.has(agent.id);
      const isComposingMessage =
        isRunning && this.composingMessageSessionIds.has(agent.id);
      const isRetrying = isRunning && this.retryingSessionIds.has(agent.id);
      const currentActivity = isRunning
        ? this.sessionActivities.get(agent.id)
        : undefined;
      const activeRemoteMemberId = isRunning
        ? this.tm.groupChat.remoteTurnMemberIdsByRoom.get(agent.id)
        : undefined;
      if (
        agent.isRunning === isRunning &&
        (agent.isRunningTurn ?? false) === isRunningTurn &&
        agent.isComposingMessage === isComposingMessage &&
        (agent.isRetrying ?? false) === isRetrying &&
        areAgentActivitiesEqual(agent.currentActivity, currentActivity) &&
        agent.activeRemoteMemberId === activeRemoteMemberId
      )
        return agent;
      return {
        ...agent,
        isRunning,
        isRunningTurn,
        isComposingMessage,
        isRetrying,
        currentActivity,
        activeRemoteMemberId,
      };
    });
  }

  setSessionComposing(sessionId: string, isComposing: boolean): void {
    const had = this.composingMessageSessionIds.has(sessionId);
    if (had === isComposing) return;
    if (isComposing) this.composingMessageSessionIds.add(sessionId);
    else this.composingMessageSessionIds.delete(sessionId);
    void this.tm.roster.emitAgentUpdate(sessionId);
  }
  setSessionRetrying(sessionId: string, isRetrying: boolean): void {
    const had = this.retryingSessionIds.has(sessionId);
    if (had === isRetrying) return;
    if (isRetrying) this.retryingSessionIds.add(sessionId);
    else this.retryingSessionIds.delete(sessionId);
    void this.tm.roster.emitAgentUpdate(sessionId);
  }
  trackRetryingFromUpdate(update: ActivityUpdate, session: any): void {
    if (update.type === "retrying") {
      const runEpoch = this.tm.turnRuntime.activeTurnEpochs.get(session.id);
      if (
        runEpoch !== undefined &&
        runEpoch !== this.tm.sendPipeline.currentTurnEpoch(session)
      )
        return;
      this.setSessionRetrying(session.id, true);
    } else if (
      [
        "text-delta",
        "thinking-delta",
        "tool-call",
        "send-message",
        "turn-ended",
      ].includes(update.type)
    )
      this.setSessionRetrying(session.id, false);
  }
  setSessionActivity(
    sessionId: string,
    activity: SandAgentActivity | undefined,
  ): void {
    if (
      areAgentActivitiesEqual(this.sessionActivities.get(sessionId), activity)
    )
      return;
    if (activity == null) this.sessionActivities.delete(sessionId);
    else this.sessionActivities.set(sessionId, activity);
    void this.tm.roster.emitAgentUpdate(sessionId);
  }
  trackActivityFromUpdate(update: ActivityUpdate, sessionId: string): void {
    const prior =
      this.sessionActivityHolds.get(sessionId) ??
      INITIAL_NAMED_ACTIVITY_HOLD_STATE;
    const { transition, state } = resolveNamedActivityHold(
      update,
      prior,
      Date.now(),
      NAMED_ACTIVITY_MAX_HOLD_MS,
    );
    if (state === INITIAL_NAMED_ACTIVITY_HOLD_STATE)
      this.sessionActivityHolds.delete(sessionId);
    else this.sessionActivityHolds.set(sessionId, state);
    this.applyActivityTransition(sessionId, transition);
  }
  applyActivityTransition(
    sessionId: string,
    transition: ActivityTransition,
  ): void {
    if (transition.type !== "keep")
      this.setSessionActivity(
        sessionId,
        transition.type === "set" ? transition.activity : undefined,
      );
  }
  trackComposingFromUpdate(update: ActivityUpdate, sessionId: string): void {
    if (
      update.type === "tool-call" &&
      update.name === SEND_MESSAGE_TOOL_CALL_OUTLINE_NAME
    )
      this.setSessionComposing(sessionId, update.status === "pending");
    else if (update.type === "send-message" || update.type === "turn-ended")
      this.setSessionComposing(sessionId, false);
  }
  closeSessionWhenIdle(session: any): void {
    if (!this.inFlightRunCounts.has(session)) session.db.close();
  }
  watchActiveSession(session: any): void {
    this.tm.memory.setActiveAgent({
      agentId: session.id,
      store: session.memory,
    });
    this.tm.automationRuntime.watchSessionAutomations(session);
    this.tm.workflowCommands.watchSessionWorkflows(session);
    this.tm.roster.watchSessionProfile(session);
  }
}
