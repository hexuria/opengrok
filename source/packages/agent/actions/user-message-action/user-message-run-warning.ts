import type { Context } from "../../../context/core.js";
import { createLogger } from "../../../context/logger.js";
import { isSyntheticUserMessage } from "./synthetic-user-message.js";

interface CursorProviderOptions {
  readonly isSummary?: boolean;
  readonly messageId?: string;
  readonly requestId?: string;
}

interface Message {
  readonly role: string;
  readonly content?: unknown;
  readonly providerOptions?: { readonly cursor?: CursorProviderOptions };
}

const logger = createLogger("@anysphere/agent");
const CONSECUTIVE_USER_MESSAGE_WARNING_THRESHOLD = 3;
const TAIL_INSPECTION_WINDOW = 12;

function extractCursorProviderOptions(message: Message): CursorProviderOptions | undefined {
  const providerOptions = message.providerOptions;
  return providerOptions?.cursor;
}

export function warnIfLongTrailingUserMessageRun(
  ctx: Context,
  messages: readonly Message[],
  invocationId: string,
): void {
  const lastMessage = messages[messages.length - 1];
  if (lastMessage?.role !== "user") {
    return;
  }
  let trailingConsecutiveUserMessages = 0;
  for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
    const message = messages[idx]!;
    if (message.role !== "user") {
      break;
    }
    if (isSyntheticUserMessage(message)) {
      continue;
    }
    trailingConsecutiveUserMessages += 1;
  }
  if (trailingConsecutiveUserMessages <= CONSECUTIVE_USER_MESSAGE_WARNING_THRESHOLD) {
    return;
  }
  let distanceToLastAssistant = -1;
  for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
    if (messages[idx]!.role === "assistant") {
      distanceToLastAssistant = messages.length - 1 - idx;
      break;
    }
  }
  const tailMessages = messages.slice(-TAIL_INSPECTION_WINDOW);
  const tailRoles = tailMessages.map(message => message.role);
  const tailCursorMessageIds: string[] = [];
  const tailCursorRequestIds: string[] = [];
  for (const message of tailMessages) {
    const cursor = extractCursorProviderOptions(message);
    if (cursor?.messageId !== undefined) {
      tailCursorMessageIds.push(cursor.messageId);
    }
    if (cursor?.requestId !== undefined) {
      tailCursorRequestIds.push(cursor.requestId);
    }
  }
  const tailDistinctCursorMessageIdCount = new Set(tailCursorMessageIds).size;
  const tailDistinctCursorRequestIdCount = new Set(tailCursorRequestIds).size;
  logger.warn(ctx, "Turn contains unusually long trailing run of consecutive user messages", {
    trailingConsecutiveUserMessages,
    threshold: CONSECUTIVE_USER_MESSAGE_WARNING_THRESHOLD,
    totalMessages: messages.length,
    invocationId,
    distanceToLastAssistant,
    tailInspectionWindow: TAIL_INSPECTION_WINDOW,
    tailRoles,
    tailCursorMessageIdCount: tailCursorMessageIds.length,
    tailDistinctCursorMessageIdCount,
    hasDuplicateTailCursorMessageIds:
      tailDistinctCursorMessageIdCount < tailCursorMessageIds.length,
    tailCursorRequestIdCount: tailCursorRequestIds.length,
    tailDistinctCursorRequestIdCount,
    hasDuplicateTailCursorRequestIds:
      tailDistinctCursorRequestIdCount < tailCursorRequestIds.length,
  });
}
