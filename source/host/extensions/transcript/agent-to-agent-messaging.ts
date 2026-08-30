import {
  buildAgentInboundWakePrompt,
  clampAgentMessage,
} from "../../agents/agent-messaging.js";
import { sandErrorDetail } from "../../ports/telemetry.js";
import { entryRaisesUserActivitySignal } from "../../../shared/transcript.js";
import { describeAgentRunError } from "./agent-run-error.js";
import { loadAgentInboundImages } from "./send-message-shaping.js";
import { nextEntryId } from "./transcript-entry-ids.js";
import { getTranscript } from "./transcript-store.js";
import { classifyAgentError } from "./turn-runtime.js";
import type { TranscriptManagerLike } from "./transcript-hub.js";

export interface AgentInboundMessage {
  from: { id: string; name: string };
  text: string;
  timestampMs: number;
  images?: readonly { url: string; alt?: string }[];
  priority?: boolean;
  isDisplayed?: boolean;
  isRedriven?: boolean;
}
export function partitionAgentInbound<T extends { priority?: boolean }>(
  messages: readonly T[],
): { priority: T[]; rest: T[] } {
  const priority: T[] = [],
    rest: T[] = [];
  for (const message of messages)
    (message.priority === true ? priority : rest).push(message);
  return { priority, rest };
}
export function prioritizeAgentInbound<T extends { priority?: boolean }>(
  messages: readonly T[],
): T[] {
  const parts = partitionAgentInbound(messages);
  return [...parts.priority, ...parts.rest];
}
export function mergeAgentInboundQueue<T extends { priority?: boolean }>(
  queued: readonly T[],
  deferred: readonly T[],
): T[] {
  const newer = partitionAgentInbound(queued),
    older = partitionAgentInbound(deferred);
  return [...newer.priority, ...older.priority, ...older.rest, ...newer.rest];
}

export class AgentToAgentMessaging {
  readonly pendingAgentInbound = new Map<string, AgentInboundMessage[]>();
  readonly revivingAgentInboundIds = new Set<string>();
  constructor(readonly tm: TranscriptManagerLike) {}

  async sendToAgent(
    fromAgentId: string,
    toAgentId: string,
    text: string,
    images: readonly { url: string; alt?: string }[] = [],
    priority = false,
  ): Promise<string> {
    const message = clampAgentMessage(text);
    if (message.length === 0) return "Message was empty; nothing was sent.";
    if (toAgentId === fromAgentId) return "An agent can't message itself.";
    if (this.tm.sessions.isAgentGone(toAgentId))
      return "That agent no longer exists.";
    if (this.tm.groupChat.isRemoteRoomAgentId(toAgentId))
      return "That is a shared chat hosted by another user; agents can't message it directly.";
    const roster = await this.tm.sessionStore.listAgents();
    const target = roster.find((agent: any) => agent.id === toAgentId);
    if (target == null) return `No agent found with id ${toAgentId}.`;
    if (target.isGroup) {
      const ack = await this.tm.postToGroup(
        fromAgentId,
        toAgentId,
        message,
        priority,
      );
      const notes: string[] = [];
      if (images.length > 0)
        notes.push(
          `Note: the attached image${images.length === 1 ? " was" : "s were"} NOT delivered — group messages are text-only for now; send images to an agent directly.`,
        );
      if (priority)
        notes.push(
          "Note: priority is 1:1 only — this post did not interrupt members.",
        );
      return notes.length === 0 ? ack : `${ack} ${notes.join(" ")}`;
    }
    this.tm.productAnalytics.trackEvent("sand.agent_message.sent", {
      from_agent_id: fromAgentId,
      to_agent_id: toAgentId,
      is_group_target: false,
      is_priority: priority,
    });
    const sender = roster.find((agent: any) => agent.id === fromAgentId);
    this.tm.sessions.liveSessions
      .get(fromAgentId)
      ?.db.addConversationPartner(toAgentId);
    this.appendAgentOutboundEntry(
      fromAgentId,
      { id: toAgentId, name: target.name, kind: "agent" },
      message,
      Date.now(),
      images,
    );
    const inbound: AgentInboundMessage = {
      from: { id: fromAgentId, name: sender?.name ?? "An agent" },
      text: message,
      timestampMs: Date.now(),
      ...(images.length === 0 ? {} : { images }),
      ...(priority ? { priority: true } : {}),
    };
    const queued = this.pendingAgentInbound.get(toAgentId) ?? [];
    if (priority) {
      this.pendingAgentInbound.set(toAgentId, [inbound, ...queued]);
      this.steerRecipientForPriorityPeer(toAgentId);
    } else {
      queued.push(inbound);
      this.pendingAgentInbound.set(toAgentId, queued);
    }
    void this.reviveForAgentInbound(toAgentId);
    return priority
      ? `Sent to ${target.name} as a priority message — it will interrupt their current non-user work and wake them now. This is asynchronous — if they reply, it'll arrive later as a new message that wakes you; don't wait on it now.`
      : `Sent to ${target.name}. This is asynchronous — if they reply, it'll arrive later as a new message that wakes you; don't wait on it now.`;
  }

  steerRecipientForPriorityPeer(agentId: string): void {
    const scheduler = this.tm.runLifecycle.runScheduler;
    if (scheduler == null || scheduler.getActiveLane(agentId) === "user")
      return;
    const reason = "superseded by a priority agent message";
    const wasInFlight = this.tm.runLifecycle.runningAgentIds().has(agentId);
    const hadGroupRun =
      this.tm.runnerRegistry.activeGroupMemberRunners
        .get(agentId)
        ?.interrupt(reason) ?? false;
    if (hadGroupRun) this.tm.groupChat.dmPreemptedGroupMemberIds.add(agentId);
    const hadDirectRun =
      this.tm.runnerRegistry.runners.get(agentId)?.interrupt(reason) ?? false;
    if (hadDirectRun)
      this.tm.backgroundWakes.dmPreemptedWakeAgentIds.add(agentId);
    if (hadDirectRun || hadGroupRun || wasInFlight)
      this.tm.telemetry.reportTurnInterrupt({
        conversationId: agentId,
        reason: "agent_steer",
        hadActiveRun: hadDirectRun || hadGroupRun,
        wasInFlight,
      });
  }

  async reviveForAgentInbound(agentId: string): Promise<void> {
    if (
      !this.tm.execution.canExecute ||
      this.revivingAgentInboundIds.has(agentId)
    )
      return;
    this.revivingAgentInboundIds.add(agentId);
    try {
      while ((this.pendingAgentInbound.get(agentId)?.length ?? 0) > 0) {
        const messages = prioritizeAgentInbound(
          this.pendingAgentInbound.get(agentId) ?? [],
        );
        this.pendingAgentInbound.delete(agentId);
        await this.runAgentInboundWake(agentId, messages);
      }
    } finally {
      this.revivingAgentInboundIds.delete(agentId);
    }
  }

  async runAgentInboundWake(
    agentId: string,
    messages: readonly AgentInboundMessage[],
  ): Promise<void> {
    if (messages.length === 0 || !this.tm.execution.canExecute) return;
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
    this.appendAgentInboundEntries(
      session,
      messages.filter((message) => message.isDisplayed !== true),
    );
    const runner = this.tm.runnerRegistry.getRunner(session);
    this.tm.runLifecycle.beginSessionRun(session);
    await this.tm.runLifecycle.enqueueExclusiveRun(
      session.id,
      async () => {
        this.tm.turnRuntime.activeRequestPrompts.delete(session.id);
        this.tm.turnRuntime.activeRequestSources.set(session.id, "agent");
        this.tm.backgroundWakes.dmPreemptedWakeAgentIds.delete(session.id);
        try {
          for (const [index, message] of messages.entries()) {
            if (
              index > 0 &&
              (this.pendingAgentInbound.get(agentId) ?? []).some(
                (pending) => pending.priority === true,
              )
            ) {
              const deferred = messages
                .slice(index)
                .map((remaining) => ({ ...remaining, isDisplayed: true }));
              this.pendingAgentInbound.set(
                agentId,
                mergeAgentInboundQueue(
                  this.pendingAgentInbound.get(agentId) ?? [],
                  deferred,
                ),
              );
              return;
            }
            const selectedImages = await loadAgentInboundImages(message.images);
            const result = await runner.run(
              buildAgentInboundWakePrompt(message),
              {
                hidden: true,
                isSilenceAllowed: true,
                ...(selectedImages.length === 0 ? {} : { selectedImages }),
              },
            );
            const preempted =
              this.tm.backgroundWakes.dmPreemptedWakeAgentIds.delete(
                session.id,
              );
            if (result.aborted && result.quiescedForUpgrade !== true) {
              if (!preempted || this.tm.sessions.isAgentGone(agentId)) return;
              const redrivable = messages
                .slice(index)
                .filter((remaining) => remaining.isRedriven !== true)
                .map((remaining) => ({
                  ...remaining,
                  isDisplayed: true,
                  isRedriven: true,
                }));
              if (redrivable.length > 0)
                this.pendingAgentInbound.set(
                  agentId,
                  mergeAgentInboundQueue(
                    this.pendingAgentInbound.get(agentId) ?? [],
                    redrivable,
                  ),
                );
              return;
            }
          }
          await this.tm.roster.emitAgentUpdate(session.id);
        } catch (error) {
          this.tm.telemetry.reportAgentError({
            source: "agent",
            conversationId: session.id,
            requestId: this.tm.runLifecycle.lastRequestIdBySession.get(
              session.id,
            ),
            error: classifyAgentError(error),
            detail: sandErrorDetail(error),
          });
          this.tm.trayErrors.pushError({
            agentId: session.id,
            title: "Message from another agent failed",
            ...describeAgentRunError(error),
          });
        } finally {
          this.tm.runLifecycle.endSessionRun(session);
        }
      },
      { lane: "agent", source: "agent" },
    );
  }

  appendAgentInboundEntries(
    session: any,
    messages: readonly AgentInboundMessage[],
  ): void {
    const isActive = session.id === this.tm.sessions.activeSession?.id;
    let raisesActivity = false;
    for (const message of messages) {
      session.db.addConversationPartner(message.from.id);
      const entries = isActive
        ? getTranscript()
        : session.db.getTranscriptEntries();
      const entry = {
        kind: "message",
        id: nextEntryId(
          entries,
          "user-message",
          session.db.getRetiredEntryIds(),
        ),
        role: "user",
        content: message.text,
        isStreaming: false,
        timestampMs: message.timestampMs,
        fromAgent: message.from,
        ...(message.images?.length ? { images: message.images } : {}),
      };
      raisesActivity ||= entryRaisesUserActivitySignal(entry);
      if (isActive) this.tm.appendEntry(entry);
      else session.db.appendTranscriptEntry(entry);
    }
    if (!isActive) {
      if (raisesActivity) this.tm.sessionStore.markSessionActivity(session);
      void this.tm.roster.emitAgentUpdate(session.id);
    }
  }
  appendAgentOutboundEntry(
    fromAgentId: string,
    toAgent: { readonly kind?: string; readonly [key: string]: unknown },
    text: string,
    timestampMs: number,
    images: readonly { url: string; alt?: string }[] = [],
  ): void {
    const session = this.tm.sessions.liveSessions.get(fromAgentId);
    if (session == null) return;
    const isActive = session.id === this.tm.sessions.activeSession?.id;
    const entry = {
      kind: "message",
      id: nextEntryId(
        isActive ? getTranscript() : session.db.getTranscriptEntries(),
        "assistant-message",
        session.db.getRetiredEntryIds(),
      ),
      role: "assistant",
      content: text,
      isStreaming: false,
      timestampMs,
      toAgent,
      ...(images.length === 0 ? {} : { images }),
    };
    if (isActive) this.tm.appendEntry(entry);
    else {
      session.db.appendTranscriptEntry(entry);
      if (entryRaisesUserActivitySignal(entry))
        this.tm.sessionStore.markSessionActivity(session);
      void this.tm.roster.emitAgentUpdate(session.id);
    }
  }
}
