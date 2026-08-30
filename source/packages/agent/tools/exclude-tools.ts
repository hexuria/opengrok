import { ToolCall } from "../../proto/generated/agent/v1/agent_pb.js";
import { isSubagentExcludedPlatformCommunicationToolName } from "../automations/platform-communication-tools.js";
import { isForcedStaticContext } from "./core.js";

type ToolLike = {
  readonly name: string;
  readonly toolIdentifier?: string;
  readonly dynamicToolMetaRole?: string;
  readonly customToolFormat?: unknown;
  readonly contextType?: { readonly type?: string };
};

const TOOL_CALL_TOOL_FIELDS = ToolCall.fields
  .list()
  .filter((field) => field.oneof?.localName === "tool");
const AGENT_PROTO_TOOL_NAMES = TOOL_CALL_TOOL_FIELDS.map((field) => field.name);
const BASE_STATIC_NATIVE_TOOL_IDENTIFIERS = new Set([
  "ANTHROPIC_COMPUTER_USE",
  "APPLY_PATCH",
  "EXTERNAL_READ",
  "COMMUNICATE_UPDATE",
  "CREATE_PLAN",
  "CREATE_PLAN_V2",
  "GEMINI_COMPUTER_USE",
  "GLOB",
  "GREP",
  "OPENAI_COMPUTER_USE",
  "PR_MANAGEMENT",
  "READ",
  "RECORD_SCREEN",
  "SEND_MESSAGE",
  "SETUP_VM_ENVIRONMENT",
  "SHELL",
  "STR_REPLACE",
  "WRITE",
]);
const NORMALIZED_PROTO_TOOL_NAMES = new Map<string, string>();
for (const field of TOOL_CALL_TOOL_FIELDS) {
  NORMALIZED_PROTO_TOOL_NAMES.set(field.name, field.name);
  NORMALIZED_PROTO_TOOL_NAMES.set(field.name.toUpperCase(), field.name);
  NORMALIZED_PROTO_TOOL_NAMES.set(field.localName, field.name);
}

function shouldOffloadTool(
  profile: "all-static" | "final",
  toolIdentifier: string,
): boolean {
  switch (profile) {
    case "all-static":
      return false;
    case "final":
      return toolIdentifier !== "ASK_QUESTION" &&
        !BASE_STATIC_NATIVE_TOOL_IDENTIFIERS.has(toolIdentifier);
    default: {
      const exhaustive: never = profile;
      return exhaustive;
    }
  }
}

/** Partitions the final offered set using the immutable agent offload rules. */
export function partitionDynamicTools(
  tools: readonly ToolLike[],
  profile: "all-static" | "final",
): { readonly staticTools: ToolLike[]; readonly dynamicTools: ToolLike[] } {
  const staticTools: ToolLike[] = [];
  const dynamicTools: ToolLike[] = [];
  for (const tool of tools) {
    if (
      tool.dynamicToolMetaRole !== undefined ||
      ("customToolFormat" in tool && tool.customToolFormat !== undefined) ||
      isForcedStaticContext(tool.contextType) ||
      (tool.toolIdentifier === "PLATFORM_ACTION" &&
        isSubagentExcludedPlatformCommunicationToolName(tool.name))
    ) {
      staticTools.push(tool);
      continue;
    }
    if (shouldOffloadTool(profile, tool.toolIdentifier ?? "")) {
      dynamicTools.push(tool);
    } else {
      staticTools.push(tool);
    }
  }
  return { staticTools, dynamicTools };
}

void AGENT_PROTO_TOOL_NAMES;
void NORMALIZED_PROTO_TOOL_NAMES;
