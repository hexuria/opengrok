import type { SandAutoReviewEvent } from "../../runner/sand-auto-review.js";

export const SAND_AUTO_REVIEW_AWAITING_TAB_ID = "auto-review";
export interface SandAutoReviewAwaitingState { readonly tabId: string; readonly reason: string; readonly since: number }
export interface SandAutoReviewAwaitingSink { trySetForTab(agentId: string, state: SandAutoReviewAwaitingState): void; clearForTab(agentId: string, tabId: string, options?: { readonly ifSinceBefore?: number }): void }

export function buildSandAutoReviewAwaitingReason(summary: string): string { return `Approval needed: ${summary}`; }

export class SandAutoReviewAwaitingBridge {
  readonly #pendingByAgent = new Map<string, Map<string, string>>();
  constructor(private readonly sink: SandAutoReviewAwaitingSink, private readonly now: () => number = Date.now) {}

  handleEvent(event: SandAutoReviewEvent): void {
    const { agentId, id, summary } = event.approval;
    if (event.type === "created") { const pending = this.#pendingByAgent.get(agentId) ?? new Map<string, string>(); this.#pendingByAgent.set(agentId, pending); pending.set(id, buildSandAutoReviewAwaitingReason(summary)); this.#assert(agentId, pending); return; }
    const pending = this.#pendingByAgent.get(agentId); if (pending == null || !pending.delete(id)) return;
    if (pending.size === 0) { this.#pendingByAgent.delete(agentId); this.sink.clearForTab(agentId, SAND_AUTO_REVIEW_AWAITING_TAB_ID); return; }
    this.#assert(agentId, pending);
  }

  pendingAwaitingState(agentId: string): SandAutoReviewAwaitingState | null { const reason = [...(this.#pendingByAgent.get(agentId)?.values() ?? [])].at(-1); return reason == null ? null : { tabId: SAND_AUTO_REVIEW_AWAITING_TAB_ID, reason, since: this.now() }; }
  #assert(agentId: string, pending: ReadonlyMap<string, string>): void { const reason = [...pending.values()].at(-1); if (reason != null) this.sink.trySetForTab(agentId, { tabId: SAND_AUTO_REVIEW_AWAITING_TAB_ID, reason, since: this.now() }); }
}
