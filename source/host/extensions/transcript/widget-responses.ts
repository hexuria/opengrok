import { errorLogTag } from "../../../shared/errors.js";
import {
  getMainTranscriptEntries,
  getThreadTranscriptEntries,
  isAgentPeerMessageEntry,
  SAND_REACTION_SELF,
  settlePendingAutoReviewApprovalEntry,
  settlePendingLocalToolPermissionEntry,
} from "../../../shared/transcript.js";
import { buildSecretProvidedAck } from "../../runner/tools/sand-secret-request.js";
import { SPEND_GUARD_VALUE_PREFIX } from "./sand-automation-spend-guard.js";
import {
  describeReactedMessageQuote,
  isUserMessageEntry,
  skippablePromptSummary,
  toggleReaction,
} from "./send-message-shaping.js";
import { getTranscript, updateEntry } from "./transcript-store.js";
import type {
  TranscriptEntry,
  TranscriptManagerLike,
} from "./transcript-hub.js";

type LiveSession = any;

export class WidgetResponses {
  constructor(readonly tm: TranscriptManagerLike) {}

  collectUnansweredQuestionPrompts(session: LiveSession): {
    skippedQuestionPrompts: string[];
    dismissedQuestionPrompts: string[];
  } {
    const isActive = session.id === this.tm.sessions.activeSession?.id;
    const entries = isActive
      ? getTranscript()
      : session.db.getTranscriptEntries();
    const skippedQuestionPrompts: string[] = [];
    const dismissedQuestionPrompts: string[] = [];
    for (const entry of entries) {
      if (
        entry.kind !== "send-message" ||
        entry.respondedValue != null ||
        entry.widgetSkipped === true
      )
        continue;
      const summary = skippablePromptSummary(entry.message as any);
      if (summary == null) continue;
      if (entry.widgetDismissed === true)
        dismissedQuestionPrompts.push(summary);
      else skippedQuestionPrompts.push(summary);
      const markSkipped = (current: TranscriptEntry): TranscriptEntry =>
        current.kind === "send-message"
          ? { ...current, widgetSkipped: true }
          : current;
      if (isActive) {
        const updated = updateEntry(entry.id, markSkipped);
        if (updated != null)
          this.tm.roster.emit({ type: "updated", entry: updated });
      }
      session.db.updateTranscriptEntry(entry.id, markSkipped);
    }
    return { skippedQuestionPrompts, dismissedQuestionPrompts };
  }

  async respondToWidget(
    entryId: string,
    value: string,
    agentId: string,
  ): Promise<{ accepted: boolean }> {
    const trimmedValue = value.trim();
    if (trimmedValue.length === 0) return { accepted: false };
    await this.tm.sessions.ensureActionTarget(agentId);
    const targetAgentId = this.tm.sessions.activeSession?.id;
    if (!this.recordWidgetResponse(entryId, trimmedValue))
      return { accepted: false };

    const widgetEntry = getTranscript().find((entry) => entry.id === entryId);
    const replyToId =
      widgetEntry?.kind === "send-message"
        ? (widgetEntry.replyTo as string | undefined)
        : undefined;
    let modelPrompt = trimmedValue;
    let guardApplied = false;
    try {
      if (
        trimmedValue.startsWith(SPEND_GUARD_VALUE_PREFIX) &&
        targetAgentId != null
      ) {
        const applied =
          await this.tm.automationRuntime.handleSpendGuardWidgetAnswer({
            agentId: targetAgentId,
            entryId,
            value: trimmedValue,
            onApplied: () => {
              guardApplied = true;
            },
          });
        if (applied == null) {
          this.rollbackWidgetResponse(entryId);
          return { accepted: false };
        }
        modelPrompt = applied;
      }
      await this.tm.sendPrompt(modelPrompt, {
        ...(targetAgentId == null ? {} : { agentId: targetAgentId }),
        ...(replyToId == null ? {} : { replyToId }),
        appendUserMessage: false,
        awaitTurn: false,
      });
    } catch (error) {
      if (guardApplied) return { accepted: true };
      this.rollbackWidgetResponse(entryId);
      throw error;
    }
    return { accepted: true };
  }

  async settleStaleAutoReviewCard(args: {
    agentId: string;
    entryId: string;
    requestId: string;
  }): Promise<boolean> {
    if (
      this.settlePendingAutoReviewApprovalsOnSession({
        agentId: args.agentId,
        status: "expired",
        requestId: args.requestId,
      })
    )
      return true;
    const expired = await this.tm.sessionStore.expirePendingAutoReviewApprovals(
      args.agentId,
      args.requestId,
    );
    if (expired.length > 0) void this.tm.roster.emitAgentUpdate(args.agentId);
    const settled = this.tm.sessionStore
      .readAgentTranscriptEntries(args.agentId)
      .find(
        (entry: any) =>
          entry.id === args.entryId &&
          entry.kind === "send-message" &&
          entry.message.type === "auto-review-approval" &&
          entry.message.approval.requestId === args.requestId,
      );
    if (settled == null) return false;
    this.tm.roster.emit({ type: "updated", entry: settled }, args.agentId);
    return true;
  }

  async expireAllPendingAutoReviewApprovalCards(): Promise<void> {
    const reportFailure = (stage: string, error: unknown): void => {
      this.tm.telemetry.reportAutoReviewExpireSweepFailed({
        stage,
        errorClass: errorLogTag(error),
      });
    };
    try {
      const activeId = this.tm.sessions.activeSession?.id;
      if (activeId != null) {
        this.settlePendingAutoReviewApprovalsOnSession({
          agentId: activeId,
          status: "expired",
        });
      }
      let agentIds: string[];
      try {
        agentIds = await this.tm.sessionStore.listAgentIds();
      } catch (error) {
        reportFailure("list_agents", error);
        return;
      }
      for (const agentId of agentIds) {
        if (agentId === activeId) continue;
        try {
          const expired =
            await this.tm.sessionStore.expirePendingAutoReviewApprovals(
              agentId,
            );
          if (expired.length > 0) void this.tm.roster.emitAgentUpdate(agentId);
        } catch (error) {
          reportFailure("expire_agent", error);
        }
      }
    } catch (error) {
      reportFailure("sweep", error);
    }
  }

  settlePendingAutoReviewApprovalsOnSession(args: {
    agentId: string;
    status: string;
    requestId?: string;
  }): boolean {
    const session = this.liveSessionFor(args.agentId);
    if (session == null) return false;
    let retired = false;
    for (const entry of session.db.getTranscriptEntries()) {
      const settled = settlePendingAutoReviewApprovalEntry(
        entry,
        args.status,
        args.requestId,
      ) as TranscriptEntry | null;
      if (settled == null) continue;
      session.db.updateTranscriptEntry(entry.id, () => settled);
      retired = true;
      const live =
        args.agentId === this.tm.sessions.activeSession?.id
          ? updateEntry(entry.id, () => settled)
          : null;
      this.tm.roster.emit(
        { type: "updated", entry: live ?? settled },
        args.agentId,
      );
    }
    return retired;
  }

  async settleStaleLocalToolPermissionCard(args: {
    agentId: string;
    entryId: string;
    requestId: string;
  }): Promise<"retired" | "already-settled" | false> {
    if (this.settlePendingLocalToolPermissionAsksOnSession(args))
      return "retired";
    const expired =
      await this.tm.sessionStore.expirePendingLocalToolPermissionAsks({
        agentId: args.agentId,
        onlyRequestId: args.requestId,
      });
    if (expired.length > 0) void this.tm.roster.emitAgentUpdate(args.agentId);
    const settled = this.tm.sessionStore
      .readAgentTranscriptEntries(args.agentId)
      .find(
        (entry: any) =>
          entry.id === args.entryId &&
          entry.kind === "send-message" &&
          entry.message.type === "local-tool-permission" &&
          entry.message.ask.requestId === args.requestId,
      );
    if (settled == null) return false;
    this.tm.roster.emit({ type: "updated", entry: settled }, args.agentId);
    return expired.length > 0 ? "retired" : "already-settled";
  }

  async expireAllPendingLocalToolPermissionCards(options?: {
    ifPendingBeforeMs?: number;
  }): Promise<void> {
    try {
      const activeId = this.tm.sessions.activeSession?.id;
      if (activeId != null) {
        this.settlePendingLocalToolPermissionAsksOnSession({
          agentId: activeId,
          ...(options?.ifPendingBeforeMs == null
            ? {}
            : { ifPendingBeforeMs: options.ifPendingBeforeMs }),
        });
      }
      let agentIds: string[];
      try {
        agentIds = await this.tm.sessionStore.listAgentIds();
      } catch {
        return;
      }
      for (const agentId of agentIds) {
        if (agentId === activeId) continue;
        try {
          const expired =
            await this.tm.sessionStore.expirePendingLocalToolPermissionAsks({
              agentId,
              ifPendingBeforeMs: options?.ifPendingBeforeMs,
            });
          if (expired.length > 0) void this.tm.roster.emitAgentUpdate(agentId);
        } catch {
          continue;
        }
      }
    } catch {
      return;
    }
  }

  settlePendingLocalToolPermissionAsksOnSession(args: {
    agentId: string;
    requestId?: string;
    ifPendingBeforeMs?: number;
  }): boolean {
    const session = this.liveSessionFor(args.agentId);
    if (session == null) return false;
    let retired = false;
    for (const entry of session.db.getTranscriptEntries()) {
      if (
        args.ifPendingBeforeMs != null &&
        entry.kind === "send-message" &&
        entry.timestampMs != null &&
        entry.timestampMs >= args.ifPendingBeforeMs
      )
        continue;
      const settled = settlePendingLocalToolPermissionEntry(
        entry,
        "expired",
        args.requestId,
      ) as TranscriptEntry | null;
      if (settled == null) continue;
      session.db.updateTranscriptEntry(entry.id, () => settled);
      retired = true;
      const live =
        args.agentId === this.tm.sessions.activeSession?.id
          ? updateEntry(entry.id, () => settled)
          : null;
      this.tm.roster.emit(
        { type: "updated", entry: live ?? settled },
        args.agentId,
      );
    }
    return retired;
  }

  async dismissWidget(args: {
    entryId: string;
    agentId: string;
  }): Promise<{ accepted: boolean }> {
    await this.tm.sessions.ensureActionTarget(args.agentId);
    const existing = getTranscript().find((entry) => entry.id === args.entryId);
    if (
      existing == null ||
      existing.kind !== "send-message" ||
      (existing.message as any)?.type !== "widget" ||
      existing.respondedValue != null ||
      existing.widgetDismissed === true
    )
      return { accepted: false };
    let didStamp = false;
    const markDismissed = (entry: TranscriptEntry): TranscriptEntry => {
      if (
        entry.kind !== "send-message" ||
        entry.respondedValue != null ||
        entry.widgetDismissed === true
      )
        return entry;
      didStamp = true;
      const { widgetSkipped: _skipped, ...rest } = entry;
      return { ...rest, widgetDismissed: true } as TranscriptEntry;
    };
    const updated = updateEntry(args.entryId, markDismissed);
    if (didStamp && updated != null) {
      this.tm.roster.emit({ type: "updated", entry: updated });
      this.tm.sessions.activeSession?.db.updateTranscriptEntry(
        args.entryId,
        markDismissed,
      );
    }
    return { accepted: didStamp };
  }

  async submitSecret(
    entryId: string,
    value: string,
    agentId: string,
  ): Promise<void> {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    await this.tm.sessions.ensureActionTarget(agentId);
    const session = this.tm.sessions.activeSession;
    if (session == null) return;
    const entry = getTranscript().find((item) => item.id === entryId);
    if (
      entry == null ||
      entry.kind !== "send-message" ||
      (entry.message as any)?.type !== "secret-request" ||
      entry.secretProvided === true
    )
      return;
    const request = (entry.message as any).secretRequest;
    if (!this.routeSecret(session.id, request.target, trimmed)) {
      this.tm.trayErrors.pushError({
        agentId: session.id,
        title: "Could not store the secret",
        detail: "The secure input could not write the credential to its store.",
      });
      return;
    }
    const markProvided = (item: TranscriptEntry): TranscriptEntry =>
      item.kind === "send-message" ? { ...item, secretProvided: true } : item;
    const updated = updateEntry(entryId, markProvided);
    if (updated != null)
      this.tm.roster.emit({ type: "updated", entry: updated });
    session.db.updateTranscriptEntry(entryId, markProvided);
    await this.tm.boxHandoff.resumeWithHiddenPrompt(
      session.id,
      buildSecretProvidedAck(request),
      "Agent failed to resume after secret submission",
    );
  }

  routeSecret(agentId: string, target: any, value: string): boolean {
    if (target.kind !== "channel-credential") return false;
    const stored = this.tm.sessionStore.storeConnectorCredential(
      agentId,
      target.platform,
      target.field,
      value,
    );
    if (stored) this.tm.channelConfigChanged?.();
    return stored;
  }

  recordWidgetResponse(entryId: string, value: string): boolean {
    const transcript = getTranscript();
    const existing = transcript.find((entry) => entry.id === entryId);
    if (
      existing == null ||
      existing.kind !== "send-message" ||
      (existing.message as any)?.type !== "widget" ||
      existing.respondedValue != null ||
      existing.widgetDismissed === true
    )
      return false;

    if ((existing.message as any).widget.dismissOnMoveOn === true) {
      const hasLaterUserMoment = (
        scope: readonly TranscriptEntry[],
      ): boolean => {
        const index = scope.findIndex((entry) => entry.id === entryId);
        return (
          index >= 0 &&
          scope
            .slice(index + 1)
            .some(
              (entry) =>
                (isUserMessageEntry(entry) &&
                  !isAgentPeerMessageEntry(entry)) ||
                (entry.kind === "send-message" &&
                  (entry.message as any)?.type === "widget" &&
                  (entry.respondedValue != null ||
                    entry.widgetDismissed === true)),
            )
        );
      };
      const surfaces: Array<readonly TranscriptEntry[]> = [];
      const main = getMainTranscriptEntries(
        transcript,
      ) as readonly TranscriptEntry[];
      if (main.some((entry) => entry.id === entryId)) surfaces.push(main);
      const thread = getThreadTranscriptEntries(
        transcript,
        entryId,
      ) as readonly TranscriptEntry[];
      if (thread.length > 1) surfaces.push(thread);
      if (surfaces.length > 0 && surfaces.every(hasLaterUserMoment))
        return false;
    }

    let didStamp = false;
    const withResponse = (entry: TranscriptEntry): TranscriptEntry => {
      if (
        entry.kind !== "send-message" ||
        entry.respondedValue != null ||
        entry.widgetDismissed === true
      )
        return entry;
      didStamp = true;
      return { ...entry, respondedValue: value };
    };
    const updated = updateEntry(entryId, withResponse);
    if (didStamp && updated != null) {
      this.tm.roster.emit({ type: "updated", entry: updated });
      this.tm.sessions.activeSession?.db.updateTranscriptEntry(
        entryId,
        withResponse,
      );
    }
    return didStamp;
  }

  rollbackWidgetResponse(entryId: string): TranscriptEntry | null {
    const withoutResponse = (entry: TranscriptEntry): TranscriptEntry => {
      if (entry.kind !== "send-message") return entry;
      const { respondedValue: _value, ...rest } = entry;
      return rest as TranscriptEntry;
    };
    const updated = updateEntry(entryId, withoutResponse);
    if (updated != null)
      this.tm.roster.emit({ type: "updated", entry: updated });
    this.tm.sessions.activeSession?.db.updateTranscriptEntry(
      entryId,
      withoutResponse,
    );
    return updated;
  }

  async reactToMessage(
    entryId: string,
    emoji: string,
    agentId: string,
  ): Promise<void> {
    const trimmed = emoji.trim();
    if (trimmed.length === 0) return;
    await this.tm.sessions.ensureActionTarget(agentId);
    const result = this.applyReaction({
      session: this.tm.sessions.activeSession ?? null,
      entryId,
      emoji: trimmed,
      by: SAND_REACTION_SELF,
    });
    const activeAgentId = this.tm.sessions.activeSession?.id;
    if (
      result?.isAdding &&
      activeAgentId != null &&
      !isUserMessageEntry(result.before)
    ) {
      void this.resumeAfterReaction(
        activeAgentId,
        trimmed,
        describeReactedMessageQuote(result.before),
      );
    }
  }

  applyReaction(args: {
    session?: LiveSession | null;
    entryId: string;
    emoji: string;
    by: string;
  }): { before: TranscriptEntry; isAdding: boolean } | null {
    const isActive =
      args.session == null ||
      args.session.id === this.tm.sessions.activeSession?.id;
    const entries = isActive
      ? getTranscript()
      : args.session.db.getTranscriptEntries();
    const before = entries.find(
      (entry: TranscriptEntry) => entry.id === args.entryId,
    );
    if (before == null) return null;
    const isAdding = !((before.reactions as any[]) ?? []).some(
      (reaction) => reaction.emoji === args.emoji && reaction.by === args.by,
    );
    const withToggle = (entry: TranscriptEntry): TranscriptEntry => {
      const next = toggleReaction(entry.reactions as any, args.emoji, args.by);
      const { reactions: _omit, ...rest } = entry;
      return next == null
        ? (rest as TranscriptEntry)
        : { ...rest, reactions: next };
    };
    if (isActive) {
      const updated = updateEntry(args.entryId, withToggle);
      if (updated == null) return null;
      this.tm.roster.emit({ type: "updated", entry: updated });
      this.tm.sessions.activeSession?.db.updateTranscriptEntry(
        args.entryId,
        withToggle,
      );
    } else {
      args.session.db.updateTranscriptEntry(args.entryId, withToggle);
      void this.tm.roster.emitAgentUpdate(args.session.id);
    }
    return { before, isAdding };
  }

  async resumeAfterReaction(
    agentId: string,
    emoji: string,
    messageQuote: string,
  ): Promise<void> {
    await this.tm.boxHandoff.resumeWithHiddenPrompt(
      agentId,
      `[The user reacted ${emoji} to your message: "${messageQuote}". You don't need to reply; act on it only if it's useful (e.g. acknowledge, adjust, or continue).]`,
      "Agent failed to resume after reaction",
    );
  }

  private liveSessionFor(agentId: string): LiveSession | null {
    return this.tm.sessions.activeSession?.id === agentId
      ? this.tm.sessions.activeSession
      : (this.tm.sessions.liveSessions.get(agentId) ?? null);
  }
}
