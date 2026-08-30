import {
  stripReplyTo,
  withReplyTo,
  type SendMessage,
} from "./send-message-shaping.js";
import type { TranscriptEntry } from "./transcript-hub.js";
export function resolveSendReplyThreading(
  tm: {
    turnRuntime: {
      resolveReplyTarget(
        entries: readonly TranscriptEntry[],
        id: string,
      ): string | undefined;
      buildReplyContext(
        entries: readonly TranscriptEntry[],
        id?: string,
      ): unknown;
    };
  },
  replyToIdOption: string | undefined,
  isForkOption: boolean,
  readAddressedTranscript: () => readonly TranscriptEntry[],
): { replyToId?: string; replyContext: unknown; isFork: boolean } {
  const entries = replyToIdOption ? readAddressedTranscript() : [],
    replyToId = replyToIdOption
      ? tm.turnRuntime.resolveReplyTarget(entries, replyToIdOption)
      : undefined,
    replyContext = tm.turnRuntime.buildReplyContext(entries, replyToId);
  return {
    ...(replyToId == null ? {} : { replyToId }),
    replyContext,
    isFork: isForkOption && replyToId != null,
  };
}
export function validateAiReplyTarget<T extends SendMessage>(
  message: T,
  inFlightId: string | undefined,
  entries: readonly TranscriptEntry[],
): T {
  const target = message.reply_to;
  return target == null || target.length === 0
    ? message
    : target === inFlightId || !entries.some((entry) => entry.id === target)
      ? stripReplyTo(message)
      : message;
}
export function applyAutoReplyThread<T extends SendMessage>(
  tm: { turnRuntime: { replyThreadTargets: ReadonlyMap<object, string> } },
  message: T,
  session: object | null,
  entries: readonly TranscriptEntry[],
): T {
  if (message.reply_to || session == null) return message;
  const target = tm.turnRuntime.replyThreadTargets.get(session);
  return target != null && entries.some((entry) => entry.id === target)
    ? withReplyTo(message, target)
    : message;
}
