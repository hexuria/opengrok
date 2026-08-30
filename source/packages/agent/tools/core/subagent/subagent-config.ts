import { ConversationStateStructure } from "../../../../proto/generated/agent/v1/agent_pb.js";
import type { SubagentType } from "../../../../proto/generated/agent/v1/subagents_pb.js";

export const GENERAL_PURPOSE_SUBAGENT_TYPE = "generalPurpose" as const;

export function normalizeSubagentTypeName(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/[-_]/g, "").replace(/(?<=.)(subagenttype|subagent|agent|mode|type)$/, "");
  if (normalized === "mediareview") {
    return "videoreview";
  }
  return normalized;
}

export function getSubagentTypeName(subagentType: SubagentType): string {
  if (subagentType.type.case === "custom") {
    return subagentType.type.value.name;
  }
  if (subagentType.type.case === "unspecified") {
    return GENERAL_PURPOSE_SUBAGENT_TYPE;
  }
  if (subagentType.type.case === "computerUse") {
    return "computerUse";
  }
  if (subagentType.type.case === "explore") {
    return "explore";
  }
  if (subagentType.type.case === "bash" || subagentType.type.case === "shell") {
    return "shell";
  }
  if (subagentType.type.case === "browserUse") {
    return "browser-use";
  }
  if (subagentType.type.case === "debug") {
    return "debug";
  }
  if (subagentType.type.case === "cursorGuide") {
    return "cursor-guide";
  }
  if (subagentType.type.case === "mediaReview") {
    return "videoReview";
  }
  if (subagentType.type.case === "watchVideo") {
    return "watchVideo";
  }
  return subagentType.type.case ?? "unknown";
}

export function isGeminiVideoSubagentType(
  subagentType: SubagentType | undefined,
): boolean {
  return subagentType?.type.case === "mediaReview" || subagentType?.type.case === "watchVideo";
}

type ConversationStateMappingConfig = {
  readonly conversationStateMapper?: ((callerState: ConversationStateStructure) => ConversationStateStructure) | undefined;
};

export function applyConversationStateMapping(
  config: ConversationStateMappingConfig,
  callerState: ConversationStateStructure,
): ConversationStateStructure {
  if (config.conversationStateMapper !== undefined) {
    return config.conversationStateMapper(callerState);
  }
  return new ConversationStateStructure();
}
