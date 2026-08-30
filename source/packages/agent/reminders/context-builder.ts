interface ToolResultContentPart {
  readonly toolName?: string;
  readonly isError?: boolean;
  readonly result?: unknown;
}

interface ReminderMessage {
  readonly role: string;
  readonly content?: unknown;
}

export interface ReminderContext<TTodo = unknown> {
  readonly toolCallCount: number;
  readonly toolTypeCounters: Map<string, number>;
  readonly consecutiveFailures: Map<string, number>;
  readonly currentToolName: string | undefined;
  readonly currentToolError: Error | undefined;
  readonly currentToolSuccess: boolean | undefined;
  readonly todos: readonly TTodo[];
  readonly conversationMessages: readonly ReminderMessage[];
  readonly responseMessages: readonly ReminderMessage[];
}

export function buildReminderContext<TTodo = unknown>(
  messages: readonly ReminderMessage[],
  todos: readonly TTodo[],
  responseMessages: readonly ReminderMessage[] = [],
): ReminderContext<TTodo> {
  let toolCallCount = 0;
  const toolTypeCounters = new Map<string, number>();
  const consecutiveFailures = new Map<string, number>();
  let currentToolName: string | undefined;
  let currentToolError: Error | undefined;
  let currentToolSuccess: boolean | undefined;
  for (const message of messages) {
    if (message.role === "tool" && Array.isArray(message.content)) {
      for (const toolResult of message.content as ToolResultContentPart[]) {
        const toolName = toolResult.toolName ?? "unknown";
        const success = !toolResult.isError;
        toolCallCount++;
        const count = toolTypeCounters.get(toolName) ?? 0;
        toolTypeCounters.set(toolName, count + 1);
        if (success) {
          consecutiveFailures.set(toolName, 0);
        } else {
          const failures = consecutiveFailures.get(toolName) ?? 0;
          consecutiveFailures.set(toolName, failures + 1);
        }
        currentToolName = toolName;
        currentToolSuccess = success;
        currentToolError = toolResult.isError
          ? new Error(String(toolResult.result))
          : undefined;
      }
    }
  }
  return {
    toolCallCount,
    toolTypeCounters,
    consecutiveFailures,
    currentToolName,
    currentToolError,
    currentToolSuccess,
    todos,
    conversationMessages: messages,
    responseMessages,
  };
}
