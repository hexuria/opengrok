import { SandSentryAccountPrivacySync, SandSentryEventIdRing, SandSentryPrivacyGate, SAND_SENTRY_CONVERSATION_TAG, SAND_SENTRY_DSN, type SandSentryEnvelope } from "../../shared/observability/sentry.js";
import { sandSentryPrivacyTierForMode, type PrivacyMode } from "../../shared/observability/sentry-privacy-mode.js";

export const SAND_FEEDBACK_SENTRY_EVENT_ID_MAX_COUNT = 5;
export interface SandSentryUser { readonly id: string; readonly email?: string }
export interface SandSentryOfflineTransport { flush(): Promise<unknown>; purgeSpool(): Promise<number>; shutdown?(): Promise<void> }
export interface SandSentryAdapter {
  init(options: { readonly dsn: string; readonly environment: string; readonly release: string; readonly gate: SandSentryPrivacyGate; readonly onEnvelopeAccepted: (envelope: SandSentryEnvelope) => void }): SandSentryOfflineTransport | undefined;
  setUser(user: SandSentryUser | null): void;
  setTag(name: string, value: string | undefined): void;
  captureMessage(message: string, context: { readonly level: "warning" | "error"; readonly tags?: Readonly<Record<string, string>> }): void;
  captureException(error: unknown, context: { readonly tags: Readonly<Record<string, string>> }): void;
}

const noopAdapter: SandSentryAdapter = { init: () => undefined, setUser: () => {}, setTag: () => {}, captureMessage: () => {}, captureException: () => {} };
let adapter: SandSentryAdapter = noopAdapter;
const gate = new SandSentryPrivacyGate();
const eventIdRing = new SandSentryEventIdRing(SAND_FEEDBACK_SENTRY_EVENT_ID_MAX_COUNT);
let privacySync = new SandSentryAccountPrivacySync();
let ringOwnerUserId: string | undefined;
let offlineTransport: SandSentryOfflineTransport | undefined;
let initialOfflineFlushStarted = false;

export function installSandSentryAdapter(next: SandSentryAdapter): void { adapter = next; }
export function resetSandSentryForTests(): void { adapter = noopAdapter; ringOwnerUserId = undefined; eventIdRing.clear(); offlineTransport = undefined; initialOfflineFlushStarted = false; privacySync = new SandSentryAccountPrivacySync(); gate.setUserId(undefined); gate.setTier(sandSentryPrivacyTierForMode(undefined)); }
export function recentSandSentryEventIds(): string[] { return eventIdRing.list(); }
export function noteAcceptedSandSentryEnvelope(envelope: SandSentryEnvelope): void { eventIdRing.record(envelope); }
export function bindSandSentryIdentity(userId: string | undefined): void { if (userId !== ringOwnerUserId) { ringOwnerUserId = userId; eventIdRing.clear(); } gate.setUserId(userId); }
export function applySandSentryPrivacyMode(mode: PrivacyMode | undefined): void { gate.setTier(sandSentryPrivacyTierForMode(mode)); }
export async function completeSandSentryInitialPrivacySync(): Promise<void> { if (initialOfflineFlushStarted || offlineTransport === undefined) return; initialOfflineFlushStarted = true; await offlineTransport.flush(); }
export function purgeSandSentrySpool(): Promise<number> { return offlineTransport?.purgeSpool() ?? Promise.resolve(0); }
export type SandAccountStatus = { readonly kind: "logged-in"; readonly authId: string; readonly email?: string } | { readonly kind: "logged-out" | "logging-in" };
export async function syncSandSentryAccount(status: SandAccountStatus, fetchPrivacyMode: () => Promise<PrivacyMode>): Promise<void> {
  const authId = status.kind === "logged-in" ? status.authId : undefined;
  const request = privacySync.begin(authId);
  if (request.reset) applySandSentryPrivacyMode(undefined);
  if (request.identityChanged) {
    bindSandSentryIdentity(authId);
    await purgeSandSentrySpool();
    if (!privacySync.isCurrent(request)) return;
  }
  if (status.kind !== "logged-in" || status.authId.length === 0) {
    setSandSentryUser(null);
    if (status.kind === "logged-out" && privacySync.isCurrent(request)) await completeSandSentryInitialPrivacySync();
    return;
  }
  setSandSentryUser({ id: status.authId, ...(status.email === undefined ? {} : { email: status.email }) });
  const mode = await fetchPrivacyMode();
  if (!privacySync.isCurrent(request)) return;
  const resolved = privacySync.finish(request, mode);
  if (resolved !== undefined) applySandSentryPrivacyMode(resolved);
  await completeSandSentryInitialPrivacySync();
}
export function captureSandSentryWarning(message: string): void { adapter.captureMessage(message, { level: "warning" }); }
export function captureSandDesktopCrash(error: unknown, kind: string): void { adapter.captureException(error, { tags: { "sand.process": "desktop-main", "sand.crash_kind": kind } }); }
export function captureSandDesktopStartupFailure(error: unknown, phase: string): void { adapter.captureException(error, { tags: { "sand.process": "desktop-main", "sand.startup_phase": phase } }); }
export function reportSandSentryInvariantViolation(report: { readonly name: string }): void { adapter.captureMessage(report.name, { level: "error", tags: { "sand.telemetry_report": "invariant_violation" } }); }
export function captureSandCoordinatorCrash(report: { readonly errorMessage: string; readonly errorName: string; readonly errorStack?: string; readonly kind: string }): void { const error = new Error(report.errorMessage); error.name = report.errorName; if (report.errorStack !== undefined) error.stack = report.errorStack; adapter.captureException(error, { tags: { "sand.process": "coordinator", "sand.crash_kind": report.kind } }); }
export function setSandSentryUser(user: SandSentryUser | null): void { bindSandSentryIdentity(user?.id); adapter.setUser(user); }
export function setSandSentryConversation(agentId: string | null): void { adapter.setTag(SAND_SENTRY_CONVERSATION_TAG, agentId ?? undefined); }
export function getSandSentryAppFlavor(runningUnderArm64Translation: boolean, arch = process.arch): string { return runningUnderArm64Translation ? `${arch}-rosetta` : arch; }
export function initSandSentry(options: { readonly environment: string; readonly release: string; readonly runningUnderArm64Translation?: boolean }): void { offlineTransport = adapter.init({ dsn: SAND_SENTRY_DSN, environment: options.environment, release: options.release, gate, onEnvelopeAccepted: noteAcceptedSandSentryEnvelope }); adapter.setTag("app_flavor", getSandSentryAppFlavor(options.runningUnderArm64Translation ?? false)); }
export function resolveSandSentryEnvironment(args: { readonly isLabBuild: boolean; readonly sandTrack: string }): string { if (args.isLabBuild) return "sand-lab"; if (args.sandTrack === "nightly") return "sand-nightly"; if (args.sandTrack === "dogfood") return "sand-dogfood"; return "sand"; }
export function initSandSentryForDesktop(args: { readonly enabled: boolean; readonly environment: string; readonly appVersion: string; readonly runningUnderArm64Translation?: boolean }): void { if (!args.enabled) return; const release = `sand@${args.appVersion}`; process.env.SAND_SENTRY_ENVIRONMENT = args.environment; process.env.SAND_SENTRY_RELEASE = release; try { initSandSentry({ environment: args.environment, release, ...(args.runningUnderArm64Translation === undefined ? {} : { runningUnderArm64Translation: args.runningUnderArm64Translation }) }); } catch (error) { console.error("Failed to initialize Sentry in main process", error); } }
