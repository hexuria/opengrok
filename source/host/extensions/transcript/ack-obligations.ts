import { randomUUID } from "node:crypto";
import { sandErrorDetail } from "../../ports/telemetry.js";
import { classifyAgentError, isDeliveryOwed } from "./turn-runtime.js";
import type { Disposable, TranscriptManagerLike } from "./transcript-hub.js";

export const MAX_ACK_REDRIVES = 3;
export const ACK_REDRIVE_IDLE_DELAY_MS = 5_000;
export function buildAckRedrivePrompt(): string {
  return "[System recovery] The user sent one or more messages that were never visibly acknowledged — the turns handling them were interrupted, or the app restarted before a reply went out. Their newest message may be MISSING from your context entirely. Respond now by actually invoking the SendMessage tool: if you can see their latest message and already completed what it asked, send a brief confirmation with the result; if you can see it but the work is not done, acknowledge them and continue the work; if you cannot be certain what they last asked, say you may have missed their latest message and ask them to resend it — NEVER guess or claim completion of work you cannot see. Plain assistant text is NEVER shown to the user; only a real SendMessage tool invocation reaches them. Do NOT end this turn with only thinking, an empty reply, or a plan to send later — ending the turn without a real SendMessage invocation delivers nothing and is a failure. Invoke SendMessage now, even if all you can send is a brief status update.";
}

export class AckObligations {
  readonly ackRedriveTimers = new Map<string, Disposable>();
  readonly ackRunTokens = new Map<string, Set<string>>();

  constructor(readonly tm: TranscriptManagerLike) {}

  recordAckObligationSend(session: any, acceptedAtMs: number): void {
    const store = this.tm.ackObligationStore;
    if (store == null || this.tm.runLifecycle.runScheduler == null) return;
    this.clearAckRedriveTimer(session.id);
    const { obligation, created } = store.recordSend(session.id, {
      atMs: acceptedAtMs,
    });
    this.tm.telemetry.reportAckObligation({
      conversationId: session.id,
      outcome: created ? "created" : "coalesced",
      ageMs: acceptedAtMs - obligation.createdAtMs,
      coalescedCount: obligation.coalescedCount,
    });
  }
  armSendGuard(
    session: any,
    acceptedAtMs: number,
    owesAck: boolean,
  ): { disarm(): void; [Symbol.dispose](): void } {
    let armed = owesAck;
    return {
      disarm: () => {
        armed = false;
      },
      [Symbol.dispose]: () => {
        if (
          !armed ||
          this.tm.ackObligationStore == null ||
          this.tm.runLifecycle.runScheduler == null
        )
          return;
        if (this.tm.ackObligationStore.get(session.id) == null)
          this.recordAckObligationSend(session, acceptedAtMs);
      },
    };
  }
  confirmAckObligationAfterInterrupt(
    session: any,
    acceptedAtMs: number,
    interrupted: boolean,
  ): void {
    const store = this.tm.ackObligationStore;
    if (store == null || this.tm.runLifecycle.runScheduler == null) return;
    this.clearAckRedriveTimer(session.id);
    if (store.get(session.id) == null)
      this.recordAckObligationSend(session, acceptedAtMs);
    if (interrupted) store.recordInterrupt(session.id, acceptedAtMs);
  }
  mintAckRunToken(agentId: string): string | undefined {
    if (
      this.tm.ackObligationStore == null ||
      this.tm.runLifecycle.runScheduler == null
    )
      return undefined;
    const token = randomUUID();
    const tokens = this.ackRunTokens.get(agentId) ?? new Set<string>();
    tokens.add(token);
    this.ackRunTokens.set(agentId, tokens);
    return token;
  }
  retireAckRunToken(agentId: string, token?: string): void {
    if (token == null) return;
    const tokens = this.ackRunTokens.get(agentId);
    if (tokens == null) return;
    tokens.delete(token);
    if (tokens.size === 0) this.ackRunTokens.delete(agentId);
  }
  fulfillAckObligation(agentId?: string, ackToken?: string): void {
    if (
      agentId == null ||
      ackToken == null ||
      this.ackRunTokens.get(agentId)?.has(ackToken) !== true
    )
      return;
    const store = this.tm.ackObligationStore;
    if (store == null || this.tm.runLifecycle.runScheduler == null) return;
    const obligation = store.get(agentId);
    if (obligation == null) return;
    store.clear(agentId);
    this.clearAckRedriveTimer(agentId);
    const now = Date.now();
    this.tm.telemetry.reportAckObligation({
      conversationId: agentId,
      outcome: "fulfilled",
      ageMs: now - obligation.createdAtMs,
      coalescedCount: obligation.coalescedCount,
      redriveAttempts: obligation.redriveAttempts,
      timeToFirstVisibleAckMs: now - obligation.createdAtMs,
      ...(obligation.lastInterruptAtMs == null
        ? {}
        : { interruptToReplacementAckMs: now - obligation.lastInterruptAtMs }),
    });
  }
  markAckObligationLost(
    agentId: string,
    reason: "agent_deleted" | "max_redrives",
  ): void {
    const store = this.tm.ackObligationStore;
    if (store == null || this.tm.runLifecycle.runScheduler == null) return;
    const obligation = store.get(agentId);
    if (obligation == null) return;
    store.clear(agentId);
    this.clearAckRedriveTimer(agentId);
    this.tm.telemetry.reportAckObligation({
      conversationId: agentId,
      outcome: "lost",
      reason,
      ageMs: Date.now() - obligation.createdAtMs,
      coalescedCount: obligation.coalescedCount,
      redriveAttempts: obligation.redriveAttempts,
    });
  }
  clearAckRedriveTimer(agentId: string): void {
    const armed = this.ackRedriveTimers.get(agentId);
    if (armed == null) return;
    armed.dispose();
    this.ackRedriveTimers.delete(agentId);
  }
  scheduleAckRedriveAfterIdle(agentId: string): void {
    this.armAckRedriveTimer(agentId, "idle");
  }
  armAckRedriveTimer(agentId: string, trigger: "idle" | "boot"): void {
    const store = this.tm.ackObligationStore;
    if (
      store == null ||
      this.tm.runLifecycle.runScheduler == null ||
      this.tm.disposed ||
      this.tm.upgradeResume.quiescingForUpgrade ||
      store.get(agentId) == null
    )
      return;
    this.clearAckRedriveTimer(agentId);
    this.ackRedriveTimers.set(
      agentId,
      this.tm.ackRedrivePolicy.arm(agentId, () => {
        this.ackRedriveTimers.delete(agentId);
        void this.redriveAckObligation(agentId, trigger);
      }),
    );
  }
  async redriveUnfulfilledAckObligations(): Promise<void> {
    const store = this.tm.ackObligationStore;
    if (
      store == null ||
      this.tm.runLifecycle.runScheduler == null ||
      !this.tm.execution.canExecute
    )
      return;
    for (const obligation of store.list())
      this.armAckRedriveTimer(obligation.agentId, "boot");
  }
  async redriveAckObligation(
    agentId: string,
    trigger: "idle" | "boot",
  ): Promise<void> {
    const store = this.tm.ackObligationStore;
    if (
      store == null ||
      this.tm.runLifecycle.runScheduler == null ||
      !this.tm.execution.canExecute ||
      this.tm.disposed ||
      this.tm.upgradeResume.quiescingForUpgrade
    )
      return;
    const obligation = store.get(agentId);
    if (obligation == null) return;
    if (this.tm.sessions.isAgentGone(agentId))
      return this.markAckObligationLost(agentId, "agent_deleted");
    if (obligation.redriveAttempts >= MAX_ACK_REDRIVES)
      return this.markAckObligationLost(agentId, "max_redrives");
    const bumped = store.recordRedriveAttempt(agentId);
    if (bumped == null) return;
    this.tm.telemetry.reportAckObligation({
      conversationId: agentId,
      outcome: "redrive",
      reason: trigger,
      ageMs: Date.now() - bumped.createdAtMs,
      coalescedCount: bumped.coalescedCount,
      redriveAttempts: bumped.redriveAttempts,
    });
    let session: any;
    try {
      session = await this.tm.sessions.resolveBackgroundSession(agentId);
    } catch {
      this.scheduleAckRedriveAfterIdle(agentId);
      return;
    }
    if (
      this.tm.groupChat.isGroupSession(session) ||
      this.tm.groupChat.isRemoteRoomSession(session)
    ) {
      store.clear(agentId);
      return;
    }
    const runner = this.tm.runnerRegistry.getRunner(session);
    this.tm.runLifecycle.beginSessionRun(session);
    const ackToken = this.mintAckRunToken(session.id);
    await this.tm.runLifecycle.enqueueExclusiveRun(
      session.id,
      async () => {
        this.tm.turnRuntime.activeRequestPrompts.delete(session.id);
        this.tm.turnRuntime.activeRequestSources.set(
          session.id,
          "handoff-resume",
        );
        try {
          if (store.get(agentId) == null) return;
          const startedAtMs = Date.now();
          const prompt = buildAckRedrivePrompt();
          const messageId = `ack-redrive-${randomUUID()}`;
          const recentUserMessages = [
            ...session.db
              .getTranscriptEntries()
              .filter(
                (entry: any) =>
                  entry.kind === "message" &&
                  entry.role === "user" &&
                  entry.fromAgent == null &&
                  entry.channel == null,
              )
              .map((entry: any) => ({
                id: entry.id,
                text: entry.content,
                richText: entry.richText,
              })),
            { id: messageId, text: prompt },
          ];
          const result = await runner.run(prompt, {
            hidden: true,
            ...(ackToken == null ? {} : { ackToken }),
            messageId,
            recentUserMessages,
            requestSource: "handoff-resume",
          });
          await this.tm.roster.emitAgentUpdate(session.id);
          if (
            isDeliveryOwed(result) &&
            !result.aborted &&
            result.quiescedForUpgrade !== true
          )
            this.tm.telemetry.reportTurnEmptyDelivery({
              conversationId: session.id,
              requestId: this.tm.runLifecycle.lastRequestIdBySession.get(
                session.id,
              ),
              source: "ack_redrive",
              requestSource: "handoff-resume",
              redriveAttempts: bumped.redriveAttempts,
              toolCallCount: runner.getObservedToolCallCount(),
              streamOutputProduced: result.streamOutputProduced === true,
              durationMs: Date.now() - startedAtMs,
              ackOutstanding: store.get(agentId) != null,
            });
        } catch (error) {
          this.tm.telemetry.reportAgentError({
            source: "ack_redrive",
            conversationId: session.id,
            requestId: this.tm.runLifecycle.lastRequestIdBySession.get(
              session.id,
            ),
            error: classifyAgentError(error),
            detail: sandErrorDetail(error),
          });
        } finally {
          this.retireAckRunToken(session.id, ackToken);
          this.tm.runLifecycle.endSessionRun(session);
        }
      },
      {
        lane: "background",
        source: "ack-redrive",
        ...(ackToken == null ? {} : { ackToken }),
      },
    );
  }
}
