import {
  countToolCallsSinceLastSendMessage,
  isInjectedReminderMessage,
  type MessageLike,
  type PromptExecutor,
} from "./send-message-reminder-middleware.js";
import { SAND_SEND_MESSAGE_TOOL_NAME } from "./tools/send-message-tool.js";

export const DEFAULT_START_OF_TURN_ACK_THRESHOLD = 1;
export const START_OF_TURN_ACK_REMINDER_MESSAGE = `<system_reminder>
You opened this turn by calling tools without first acknowledging the user, so they are watching silence and may think the app froze. Acknowledge them RIGHT NOW by actually invoking the SendMessage tool \u2014 make a real tool/function call, not text you write. Plain assistant text is NEVER shown to the user; only a real SendMessage tool invocation reaches them, so if you don't call the tool they just keep seeing silence. Make that first SendMessage a one-line text acknowledgement, before any further tool call, then continue the work. A widget, attachment, or cursor-agent card does not count as this acknowledgement.
</system_reminder>`;

export function buildReminderMessage(content: string): MessageLike {
  return {
    role: "user",
    content,
    providerOptions: { cursor: { sandStartOfTurnAckReminder: true } },
  };
}

export function isStartOfTurnAckReminderMessage(message: MessageLike): boolean {
  return message.providerOptions?.cursor?.sandStartOfTurnAckReminder === true;
}

export function isTextSendMessageArgs(args: unknown): boolean {
  return typeof args === "object"
    && args != null
    && "type" in args
    && args.type === "text";
}

export function hasTextSendMessageCall(message: MessageLike): boolean {
  if (message.role !== "assistant" || typeof message.content === "string") return false;
  return message.content.some((part) => {
    const candidate = part as typeof part & { readonly args?: unknown };
    return candidate.type === "tool-call"
      && candidate.toolName === SAND_SEND_MESSAGE_TOOL_NAME
      && isTextSendMessageArgs(candidate.args);
  });
}

export function hasTextSendMessageSinceTurnStart(messages: readonly MessageLike[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message == null || isInjectedReminderMessage(message)) continue;
    if (message.role === "user" || message.role === "system") return false;
    if (hasTextSendMessageCall(message)) return true;
  }
  return false;
}

export class StartOfTurnAckReminderMiddleware implements PromptExecutor {
  constructor(
    readonly innerExecutor: PromptExecutor,
    readonly threshold: number,
    readonly message: MessageLike,
  ) {}

  getMessages(): readonly MessageLike[] {
    return this.innerExecutor.getMessages();
  }

  getState(): readonly MessageLike[] {
    return this.innerExecutor.getState();
  }

  clearMessages(): void {
    this.innerExecutor.clearMessages();
  }

  appendMessages(messages: MessageLike | readonly MessageLike[]): void {
    this.innerExecutor.appendMessages(messages);
  }

  stream(...args: any[]): unknown {
    const messages = this.innerExecutor.getMessages();
    const lastMessage = messages.at(-1);
    if (
      lastMessage != null
      && !isStartOfTurnAckReminderMessage(lastMessage)
      && !hasTextSendMessageSinceTurnStart(messages)
      && countToolCallsSinceLastSendMessage(messages) > this.threshold
    ) {
      this.innerExecutor.appendMessages(this.message);
    }
    return this.innerExecutor.stream(...args);
  }
}

export function createStartOfTurnAckReminderMiddleware(options: {
  readonly threshold?: number;
  readonly message?: string;
} = {}) {
  const threshold = options.threshold ?? DEFAULT_START_OF_TURN_ACK_THRESHOLD;
  const message = buildReminderMessage(options.message ?? START_OF_TURN_ACK_REMINDER_MESSAGE);
  return (executor: PromptExecutor) =>
    new StartOfTurnAckReminderMiddleware(executor, threshold, message);
}
