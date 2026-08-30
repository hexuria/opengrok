import {
  SAND_HIDDEN_PROMPT_MARKER,
  SAND_TRUSTED_AUTOMATION_PROMPT_MARKER,
} from "./sand-prompt-markers.js";

export const SEND_MESSAGE_TOOL_CALL_OUTLINE_NAME = "sendMessageToolCall";
export const MCP_TOOL_CALL_OUTLINE_NAME = "mcpToolCall";
export const MAX_TOOL_ACTIVITY_ARGS_CHARS = 20_000;

export type OutlineMessage =
  | { readonly type: "text"; readonly content: string }
  | { readonly type: "attachment"; readonly url: string; readonly alt?: string };

export type OutlineItem =
  | { readonly kind: "user"; readonly id: string; readonly text: string; readonly hidden?: true }
  | { readonly kind: "assistant-text"; readonly id: string; readonly text: string }
  | { readonly kind: "thinking"; readonly id: string; readonly text: string; readonly durationMs: number | undefined }
  | { readonly kind: "send-message"; readonly id: string; readonly message: OutlineMessage }
  | {
    readonly kind: "tool-call";
    readonly id: string;
    readonly name: string;
    readonly status: "pending" | "failed" | "done";
    readonly summary: string | undefined;
  };

interface JsonArguments {
  toJson(): unknown;
}

interface TaskToolCall {
  readonly args?: { readonly description?: string; readonly prompt?: string };
  readonly result?: {
    readonly result: { readonly case?: string; readonly value?: unknown };
  };
}

interface ComputerAction {
  readonly action: { readonly case?: string };
}

interface ComputerUseToolCall {
  readonly args?: { readonly actions?: readonly ComputerAction[] };
}

interface SendMessageToolCall {
  readonly args?: {
    readonly message?: {
      readonly case?: string;
      readonly value?: unknown;
    };
  };
}

export interface OutlineToolCall {
  readonly tool: {
    readonly case?: string;
    readonly value?: TaskToolCall | ComputerUseToolCall | SendMessageToolCall | {
      readonly args?: JsonArguments;
    };
  };
}

export type OutlineStep = {
  readonly message:
    | { readonly case: "assistantMessage"; readonly value: { readonly text: string } }
    | { readonly case: "thinkingMessage"; readonly value: { readonly text: string; readonly durationMs: number } }
    | { readonly case: "toolCall"; readonly value: OutlineToolCall };
};

export interface ConversationState {
  readonly turns: readonly {
    readonly turn:
      | {
        readonly case: "agentConversationTurn";
        readonly value: {
          readonly userMessage?: { readonly text?: string; readonly messageId?: string };
          readonly steps: readonly OutlineStep[];
        };
      }
      | {
        readonly case: "shellConversationTurn";
        readonly value: { readonly shellCommand?: { readonly command?: string } };
      };
  }[];
}

export interface OutlineTurn {
  readonly rawUserText: string;
  readonly userMessageId: string;
  readonly items: readonly OutlineItem[];
}

export function stripHiddenMarker(text: string): string {
  const withoutHidden = text.startsWith(SAND_HIDDEN_PROMPT_MARKER)
    ? text.slice(SAND_HIDDEN_PROMPT_MARKER.length)
    : text;
  return withoutHidden.startsWith(SAND_TRUSTED_AUTOMATION_PROMPT_MARKER)
    ? withoutHidden.slice(SAND_TRUSTED_AUTOMATION_PROMPT_MARKER.length)
    : withoutHidden;
}

export function getOutlineToolCallName(toolCall: OutlineToolCall): string {
  if (toolCall.tool.case === "taskToolCall") return "Task";
  if (toolCall.tool.case === "computerUseToolCall") {
    const value = toolCall.tool.value as ComputerUseToolCall | undefined;
    const actions = value?.args?.actions;
    if (actions?.length === 1 && actions[0]?.action.case === "screenshot") {
      return "Screenshot";
    }
  }
  return toolCall.tool.case ?? "Tool";
}

export function getTaskSummary(taskToolCall: TaskToolCall): string | undefined {
  const result = taskToolCall.result;
  if (result?.result.case === "error") {
    const value = result.result.value as { readonly error?: unknown } | undefined;
    if (typeof value?.error === "string") return value.error;
  }
  const description = taskToolCall.args?.description?.trim();
  if (description != null && description.length > 0) return description;
  const prompt = taskToolCall.args?.prompt?.trim();
  return prompt != null && prompt.length > 0 ? prompt : undefined;
}

export function getOutlineToolCallSummary(toolCall: OutlineToolCall): string | undefined {
  return toolCall.tool.case === "taskToolCall"
    ? getTaskSummary(toolCall.tool.value as TaskToolCall)
    : undefined;
}

export function getToolCallActivityArgs(toolCall: OutlineToolCall): string | undefined {
  const tool = toolCall.tool.value;
  if (tool == null || !("args" in tool) || tool.args == null || !("toJson" in tool.args)) {
    return undefined;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(tool.args.toJson());
  } catch {
    return undefined;
  }
  if (["{}", '\"\"', "[]", "null"].includes(serialized)) return undefined;
  if (serialized.length <= MAX_TOOL_ACTIVITY_ARGS_CHARS) return serialized;
  const copiedPrefix = Buffer.from(
    serialized.slice(0, MAX_TOOL_ACTIVITY_ARGS_CHARS),
    "utf8",
  ).toString("utf8");
  return `${copiedPrefix}\n… (truncated)`;
}

export function isFailedTaskToolCall(toolCall: OutlineToolCall): boolean {
  if (toolCall.tool.case !== "taskToolCall") return false;
  return (toolCall.tool.value as TaskToolCall).result?.result.case === "error";
}

export function getOutlineToolCallStatus(
  event: string,
  toolCall: OutlineToolCall,
): "pending" | "failed" | "done" {
  if (event !== "toolCallCompleted") return "pending";
  return isFailedTaskToolCall(toolCall) ? "failed" : "done";
}

export function sendMessageFromToolCall(toolCall: SendMessageToolCall): OutlineMessage | null {
  const message = toolCall.args?.message;
  if (message == null) return null;
  if (message.case === "text") {
    const value = message.value as { readonly content?: unknown } | undefined;
    return typeof value?.content === "string" ? { type: "text", content: value.content } : null;
  }
  if (message.case === "attachment") {
    const value = message.value as { readonly url?: unknown; readonly alt?: unknown } | undefined;
    if (typeof value?.url !== "string") return null;
    return {
      type: "attachment",
      url: value.url,
      ...(typeof value.alt === "string" && value.alt.length > 0
        ? { alt: value.alt }
        : {}),
    };
  }
  return null;
}

export function stepToOutlineItem(step: OutlineStep, id: string): OutlineItem | null {
  switch (step.message.case) {
    case "assistantMessage":
      return step.message.value.text.length === 0
        ? null
        : { kind: "assistant-text", id, text: step.message.value.text };
    case "thinkingMessage": {
      const { text, durationMs } = step.message.value;
      return text.length === 0
        ? null
        : { kind: "thinking", id, text, durationMs: durationMs > 0 ? durationMs : undefined };
    }
    case "toolCall": {
      const toolCall = step.message.value;
      if (toolCall.tool.case === "sendMessageToolCall") {
        const message = sendMessageFromToolCall(toolCall.tool.value as SendMessageToolCall);
        return message == null ? null : { kind: "send-message", id, message };
      }
      const summary = getOutlineToolCallSummary(toolCall);
      return {
        kind: "tool-call",
        id,
        name: getOutlineToolCallName(toolCall),
        status: getOutlineToolCallStatus("toolCallCompleted", toolCall),
        summary,
      };
    }
    default:
      return null;
  }
}

export function deriveOutlineTurnsFromConversationState(state: ConversationState): OutlineTurn[] {
  const turns: OutlineTurn[] = [];
  state.turns.forEach((turn, turnIndex) => {
    if (turn.turn.case === "agentConversationTurn") {
      const agentTurn = turn.turn.value;
      const rawUserText = agentTurn.userMessage?.text ?? "";
      const userMessageId = agentTurn.userMessage?.messageId ?? "";
      const hidden = rawUserText.startsWith(SAND_HIDDEN_PROMPT_MARKER);
      const userText = stripHiddenMarker(rawUserText);
      const items: OutlineItem[] = [];
      if (userText.trim().length > 0) {
        items.push({
          kind: "user",
          id: `outline-user-${turnIndex}`,
          text: userText,
          ...(hidden ? { hidden: true } : {}),
        });
      }
      agentTurn.steps.forEach((step, stepIndex) => {
        const item = stepToOutlineItem(step, `outline-${turnIndex}-${stepIndex}`);
        if (item != null) items.push(item);
      });
      turns.push({ rawUserText, userMessageId, items });
    } else if (turn.turn.case === "shellConversationTurn") {
      const command = turn.turn.value.shellCommand?.command ?? "";
      turns.push({
        rawUserText: "",
        userMessageId: "",
        items: [{
          kind: "tool-call",
          id: `outline-shell-${turnIndex}`,
          name: "shellToolCall",
          status: "done",
          summary: command.length > 0 ? command : undefined,
        }],
      });
    }
  });
  return turns;
}

export function deriveOutlineFromConversationState(state: ConversationState): OutlineItem[] {
  return deriveOutlineTurnsFromConversationState(state).flatMap((turn) => turn.items);
}
