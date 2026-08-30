import { createHash, randomUUID } from "node:crypto";

export const SAND_AUTO_REVIEW_APPROVAL_TTL_MS = 10 * 60 * 1_000;
export const SAND_AUTO_REVIEW_MAX_PENDING_PER_AGENT = 4;
export const SAND_AUTO_REVIEW_HOST_GENERATION = randomUUID();

export type SandAutoReviewMode = "off" | "shadow" | "enforce";
export type SandAutoReviewSurface = "hostShell" | "boxShell" | "mcp" | "computer" | "automationWrite" | "cloudAgent" | "subagentLaunch" | string;
export type SandAutoReviewResolution = "approved" | "denied";
export type SandAutoReviewExpiryCause = "ttl" | "cancelled" | "user_redirect" | "settings_change" | "session_end" | "quiesce" | string;
export type SandAutoReviewExpiryPolicy = "park" | "ttl";

export interface SandAutoReviewModes {
  readonly hostShell: SandAutoReviewMode;
  readonly boxShell: SandAutoReviewMode;
  readonly mcp: SandAutoReviewMode;
  readonly computer: SandAutoReviewMode;
  readonly automationWrite: "off";
  readonly cloudAgent: SandAutoReviewMode;
  readonly subagentLaunch: SandAutoReviewMode;
}

export interface SandAutoReviewApproval {
  readonly id: string;
  readonly agentId: string;
  readonly surface: SandAutoReviewSurface;
  readonly fingerprint: string;
  readonly reason: string;
  readonly summary: string;
  readonly command?: string;
  readonly proposedRule?: string;
  readonly userMessageEpoch: number;
  readonly hostGeneration: string;
  readonly createdAtMs: number;
  readonly expiresAtMs?: number;
  readonly status: "pending" | SandAutoReviewResolution | "expired";
}

export type SandAutoReviewEvent =
  | { readonly type: "created" | "resolved"; readonly approval: SandAutoReviewApproval }
  | { readonly type: "expired"; readonly approval: SandAutoReviewApproval; readonly cause: SandAutoReviewExpiryCause };

export interface SandAutoReviewRequest {
  readonly agentId?: string;
  readonly surface: SandAutoReviewSurface;
  readonly fingerprint: string;
  readonly reason: string;
  readonly summary: string;
  readonly command?: string;
  readonly proposedRule?: string;
  readonly expiryPolicy?: SandAutoReviewExpiryPolicy;
  readonly signal?: AbortSignal;
}

export type SandAutoReviewDecision = { readonly approved: true } | { readonly approved: false; readonly reason: string };

export function sandAutoReviewApprovalExpiryPolicy(source: string): SandAutoReviewExpiryPolicy {
  return source === "turn" || source === "handoff-resume" ? "park" : "ttl";
}

export const SAND_AUTO_REVIEW_MODES_OFF: SandAutoReviewModes = Object.freeze({ hostShell: "off", boxShell: "off", mcp: "off", computer: "off", automationWrite: "off", cloudAgent: "off", subagentLaunch: "off" });
export const SAND_AUTO_REVIEW_MODES_SHADOW: SandAutoReviewModes = Object.freeze({ hostShell: "shadow", boxShell: "shadow", mcp: "shadow", computer: "shadow", automationWrite: "off", cloudAgent: "shadow", subagentLaunch: "shadow" });
export const SAND_AUTO_REVIEW_MODES_ENFORCE: SandAutoReviewModes = Object.freeze({ hostShell: "enforce", boxShell: "enforce", mcp: "enforce", computer: "enforce", automationWrite: "off", cloudAgent: "enforce", subagentLaunch: "enforce" });

export function resolveSandAutoReviewModes(args: { readonly settingsEnabled: boolean; readonly enforceEnabled: boolean; readonly localOverride?: SandAutoReviewMode }): SandAutoReviewModes {
  if (!args.settingsEnabled) return SAND_AUTO_REVIEW_MODES_OFF;
  if (args.localOverride !== undefined) return { hostShell: args.localOverride, boxShell: args.localOverride, mcp: args.localOverride, computer: args.localOverride, automationWrite: "off", cloudAgent: args.localOverride, subagentLaunch: args.localOverride };
  return args.enforceEnabled ? SAND_AUTO_REVIEW_MODES_ENFORCE : SAND_AUTO_REVIEW_MODES_SHADOW;
}

export function formatSandAutoReviewDeniedReason(classifierReason: string): string {
  return `Auto-review blocked this action: ${classifierReason}. Do not retry the same action, and do not switch to another anonymous public file host, pastebin, disposable transfer link, or similar courier — that is the same unauthorized data-exposure crossing. Ask the user what they want next. Use a safer alternative only when it is a genuinely authorized path.`;
}

export function formatSandAutoReviewInterruptedForUpdateReason(classifierReason: string): string {
  return `A host update interrupted this approval request before the user could answer \u2014 the user did NOT deny it. After you resume, re-run the action; if it is blocked again, use the tool's approval-retry parameter to raise a fresh approval card. The pending review reason was: ${classifierReason}`;
}

function sanitize(value: string, fallback: string, length: number): string { const trimmed = value.trim(); return (trimmed.length === 0 ? fallback : trimmed).slice(0, length); }
function sanitizeOptional(value: string | undefined, length: number, collapseWhitespace = false): string | undefined { if (value === undefined) return undefined; const trimmed = (collapseWhitespace ? value.replace(/\s+/g, " ") : value).trim(); return trimmed.length === 0 ? undefined : trimmed.slice(0, length); }

interface PendingRecord {
  readonly approval: SandAutoReviewApproval;
  readonly resolve: (decision: SandAutoReviewDecision) => void;
  readonly expiryAbort: AbortController;
  readonly signal?: AbortSignal;
  abortListener?: () => void;
}

export class SandAutoReviewController {
  readonly #pending = new Map<string, PendingRecord>();
  readonly #listeners = new Set<(event: SandAutoReviewEvent) => void>();
  readonly #approvalTtlMs: number;
  readonly #maxPendingPerAgent: number;
  readonly #approvalsResolvable: boolean;
  readonly #now: () => number;
  #userMessageEpoch = 0;
  #quiescingForHostWindDown = false;

  constructor(readonly options: { readonly agentId: string; readonly hostGeneration: string; readonly approvalTtlMs?: number; readonly maxPendingPerAgent?: number; readonly approvalsResolvable?: boolean; readonly now?: () => number; readonly randomId?: () => string; readonly onDisplayRecheckFailed?: (report: { agentId: string }) => void }) {
    this.#approvalTtlMs = options.approvalTtlMs ?? SAND_AUTO_REVIEW_APPROVAL_TTL_MS;
    this.#maxPendingPerAgent = options.maxPendingPerAgent ?? SAND_AUTO_REVIEW_MAX_PENDING_PER_AGENT;
    this.#approvalsResolvable = options.approvalsResolvable ?? true;
    this.#now = options.now ?? Date.now;
  }

  get epoch(): number { return this.#userMessageEpoch; }
  get agentId(): string { return this.options.agentId; }
  get hostGeneration(): string { return this.options.hostGeneration; }

  reportDisplayRecheckFailed(agentId?: string): void { try { this.options.onDisplayRecheckFailed?.({ agentId: agentId ?? this.options.agentId }); } catch {} }

  async requestApproval(request: SandAutoReviewRequest): Promise<SandAutoReviewDecision> {
    const agentId = request.agentId ?? this.options.agentId;
    if (request.signal?.aborted === true) return { approved: false, reason: "The action was cancelled." };
    if (this.#quiescingForHostWindDown) return { approved: false, reason: formatSandAutoReviewInterruptedForUpdateReason(request.reason) };
    if (!this.#approvalsResolvable) return { approved: false, reason: "This action needs Auto-review approval, which isn't available in this conversation. Run it from a direct chat with the assistant." };
    if ([...this.#pending.values()].filter((record) => record.approval.agentId === agentId).length >= this.#maxPendingPerAgent) return { approved: false, reason: "Too many actions are already waiting for Auto-review approval; resolve those first." };
    const createdAtMs = this.#now();
    const command = sanitizeOptional(request.command, 4_000);
    const proposedRule = sanitizeOptional(request.proposedRule, 500, true);
    const expiryPolicy = request.expiryPolicy ?? "ttl";
    const approval: SandAutoReviewApproval = {
      id: this.options.randomId?.() ?? randomUUID(), agentId, surface: request.surface, fingerprint: request.fingerprint,
      reason: sanitize(request.reason, "This action requires your approval.", 500), summary: sanitize(request.summary, "Sensitive action", 500),
      ...(command === undefined ? {} : { command }), ...(proposedRule === undefined ? {} : { proposedRule }),
      userMessageEpoch: this.#userMessageEpoch, hostGeneration: this.options.hostGeneration, createdAtMs,
      ...(expiryPolicy === "ttl" ? { expiresAtMs: createdAtMs + this.#approvalTtlMs } : {}), status: "pending"
    };
    return new Promise<SandAutoReviewDecision>((resolve) => {
      const expiryAbort = new AbortController();
      if (expiryPolicy === "ttl") {
        const timer = setTimeout(() => { if (!expiryAbort.signal.aborted) this.#retire(approval.id, "ttl", { approved: false, reason: formatSandAutoReviewDeniedReason(approval.reason) }); }, this.#approvalTtlMs);
        timer.unref?.();
        expiryAbort.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
      }
      const record: PendingRecord = { approval, resolve, expiryAbort, ...(request.signal === undefined ? {} : { signal: request.signal }) };
      if (request.signal !== undefined) {
        const abortListener = () => this.#retire(approval.id, "cancelled", { approved: false, reason: "The action was cancelled." });
        record.abortListener = abortListener;
        request.signal.addEventListener("abort", abortListener, { once: true });
      }
      this.#pending.set(approval.id, record);
      this.#emit({ type: "created", approval });
    });
  }

  resolveApproval(approvalId: string, resolution: SandAutoReviewResolution): SandAutoReviewApproval | undefined {
    const record = this.#pending.get(approvalId);
    if (record === undefined || record.approval.hostGeneration !== this.options.hostGeneration || record.approval.userMessageEpoch !== this.#userMessageEpoch || (record.approval.expiresAtMs !== undefined && record.approval.expiresAtMs <= this.#now())) return undefined;
    const resolved: SandAutoReviewApproval = { ...record.approval, status: resolution };
    this.#deletePending(approvalId, record); this.#emit({ type: "resolved", approval: resolved });
    record.resolve(resolution === "denied" ? { approved: false, reason: formatSandAutoReviewDeniedReason(record.approval.reason) } : { approved: true });
    return resolved;
  }

  getPendingApprovals(): SandAutoReviewApproval[] { return [...this.#pending.values()].map((record) => record.approval); }
  getPendingApprovalForAgent(agentId: string): SandAutoReviewApproval | undefined { return [...this.#pending.values()].find((record) => record.approval.agentId === agentId)?.approval; }
  subscribe(listener: (event: SandAutoReviewEvent) => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  beginUserMessageEpoch(): void { this.#userMessageEpoch += 1; this.expire("user_redirect"); }
  expireSurfaces(surfaces: ReadonlySet<SandAutoReviewSurface>): void { for (const [id, record] of [...this.#pending]) if (surfaces.has(record.approval.surface)) this.#retire(id, "settings_change", { approved: false, reason: "Auto-review settings changed; retry the action." }); }
  expire(cause: SandAutoReviewExpiryCause): void { for (const [id, record] of [...this.#pending]) this.#retire(id, cause, { approved: false, reason: formatSandAutoReviewDeniedReason(record.approval.reason) }); }
  expireForQuiesce(): void { this.#quiescingForHostWindDown = true; for (const [id, record] of [...this.#pending]) this.#retire(id, "quiesce", { approved: false, reason: formatSandAutoReviewInterruptedForUpdateReason(record.approval.reason) }); }
  cancelQuiesce(): void { this.#quiescingForHostWindDown = false; }
  #retire(id: string, cause: SandAutoReviewExpiryCause, decision: SandAutoReviewDecision): void { const record = this.#pending.get(id); if (record === undefined) return; const approval: SandAutoReviewApproval = { ...record.approval, status: "expired" }; this.#deletePending(id, record); this.#emit({ type: "expired", approval, cause }); record.resolve(decision); }
  #deletePending(id: string, record: PendingRecord): void { record.expiryAbort.abort(); if (record.signal !== undefined && record.abortListener !== undefined) record.signal.removeEventListener("abort", record.abortListener); this.#pending.delete(id); }
  #emit(event: SandAutoReviewEvent): void { for (const listener of this.#listeners) listener(event); }
}

export function fingerprintSandAutoReviewTarget(target: unknown): string { return createHash("sha256").update(JSON.stringify(target)).digest("hex"); }
