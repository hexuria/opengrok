import {
  TaskError,
  TaskResult,
  TaskToolCall,
  TaskToolCallDelta,
  ToolCall,
  ToolCallDelta,
} from "../../proto/generated/agent/v1/agent_pb.js";
import type { Context } from "../../context/core.js";
import { PrivacyCapability } from "../../redaction/classification.js";
import type { ResourceAccessor } from "../../agent-exec/resource-provider.js";
import type { RemoteExecManager } from "../../agent-exec/remote.js";
import { createReadonlyResourceAccessor } from "../../agent-exec/readonly-resource-accessor.js";
import { subagentRegistryResource } from "./subagent-registry.js";
import { SubagentArgs } from "../../proto/generated/agent/v1/subagent_exec_pb.js";
import { parentRequestIdKey, requestModelNameKey } from "../utils/request-id.js";
import { NoopConversationActionReceiver } from "../../agent-core/conversation-actions/remote.js";
import { Responses } from "../../agent-core/interaction-queries.js";
import { toRedactedInteractionListener } from "../../agent-core/redacted-interaction-listener.js";
import { AnysphereAgent } from "../index.js";
import {
  fromRedactedConversationStateStructure,
  toRedactedConversationAction,
  toRedactedConversationStateStructure,
} from "../../redacted-protos/generated/agent/v1/agent_redacted.js";
import { createZodAgentTool, withSafeParsedArgs } from "./common.js";
import { isPromptVisibleDescription } from "./core.js";
import { getTaskToolName } from "./task-tool-name.js";
import {
  buildTaskParametersSchema,
  buildTaskToolDescriptionParts,
} from "./task-tool-schema.js";
import {
  assertCloudOnlyTaskArgsAllowed,
  assertMachineAndLegacyArgsNotBothSet,
  type TaskSubagentModelConfig,
} from "./task-cluster-internal.js";
import {
  buildPreparedTaskToolHookInput,
  prepareTaskSubagent,
  resolveTaskSubagentConfig,
  type TaskRawArguments,
  type TaskResolutionParentState,
  type TaskSubagentResolution,
} from "./task-subagent-preparation.js";
import {
  executeClientSideTaskSubagent,
  renderTaskResultToString,
} from "./task-client.js";
import {
  handleSubagentExecutionError,
  handleSubagentRunStreamError,
  processSubagentIterationSuccess,
  type TaskSubagentCompletionContext,
  type TaskSubagentIterationState,
} from "./task-subagent-completion.js";
import { createStringResult } from "../../chat-inference/prompt-executor.js";
import { SubagentModelForcePolicy } from "./subagent-model-force-policy.js";

type Any = any;

interface ToolExecutionMetaLike {
  readonly toolCallId: string;
  readonly [key: string]: unknown;
}

interface TaskToolOptions {
  readonly readonlyShellEnabled?: boolean;
  readonly allowCustomModelId?: boolean;
  readonly includeExploreSubagent?: boolean;
  readonly enableExecuteHookExec?: boolean;
  readonly subagentModels: Any;
  readonly subagentModelsInUserInfo?: boolean;
  readonly subagentInheritGuidance?: boolean;
  readonly isModelBlocked?: (modelId: string) => boolean;
  readonly isModelValid?: (modelId: string) => boolean;
  readonly parentMaxMode?: boolean;
  readonly forceModelId?: string;
  readonly subagentModelForcePolicy?: Any;
  readonly compareModelCosts?: (candidateModelId: string, parentModelId: string) => number;
  readonly requiresMaxMode?: (modelId: string) => Promise<boolean>;
  readonly requireServerSideSubagent?: boolean;
  readonly configuredSteps?: readonly string[];
  readonly useClientSideSubagent?: boolean;
  readonly enableCloudAsyncSubagents?: boolean;
  readonly defaultSubagentsRunInBackground?: boolean;
  readonly enableMultitaskMode?: boolean;
  readonly enableJobCompletionNotifications?: boolean;
  readonly hideAsyncSubagentTaskNotifications?: boolean;
  readonly enableAgentChatLinks?: boolean;
  readonly enableExploreParentModelInheritance?: boolean;
  readonly subagentExperimentGroup?: string;
  readonly subagentCredentials?: SubagentArgs["credentials"];
  readonly attachedMediaUrlProvider?: Any;
  readonly geminiVideoAttachedMediaUrlProvider?: Any;
  readonly inlineVideoMaxBytes?: number;
  readonly signedUrlVideoMaxBytes?: number;
  readonly trustedVideoAttachmentRoots?: readonly string[];
  readonly allowResumeSelfFork?: boolean;
  readonly enableSubagentInterrupt?: boolean;
  readonly environmentParamForSubagent?: boolean;
  readonly requestedEnvironmentBuildParamForSubagent?: boolean;
  readonly cloudSubagentTargeting?: boolean;
  readonly parentRequestedModelName?: string;
  readonly parentModelParameters?: readonly unknown[];
}

interface TaskToolConfig {
  readonly agentConfig: Any;
  readonly promptSession: Any;
  readonly summarizationHandler: Any;
  readonly logSubagentStart?: (args: Any) => unknown;
}

interface ParentStateHandler extends TaskResolutionParentState {
  readonly turns: readonly Any[];
  getBlobStore(): Any;
  getPrivacyMode(): Any;
  persistSubagentState(ctx: Context, subagentId: string, subagentType: Any, state: Any): void;
  computeNewStructure(ctx: Context): Promise<Any>;
}

function createTaskToolCall(taskTool: TaskToolCall): ToolCall {
  return new ToolCall({ tool: { case: "taskToolCall", value: taskTool } });
}

function serializeTaskError(error: unknown): ToolCall {
  return createTaskToolCall(new TaskToolCall({
    result: new TaskResult({
      result: { case: "error", value: new TaskError({ error: error instanceof Error ? error.message : String(error) }) },
    }),
  }));
}

class StreamingTaskInteractionListener {
  constructor(private readonly interactionHandler: Any, private readonly toolCallId: string) {}

  async sendUpdate(ctx: Context, update: Any): Promise<void> {
    await this.interactionHandler.emitToolCallDelta(ctx, this.toolCallId, new ToolCallDelta({
      delta: {
        case: "taskToolCallDelta",
        value: new TaskToolCallDelta({ interactionUpdate: update }),
      },
    }));
  }

  async query(_ctx: Context, query: Any): Promise<Any> {
    switch (query.query.case) {
      case "webSearchRequestQuery": return Responses.webSearchApproved(query.id);
      case "webFetchRequestQuery": return Responses.webFetchApproved(query.id);
      case "generateImageRequestQuery": return Responses.generateImageApproved(query.id);
      default: throw new Error(`Unhandled interaction query type: ${query.query.case}`);
    }
  }
}

function createSubagentAgentConfig(args: {
  readonly baseAgentConfig: Any;
  readonly subagentConfig: TaskSubagentModelConfig;
  readonly overriddenModelId: string;
  readonly subagentInstanceId: string;
}): Any {
  const { baseAgentConfig, subagentConfig, overriddenModelId, subagentInstanceId } = args;
  const featureFlags = baseAgentConfig.featureFlags === undefined
    ? undefined
    : { ...baseAgentConfig.featureFlags, glassMetaParentAgent: false };
  return {
    ...baseAgentConfig,
    modelId: overriddenModelId,
    featureFlags,
    isCloudMetaAgentParent: false,
    preTurnAssistantNotice: undefined,
    getNamedAgentSelfDocument: undefined,
    userInfoDisplayOptions: subagentConfig.subagent_type.type.case === "computerUse"
      ? { ...baseAgentConfig.userInfoDisplayOptions, displaySkills: false, displayCursorRules: false, computerUseSubagentSurface: true, excludeAgentTranscripts: true }
      : baseAgentConfig.userInfoDisplayOptions,
    toolsGenerator: (props: Any) => {
      const nextProps = { ...props, isCloudMetaAgentParent: false, subagentInstanceId, subagentConfig };
      const tools = baseAgentConfig.toolsGenerator(nextProps);
      return tools;
    },
    systemPromptGenerator: (props: Any, toolSet: Any) => {
      const nextProps = { ...props, isCloudMetaAgentParent: false, subagentType: subagentConfig.subagent_type };
      const runtimeSubagentConfig = subagentConfig as Any;
      const basePrompt = runtimeSubagentConfig.systemPromptOverride
        ? runtimeSubagentConfig.systemPromptOverride(nextProps, toolSet, { subagentInstanceId, baseSystemPromptGenerator: baseAgentConfig.systemPromptGenerator })
        : baseAgentConfig.systemPromptGenerator(nextProps, toolSet);
      const reminder = runtimeSubagentConfig.systemReminder?.(toolSet)?.trim();
      return reminder ? `<system_reminder>\n${reminder}\n</system_reminder>\n\n${basePrompt}` : basePrompt;
    },
    messageHistoryModifier: (subagentConfig as Any).messageHistoryModifier ?? undefined,
  };
}

function createParentStateAccessor(stateHandler: ParentStateHandler): TaskResolutionParentState {
  return {
    restoreSubagentState: (ctx, subagentId) => stateHandler.restoreSubagentState(ctx, subagentId),
    resolveSubagentId: subagentId => stateHandler.resolveSubagentId?.(subagentId),
    getSubagentIdToResume: (typeName, mode) => stateHandler.getSubagentIdToResume?.(typeName, mode),
    getConversationState: async ctx => fromRedactedConversationStateStructure(
      await stateHandler.computeNewStructure(ctx),
      PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
      undefined,
    ),
  };
}

async function runServerTaskSubagent(args: {
  readonly ctx: Context;
  readonly interactionHandler: Any;
  readonly meta: ToolExecutionMetaLike;
  readonly rawArgs: TaskRawArguments;
  readonly resolved: TaskSubagentResolution;
  readonly parentState: TaskResolutionParentState;
  readonly stateHandler: ParentStateHandler;
  readonly resourceAccessor: ResourceAccessor<RemoteExecManager>;
  readonly getTaskToolConfig: (modelId: string, subagentType: Any) => Promise<TaskToolConfig>;
  readonly parentModelInfo: Any;
  readonly options: TaskToolOptions;
}): Promise<TaskResult> {
  const { ctx, interactionHandler, meta, rawArgs, resolved, parentState, stateHandler, resourceAccessor, getTaskToolConfig, parentModelInfo, options } = args;
  const prepared = await (async () => {
    const preparedValue = await prepareTaskSubagent({
      resolved,
      ctx,
      rawArgs,
      meta,
      parentState,
      resourceAccessor,
      parentModelInfo,
      ...(options.subagentCredentials !== undefined ? { subagentCredentials: options.subagentCredentials } : {}),
      enableExecuteHookExec: options.enableExecuteHookExec,
      configuredSteps: options.configuredSteps,
      readonlyShellEnabled: options.readonlyShellEnabled,
      toolName: getTaskToolName(parentModelInfo),
      privacyMode: stateHandler.getPrivacyMode(),
      attachedMediaUrlProvider: options.attachedMediaUrlProvider,
      geminiVideoAttachedMediaUrlProvider: options.geminiVideoAttachedMediaUrlProvider,
      ...(options.inlineVideoMaxBytes !== undefined ? { inlineVideoMaxBytes: options.inlineVideoMaxBytes } : {}),
      ...(options.signedUrlVideoMaxBytes !== undefined ? { signedUrlVideoMaxBytes: options.signedUrlVideoMaxBytes } : {}),
    });
    const latestConfig = await getTaskToolConfig(preparedValue.resolvedModelId, preparedValue.subagentType);
    return {
      prepared: preparedValue,
      taskToolConfig: latestConfig,
    };
  })();
  const preparedValue = prepared.prepared;
  const taskToolConfig = prepared.taskToolConfig;
  const subagentId = resolved.subagentId;
  const subagentRequestId = preparedValue.subagentRequestId;
  const [subagentCtx, cancelSubagent] = ctx.withDetached().withCancel();
  const registry = resourceAccessor.get(subagentRegistryResource);
  registry.register(subagentId, { cancel: cancelSubagent }, meta.toolCallId);
  const timeoutMs = (resolved.subagentConfig as Any).executionTimeoutMs as number | undefined;
  const timeout = timeoutMs !== undefined && timeoutMs > 0
    ? setTimeout(() => registry.cancel(subagentId, { intentional: true, reason: `Subagent exceeded execution timeout of ${timeoutMs}ms` }), timeoutMs)
    : undefined;
  const interactionListener = toRedactedInteractionListener(
    new StreamingTaskInteractionListener(interactionHandler, meta.toolCallId),
    stateHandler.getPrivacyMode(),
  );
  const baseAgentConfig = taskToolConfig.agentConfig;
  const agentConfig = createSubagentAgentConfig({
    baseAgentConfig,
    subagentConfig: resolved.subagentConfig,
    overriddenModelId: resolved.resolvedModelId,
    subagentInstanceId: subagentRequestId,
  });
  const agent = new AnysphereAgent(
    agentConfig,
    taskToolConfig.promptSession,
    interactionListener,
    resolved.effectiveReadonly
      ? createReadonlyResourceAccessor(resourceAccessor, !(options.readonlyShellEnabled === true))
      : resourceAccessor,
    stateHandler.getBlobStore(),
    taskToolConfig.summarizationHandler,
    new NoopConversationActionReceiver(),
  );
  const completionCtx: TaskSubagentCompletionContext = {
    subagentId,
    subagentRequestId,
    toolCallId: meta.toolCallId,
    typeName: resolved.typeName,
    analyticsSubagentType: resolved.analyticsSubagentType,
    overriddenModelId: resolved.resolvedModelId,
    effectiveReadonly: resolved.effectiveReadonly,
    useAskModeForSubagent: resolved.useAskModeForSubagent,
    initialTurnsCount: preparedValue.initialTurnsCount,
    executionStartTime: Date.now(),
    isParallel: registry.size > 1,
    parentModelName: parentModelInfo.modelName,
    ...(resolved.subagentConfig.resultSuffix !== undefined ? { resultSuffix: resolved.subagentConfig.resultSuffix } : {}),
    ...(preparedValue.selectedContext !== undefined ? { selectedContext: preparedValue.selectedContext } : {}),
    ...(resolved.subagentConfig.plugin !== undefined ? { plugin: resolved.subagentConfig.plugin } : {}),
    ...(resolved.subagentConfig.marketplace !== undefined ? { marketplace: resolved.subagentConfig.marketplace } : {}),
    ...(resolved.subagentConfig.pluginId !== undefined ? { pluginId: resolved.subagentConfig.pluginId } : {}),
    ...(resolved.subagentConfig.marketplaceId !== undefined ? { marketplaceId: resolved.subagentConfig.marketplaceId } : {}),
    rawArgsPrompt: rawArgs.prompt,
    rawArgsDescription: rawArgs.description ?? "",
  };
  const iterState: TaskSubagentIterationState = { loopCount: 0, runStreamCompleted: false, subagentStopCalled: false };
  const completionDeps = {
    ctx,
    blobStore: stateHandler.getBlobStore(),
    registry,
    hookContext: { resourceAccessor, toolCallId: meta.toolCallId, subagentId, subagentType: resolved.typeName, overriddenModelId: resolved.resolvedModelId, parentCtx: ctx },
    enableTaskToolHooksExec: options.enableExecuteHookExec === true,
    configuredSteps: options.configuredSteps ?? [],
    toolName: getTaskToolName(parentModelInfo),
    postToolUseHookInput: buildPreparedTaskToolHookInput(preparedValue),
  };
  let state = preparedValue.conversationState;
  let action = preparedValue.initialAction;
  if (state === undefined || action === undefined) throw new Error("Prepared subagent launch is missing state or action");
  try {
    while (true) {
      iterState.runStreamCompleted = false;
      const turnsAtStart = iterState.loopCount === 0 ? preparedValue.initialTurnsCount : state!.turns.length;
      try {
        state = await agent.runStream(
          subagentCtx.with(requestModelNameKey, resolved.resolvedModelId).with(parentRequestIdKey, resolved.parentRequestId),
          toRedactedConversationStateStructure(state, stateHandler.getPrivacyMode()),
          toRedactedConversationAction(action, stateHandler.getPrivacyMode()),
          [],
          async () => {},
        );
        iterState.runStreamCompleted = true;
      } catch (error) {
        await handleSubagentRunStreamError(error, state!, iterState, completionCtx, completionDeps, subagentCtx.canceled, registry.lastAbortOptions);
      }
      const iteration = await processSubagentIterationSuccess(
        state!,
        turnsAtStart,
        iterState,
        completionCtx,
        completionDeps,
        (persistCtx, persistId, _type, persistedState) => stateHandler.persistSubagentState(persistCtx, persistId, resolved.subagentConfig.subagent_type, persistedState),
        resolved.subagentConfig.subagent_type,
      );
      if (!iteration.shouldContinue) return iteration.finalResult ?? new TaskResult({ result: { case: "error", value: new TaskError({ error: "Subagent completed without a result" }) } });
      action = iteration.nextAction!;
    }
  } catch (error) {
    return await handleSubagentExecutionError(error, state, iterState, completionCtx, completionDeps, subagentCtx.canceled, registry.lastAbortOptions);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function createTaskTool(
  resourceAccessor: ResourceAccessor<RemoteExecManager>,
  getTaskToolConfig: (modelId: string, subagentType: Any) => Promise<TaskToolConfig>,
  parentModelInfo: Any,
  stateHandler: ParentStateHandler,
  subagentConfigs: readonly TaskSubagentModelConfig[],
  options: TaskToolOptions,
): Record<string, unknown> {
  const canUseClientSideSubagent = options.useClientSideSubagent === true && options.requireServerSideSubagent !== true;
  const allowResumeSelfFork = (canUseClientSideSubagent || options.enableCloudAsyncSubagents === true) && options.allowResumeSelfFork === true;
  const enableSubagentInterrupt = canUseClientSideSubagent && options.enableSubagentInterrupt === true;
  const includeRunInBackground = canUseClientSideSubagent || options.enableCloudAsyncSubagents === true;
  const defaultRunInBackground = includeRunInBackground && options.defaultSubagentsRunInBackground === true;
  const notificationHints = options.enableJobCompletionNotifications === true && includeRunInBackground;
  const { schemaTowardsModel, schemaForParsing } = buildTaskParametersSchema(subagentConfigs, {
    allowCustomModelId: options.allowCustomModelId === true,
    subagentModels: options.subagentModels,
    subagentModelsInUserInfo: options.subagentModelsInUserInfo === true,
    subagentInheritGuidance: options.subagentInheritGuidance === true,
    useClientSideSubagent: canUseClientSideSubagent,
    includeRunInBackgroundInTaskSchema: includeRunInBackground,
    defaultSubagentsRunInBackground: defaultRunInBackground,
    enableSubagentInterrupt,
    environmentParamForSubagent: options.environmentParamForSubagent === true,
    requestedEnvironmentBuildParamForSubagent: options.requestedEnvironmentBuildParamForSubagent === true,
    cloudSubagentTargeting: options.cloudSubagentTargeting === true,
    allowResumeSelfFork,
    enableMultitaskMode: options.enableMultitaskMode === true,
    taskToolNotificationHintsEnabled: notificationHints,
    hideAsyncSubagentTaskNotifications: options.hideAsyncSubagentTaskNotifications === true,
    enableAgentChatLinks: options.enableAgentChatLinks === true,
  });
  const toolName = getTaskToolName(parentModelInfo);
  const descriptionCache = new WeakMap<object, Map<boolean, string>>();
  const description = (props: Any, descriptionOptions: Any): string => {
    const catalogsInUserInfo = options.subagentModelsInUserInfo === true || !isPromptVisibleDescription(descriptionOptions);
    let byPlacement = descriptionCache.get(props);
    if (byPlacement?.has(catalogsInUserInfo)) return byPlacement.get(catalogsInUserInfo)!;
    const parts = buildTaskToolDescriptionParts({
      configs: subagentConfigs,
      defaultResumeMode: "DEFAULT",
      includeExploreSubagent: options.includeExploreSubagent === true,
      useClientSideSubagent: canUseClientSideSubagent,
      enableSubagentInterrupt,
      taskToolNotificationHintsEnabled: notificationHints,
      hideAsyncSubagentTaskNotifications: options.hideAsyncSubagentTaskNotifications === true,
      allowResumeSelfFork,
      enableAgentChatLinks: options.enableAgentChatLinks === true,
      subagentModels: options.subagentModels,
      subagentModelsInUserInfo: options.subagentModelsInUserInfo === true,
      subagentInheritGuidance: options.subagentInheritGuidance === true,
      catalogsInUserInfo,
      toolLabel: toolName,
      readToolName: props.allTools?.READ?.name,
      globToolName: props.allTools?.GLOB?.name,
      ...(options.subagentExperimentGroup !== undefined ? { subagentExperimentGroup: options.subagentExperimentGroup } : {}),
    });
    let full = parts.fullDescription;
    if (byPlacement === undefined) { byPlacement = new Map(); descriptionCache.set(props, byPlacement); }
    byPlacement.set(catalogsInUserInfo, full);
    return full;
  };
  const parse = (raw: Any): TaskRawArguments => {
    let parsedJson: Any;
    try { parsedJson = typeof raw === "string" ? JSON.parse(raw) : raw; }
    catch (error) { throw new Error(`Invalid arguments:\nargument: ${error instanceof Error ? error.message : "Failed to parse arguments"}`); }
    const result = schemaForParsing.safeParse(parsedJson);
    if (!result.success) throw new Error(`Invalid arguments:\n${result.error.errors.map((error: Any) => `${error.path.length > 0 ? error.path.join(".") : "argument"}: ${error.message}`).join("\n")}`);
    assertMachineAndLegacyArgsNotBothSet(result.data);
    assertCloudOnlyTaskArgsAllowed(result.data);
    if (result.data.resume?.trim().toLowerCase() === "self" && !allowResumeSelfFork) throw new Error('Invalid arguments:\nresume="self" is not available for this Task tool.');
    return result.data as TaskRawArguments;
  };
  const execute = async (ctx: Context, interactionHandler: Any, rawArgs: TaskRawArguments, meta: ToolExecutionMetaLike): Promise<TaskResult> => {
    const parentState = createParentStateAccessor(stateHandler);
    const resolved = await resolveTaskSubagentConfig({
      ctx,
      rawArgs,
      meta,
      subagentConfigs,
      parentState,
      parentModelInfo,
      options: {
        ...(options.forceModelId !== undefined ? { forceModelId: options.forceModelId } : {}),
        subagentModelForcePolicy: options.subagentModelForcePolicy ?? SubagentModelForcePolicy.None,
        ...(options.parentRequestedModelName !== undefined ? { parentRequestedModelName: options.parentRequestedModelName } : {}),
        ...(options.parentModelParameters !== undefined ? { parentModelParameters: options.parentModelParameters } : {}),
        parentMaxMode: options.parentMaxMode === true,
        subagentModels: options.subagentModels,
        isModelBlocked: options.isModelBlocked ?? (() => false),
        isModelValid: options.isModelValid ?? (() => true),
        ...(options.requiresMaxMode !== undefined ? { requiresMaxMode: options.requiresMaxMode } : {}),
        compareModelCosts: options.compareModelCosts ?? (() => 0),
        ...(options.enableExploreParentModelInheritance !== undefined ? { enableExploreParentModelInheritance: options.enableExploreParentModelInheritance } : {}),
      },
    });
    if (canUseClientSideSubagent) {
      return executeClientSideTaskSubagent({
        ctx,
        toolCallId: meta.toolCallId,
        rawArgs,
        resolved,
        resourceAccessor,
        stateHandler,
        parentModelName: parentModelInfo.modelName,
        ...(options.subagentCredentials !== undefined ? { subagentCredentials: options.subagentCredentials } : {}),
        attachedMediaUrlProvider: options.attachedMediaUrlProvider,
        geminiVideoAttachedMediaUrlProvider: options.geminiVideoAttachedMediaUrlProvider,
        ...(options.inlineVideoMaxBytes !== undefined ? { inlineVideoMaxBytes: options.inlineVideoMaxBytes } : {}),
        ...(options.signedUrlVideoMaxBytes !== undefined ? { signedUrlVideoMaxBytes: options.signedUrlVideoMaxBytes } : {}),
        ...(options.trustedVideoAttachmentRoots !== undefined ? { trustedVideoAttachmentRoots: options.trustedVideoAttachmentRoots } : {}),
        enableSubagentInterrupt,
        interrupt: (rawArgs as Any).interrupt,
        contextInjectionSignal: (meta as Any).contextInjectionSignal,
      });
    }
    try {
      return await runServerTaskSubagent({ ctx, interactionHandler, meta, rawArgs, resolved, parentState, stateHandler, resourceAccessor, getTaskToolConfig, parentModelInfo, options });
    } catch (error) {
      return new TaskResult({ result: { case: "error", value: new TaskError({ error: error instanceof Error ? error.message : String(error) }) } });
    }
  };
  return createZodAgentTool("TASK", {
    name: toolName,
    descriptionGenerator: description,
    parameters: schemaTowardsModel,
    prepareSubagent: async (ctx: Context, rawArgs: Any, meta: ToolExecutionMetaLike) => {
      const parsed = parse(rawArgs);
      const resolved = await resolveTaskSubagentConfig({
        ctx,
        rawArgs: parsed,
        meta,
        subagentConfigs,
        parentState: createParentStateAccessor(stateHandler),
        parentModelInfo,
        options: {
          ...(options.forceModelId !== undefined ? { forceModelId: options.forceModelId } : {}),
          subagentModelForcePolicy: options.subagentModelForcePolicy ?? SubagentModelForcePolicy.None,
          parentMaxMode: options.parentMaxMode === true,
          subagentModels: options.subagentModels,
          isModelBlocked: options.isModelBlocked ?? (() => false),
          isModelValid: options.isModelValid ?? (() => true),
          compareModelCosts: options.compareModelCosts ?? (() => 0),
        },
      });
      return await prepareTaskSubagent({ resolved, ctx, rawArgs: parsed, meta, parentState: createParentStateAccessor(stateHandler), resourceAccessor, parentModelInfo, ...(options.readonlyShellEnabled !== undefined ? { readonlyShellEnabled: options.readonlyShellEnabled } : {}), toolName, privacyMode: stateHandler.getPrivacyMode() });
    },
    execute: withSafeParsedArgs(schemaForParsing, execute, createTaskToolCall(new TaskToolCall())),
    render: async (_ctx: Context, result: TaskResult) => createStringResult(renderTaskResultToString(result, { enableJobCompletionNotifications: notificationHints, ...(options.hideAsyncSubagentTaskNotifications !== undefined ? { hideAsyncSubagentTaskNotifications: options.hideAsyncSubagentTaskNotifications } : {}), ...(options.enableAgentChatLinks !== undefined ? { enableAgentChatLinks: options.enableAgentChatLinks } : {}) }), result.result.case === "error"),
    serializeError: serializeTaskError,
  });
}
