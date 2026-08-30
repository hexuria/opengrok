import { randomUUID } from "node:crypto";
import { NoopInteractionListener } from "../../packages/agent-core/interaction-listener.js";
import { getRootParentRequestId } from "../../packages/agent/utils/request-id.js";
import { requestIdKey } from "../../packages/chat-inference-proto/client.js";
import type { Context } from "../../packages/context/core.js";
import { SubagentBackgroundReason } from "../../packages/proto/generated/agent/v1/agent_pb.js";
import type { AgentSkill } from "../../packages/proto/generated/agent/v1/agent_skills_pb.js";
import type { CursorRule } from "../../packages/proto/generated/agent/v1/cursor_rules_pb.js";
import {
  RequestContext,
  RequestContextEnv,
  RequestContextResult,
  RequestContextSuccess,
} from "../../packages/proto/generated/agent/v1/request_context_exec_pb.js";
import {
  getOutlineToolCallName,
  getOutlineToolCallStatus,
  getOutlineToolCallSummary,
  getToolCallActivityArgs,
  type OutlineToolCall,
} from "./conversation-outline.js";
import { computeSubagentRequestId, type SubagentLineage, type SubagentSession } from "./subagent-runtime.js";
import { turnUsageFromTurnEnded, type TurnEndedUsage } from "./turn-usage.js";
import { projectAgentToolCallToClientSideToolV2 } from "../extensions/transcript/client-side-tool-v2-projection.js";
export class SandSubagentDispatchError extends Error { override readonly name = "SandSubagentDispatchError"; }
export function deriveSandSubagentRequestLineage(ctx: Context, toolCallId: string): (SubagentLineage & { parentAgentToolCallId?: string }) | undefined { const parentRequestId = ctx.get(requestIdKey); if (parentRequestId == null || parentRequestId === "") return undefined; return { parentRequestId, rootParentRequestId: getRootParentRequestId(ctx) ?? parentRequestId, ...(toolCallId.length > 0 ? { parentAgentToolCallId: toolCallId } : {}) }; }
export interface RequestContextProvider { resolve(): { osVersion?: string; shell?: string; timeZone?: string; transcriptsFolder?: string }; resolveRules(): Promise<CursorRule[] | undefined> }
export class SandRequestContextExecutor {
  constructor(readonly requestContext: RequestContextProvider, readonly includeTranscripts: boolean, readonly autoReviewEnforceEnabled: boolean, readonly resolveAgentSkills?: () => AgentSkill[]) {}
  async execute(_ctx?: unknown, _args?: unknown): Promise<RequestContextResult> { const info = this.requestContext.resolve(), rules = await this.requestContext.resolveRules(); return new RequestContextResult({ result: { case: "success", value: new RequestContextSuccess({ requestContext: new RequestContext({ env: new RequestContextEnv({ osVersion: info.osVersion!, shell: info.shell!, timeZone: info.timeZone!, agentTranscriptsFolder: this.includeTranscripts ? info.transcriptsFolder! : undefined!, smartModeClassifierAutoModeEnabled: this.autoReviewEnforceEnabled }), rules: rules ?? [], rulesInfoComplete: rules !== undefined, agentSkills: this.resolveAgentSkills?.() ?? [] }) }) } }); }
}
export interface SubagentAdapterArgs { readonly resumeAgentId?: string; readonly subagentType: string; readonly toolCallId: string; readonly prompt: string; readonly readonly?: boolean; readonly selectedContext?: { selectedVideos?: readonly unknown[] } }
export interface SubagentDispatcher { isRunning(id: string): boolean; allocateComputerUseWindow(id: string): unknown | null; freeComputerUseWindow(id: string): void; dispatch(args: { subagentAgentId: string; subagentType: string; toolCallId: string; prompt: string; lineage?: SubagentLineage; run(): Promise<{ text: string; aborted?: boolean }> }): void }
export class SandSubagentHostAdapter {
  #reviewLaunch: ((ctx: unknown, args: SubagentAdapterArgs) => Promise<{ allowed: boolean; reason: string }>) | undefined;
  constructor(readonly sessions: Map<string, SubagentSession>, readonly createRunner: (id: string, args: SubagentAdapterArgs) => SubagentSession, readonly dispatcher: SubagentDispatcher) {}
  setLaunchReviewer(review: (ctx: unknown, args: SubagentAdapterArgs) => Promise<{ allowed: boolean; reason: string }>): void { this.#reviewLaunch = review; }
  async createOrResumeSession(_ctx: unknown, args: SubagentAdapterArgs): Promise<string> { if (args.resumeAgentId != null && this.sessions.has(args.resumeAgentId)) { if (this.dispatcher.isRunning(args.resumeAgentId)) throw new SandSubagentDispatchError("That background subagent is still running, so it can't be resumed yet — use MessageSubagent or StopSubagent while it runs."); return args.resumeAgentId; } const id = args.resumeAgentId ?? `subagent-${randomUUID()}`, computer = args.subagentType.replace(/[-_ ]/g, "").toLowerCase() === "computeruse"; if (computer && this.dispatcher.allocateComputerUseWindow(id) == null) throw new SandSubagentDispatchError("A computerUse subagent is already using the box's desktop. Only one can run at a time."); try { this.sessions.set(id, this.createRunner(id, args)); } catch (error) { if (computer) this.dispatcher.freeComputerUseWindow(id); throw error; } return id; }
  async runSession(ctx: unknown, agentId: string, args: SubagentAdapterArgs): Promise<{ status: "error"; error: string } | { status: "background"; backgroundReason: SubagentBackgroundReason; toolCallCount: 0 }> { const runner = this.sessions.get(agentId); if (runner == null) return { status: "error", error: `Unknown Grok Bot subagent: ${agentId}` }; if (this.dispatcher.isRunning(agentId)) return { status: "error", error: "That background subagent is already running." }; const review = await this.#reviewLaunch?.(ctx, args); if (review != null && !review.allowed) { this.releaseSession(agentId); return { status: "error", error: review.reason }; } const lineage = deriveSandSubagentRequestLineage(ctx as Context, args.toolCallId); this.dispatcher.dispatch({ subagentAgentId: agentId, subagentType: args.subagentType || "generalPurpose", toolCallId: args.toolCallId, prompt: args.prompt, ...(lineage == null ? {} : { lineage }), run: () => runner.run(args.prompt, { selectedVideos: args.selectedContext?.selectedVideos!, inferenceRequestId: (args.toolCallId.length > 0 ? computeSubagentRequestId(args.toolCallId) : undefined)!, ...(lineage == null ? {} : { lineage }) }) }); return { status: "background", backgroundReason: SubagentBackgroundReason.AGENT_REQUEST, toolCallCount: 0 }; }
  releaseSession(agentId: string): void { if (this.dispatcher.isRunning(agentId)) return; this.sessions.delete(agentId); this.dispatcher.freeComputerUseWindow(agentId); }
}
export interface ForwardedUpdate { readonly type: string; readonly [key: string]: unknown }
const SURFACE_UNRESOLVED_TOOL_CASES = new Set(["shellToolCall", "readToolCall", "awaitToolCall"]);
export class ForwardingInteractionListener extends NoopInteractionListener<{ readonly canceled?: boolean }> {
  constructor(readonly onUpdate: (event: ForwardedUpdate) => void, readonly observers: { onToolCall?: (phase: string, callId: string, toolCall: unknown) => void; resolveToolName?: (phase: string, callId: string, fallback: string) => string; onSurfaceUnresolvedPending?: (callId: string, update: ForwardedUpdate) => void; onSummaryLifecycle?: () => void } = {}) { super(); }
  async sendUpdate(ctx: { canceled?: boolean }, update: any): Promise<void> { await super.sendUpdate(ctx, update); switch (update.message.case) { case "textDelta": this.onUpdate({ type: "text-delta", text: update.message.value.text }); break; case "thinkingDelta": this.onUpdate({ type: "thinking-delta", text: update.message.value.text }); break; case "turnEnded": { const usage = turnUsageFromTurnEnded(update.message.value as TurnEndedUsage); this.onUpdate(usage != null ? { type: "turn-ended", usage } : { type: "turn-ended" }); break; } case "toolCallStarted": case "partialToolCall": case "toolCallCompleted": { const phase = update.message.case, callId = update.message.value.callId, toolCall = update.message.value.toolCall as OutlineToolCall | undefined; if (toolCall == null) break; this.observers.onToolCall?.(phase, callId, toolCall); const outlineName = getOutlineToolCallName(toolCall); const forwarded = { type: "tool-call", id: callId, name: this.observers.resolveToolName?.(phase, callId, outlineName) ?? outlineName, status: getOutlineToolCallStatus(phase, toolCall), summary: getOutlineToolCallSummary(toolCall), args: getToolCallActivityArgs(toolCall) }; this.onUpdate(forwarded); const typed = projectAgentToolCallToClientSideToolV2(phase, callId, toolCall as unknown as import("../../packages/proto/generated/agent/v1/agent_pb.js").ToolCall, update.message.value.modelCallId, forwarded.name); if (typed != null) this.onUpdate({ type: "client-side-tool-v2", update: typed }); if (forwarded.status === "pending" && SURFACE_UNRESOLVED_TOOL_CASES.has(forwarded.name)) this.observers.onSurfaceUnresolvedPending?.(callId, forwarded); break; } case "summaryStarted": case "summaryCompleted": if (!ctx.canceled) this.observers.onSummaryLifecycle?.(); break; default: break; } }
}
