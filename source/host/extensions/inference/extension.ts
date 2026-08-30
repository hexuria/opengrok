import type { HostInferenceOptions } from "./inference-service.js";
import type { SummarizationPromptSession } from "../../../packages/agent-summarization/summarization-handler.js";

export interface InferenceExtensionContext {
  deps: {
    auth: HostInferenceOptions["auth"] & { peekAccessToken(): string | null };
    experiments: HostInferenceOptions["experiments"];
    settings: HostInferenceOptions["settings"];
  };
  createPort(onApplied: () => void): AgentInferenceOwner;
  createWebSearch(args: unknown): unknown;
  createWebFetch(args: unknown): unknown;
}

export interface AgentPromptSession {
  getModelId(): string;
  getExecutor(state?: unknown): unknown;
}

export interface AgentPromptSessionOwner {
  createSession(
    onRequestId: (requestId: string) => void,
    options?: Readonly<Record<string, unknown>>,
  ): AgentPromptSession;
}

/**
 * The concrete per-turn inference owner consumed by the recovered
 * createTurnAgentRunContext boundary.  The cursor-session implementation
 * already owns these capabilities; keeping them on the extension port
 * preserves their identity instead of making the runner rediscover or
 * synthesize privacy/media behavior.
 */
export interface AgentInferenceOwner extends AgentPromptSessionOwner {
  resolvePrivacyMode(): Promise<unknown> | unknown;
  getGeminiVideoAttachedMediaUrlProvider?(): unknown | undefined;
  createSummarizationSession?(
    onRequestId: (requestId: string) => void,
    options?: Readonly<Record<string, unknown>>,
  ): SummarizationPromptSession;
}

/** Directly exposes the inference extension's package-Agent session owner. */
export function createAgentPromptSession(
  owner: AgentPromptSessionOwner,
  onRequestId: (requestId: string) => void,
  options?: Readonly<Record<string, unknown>>,
): AgentPromptSession {
  return owner.createSession(onRequestId, options);
}

export const inferenceExtension = { id: "inference", dependencies: ["auth", "experiments", "settings"] as const, start(context: InferenceExtensionContext) { const listeners = new Set<() => void>(); const notify = () => { for (const listener of [...listeners]) listener(); }; return { isReady: async () => process.env.SAND_AGENT_MOCK_RESPONSE != null || context.deps.auth.peekAccessToken() !== null, port: context.createPort(notify), onModelExperimentApplied(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); }, createWebSearch: (args: unknown) => context.createWebSearch(args), createWebFetch: (args: unknown) => context.createWebFetch(args) }; } };
