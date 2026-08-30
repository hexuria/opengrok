import { randomUUID } from "node:crypto";
import {
  buildAdminBroadcastWakePrompt,
  clampAgentMessage,
} from "../../agents/agent-messaging.js";
import { sandErrorDetail } from "../../ports/telemetry.js";
import {
  buildChannelDeliveryFailureWakePrompt,
  buildChannelInboundWakePrompt,
  buildChannelOutboundMessage,
  humanizeChannelDeliveryFailure,
} from "../../../shared/channel-messaging.js";
import { formatChannelAddress } from "../../../shared/channels.js";
import { buildTimelineEventWakePrompt } from "../../../shared/sand-timeline-events.js";
import { AgentToAgentMessaging } from "./agent-to-agent-messaging.js";
import { describeAgentRunError } from "./agent-run-error.js";
import { CompletionRevivals } from "./completion-revivals.js";
import { AgentGoneError } from "./session-runtime.js";
import { collectInboundImages } from "./send-message-shaping.js";
import { nextEntryId } from "./transcript-entry-ids.js";
import { getTranscript } from "./transcript-store.js";
import { classifyAgentError } from "./turn-runtime.js";
import type { TranscriptManagerLike } from "./transcript-hub.js";

export function distinctChannelAddresses(
  envelopes: readonly { address: any }[],
): string[] {
  return [
    ...new Set(
      envelopes.map((envelope) => formatChannelAddress(envelope.address)),
    ),
  ];
}

export class BackgroundWakes {
  readonly pendingInbound = new Map<string, any[]>();
  readonly revivingInboundAgentIds = new Set<string>();
  readonly pendingChannelFailures = new Map<string, any[]>();
  readonly revivingChannelFailureAgentIds = new Set<string>();
  readonly pendingEventWakes = new Map<string, any[]>();
  readonly revivingEventAgentIds = new Set<string>();
  readonly dmPreemptedWakeAgentIds = new Set<string>();
  readonly completionRevivals: CompletionRevivals;
  readonly agentToAgent: AgentToAgentMessaging;
  readonly pendingSubagentCompletions;
  readonly revivingSubagentAgentIds;
  readonly pendingShellCompletions;
  readonly revivingShellAgentIds;
  readonly pendingAgentInbound;

  constructor(readonly tm: TranscriptManagerLike) {
    this.completionRevivals = new CompletionRevivals(tm);
    this.agentToAgent = new AgentToAgentMessaging(tm);
    this.pendingSubagentCompletions =
      this.completionRevivals.pendingSubagentCompletions;
    this.revivingSubagentAgentIds =
      this.completionRevivals.revivingSubagentAgentIds;
    this.pendingShellCompletions =
      this.completionRevivals.pendingShellCompletions;
    this.revivingShellAgentIds = this.completionRevivals.revivingShellAgentIds;
    this.pendingAgentInbound = this.agentToAgent.pendingAgentInbound;
  }
  handleBackgroundSubagentCompletion(
    ...args: Parameters<
      CompletionRevivals["handleBackgroundSubagentCompletion"]
    >
  ): void {
    this.completionRevivals.handleBackgroundSubagentCompletion(...args);
  }
  handleBackgroundShellCompletion(
    ...args: Parameters<CompletionRevivals["handleBackgroundShellCompletion"]>
  ): void {
    this.completionRevivals.handleBackgroundShellCompletion(...args);
  }
  reviveForSubagentCompletions(agentId: string) {
    return this.completionRevivals.reviveForSubagentCompletions(agentId);
  }
  reviveForShellCompletions(agentId: string) {
    return this.completionRevivals.reviveForShellCompletions(agentId);
  }
  sendToAgent(...args: Parameters<AgentToAgentMessaging["sendToAgent"]>) {
    return this.agentToAgent.sendToAgent(...args);
  }
  appendAgentOutboundEntry(
    ...args: Parameters<AgentToAgentMessaging["appendAgentOutboundEntry"]>
  ): void {
    this.agentToAgent.appendAgentOutboundEntry(...args);
  }

  deliverToChannel(
    runSession: any,
    message: unknown,
    addressToken: string,
  ): void {
    const agentId = runSession?.id ?? this.tm.sessions.activeSession?.id;
    if (agentId == null) return;
    const outbound = buildChannelOutboundMessage(message as any);
    if (outbound == null) return;
    void this.tm
      .channelDelivery(agentId, addressToken, outbound)
      .catch((error: unknown) => {
        const rawDetail =
          error instanceof Error ? error.message : "Channel delivery failed";
        const reason = humanizeChannelDeliveryFailure(addressToken, rawDetail);
        this.tm.trayErrors.pushError({
          agentId,
          title: "Message not delivered",
          detail: reason,
        });
        this.queueChannelDeliveryFailure(agentId, { addressToken, reason });
      });
  }
  queueChannelDeliveryFailure(agentId: string, failure: unknown): void {
    if (
      this.tm.pendingWakes.enqueuePendingWake(
        this.pendingChannelFailures,
        agentId,
        [failure],
      )
    )
      void this.reviveForChannelFailures(agentId);
  }
  async reviveForChannelFailures(agentId: string): Promise<void> {
    if (
      !this.tm.execution.canExecute ||
      this.revivingChannelFailureAgentIds.has(agentId)
    )
      return;
    this.revivingChannelFailureAgentIds.add(agentId);
    try {
      while ((this.pendingChannelFailures.get(agentId)?.length ?? 0) > 0) {
        const failures = this.pendingChannelFailures.get(agentId) ?? [];
        this.pendingChannelFailures.delete(agentId);
        if (!(await this.runChannelFailureWake(agentId, failures))) {
          this.pendingChannelFailures.set(agentId, [
            ...failures,
            ...(this.pendingChannelFailures.get(agentId) ?? []),
          ]);
          break;
        }
      }
    } finally {
      this.revivingChannelFailureAgentIds.delete(agentId);
    }
  }
  async runChannelFailureWake(
    agentId: string,
    failures: readonly any[],
  ): Promise<boolean> {
    if (failures.length === 0) return true;
    if (!this.tm.execution.canExecute) return false;
    let session: any;
    try {
      session = await this.tm.sessions.resolveBackgroundSession(agentId);
    } catch (error) {
      return error instanceof AgentGoneError;
    }
    if (this.tm.groupChat.isGroupSession(session)) return true;
    await this.runBackgroundWake(
      session,
      "connector",
      "channel-failure",
      async (runner) => {
        await runner.run(buildChannelDeliveryFailureWakePrompt(failures), {
          hidden: true,
          ...this.tm.widgetResponses.collectUnansweredQuestionPrompts(session),
        });
      },
      "Delivery-failure follow-up failed",
      "channel_failure",
    );
    return true;
  }

  wakeForInbound(agentId: string, envelope: unknown): void {
    if (
      this.tm.pendingWakes.enqueuePendingWake(this.pendingInbound, agentId, [
        envelope,
      ])
    )
      void this.reviveForInbound(agentId);
  }
  async reviveForInbound(agentId: string): Promise<void> {
    if (
      !this.tm.execution.canExecute ||
      this.revivingInboundAgentIds.has(agentId)
    )
      return;
    this.revivingInboundAgentIds.add(agentId);
    try {
      while ((this.pendingInbound.get(agentId)?.length ?? 0) > 0) {
        const envelopes = this.pendingInbound.get(agentId) ?? [];
        this.pendingInbound.delete(agentId);
        await this.runInboundWake(agentId, envelopes);
      }
    } finally {
      this.revivingInboundAgentIds.delete(agentId);
    }
  }
  async runInboundWake(
    agentId: string,
    envelopes: readonly any[],
  ): Promise<void> {
    if (envelopes.length === 0 || !this.tm.execution.canExecute) return;
    let session: any;
    try {
      session = await this.tm.sessions.resolveBackgroundSession(agentId);
    } catch {
      return;
    }
    if (
      this.tm.groupChat.isGroupSession(session) ||
      this.tm.groupChat.isRemoteRoomSession(session)
    )
      return;
    this.appendChannelInboundEntries(
      session,
      envelopes.filter((envelope) => envelope.isDisplayed !== true),
    );
    const sourceAddresses = distinctChannelAddresses(envelopes);
    const runner = this.tm.runnerRegistry.getRunner(session);
    this.tm.runLifecycle.beginSessionRun(session);
    await this.tm.runLifecycle.enqueueExclusiveRun(
      session.id,
      async () => {
        this.tm.turnRuntime.activeRequestPrompts.delete(session.id);
        this.tm.turnRuntime.activeRequestSources.set(session.id, "connector");
        this.dmPreemptedWakeAgentIds.delete(session.id);
        try {
          this.notifyChannelActivity(session.id, sourceAddresses, true);
          const result = await runner.run(
            buildChannelInboundWakePrompt(envelopes),
            {
              hidden: true,
              ...this.tm.widgetResponses.collectUnansweredQuestionPrompts(
                session,
              ),
              selectedImages: collectInboundImages(envelopes),
            },
          );
          const preempted = this.dmPreemptedWakeAgentIds.delete(session.id);
          if (result.aborted && result.quiescedForUpgrade !== true) {
            if (!preempted || this.tm.sessions.isAgentGone(agentId)) return;
            const redrivable = envelopes
              .filter((envelope) => envelope.isRedriven !== true)
              .map((envelope) => ({
                ...envelope,
                isDisplayed: true,
                isRedriven: true,
              }));
            if (redrivable.length > 0)
              this.pendingInbound.set(agentId, [
                ...redrivable,
                ...(this.pendingInbound.get(agentId) ?? []),
              ]);
            return;
          }
          if (!result.aborted && result.sentMessageCount === 0)
            await this.tm.automationRuntime.ensureHiddenTurnReply(runner);
          await this.tm.roster.emitAgentUpdate(session.id);
        } catch (error) {
          this.reportWakeError(
            session,
            "connector",
            "Channel message follow-up failed",
            error,
          );
        } finally {
          this.notifyChannelActivity(session.id, sourceAddresses, false);
          this.tm.runLifecycle.endSessionRun(session);
        }
      },
      { lane: "background", source: "connector" },
    );
  }
  notifyChannelActivity(
    agentId: string,
    addresses: readonly string[],
    isActive: boolean,
  ): void {
    for (const address of addresses)
      this.tm.channelActivity?.(agentId, address, isActive);
  }
  appendChannelInboundEntries(session: any, envelopes: readonly any[]): void {
    const isActive = session.id === this.tm.sessions.activeSession?.id;
    for (const envelope of envelopes) {
      const entry = {
        kind: "message",
        id: nextEntryId(
          isActive ? getTranscript() : session.db.getTranscriptEntries(),
          "user-message",
          session.db.getRetiredEntryIds(),
        ),
        role: "user",
        content: envelope.text,
        isStreaming: false,
        timestampMs: envelope.timestampMs,
        channel: formatChannelAddress(envelope.address),
        channelSender: envelope.sender,
      };
      if (isActive) this.tm.appendEntry(entry);
      else session.db.appendTranscriptEntry(entry);
    }
    if (!isActive) {
      this.tm.sessionStore.markSessionActivity(session);
      void this.tm.roster.emitAgentUpdate(session.id);
    }
  }

  async broadcastToAgents(
    targets: "all" | readonly string[],
    message: string,
  ): Promise<{ total: number; scheduled: number }> {
    const text = clampAgentMessage(message);
    if (text.length === 0 || !this.tm.execution.canExecute)
      return { total: 0, scheduled: 0 };
    const ids =
      targets === "all"
        ? await this.tm.sessionStore.listAgentIds()
        : [...new Set(targets)];
    let scheduled = 0;
    for (const id of ids)
      if (await this.scheduleBroadcast(id, text)) scheduled += 1;
    return { total: ids.length, scheduled };
  }
  async scheduleBroadcast(agentId: string, message: string): Promise<boolean> {
    if (this.tm.sessions.isAgentGone(agentId)) return false;
    let session: any;
    try {
      session = await this.tm.sessions.resolveBackgroundSession(agentId);
    } catch {
      return false;
    }
    if (
      this.tm.groupChat.isGroupSession(session) ||
      this.tm.groupChat.isRemoteRoomSession(session)
    )
      return false;
    void this.runBackgroundWake(
      session,
      "broadcast",
      "broadcast",
      async (runner) => {
        const result = await runner.run(
          buildAdminBroadcastWakePrompt(message),
          { hidden: true },
        );
        if (!result.aborted && result.sentMessageCount === 0)
          await this.tm.automationRuntime.ensureHiddenTurnReply(runner);
      },
      "Broadcast message failed",
    );
    return true;
  }

  emitTimelineEvent(agentId: string, event: unknown): void {
    if (!this.tm.sessions.isAgentGone(agentId))
      void this.recordTimelineEvent(agentId, event);
  }
  async recordTimelineEvent(agentId: string, event: unknown): Promise<void> {
    let session: any;
    try {
      session = await this.tm.sessions.resolveBackgroundSession(agentId);
    } catch {
      return;
    }
    if (this.tm.groupChat.isGroupSession(session)) return;
    this.appendTimelineEventEntry(session, event);
    if (!this.tm.runLifecycle.runningAgentIds().has(agentId))
      this.queueEventWake(agentId, event);
  }
  appendTimelineEventEntry(session: any, event: unknown): void {
    const entry = {
      kind: "event",
      id: `event-${randomUUID()}`,
      event,
      timestampMs: Date.now(),
    };
    if (session.id === this.tm.sessions.activeSession?.id)
      this.tm.appendEntry(entry);
    else session.db.appendTranscriptEntry(entry);
  }
  queueEventWake(agentId: string, event: unknown): void {
    if (
      this.tm.pendingWakes.enqueuePendingWake(this.pendingEventWakes, agentId, [
        event,
      ])
    )
      void this.reviveForEvents(agentId);
  }
  async reviveForEvents(agentId: string): Promise<void> {
    if (
      !this.tm.execution.canExecute ||
      this.revivingEventAgentIds.has(agentId)
    )
      return;
    this.revivingEventAgentIds.add(agentId);
    try {
      while ((this.pendingEventWakes.get(agentId)?.length ?? 0) > 0) {
        const events = this.pendingEventWakes.get(agentId) ?? [];
        this.pendingEventWakes.delete(agentId);
        try {
          await this.runEventWake(agentId, events);
        } catch (error) {
          console.error(
            `[transcript-manager] event wake revival failed for ${agentId}:`,
            error,
          );
        }
      }
    } finally {
      this.revivingEventAgentIds.delete(agentId);
    }
  }
  async runEventWake(agentId: string, events: readonly any[]): Promise<void> {
    if (events.length === 0 || !this.tm.execution.canExecute) return;
    let session: any;
    try {
      session = await this.tm.sessions.resolveBackgroundSession(agentId);
    } catch {
      return;
    }
    if (!this.tm.groupChat.isGroupSession(session))
      await this.runBackgroundWake(
        session,
        "event",
        "event",
        (runner) =>
          runner.run(buildTimelineEventWakePrompt(events), {
            hidden: true,
            isSilenceAllowed: true,
          }),
        "Timeline event follow-up failed",
      );
  }
  hasRunningBackgroundShellWork(): boolean {
    for (const runner of this.tm.runnerRegistry.runners.values())
      if (runner.hasRunningBackgroundShellWork()) return true;
    return false;
  }

  private async runBackgroundWake(
    session: any,
    requestSource: string,
    queueSource: string,
    run: (runner: any) => Promise<unknown>,
    trayTitle: string,
    errorSource = requestSource,
  ): Promise<void> {
    const runner = this.tm.runnerRegistry.getRunner(session);
    this.tm.runLifecycle.beginSessionRun(session);
    await this.tm.runLifecycle.enqueueExclusiveRun(
      session.id,
      async () => {
        this.tm.turnRuntime.activeRequestPrompts.delete(session.id);
        this.tm.turnRuntime.activeRequestSources.set(session.id, requestSource);
        try {
          await run(runner);
          await this.tm.roster.emitAgentUpdate(session.id);
        } catch (error) {
          this.reportWakeError(session, errorSource, trayTitle, error);
        } finally {
          this.tm.runLifecycle.endSessionRun(session);
        }
      },
      { lane: "background", source: queueSource },
    );
  }
  private reportWakeError(
    session: any,
    source: string,
    title: string,
    error: unknown,
  ): void {
    this.tm.telemetry.reportAgentError({
      source,
      conversationId: session.id,
      requestId: this.tm.runLifecycle.lastRequestIdBySession.get(session.id),
      error: classifyAgentError(error),
      detail: sandErrorDetail(error),
    });
    this.tm.trayErrors.pushError({
      agentId: session.id,
      title,
      ...describeAgentRunError(error),
    });
  }
}
