/**
 * User-info rerender and carrier metadata helpers recovered from the immutable
 * host. Mac/Windows evidence: host-main.cjs:573693-573915.
 */
import { PrivacyCapability } from "../../redaction/classification.js";
import { fromRedactedCoreMessage } from "../../redaction/core-message.js";
import {
  getComposer2CustomUserRulesForModel,
  type Composer2CustomUserRuleFeatureFlags,
  type Composer2CustomUserRuleModelInfo,
  type Composer2CustomUserRuleOptions,
} from "./user-info-composer2-rules.js";
import {
  parseRequestContextCompletenessMetadata,
  parseUserInfoSummarizationEpochMetadata,
  userInfoMatchesAvailableSubagentModels,
  userInfoMatchesAvailableSubagentTypes,
  userInfoMatchesDynamicToolSnapshot,
} from "./shared.js";
import { parseComposer2CloudTestingSectionsPlacementMetadata } from "./composer2-cloud-testing-sections.js";
import { renderMultitaskModeEnterUserReminderInner } from "./multitask-mode-user-reminder.js";
import { AgentMode } from "../../proto/generated/agent/v1/agent_pb.js";

type UserMessageContent = string | readonly { readonly type: string; readonly text: string }[];

function userMessagePlainText(message: { readonly content: UserMessageContent }): string | undefined {
  const content = message.content;
  if (typeof content === "string") return content.length > 0 ? content : undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content.filter(part => part.type === "text").map(part => part.text).join("\n");
  return text.length > 0 ? text : undefined;
}

type PriorUserMessage = Parameters<typeof fromRedactedCoreMessage>[0] & {
  readonly role: string;
  readonly providerOptions?: {
    readonly cursor?: {
      readonly requestContextCompleteness?: unknown;
      readonly userInfoSummarizationEpoch?: unknown;
      readonly omitCloudWorkerProcedure?: unknown;
      readonly isSummary?: unknown;
      readonly composer2CloudTestingSectionsPlacement?: unknown;
    } | undefined;
  } | undefined;
};

type UserInfoRerenderOptions = Composer2CustomUserRuleOptions & {
  readonly availableSubagentModelsDescription?: string | undefined;
  readonly availableSubagentTypesDescription?: string | undefined;
  readonly skipDynamicToolSnapshotCheck?: boolean | undefined;
  readonly mcpMetaToolOptions?: Parameters<typeof userInfoMatchesDynamicToolSnapshot>[1];
};

function stripWhitespace(value: string): string {
  return value.replace(/\s+/g, "");
}

const COMPOSER2_RULES_PRESENCE_SENTINEL = stripWhitespace(
  getComposer2CustomUserRulesForModel(undefined, { enableComposer2CustomUserRules: true })[0] ?? "",
);
const TAHOMA_USER_RULE_INTERVENTION_SENTINEL = stripWhitespace(
  getComposer2CustomUserRulesForModel(undefined, { enableTahomaUserRuleIntervention: true })[0] ?? "",
);
const VEGA_FRONTEND_USER_RULE_INTERVENTION_SENTINEL = stripWhitespace(
  getComposer2CustomUserRulesForModel(undefined, { enableVegaFrontendUserRuleIntervention: true })[0] ?? "",
);

function userInfoHasAnyGeneratedCustomUserRules(content: string): boolean {
  const stripped = stripWhitespace(content);
  return stripped.includes(COMPOSER2_RULES_PRESENCE_SENTINEL) ||
    stripped.includes(TAHOMA_USER_RULE_INTERVENTION_SENTINEL) ||
    stripped.includes(VEGA_FRONTEND_USER_RULE_INTERVENTION_SENTINEL);
}

function userInfoHasExpectedCustomUserRules(
  content: string,
  modelInfo: Composer2CustomUserRuleModelInfo | undefined,
  featureFlags: Composer2CustomUserRuleFeatureFlags | undefined,
  options: UserInfoRerenderOptions | undefined,
): boolean {
  const stripped = stripWhitespace(content);
  const resolvedFeatureFlags = {
    enableComposer2CustomUserRules: true,
    ...featureFlags,
  };
  const rules = getComposer2CustomUserRulesForModel(modelInfo, resolvedFeatureFlags, options);
  const strippedRules = rules.map(stripWhitespace);
  const expectsTahomaIntervention = featureFlags?.enableTahomaUserRuleIntervention === true;
  const hasTahomaIntervention = stripped.includes(TAHOMA_USER_RULE_INTERVENTION_SENTINEL);
  const expectsVegaFrontendIntervention = featureFlags?.enableVegaFrontendUserRuleIntervention === true;
  const hasVegaFrontendIntervention = stripped.includes(VEGA_FRONTEND_USER_RULE_INTERVENTION_SENTINEL);
  const expectsComposer2CustomRules = strippedRules.some(rule => rule === COMPOSER2_RULES_PRESENCE_SENTINEL);
  const hasComposer2CustomRules = stripped.includes(COMPOSER2_RULES_PRESENCE_SENTINEL);
  if (
    hasTahomaIntervention !== expectsTahomaIntervention ||
    hasVegaFrontendIntervention !== expectsVegaFrontendIntervention ||
    hasComposer2CustomRules !== expectsComposer2CustomRules
  ) {
    return false;
  }
  return rules.length > 0 && strippedRules.every(rule => stripped.includes(rule));
}

export function shouldRerenderUserInfo(
  hasExistingNonSystemMessages: boolean,
  priorMessages: readonly PriorUserMessage[],
  expectedCustomUserRules: readonly string[],
  modelInfo: Composer2CustomUserRuleModelInfo | undefined,
  forceRerender: boolean,
  featureFlags: Composer2CustomUserRuleFeatureFlags | undefined,
  options: UserInfoRerenderOptions | undefined,
): boolean {
  if (!hasExistingNonSystemMessages || priorMessages.length === 0) return false;
  const firstMsg = priorMessages[0];
  if (firstMsg?.role !== "user") return false;
  const plainFirst = fromRedactedCoreMessage(firstMsg, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
  const contentStr = userMessagePlainText(plainFirst as { readonly content: UserMessageContent });
  if (contentStr === undefined) return false;
  if (!contentStr.includes("<user_info>")) return false;
  if (forceRerender) return true;
  if (!userInfoMatchesAvailableSubagentModels(contentStr, options?.availableSubagentModelsDescription)) return true;
  if (!userInfoMatchesAvailableSubagentTypes(contentStr, options?.availableSubagentTypesDescription)) return true;
  if (options?.skipDynamicToolSnapshotCheck !== true && !userInfoMatchesDynamicToolSnapshot(contentStr, options?.mcpMetaToolOptions)) return true;
  const wantsCustomUserRules = expectedCustomUserRules.length > 0;
  if (wantsCustomUserRules) return !userInfoHasExpectedCustomUserRules(contentStr, modelInfo, featureFlags, options);
  return userInfoHasAnyGeneratedCustomUserRules(contentStr);
}

export function getFirstUserInfoRequestContextCompleteness(priorMessages: readonly PriorUserMessage[]) {
  const firstMsg = priorMessages[0];
  if (firstMsg?.role !== "user") return undefined;
  return parseRequestContextCompletenessMetadata(firstMsg.providerOptions?.cursor?.requestContextCompleteness);
}

export function getFirstUserInfoSummarizationEpoch(priorMessages: readonly PriorUserMessage[]) {
  const firstMsg = priorMessages[0];
  if (firstMsg?.role !== "user") return undefined;
  return parseUserInfoSummarizationEpochMetadata(firstMsg.providerOptions?.cursor?.userInfoSummarizationEpoch);
}

export function getFirstUserInfoOmitCloudWorkerProcedure(priorMessages: readonly PriorUserMessage[]): boolean {
  return priorMessages[0]?.providerOptions?.cursor?.omitCloudWorkerProcedure === true;
}

export function hasSummaryCarrierMessage(priorMessages: readonly PriorUserMessage[]): boolean {
  return priorMessages.some(message => message.providerOptions?.cursor?.isSummary === true);
}

export function getFirstUserInfoCloudTestingSectionsPlacement(priorMessages: readonly PriorUserMessage[]) {
  const firstMsg = priorMessages[0];
  if (firstMsg?.role !== "user") return undefined;
  const placement = parseComposer2CloudTestingSectionsPlacementMetadata(
    firstMsg.providerOptions?.cursor?.composer2CloudTestingSectionsPlacement,
  );
  if (placement !== undefined) return placement;
  return getFirstUserInfoMessageContent(priorMessages) !== undefined ? "user_info" : undefined;
}

export function getFirstUserInfoMessageContent(priorMessages: readonly PriorUserMessage[]) {
  const firstMsg = priorMessages[0];
  if (firstMsg?.role !== "user") return undefined;
  const plainFirst = fromRedactedCoreMessage(firstMsg, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
  const contentStr = userMessagePlainText(plainFirst as { readonly content: UserMessageContent });
  if (contentStr === undefined || !contentStr.includes("<user_info>")) return undefined;
  return contentStr;
}

const MULTITASK_MODE_ENTER_REMINDER_SENTINEL = stripWhitespace(
  renderMultitaskModeEnterUserReminderInner("Task").slice(0, 40),
);

export function userInfoHasMultitaskModeEnterReminder(content: string): boolean {
  return stripWhitespace(content).includes(MULTITASK_MODE_ENTER_REMINDER_SENTINEL);
}

export function shouldMigrateMultitaskEnterReminderToUserInfo(params: {
  readonly hasExistingNonSystemMessages: boolean;
  readonly previousTurnMode: AgentMode | undefined;
  readonly resolvedTurnMode: AgentMode;
  readonly priorMessages: readonly PriorUserMessage[];
  readonly firstUserInfoContent: string | undefined;
  readonly userInfoAlreadyHasMultitaskEnterReminder: boolean;
}): boolean {
  return params.hasExistingNonSystemMessages &&
    params.previousTurnMode === AgentMode.MULTITASK &&
    params.resolvedTurnMode === AgentMode.MULTITASK &&
    params.firstUserInfoContent !== undefined &&
    !params.userInfoAlreadyHasMultitaskEnterReminder &&
    hasSummaryCarrierMessage(params.priorMessages);
}
