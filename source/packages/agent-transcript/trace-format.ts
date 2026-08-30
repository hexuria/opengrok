import { ConversationMessage_MessageType, type ConversationMessage } from "../proto/generated/aiserver/v1/chat_pb.js";

export enum HistoryVisibilityMode { INTERNAL = "INTERNAL", EXTERNAL = "EXTERNAL", NO_PREAMBLE = "NO_PREAMBLE" }
type ToolResult = ConversationMessage["toolResults"][number];

function tryParseJson(value: string | undefined): unknown {
  if (!value) return undefined;
  try { return JSON.parse(value); } catch { return value; }
}
function applyToolCallTimestamps(target: Record<string, unknown>, toolResult: ToolResult): void {
  const startedAtMs = toolResult.startedAtMs !== undefined ? Number(toolResult.startedAtMs) : undefined;
  const completedAtMs = toolResult.completedAtMs !== undefined ? Number(toolResult.completedAtMs) : undefined;
  if (startedAtMs !== undefined) target.started_at_ms = startedAtMs;
  if (completedAtMs !== undefined) target.completed_at_ms = completedAtMs;
  if (startedAtMs !== undefined && completedAtMs !== undefined) target.duration_ms = completedAtMs - startedAtMs;
}
function extractToolResultContent(toolResult: ToolResult): unknown {
  if (toolResult.content) return tryParseJson(toolResult.content);
  const result = toolResult.result?.result;
  return result?.case && result.value !== undefined ? { resultType: result.case, value: result.value } : undefined;
}
export function convertConversationMessagesToTrace(messages: readonly ConversationMessage[], visibilityMode: HistoryVisibilityMode): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];
  const startIndex = visibilityMode === HistoryVisibilityMode.EXTERNAL ? 2 : 0;
  for (let index = startIndex; index < messages.length; index++) {
    const message = messages[index] as ConversationMessage;
    const role = index === 0 && visibilityMode === HistoryVisibilityMode.INTERNAL && message.type === ConversationMessage_MessageType.HUMAN ? "system" : message.type === ConversationMessage_MessageType.HUMAN ? "user" : message.type === ConversationMessage_MessageType.AI ? "assistant" : "unknown";
    const trace: Record<string, unknown> = { role };
    if (message.text && message.text.trim().length > 0) trace.text = message.text;
    if (message.thinking?.text && message.thinking.text.trim().length > 0) trace.thinking = message.thinking.text;
    if (message.type === ConversationMessage_MessageType.AI && message.toolResults.length > 0) {
      const calls = message.toolResults.map((toolResult) => {
        const call: Record<string, unknown> = {};
        if (toolResult.toolCallId) call.tool_call_id = toolResult.toolCallId;
        if (toolResult.toolName) call.tool_name = toolResult.toolName;
        const args = toolResult.rawArgs || toolResult.args;
        if (args) call.tool_args = tryParseJson(args);
        applyToolCallTimestamps(call, toolResult);
        return call;
      });
      if (calls.length > 0) trace.tool_calls = calls;
    }
    output.push(trace);
    if (message.type === ConversationMessage_MessageType.AI) for (const toolResult of message.toolResults) {
      const tool: Record<string, unknown> = { role: "tool" };
      if (toolResult.toolCallId) tool.tool_call_id = toolResult.toolCallId;
      if (toolResult.toolName) tool.tool_name = toolResult.toolName;
      const args = toolResult.rawArgs || toolResult.args;
      if (args) tool.tool_args = tryParseJson(args);
      const result = extractToolResultContent(toolResult);
      if (result !== undefined) tool.tool_result = result;
      applyToolCallTimestamps(tool, toolResult);
      output.push(tool);
    }
  }
  return output;
}
