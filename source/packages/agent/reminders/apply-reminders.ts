import {
  buildReminderContext,
  type ReminderContext,
} from "./context-builder.js";

interface MutableToolResultContentPart {
  readonly type?: string;
  readonly experimental_content?: Array<{ type: string; text: string }>;
}

interface MutableReminderMessage {
  readonly role: string;
  readonly content?: MutableToolResultContentPart[] | unknown;
}

interface Reminder<TTodo> {
  shouldTrigger(context: ReminderContext<TTodo>): boolean;
  generate(context: ReminderContext<TTodo>): string | undefined;
}

export async function applyRemindersToToolResults<TTodo = unknown>(
  responseMessages: MutableReminderMessage[],
  reminders: readonly Reminder<TTodo>[],
  currentTodos: readonly TTodo[],
  conversationMessages: readonly MutableReminderMessage[],
): Promise<void> {
  if (reminders.length === 0) {
    return;
  }
  const context = buildReminderContext(
    conversationMessages,
    currentTodos,
    responseMessages,
  );
  const triggeredReminders: string[] = [];
  for (const reminder of reminders) {
    if (reminder.shouldTrigger(context)) {
      const text = reminder.generate(context);
      if (text && text.length > 0) {
        triggeredReminders.push(text);
      }
    }
  }
  if (triggeredReminders.length > 0) {
    const combinedReminderText = triggeredReminders.join("\n\n");
    const toolMessages = responseMessages.filter(
      message => message.role === "tool" && Array.isArray(message.content),
    );
    if (toolMessages.length > 0) {
      const lastToolMessage = toolMessages[toolMessages.length - 1];
      if (lastToolMessage && Array.isArray(lastToolMessage.content)) {
        const lastToolResult = lastToolMessage.content[lastToolMessage.content.length - 1];
        if (lastToolResult && lastToolResult.type === "tool-result") {
          if (Array.isArray(lastToolResult.experimental_content)) {
            lastToolResult.experimental_content.push({
              type: "text",
              text: combinedReminderText,
            });
          }
        }
      }
    }
  }
}
