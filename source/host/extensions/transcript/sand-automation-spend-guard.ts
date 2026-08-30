import { formatTimestamp } from "../../../shared/automation-schedule.js";
export const SPEND_GUARD_IDLE_TTL_MS = 3 * 24 * 60 * 60_000;
export const SPEND_GUARD_MIN_UNREAD_COUNT = 15;
export const SPEND_GUARD_MIN_FIRES_SINCE_VIEWED = 20;
export const SPEND_GUARD_PAUSE_DELAY_MS = 3 * 24 * 60 * 60_000;
export const SPEND_GUARD_SNOOZE_MS = 30 * 24 * 60 * 60_000;
export const SPEND_GUARD_VALUE_PREFIX = "spend-guard:";
export const SPEND_GUARD_ANSWER_VALUES = {
  keep: `${SPEND_GUARD_VALUE_PREFIX}keep`,
  pause: `${SPEND_GUARD_VALUE_PREFIX}pause`,
  optOut: `${SPEND_GUARD_VALUE_PREFIX}never-ask`,
  resume: `${SPEND_GUARD_VALUE_PREFIX}resume`,
  stayPaused: `${SPEND_GUARD_VALUE_PREFIX}stay-paused`,
} as const;
export type SpendGuardAnswer = keyof typeof SPEND_GUARD_ANSWER_VALUES;
export function interpretSpendGuardAnswer(
  value: string,
): SpendGuardAnswer | null {
  for (const [answer, sentinel] of Object.entries(SPEND_GUARD_ANSWER_VALUES))
    if (value === sentinel) return answer as SpendGuardAnswer;
  return null;
}
export interface SpendGuardEvaluation {
  nowMs: number;
  lastViewedAtMs: number;
  unreadCount: number;
  firesSinceViewedCount: number;
  nudgedAtMs: number | null;
  snoozedUntilMs: number | null;
  optedOut: boolean;
}
export function evaluateAutomationSpendGuard(
  input: SpendGuardEvaluation,
):
  | "opted-out"
  | "user-active"
  | "snoozed"
  | "pause"
  | "awaiting-ack"
  | "nudge"
  | "below-thresholds" {
  if (input.optedOut) return "opted-out";
  if (input.nowMs - input.lastViewedAtMs < SPEND_GUARD_IDLE_TTL_MS)
    return "user-active";
  if (input.snoozedUntilMs != null && input.nowMs < input.snoozedUntilMs)
    return "snoozed";
  if (input.nudgedAtMs != null && input.nudgedAtMs > input.lastViewedAtMs)
    return input.nowMs - input.nudgedAtMs >= SPEND_GUARD_PAUSE_DELAY_MS
      ? "pause"
      : "awaiting-ack";
  if (
    input.unreadCount >= SPEND_GUARD_MIN_UNREAD_COUNT ||
    input.firesSinceViewedCount >= SPEND_GUARD_MIN_FIRES_SINCE_VIEWED
  )
    return "nudge";
  return "below-thresholds";
}
export function countAutomationRunsSince(
  automations: readonly { runs: readonly { startedAt: number }[] }[],
  sinceMs: number,
): number {
  let count = 0;
  for (const automation of automations)
    for (const run of automation.runs) if (run.startedAt > sinceMs) count++;
  return count;
}
export interface SpendGuardWidget {
  prompt: string;
  options: Array<{ label: string; value: string; style?: string }>;
}
export function buildSpendGuardNudgeWidget(): SpendGuardWidget {
  return {
    prompt: "You've been away for a bit — keep my routines running?",
    options: [
      {
        label: "Keep them running",
        value: SPEND_GUARD_ANSWER_VALUES.keep,
        style: "primary",
      },
      { label: "Pause them all", value: SPEND_GUARD_ANSWER_VALUES.pause },
      {
        label: "Keep running, don't ask again",
        value: SPEND_GUARD_ANSWER_VALUES.optOut,
      },
    ],
  };
}
export function buildSpendGuardPausedWidget(): SpendGuardWidget {
  return {
    prompt:
      "I paused all your routines while you were away to avoid wasted spend. Want me to start them back up?",
    options: [
      {
        label: "Resume routines",
        value: SPEND_GUARD_ANSWER_VALUES.resume,
        style: "primary",
      },
      {
        label: "Keep them paused",
        value: SPEND_GUARD_ANSWER_VALUES.stayPaused,
      },
    ],
  };
}
export const SPEND_GUARD_ANSWER_ACKS: Record<SpendGuardAnswer, string> = {
  keep: "keep your routines running, and not to be asked again for a month",
  resume: "start the paused routines back up",
  optOut: "keep your routines running and never be asked about this again",
  pause: "pause every one of your routines",
  stayPaused: "leave your routines paused",
};
export function renderSpendGuardAnswerAck(answer: SpendGuardAnswer): string {
  return [
    "<system_reminder>",
    `The app asked the user about the money your routines spend while they are away. They chose to ${SPEND_GUARD_ANSWER_ACKS[answer]}, and the app has ALREADY applied that itself.`,
    "Acknowledge their choice in one short line. Do NOT edit any automation.json and do NOT ask again.",
    "</system_reminder>",
  ].join("\n");
}
export function isSpendGuardCard(
  widget: SpendGuardWidget,
  value: string,
): boolean {
  return (
    [
      buildSpendGuardNudgeWidget().prompt,
      buildSpendGuardPausedWidget().prompt,
    ].includes(widget.prompt) &&
    widget.options.some((option) => option.value === value)
  );
}
export function renderSpendGuardNudgeReminder(
  input: Pick<
    SpendGuardEvaluation,
    "nowMs" | "lastViewedAtMs" | "unreadCount" | "firesSinceViewedCount"
  > & { timeZone?: string },
): string {
  const away =
      input.lastViewedAtMs > 0
        ? `hasn't opened this chat since ${formatTimestamp(input.lastViewedAtMs, input.timeZone)}`
        : "has never opened this chat",
    deadline = formatTimestamp(
      input.nowMs + SPEND_GUARD_PAUSE_DELAY_MS,
      input.timeZone,
    );
  return [
    "<system_reminder>",
    `The user ${away} — ${input.unreadCount} of your messages are unread and your routines have run ${input.firesSinceViewedCount} times since then. They may be spending money on work nobody is reading.`,
    "The app has already asked them directly whether to keep your routines running, and applies their answer itself. Do NOT ask again yourself and do NOT edit any automation.json; just acknowledge their choice if it comes back as their reply.",
    `If they neither answer nor return by ${deadline}, the app will pause ALL of this agent's routines and tell them so.`,
    "</system_reminder>",
  ].join("\n");
}
