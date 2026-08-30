import { join } from "node:path";

import { SAND_COMPUTER_USE_MODEL_SELECTION, SAND_COMPUTER_USE_SUBAGENT_MODEL_ID, isSandAgentModelSelection, type SandAgentModelSelection } from "../../../shared/agents/sand-agent-model.js";
import { type InferenceReason } from "../../../packages/proto/generated/aiserver/v1/inference_pb.js";
import { createMockPromptExecutor } from "../../../packages/chat-inference/mock-prompt-executor.js";
import {
  createCursorInferencePromptSession,
  createSandAttachedMediaUrlProvider,
  resolveSandRunPrivacyMode,
  type RequestLineage,
} from "../../../shared/node/cursor-backend/cursor-inference.js";
import { createSandLabelingClient, recordSandPostTurnLabeling, wrapPromptSessionWithSandFollowupLabeling, type LabelMessage, type LabelingClient, type PromptExecutor } from "./sand-labeling.js";
import { selectSandExperimentTurnModel } from "./sand-model-experiment.js";
import type { SummarizationPromptSession } from "../../../packages/agent-summarization/summarization-handler.js";
import { SandSettingsStore } from "../../../shared/node/settings/sand-settings-store.js";
import { getSandRootDir } from "../../host-paths.js";
import { createProviderPromptSession } from "./provider-session.js";

export const SAND_DEFAULT_MODEL_ID = "grok-4.5";
export const SAND_DEFAULT_MODEL_SELECTION: SandAgentModelSelection = { modelId: SAND_DEFAULT_MODEL_ID, maxMode: true, parameters: [{ id: "effort", value: "high" }, { id: "fast", value: "true" }] };
export interface RequestedModel { modelId: string; maxMode?: boolean; parameters?: readonly { id: string; value: string }[] }
export interface SandSessionOptions { modelId?: string; isSummarizationSession?: boolean; isComputerUseSubagent?: boolean; isBrowserUseSubagent?: boolean }

function fromSelection(selection: SandAgentModelSelection): RequestedModel { return { modelId: selection.modelId, maxMode: selection.maxMode, parameters: selection.parameters.map((parameter) => ({ ...parameter })) }; }
function subagent(modelId: string): RequestedModel { return { modelId, maxMode: true }; }
export function resolveSandRequestedModel(inputs: { sessionOptions?: SandSessionOptions; envModelOverride?: string; storedDefaultModel?: SandAgentModelSelection; storedComputerUseModel?: unknown; storedBrowserUseModel?: unknown; experimentModelOverride?: SandAgentModelSelection }): RequestedModel {
  const { sessionOptions, envModelOverride, storedDefaultModel } = inputs, effectiveDefault = inputs.experimentModelOverride ?? storedDefaultModel, effectiveDefaultId = envModelOverride ?? effectiveDefault?.modelId ?? SAND_DEFAULT_MODEL_ID, subagentModelId = sessionOptions?.modelId;
  const computer = isSandAgentModelSelection(inputs.storedComputerUseModel) ? inputs.storedComputerUseModel : null, browser = isSandAgentModelSelection(inputs.storedBrowserUseModel) ? inputs.storedBrowserUseModel : null;
  if (sessionOptions?.isSummarizationSession === true && subagentModelId != null) return subagent(subagentModelId);
  if (sessionOptions?.isComputerUseSubagent === true) return fromSelection(computer ?? { ...SAND_COMPUTER_USE_MODEL_SELECTION, modelId: SAND_COMPUTER_USE_SUBAGENT_MODEL_ID });
  if (sessionOptions?.isBrowserUseSubagent === true && browser != null) return fromSelection(browser);
  if (subagentModelId != null && subagentModelId !== effectiveDefaultId) return subagent(subagentModelId);
  if (envModelOverride != null) return { modelId: envModelOverride };
  return fromSelection(effectiveDefault ?? SAND_DEFAULT_MODEL_SELECTION);
}
export interface SandMockToolCall {
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
}
export interface SandMockScript {
  readonly toolCalls: readonly SandMockToolCall[];
}
export function parseSandMockScript(raw: string): SandMockScript | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { return null; }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.sendMessage === "string" && record.sendMessage.length > 0) {
    return { toolCalls: [{ toolName: "SendMessage", args: { type: "text", content: record.sendMessage } }] };
  }
  if (!Array.isArray(record.toolCalls) || record.toolCalls.length === 0) return null;
  const toolCalls: SandMockToolCall[] = [];
  for (const value of record.toolCalls) {
    if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
    const call = value as Record<string, unknown>;
    if (typeof call.toolName !== "string" || call.toolName.length === 0 || call.args == null || typeof call.args !== "object" || Array.isArray(call.args)) return null;
    if (call.toolCallId !== undefined && (typeof call.toolCallId !== "string" || call.toolCallId.length === 0)) return null;
    toolCalls.push({ ...(typeof call.toolCallId === "string" ? { toolCallId: call.toolCallId } : {}), toolName: call.toolName, args: call.args as Record<string, unknown> });
  }
  return { toolCalls };
}

export function createScriptedMockSession(script: SandMockScript, modelId: string): { getExecutor(): PromptExecutor; getModelId(): string } {
  let callIndex = 0;
  const executor = createMockPromptExecutor(() => {
    const call = script.toolCalls[callIndex];
    callIndex += 1;
    return call === undefined
      ? { response: "", toolCalls: [] }
      : { response: "", toolCalls: [{ toolCallId: call.toolCallId ?? `mock-tool-${callIndex}`, toolName: call.toolName, args: call.args }] };
  });
  return {
    getExecutor: () => executor,
    getModelId: () => modelId
  };
}

export interface CursorPromptSession { getModelId(): string; getExecutor(state?: unknown): PromptExecutor }
export interface CursorSessionOptions extends SandSessionOptions { requestSource?: string; inferenceReason?: InferenceReason; lineage?: RequestLineage; skipLabeling?: boolean }
export interface CursorSandInferenceOptions {
  getAccessToken(...args: unknown[]): Promise<string>;
  getMachineId(): string;
  isGeminiVideoDeveloperApiEnabled?(): boolean;
  getDefaultModel?(): SandAgentModelSelection | undefined;
  getComputerUseModel?(): unknown;
  getBrowserUseModel?(): unknown;
  getModelExperimentState?(): Parameters<typeof selectSandExperimentTurnModel>[0]["state"];
  getConfiguredDefaultModel?(): SandAgentModelSelection | undefined;
  getConfiguredAutomationsModel?(): SandAgentModelSelection | undefined;
}
export interface CursorSandInference {
  resolvePrivacyMode(): Promise<unknown> | unknown;
  getGeminiVideoAttachedMediaUrlProvider(): unknown | undefined;
  createSession(onRequestId: (requestId: string) => void, sessionOptions?: CursorSessionOptions): CursorPromptSession | ReturnType<typeof createScriptedMockSession> | { getModelId(): string; getExecutor(): PromptExecutor };
  createSummarizationSession?(onRequestId: (requestId: string) => void, sessionOptions?: CursorSessionOptions): SummarizationPromptSession;
  recordPostTurnLabeling(args: { conversationId: string; requestId: string; modelName: string; messages: readonly LabelMessage[] }): void;
}
export function createCursorSandInference(options: CursorSandInferenceOptions): CursorSandInference {
  let labelingClient: LabelingClient | undefined;
  const auth = { getAccessToken: options.getAccessToken, getMachineId: options.getMachineId };
  const attachedMedia = createSandAttachedMediaUrlProvider(auth);
  const getLabelingClient = (): LabelingClient => labelingClient ??= createSandLabelingClient(auth);
  return {
    resolvePrivacyMode: () => resolveSandRunPrivacyMode(auth),
    getGeminiVideoAttachedMediaUrlProvider: () => options.isGeminiVideoDeveloperApiEnabled?.() === true ? attachedMedia : undefined,
    createSession(onRequestId, sessionOptions) {
      const mockResponse = process.env.SAND_AGENT_MOCK_RESPONSE;
      if (mockResponse != null) {
        const modelId = sessionOptions?.modelId ?? "sand-mock", script = parseSandMockScript(mockResponse);
        if (script != null) return createScriptedMockSession(script, modelId);
        return { getExecutor: () => createMockPromptExecutor(() => ({ response: mockResponse, chunkSize: 8 })), getModelId: () => modelId };
      }
      const routedProvider = new SandSettingsStore(join(getSandRootDir(), "settings.json")).getInferenceProvider();
      // Computer-use / box-local sessions stay on the Cursor host path so a
      // provider switch cannot take the computer offline. Chat turns for
      // Claude/Codex are owned by the desktop coordinator.
      if (routedProvider !== "cursor" && sessionOptions?.isComputerUseSubagent !== true && sessionOptions?.isBrowserUseSubagent !== true && sessionOptions?.isSummarizationSession !== true) {
        return createProviderPromptSession(routedProvider) as unknown as CursorPromptSession;
      }
      const experimentState = options.getModelExperimentState?.(), requestSource = sessionOptions?.requestSource;
      const experimentModelOverride = selectSandExperimentTurnModel({ ...(experimentState === undefined ? {} : { state: experimentState }), ...(requestSource === undefined ? {} : { requestSource }), readConfiguredDefaultModel: () => options.getConfiguredDefaultModel?.(), readConfiguredAutomationsModel: () => options.getConfiguredAutomationsModel?.() });
      const storedDefaultModel = options.getDefaultModel?.(), storedComputerUseModel = options.getComputerUseModel?.(), storedBrowserUseModel = options.getBrowserUseModel?.();
      const requestedModel = resolveSandRequestedModel({ ...(sessionOptions == null ? {} : { sessionOptions }), ...(process.env.SAND_AGENT_MODEL == null ? {} : { envModelOverride: process.env.SAND_AGENT_MODEL }), ...(storedDefaultModel == null ? {} : { storedDefaultModel }), ...(storedComputerUseModel === undefined ? {} : { storedComputerUseModel }), ...(storedBrowserUseModel === undefined ? {} : { storedBrowserUseModel }), ...(experimentModelOverride == null ? {} : { experimentModelOverride }) });
      const promptArgs: Parameters<typeof createCursorInferencePromptSession>[0] = {
        getAccessToken: options.getAccessToken,
        getMachineId: options.getMachineId,
        requestedModel,
        onRequestId,
        ...(options.isGeminiVideoDeveloperApiEnabled?.() === true && sessionOptions?.inferenceReason != null ? { inferenceReason: sessionOptions.inferenceReason } : {}),
        ...(sessionOptions?.lineage == null ? {} : { lineage: sessionOptions.lineage }),
      };
      const session = createCursorInferencePromptSession(promptArgs), skipLabeling = sessionOptions?.skipLabeling === true || sessionOptions?.isSummarizationSession === true || sessionOptions?.isComputerUseSubagent === true;
      return skipLabeling ? session : wrapPromptSessionWithSandFollowupLabeling(session, getLabelingClient(), requestedModel.modelId);
    },
    createSummarizationSession(onRequestId, sessionOptions) {
      return this.createSession(onRequestId, {
        ...(sessionOptions ?? {}),
        isSummarizationSession: true,
      }) as SummarizationPromptSession;
    },
    recordPostTurnLabeling: (args) => recordSandPostTurnLabeling(getLabelingClient(), args)
  };
}
