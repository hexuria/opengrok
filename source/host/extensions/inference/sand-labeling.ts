import type { Context } from "../../../packages/context/core.js";
import { conversationIdKey, requestIdKey } from "../../../packages/chat-inference-proto/client.js";
import { coreMessageToProto } from "../../../packages/chat-inference-proto/converters.js";
import { InferenceService } from "../../../packages/proto/generated/aiserver/v1/inference_connect.js";
import {
  AgentFollowupCategorizationRequest,
  AgentPostTurnLabelingRequest,
} from "../../../packages/proto/generated/aiserver/v1/inference_pb.js";
import {
  createSandCursorBackendClient,
  type SandInferenceOptions,
} from "../../../shared/node/cursor-backend/cursor-inference.js";
import { errorLogTag } from "../../../shared/errors.js";
import { reportHostDiagnostic } from "../../host-diagnostics.js";

export const SAND_AGENT_MODE = "sand-agent";
export interface LabelMessage { providerOptions?: { cursor?: { inferenceReason?: string } }; [key: string]: unknown }
export interface LabelingClient {
  recordFollowupClassification(request: AgentFollowupCategorizationRequest): Promise<unknown>;
  recordPostTurnLabeling(request: AgentPostTurnLabelingRequest): Promise<unknown>;
}
export interface PromptExecutor {
  appendMessages(messages: LabelMessage | readonly LabelMessage[]): unknown;
  getState(): unknown;
  getMessages(): readonly LabelMessage[];
  clearMessages(): void;
  stream(...args: readonly unknown[]): unknown;
}

export function createSandLabelingClient(options: Omit<SandInferenceOptions, "backendUrl">): LabelingClient {
  const client = createSandCursorBackendClient(InferenceService, options) as unknown as {
    recordAgentFollowupClassification(request: AgentFollowupCategorizationRequest): Promise<unknown>;
    recordAgentPostTurnLabeling(request: AgentPostTurnLabelingRequest): Promise<unknown>;
  };
  return {
    recordFollowupClassification: (request) => client.recordAgentFollowupClassification(request),
    recordPostTurnLabeling: (request) => client.recordAgentPostTurnLabeling(request),
  };
}

function logLabelingError(label: string, error: unknown): void {
  reportHostDiagnostic({ kind: "labeling_failed", stage: label, errorClass: errorLogTag(error) });
}

const lastRequestIdByConversation = new Map<string, string>();

export function wrapExecutorWithSandFollowupLabeling(
  executor: PromptExecutor,
  client: LabelingClient,
  modelName: string,
  recordedRequestIds = new Set<string>(),
): PromptExecutor {
  return {
    appendMessages(messages) { executor.appendMessages(messages); return this; },
    getState: () => executor.getState(),
    getMessages: () => executor.getMessages(),
    clearMessages: () => executor.clearMessages(),
    stream(...args) {
      const [ctx, invocationId, tools, options] = args as [Context, unknown, unknown, unknown];
      const result = executor.stream(ctx, invocationId, tools, options);
      try {
        const conversationId = ctx.get(conversationIdKey);
        const requestId = ctx.get(requestIdKey);
        if (conversationId == null || conversationId === "" || requestId == null || requestId === "") return result;
        const messages = executor.getMessages();
        if (messages.length === 0 || messages.some((message) => message.providerOptions?.cursor?.inferenceReason === "agent-summarization")) return result;
        const previousRequestId = lastRequestIdByConversation.get(conversationId);
        if (lastRequestIdByConversation.get(conversationId) !== requestId) lastRequestIdByConversation.set(conversationId, requestId);
        if (previousRequestId == null || previousRequestId === "" || previousRequestId === requestId || recordedRequestIds.has(requestId)) return result;
        recordedRequestIds.add(requestId);
        const request = new AgentFollowupCategorizationRequest({
          requestId,
          replyingToRequestId: previousRequestId,
          messages: messages.map((message) => coreMessageToProto(message)),
          conversationId,
          agentMode: SAND_AGENT_MODE,
          modelName,
        });
        void client.recordFollowupClassification(request).catch((error) => logLabelingError("followup_classification", error));
      } catch (error) {
        logLabelingError("followup_classification_prepare", error);
      }
      return result;
    },
  };
}

export function wrapPromptSessionWithSandFollowupLabeling<T extends { getModelId(): string; getExecutor(state?: unknown): PromptExecutor }>(session: T, client: LabelingClient, modelName: string) {
  const recordedRequestIds = new Set<string>();
  return {
    getModelId: () => session.getModelId(),
    getExecutor: (state?: unknown) => wrapExecutorWithSandFollowupLabeling(session.getExecutor(state), client, modelName, recordedRequestIds),
  };
}

export function recordSandPostTurnLabeling(client: LabelingClient, args: { conversationId: string; requestId: string; modelName: string; messages: readonly LabelMessage[] }): void {
  if (args.messages.length === 0 || args.requestId.trim() === "" || args.conversationId.trim() === "") return;
  try {
    const request = new AgentPostTurnLabelingRequest({
      requestId: args.requestId,
      messages: args.messages.map((message) => coreMessageToProto(message)),
      conversationId: args.conversationId,
      agentMode: SAND_AGENT_MODE,
      modelName: args.modelName,
    });
    void client.recordPostTurnLabeling(request).catch((error) => logLabelingError("post_turn_labeling", error));
  } catch (error) {
    logLabelingError("post_turn_labeling_prepare", error);
  }
}
