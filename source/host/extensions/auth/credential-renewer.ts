import { readFile } from "node:fs/promises";

import type { Clock, RetryPolicy } from "../../../internal/scheduling.js";
import { errorLogTag } from "../../../shared/errors.js";
import { getAccessTokenExpiryMs, getConfiguredBackendUrl } from "../../../shared/node/cursor-token.js";
import { getSandBackendClientHeaders } from "../../../shared/node/sand-client-metadata.js";

export class SandCredentialRenewalError extends Error {
  constructor(message: string) { super(message); this.name = "SandCredentialRenewalError"; }
}

export const SAND_INFERENCE_RENEWAL_CREDENTIAL_ENV = "SAND_INFERENCE_RENEWAL_CREDENTIAL";
export const SAND_DEV_INFERENCE_TOKEN_FILE_ENV = "SAND_DEV_INFERENCE_TOKEN_FILE";
export const REFRESH_LEEWAY_MS = 2 * 60 * 1_000;
export const MIN_REFRESH_INTERVAL_MS = 30 * 1_000;
export const MAX_REFRESH_INTERVAL_MS = 30 * 60 * 1_000;
export const CREDENTIAL_RETRY_BASE_DELAY_MS = 5 * 1_000;
export const CREDENTIAL_RETRY_MAX_DELAY_MS = 5 * 60 * 1_000;
export const DEFAULT_TTL_MS = 10 * 60 * 1_000;
export const RENEWAL_PATH = "/sand-box/inference-credential";

export interface InferenceCredential { readonly accessToken: string; readonly expiresAtMs: number; }
export interface RenewalResult {
  readonly outcome: "renewed" | "failed";
  readonly consecutiveFailures: number;
  readonly durationMs: number;
  readonly errorSummary: string | undefined;
}

function credentialFromPayload(parsed: unknown, absentMessage: string): InferenceCredential {
  const record = parsed as Record<string, unknown>;
  const accessToken = typeof record.accessToken === "string" ? record.accessToken : "";
  if (accessToken.length === 0) throw new SandCredentialRenewalError(absentMessage);
  const expiresAtMs = typeof record.expiresAtMs === "number" && Number.isFinite(record.expiresAtMs)
    ? record.expiresAtMs
    : getAccessTokenExpiryMs(accessToken) ?? Date.now() + DEFAULT_TTL_MS;
  return { accessToken, expiresAtMs };
}

export async function renewSandBoxInferenceCredential(args: {
  readonly backendUrl: string;
  readonly credential: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<InferenceCredential> {
  const response = await (args.fetchImpl ?? fetch)(new URL(RENEWAL_PATH, args.backendUrl).toString(), {
    method: "POST",
    headers: { "content-type": "application/json", ...getSandBackendClientHeaders() },
    body: JSON.stringify({ credential: args.credential })
  });
  if (!response.ok) throw new SandCredentialRenewalError(`Sand inference-credential renewal failed (HTTP ${response.status}).`);
  return credentialFromPayload(await response.json(), "Sand inference-credential renewal returned no token.");
}

export async function readDevInferenceCredentialFile(args: {
  readonly path: string;
  readonly readFileImpl?: (path: string) => Promise<string>;
}): Promise<InferenceCredential> {
  const raw = await (args.readFileImpl ?? ((path) => readFile(path, "utf8")))(args.path);
  return credentialFromPayload(JSON.parse(raw) as unknown, `Dev inference token file ${args.path} has no accessToken yet.`);
}

export class SandInferenceCredentialRenewer {
  private readonly abort = new AbortController();
  private loop: Promise<void> | undefined;
  private consecutiveFailures = 0;
  private interruptRefreshWait: (() => void) | undefined;
  private onDemandRenewal: PromiseWithResolvers<void> | undefined;

  constructor(private readonly options: {
    readonly getCredential: () => string | null;
    readonly renew: (credential: string) => Promise<InferenceCredential>;
    readonly setCredential: (credential: InferenceCredential) => void;
    readonly onResult?: (result: RenewalResult) => void;
    readonly retry: RetryPolicy;
    readonly clock: Clock;
  }) {}

  start(): void { this.loop ??= this.run(); }
  close(): void { this.abort.abort(); }

  requestImmediateRenewal(): Promise<boolean> {
    if (this.onDemandRenewal !== undefined) return this.onDemandRenewal.promise.then(() => true);
    const interrupt = this.interruptRefreshWait;
    if (interrupt === undefined) return Promise.resolve(false);
    this.onDemandRenewal = Promise.withResolvers<void>();
    const result = this.onDemandRenewal.promise.then(() => true);
    interrupt();
    return result;
  }

  private async run(): Promise<void> {
    try {
      while (!this.abort.signal.aborted) {
        const next = await this.cycle();
        this.completeOnDemandRenewal();
        if (next === null) return;
        await this.waitFor(next);
      }
    } finally { this.completeOnDemandRenewal(); }
  }

  private completeOnDemandRenewal(): void { this.onDemandRenewal?.resolve(); this.onDemandRenewal = undefined; }

  private async cycle(): Promise<{ kind: "refresh"; delayMs: number } | { kind: "backoff"; attempt: number } | null> {
    const cycleStartedAtMs = Date.now();
    try {
      const credential = this.options.getCredential();
      if (credential == null || credential.length === 0) return { kind: "refresh", delayMs: MAX_REFRESH_INTERVAL_MS };
      const renewed = await this.options.renew(credential);
      if (this.abort.signal.aborted) return null;
      this.options.setCredential(renewed);
      this.consecutiveFailures = 0;
      this.reportResult("renewed", Date.now() - cycleStartedAtMs);
      const untilRefresh = renewed.expiresAtMs - Date.now() - REFRESH_LEEWAY_MS;
      return { kind: "refresh", delayMs: Math.min(Math.max(untilRefresh, MIN_REFRESH_INTERVAL_MS), MAX_REFRESH_INTERVAL_MS) };
    } catch (error) {
      if (this.abort.signal.aborted) return null;
      this.consecutiveFailures += 1;
      this.reportResult("failed", Date.now() - cycleStartedAtMs, redactRenewalErrorForReport(error instanceof Error ? error.message : String(error)));
      return { kind: "backoff", attempt: this.consecutiveFailures };
    }
  }

  private async waitFor(next: { kind: "refresh"; delayMs: number } | { kind: "backoff"; attempt: number }): Promise<void> {
    const signal = this.abort.signal;
    if (signal.aborted) return;
    if (next.kind === "backoff") {
      await this.options.retry.schedule(next.attempt, signal).elapsed.catch((error) => {
        if (!signal.aborted) console.warn(`[sand-credential-renewer] backoff wait failed (${errorLogTag(error)})`);
      });
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      let scheduled: { dispose(): void };
      const finish = () => {
        if (settled) return;
        settled = true;
        scheduled.dispose();
        signal.removeEventListener("abort", finish);
        if (this.interruptRefreshWait === finish) this.interruptRefreshWait = undefined;
        resolve();
      };
      scheduled = this.options.clock.schedule(next.delayMs, finish);
      this.interruptRefreshWait = finish;
      signal.addEventListener("abort", finish, { once: true });
    });
  }

  private reportResult(outcome: "renewed" | "failed", durationMs: number, errorSummary?: string): void {
    try { this.options.onResult?.({ outcome, consecutiveFailures: this.consecutiveFailures, durationMs, errorSummary }); }
    catch {}
  }
}

export function redactRenewalErrorForReport(raw: string): string {
  return raw.replace(/https?:\/\/\S+/gi, "<url>").replace(/\/[^\s"']+/g, "<path>").replace(/[A-Za-z0-9_-]{24,}/g, "<id>").replace(/\s+/g, " ").trim().slice(0, 160);
}

export function getSandInferenceBackendUrl(): string { return getConfiguredBackendUrl(); }
