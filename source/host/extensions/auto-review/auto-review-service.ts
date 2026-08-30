import type { SandAutoReviewInstructions } from "../../../shared/sand-auto-review-instructions.js";
import { SAND_AUTO_REVIEW_STALE, SAND_AUTO_REVIEW_STALE_MESSAGE } from "../../../shared/transcript.js";
import { resolveSandAutoReviewModes, SandAutoReviewController, type SandAutoReviewEvent, type SandAutoReviewMode, type SandAutoReviewResolution } from "../../runner/sand-auto-review.js";
import { SAND_AUTO_REVIEW_AWAITING_TAB_ID, SandAutoReviewAwaitingBridge, type SandAutoReviewAwaitingSink } from "./sand-auto-review-awaiting.js";

export function parseLocalAutoReviewMode(value: unknown): SandAutoReviewMode | undefined { return value === "off" || value === "shadow" || value === "enforce" ? value : undefined; }
export const SETTLED_APPROVAL_MEMORY = 256;

export interface AutoReviewUpdateSink { (update: unknown): void }
export interface AutoReviewServiceDeps<Classifier = unknown, Auth = unknown> {
  readonly auth: Auth;
  readonly experiments: { checkFeatureGate(name: string): boolean };
  readonly settings: { getAutoReviewInstructions(): SandAutoReviewInstructions };
  readonly telemetry: { reportAutoReviewDisplayRecheckFailed(report: { conversationId: string }): void; reportAutoReviewApproval(report: Record<string, unknown>): void };
  readonly awaitingSink: SandAutoReviewAwaitingSink;
  readonly transcript: { settleStaleAutoReviewCard(args: { agentId: string; entryId: string; requestId: string }): Promise<boolean> };
  readonly hostGeneration: string;
  readonly localMode?: SandAutoReviewMode;
  readonly createClassifierExecutor: (auth: Auth) => Classifier;
  readonly now?: () => number;
}

export class AutoReviewService<Classifier = unknown, Auth = unknown> {
  readonly #now: () => number; readonly #pendingControllers = new Map<SandAutoReviewController, () => void>(); readonly #settledApprovalIds = new Set<string>(); readonly #awaitingBridge: SandAutoReviewAwaitingBridge;
  constructor(readonly deps: AutoReviewServiceDeps<Classifier, Auth>) { this.#now = deps.now ?? Date.now; this.#awaitingBridge = new SandAutoReviewAwaitingBridge(deps.awaitingSink, this.#now); }

  bindRunner(options: { readonly agentId: string; readonly approvalsResolvable?: boolean; readonly onUpdate: AutoReviewUpdateSink }) {
    const getAutoReviewModes = () => this.#resolveModes();
    const autoReviewController = new SandAutoReviewController({ agentId: options.agentId, hostGeneration: this.deps.hostGeneration, ...(options.approvalsResolvable === undefined ? {} : { approvalsResolvable: options.approvalsResolvable }), now: this.#now, onDisplayRecheckFailed: (report) => this.deps.telemetry.reportAutoReviewDisplayRecheckFailed({ conversationId: report.agentId }) });
    let unsubscribe = () => {};
    unsubscribe = autoReviewController.subscribe((event) => { if (event.type === "created") this.#pendingControllers.set(autoReviewController, unsubscribe); if (event.type === "resolved") this.#rememberSettled(event.approval.id); this.#awaitingBridge.handleEvent(event); this.#handleApprovalEvent(options.onUpdate, event); if (event.type !== "created" && autoReviewController.getPendingApprovals().length === 0) this.#pendingControllers.delete(autoReviewController); });
    return { autoReviewController, autoReviewModes: getAutoReviewModes(), getAutoReviewModes, autoReviewClassifierExecutor: this.deps.createClassifierExecutor(this.deps.auth), getAutoReviewInstructions: () => this.deps.settings.getAutoReviewInstructions() };
  }

  async resolveApproval(args: { readonly requestId: string; readonly resolution: SandAutoReviewResolution; readonly agentId: string; readonly entryId: string }): Promise<void> {
    if (this.#ownerOf(args.requestId)?.resolveApproval(args.requestId, args.resolution) != null) return;
    if (this.#settledApprovalIds.has(args.requestId)) return;
    if (await this.deps.transcript.settleStaleAutoReviewCard({ agentId: args.agentId, entryId: args.entryId, requestId: args.requestId })) return;
    throw new Error(`${SAND_AUTO_REVIEW_STALE}: ${SAND_AUTO_REVIEW_STALE_MESSAGE}`);
  }

  expirePendingApprovals(): void { for (const [controller] of [...this.#pendingControllers]) controller.expire("session_end"); }
  agentIdsWithPendingApprovals(): string[] { const ids = new Set<string>(); for (const [controller] of this.#pendingControllers) { const pending = controller.getPendingApprovals(); if (pending.length === 0) continue; ids.add(controller.agentId); for (const approval of pending) ids.add(approval.agentId); } return [...ids]; }
  stop(): void { const pending = [...this.#pendingControllers]; this.expirePendingApprovals(); for (const [, unsubscribe] of pending) unsubscribe(); this.#pendingControllers.clear(); }
  pendingAwaitingState(agentId: string) { return this.#awaitingBridge.pendingAwaitingState(agentId); }
  async sweepStaleAwaitingBadges(listAgentIds: () => Promise<readonly string[]>, ifSinceBefore: number): Promise<void> { try { for (const agentId of await listAgentIds()) this.deps.awaitingSink.clearForTab(agentId, SAND_AUTO_REVIEW_AWAITING_TAB_ID, { ifSinceBefore }); } catch {} }
  #ownerOf(requestId: string): SandAutoReviewController | undefined { for (const [controller] of this.#pendingControllers) if (controller.getPendingApprovals().some((approval) => approval.id === requestId)) return controller; return undefined; }
  #rememberSettled(id: string): void { this.#settledApprovalIds.add(id); if (this.#settledApprovalIds.size <= SETTLED_APPROVAL_MEMORY) return; const oldest = this.#settledApprovalIds.values().next(); if (!oldest.done) this.#settledApprovalIds.delete(oldest.value); }
  #resolveModes() { return resolveSandAutoReviewModes({ settingsEnabled: this.deps.settings.getAutoReviewInstructions().isEnabled, enforceEnabled: this.deps.experiments.checkFeatureGate("sand_auto_review"), ...(this.deps.localMode === undefined ? {} : { localOverride: this.deps.localMode }) }); }
  #handleApprovalEvent(onUpdate: AutoReviewUpdateSink, event: SandAutoReviewEvent): void {
    const approval = event.approval; this.deps.telemetry.reportAutoReviewApproval({ eventType: event.type, conversationId: approval.agentId, approvalId: approval.id, surface: approval.surface, status: approval.status, ageMs: this.#now() - approval.createdAtMs, ...(approval.expiresAtMs === undefined ? {} : { ttlMs: approval.expiresAtMs - approval.createdAtMs }), ...(event.type === "expired" ? { cause: event.cause } : {}) });
    if (event.type === "created") { onUpdate({ type: "send-message", message: { type: "auto-review-approval", approval: { requestId: approval.id, surface: approval.surface, summary: approval.summary, reason: approval.reason, status: "pending", ...(approval.command === undefined ? {} : { command: approval.command }), ...(approval.proposedRule === undefined ? {} : { proposedRule: approval.proposedRule }) } }, timestampMs: this.#now() }); return; }
    onUpdate({ type: "auto-review-status", requestId: approval.id, status: event.type === "expired" || approval.status === "pending" ? "expired" : approval.status });
  }
}
