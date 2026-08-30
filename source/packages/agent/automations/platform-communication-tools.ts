import {
  AUTOMATION_TOOLS_MCP_SERVER_ID,
  OFFER_REPOSITORY_SWITCH_TOOL_NAME,
  SEND_SLACK_MESSAGE_V2_TOOL_NAME,
  SLACK_AGENT_TOOLS_MCP_SERVER_ID,
  SLACK_OFFER_REPOSITORY_SWITCH_MCP_TOOL_NAME,
  SLACK_SEND_MESSAGE_MCP_TOOL_NAME,
  SLACK_SET_STATUS_MCP_TOOL_NAME,
  SLACK_START_STREAMING_MCP_TOOL_NAME,
  START_SLACK_STREAMING_TOOL_NAME,
} from "../constants.js";
import { automationToolNameToSnakeCase } from "../prompts/bugbot/automations.js";

const AUTOMATIONS_PLATFORM_COMMUNICATION_TOOL_NAMES = [
  "SendSlackMessage",
  "SendMicrosoftTeamsMessage",
  "PostReviewCommentOnPr",
] as const;
const automationsPlatformCommunicationToolNameSet = new Set(AUTOMATIONS_PLATFORM_COMMUNICATION_TOOL_NAMES);

export function isAutomationsPlatformCommunicationToolName(toolName: string): boolean {
  return automationsPlatformCommunicationToolNameSet.has(toolName as typeof AUTOMATIONS_PLATFORM_COMMUNICATION_TOOL_NAMES[number]);
}

const SUBAGENT_EXCLUDED_AUTOMATION_TOOL_NAMES = [
  ...AUTOMATIONS_PLATFORM_COMMUNICATION_TOOL_NAMES,
  "PostToPrComment",
] as const;
const subagentExcludedPlatformCommunicationToolNameSet = new Set([
  ...SUBAGENT_EXCLUDED_AUTOMATION_TOOL_NAMES,
  SEND_SLACK_MESSAGE_V2_TOOL_NAME,
  OFFER_REPOSITORY_SWITCH_TOOL_NAME,
  START_SLACK_STREAMING_TOOL_NAME,
]);

export function isSubagentExcludedPlatformCommunicationToolName(toolName: string): boolean {
  return subagentExcludedPlatformCommunicationToolNameSet.has(toolName);
}

const subagentExcludedCommunicationMcpToolNamesByServer = new Map<string, Set<string>>([
  [
    SLACK_AGENT_TOOLS_MCP_SERVER_ID.toLowerCase(),
    new Set([
      SLACK_OFFER_REPOSITORY_SWITCH_MCP_TOOL_NAME,
      SLACK_SEND_MESSAGE_MCP_TOOL_NAME,
      SLACK_SET_STATUS_MCP_TOOL_NAME,
      SLACK_START_STREAMING_MCP_TOOL_NAME,
    ]),
  ],
  [
    AUTOMATION_TOOLS_MCP_SERVER_ID.toLowerCase(),
    new Set(SUBAGENT_EXCLUDED_AUTOMATION_TOOL_NAMES.map(automationToolNameToSnakeCase)),
  ],
]);
