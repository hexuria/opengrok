import type { SelectedConsoleLog } from "../proto/generated/agent/v1/selected_context_pb.js";

export interface ConsoleLogsTextContent {
  readonly type: "text";
  readonly text: string;
}

// Extracted from ../packages/agent/dist/context-processing.js as an
// uncomposed console-log prompt leaf. The parent processSelectedContext
// function remains absent.
export function renderConsoleLogsContext(
  consoleLogs: readonly SelectedConsoleLog[],
): ConsoleLogsTextContent | undefined {
  if (consoleLogs.length === 0) {
    return undefined;
  }
  const logsText = consoleLogs
    .map(log => `${log.level} ${new Date(log.timestamp).toLocaleTimeString()}: ${log.message}`)
    .join("\n");
  return {
    type: "text",
    text: `<console_logs_context>
Recent logs from the runtime connected to the AI agent.
${logsText}
</console_logs_context>`,
  };
}
