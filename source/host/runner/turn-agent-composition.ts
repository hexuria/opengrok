import {
  buildTurnTools,
  type TurnTool,
  type TurnToolsetBuildProps,
  type TurnToolsetHost,
  type TurnToolsetTurnInput,
  type TurnMcpMetaToolFactoryInput,
  type TurnMultitaskToolFactoryInput,
  type TurnShellToolFactoryInput,
  createTurnShellAutoReviewOptions,
  createTurnToolsetFactoriesForTurn,
  resolveTurnShellAutoReviewInputs,
} from "./tools/turn-toolset.js";
import type { Context } from "../../packages/context/core.js";
import { requestIdKey } from "../../packages/chat-inference-proto/client.js";
import { AnysphereAgent } from "../../packages/agent/index.js";
import { SimplePromptToolExecutor } from "../../packages/agent/tool-stream-executor.js";
import { NoopConversationActionReceiver } from "../../packages/agent-core/conversation-actions/remote.js";
import { toRedactedInteractionListener } from "../../packages/agent-core/redacted-interaction-listener.js";
import type { PrivacyMode } from "../../packages/redaction/privacy-mode.js";
import type { RedactedString } from "../../packages/redaction/types.js";
import {
  toRedactedConversationAction,
  toRedactedConversationStateStructure,
} from "../../packages/redacted-protos/generated/agent/v1/agent_redacted.js";
import {
  ConversationStateStructure,
} from "../../packages/proto/generated/agent/v1/agent_pb.js";
import type { ConversationAction } from "../../packages/proto/generated/agent/v1/agent_pb.js";
import { RESUME_TURN_ACTION } from "./turn-run-shell.js";
import {
  SAND_BOX_SHELL_TOOL_NAME,
  SAND_EXTERNAL_SHELL_TOOL_NAME,
} from "../sand-activity.js";
import type { SummarizationPromptSession } from "../../packages/agent-summarization/summarization-handler.js";
import type {
  CloudAgentToolDeps,
} from "../cloud-agents/cloud-agent-tool.js";
import type { BackgroundWatchesHost } from "./background-work.js";
import type { BlobStore } from "../../packages/agent-kv/blob-store.js";
import {
  CombinedResourceAccessor,
  resourceEntry,
  type RemoteResource,
  type ResourceAccessor,
} from "../../packages/agent-exec/resource-provider.js";
import type {
  Executor,
  ExecutorOptions,
  RemoteExecManager,
  StreamExecutor,
} from "../../packages/agent-exec/remote.js";
import {
  createSubagentExecutor,
  subagentExecutorResource,
} from "../../packages/agent-exec/subagent.js";
import {
  backgroundShellExecutorResource,
} from "../../packages/agent-exec/background-shell.js";
import {
  requestContextExecutorResource,
} from "../../packages/agent-exec/request-context.js";
import {
  shellStreamExecutorResource,
} from "../../packages/agent-exec/shell-stream.js";
import {
  smartModeClassifierExecutorResource,
} from "../../packages/agent-exec/smart-mode-classifier.js";
import {
  mcpExecutorResource,
  mcpStateExecutorResource,
} from "../../packages/agent-exec/mcp.js";
import type {
  BackgroundShellSpawnArgs,
  BackgroundShellSpawnResult,
} from "../../packages/proto/generated/agent/v1/background_shell_exec_pb.js";
import type {
  RequestContextArgs,
  RequestContextResult,
} from "../../packages/proto/generated/agent/v1/request_context_exec_pb.js";
import type {
  ShellArgs,
  ShellStream,
} from "../../packages/proto/generated/agent/v1/shell_exec_pb.js";
import type {
  SmartModeClassifierArgs,
  SmartModeClassifierResult,
} from "../../packages/proto/generated/agent/v1/smart_mode_classifier_exec_pb.js";
import type {
  McpArgs,
  McpResult,
  McpStateExecArgs,
  McpStateExecResult,
} from "../../packages/proto/generated/agent/v1/mcp_exec_pb.js";
import {
  SandSubagentHostAdapter,
  SandRequestContextExecutor,
  type RequestContextProvider,
  type SubagentAdapterArgs,
  type SubagentDispatcher,
  ForwardingInteractionListener,
  type ForwardedUpdate,
} from "./agent-adapters.js";
import type { AgentSkill } from "../../packages/proto/generated/agent/v1/agent_skills_pb.js";
import type {
  SubagentSession,
} from "./subagent-runtime.js";
import { SubagentRegistry, subagentRegistryResource } from "../../packages/agent/tools/subagent-registry.js";
import {
  NoopDocumentationHydrationService,
  NoopWebScraperService,
} from "../../packages/agent/utils/agent-config.js";
import { createSubagentModels } from "../../packages/agent/tools/core/subagent/models.js";
import { createSandSummarizationHandler } from "./conversation-state.js";
import {
  createDiskPressureReminderMiddleware,
  createSendMessageReminderMiddleware,
  type MessageLike,
  type PromptExecutor as ReminderPromptExecutor,
} from "./send-message-reminder-middleware.js";
import { createStartOfTurnAckReminderMiddleware } from "./start-of-turn-ack-reminder-middleware.js";
import { createSandBrowserUseSubagentConfig } from "./tools/sand-browser-use-subagent.js";
import { createSandComputerUseSubagentConfig } from "./tools/sand-computer-use-subagent.js";
import { createSandExecutorSubagentConfig } from "../sand-multitask.js";
import {
  buildSandSubagentLaunchReviewTarget,
  buildSandSubagentRiskTarget,
  reviewSandSubagentAction,
  SAND_SUBAGENT_CLASSIFIER_ERROR_REASON,
  type InstructionPermissions,
} from "./sand-subagent-auto-review.js";
import {
  runSandAutoReviewClassifier,
} from "./sand-auto-review-classifier-run.js";
import type {
  SandAutoReviewController,
  SandAutoReviewExpiryPolicy,
  SandAutoReviewMode,
} from "./sand-auto-review.js";
import type { SmartModeClassifierConversationMessage } from "../../packages/proto/generated/agent/v1/smart_mode_classifier_exec_pb.js";

export const SAND_AGENT_MAX_STEPS = 5_000;

export interface TurnProfileIdentity {
  readonly name: string;
  readonly description: string;
}

export type TurnProfileUpdateCallback = (
  identity: TurnProfileIdentity,
) => void;

export type TurnProfileHistoryAppender = (
  messages: readonly unknown[],
  profilePromptSnapshot: unknown,
  onProfileUpdateAppended: TurnProfileUpdateCallback,
) => unknown;

export type TurnAgentResourceAccessor = ResourceAccessor<RemoteExecManager>;

export type TurnAgentStateHandler = NonNullable<
  TurnToolsetBuildProps["stateHandler"]
>;

export interface TurnAgentToolSession {
  getExecutor(...args: readonly unknown[]): SimplePromptToolExecutor;
}

export interface TurnAgentToolSessionInput {
  getExecutor(): ReminderPromptExecutor;
  readonly isSubagentRunner: boolean;
  readonly isSilenceAllowed: boolean;
  readonly diskPressureReminderEpisodeId?: string | null;
  readonly onLatestPromptMessages?: (
    getter: () => readonly MessageLike[],
  ) => void;
}

/**
 * Reconstructs the immutable per-turn executor order: disk pressure first,
 * then SendMessage reminder, then start-of-turn acknowledgement. A fresh
 * executor is requested on every call and the latest-message getter is
 * updated by identity; no executor or state is cached across turns.
 */
export function createTurnToolSession(
  input: TurnAgentToolSessionInput,
): TurnAgentToolSession {
  return {
    getExecutor: () => {
      const base = input.getExecutor();
      const withDiskPressure = input.diskPressureReminderEpisodeId == null
        ? base
        : createDiskPressureReminderMiddleware(
          input.diskPressureReminderEpisodeId,
        )(base);
      const withSendMessage = input.isSubagentRunner || input.isSilenceAllowed
        ? withDiskPressure
        : createSendMessageReminderMiddleware()(withDiskPressure);
      const executor = input.isSubagentRunner || input.isSilenceAllowed
        ? withSendMessage
        : createStartOfTurnAckReminderMiddleware()(withSendMessage);
      const toolExecutor = new SimplePromptToolExecutor(executor);
      input.onLatestPromptMessages?.(() => toolExecutor.getMessages());
      return toolExecutor;
    },
  };
}

const DEFAULT_BACKGROUND_SUMMARIZATION = {
  unusedTokensThresholdToStartBackgroundSummarization: 10_000,
  unusedPercentTokensThresholdToStartBackgroundSummarization: 0.1,
  unusedTokensThresholdToPersistBackgroundSummarization: 5_000,
  unusedPercentTokensThresholdToPersistBackgroundSummarization: 0.05,
  discardOnError: true,
  requireTriggerThresholdForMidLoopPersist: true,
} as const;

export interface TurnAgentStaticConfigInputs {
  readonly modelId: string;
  readonly agentTokenLimit: number;
  readonly conversationId: string;
  readonly isBoxScopedSubagent: boolean;
  readonly isSubagentRunner: boolean;
  readonly isSharedRoomRunner: boolean;
  readonly sandSendMessageDeliveryOwed: boolean;
  readonly transcriptsFolderAvailable?: boolean;
  readonly backgroundSummarizationPropsOverride?: Partial<
    typeof DEFAULT_BACKGROUND_SUMMARIZATION
  >;
  readonly systemPromptGenerator: (...args: readonly unknown[]) => unknown;
  readonly toolsGenerator: (
    props: TurnToolsetBuildProps,
  ) => ReturnType<typeof buildTurnTools>;
  readonly selfSummaryConfig?: unknown;
  readonly attachedMediaUrlProvider?: unknown;
  readonly messageHistoryModifier?: (...args: readonly unknown[]) => unknown;
  readonly profilePromptSnapshot?: unknown;
  readonly onProfileUpdateAppended?: TurnProfileUpdateCallback;
  readonly appendProfileUpdateToHistory?: TurnProfileHistoryAppender;
}

export function createSandTurnModelProjection(modelId: string) {
  return {
    parentModelInfo: createSandPromptModelInfo(modelId),
    subagentModels: createSubagentModels({
      [modelId]: { slug: modelId },
    }),
  };
}

/**
 * Builds the dependency-closed static Agent config portion of the immutable
 * buildAgentForRun owner. Dynamic host branches remain caller supplied.
 */
export function createSandAgentStaticConfig(
  input: TurnAgentStaticConfigInputs,
) {
  const profilePromptSnapshot = input.profilePromptSnapshot;
  const onProfileUpdateAppended = input.onProfileUpdateAppended;
  const appendProfileUpdateToHistory = input.appendProfileUpdateToHistory;
  const messageHistoryModifier =
    profilePromptSnapshot === undefined
    || onProfileUpdateAppended === undefined
    || appendProfileUpdateToHistory === undefined
      ? input.messageHistoryModifier
      : (messages: readonly unknown[]) => appendProfileUpdateToHistory(
        messages,
        profilePromptSnapshot,
        onProfileUpdateAppended,
      );
  return {
    maxSteps: SAND_AGENT_MAX_STEPS,
    modelId: input.modelId,
    agentTokenLimit: input.agentTokenLimit,
    backgroundSummarizationProps: {
      ...DEFAULT_BACKGROUND_SUMMARIZATION,
      ...input.backgroundSummarizationPropsOverride,
    },
    ...(input.selfSummaryConfig === undefined
      ? {}
      : { selfSummaryConfig: input.selfSummaryConfig }),
    featureFlags: {
      enableWatchVideoInIdeSubagent: true,
      sandSendMessageDeliveryOwed: input.sandSendMessageDeliveryOwed,
      userMessageTimestamps: true,
      rerenderUserInfoOnRequestContextRecovery: true,
      rerenderUserInfoOnSummarization: true,
      skipPreTurnStateSnapshot: true,
    },
    agentType: "IDE" as const,
    conversationId: input.conversationId,
    conversationGroupId: input.conversationId,
    ...(input.attachedMediaUrlProvider === undefined
      ? {}
      : { attachedMediaUrlProvider: input.attachedMediaUrlProvider }),
    systemPromptGenerator: input.systemPromptGenerator,
    ...(messageHistoryModifier === undefined
      ? {}
      : { messageHistoryModifier }),
    toolsGenerator: input.toolsGenerator,
    webScraperService: new NoopWebScraperService(),
    documentationHydrationService: new NoopDocumentationHydrationService(),
    userInfoDisplayOptions: {
      disable: input.isBoxScopedSubagent,
      displayCursorRules: true,
      displaySkills: !input.isSubagentRunner && !input.isSharedRoomRunner,
      excludeAgentTranscripts:
        input.isSubagentRunner || input.transcriptsFolderAvailable === false,
    },
    enableTerminalFiles: false,
    enableTranscriptInSummary: true,
  };
}

export interface TurnAgentToolsHandoff {
  readonly toolsGenerator: (
    props: TurnToolsetBuildProps,
  ) => ReturnType<typeof buildTurnTools>;
  readonly getActiveStateHandler: () => TurnAgentStateHandler | undefined;
}

/**
 * Preserves the immutable lazy tool/state boundary: state is captured only
 * when the Agent asks for tools, and every per-turn prop reaches buildTurnTools
 * unchanged. There is no cached state or fallback toolset.
 */
export function createTurnAgentToolsHandoff(input: {
  readonly toolHost: TurnToolsetHost;
  readonly turn: TurnToolsetTurnInput;
  readonly turnScope?: TurnAgentTurnScope;
}): TurnAgentToolsHandoff {
  let activeStateHandler: TurnAgentStateHandler | undefined;
  const turn = input.turnScope === undefined
    ? input.turn
    : {
      ...input.turn,
      ...createTurnScopeToolHooks(input.turnScope),
    };

  const createPerTurnToolHost = (props: TurnToolsetBuildProps): TurnToolsetHost => {
    const resolvedShellAutoReview = turn.shellAutoReview === undefined
      ? resolveTurnShellAutoReviewInputs(turn, props)
      : undefined;
    const effectiveTurn: TurnToolsetTurnInput = {
      ...turn,
      ...(resolvedShellAutoReview === undefined
        ? {}
        : { shellAutoReview: resolvedShellAutoReview }),
    };
    const provider = props.turnToolsetFactoryProvider
      ?? input.toolHost.factoryProvider;
    const hasDirectComputerInputs = props.createComputerToolDependencies !== undefined;
    const hasDirectScreenshotInputs = props.createScreenshotToolDependencies !== undefined;
    const hasDirectBrowserInputs = props.createBrowserDriverDependencies !== undefined;
    const hasDirectMultitaskInputs = props.stateHandler !== undefined;
    const hasDirectMcpMetaInputs = props.mcp?.mcpMeta !== undefined;
    const hasDirectShellInputs = (() => {
      try {
        return props.resourceAccessor.get(shellStreamExecutorResource) !== undefined;
      } catch {
        return false;
      }
    })();
    if (
      provider === undefined
      && !hasDirectComputerInputs
      && !hasDirectScreenshotInputs
      && !hasDirectBrowserInputs
      && !hasDirectMultitaskInputs
      && !hasDirectMcpMetaInputs
      && !hasDirectShellInputs
    ) return input.toolHost;

    const perTurnProvider = {
      ...(provider ?? {}),
      ...(provider?.createComputerToolInputs !== undefined || !hasDirectComputerInputs
        ? {}
        : {
            createComputerToolInputs: (
              _turn: TurnToolsetTurnInput,
              currentProps: TurnToolsetBuildProps,
            ) => {
              const createDependencies = currentProps.createComputerToolDependencies;
              if (createDependencies === undefined) {
                throw new TypeError("computer tool dependencies are not bound");
              }
              return { dependencies: createDependencies(currentProps) };
            },
          }),
      ...(provider?.createMultitaskToolInputs !== undefined || !hasDirectMultitaskInputs
        ? {}
        : {
            createMultitaskToolInputs: (
              _turn: TurnToolsetTurnInput,
              currentProps: TurnToolsetBuildProps,
            ): TurnMultitaskToolFactoryInput => {
              if (currentProps.stateHandler === undefined) {
                throw new TypeError("Multitask state handler is not bound");
              }
              return {
                resourceAccessor: currentProps.resourceAccessor as TurnMultitaskToolFactoryInput["resourceAccessor"],
                stateHandler: currentProps.stateHandler as unknown as TurnMultitaskToolFactoryInput["stateHandler"],
              };
            },
          }),
      ...(provider?.createScreenshotToolInputs !== undefined || !hasDirectScreenshotInputs
        ? {}
        : {
            createScreenshotToolInputs: (
              _turn: TurnToolsetTurnInput,
              currentProps: TurnToolsetBuildProps,
            ) => {
              const createDependencies = currentProps.createScreenshotToolDependencies;
              if (createDependencies === undefined) {
                throw new TypeError("screenshot tool dependencies are not bound");
              }
              return { dependencies: createDependencies(currentProps) };
            },
          }),
      ...(provider?.createBrowserToolInputs !== undefined || !hasDirectBrowserInputs
        ? {}
        : {
            createBrowserToolInputs: (
              _turn: TurnToolsetTurnInput,
              currentProps: TurnToolsetBuildProps,
            ) => {
              const createDependencies = currentProps.createBrowserDriverDependencies;
              if (createDependencies === undefined) {
                throw new TypeError("browser tool dependencies are not bound");
              }
              return { dependencies: createDependencies(currentProps) };
            },
          }),
      ...(provider?.createMcpMetaToolInputs !== undefined || !hasDirectMcpMetaInputs
        ? {}
        : {
            createMcpMetaToolInputs: (
              _turn: TurnToolsetTurnInput,
              currentProps: TurnToolsetBuildProps,
            ): TurnMcpMetaToolFactoryInput => {
              const mcpMeta = currentProps.mcp?.mcpMeta;
              if (mcpMeta === undefined) {
                throw new TypeError("MCP meta-tool options are not bound");
              }
              return {
                resourceAccessor: currentProps.resourceAccessor as TurnMcpMetaToolFactoryInput["resourceAccessor"],
                ...mcpMeta,
              };
            },
          }),
      ...(provider?.createExternalShellToolInputs !== undefined || !hasDirectShellInputs
        ? {}
        : {
            createExternalShellToolInputs: (
              _turn: TurnToolsetTurnInput,
              currentProps: TurnToolsetBuildProps,
            ): TurnShellToolFactoryInput | undefined => {
              if (currentProps.resourceAccessor.get(shellStreamExecutorResource) === undefined) {
                return undefined;
              }
              return {
              resourceAccessor: currentProps.resourceAccessor as TurnShellToolFactoryInput["resourceAccessor"],
              options: createTurnShellAutoReviewOptions({
                resourceAccessor: currentProps.resourceAccessor as TurnShellToolFactoryInput["resourceAccessor"],
                options: {
                surface: "host_machine",
                toolName: SAND_EXTERNAL_SHELL_TOOL_NAME,
                readToolIdentifier: "EXTERNAL_READ",
                awaitToolIdentifier: "AWAIT",
                enableBlockUntilMs: true,
                defaultBlockUntilMs: 30_000,
                },
                ...(effectiveTurn.shellAutoReview?.host === undefined
                  ? {}
                  : { review: effectiveTurn.shellAutoReview.host }),
              }),
              };
            },
          }),
      ...(provider?.createBoxShellToolInputs !== undefined || !hasDirectShellInputs
        ? {}
        : {
            createBoxShellToolInputs: (
              _turn: TurnToolsetTurnInput,
              currentProps: TurnToolsetBuildProps,
            ): TurnShellToolFactoryInput | undefined => {
              const resourceAccessor = effectiveTurn.remoteBoxResourceAccessor;
              if (resourceAccessor === undefined) {
                throw new TypeError("remote box resource accessor is not bound");
              }
              if (resourceAccessor.get(shellStreamExecutorResource) === undefined) {
                return undefined;
              }
              return {
              resourceAccessor: resourceAccessor as TurnShellToolFactoryInput["resourceAccessor"],
              options: createTurnShellAutoReviewOptions({
                resourceAccessor: resourceAccessor as TurnShellToolFactoryInput["resourceAccessor"],
                options: {
                surface: "isolated_box",
                toolName: SAND_BOX_SHELL_TOOL_NAME,
                awaitToolIdentifier: "BOX_AWAIT",
                enableBlockUntilMs: true,
                defaultBlockUntilMs: 30_000,
                },
                ...(effectiveTurn.shellAutoReview?.box === undefined
                  ? {}
                  : { review: effectiveTurn.shellAutoReview.box }),
              }),
              };
            },
          }),
    };
    const projectedFactories = createTurnToolsetFactoriesForTurn(
      perTurnProvider,
      effectiveTurn,
      props,
    );
    if (Object.keys(projectedFactories).length === 0) return input.toolHost;
    return {
      ...input.toolHost,
      ...(provider === undefined ? {} : { factoryProvider: provider }),
      factories: {
        ...input.toolHost.factories,
        ...projectedFactories,
      },
    };
  };

  return {
    toolsGenerator: props => {
      const enrichedProps: TurnToolsetBuildProps =
        turn.parentModelInfo === undefined && turn.subagentModels === undefined
          ? props
          : {
              ...props,
              ...(turn.parentModelInfo === undefined
                ? {}
                : { parentModelInfo: turn.parentModelInfo }),
              ...(turn.subagentModels === undefined
                ? {}
                : { subagentModels: turn.subagentModels }),
            };
      activeStateHandler = enrichedProps.stateHandler;
      return buildTurnTools(
        createPerTurnToolHost(enrichedProps),
        turn,
        enrichedProps,
      );
    },
    getActiveStateHandler: () => activeStateHandler,
  };
}

export interface TurnAgentConstructorHandoff
  extends TurnAgentConstructionInputs {
  readonly toolHost: TurnToolsetHost;
  readonly turn: TurnToolsetTurnInput;
  readonly turnScope?: TurnAgentTurnScope;
}

/**
 * Binds the real lazy tools generator to the recovered Agent constructor. The
 * host still owns the omitted MCP, approval, and subagent resource branches.
 */
export function createTurnAgentConstructorHandoff(
  input: TurnAgentConstructorHandoff,
) {
  const tools = createTurnAgentToolsHandoff({
    toolHost: input.toolHost,
    turn: input.turn,
    ...(input.turnScope === undefined
      ? {}
      : { turnScope: input.turnScope }),
  });
  const agent = createTurnAgentForRun({
    ...input,
    config: {
      ...input.config,
      toolsGenerator: tools.toolsGenerator,
    },
  });
  return {
    agent,
    toolsGenerator: tools.toolsGenerator,
    getActiveStateHandler: tools.getActiveStateHandler,
  };
}

export interface TurnAgentBuildForRunInput
  extends Omit<TurnAgentConstructorHandoff, "config"> {
  readonly staticConfig: Omit<
    TurnAgentStaticConfigInputs,
    "toolsGenerator"
  >;
}

export interface BuiltTurnAgentForRun {
  readonly agent: AnysphereAgent;
  readonly config: ReturnType<typeof createSandAgentStaticConfig>;
  readonly parentModelInfo: PromptModelInfo;
  readonly subagentModels: ReturnType<typeof createSubagentModels>;
  readonly toolsGenerator: (
    props: TurnToolsetBuildProps,
  ) => ReturnType<typeof buildTurnTools>;
  readonly getActiveStateHandler: () => unknown;
  readonly runStream: (input: TurnAgentRunStreamInput) => Promise<ConversationStateStructure>;
}

export interface TurnAgentRunStreamInput {
  readonly attemptCtx: Context;
  readonly state: TurnRedactedConversationState;
  readonly action: TurnRedactedConversationAction;
  readonly mcpTools: readonly unknown[];
  readonly persistCheckpoint: (
    checkpointCtx: Context,
    checkpoint: ConversationStateStructure,
  ) => Promise<void> | void;
}

export interface TurnAgentStreamStartInput {
  readonly agent: Pick<BuiltTurnAgentForRun, "agent">;
  readonly baseState: ConversationStateStructure;
  readonly action: ConversationAction;
  readonly privacyMode: PrivacyMode;
  readonly mcpTools: readonly unknown[];
}

export interface TurnAgentStreamStart {
  startStream(
    attemptCtx: Context,
    resumeFrom: ConversationStateStructure | undefined,
    persistCheckpoint: TurnAgentRunStreamInput["persistCheckpoint"],
  ): Promise<ConversationStateStructure>;
}

/**
 * Binds the exact outer createStreamAttempt startStream callback to the real
 * Agent. The attempt layer owns accepted-checkpoint capture and retry state;
 * this boundary only projects generated state/action values to their redacted
 * forms and forwards mcpTools and persistCheckpoint by identity.
 */
export function createTurnAgentStreamStart(
  input: TurnAgentStreamStartInput,
): TurnAgentStreamStart {
  return {
    startStream(attemptCtx, resumeFrom, persistCheckpoint) {
      const streamInput = createTurnAgentRunStreamInput({
        attemptCtx,
        baseState: input.baseState,
        action: input.action,
        ...(resumeFrom === undefined ? {} : { resumeFrom }),
        privacyMode: input.privacyMode,
        mcpTools: input.mcpTools,
        persistCheckpoint,
      });
      return input.agent.agent.runStream(
        streamInput.attemptCtx,
        streamInput.state,
        streamInput.action,
        streamInput.mcpTools,
        streamInput.persistCheckpoint,
      );
    },
  };
}

export interface TurnAgentMcpTurnProvider {
  getTools(ctx: Context): Promise<readonly unknown[]>;
  refreshAccountConfig(): void;
}

export interface TurnAgentRunInputProjectionFactoryInput {
  readonly runCtx: Context;
  readonly createAction: (runCtx: Context) => Promise<ConversationAction>;
  readonly mcp?: TurnAgentMcpTurnProvider;
  readonly onMcpDiscoveryFailed?: (error: unknown) => void;
  readonly getConversationState: () => ConversationStateStructure;
}

export interface TurnAgentRunInputProjection {
  readonly action: ConversationAction;
  readonly baseState: ConversationStateStructure;
  readonly mcpTools: readonly unknown[];
}

/**
 * Reconstructs the producer immediately before the immutable stream attempt.
 * The action producer must already return generated proto values; this helper
 * deliberately does not coerce structural prompt output. MCP discovery is
 * per-turn, preserves provider order, reports discovery failures by identity,
 * refreshes account configuration without disposing the manager, and falls
 * back to an empty tool list. The state is cloned only after discovery.
 */
export async function createTurnAgentRunInputProjection(
  input: TurnAgentRunInputProjectionFactoryInput,
): Promise<TurnAgentRunInputProjection> {
  const action = await input.createAction(input.runCtx);
  let mcpTools: readonly unknown[] = [];
  if (input.mcp !== undefined) {
    try {
      mcpTools = [...await input.mcp.getTools(input.runCtx)];
    } catch (error) {
      input.onMcpDiscoveryFailed?.(error);
    }
    input.mcp.refreshAccountConfig();
  }
  const conversationState = input.getConversationState();
  const baseState = ConversationStateStructure.fromBinary(
    conversationState.toBinary(),
  );
  return { action, baseState, mcpTools };
}

/**
 * Keeps the immutable stream boundary typed at the constructor handoff. The
 * attempt layer owns retries and persistence policy; this projection only
 * selects the canonical action/state pair and forwards the checkpoint
 * callback unchanged.
 */
export function createTurnAgentRunStreamInput(input: {
  readonly attemptCtx: Context;
  readonly baseState: ConversationStateStructure;
  readonly action: ConversationAction;
  readonly resumeFrom?: ConversationStateStructure;
  readonly privacyMode: PrivacyMode;
  readonly mcpTools: readonly unknown[];
  readonly persistCheckpoint: TurnAgentRunStreamInput["persistCheckpoint"];
}): TurnAgentRunStreamInput {
  const projection = createTurnRedactedRunProjection(input);
  return {
    attemptCtx: input.attemptCtx,
    state: projection.state,
    action: projection.action,
    mcpTools: input.mcpTools,
    persistCheckpoint: input.persistCheckpoint,
  };
}

/**
 * Recovered buildAgentForRun body around the proven constructor boundary.
 * The tool host remains the owner of live shared-room/cloud gates; omitted
 * host branches are therefore absent rather than replaced with defaults.
 */
export function buildAgentForRun(
  input: TurnAgentBuildForRunInput,
): BuiltTurnAgentForRun {
  const model = createSandTurnModelProjection(input.staticConfig.modelId);
  const turn: TurnToolsetTurnInput = {
    ...input.turn,
    parentModelInfo: model.parentModelInfo,
    subagentModels: model.subagentModels,
  };
  const tools = createTurnAgentToolsHandoff({
    toolHost: input.toolHost,
    turn,
    ...(input.turnScope === undefined
      ? {}
      : { turnScope: input.turnScope }),
  });
  const config = createSandAgentStaticConfig({
    ...input.staticConfig,
    ...(input.turnScope?.profilePromptSnapshot === undefined
      ? {}
      : { profilePromptSnapshot: input.turnScope.profilePromptSnapshot }),
    ...(input.turnScope?.onProfileUpdateAppended === undefined
      ? {}
      : { onProfileUpdateAppended: input.turnScope.onProfileUpdateAppended }),
    toolsGenerator: tools.toolsGenerator,
  });
  const agent = createTurnAgentForRun({
    ...input,
    config,
    preserveLatestImage:
      input.preserveLatestImage ?? input.staticConfig.isBoxScopedSubagent,
  });
  const runStream = async (
    streamInput: TurnAgentRunStreamInput,
  ): Promise<ConversationStateStructure> => agent.runStream(
    streamInput.attemptCtx,
    streamInput.state,
    streamInput.action,
    streamInput.mcpTools,
    streamInput.persistCheckpoint,
  );
  return {
    agent,
    config,
    parentModelInfo: model.parentModelInfo,
    subagentModels: model.subagentModels,
    toolsGenerator: tools.toolsGenerator,
    getActiveStateHandler: tools.getActiveStateHandler,
    runStream,
  };
}

export type TurnCloudAgentTool = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly execute: (...args: readonly unknown[]) => Promise<unknown>;
};
export type TurnCloudAgentReviewAction = NonNullable<
  CloudAgentToolDeps["reviewAction"]
>;
export type TurnCloudAgentWatch = NonNullable<CloudAgentToolDeps["watch"]>;
export type TurnCloudAgentWatcher = NonNullable<
  ReturnType<BackgroundWatchesHost["cloudAgentWatcher"]>
>;

export interface TurnCloudAgentProjectionInput {
  readonly createCloudAgentTool: (input: {
    readonly reviewAction?: TurnCloudAgentReviewAction;
  }) => TurnCloudAgentTool;
  readonly watchCloudAgent: TurnCloudAgentWatch;
  readonly cloudAgentWatcher: BackgroundWatchesHost["cloudAgentWatcher"];
}

export interface TurnCloudAgentProjection {
  readonly createCloudAgentTool: TurnCloudAgentProjectionInput["createCloudAgentTool"];
  readonly watchCloudAgent: TurnCloudAgentWatch;
  readonly cloudAgentWatcher: BackgroundWatchesHost["cloudAgentWatcher"];
}

/**
 * Projects the host-owned cloud tool and watcher into one per-run boundary.
 * The policy fence remains in buildTurnTools, while reviewAction and watcher
 * callbacks retain their host identities and are never cached here.
 */
export function createTurnCloudAgentProjection(
  input: TurnCloudAgentProjectionInput,
): TurnCloudAgentProjection {
  return {
    createCloudAgentTool: ({ reviewAction } = {}) => input.createCloudAgentTool(
      reviewAction === undefined ? {} : { reviewAction },
    ),
    watchCloudAgent: input.watchCloudAgent,
    cloudAgentWatcher: input.cloudAgentWatcher,
  };
}

export function createTurnCloudAgentFactory(
  projection: TurnCloudAgentProjection,
  reviewAction?: TurnCloudAgentReviewAction,
): () => TurnCloudAgentTool {
  return () => projection.createCloudAgentTool(
    reviewAction === undefined ? {} : { reviewAction },
  );
}

export interface TurnAgentConstructionInputs {
  readonly config: ReturnType<typeof createSandAgentStaticConfig>;
  readonly toolSession: TurnAgentToolSession;
  readonly emitUpdate: (update: ForwardedUpdate) => void;
  readonly interactionObservers: ConstructorParameters<
    typeof ForwardingInteractionListener
  >[1];
  readonly privacyMode: PrivacyMode;
  readonly resourceAccessor: TurnAgentResourceAccessor;
  readonly blobStore: BlobStore<unknown>;
  readonly summarizationSession: SummarizationPromptSession;
  readonly preserveLatestImage?: boolean;
}

/**
 * Constructs the exact recovered Agent boundary without promoting the larger
 * host runner. The caller must supply the already-resolved per-run config,
 * tool session, resource accessor, and blob store; missing host branches stay
 * outside this leaf rather than receiving synthetic fallbacks.
 */
export function createTurnAgentForRun(
  input: TurnAgentConstructionInputs,
): AnysphereAgent {
  const interactionListener = toRedactedInteractionListener(
    new ForwardingInteractionListener(
      input.emitUpdate,
      input.interactionObservers,
    ),
    input.privacyMode,
  );
  const summarizationHandler = createSandSummarizationHandler(
    input.summarizationSession,
    { preserveLatestImage: input.preserveLatestImage ?? false },
  );
  return new AnysphereAgent(
    input.config,
    input.toolSession,
    interactionListener,
    input.resourceAccessor,
    input.blobStore,
    summarizationHandler,
    new NoopConversationActionReceiver(),
  );
}

export interface PromptModelInfo {
  readonly vendor: "openai";
  readonly modelName: string;
  readonly promptVersion: "latest";
  readonly isSonnet45: false;
  readonly isGemini3: false;
  readonly isGpt51: false;
  readonly isGpt52: false;
  readonly isGpt5: false;
  readonly isSonnet4: false;
  readonly isCodexFamily: false;
  readonly isGpt52Codex: false;
  readonly isGpt53Codex: false;
  readonly isClaude4X: false;
  readonly isOpus45: false;
  readonly isOpus46: false;
  readonly isGpt5Family: false;
  readonly isComposer1: false;
  readonly isComposer15: false;
  readonly isComposer2: false;
  readonly isGpt53CodexSpark: false;
}

export function createSandPromptModelInfo(
  modelName: string,
): PromptModelInfo {
  return {
    vendor: "openai",
    modelName,
    promptVersion: "latest",
    isSonnet45: false,
    isGemini3: false,
    isGpt51: false,
    isGpt52: false,
    isGpt5: false,
    isSonnet4: false,
    isCodexFamily: false,
    isGpt52Codex: false,
    isGpt53Codex: false,
    isClaude4X: false,
    isOpus45: false,
    isOpus46: false,
    isGpt5Family: false,
    isComposer1: false,
    isComposer15: false,
    isComposer2: false,
    isGpt53CodexSpark: false,
  };
}

export interface PromptExecutor {
  executeModelStreamOnly(
    ...args: readonly unknown[]
  ): {
    readonly response: Promise<unknown>;
    readonly toolCallDescriptors: Promise<unknown>;
    readonly [key: string]: unknown;
  };
}

export class SandSelfSummaryPromptToolExecutor {
  constructor(readonly executor: PromptExecutor) {}

  executeToolStream(
    ...args: readonly unknown[]
  ): {
    readonly response: Promise<unknown>;
    readonly [key: string]: unknown;
  } {
    const {
      toolCallDescriptors,
      ...result
    } = this.executor.executeModelStreamOnly(...args);
    return {
      ...result,
      response: Promise.all([
        result.response,
        toolCallDescriptors,
      ]).then(([response]) => response),
    };
  }
}

export interface AgentSession {
  getModelId(): string;
  getResolvedModelId?(): string | undefined;
  getExecutor(): unknown;
  getExecutorWithoutResolvedModelTracking?(state: unknown): PromptExecutor;
}

export interface TurnAgentSessions {
  readonly agent: AgentSession;
  /** The concrete summary owner has a message-aware executor signature. */
  readonly summarization: AgentSession | SummarizationPromptSession;
  readonly canUseSelfSummary: () => boolean;
}

export interface TurnAgentScope {
  readonly isSilenceAllowed: boolean;
  readonly privacyMode: PrivacyMode;
  readonly quietOrigin?: unknown;
  readonly directionEpoch?: number;
  readonly cancelThisRun: (reason: {
    intentional: boolean;
    reason: string;
  }) => void;
  readonly ackToken?: string;
  readonly pauseThisRun?: () => void;
  readonly isRunAwaitingUserSelection?: () => boolean;
  readonly endThisRunAwaitingUser?: (reason: string) => void;
  readonly profilePromptSnapshot?: unknown;
  readonly onProfileUpdateAppended?: TurnProfileUpdateCallback;
  readonly diskPressureReminderEpisodeId?: string | null;
  readonly emittedConnectorCards: Set<string>;
}

export type TurnAgentTurnScope = Pick<
  TurnAgentScope,
  | "cancelThisRun"
  | "ackToken"
  | "pauseThisRun"
  | "isRunAwaitingUserSelection"
  | "endThisRunAwaitingUser"
  | "privacyMode"
  | "profilePromptSnapshot"
  | "onProfileUpdateAppended"
>;

export interface TurnScopeToolHooks {
  readonly cancelThisRun: TurnAgentScope["cancelThisRun"];
  readonly ackToken?: string;
  readonly pauseThisRun?: () => void;
  readonly isRunAwaitingUserSelection?: () => boolean;
  readonly endThisRunAwaitingUser?: (reason: string) => void;
}

/**
 * Copies the live turn controls without binding them to a runner instance.
 * Optional controls remain absent when the host has not supplied them; no
 * no-op callback can accidentally turn a fail-closed branch into success.
 */
export function createTurnScopeToolHooks(
  scope: Pick<
    TurnAgentScope,
    | "cancelThisRun"
    | "ackToken"
    | "pauseThisRun"
    | "isRunAwaitingUserSelection"
    | "endThisRunAwaitingUser"
  >,
): TurnScopeToolHooks {
  return {
    cancelThisRun: scope.cancelThisRun,
    ...(scope.ackToken === undefined ? {} : { ackToken: scope.ackToken }),
    ...(scope.pauseThisRun === undefined
      ? {}
      : { pauseThisRun: scope.pauseThisRun }),
    ...(scope.isRunAwaitingUserSelection === undefined
      ? {}
      : { isRunAwaitingUserSelection: scope.isRunAwaitingUserSelection }),
    ...(scope.endThisRunAwaitingUser === undefined
      ? {}
      : { endThisRunAwaitingUser: scope.endThisRunAwaitingUser }),
  };
}

export type TurnAgentInteractionObservers = ConstructorParameters<
  typeof ForwardingInteractionListener
>[1];

export interface TurnAgentScopeProjection {
  readonly toolHooks: TurnScopeToolHooks;
  readonly interactionObservers: TurnAgentInteractionObservers;
  readonly privacyMode: PrivacyMode;
  readonly preserveLatestImage: boolean;
  readonly profilePromptSnapshot?: unknown;
  readonly onProfileUpdateAppended?: TurnProfileUpdateCallback;
}

export function createTurnAgentScopeProjection(input: {
  readonly scope: Pick<
    TurnAgentScope,
    | "cancelThisRun"
    | "ackToken"
    | "pauseThisRun"
    | "isRunAwaitingUserSelection"
    | "endThisRunAwaitingUser"
    | "privacyMode"
    | "profilePromptSnapshot"
    | "onProfileUpdateAppended"
  >;
  readonly interactionObservers: TurnAgentInteractionObservers;
  readonly isBoxScopedSubagent: boolean;
}): TurnAgentScopeProjection {
  return {
    toolHooks: createTurnScopeToolHooks(input.scope),
    interactionObservers: input.interactionObservers,
    privacyMode: input.scope.privacyMode,
    preserveLatestImage: input.isBoxScopedSubagent,
    ...(input.scope.profilePromptSnapshot === undefined
      ? {}
      : { profilePromptSnapshot: input.scope.profilePromptSnapshot }),
    ...(input.scope.onProfileUpdateAppended === undefined
      ? {}
      : { onProfileUpdateAppended: input.scope.onProfileUpdateAppended }),
  };
}

export interface TurnRedactedConversationAction {
  readonly _privacyMode: PrivacyMode;
  readonly triggeringAuthId?: string | undefined;
  readonly triggeringUserInfo?: Readonly<Record<string, unknown>> | undefined;
  readonly requestContextParts?: Readonly<Record<string, unknown>> | undefined;
  readonly action: {
    readonly case: string | undefined;
    readonly value?: Readonly<Record<string, unknown>> | undefined;
  };
}

export interface TurnRedactedConversationState {
  readonly _privacyMode: PrivacyMode;
  readonly rootPromptMessagesJson: readonly Uint8Array[];
  readonly turns: readonly Uint8Array[];
  readonly todos: readonly Uint8Array[];
  readonly pendingToolCalls: readonly RedactedString[];
  readonly previousWorkspaceUris: readonly RedactedString[];
  readonly summaryArchives: readonly Uint8Array[];
  readonly turnTimings: readonly Readonly<Record<string, unknown>>[];
  readonly readPaths: readonly RedactedString[];
  readonly [field: string]: unknown;
}

export interface TurnRedactedRunProjection {
  readonly state: TurnRedactedConversationState;
  readonly action: TurnRedactedConversationAction;
  readonly isResume: boolean;
}

/**
 * Projects the exact pre-dispatch state/action pair. A retry resumes from the
 * latest state but sends the canonical empty RESUME action; MCP tools and
 * checkpoint persistence are intentionally outside this boundary.
 */
export function createTurnRedactedRunProjection(input: {
  readonly baseState: ConversationStateStructure;
  readonly action: ConversationAction;
  readonly resumeFrom?: ConversationStateStructure;
  readonly privacyMode: PrivacyMode;
}): TurnRedactedRunProjection {
  const isResume = input.resumeFrom !== undefined;
  const state = toRedactedConversationStateStructure(
    input.resumeFrom ?? input.baseState,
    input.privacyMode,
  );
  const action = toRedactedConversationAction(
    isResume ? RESUME_TURN_ACTION : input.action,
    input.privacyMode,
  );
  return { state, action, isResume };
}

export interface TurnAgentCompositionHost {
  readonly toolHost: TurnToolsetHost;
  readonly isSubagentRunner: boolean;
  readonly isSharedRoomRunner: boolean;
  readonly isBoxScopedSubagent: boolean;
  readonly isSystemPromptOverridden?: boolean;
  getConversationId(): string;
  resolveContextWindow(modelId: string): number;
  isSendMessageDeliveryOwedEnabled?(): boolean;
  currentAutoReviewModes(): {
    hostShell: string;
    boxShell: string;
    mcp: string;
    computer: string;
    automationWrite: string;
    cloudAgent: string;
    subagentLaunch: string;
  };
  getSubagentConfigs?(): readonly unknown[];
  isBrowserUseSubagentEnabled?(): boolean;
  isMultitaskEnabled?(): boolean;
  createExecutorSubagentConfig?(): unknown;
  getSubagentTypeName?(config: unknown): string | undefined;
  transcriptsFolderAvailable?(): boolean;
}

export interface TurnAgentProductionReadiness {
  readonly ready: boolean;
  readonly blockers: readonly ("multitask" | "externalRead")[];
}

export interface TurnAgentProductionReadinessOptions {
  /** The exact per-turn resource/state projection is available. */
  readonly multitaskPerTurnProjectionAvailable?: boolean;
}

/**
 * The constructor/stream handoff is exact, but production activation remains
 * fail-closed until the two mandatory tool owners are source-closed. This is
 * a pure gate over the real registry; it does not manufacture factories or a
 * runner callback.
 */
export function getTurnAgentProductionReadiness(
  toolHost: Pick<TurnToolsetHost, "factories">,
  options: TurnAgentProductionReadinessOptions = {},
): TurnAgentProductionReadiness {
  const blockers: Array<"multitask" | "externalRead"> = [];
  if (
    toolHost.factories.multitask === undefined
    && options.multitaskPerTurnProjectionAvailable !== true
  ) blockers.push("multitask");
  if (toolHost.factories.externalRead === undefined) blockers.push("externalRead");
  return { ready: blockers.length === 0, blockers };
}

export interface ConnectorCardEmission {
  readonly serverId: string;
  readonly variant: string;
  readonly connector?: string;
}

export interface TurnScopedConnectorCardEmission extends ConnectorCardEmission {
  readonly ackToken?: string | undefined;
  readonly cancelThisRun: TurnAgentScope["cancelThisRun"];
}

export interface TurnMcpResult {
  readonly result: {
    readonly case: string | undefined;
    readonly value?: unknown;
  };
}

function hasMcpErrorMessage(value: unknown): value is { error: string } {
  return typeof value === "object"
    && value !== null
    && "error" in value
    && typeof value.error === "string";
}

export function createTurnMcpExecutorGuard<ExecContext extends Context, Args extends {
  readonly providerIdentifier: string;
  readonly serverIdentifier: string;
  readonly toolCallId?: string;
}, Result extends TurnMcpResult>(dependencies: {
  readonly isSubagentRunner: boolean;
  readonly assertNoPendingApproval: () => void;
  readonly execute: (context: ExecContext, args: Args, options?: ExecutorOptions) => Promise<Result>;
  readonly beginObservation: (args: {
    toolCallId: string;
    connector: string;
    requestId?: string | undefined;
  }) => (errorClass?: string) => void;
  readonly boundedConnectorTag: (providerIdentifier: string) => string;
  readonly mcpErrorClassOf: (error: unknown) => string;
  readonly takeMcpExecErrorClass: (toolCallId: string) => string | undefined;
  readonly resolveNeedsAuthSlot?: ((providerIdentifier: string) => Promise<{ serverName: string; serverId: string } | null>) | undefined;
  readonly emitConnectorCard: (emission: ConnectorCardEmission) => void;
  readonly reportDiagnostic: (event: { kind: "mcp_connect_card_failed"; errorClass: string }) => void;
  readonly errorLogTag: (error: unknown) => string;
}) {
  const connectCardEmittedForServer = new Set<string>();

  async function surfaceNeedsAuthCard(providerIdentifier: string): Promise<string | null> {
    if (dependencies.isSubagentRunner || dependencies.resolveNeedsAuthSlot == null) return null;
    if (providerIdentifier.length === 0 || connectCardEmittedForServer.has(providerIdentifier)) return null;
    const slot = await dependencies.resolveNeedsAuthSlot(providerIdentifier);
    if (slot == null) return null;
    connectCardEmittedForServer.add(providerIdentifier);
    dependencies.emitConnectorCard({ connector: slot.serverName, serverId: slot.serverId, variant: "connect" });
    return `"${slot.serverName}" needs authentication; its connect card is now in the chat. Finish unrelated work, then end your turn \u2014 you're resumed automatically when the user authorizes. Don't call AuthenticateMcpServer, send a link, or reach the service another way meanwhile.`;
  }

  return {
    async execute(context: ExecContext, args: Args, options?: ExecutorOptions): Promise<Result> {
      dependencies.assertNoPendingApproval();
      const providerIdentifier = args.providerIdentifier.length > 0 ? args.providerIdentifier : args.serverIdentifier;
      const settleObservation = dependencies.beginObservation({
        toolCallId: args.toolCallId ?? "",
        connector: dependencies.boundedConnectorTag(providerIdentifier),
        ...(() => {
          const requestId = context.get(requestIdKey);
          return requestId === undefined ? {} : { requestId };
        })(),
      });
      let result: Result;
      try {
        result = await dependencies.execute(context, args, options);
      } catch (error) {
        settleObservation(dependencies.mcpErrorClassOf(error));
        throw error;
      }
      if (result.result.case !== "error") {
        settleObservation();
        return result;
      }
      settleObservation(dependencies.takeMcpExecErrorClass(args.toolCallId ?? ""));
      try {
        const note = await surfaceNeedsAuthCard(providerIdentifier);
        if (note != null && hasMcpErrorMessage(result.result.value)) {
          result.result.value.error = `${result.result.value.error}\n${note}`;
        }
      } catch (cardError) {
        dependencies.reportDiagnostic({ kind: "mcp_connect_card_failed", errorClass: dependencies.errorLogTag(cardError) });
      }
      return result;
    },
    surfaceNeedsAuthCard,
  };
}

export function wrapTurnShellExecutorForAudit<Context, Args extends { readonly command: string }, Result>(
  base: { execute(context: Context, args: Args, options: unknown): Result },
  dependencies: {
    readonly assertNoPendingApproval: () => void;
    readonly auditShellCommand: (kind: "foreground" | "background", command: string, surface: "user_machine") => void;
  },
  kind: "foreground" | "background",
) {
  return {
    execute(context: Context, args: Args, options: unknown): Result {
      dependencies.assertNoPendingApproval();
      dependencies.auditShellCommand(kind, args.command, "user_machine");
      return base.execute(context, args, options);
    },
  };
}

type TurnLocalResourceEntry = readonly [
  RemoteResource<unknown, RemoteExecManager>,
  unknown,
];

export interface TurnLocalResourceProjectionInput {
  readonly baseAccessor: ResourceAccessor<RemoteExecManager>;
  readonly subagentSessions: Map<string, SubagentSession>;
  readonly createSubagentRunner: (
    agentId: string,
    args: SubagentAdapterArgs,
  ) => SubagentSession;
  readonly subagentDispatcher: SubagentDispatcher;
  readonly reviewSubagentLaunch?: (
    context: unknown,
    args: SubagentAdapterArgs,
  ) => Promise<{ readonly allowed: boolean; readonly reason: string }>;
  /** Exact per-turn launch-review inputs; installed only after the final accessor exists. */
  readonly subagentReview?: TurnSubagentLaunchReviewInput;
  readonly requestContext: RequestContextProvider;
  /** Workflow-derived skills are resolved per request-context execution. */
  readonly resolveAgentSkills?: () => AgentSkill[];
  readonly includeTranscripts: boolean;
  readonly autoReviewEnforceEnabled: boolean;
  readonly smartModeClassifierExecutor?: Executor<
    SmartModeClassifierArgs,
    SmartModeClassifierResult
  >;
  readonly shellStreamExecutor: StreamExecutor<ShellArgs, ShellStream>;
  readonly backgroundShellExecutor: Executor<
    BackgroundShellSpawnArgs,
    BackgroundShellSpawnResult
  >;
  readonly autoReviewGate: {
    readonly assertNoPendingApproval: () => void;
  };
  readonly actionAuditor: {
    readonly record: (record: unknown) => void;
  };
  readonly agentId: string;
  readonly now?: () => number;
  readonly mcp?: TurnMcpProjectionInput;
}

export interface TurnSubagentLaunchReviewInput {
  readonly isSubagentRunner: boolean;
  readonly mode: SandAutoReviewMode;
  readonly agentId: string;
  readonly autoReviewGate: {
    readonly assertNoPendingApproval: () => void;
  };
  readonly autoReviewController?: Pick<SandAutoReviewController, "requestApproval">;
  readonly getApprovalExpiryPolicy?: () => SandAutoReviewExpiryPolicy;
  readonly personalInstructions?: InstructionPermissions;
  readonly userAutoRunInstructions?: InstructionPermissions;
  readonly projectAutoRunInstructions?: InstructionPermissions;
  readonly getActiveStateHandler?: () => unknown;
  readonly extractConversationContext?: (
    context: Context,
    stateHandler: unknown,
  ) => Promise<SmartModeClassifierConversationMessage[]>;
  readonly workspacePaths?: readonly string[];
  readonly reportShadowFailure?: (error: unknown) => void;
  readonly suspendToolExecutionTimeout?: <T>(
    context: Context,
    operation: () => Promise<T>,
  ) => Promise<T>;
}

function isTurnContext(value: unknown): value is Context {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    readonly signal?: unknown;
    readonly get?: unknown;
    readonly withCancel?: unknown;
  };
  return typeof candidate.signal === "object"
    && candidate.signal !== null
    && typeof candidate.get === "function"
    && typeof candidate.withCancel === "function";
}

/**
 * Creates the immutable launch-review callback. The callback is intentionally
 * built from the final CombinedResourceAccessor: classifier lookup, active
 * state, approval, expiry, and cancellation are all per-run identities.
 */
export function createTurnSubagentLaunchReviewer(
  input: TurnSubagentLaunchReviewInput & {
    readonly resourceAccessor: ResourceAccessor<RemoteExecManager>;
  },
): ((
  context: unknown,
  args: SubagentAdapterArgs,
) => Promise<{ readonly allowed: boolean; readonly reason: string }>) | undefined {
  if (input.isSubagentRunner || input.mode === "off") return undefined;
  return async (context, args) => {
    if (!isTurnContext(context)) {
      return {
        allowed: false,
        reason: "Auto-review requires a live turn context.",
      };
    }
    const target = buildSandSubagentLaunchReviewTarget({
      prompt: args.prompt,
      subagentType: args.subagentType,
      ...(args.readonly === undefined ? {} : { readonly: args.readonly }),
      resume: args.resumeAgentId !== undefined && args.resumeAgentId.length > 0,
    });
    if (target === undefined) return { allowed: true, reason: "" };
    input.autoReviewGate.assertNoPendingApproval();
    return reviewSandSubagentAction({
      ctx: context,
      target,
      toolCallId: args.toolCallId,
      signal: context.signal,
      options: {
        mode: input.mode,
        agentId: input.agentId,
        ...(input.autoReviewController === undefined
          ? {}
          : { autoReviewController: input.autoReviewController }),
        ...(input.personalInstructions === undefined
          ? {}
          : { personalInstructions: input.personalInstructions }),
        ...(input.userAutoRunInstructions === undefined
          ? {}
          : { userAutoRunInstructions: input.userAutoRunInstructions }),
        ...(input.projectAutoRunInstructions === undefined
          ? {}
          : { projectAutoRunInstructions: input.projectAutoRunInstructions }),
        ...(input.getApprovalExpiryPolicy === undefined
          ? {}
          : { getApprovalExpiryPolicy: input.getApprovalExpiryPolicy }),
        classify: async (classifyContext, classifyTarget, mode, toolCallId) =>
          await runSandAutoReviewClassifier({
            ctx: classifyContext,
            resourceAccessor: input.resourceAccessor,
            toolCallId,
            mode,
            buildTarget: () => buildSandSubagentRiskTarget({
              target: classifyTarget,
              ...(input.personalInstructions === undefined
                ? {}
                : { personalInstructions: input.personalInstructions }),
              ...(input.userAutoRunInstructions === undefined
                ? {}
                : { userAutoRunInstructions: input.userAutoRunInstructions }),
              ...(input.projectAutoRunInstructions === undefined
                ? {}
                : { projectAutoRunInstructions: input.projectAutoRunInstructions }),
            }),
            loadConversationContext: async () => {
              const stateHandler = input.getActiveStateHandler?.();
              if (
                stateHandler === undefined
                || input.extractConversationContext === undefined
              ) return [];
              return input.extractConversationContext(classifyContext, stateHandler);
            },
            ...(input.workspacePaths === undefined
              ? {}
              : { workspacePaths: input.workspacePaths }),
            errorReason: SAND_SUBAGENT_CLASSIFIER_ERROR_REASON,
          }),
        ...(input.reportShadowFailure === undefined
          ? {}
          : { reportShadowFailure: input.reportShadowFailure }),
        ...(input.suspendToolExecutionTimeout === undefined
          ? {}
          : { suspendToolExecutionTimeout: input.suspendToolExecutionTimeout }),
      },
    }).then(result => ({
      allowed: result.allowed,
      reason: result.reason ?? "",
    }));
  };
}

export interface TurnMcpForTurn {
  readonly createExecutor: (
    persistImage: unknown,
    spillLargeText: unknown,
    auditIdentity: { readonly agentId: string },
  ) => Executor<McpArgs, McpResult>;
  readonly createStateExecutor: () => Executor<
    McpStateExecArgs,
    McpStateExecResult
  >;
  readonly resolveNeedsAuthSlot?: (
    providerIdentifier: string,
  ) => Promise<{ readonly serverName: string; readonly serverId: string } | null>;
}

export interface TurnMcpProjectionInput {
  readonly mcpForTurn: TurnMcpForTurn;
  readonly persistImage: unknown;
  readonly textSpiller: unknown;
  readonly isSubagentRunner: boolean;
  readonly beginObservation: (
    args: {
      readonly toolCallId: string;
      readonly connector: string;
      readonly requestId?: string | undefined;
    },
  ) => (errorClass?: string) => void;
  readonly boundedConnectorTag: (providerIdentifier: string) => string;
  readonly mcpErrorClassOf: (error: unknown) => string;
  readonly takeMcpExecErrorClass: (toolCallId: string) => string | undefined;
  readonly emitConnectorCard: (emission: TurnScopedConnectorCardEmission) => void;
  readonly ackToken?: string | undefined;
  readonly cancelThisRun: TurnAgentScope["cancelThisRun"];
  readonly reportDiagnostic: (event: {
    readonly kind: "mcp_connect_card_failed";
    readonly errorClass: string;
  }) => void;
  readonly errorLogTag: (error: unknown) => string;
  /** Exact caller-supplied MCP discovery/call options; no defaults are synthesized. */
  readonly mcpMeta?: Omit<TurnMcpMetaToolFactoryInput, "resourceAccessor">;
}

export interface TurnLocalResourceProjection {
  readonly adapter: SandSubagentHostAdapter;
  readonly subagentRegistry: SubagentRegistry;
  readonly localEntries: readonly TurnLocalResourceEntry[];
  readonly resourceAccessor: CombinedResourceAccessor<RemoteExecManager>;
  /** True only when this turn has no supplied MCP executor/state projection. */
  readonly mcpEntriesPending: boolean;
}

function createTurnShellAudit(
  input: Pick<TurnLocalResourceProjectionInput, "actionAuditor" | "agentId" | "now">,
) {
  return (kind: "foreground" | "background", command: string): void => {
    input.actionAuditor.record({
      agentId: input.agentId,
      occurredAtMs: (input.now ?? Date.now)(),
      action: {
        kind: "shellCommand",
        command,
        shellKind: kind,
        target: "user_machine",
      },
    });
  };
}

/**
 * Builds the local resource set for one turn. Every implementation is fresh
 * and keyed by the real resource symbol; the remote accessor remains the
 * fallback. Supplied MCP entries are appended in executor/state order, while
 * absent MCP remains an explicit fail-closed fallback.
 */
export function createTurnLocalResourceProjection(
  input: TurnLocalResourceProjectionInput,
): TurnLocalResourceProjection {
  const adapter = new SandSubagentHostAdapter(
    input.subagentSessions,
    input.createSubagentRunner,
    input.subagentDispatcher,
  );

  const subagentExecutor = createSubagentExecutor(adapter);
  const requestContextExecutor = new SandRequestContextExecutor(
    input.requestContext,
    input.includeTranscripts,
    input.autoReviewEnforceEnabled,
    input.resolveAgentSkills,
  );
  const subagentRegistry = new SubagentRegistry();
  const auditShellCommand = createTurnShellAudit(input);
  const shellStreamExecutor = wrapTurnShellExecutorForAudit(
    input.shellStreamExecutor,
    {
      assertNoPendingApproval: input.autoReviewGate.assertNoPendingApproval,
      auditShellCommand: (kind, command) => auditShellCommand(kind, command),
    },
    "foreground",
  );
  const backgroundShellExecutor = wrapTurnShellExecutorForAudit(
    input.backgroundShellExecutor,
    {
      assertNoPendingApproval: input.autoReviewGate.assertNoPendingApproval,
      auditShellCommand: (kind, command) => auditShellCommand(kind, command),
    },
    "background",
  );
  const localEntries: TurnLocalResourceEntry[] = [
    resourceEntry(subagentExecutorResource, subagentExecutor),
    resourceEntry(requestContextExecutorResource, requestContextExecutor),
    resourceEntry(subagentRegistryResource, subagentRegistry),
  ];
  if (input.smartModeClassifierExecutor !== undefined) {
    localEntries.push(
      resourceEntry(
        smartModeClassifierExecutorResource,
        input.smartModeClassifierExecutor,
      ),
    );
  }
  if (input.mcp !== undefined) {
    const mcpExecutor = input.mcp.mcpForTurn.createExecutor(
      input.mcp.persistImage,
      input.mcp.textSpiller,
      { agentId: input.agentId },
    );
    const guardedMcpExecutor = createTurnMcpExecutorGuard({
      isSubagentRunner: input.mcp.isSubagentRunner,
      assertNoPendingApproval: input.autoReviewGate.assertNoPendingApproval,
      execute: (
        context: Context,
        args: McpArgs,
        options?: ExecutorOptions,
      ) => mcpExecutor.execute(context, args, options),
      beginObservation: input.mcp.beginObservation,
      boundedConnectorTag: input.mcp.boundedConnectorTag,
      mcpErrorClassOf: input.mcp.mcpErrorClassOf,
      takeMcpExecErrorClass: input.mcp.takeMcpExecErrorClass,
      resolveNeedsAuthSlot: input.mcp.mcpForTurn.resolveNeedsAuthSlot,
      emitConnectorCard: emission => input.mcp?.emitConnectorCard({
        ...emission,
        ...(input.mcp.ackToken === undefined
          ? {}
          : { ackToken: input.mcp.ackToken }),
        cancelThisRun: input.mcp.cancelThisRun,
      }),
      reportDiagnostic: input.mcp.reportDiagnostic,
      errorLogTag: input.mcp.errorLogTag,
    });
    localEntries.push(
      resourceEntry(mcpExecutorResource, guardedMcpExecutor),
      resourceEntry(
        mcpStateExecutorResource,
        input.mcp.mcpForTurn.createStateExecutor(),
      ),
    );
  }
  localEntries.push(
    resourceEntry(shellStreamExecutorResource, shellStreamExecutor),
    resourceEntry(backgroundShellExecutorResource, backgroundShellExecutor),
  );
  const resourceAccessor = new CombinedResourceAccessor(
    input.baseAccessor,
    localEntries,
  );
  const launchReviewer = input.subagentReview === undefined
    ? input.reviewSubagentLaunch
    : createTurnSubagentLaunchReviewer({
      ...input.subagentReview,
      resourceAccessor,
    });
  if (launchReviewer !== undefined) {
    adapter.setLaunchReviewer(launchReviewer);
  }
  return {
    adapter,
    subagentRegistry,
    localEntries,
    resourceAccessor,
    mcpEntriesPending: input.mcp === undefined,
  };
}

export function createTurnAgentComposition(
  host: TurnAgentCompositionHost,
) {
  let subagentConfigsForRun: readonly unknown[] | undefined;

  function buildSubagentConfigsForRun(): readonly unknown[] | undefined {
    if (host.isSubagentRunner) return undefined;
    const configs = [...(host.getSubagentConfigs?.() ?? [])];
    if (host.toolHost.remoteBoxHasDesktop && host.toolHost.getRemoteBoxAvailable()) {
      const browserUseOffered = host.isBrowserUseSubagentEnabled?.() === true;
      configs.push(createSandComputerUseSubagentConfig({ browserUseOffered }));
      if (browserUseOffered) configs.push(createSandBrowserUseSubagentConfig());
    }
    if (host.isSystemPromptOverridden !== true && host.isMultitaskEnabled?.() === true) {
      const executor = createSandExecutorSubagentConfig();
      const generalPurposeIndex = configs.findIndex((config) => {
        const hostName = host.getSubagentTypeName?.(config);
        if (hostName !== undefined) return hostName === "generalPurpose";
        if (typeof config !== "object" || config === null || !("subagent_type" in config)) return false;
        const subagentType = config.subagent_type;
        if (typeof subagentType !== "object" || subagentType === null || !("type" in subagentType)) return false;
        const type = subagentType.type;
        if (typeof type !== "object" || type === null || !("case" in type)) return false;
        if (type.case === "unspecified") return true;
        return type.case === "custom" &&
          "value" in type &&
          typeof type.value === "object" &&
          type.value !== null &&
          "name" in type.value &&
          type.value.name === "generalPurpose";
      });
      if (generalPurposeIndex >= 0) configs.splice(generalPurposeIndex, 1, executor);
      else configs.push(executor);
    }
    return configs;
  }

  function buildAgentForRunFromInput(
    input: TurnAgentBuildForRunInput,
  ): BuiltTurnAgentForRun {
    return buildAgentForRun(input);
  }

  const getProductionReadiness = (): TurnAgentProductionReadiness =>
    getTurnAgentProductionReadiness(host.toolHost, {
      multitaskPerTurnProjectionAvailable: host.isMultitaskEnabled?.() === true,
    });

  return {
    buildAgentForRun: buildAgentForRunFromInput,
    getProductionReadiness,
    buildSubagentConfigsForRun,
    getSubagentConfigsForRun:
      (): readonly unknown[] | undefined => subagentConfigsForRun,
  };
}
