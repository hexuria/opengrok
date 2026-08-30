import { SAND_HIDDEN_PROMPT_MARKER } from "./sand-prompt-markers.js";
import {
  SummarizationHandler,
  type SummarizationPromptSession,
} from "../../packages/agent-summarization/summarization-handler.js";
export interface RecentUserMessage { readonly id: string; readonly text: string }
export function selectUnconfirmedUserMessages<T extends RecentUserMessage>(params: { recentUserMessages: readonly T[]; currentMessageId?: string; lastTurnUserMessageId?: string; hasConfirmedTurns: boolean }): T[] {
  if (!params.currentMessageId) return [];
  const currentIndex = params.recentUserMessages.findIndex((message) => message.id === params.currentMessageId);
  if (currentIndex <= 0) return [];
  let start: number;
  if (params.lastTurnUserMessageId) { const watermark = params.recentUserMessages.findIndex((message) => message.id === params.lastTurnUserMessageId); if (watermark < 0) return []; start = watermark + 1; }
  else if (!params.hasConfirmedTurns) start = 0;
  else return [];
  return start >= currentIndex ? [] : params.recentUserMessages.slice(start, currentIndex).filter((message) => message.text.trim().length > 0);
}

export function lastRepliedUserMessageId(
  entries: readonly { readonly kind: string; readonly role?: string; readonly id: string }[],
): string | undefined {
  let lastUser: string | undefined;
  let lastReplied: string | undefined;
  for (const entry of entries) {
    if (entry.kind === "message" && entry.role === "user") lastUser = entry.id;
    if (entry.kind === "send-message" && lastUser != null) lastReplied = lastUser;
  }
  return lastReplied;
}

export function userMessagesAfterLastReply<T extends { readonly id: string }>(
  messages: readonly T[],
  lastRepliedId: string | undefined,
): T[] {
  if (lastRepliedId == null) return [...messages];
  const index = messages.findIndex((message) => message.id === lastRepliedId);
  return index < 0 ? [...messages] : messages.slice(index + 1);
}
export function buildUnansweredQuestionsNote(prompts: { skipped: readonly string[]; dismissed: readonly string[] }): string {
  const clean = (values: readonly string[]) => values.map((value) => value.trim()).filter(Boolean), skipped = clean(prompts.skipped), dismissed = clean(prompts.dismissed), sections: string[] = [];
  if (skipped.length === 1) sections.push(`Earlier you prompted the user and they moved on without responding ("${skipped[0]}") \u2014 treat it as skipped. Don't wait for or assume a response; continue with what you already know, and only ask again if you still genuinely need it.`);
  else if (skipped.length > 1) { const list = skipped.map((prompt) => `\n- "${prompt}"`).join(""); sections.push(`Earlier you prompted the user for these and they moved on without responding \u2014 treat them as skipped:${list}\nDon't wait for or assume responses; continue with what you already know, and only ask again if you still genuinely need to.`); }
  if (dismissed.length === 1) sections.push(`The user dismissed your question ("${dismissed[0]}") without answering \u2014 they'd rather not respond. Don't ask it again or wait for an answer; continue with what you already know and decide yourself.`);
  else if (dismissed.length > 1) { const list = dismissed.map((prompt) => `\n- "${prompt}"`).join(""); sections.push(`The user dismissed these questions without answering \u2014 they'd rather not respond:${list}\nDon't ask them again or wait for answers; continue with what you already know and decide yourself.`); }
  return sections.length === 0 ? "" : `${SAND_HIDDEN_PROMPT_MARKER}${sections.join("\n\n")}`;
}
export function toSafeTokenCount(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0; }
export function awaitBlockUntilMs(awaitCall: { args?: { blockUntilMs?: unknown } }): number { return awaitCall.args?.blockUntilMs == null ? 0 : Number(awaitCall.args.blockUntilMs); }
export function classifyCompletedAwaitOutcome(awaitCall: any): "slept_full" | "completed_early" { const inner = awaitCall.result?.result?.case === "success" ? awaitCall.result.result.value.awaitResult : undefined; if (inner?.case === "complete") return inner.value.taskId.trim().length === 0 ? "slept_full" : "completed_early"; if (inner?.case === "stillRunning") return inner.value.regexMatch?.length > 0 ? "completed_early" : "slept_full"; return "completed_early"; }
export interface Usage { readonly promptTokens: number; readonly completionTokens: number; readonly totalTokens: number; readonly [key: string]: unknown }
export function sanitizeUsage<T extends Record<string, unknown>>(usage: T): T & Usage { const promptTokens = toSafeTokenCount(usage.promptTokens), completionTokens = toSafeTokenCount(usage.completionTokens); return { ...usage, promptTokens, completionTokens, totalTokens: toSafeTokenCount(usage.totalTokens) || promptTokens + completionTokens }; }
const contextWindowByModelForHostLifetime = new Map<string, number>();
export function lastReportedContextWindow(modelId: string): number | undefined { return contextWindowByModelForHostLifetime.get(modelId); }
export function sanitizeExtendedUsage(usage: Record<string, unknown>, modelId: string) { const maxTokens = toSafeTokenCount(usage.maxTokens); if (maxTokens > 0) contextWindowByModelForHostLifetime.set(modelId, maxTokens); return { inputTokens: toSafeTokenCount(usage.inputTokens), outputTokens: toSafeTokenCount(usage.outputTokens), cacheReadTokens: toSafeTokenCount(usage.cacheReadTokens), cacheWriteTokens: toSafeTokenCount(usage.cacheWriteTokens), maxTokens }; }
export async function* sanitizeFullStream(stream: AsyncIterable<any>): AsyncIterable<any> { let error: unknown; for await (const part of stream) { if (error != null) continue; if (part.type === "error") { error = part.error instanceof Error ? part.error : new Error(String(part.error)); continue; } yield part.type === "finish" ? { ...part, usage: sanitizeUsage(part.usage) } : part; } if (error != null) throw error; }
export function sanitizeStreamResult<T extends { fullStream: AsyncIterable<any>; response: Promise<{ modelId: string }>; usage: Promise<Record<string, unknown>>; extendedUsage: Promise<Record<string, unknown>> }>(result: T, modelId: string, onResolvedModelId?: (modelId: string) => void) { return { ...result, fullStream: sanitizeFullStream(result.fullStream), response: result.response.then((response) => { const resolved = response.modelId.trim(); if (resolved) onResolvedModelId?.(resolved); return response; }), usage: result.usage.then(sanitizeUsage), extendedUsage: result.extendedUsage.then((usage) => sanitizeExtendedUsage(usage, modelId)) }; }
export function createSandResolvedModelTracker() { let sequence = 0; const accepted = new Map<string, { requestSequence: number; modelId: string }>(); return { get: (requested: string) => accepted.get(requested)?.modelId, beginRequest: (requested: string) => { const requestSequence = ++sequence; return (modelId: string): boolean => { const prior = accepted.get(requested); if (prior != null && prior.requestSequence >= requestSequence) return false; accepted.set(requested, { requestSequence, modelId }); return true; }; } }; }
export function sanitizePromptExecutorUsage<T extends { stream(...args: any[]): any }>(executor: T, modelId: string, tracking?: { tracker: ReturnType<typeof createSandResolvedModelTracker>; onResolvedModelId(modelId: string): void }): T { return new Proxy(executor, { get(target, property, receiver) { if (property !== "stream") return Reflect.get(target, property, receiver); return (...args: any[]) => { const accept = tracking?.tracker.beginRequest(modelId); return sanitizeStreamResult(target.stream(...args), modelId, (resolved) => { if (accept?.(resolved) === true) tracking?.onResolvedModelId(resolved); }); }; } }); }
export function sanitizePromptSessionUsage<T>(session: { getExecutor(state: unknown): T; getModelId(): string }, tracker = createSandResolvedModelTracker(), onResolvedModelId?: (modelId: string) => void) { let resolvedModelId = tracker.get(session.getModelId()); return { getExecutor: (state: unknown) => sanitizePromptExecutorUsage(session.getExecutor(state) as T & { stream(...args: any[]): any }, session.getModelId(), { tracker, onResolvedModelId: (modelId) => { resolvedModelId = modelId; onResolvedModelId?.(modelId); } }), getExecutorWithoutResolvedModelTracking: (state: unknown) => sanitizePromptExecutorUsage(session.getExecutor(state) as T & { stream(...args: any[]): any }, session.getModelId()), getModelId: () => session.getModelId(), getResolvedModelId: () => resolvedModelId }; }
const DEPRECATED = new Set(["grok-4.5-medium", "grok-4.5-fast-medium", "grok-4.5-high", "grok-4.5-fast-high", "grok-4.5-xhigh", "grok-4.5-fast-xhigh"]);
export function shouldUseSandSelfSummary(modelId: string): boolean { const model = modelId.split("#", 1)[0] ?? modelId, parts = model.startsWith("XAIEXTERNAL--") ? model.split("--") : [], external = parts.length === 3 && parts[1] ? parts[2] : undefined; return model === "grok-4.5" || DEPRECATED.has(model) || model === "cursor-grok-4.5" || model.startsWith("cursor-grok-4.5-") || model === "vega" || model.startsWith("vega-") || model.startsWith("accounts/anysphere/models/vega") || model.startsWith("cursor/vega") || model === "v9" || model.startsWith("v9-") || external === "v9" || external?.startsWith("v9-") === true; }
export const SAND_SUMMARIZATION_MAX_PROMPT_CHARS = 2_800_000;
export function createSandSummarizationHandler(
  summarizationSession: SummarizationPromptSession,
  options?: { preserveLatestImage?: boolean },
): SummarizationHandler {
  return new SummarizationHandler(summarizationSession, false, {
    enableReduceInputsRetry: true,
    maxPromptChars: SAND_SUMMARIZATION_MAX_PROMPT_CHARS,
    maxOutputTokens: 32_000,
    preserveLatestImage: options?.preserveLatestImage ?? false,
  });
}
