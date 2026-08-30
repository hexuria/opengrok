import { PrivacyCapability } from "../../../../redaction/classification.js";

interface RedactedToolArguments {
  unwrap(purpose: PrivacyCapability): string;
}

interface ReplayHorizonMessage {
  readonly role: string;
  readonly content: unknown;
}

function readAsyncOriginalToolCallId(args: RedactedToolArguments): string | undefined {
  let parsedArgs: unknown;
  try {
    parsedArgs = JSON.parse(args.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED));
  } catch {
    return undefined;
  }
  if (
    typeof parsedArgs !== "object" ||
    parsedArgs === null ||
    Array.isArray(parsedArgs) ||
    !("async_original_tool_call_id" in parsedArgs)
  ) {
    return undefined;
  }
  const originalToolCallId = parsedArgs.async_original_tool_call_id;
  return typeof originalToolCallId === "string" && originalToolCallId.length > 0
    ? originalToolCallId
    : undefined;
}

function isAskQuestionToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase().replace(/_/g, "");
  return normalized === "askquestion" || normalized === "multiplechoice";
}

export function collectLiveAskQuestionOriginalIds(
  messages: readonly ReplayHorizonMessage[],
): Set<string> {
  const liveOriginalIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const typedPart = part as {
        readonly type: string;
        readonly toolName: string;
        readonly args: RedactedToolArguments;
        readonly toolCallId: string;
      };
      if (typedPart.type !== "tool-call" || !isAskQuestionToolName(typedPart.toolName)) {
        continue;
      }
      const originalToolCallId = readAsyncOriginalToolCallId(typedPart.args) ?? typedPart.toolCallId;
      if (originalToolCallId.length > 0) liveOriginalIds.add(originalToolCallId);
    }
  }
  return liveOriginalIds;
}
