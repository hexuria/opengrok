import { BackgroundComposerSource } from "../../proto/generated/aiserver/v1/background_composer_pb.js";
import { jsx as promptJsx, jsxs as promptJsxs, type PromptNode, type PromptProps } from "../../prompt-jsx/jsx-runtime.js";
import { getBrowserMcpProviderName } from "../common.js";
import {
  AgentType,
  isCloudAgentTestingPromptEligibleEnvironment,
  shouldEnableComputerUse,
  shouldUseExperimentalCloudBehavior,
} from "../utils/agent-config.js";
import { isNamedAgentHomePromptSession } from "./cloud-meta-agent/index.js";
import { isSlackV1_5ThreadBoundSession } from "./claude-helpers.js";
import { ComputerUseInstructionsSection, GitOrNoRepositoryInstructions } from "./shared.js";
import { TestingInstructions2 } from "./testing/index.js";

const jsx = (type: unknown, props: PromptProps) => promptJsx(type as never, props);
const jsxs = (type: unknown, props: PromptProps) => promptJsxs(type as never, props);

type ComposerToolInfo = {
  readonly allTools: Record<string, { readonly name: string } | undefined>;
  readonly [key: string]: unknown;
};

type ComposerEnvironment = {
  readonly artifactsFolder?: string | undefined;
  readonly [key: string]: unknown;
};

interface Composer2CloudTestingSectionsProps {
  readonly modelInfo?: {
    readonly modelName?: string | undefined;
    readonly promptVersion?: string | undefined;
    readonly isGrok45ProductPrompt?: boolean | undefined;
    readonly [key: string]: unknown;
  } | undefined;
  readonly enableComposer2IntelligentTestingPromptSection?: boolean | undefined;
  readonly backgroundAgentSource?: BackgroundComposerSource | undefined;
  readonly agentType?: AgentType | undefined;
  readonly enableCloudTesting?: boolean | undefined;
  readonly priorUserInfoCloudTestingSectionsPlacement?: string | undefined;
  readonly featureFlags?: {
    readonly grokCloudTestingInSystemPrompt?: boolean | undefined;
  } | undefined;
  readonly namedAgentSessionKind?: string | undefined;
  readonly isCloudMetaAgentParent?: boolean | undefined;
  readonly subagentType?: { readonly type?: { readonly case?: string | undefined } | undefined } | undefined;
  readonly useLocalAgentPrompting?: boolean | undefined;
  readonly env?: ComposerEnvironment | undefined;
  readonly cursorRules?: unknown;
  readonly browserTools?: readonly string[] | undefined;
  readonly cloudRule?: unknown;
  readonly mode?: unknown;
  readonly toolInfo?: ComposerToolInfo | undefined;
  readonly isDev?: boolean | undefined;
  readonly isRepoless?: boolean | undefined;
  readonly isSlackV1_5?: boolean | undefined;
}

interface Composer2CloudTestingSectionElementsOptions {
  readonly omitTestingWorkflow?: boolean | undefined;
}

export function parseComposer2CloudTestingSectionsPlacementMetadata(
  value: unknown,
): "user_info" | "system_prompt" | undefined {
  return value === "user_info" || value === "system_prompt" ? value : undefined;
}

export function getComposer2CloudTestingSectionsPlacement(
  props: Composer2CloudTestingSectionsProps,
): "user_info" | "system_prompt" | undefined {
  const eligible = !isNamedAgentHomePromptSession(props) && props.modelInfo?.promptVersion === "cursor-0226" && props.enableComposer2IntelligentTestingPromptSection === true && props.backgroundAgentSource !== undefined && props.agentType !== undefined && shouldUseExperimentalCloudBehavior({
    agentType: props.agentType,
    enableCloudTesting: props.enableCloudTesting ?? false,
  }) && isCloudAgentTestingPromptEligibleEnvironment(props.backgroundAgentSource);
  if (!eligible) {
    return undefined;
  }
  const prior = props.priorUserInfoCloudTestingSectionsPlacement;
  const isGrok45ProductPrompt = props.modelInfo?.isGrok45ProductPrompt === true;
  if (prior === "system_prompt") {
    return isGrok45ProductPrompt ? "system_prompt" : "user_info";
  }
  if (prior === "user_info") {
    return "user_info";
  }
  return isGrok45ProductPrompt && props.featureFlags?.grokCloudTestingInSystemPrompt === true ? "system_prompt" : "user_info";
}

function getComposer2CloudSectionContext(props: Composer2CloudTestingSectionsProps) {
  if (props.useLocalAgentPrompting === true || props.backgroundAgentSource === undefined || props.agentType === undefined || props.modelInfo === undefined || props.toolInfo === undefined) {
    return undefined;
  }
  const enableCloudTesting = props.enableCloudTesting ?? false;
  const enableComputerUse = shouldEnableComputerUse({
    agentType: props.agentType,
    enableCloudTesting,
    backgroundAgentSource: props.backgroundAgentSource,
    modelId: props.modelInfo.modelName as string,
    isBackground: props.agentType === AgentType.BACKGROUND,
  }) ?? false;
  const testingPromptProps = {
    env: props.env,
    cursorRules: props.cursorRules,
    browserTools: props.browserTools,
    cloudRule: props.cloudRule,
    mode: props.mode,
    agentType: props.agentType,
    isDev: false,
    enableCloudTesting,
    backgroundAgentSource: props.backgroundAgentSource,
    featureFlags: props.featureFlags,
    modelInfo: props.modelInfo,
    toolInfo: props.toolInfo,
    formattingOptions: {
      shouldUseFormatCodeblock: true,
      gpt5StyleLineNumbers: false,
      gpt5CodexCatN: false,
      enableLineNumbers: true,
    },
    nameWeTellTheModelToCallItself: "Composer",
    enableComputerUse,
  };
  return {
    testingPromptProps,
    enableComputerUse,
    browserTools: props.browserTools,
  };
}

const TestingInstructions2Prompt = TestingInstructions2 as unknown as (props: PromptProps) => PromptNode;
const ComputerUseInstructionsSectionPrompt = ComputerUseInstructionsSection as unknown as (props: PromptProps) => PromptNode;

export function getComposer2CloudTestingSectionElements(
  props: Composer2CloudTestingSectionsProps,
  options2?: Composer2CloudTestingSectionElementsOptions,
) {
  const context2 = getComposer2CloudSectionContext(props);
  if (context2 === undefined || props.toolInfo === undefined) {
    return undefined;
  }
  return {
    gitAndSubmission: jsxs("section", { title: "git_and_submission", children: [jsx("h2", { children: "Git and submitting your work" }), jsx("ul", { children: GitOrNoRepositoryInstructions({
      isRepoless: props.isRepoless,
      gitInstructionsProps: {
        toolInfo: props.toolInfo,
        shouldShowTestingInstructions: true,
        suppressCreatedPrMention: isSlackV1_5ThreadBoundSession(props),
      },
    }) })] }),
    testing: jsx(TestingInstructions2Prompt, { props: context2.testingPromptProps, browserMcpProviderName: getBrowserMcpProviderName(context2.browserTools), screenshotToolName: context2.browserTools?.find(tool => tool.includes("browser_take_screenshot")), enableComputerUse: context2.enableComputerUse, enableManualReproduction: context2.enableComputerUse, computerUseSubagentName: "computerUse", omitTestingWorkflow: options2?.omitTestingWorkflow === true }),
    computerUse: context2.enableComputerUse ? jsx(ComputerUseInstructionsSectionPrompt, { props: context2.testingPromptProps }) : undefined,
  };
}
