import type { ProcessCrashKind } from "../process-crash-guard.js";
import { SAND_SENTRY_DSN, SandSentryPrivacyGate, gateEnvelopeSend, type SandSentryEnvelope } from "../../shared/observability/sentry.js";

interface SentryTransport { send(envelope: SandSentryEnvelope): Promise<unknown>; readonly [key: string]: unknown; }
export interface SandSentryDaemonRuntime {
  init(options: Record<string, unknown>): void;
  eventFiltersIntegration(): unknown; functionToStringIntegration(): unknown; linkedErrorsIntegration(): unknown; dedupeIntegration(): unknown;
  makeNodeTransport(options: unknown): SentryTransport;
  setTag(key: string, value: string): void;
  captureException(error: Error, options: { readonly level: "fatal"; readonly tags: { readonly "crash.kind": ProcessCrashKind | "fatal" } }): void;
  flush(timeoutMs: number): Promise<boolean>;
}

let activeRuntime: SandSentryDaemonRuntime | undefined;
export function initSandSentryDaemon(runtime: SandSentryDaemonRuntime, env: NodeJS.ProcessEnv = process.env): ((error: Error, kind: ProcessCrashKind | "fatal") => void) | undefined {
  const environment = env.SAND_SENTRY_ENVIRONMENT; const release = env.SAND_SENTRY_RELEASE; if (environment === undefined || release === undefined) return undefined;
  try { const gate = new SandSentryPrivacyGate(); runtime.init({ dsn: SAND_SENTRY_DSN, environment, release, includeServerName: false, defaultIntegrations: false, skipOpenTelemetrySetup: true, integrations: [runtime.eventFiltersIntegration(), runtime.functionToStringIntegration(), runtime.linkedErrorsIntegration(), runtime.dedupeIntegration()], transport: (transportOptions: unknown) => { const base = runtime.makeNodeTransport(transportOptions); return { ...base, send: gateEnvelopeSend(gate, (envelope) => base.send(envelope)) }; } }); runtime.setTag("sand.process", "local-exec-daemon"); activeRuntime = runtime; return (error, kind) => { void runtime.captureException(error, { level: "fatal", tags: { "crash.kind": kind } }); }; }
  catch (error) { console.error("[sand-local-exec-daemon] Sentry init failed:", error); return undefined; }
}
export function flushSandSentry(timeoutMs: number): Promise<boolean> { return activeRuntime?.flush(timeoutMs) ?? Promise.resolve(true); }
