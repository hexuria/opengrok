import {
  SPEND_GUARD_SNOOZE_MS,
  buildSpendGuardNudgeWidget,
  buildSpendGuardPausedWidget,
  countAutomationRunsSince,
  evaluateAutomationSpendGuard,
  interpretSpendGuardAnswer,
  isSpendGuardCard,
  renderSpendGuardAnswerAck,
  renderSpendGuardNudgeReminder,
  type SpendGuardAnswer,
  type SpendGuardWidget,
} from "./sand-automation-spend-guard.js";
import { nextEntryId } from "./transcript-entry-ids.js";
import { getTranscript } from "./transcript-store.js";
import type {
  TranscriptEntry,
  TranscriptManagerLike,
} from "./transcript-hub.js";

export const SPEND_GUARD_ANSWER_OUTCOMES = {
  keep: { routines: "resume-guard-paused", snoozes: true, retiresGuard: false },
  resume: {
    routines: "resume-guard-paused",
    snoozes: true,
    retiresGuard: false,
  },
  optOut: {
    routines: "resume-guard-paused",
    snoozes: false,
    retiresGuard: true,
  },
  pause: {
    routines: "disable-every-enabled",
    snoozes: false,
    retiresGuard: false,
  },
  stayPaused: { routines: "leave-as-is", snoozes: false, retiresGuard: false },
} as const;
export const CLEARED_GUARD_STATE = {
  nudgedAtMs: null,
  snoozedUntilMs: null,
  optedOut: false,
  cardEntryIds: [] as string[],
  pausedAutomationIds: [] as string[],
};

interface GuardState {
  nudgedAtMs: number | null;
  snoozedUntilMs: number | null;
  optedOut: boolean;
  cardEntryIds: string[];
  pausedAutomationIds: string[];
}
interface GuardSession {
  id: string;
  automations: any;
  db: any;
}

export function disableEveryEnabledRoutine(session: GuardSession): string[] {
  const disabled: string[] = [];
  for (const automation of session.automations.listDefinitions()) {
    if (automation.isEnabled) {
      session.automations.setEnabled(automation.id, false);
      disabled.push(automation.id);
    }
  }
  return disabled;
}
export function reEnableGuardPausedRoutines(
  session: GuardSession,
  ids: readonly string[],
): void {
  const resume = new Set(ids);
  for (const automation of session.automations.listDefinitions()) {
    if (resume.has(automation.id) && !automation.isEnabled)
      session.automations.setEnabled(automation.id, true);
  }
}

export class AutomationSpendGuardRuntime {
  constructor(
    readonly tm: TranscriptManagerLike,
    readonly host: any,
  ) {}

  async apply(
    session: GuardSession,
    firing: { id: string },
  ): Promise<{ paused: boolean; reminder?: string }> {
    const nowMs = Date.now();
    const isFiringOff = () =>
      session.automations.get(firing.id)?.isEnabled !== true;
    const evaluated = this.evaluate(session, nowMs);
    switch (evaluated.decision) {
      case "user-active":
      case "opted-out":
      case "snoozed":
      case "below-thresholds":
        return { paused: isFiringOff() };
      case "awaiting-ack":
        this.issueCardIfNone(session);
        return { paused: isFiringOff() };
      case "nudge":
        session.db.setAutomationSpendGuardState({
          ...CLEARED_GUARD_STATE,
          nudgedAtMs: nowMs,
          cardEntryIds: [
            this.issueGuardCard(session, buildSpendGuardNudgeWidget()),
          ],
        });
        return {
          paused: isFiringOff(),
          reminder: renderSpendGuardNudgeReminder({
            nowMs,
            lastViewedAtMs: evaluated.lastViewedAtMs,
            unreadCount: evaluated.unreadCount,
            firesSinceViewedCount: evaluated.firesSinceViewedCount,
            timeZone: this.tm.sessionStore.getUserTimeZone(),
          }),
        };
      case "pause":
        return {
          paused: (await this.pauseForAwayUser(session)) || isFiringOff(),
        };
    }
  }

  evaluate(session: GuardSession, nowMs: number) {
    const unread = session.db.getUnreadState();
    const state = session.db.getAutomationSpendGuardState() as GuardState;
    const firesSinceViewedCount = countAutomationRunsSince(
      session.automations.listDefinitions(),
      unread.lastViewedAt,
    );
    return {
      decision: evaluateAutomationSpendGuard({
        nowMs,
        lastViewedAtMs: unread.lastViewedAt,
        unreadCount: unread.unreadCount,
        firesSinceViewedCount,
        nudgedAtMs: state.nudgedAtMs,
        snoozedUntilMs: state.snoozedUntilMs,
        optedOut: state.optedOut,
      }),
      lastViewedAtMs: unread.lastViewedAt,
      unreadCount: unread.unreadCount,
      firesSinceViewedCount,
    };
  }

  async pauseForAwayUser(session: GuardSession): Promise<boolean> {
    let guardPausedIds: string[] = [];
    await this.runGuardTransition(session, (current) => {
      if (this.evaluate(session, Date.now()).decision !== "pause") return;
      guardPausedIds = disableEveryEnabledRoutine(session);
      if (guardPausedIds.length === 0) return;
      const isPauseAlreadyOpen = current.pausedAutomationIds.length > 0;
      session.db.setAutomationSpendGuardState({
        ...CLEARED_GUARD_STATE,
        nudgedAtMs: current.nudgedAtMs,
        pausedAutomationIds: [
          ...new Set([...current.pausedAutomationIds, ...guardPausedIds]),
        ],
        cardEntryIds: isPauseAlreadyOpen
          ? current.cardEntryIds
          : [
              ...current.cardEntryIds,
              this.issueGuardCard(session, buildSpendGuardPausedWidget()),
            ],
      });
    });
    if (guardPausedIds.length === 0) return false;
    this.tm.automationConfigChanged?.();
    this.host.emitAutomations(session);
    this.tm.trayErrors.pushError({
      agentId: session.id,
      title: "Routines paused while you were away",
      detail:
        "This agent's routines kept running without anyone reading the results, so they were paused to avoid wasted spend. Re-enable them from the routine panel when you're back.",
      dedupeKey: `spend-guard-paused:${session.id}`,
    });
    return true;
  }

  async handleWidgetAnswer(args: {
    agentId: string;
    entryId: string;
    value: string;
    onApplied?(ack: string): void;
  }): Promise<string | null> {
    const answer = interpretSpendGuardAnswer(args.value);
    if (answer == null || this.tm.sessions.isAgentGone(args.agentId))
      return null;
    const session = (await this.tm.sessions.resolveBackgroundSession(
      args.agentId,
    )) as GuardSession;
    const nowMs = Date.now();
    let applied = false;
    await this.runGuardTransition(session, (current) => {
      if (
        !current.cardEntryIds.includes(args.entryId) ||
        !this.isHostIssuedCard(session, args.entryId, args.value)
      )
        return;
      const outcome = SPEND_GUARD_ANSWER_OUTCOMES[answer];
      let guardPausedIds: string[] = [];
      if (outcome.routines === "resume-guard-paused")
        reEnableGuardPausedRoutines(session, current.pausedAutomationIds);
      else if (outcome.routines === "disable-every-enabled")
        guardPausedIds = [
          ...new Set([
            ...current.pausedAutomationIds,
            ...disableEveryEnabledRoutine(session),
          ]),
        ];
      session.db.setAutomationSpendGuardState({
        ...CLEARED_GUARD_STATE,
        snoozedUntilMs: outcome.snoozes ? nowMs + SPEND_GUARD_SNOOZE_MS : null,
        optedOut: outcome.retiresGuard,
        pausedAutomationIds: guardPausedIds,
        cardEntryIds: guardPausedIds.length > 0 ? current.cardEntryIds : [],
      });
      applied = true;
    });
    if (!applied) return null;
    const ack = renderSpendGuardAnswerAck(answer as SpendGuardAnswer);
    args.onApplied?.(ack);
    this.tm.automationConfigChanged?.();
    this.host.emitAutomations(session);
    return ack;
  }

  issueCardIfNone(session: GuardSession): void {
    const current = session.db.getAutomationSpendGuardState() as GuardState;
    if (current.cardEntryIds.length > 0) return;
    session.db.setAutomationSpendGuardState({
      ...current,
      cardEntryIds: [
        this.issueGuardCard(session, buildSpendGuardNudgeWidget()),
      ],
    });
  }
  isHostIssuedCard(
    session: GuardSession,
    entryId: string,
    value: string,
  ): boolean {
    const entry = this.readEntries(session).find(
      (item) => item.id === entryId,
    ) as any;
    return (
      entry?.kind === "send-message" &&
      entry.message?.type === "widget" &&
      isSpendGuardCard(entry.message.widget as SpendGuardWidget, value)
    );
  }
  readEntries(session: GuardSession): TranscriptEntry[] {
    return this.tm.sessions.activeSession?.id === session.id
      ? getTranscript()
      : session.db.getTranscriptEntries();
  }
  issueGuardCard(session: GuardSession, widget: SpendGuardWidget): string {
    const isActive = this.tm.sessions.activeSession?.id === session.id;
    const entry: TranscriptEntry = {
      kind: "send-message",
      id: nextEntryId(
        this.readEntries(session),
        "send-message",
        session.db.getRetiredEntryIds(),
      ),
      message: { type: "widget", widget },
      timestampMs: Date.now(),
    };
    if (isActive) this.tm.appendEntry(entry);
    else {
      session.db.appendTranscriptEntry(entry);
      this.tm.sessionStore.markSessionActivity(session);
      void this.tm.roster.emitAgentUpdate(session.id);
    }
    return entry.id;
  }
  runGuardTransition(
    session: GuardSession,
    transition: (current: GuardState) => void,
  ): Promise<unknown> {
    return this.host.enqueueAutomationLifecycleMutation({
      agentId: session.id,
      mutation: () => {
        const before = session.automations.listDefinitions();
        const isActive = this.tm.sessions.activeSession?.id === session.id;
        this.recordPendingAgentEdits(session, isActive, before);
        transition(session.db.getAutomationSpendGuardState());
        this.recordGuardDelta(session, isActive, before);
      },
    });
  }
  recordPendingAgentEdits(
    session: GuardSession,
    isActive: boolean,
    before: unknown,
  ): void {
    if (isActive) this.host.recordAutomationChangeEvents(session, "agent");
    else
      this.host.recordInactiveAutomationChanges({
        agentId: session.id,
        before,
        after: before,
        source: "agent",
      });
  }
  recordGuardDelta(
    session: GuardSession,
    isActive: boolean,
    before: unknown,
  ): void {
    if (isActive)
      this.host.recordAutomationChangeEvents(session, "spend_guard");
    else
      this.host.recordInactiveAutomationChanges({
        agentId: session.id,
        before,
        after: session.automations.listDefinitions(),
        source: "spend_guard",
      });
  }
}
