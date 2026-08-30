import { CursorRuleSource, type CursorRule } from "../../proto/generated/agent/v1/cursor_rules_pb.js";
import { fromRedactedCoreMessage } from "../../redaction/core-message.js";
import { PrivacyCapability } from "../../redaction/classification.js";
import { parseComposer2CloudTestingSectionsPlacementMetadata } from "../prompts/composer2-cloud-testing-sections.js";

type RequestContextWithRules = {
  readonly rules: readonly CursorRule[];
  readonly disabledTeamRules: readonly string[];
};

type RuleFeatureFlags = {
  readonly dropCustomPromptContext?: boolean | undefined;
};

export function getAllRules(
  requestContext: RequestContextWithRules,
  serverFetchedRules: readonly CursorRule[],
  featureFlags?: RuleFeatureFlags,
): CursorRule[] {
  if (featureFlags?.dropCustomPromptContext === true) {
    return [];
  }
  const teamRuleName = (rule: CursorRule) => rule.fullPath.split("/").pop() ?? rule.fullPath;
  const allRules = [...requestContext.rules, ...serverFetchedRules];
  const disabled = new Set(requestContext.disabledTeamRules);
  const enabledRules = allRules.filter(
    rule => rule.source !== CursorRuleSource.TEAM || rule.isRequired || !disabled.has(teamRuleName(rule)),
  );
  const seenTeamRules = new Set<string>();
  return enabledRules.filter(rule => {
    if (rule.source !== CursorRuleSource.TEAM) {
      return true;
    }
    const name = teamRuleName(rule);
    if (seenTeamRules.has(name)) {
      return false;
    }
    seenTeamRules.add(name);
    return true;
  });
}

type UserMessageContent = string | readonly { readonly type: string; readonly text: string }[];

function userMessagePlainText(message: { readonly content: UserMessageContent }): string | undefined {
  const content = message.content;
  if (typeof content === "string") {
    return content.length > 0 ? content : undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content.filter(part => part.type === "text").map(part => part.text).join("\n");
  return text.length > 0 ? text : undefined;
}

type PriorUserMessage = Parameters<typeof fromRedactedCoreMessage>[0] & {
  readonly role: string;
  readonly providerOptions?: {
    readonly cursor?: {
      readonly composer2CloudTestingSectionsPlacement?: unknown;
    } | undefined;
  } | undefined;
};

function getFirstUserInfoCloudTestingSectionsPlacement(priorMessages: readonly PriorUserMessage[]) {
  const firstMsg = priorMessages[0];
  if (firstMsg?.role !== "user") {
    return undefined;
  }
  const placement = parseComposer2CloudTestingSectionsPlacementMetadata(firstMsg.providerOptions?.cursor?.composer2CloudTestingSectionsPlacement);
  if (placement !== undefined) {
    return placement;
  }
  return getFirstUserInfoMessageContent(priorMessages) !== undefined ? "user_info" : undefined;
}

function getFirstUserInfoMessageContent(priorMessages: readonly PriorUserMessage[]) {
  const firstMsg = priorMessages[0];
  if (firstMsg?.role !== "user") {
    return undefined;
  }
  const plainFirst = fromRedactedCoreMessage(firstMsg, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
  const contentStr = userMessagePlainText(plainFirst as { readonly content: UserMessageContent });
  if (contentStr === undefined || !contentStr.includes("<user_info>")) {
    return undefined;
  }
  return contentStr;
}

type UnwrappableText = {
  unwrap(purpose: PrivacyCapability): string;
};

type AutomationTriggerMessage = {
  readonly role: string;
  readonly content: UnwrappableText | readonly { readonly type: string; readonly text: UnwrappableText }[];
};

const TRIGGER_INFO_OPEN = "<automation_trigger_info>";
const TRIGGER_INFO_CLOSE = "</automation_trigger_info>";

export function extractAutomationTriggerContext(
  messages: readonly AutomationTriggerMessage[],
): string | undefined {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const content = message.content;
    const textParts: string[] = [];
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === "text") {
          textParts.push(part.text.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED));
        }
      }
    } else {
      textParts.push((content as UnwrappableText).unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED));
    }
    const fullText = textParts.join("\n");
    const openIdx = fullText.indexOf(TRIGGER_INFO_OPEN);
    if (openIdx === -1) continue;
    const closeIdx = fullText.indexOf(TRIGGER_INFO_CLOSE, openIdx);
    if (closeIdx === -1) continue;
    return fullText.slice(openIdx, closeIdx + TRIGGER_INFO_CLOSE.length).trim();
  }
  return undefined;
}
