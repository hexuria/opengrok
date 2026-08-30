import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../../shared/node/atomic-write.js";
import { reportDesktopEdgeFailure } from "../desktop-edge-failures.js";

export const BOX_SECRETS_PUSH_STATE_FILE_NAME = "box-secrets-push-state.v1.json";
export const BOX_SECRETS_PUSH_COUNT_CAP = 999;

export type BoxSecretsPushTrigger = "startup" | "edit" | "account" | "retry" | string;
export type BoxSecretsPushAttempt =
  | { readonly outcome: "failed"; readonly trigger: BoxSecretsPushTrigger; readonly errorClass: string; readonly scope?: { readonly accountScope?: string | undefined }; readonly secretCount?: number }
  | { readonly outcome: "ok"; readonly trigger: BoxSecretsPushTrigger; readonly accountScope?: string | undefined; readonly secretCount: number; readonly applied: boolean; readonly departing?: boolean };

export interface BoxSecretsPushTelemetryDependencies {
  readonly statePath?: string;
  readonly isSignedIn: () => boolean;
  readonly report: (level: "info" | "warn", metadata: Readonly<Record<string, string>>) => void;
  readonly onEdgeFailure?: (area: "user-secrets" | "telemetry", leg: "marker-read" | "marker-write" | "submit", error: unknown) => void;
}

interface AckedPushState { readonly version: 1; readonly ackedCount: number; readonly scopeHash?: string }

function isAckedPushState(value: unknown): value is AckedPushState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return state.version === 1 && Number.isInteger(state.ackedCount) && (state.ackedCount as number) >= 0
    && (state.ackedCount as number) <= BOX_SECRETS_PUSH_COUNT_CAP
    && (state.scopeHash === undefined || typeof state.scopeHash === "string");
}

export function boxSecretsScopeHash(accountScope: string | undefined): string | undefined {
  return accountScope === undefined ? undefined : createHash("sha256").update(accountScope).digest("hex").slice(0, 16);
}

export function cappedBoxSecretsPushCount(count: number): number {
  return Math.max(0, Math.min(Math.round(count), BOX_SECRETS_PUSH_COUNT_CAP));
}

const countTag = (count: number): string => String(cappedBoxSecretsPushCount(count));
const deltaTag = (delta: number): string => String(Math.max(-BOX_SECRETS_PUSH_COUNT_CAP, Math.min(Math.round(delta), BOX_SECRETS_PUSH_COUNT_CAP)));

export function createBoxSecretsPushTelemetry(deps: BoxSecretsPushTelemetryDependencies) {
  const statePath = resolveStatePath(deps);
  let state: AckedPushState | undefined;
  let failureStreak = 0;
  let lastFailureClass: string | undefined;

  const load = async (): Promise<void> => {
    let raw: string;
    try { raw = await readFile(statePath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") reportDesktopEdgeFailure("user-secrets", "marker-read", error);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isAckedPushState(parsed)) throw new TypeError("Invalid box secrets push state");
      state = parsed;
    } catch (error) { reportDesktopEdgeFailure("user-secrets", "marker-read", error); }
  };

  const save = async (next: AckedPushState): Promise<void> => {
    try { await writeFileAtomic(statePath, new TextEncoder().encode(JSON.stringify(next)), { mode: 0o600 }); }
    catch (error) { reportDesktopEdgeFailure("user-secrets", "marker-write", error); }
  };

  const applyFailed = (attempt: Extract<BoxSecretsPushAttempt, { outcome: "failed" }>): void => {
    if (failureStreak === 0 || attempt.errorClass !== lastFailureClass) {
      deps.report("warn", {
        outcome: "failed", trigger: attempt.trigger, error_class: attempt.errorClass,
        signed_in: String(deps.isSignedIn()),
        ...(attempt.scope !== undefined ? { scope_present: String(attempt.scope.accountScope !== undefined) } : {}),
        ...(attempt.secretCount !== undefined ? { key_count: countTag(attempt.secretCount) } : {}),
        ...(state !== undefined ? { prev_count: countTag(state.ackedCount) } : {}),
      });
    }
    failureStreak = Math.min(failureStreak + 1, BOX_SECRETS_PUSH_COUNT_CAP);
    lastFailureClass = attempt.errorClass;
  };

  const applyAcked = async (attempt: Extract<BoxSecretsPushAttempt, { outcome: "ok" }>): Promise<void> => {
    const scopeHash = boxSecretsScopeHash(attempt.accountScope);
    const previous = state;
    const delta = previous === undefined ? undefined : attempt.secretCount - previous.ackedCount;
    const scopeChanged = scopeHash !== undefined && previous?.scopeHash !== undefined && scopeHash !== previous.scopeHash;
    const signedIn = deps.isSignedIn();
    const departed = attempt.accountScope === undefined && (attempt.departing === true || !signedIn);
    const recoveredAfter = failureStreak;
    failureStreak = 0;
    lastFailureClass = undefined;
    const firstBaseline = previous === undefined && attempt.secretCount > 0;
    if (recoveredAfter > 0 || firstBaseline || (delta !== undefined && delta !== 0)) {
      const shrankOutsideEdit = delta !== undefined && delta < 0 && attempt.trigger !== "edit" && !scopeChanged && !departed;
      deps.report(shrankOutsideEdit ? "warn" : "info", {
        outcome: "ok", trigger: attempt.trigger, key_count: countTag(attempt.secretCount), applied: String(attempt.applied),
        scope_present: String(attempt.accountScope !== undefined), signed_in: String(signedIn),
        ...(previous !== undefined ? { prev_count: countTag(previous.ackedCount) } : {}),
        ...(delta !== undefined ? { delta: deltaTag(delta) } : {}),
        ...(scopeChanged ? { scope_changed: "true" } : {}), ...(departed ? { scope_departed: "true" } : {}),
        ...(recoveredAfter > 0 ? { recovered_after: countTag(recoveredAfter) } : {}),
      });
    }
    const next: AckedPushState = { version: 1, ackedCount: cappedBoxSecretsPushCount(attempt.secretCount), ...(scopeHash === undefined ? {} : { scopeHash }) };
    if (previous === undefined || previous.ackedCount !== next.ackedCount || previous.scopeHash !== next.scopeHash) { state = next; await save(next); }
  };

  let chain = load();
  return {
    record(attempt: BoxSecretsPushAttempt): void {
      chain = chain.then(() => attempt.outcome === "failed" ? applyFailed(attempt) : applyAcked(attempt)).catch((error: unknown) => {
        reportDesktopEdgeFailure("telemetry", "submit", error);
      });
    },
    settled: (): Promise<void> => chain,
  };
}

function resolveStatePath(deps: BoxSecretsPushTelemetryDependencies): string {
  const configured = deps.statePath;
  if (configured !== undefined) return configured;
  const moduleName = "electron";
  const electron = require(moduleName) as { readonly app: { getPath(name: "userData"): string } };
  return join(electron.app.getPath("userData"), BOX_SECRETS_PUSH_STATE_FILE_NAME);
}
