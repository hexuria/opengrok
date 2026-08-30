/**
 * Interrupted pending-tool reconstruction recovered from the immutable host.
 * Mac/Windows evidence: host-main.cjs:573923-574065.
 */
import { PrivacyCapability } from "../../../redaction/classification.js";
import { toRedactedCoreMessages } from "../../../redaction/core-message.js";
import { fromRedactedInterruptedPendingToolCallResolution } from "../../../redacted-protos/generated/agent/v1/agent_redacted.js";
import { getExecutableTools } from "../../tools/core.js";
import { renderShellResultToString, formatShellPartialOutputSection } from "../../tools/core/shell/formatters.js";
import { renderTaskResultToString } from "../../tools/task-client.js";
import { getInterruptedShellOutputSnapshot, clearInterruptedShellOutputSnapshot } from "../../tools/core/shell/interrupted-shell-output.js";
import type { PrivacyMode } from "../../../redaction/privacy-mode.js";

interface RedactedPendingMessage {
  unwrap(purpose: PrivacyCapability): string;
}

interface InterruptedToolStateHandler {
  getRawPendingMessages(): readonly RedactedPendingMessage[] | undefined;
  getPrivacyMode(): PrivacyMode;
}

interface ToolLike {
  readonly name: string;
  readonly toolIdentifier?: string | undefined;
}

interface ParsedPendingMessage {
  readonly [key: string]: unknown;
  readonly role: string;
  readonly content: unknown;
  readonly providerOptions?: {
    readonly cursor?: {
      readonly pendingToolCallStartedAtMs?: unknown;
      readonly highLevelToolCallResult?: unknown;
    } | undefined;
  } | undefined;
}

type RedactedInterruptedResolution = Parameters<typeof fromRedactedInterruptedPendingToolCallResolution>[0];
type RedactedInterruptedResolutions = {
  readonly resolutions: readonly RedactedInterruptedResolution[];
};

function getPendingToolCallElapsedMs(message: {
  readonly providerOptions?: {
    readonly cursor?: { readonly pendingToolCallStartedAtMs?: unknown } | undefined;
  } | undefined;
}): number | undefined {
  const startedAtMs = message.providerOptions?.cursor?.pendingToolCallStartedAtMs;
  if (typeof startedAtMs !== "number" || !Number.isFinite(startedAtMs)) return undefined;
  return Math.max(0, Date.now() - startedAtMs);
}

function formatElapsedText(elapsedMs: number | undefined): string {
  return elapsedMs !== undefined ? ` after ${elapsedMs}ms` : "";
}

function formatInterruptedAwaitResult(elapsedMs: number | undefined): string {
  return `Error: Await was interrupted by the user${formatElapsedText(elapsedMs)}.`;
}

function formatInterruptedShellResult(args: { readonly toolCallId: string; readonly elapsedMs: number | undefined }): string {
  const snapshot = getInterruptedShellOutputSnapshot(args.toolCallId);
  clearInterruptedShellOutputSnapshot(args.toolCallId);
  const elapsedText = formatElapsedText(args.elapsedMs);
  if (snapshot === undefined || snapshot.length === 0) {
    return `Error: Shell command was interrupted by the user${elapsedText} before it completed.`;
  }
  const partialOutputSection = formatShellPartialOutputSection(snapshot, {
    heading: "Output collected before interruption",
    truncatedSuffix: " (truncated)",
  });
  return `Error: Shell command was interrupted by the user${elapsedText} before it completed.\n\n${partialOutputSection}`;
}

function formatInterruptedToolResult(args: {
  readonly toolIdentifier: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly elapsedMs: number | undefined;
}): string {
  switch (args.toolIdentifier) {
    case "AWAIT": return formatInterruptedAwaitResult(args.elapsedMs);
    case "SHELL": return formatInterruptedShellResult({ toolCallId: args.toolCallId, elapsedMs: args.elapsedMs });
    default: return `Error: ${args.toolName} was interrupted by the user${formatElapsedText(args.elapsedMs)} before it completed.`;
  }
}

function formatResolvedInterruptedToolCall(args: {
  readonly resolution: RedactedInterruptedResolution | undefined;
  readonly terminalsFolder: string | undefined;
}): { readonly result: string; readonly isError: boolean } | undefined {
  if (args.resolution === undefined) return undefined;
  const resolution = fromRedactedInterruptedPendingToolCallResolution(args.resolution, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined).resolution;
    switch (resolution.case) {
    case "shellResult": {
      const shellResult = resolution.value;
      const resultCase = shellResult.result.case;
      if (resultCase === undefined) return { result: "Unknown error", isError: true };
      shellResult.terminalsFolder = shellResult.terminalsFolder ?? args.terminalsFolder!;
      return {
        result: renderShellResultToString({
          result: { case: resultCase, value: shellResult.result.value },
          ...(shellResult.sandboxPolicy !== undefined ? { sandboxPolicy: shellResult.sandboxPolicy } : {}),
          ...(shellResult.isBackground !== undefined ? { isBackground: shellResult.isBackground } : {}),
          ...(shellResult.terminalsFolder !== undefined ? { terminalsFolder: shellResult.terminalsFolder } : {}),
        }, { autoBackgroundedForInterruption: true }),
        isError: shellResult.result.case !== "success",
      };
    }
    case "taskResult":
      return {
        result: renderTaskResultToString(resolution.value),
        isError: resolution.value.result.case === "error",
      };
    case undefined: return undefined;
    default: {
      const exhaustive: never = resolution;
      return exhaustive;
    }
  }
}

function getToolIdentifier(toolName: string, toolMap: Record<string, ToolLike>): string {
  return toolMap[toolName]?.toolIdentifier ?? "other";
}

export function buildInterruptedPendingToolCallMessages(
  stateHandler: InterruptedToolStateHandler,
  tools: ReturnType<typeof getExecutableTools>,
  interruptedPendingToolCallResolutions: RedactedInterruptedResolutions | undefined,
  terminalsFolder: string | undefined,
) {
  const pendingMessages = stateHandler.getRawPendingMessages() ?? [];
  if (pendingMessages.length === 0) return [];
  const messagesToAppend: ParsedPendingMessage[] = [];
  const toolMap: Record<string, ToolLike> = Object.fromEntries(tools.map(tool => [tool.name, tool]));
  const resolutionByToolCallId = new Map(
    interruptedPendingToolCallResolutions?.resolutions.map(resolution => [resolution.toolCallId, resolution]) ?? [],
  );
  for (const pendingMessage of pendingMessages) {
    let parsed: ParsedPendingMessage;
    try {
      parsed = JSON.parse(pendingMessage.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)) as ParsedPendingMessage;
    } catch {
      continue;
    }
    messagesToAppend.push(parsed);
    if (parsed.role !== "assistant" || !Array.isArray(parsed.content)) continue;
    const elapsedMs = getPendingToolCallElapsedMs(parsed);
    const toolResults: Array<Record<string, unknown>> = [];
    const rawErrorMessages: string[] = [];
    for (const content of parsed.content) {
      if (
        content === null || typeof content !== "object" || Array.isArray(content) ||
        (content as { readonly type?: unknown }).type !== "tool-call"
      ) continue;
      const toolCall = content as { readonly toolCallId?: unknown; readonly toolName?: unknown };
      if (typeof toolCall.toolCallId !== "string" || typeof toolCall.toolName !== "string") continue;
      const toolIdentifier = getToolIdentifier(toolCall.toolName, toolMap);
      const resolved = formatResolvedInterruptedToolCall({ resolution: resolutionByToolCallId.get(toolCall.toolCallId), terminalsFolder });
      const result = resolved?.result ?? formatInterruptedToolResult({
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        toolIdentifier,
        elapsedMs,
      });
      if (resolved?.isError !== false) rawErrorMessages.push(result);
      toolResults.push({
        type: "tool-result",
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        result,
        experimental_content: [{ type: "text", text: result }],
      });
    }
    if (toolResults.length > 0) {
      messagesToAppend.push({
        role: "tool",
        content: toolResults,
        providerOptions: {
          cursor: {
            highLevelToolCallResult: {
              output: toolResults.map(result => result.result),
              isError: rawErrorMessages.length > 0,
              rawErrorMessages,
            },
          },
        },
      });
    }
  }
  return toRedactedCoreMessages(messagesToAppend, stateHandler.getPrivacyMode());
}
