import {
  AssistantMessage,
  ConversationStep,
  SubagentExecutionEnvironment,
  SubagentPersistedState,
  SubagentBackgroundReason,
  TaskError,
  TaskResult,
  TaskSuccess,
  TaskToolCall,
  ToolCall,
  type ConversationStep as ConversationStepValue,
  type SubagentPersistedState as SubagentPersistedStateValue,
} from "../../proto/generated/agent/v1/agent_pb.js";
import {
  ClientContinuationConfig,
  ForceBackgroundSubagentArgs,
  ForceBackgroundSubagentStatus,
  SubagentArgs,
  type SubagentResult,
} from "../../proto/generated/agent/v1/subagent_exec_pb.js";
import type { Context } from "../../context/core.js";
import { PrivacyCapability } from "../../redaction/classification.js";
import type { PrivacyMode } from "../../redaction/privacy-mode.js";
import { fromRedactedSelectedContext } from "../../redacted-protos/generated/agent/v1/selected_context_redacted.js";
import type { ResourceAccessor } from "../../agent-exec/resource-provider.js";
import type { RemoteExecManager } from "../../agent-exec/remote.js";
import { forceBackgroundSubagentExecutorResource } from "../../agent-exec/subagent-control.js";
import { subagentExecutorResource } from "../../agent-exec/subagent.js";
import { getConversationGroupId, getConversationId } from "../utils/request-id.js";
import { isGeminiVideoSubagentType, getSubagentTypeName } from "./core/subagent/subagent-config.js";
import {
  buildClientSubagentAttachmentsContext,
  type TaskRawArguments,
  type TaskSubagentResolution,
} from "./task-subagent-preparation.js";
import {
  buildCloudSubagentPersistedState,
  type TaskTargetMachine,
} from "./task-cluster-internal.js";
import {
  RUNNING_SUBAGENT_FOLLOWUP_ERROR,
  RUNNING_SUBAGENT_INTERRUPT_RETRY_HINT,
} from "../../agent-exec/subagent.js";
import { createStringResult, type TextResult } from "../../chat-inference/prompt-executor.js";
import { WriteIterableClosedError } from "../../utils/writable-iterable.js";

const SUBAGENT_STREAM_CLOSED_ERROR =
  "The subagent's connection closed before it finished (the run was torn down mid-flight). This is usually transient — please try again.";

export interface TaskResultRenderingOptions {
  readonly enableJobCompletionNotifications?: boolean;
  readonly hideAsyncSubagentTaskNotifications?: boolean;
  readonly enableAgentChatLinks?: boolean;
}

function extractFinalSummaryFromSteps(steps: readonly ConversationStepValue[]): string | undefined {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step?.message.case !== "toolCall") continue;
    const tool = step.message.value.tool;
    if (tool.case !== "sendFinalSummaryToolCall" && tool.case !== "communicateUpdateToolCall") continue;
    const summary = tool.value.args?.finalSummary?.trim();
    if (summary !== undefined && summary.length > 0) return summary;
  }
  return undefined;
}

function getTaskSuccessResultText(
  taskSuccess: TaskSuccess,
  options?: TaskResultRenderingOptions,
): string {
  const lastAssistantOutput = [...taskSuccess.conversationSteps]
    .reverse()
    .map((step) => (step.message.case === "assistantMessage" ? step.message.value?.text : undefined))
    .find((text) => text !== undefined);
  const responseBody = lastAssistantOutput ?? "No output";
  if (options?.hideAsyncSubagentTaskNotifications !== true) {
    const finalSummary = extractFinalSummaryFromSteps(taskSuccess.conversationSteps);
    if (finalSummary !== undefined) {
      return [
        "response:",
        "<user_visible_high_level_summary>",
        finalSummary,
        "</user_visible_high_level_summary>",
        "<response>",
        responseBody,
        "</response>",
      ].join("\n");
    }
  }
  if (lastAssistantOutput !== undefined && lastAssistantOutput.includes("<response>") && lastAssistantOutput.includes("</response>")) {
    return ["response:", lastAssistantOutput].join("\n");
  }
  return ["response:", "<response>", responseBody, "</response>"].join("\n");
}

export function formatSubagentBackgroundMessage(
  reason: SubagentBackgroundReason,
  transcriptPath: string | undefined,
  options?: TaskResultRenderingOptions,
): string {
  let intro: string;
  switch (reason) {
    case SubagentBackgroundReason.USER_REQUEST:
      intro = "The user manually backgrounded the subagent. It is still running; you can continue with other work.";
      break;
    case SubagentBackgroundReason.QUEUED_FOLLOW_UP:
      intro = RUNNING_SUBAGENT_FOLLOWUP_ERROR;
      break;
    case SubagentBackgroundReason.AGENT_REQUEST:
    case SubagentBackgroundReason.UNSPECIFIED:
      intro = "Subagent is running in the background.";
      break;
    default:
      intro = "Subagent is running in the background.";
  }
  const displayTranscriptPath = transcriptPath?.trim();
  if (!displayTranscriptPath) return intro;
  if (options?.enableJobCompletionNotifications === true) {
    return `${intro} If needed, you can monitor its output by tailing the transcript at: ${displayTranscriptPath}. When you end your turn, you will be automatically sent the subagent's final response upon its completion, so do not wait for it - either end your turn or work on something else.\nDo NOT mention the transcript path to the user. Do NOT try to predict the subagent's response before it replies.`;
  }
  return `${intro} You can monitor its output by tailing the transcript at: ${displayTranscriptPath}. Do not mention the transcript path to the user.`;
}

export function renderTaskResultToString(
  taskResult: TaskResult,
  options?: TaskResultRenderingOptions,
): string {
  const enableAgentChatLinks = options?.enableAgentChatLinks ?? true;
  const chatLinkExample = (agentId: string): string =>
    options?.hideAsyncSubagentTaskNotifications === true
      ? `\`[Name](${agentId})\`. Don't use a generic label such as \`[agent]\`, \`[worker]\`, or \`[subagent]\`. For cloud subagents, when the agent has edited code, link to \`[Review](${agentId}#changes)\`, or, if you know the exact added and deleted line counts, \`[Review +A −D](${agentId}#changes)\`, replacing A and D with those counts. Never write A or D literally. Use \`[Try Live](${agentId}#desktop)\` only when the agent used computer use`
      : `\`[label](${agentId})\``;
  switch (taskResult.result.case) {
    case "success": {
      const taskSuccess = taskResult.result.value;
      const agentIdInfo = taskSuccess.agentId
        ? `\n\nAgent ID: ${taskSuccess.agentId} (can be used with the \`resume\` parameter to send a follow-up after it completes${enableAgentChatLinks ? `, or to link to this agent/subagent in user-facing text with ${chatLinkExample(taskSuccess.agentId)}` : ""})`
        : "";
      const suffixInfo = taskSuccess.resultSuffix ? `\n\n${taskSuccess.resultSuffix}` : "";
      if (taskSuccess.backgroundReason !== SubagentBackgroundReason.UNSPECIFIED) {
        return `${formatSubagentBackgroundMessage(taskSuccess.backgroundReason, taskSuccess.transcriptPath, options)}${agentIdInfo}${suffixInfo}`;
      }
      return `This is the output of the subagent:\n\n${getTaskSuccessResultText(taskSuccess, options)}${agentIdInfo}${suffixInfo}`;
    }
    case "error":
      return `Error: ${taskResult.result.value.error}`;
    case undefined:
      return "Unknown error";
    default:
      throw new Error(`Unhandled result case: ${taskResult.result}`);
  }
}

export function createTaskToolCall(taskTool: TaskToolCall): ToolCall {
  return new ToolCall({ tool: { case: "taskToolCall", value: taskTool } });
}

export function serializeError(error: unknown): ToolCall {
  const errorMessage = error instanceof Error ? error.message : String(error);
  return createTaskToolCall(new TaskToolCall({
    result: new TaskResult({ result: { case: "error", value: new TaskError({ error: errorMessage }) } }),
  }));
}

export interface ClientContinuationPolicy {
  readonly idleThreshold: number;
  readonly maxLoops?: number;
  readonly continuationMessage: string | ((args: { isEscapeHatch: boolean; idleCount: number; escapeToken: string }) => string);
}

interface ContinuationSubagentConfig {
  readonly subagent_type: Parameters<typeof getSubagentTypeName>[0];
  readonly continuationPolicy?: ClientContinuationPolicy;
}

export function buildClientContinuationConfig(
  config: ContinuationSubagentConfig,
): ClientContinuationConfig | undefined {
  const policy = config.continuationPolicy;
  if (!policy) return undefined;
  const msg = policy.continuationMessage;
  const nudgeMessage = typeof msg === "function" ? msg({ isEscapeHatch: false, idleCount: 0, escapeToken: "" }) : msg;
  const idleSentinel = 99999;
  const tokenSentinel = "___ESCAPE_TOKEN_PLACEHOLDER___";
  const escapeMessageTemplate = typeof msg === "function"
    ? msg({ isEscapeHatch: true, idleCount: idleSentinel, escapeToken: tokenSentinel })
      .replace(String(idleSentinel), "{idle_count}")
      .replace(tokenSentinel, "{escape_token}")
    : "You've made {idle_count} responses without tool calls. If you're done, respond with exactly: {escape_token}\nIf not, continue working.";
  const isCoordinatorAgent = getSubagentTypeName(config.subagent_type) === "coordinator-agent";
  return new ClientContinuationConfig({
    idleThreshold: policy.idleThreshold,
    maxLoops: policy.maxLoops ?? 0,
    nudgeMessage,
    escapeMessageTemplate,
    collectBackgroundChildren: isCoordinatorAgent,
    childrenCompletedMessageTemplate: isCoordinatorAgent
      ? "The following background agents have completed:\n\n{summaries}\n\nReview their results. If more work is needed, spawn additional workers. Otherwise, wrap up."
      : "",
  });
}

export function maybeAppendInterruptRetryHint(
  error: string,
  enableSubagentInterrupt: boolean,
  interruptAlreadyRequested: boolean,
): string {
  if (!enableSubagentInterrupt || interruptAlreadyRequested || error !== RUNNING_SUBAGENT_FOLLOWUP_ERROR) return error;
  return `${error}\n${RUNNING_SUBAGENT_INTERRUPT_RETRY_HINT}`;
}

export interface ClientTaskStateHandler {
  readonly turns: readonly ClientTaskTurnHandle[];
  getPrivacyMode(): PrivacyMode;
  persistSubagentState(ctx: Context, subagentId: string, subagentType: Parameters<typeof getSubagentTypeName>[0], state: SubagentPersistedStateValue): void;
}

export interface ClientTaskTurnHandle {
  get(ctx: Context): Promise<{ readonly userMessage?: { get(ctx: Context): Promise<{ readonly isSimulatedMsg?: boolean; readonly selectedContext?: unknown }> } }>;
}

export interface ClientTaskContextInjectionSignal {
  hasPendingUserInjections(): boolean;
  onUserInjectionAdmitted(listener: () => void): () => void;
}

export interface ClientTaskExecutionArgs {
  readonly ctx: Context;
  readonly toolCallId: string;
  readonly rawArgs: TaskRawArguments;
  readonly resolved: TaskSubagentResolution;
  readonly resourceAccessor: ResourceAccessor<RemoteExecManager>;
  readonly stateHandler: ClientTaskStateHandler;
  readonly parentModelName: string;
  readonly subagentCredentials?: SubagentArgs["credentials"];
  readonly attachedMediaUrlProvider?: import("../context-processing-video-data.js").AttachedMediaUrlProvider;
  readonly geminiVideoAttachedMediaUrlProvider?: ClientTaskExecutionArgs["attachedMediaUrlProvider"];
  readonly inlineVideoMaxBytes?: number;
  readonly signedUrlVideoMaxBytes?: number;
  readonly trustedVideoAttachmentRoots?: readonly string[];
  readonly enableSubagentInterrupt?: boolean;
  readonly interrupt?: boolean;
  readonly contextInjectionSignal?: ClientTaskContextInjectionSignal;
}

function getUserAttachedVideoPaths(ctx: Context, stateHandler: ClientTaskStateHandler): Promise<string[]> {
  return (async () => {
    const videoPaths = new Set<string>();
    for (const turnHandle of stateHandler.turns) {
      const turn = await turnHandle.get(ctx);
      const userMessage = turn.userMessage === undefined ? undefined : await turn.userMessage.get(ctx);
      if (userMessage?.isSimulatedMsg === true || userMessage?.selectedContext === undefined) continue;
      const selectedContext = fromRedactedSelectedContext(userMessage.selectedContext, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, {});
      for (const selectedVideo of selectedContext.selectedVideos) {
        const videoPath = selectedVideo.path.trim();
        if (videoPath.length > 0) videoPaths.add(videoPath);
      }
    }
    return [...videoPaths];
  })();
}

function isWritableIterableClosedError(error: unknown): boolean {
  return error instanceof WriteIterableClosedError || error instanceof Error && error.message.includes("WritableIterable is closed");
}

function modelParameters(value: readonly unknown[] | undefined): Array<{ id: string; value: string }> | undefined {
  if (value === undefined) return undefined;
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = Object.fromEntries(Object.entries(entry));
    return typeof record.id === "string" && typeof record.value === "string"
      ? [{ id: record.id, value: record.value }]
      : [];
  });
}

export async function executeClientSideTaskSubagent(args: ClientTaskExecutionArgs): Promise<TaskResult> {
  const {
    ctx,
    rawArgs,
    resolved,
    resourceAccessor,
    stateHandler,
    parentModelName,
    contextInjectionSignal,
  } = args;
  const startedAt = Date.now();
  const subagentExecutor = resourceAccessor.get(subagentExecutorResource);
  const continuationConfig = buildClientContinuationConfig(resolved.subagentConfig);
  const parentConversationId = getConversationId(ctx);
  const rootParentConversationId = getConversationGroupId(ctx);
  const runInBackground = rawArgs.run_in_background ?? resolved.subagentConfig.isBackground;
  let selectedContext;
  if ((rawArgs.file_attachments?.length ?? 0) > 0) {
    const userAttachedVideoPaths = await getUserAttachedVideoPaths(ctx, stateHandler);
    const attachmentOptions = {
      resolvedModelId: resolved.resolvedModelId,
      privacyMode: stateHandler.getPrivacyMode(),
      ...(isGeminiVideoSubagentType(resolved.subagentConfig.subagent_type)
        ? (args.geminiVideoAttachedMediaUrlProvider ?? args.attachedMediaUrlProvider) !== undefined
          ? { attachedMediaUrlProvider: args.geminiVideoAttachedMediaUrlProvider ?? args.attachedMediaUrlProvider }
          : {}
        : args.attachedMediaUrlProvider !== undefined ? { attachedMediaUrlProvider: args.attachedMediaUrlProvider } : {}),
      ...(parentConversationId !== undefined ? { conversationId: parentConversationId } : {}),
      ...(args.inlineVideoMaxBytes !== undefined ? { inlineVideoMaxBytes: args.inlineVideoMaxBytes } : {}),
      ...(args.signedUrlVideoMaxBytes !== undefined ? { signedUrlVideoMaxBytes: args.signedUrlVideoMaxBytes } : {}),
      userAttachedVideoPaths,
      ...(args.trustedVideoAttachmentRoots !== undefined ? { trustedVideoAttachmentRoots: args.trustedVideoAttachmentRoots } : {}),
    };
    selectedContext = await buildClientSubagentAttachmentsContext(ctx, rawArgs.file_attachments!, resourceAccessor, args.toolCallId, attachmentOptions);
  }
  let stopSteerHandoff: (() => void) | undefined;
  if (contextInjectionSignal !== undefined && runInBackground !== true) {
    let stopped = false;
    let handoffInFlight = false;
    let handoffAccepted = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const requestSteerHandoff = (): void => {
      if (stopped || handoffInFlight || handoffAccepted) return;
      handoffInFlight = true;
      void (async () => {
        try {
          const executor = resourceAccessor.get(forceBackgroundSubagentExecutorResource);
          const result = await executor.execute(ctx, new ForceBackgroundSubagentArgs({ toolCallId: args.toolCallId }));
          if (result.status === ForceBackgroundSubagentStatus.ACCEPTED) handoffAccepted = true;
        } catch {
          // A missing or torn-down handoff resource is intentionally fail-closed.
        } finally {
          handoffInFlight = false;
          if (!stopped && !handoffAccepted && retryTimer === undefined && contextInjectionSignal.hasPendingUserInjections()) {
            retryTimer = setTimeout(() => {
              retryTimer = undefined;
              requestSteerHandoff();
            }, 500);
          }
        }
      })();
    };
    stopSteerHandoff = () => {
      stopped = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      unsubscribe?.();
    };
    unsubscribe = contextInjectionSignal.onUserInjectionAdmitted(requestSteerHandoff);
    if (contextInjectionSignal.hasPendingUserInjections()) requestSteerHandoff();
  }
  try {
    let result: SubagentResult;
    try {
      result = await subagentExecutor.execute(ctx, new SubagentArgs({
        toolCallId: args.toolCallId,
        subagentType: resolved.typeName,
        modelId: resolved.resolvedModelId,
        prompt: rawArgs.prompt,
        readonly: resolved.useAskModeForSubagent,
        ...(resolved.isSelfForkRequested ? {} : resolved.subagentIdToResume !== undefined ? { resumeAgentId: resolved.subagentIdToResume } : {}),
        ...(resolved.isSelfForkRequested && parentConversationId !== undefined ? { forkAgentId: parentConversationId } : {}),
        ...(args.enableSubagentInterrupt === true && args.interrupt === true ? { interrupt: true } : {}),
        ...(runInBackground !== undefined ? { runInBackground } : {}),
        ...(continuationConfig !== undefined ? { continuationConfig } : {}),
        ...(rootParentConversationId !== undefined ? { rootParentConversationId } : {}),
        ...(parentConversationId !== undefined ? { parentConversationId } : {}),
        ...(selectedContext !== undefined ? { selectedContext } : {}),
        environment: resolved.effectiveEnvironment,
        ...(resolved.subagentIdToResume === undefined
          ? rawArgs.cloud_base_branch !== undefined
            ? { cloudBaseBranch: rawArgs.cloud_base_branch }
            : resolved.effectiveTargetMachine.type === "new_cloud_vm" && resolved.effectiveTargetMachine.base_branch !== undefined
              ? { cloudBaseBranch: resolved.effectiveTargetMachine.base_branch }
              : {}
          : rawArgs.cloud_base_branch !== undefined ? { cloudBaseBranch: rawArgs.cloud_base_branch } : {}),
        ...(modelParameters(resolved.resolvedModelParameters) !== undefined ? { modelParameters: modelParameters(resolved.resolvedModelParameters)! } : {}),
        ...(args.subagentCredentials !== undefined ? { credentials: args.subagentCredentials } : {}),
      }));
    } finally {
      stopSteerHandoff?.();
    }
    if (result.result.case === "error") {
      throw new Error(maybeAppendInterruptRetryHint(result.result.value.error || "Unknown subagent error", args.enableSubagentInterrupt === true, args.interrupt === true));
    }
    if (result.result.case !== "success") throw new Error("Unknown subagent result");
    const success = result.result.value;
    if (success.backgroundReason === SubagentBackgroundReason.QUEUED_FOLLOW_UP) {
      return new TaskResult({ result: { case: "error", value: new TaskError({ error: maybeAppendInterruptRetryHint(RUNNING_SUBAGENT_FOLLOWUP_ERROR, args.enableSubagentInterrupt === true, args.interrupt === true) }) } });
    }
    const lastAgentId = resolved.effectiveEnvironment === SubagentExecutionEnvironment.CLOUD
      ? success.agentId
      : success.agentId ?? resolved.subagentId;
    if (lastAgentId !== undefined && lastAgentId.length > 0) {
      const persistedState = resolved.effectiveEnvironment === SubagentExecutionEnvironment.CLOUD
        ? buildCloudSubagentPersistedState({ bcId: lastAgentId, modelId: resolved.resolvedModelId, ...(success.transcriptPath !== undefined ? { transcriptPath: success.transcriptPath } : {}), machine: resolved.effectiveTargetMachine })
        : new SubagentPersistedState({ modelId: resolved.resolvedModelId });
      stateHandler.persistSubagentState(ctx, lastAgentId, resolved.subagentConfig.subagent_type, persistedState);
    }
    const isBackground = success.backgroundReason !== SubagentBackgroundReason.UNSPECIFIED;
    const conversationSteps: ConversationStep[] = [];
    if (!isBackground && success.finalMessage) {
      conversationSteps.push(new ConversationStep({ message: { case: "assistantMessage", value: new AssistantMessage({ text: success.finalMessage }) } }));
    }
    return new TaskResult({ result: { case: "success", value: new TaskSuccess({ conversationSteps, durationMs: BigInt(Date.now() - startedAt), ...(lastAgentId !== undefined ? { agentId: lastAgentId } : {}), isBackground, backgroundReason: success.backgroundReason, ...(success.transcriptPath !== undefined ? { transcriptPath: success.transcriptPath } : {}) }) } });
  } catch (error) {
    const errorMessage = isWritableIterableClosedError(error)
      ? SUBAGENT_STREAM_CLOSED_ERROR
      : error instanceof Error ? error.message : String(error);
    return new TaskResult({ result: { case: "error", value: new TaskError({ error: errorMessage }) } });
  }
}

export function renderClientTaskResult(result: TaskResult, options?: TaskResultRenderingOptions): TextResult {
  return createStringResult(renderTaskResultToString(result, options), result.result.case === "error");
}
