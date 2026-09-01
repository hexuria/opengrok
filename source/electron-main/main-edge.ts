import { randomUUID } from "node:crypto";
import { isSandAgentModelSelection, resolveComputerUseModelSelection } from "../shared/agents/sand-agent-model.js";
import { normalizeSandAutoReviewInstructions } from "../shared/sand-auto-review-instructions.js";
import { isSandLocalToolAction, normalizeSandLocalToolPermission } from "../shared/local-tool-permission.js";
import { isSandThemePreference } from "../shared/desktop.js";
import { SAND_NOTIFICATION_SOUNDS_GATE, normalizeNotificationPreferences } from "../shared/notification-sound.js";
import { isSandUpdateTrack } from "../shared/update-track.js";
import { isValidIanaTimeZone } from "../shared/timezone.js";
import { sandWebauthnProxyMirroredEnablement } from "../shared/webauthn-proxy-availability.js";
import { reportDesktopEdgeFailure } from "./desktop-edge-failures.js";
import { askpassBiometricKind, askpassService, authorizeSudoEnableProduction } from "./askpass/askpass-runtime.js";
import { isSandInferenceProvider, parseOpenRouterModelId } from "../shared/inference-router.js";
import { getLocalInferenceCliStatus } from "../shared/node/inference-router-local.js";
import { coerceBoxRuntimeForProvider, isSandBoxRuntime, OPENGROK_ACCESS_TOKEN_SECRET, OPENGROK_DAEMON_MACHINE_SECRET, OPENGROK_DAEMON_TOKEN_SECRET, OPENGROK_GATEWAY_TOKEN_SECRET } from "../shared/box-runtime.js";
import { getOpenGrokServerStatus, noteOpenGrokServerStatus } from "./box/opengrok-server-status.js";
import { getLocalDockerStatus, startLocalDockerBox } from "./box/local-docker-host-connector.js";
import { transcribeWithLocalWhisper } from "./account/local-whisper-transcribe.js";
import { GEMINI_TRANSCRIBE_MODEL, resolveGeminiApiKey, transcribeWithGemini } from "./account/gemini-transcribe.js";
import { asAttachmentBytes } from "../shared/media/bytes-base64.js";
import { getAccountComputerStatus } from "./box/account-computer-status.js";
import {
  checkinWindows365Session,
  describeWindows365Session,
  ensureWindows365Session,
  resetWindows365Session,
  testWindows365Credentials,
} from "./box/windows365/windows365-session.js";
import {
  readWindows365Credentials,
  toWindows365PublicSettings,
  writeWindows365Credentials,
} from "./box/windows365/windows365-credentials.js";
import {
  isSubscriptionInferenceProvider,
  readSubscriptionLocalStatus,
  type SubscriptionCliAuthPort,
} from "../shared/node/subscription-cli-auth.js";
import { applyInferenceProviderSwitch } from "../shared/node/provider-switch.js";
import {
  activateProviderComputer,
  isProviderComputerKind,
  migrateBoxRuntimeIntoProviderComputers,
  parseProviderComputerMap,
  selectProviderComputerScreen,
} from "../shared/provider-computers.js";
import { createSubscriptionCliAuthWiring } from "./account/subscription-cli-auth-wiring.js";

export const MAIN_EDGE_UNSERVED = "main/unserved-method";
export const MAIN_EDGE_UPDATE_UNAVAILABLE = "main/update-unavailable";
export const MAIN_EDGE_THEME_UNAVAILABLE = "main/theme-unavailable";
export const MAIN_EDGE_EGRESS_TUNNEL_UNAVAILABLE = "main/egress-tunnel-unavailable";
export const MAIN_EDGE_NOTIFICATION_SOUNDS_UNAVAILABLE = "main/notification-sounds-unavailable";

type UnknownRecord = Record<string, unknown>;
function optionalInvoke(target: UnknownRecord | undefined, method: string, ...args: unknown[]): unknown {
  if (target == null) return undefined;
  const fn = Reflect.get(target, method);
  return typeof fn === "function" ? Reflect.apply(fn, target, args) : undefined;
}
type Handler = (request: UnknownRecord) => unknown;
type HandlerMap = Record<string, Handler>;
export type ServedMainEdgeHandlerMap = Record<string, {
  readonly trust: "appWindow";
  readonly run: (request: UnknownRecord, sender?: unknown) => unknown;
}>;

export class EdgeCallFailure extends Error {
  readonly code: string;
  readonly detail: string;
  constructor(args: { readonly code: string; readonly detail: string }) { super(`${args.code}: ${args.detail}`); this.name = "EdgeCallFailure"; this.code = args.code; this.detail = args.detail; }
}
export class SandHostSettingsUnreachableError extends Error {}

export interface MainEdgeDeps {
  readonly readLiveUpdateService: () => UnknownRecord | null;
  readonly readThemeController: () => UnknownRecord | null;
  readonly readEgressTunnelController: () => UnknownRecord | null;
  readonly settingsStore: UnknownRecord;
  readonly agentPrefsStore: UnknownRecord;
  readonly boxToggleStore: UnknownRecord;
  readonly onboardingSeen: UnknownRecord;
  readonly shell: UnknownRecord;
  readonly boxRecovery: UnknownRecord;
  readonly windowChrome: UnknownRecord;
  readonly avatarImages: UnknownRecord;
  readonly attachments: UnknownRecord;
  readonly cursorAccount: UnknownRecord;
  readonly experiments: UnknownRecord;
  readonly syncHostSettingsToBox: (settings: UnknownRecord) => Promise<UnknownRecord | null>;
  readonly readHostSettingsFromBox: () => Promise<UnknownRecord>;
  readonly deleteTranscriptEntries: (args: UnknownRecord) => Promise<unknown>;
  /** Share/bookmark entry point for the multi-select UI; snapshots and stores in main. */
  readonly addCollectionMessages?: (args: UnknownRecord) => Promise<unknown>;
  /** Collection roster for the in-transcript share picker. */
  readonly listCollections?: () => Promise<unknown>;
  readonly recordLocalToolApproval: (approval: { id: string; action: string; target: string }) => Promise<void>;
  readonly clearLocalToolApprovals: () => Promise<void>;
  readonly getComputerUseModelOverride: () => unknown;
  readonly fetchAvailableModels: () => unknown;
  readonly emitEgressTunnelChanged: (enabled: boolean) => void;
  readonly emitWebauthnProxyChanged: (enabled: boolean) => void;
  readonly ensureTranscriptionManager: () => Promise<UnknownRecord>;
  readonly platform: NodeJS.Platform;
  readonly authorizeSudoEnable?: () => Promise<{ ok: boolean; error?: string }>;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly detectTimeZone?: () => string | null | undefined;
  readonly subscriptionAuth?: SubscriptionCliAuthPort;
  readonly startLocalDockerBox?: typeof startLocalDockerBox;
  readonly getLocalDockerStatus?: typeof getLocalDockerStatus;
  /** Decrypts one secret from the app's keychain-backed user secrets store. */
  readonly revealSecret?: (key: string) => Promise<string | null>;
  /** Forwards a per-agent image-metadata bust into the coordinator's local roster store. */
  readonly clearAgentImageMetadata?: (args: { id: string }) => Promise<unknown>;
}

function invariant(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function invoke(target: UnknownRecord, method: string, ...args: unknown[]): unknown { const fn = target[method]; invariant(typeof fn === "function", `Missing main-edge dependency method ${method}.`); return Reflect.apply(fn, target, args); }
function req(value: unknown): UnknownRecord { return typeof value === "object" && value != null && !Array.isArray(value) ? value as UnknownRecord : {}; }
function detectTimeZone(): string | null { const value = Intl.DateTimeFormat().resolvedOptions().timeZone; return value.length > 0 ? value : null; }
const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
/**
 * Account secrets for the OpenGrok account API, refreshed before use.
 *
 * The stored access token lives an hour; replaying it raw meant every
 * account-scoped call started failing an hour after sign-in. Ask the auth
 * service for a valid token first - the same move listOpenGrokComputers
 * already makes - and fall back to the stored one only when refresh is
 * unavailable, because refusing to refresh is not a reason to skip the call.
 */
function openGrokAccountSecrets(deps: MainEdgeDeps, gatewayUrl: string): { readSecret(key: string): Promise<string | null> } {
  return {
    readSecret: async (key: string): Promise<string | null> => {
      const secretStore = await import("./secrets/secret-store.js");
      const stored = (await secretStore.readSecret(key)) ?? "";
      if (key !== OPENGROK_ACCESS_TOKEN_SECRET) return stored.length === 0 ? null : stored;
      let access = stored;
      try {
        const fresh = await Promise.resolve(invoke(deps.cursorAccount, "getValidAccessToken", { backendUrl: gatewayUrl }));
        if (typeof fresh === "string" && fresh.length > 0) access = fresh;
      } catch { /* see above */ }
      if (access !== stored && access.length > 0) await secretStore.writeSecret(key, access);
      return access.length === 0 ? null : access;
    },
  };
}

/**
 * Mirror an auto-review tier to the OpenGrok server. The server enforces the
 * rules on our route; the local store still feeds the Cursor route's box. On
 * the Cursor route (no gateway) this is a no-op. The server field is one text
 * blob per direction - the client's rule rows joined with newlines - so the
 * judge reads each line as one instruction; the global tier always sends
 * concrete values, so a cleared list is "" (stop inheriting), never null.
 */
/** The whole-row PUT. Every field is sent; null means "inherit from below". */
async function putAutoReviewPolicyRow(
  deps: MainEdgeDeps,
  body: { readonly scopeKind: "global" | "coworker"; readonly scopeId: string; readonly enabled: boolean | null; readonly allowInstructions: string | null; readonly blockInstructions: string | null },
): Promise<void> {
  const gatewayUrl = invoke(deps.settingsStore, "getOpenGrokGatewayUrl");
  if (typeof gatewayUrl !== "string" || gatewayUrl.length === 0) return;
  const { callOpenGrokAccountApi } = await import("./box/opengrok-account-call.js");
  await callOpenGrokAccountApi(openGrokAccountSecrets(deps, gatewayUrl), OPENGROK_ACCESS_TOKEN_SECRET, gatewayUrl, {
    path: "/auto-review/policy", method: "PUT", body,
  });
}

/** One text blob per direction; [] becomes "" (explicit none), null stays null. */
function autoReviewBlob(rows: readonly string[] | null): string | null {
  return rows === null ? null : rows.join("\n");
}

/** The global tier mirrors the local instructions with concrete values only. */
async function putOpenGrokAutoReviewPolicy(
  deps: MainEdgeDeps,
  scopeKind: "global" | "coworker",
  scopeId: string,
  instructions: { readonly isEnabled: boolean; readonly allowInstructions: readonly string[]; readonly blockInstructions: readonly string[] },
): Promise<void> {
  await putAutoReviewPolicyRow(deps, {
    scopeKind, scopeId,
    enabled: instructions.isEnabled,
    allowInstructions: instructions.allowInstructions.join("\n"),
    blockInstructions: instructions.blockInstructions.join("\n"),
  });
}

function subscriptionAuthOf(deps: MainEdgeDeps): SubscriptionCliAuthPort {
  return deps.subscriptionAuth ?? createSubscriptionCliAuthWiring().port;
}
function projectLocalCliStatus(local: Awaited<ReturnType<typeof readSubscriptionLocalStatus>>) {
  return {
    codex: { installed: local.codex.installed, authenticated: local.codex.authenticated, executablePath: local.codex.executablePath, prompt: local.codex.prompt },
    "claude-code": { installed: local["claude-code"].installed, authenticated: local["claude-code"].authenticated, executablePath: local["claude-code"].executablePath, prompt: local["claude-code"].prompt },
  };
}
async function inferenceRouterLocal(deps: MainEdgeDeps) {
  try { return projectLocalCliStatus(await readSubscriptionLocalStatus(subscriptionAuthOf(deps))); }
  catch { return getLocalInferenceCliStatus(); }
}
function cloneableRecord(value: unknown): UnknownRecord {
  return JSON.parse(JSON.stringify(value)) as UnknownRecord;
}
/** Rolling dictation diagnostics: which engine served each mic request and why others were skipped. */
async function appendTranscribeLog(entry: Record<string, unknown>): Promise<void> {
  try {
    const { appendFile, mkdir, stat, rename } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { getSandRootDir } = await import("../host/host-paths.js");
    const dir = getSandRootDir();
    await mkdir(dir, { recursive: true });
    const logPath = join(dir, "transcribe-log.jsonl");
    const size = await stat(logPath).then((s) => s.size).catch(() => 0);
    if (size > 512 * 1024) await rename(logPath, `${logPath}.1`).catch(() => { /* best effort */ });
    await appendFile(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch { /* diagnostics never break dictation */ }
}

/** Last line of the dictation log, summarized for the Settings status row. */
async function lastTranscribeAttempt(): Promise<UnknownRecord | null> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { getSandRootDir } = await import("../host/host-paths.js");
    const raw = await readFile(join(getSandRootDir(), "transcribe-log.jsonl"), "utf8");
    const last = raw.trim().split("\n").at(-1);
    if (last == null || last.length === 0) return null;
    const entry = JSON.parse(last) as UnknownRecord;
    const geminiError = typeof entry.geminiError === "string" ? entry.geminiError : null;
    return {
      at: entry.at,
      engine: entry.engine,
      geminiStatus: geminiError == null
        ? (entry.engine === "gemini" ? "ok" : null)
        : geminiError.startsWith("http-429") ? "quota"
          : geminiError.startsWith("no-api-key") ? "no-key"
            : geminiError.startsWith("http-4") && (geminiError.includes("API key") || geminiError.startsWith("http-401") || geminiError.startsWith("http-403")) ? "bad-key"
              : "error",
      ...(geminiError == null ? {} : { geminiError: geminiError.slice(0, 160) }),
    };
  } catch { return null; }
}

/** The renderer saves GEMINI_API_KEY through the keychain-backed secrets UI; env and box-secrets stay as fallbacks. */
async function geminiKeyOf(deps: MainEdgeDeps): Promise<string | null> {
  const revealed = await deps.revealSecret?.("GEMINI_API_KEY").catch(() => null) ?? null;
  if (revealed != null && revealed.trim().length > 0) return revealed.trim();
  return await resolveGeminiApiKey();
}
function persistOpenRouterModel(deps: MainEdgeDeps, raw: unknown): string {
  const request = req(raw);
  const candidate = typeof request.openRouterModel === "string" ? request.openRouterModel : typeof request.model === "string" ? request.model : "";
  const parsed = parseOpenRouterModelId(candidate);
  invariant(parsed != null, "Enter an OpenRouter model id like openai/gpt-4o-mini or org/model:free.");
  invoke(deps.settingsStore, "setOpenRouterModel", parsed);
  const stored = optionalInvoke(deps.settingsStore, "getOpenRouterModel");
  invariant(typeof stored === "string" && stored.length > 0, "Enter an OpenRouter model id like openai/gpt-4o-mini or org/model:free.");
  return stored;
}
/**
 * The chosen provider and computer come from the local settings store and are
 * known synchronously. They used to be returned only after a round trip to the
 * box and two CLI probes had finished, so the settings panel sat on its
 * defaults for seconds — and showed "Cursor" and "Grok VM" as though they were
 * the saved answer. The slow lookups now run concurrently and never gate the
 * values that were already on disk.
 */
/** Settings must render from what is already on disk, never wait on the box. */
const HOST_SETTINGS_READ_BUDGET_MS = 1_500;
function withDeadline<T>(work: Promise<T>, budgetMs: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("host settings read exceeded its budget")), budgetMs);
      if (typeof timer.unref === "function") timer.unref();
    }),
  ]);
}

async function inferenceRouterState(deps: MainEdgeDeps) {
  const provider = invoke(deps.settingsStore, "getInferenceProvider");
  const resolved = isSandInferenceProvider(provider) ? provider : "cursor";
  const openRouterModel = optionalInvoke(deps.settingsStore, "getOpenRouterModel") ?? null;
  const localStatus = inferenceRouterLocal(deps);
  const [settings, local, firstRunLogins] = await Promise.all([
    // Bounded, not just caught. When the box cannot start — a stopped Docker
    // engine, say — this call does not reject, it simply never answers, and
    // measured that way it held the whole panel for seventeen seconds. The
    // only thing it contributes is recorded usage, which the local store
    // already has a copy of, so it is never worth waiting on.
    withDeadline(deps.readHostSettingsFromBox(), HOST_SETTINGS_READ_BUDGET_MS).catch(() => ({} as UnknownRecord)),
    localStatus,
    localStatus.then((status) => firstRunLoginsOf(deps, status)),
  ]);
  return {
    provider: resolved,
    usage: settings.inferenceRouterUsage ?? invoke(deps.settingsStore, "getInferenceRouterUsage") ?? null,
    local,
    computers: providerComputersOf(deps, resolved),
    firstRunLogins,
    loginWallSkipped: optionalInvoke(deps.settingsStore, "getCursorLoginWallSkipped") === true,
    openRouterModel,
    model: openRouterModel,
  };
}
function providerComputersOf(deps: MainEdgeDeps, provider: ReturnType<typeof invoke> | string) {
  const resolved = isSandInferenceProvider(provider) ? provider : "cursor";
  const store = deps.settingsStore as { getProviderComputers?: () => unknown; getBoxRuntime?: () => unknown };
  const boxRuntime = store.getBoxRuntime?.();
  const map = migrateBoxRuntimeIntoProviderComputers(
    resolved,
    isSandBoxRuntime(boxRuntime) ? boxRuntime : undefined,
    typeof store.getProviderComputers === "function" ? parseProviderComputerMap(store.getProviderComputers()) : undefined,
  );
  return { map, selectedScreen: map[resolved].selectedScreen, activated: map[resolved].activated };
}
/**
 * `local` is passed in so the settings panel probes the CLIs once per refresh
 * rather than twice: this used to start its own `inferenceRouterLocal`, and
 * that call shells out to `codex login status` and `claude auth status`.
 */
async function firstRunLoginsOf(deps: MainEdgeDeps, localStatus?: Awaited<ReturnType<typeof inferenceRouterLocal>>) {
  const local = localStatus ?? await inferenceRouterLocal(deps);
  let cursor: unknown = { kind: "logged-out" };
  try {
    if (deps.cursorAccount != null) cursor = await Promise.resolve(invoke(deps.cursorAccount, "getAuthStatus"));
  } catch {
    cursor = { kind: "logged-out" };
  }
  const cursorRecord = typeof cursor === "object" && cursor != null ? cursor as UnknownRecord : {};
  return {
    cursor: { kind: "cursor", authenticated: cursorRecord.kind === "logged-in", label: "Sign in with Cursor" },
    "claude-code": { kind: "claude-code", authenticated: local["claude-code"]?.authenticated === true, label: "Sign in with Claude", command: "claude /login" },
    codex: { kind: "codex", authenticated: local.codex?.authenticated === true, label: "Sign in with Codex", command: "codex login" },
  };
}
async function ensureBoxRuntime(deps: MainEdgeDeps, mode: "remote" | "local-docker", options: { readonly restart: boolean }) {
  const settingsPath = String(Reflect.get(deps.settingsStore, "settingsPath"));
  invoke(deps.settingsStore, "setBoxRuntime", mode);
  try {
    if (mode === "local-docker") await (deps.startLocalDockerBox ?? startLocalDockerBox)(settingsPath);
  } catch (error) {
    invoke(deps.settingsStore, "setBoxRuntime", mode === "local-docker" ? "remote" : "local-docker");
    throw error;
  }
  if (options.restart) invoke(deps.boxRecovery, "restartCoordinator");
  return { mode, status: await (deps.getLocalDockerStatus ?? getLocalDockerStatus)(settingsPath) };
}

export function createMainEdgeTrust() { return { appWindow: { kind: "require" as const, test: (sender: { isAppWindowTopFrame?: boolean }) => sender.isAppWindowTopFrame === true, denial: "The main edge is only accessible from the Sand app window's top frame." } }; }
export const unserved = (): never => { throw new EdgeCallFailure({ code: MAIN_EDGE_UNSERVED, detail: "This method still rides its hand-wired preload channel." }); };
function required(read: () => UnknownRecord | null, code: string, detail: string): UnknownRecord { const value = read(); if (value == null) throw new EdgeCallFailure({ code, detail }); return value; }
function updateService(deps: MainEdgeDeps) { return required(deps.readLiveUpdateService, MAIN_EDGE_UPDATE_UNAVAILABLE, "The update service is not running."); }
function themeController(deps: MainEdgeDeps) { return required(deps.readThemeController, MAIN_EDGE_THEME_UNAVAILABLE, "The theme controller is not running."); }
function egressController(deps: MainEdgeDeps) { return required(deps.readEgressTunnelController, MAIN_EDGE_EGRESS_TUNNEL_UNAVAILABLE, "The egress tunnel controller is not running."); }
async function echo(deps: MainEdgeDeps, field: string, value: unknown, label: string): Promise<unknown> { const result = await deps.syncHostSettingsToBox({ [field]: value }); if (result == null) throw new SandHostSettingsUnreachableError(`Couldn't reach the computer to save ${label}.`); return result[field] ?? null; }
/** The reader stays open so an already-stored preference still round-trips; only writes are gated. */
async function notificationSoundsEnabled(deps: MainEdgeDeps): Promise<boolean> {
  const snapshot = req(invoke(req(await Promise.resolve(invoke(deps.experiments, "ensureService"))), "getSnapshot"));
  return req(snapshot.featureGates)[SAND_NOTIFICATION_SOUNDS_GATE] === true;
}
function computerUseModel(deps: MainEdgeDeps): unknown { const stored = invoke(deps.agentPrefsStore, "getComputerUseModel"); const override = deps.getComputerUseModelOverride(); return resolveComputerUseModelSelection({ ...(isSandAgentModelSelection(stored) ? { storedModel: stored } : {}), ...(isSandAgentModelSelection(override) ? { overrideModel: override } : {}) }) ?? null; }
function parseAgentModel(value: unknown, requireNonWhitespaceId: boolean): { modelId: string; maxMode: boolean; parameters: { id: string; value: string }[] } | null {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return null;
  const record = value as UnknownRecord;
  if (typeof record.modelId !== "string" || record.modelId.length === 0 || (requireNonWhitespaceId && record.modelId.trim().length === 0) || typeof record.maxMode !== "boolean" || !Array.isArray(record.parameters)) return null;
  const parameters: { id: string; value: string }[] = [];
  for (const raw of record.parameters) { if (typeof raw !== "object" || raw == null || Array.isArray(raw)) return null; const parameter = raw as UnknownRecord; if (typeof parameter.id !== "string" || parameter.id.length === 0 || typeof parameter.value !== "string") return null; parameters.push({ id: parameter.id, value: parameter.value }); }
  return { modelId: record.modelId, maxMode: record.maxMode, parameters };
}

export function createMainEdgeHandlers(deps: MainEdgeDeps): HandlerMap {
  const handlers: HandlerMap = {
    getUpdateStatus: () => invoke(updateService(deps), "getStatus"),
    checkForUpdates: () => invoke(updateService(deps), "checkForUpdates", { trigger: "explicit" }),
    setUpdateTrack: (raw) => { const { track } = req(raw); const service = updateService(deps); return track === null ? invoke(service, "setTrackOverride", null) : isSandUpdateTrack(track) ? invoke(service, "setTrackOverride", track) : invoke(service, "getStatus"); },
    quitAndInstallUpdate: () => { invoke(updateService(deps), "quitAndInstall"); },
    setAutoUpdateWhenIdleOptIn: (raw) => invoke(updateService(deps), "setAutoUpdateWhenIdleOptIn", req(raw).enabled === true),

    getTimeZone: () => ({ detectedTimeZone: (deps.detectTimeZone ?? detectTimeZone)() ?? null, overrideTimeZone: invoke(deps.settingsStore, "getUserTimeZoneOverride") ?? null }),
    setTimeZoneOverride: (raw) => { const { timeZone } = req(raw); if (timeZone === null) invoke(deps.settingsStore, "setUserTimeZoneOverride", undefined); else if (typeof timeZone === "string" && isValidIanaTimeZone(timeZone)) invoke(deps.settingsStore, "setUserTimeZoneOverride", timeZone); const detected = (deps.detectTimeZone ?? detectTimeZone)(); void deps.syncHostSettingsToBox({ ...(detected == null ? {} : { userTimeZone: detected }), userTimeZoneOverride: invoke(deps.settingsStore, "getUserTimeZoneOverride") ?? "" }); return { detectedTimeZone: (deps.detectTimeZone ?? detectTimeZone)() ?? null, overrideTimeZone: invoke(deps.settingsStore, "getUserTimeZoneOverride") ?? null }; },
    getAutoReviewInstructions: () => invoke(deps.settingsStore, "getAutoReviewInstructions"),
    setAutoReviewInstructions: async (raw) => { const value = req(raw).instructions; const instructions = typeof value === "object" && value != null && !Array.isArray(value) ? value as { isEnabled?: unknown; allowInstructions?: unknown; blockInstructions?: unknown } : undefined; const normalized = normalizeSandAutoReviewInstructions(instructions); invoke(deps.settingsStore, "setAutoReviewInstructions", normalized); try { await deps.syncHostSettingsToBox({ autoReviewInstructions: normalized }); } catch (error) { reportDesktopEdgeFailure("host-settings", "auto-review", error); } await putOpenGrokAutoReviewPolicy(deps, "global", "", normalized).catch((error) => reportDesktopEdgeFailure("host-settings", "auto-review-global", error)); return invoke(deps.settingsStore, "getAutoReviewInstructions"); },
    getLocalComputer: async () => {
      const { hostname } = await import("node:os");
      let machine = "";
      try { machine = hostname(); } catch { machine = ""; }
      const chosen = invoke(deps.settingsStore, "getLocalComputerName");
      return { name: typeof chosen === "string" && chosen.length > 0 ? chosen : machine, hostname: machine, isCustom: typeof chosen === "string" && chosen.length > 0 };
    },
    setLocalComputerName: (raw) => {
      const name = req(raw).name;
      invariant(typeof name === "string" && name.length <= 120, "setLocalComputerName requires a bounded name.");
      invoke(deps.settingsStore, "setLocalComputerName", name);
      return { ok: true };
    },
    getLocalToolPermission: () => invoke(deps.settingsStore, "getLocalToolPermission"),
    getSudoAskpassEnabled: () => ({ enabled: invoke(deps.settingsStore, "getSudoAskpassEnabled") === true, available: deps.platform !== "win32", biometric: askpassBiometricKind() }),
    setSudoAskpassEnabled: async (raw) => {
      // Turning off is free; turning on must be authenticated (Touch ID, or a
      // validated sudo password) so an agent can't flip its own master switch.
      if (req(raw).enabled !== true) {
        invoke(deps.settingsStore, "setSudoAskpassEnabled", false);
        return { enabled: false, available: deps.platform !== "win32", biometric: askpassBiometricKind() };
      }
      const outcome = await (deps.authorizeSudoEnable ?? authorizeSudoEnableProduction)();
      if (outcome.ok) invoke(deps.settingsStore, "setSudoAskpassEnabled", true);
      return { enabled: invoke(deps.settingsStore, "getSudoAskpassEnabled") === true, available: deps.platform !== "win32", biometric: askpassBiometricKind(), ...(outcome.error == null ? {} : { error: outcome.error }) };
    },
    getLocalToolPermissionCeiling: () => invoke(deps.settingsStore, "getLocalToolPermissionCeiling") ?? null,
    setLocalToolPermission: async (raw) => { invoke(deps.settingsStore, "setLocalToolPermission", normalizeSandLocalToolPermission(req(raw).permission)); for (let attempt = 0; attempt < 3; attempt += 1) { const permission = invoke(deps.settingsStore, "getLocalToolPermission"); try { const applied = await deps.syncHostSettingsToBox({ localToolPermission: permission }); if (applied?.localToolPermission === permission) break; } catch (error) { reportDesktopEdgeFailure("host-settings", "local-tool-retry", error); } await (deps.delay ?? sleep)(250 * (attempt + 1)); } return invoke(deps.settingsStore, "getLocalToolPermission"); },
    recordLocalToolApproval: async (raw) => { const { approvalId, action, target } = req(raw); invariant(typeof approvalId === "string" && approvalId.length > 0 && isSandLocalToolAction(action) && typeof target === "string", "A local-tool approval needs its request id and action."); await deps.recordLocalToolApproval({ id: approvalId, action, target }); },
    clearLocalToolApprovals: async () => { await deps.clearLocalToolApprovals().catch((error: unknown) => reportDesktopEdgeFailure("local-tool-approvals", "clear", error)); },

    getAskpassPrompt: () => askpassService()?.pendingPrompt() ?? null,
    respondAskpass: (raw) => {
      const { id, password } = req(raw);
      const answer = typeof password === "string" ? password : null;
      const resolved = typeof id === "string" && askpassService()?.resolvePrompt(id, answer) === true;
      return { resolved };
    },

    getThemeState: () => invoke(themeController(deps), "getState"),
    setThemePreference: (raw) => { const controller = themeController(deps); const preference = req(raw).preference; return isSandThemePreference(preference) ? invoke(controller, "setPreference", preference) : invoke(controller, "getState"); },
    getDesktopNotificationPreferences: () => invoke(deps.settingsStore, "getDesktopNotificationPreferences"),
    setDesktopNotificationPreferences: async (raw) => { if (!await notificationSoundsEnabled(deps)) throw new EdgeCallFailure({ code: MAIN_EDGE_NOTIFICATION_SOUNDS_UNAVAILABLE, detail: `Notification sounds are behind the ${SAND_NOTIFICATION_SOUNDS_GATE} gate.` }); invoke(deps.settingsStore, "setDesktopNotificationPreferences", normalizeNotificationPreferences(req(raw).preferences)); return invoke(deps.settingsStore, "getDesktopNotificationPreferences"); },
    getAgentDefaultModel: async () => { const settings = await deps.readHostSettingsFromBox(); invoke(deps.agentPrefsStore, "setAgentDefaultModel", settings.agentDefaultModel); return settings.agentDefaultModel ?? null; },
    setAgentDefaultModel: async (raw) => { const model = parseAgentModel(req(raw).model, false); if (model == null) return invoke(deps.agentPrefsStore, "getAgentDefaultModel") ?? null; const result = await deps.syncHostSettingsToBox({ agentDefaultModel: model }); if (result == null) throw new SandHostSettingsUnreachableError("Couldn't reach the computer to save the default model."); invoke(deps.agentPrefsStore, "setAgentDefaultModel", result.agentDefaultModel); return result.agentDefaultModel ?? null; },
    getComputerUseModel: () => computerUseModel(deps),
    setComputerUseModel: (raw) => { const requested = req(raw).model; const model = requested === null ? null : parseAgentModel(requested, true); if (requested === null || model != null) { invoke(deps.agentPrefsStore, "setComputerUseModel", model ?? undefined); void deps.syncHostSettingsToBox({ computerUseModel: invoke(deps.agentPrefsStore, "getComputerUseModel") ?? null }); } return computerUseModel(deps); },
    getHostPinnedAgents: async () => (await deps.readHostSettingsFromBox()).pinnedAgentIds ?? null,
    setHostPinnedAgents: (raw) => echo(deps, "pinnedAgentIds", req(raw).pinnedAgentIds, "pinned agents"),
    getHostSidebarSections: async () => (await deps.readHostSettingsFromBox()).sidebarSections ?? null,
    setHostSidebarSections: (raw) => echo(deps, "sidebarSections", req(raw).sections, "sidebar sections"),
    getAvailableModels: () => deps.fetchAvailableModels(),
    getInferenceRouter: async () => cloneableRecord(await inferenceRouterState(deps)),
    setInferenceRouter: async (raw) => {
      const request = req(raw);
      const hasModel = typeof request.openRouterModel === "string" || typeof request.model === "string";
      if (hasModel) persistOpenRouterModel(deps, request);
      if (!isSandInferenceProvider(request.provider)) {
        if (request.provider != null && request.provider !== "") invariant(false, "Unknown inference provider.");
        return cloneableRecord({ ...(await inferenceRouterState(deps)), persisted: hasModel, applied: hasModel });
      }
      const current = invoke(deps.settingsStore, "getInferenceProvider");
      const switched = await applyInferenceProviderSwitch({
        requested: request.provider,
        current: isSandInferenceProvider(current) ? current : "cursor",
        auth: subscriptionAuthOf(deps),
        persist: (value) => { invoke(deps.settingsStore, "setInferenceProvider", value); },
      });
      if (!switched.ok) throw new Error(switched.error ?? "This provider is not signed in.");
      // A settings store without a box runtime has nothing to coerce.
      const hasRuntimeSettings = typeof Reflect.get(deps.settingsStore, "getBoxRuntime") === "function" && typeof Reflect.get(deps.settingsStore, "setBoxRuntime") === "function";
      const runtimeSettingsPath = String(Reflect.get(deps.settingsStore, "settingsPath"));
      const currentRuntime = hasRuntimeSettings ? invoke(deps.settingsStore, "getBoxRuntime") : undefined;
      const nextRuntime = isSandBoxRuntime(currentRuntime) ? coerceBoxRuntimeForProvider(currentRuntime, switched.provider) : undefined;
      if (nextRuntime != null && nextRuntime !== currentRuntime) {
        invoke(deps.settingsStore, "setBoxRuntime", nextRuntime);
        // Subscription providers run on the desktop host, not the Docker VM.
        if (nextRuntime === "local-docker" && !isSubscriptionInferenceProvider(switched.provider)) await (deps.startLocalDockerBox ?? startLocalDockerBox)(runtimeSettingsPath).catch((error: unknown) => reportDesktopEdgeFailure("box-runtime", "attach-local-vm", error));
        invoke(deps.boxRecovery, "restartCoordinator");
      }
      const computers = providerComputersOf(deps, switched.provider);
      const openRouterModel = optionalInvoke(deps.settingsStore, "getOpenRouterModel") ?? null;
      return cloneableRecord({
        provider: switched.provider,
        persisted: switched.persisted,
        applied: switched.applied,
        previousLoggedOut: switched.previousLoggedOut,
        computerImpact: switched.computer,
        usage: invoke(deps.settingsStore, "getInferenceRouterUsage") ?? null,
        local: projectLocalCliStatus(switched.local),
        computers,
        firstRunLogins: await firstRunLoginsOf(deps),
        openRouterModel,
        model: openRouterModel,
        ...(hasRuntimeSettings ? { mode: invoke(deps.settingsStore, "getBoxRuntime") } : {}),
      });
    },
    setOpenRouterModel: async (raw) => {
      persistOpenRouterModel(deps, raw);
      return cloneableRecord({ ...(await inferenceRouterState(deps)), persisted: true, applied: true });
    },
    startSubscriptionLogin: async (raw) => {
      const provider = req(raw).provider;
      invariant(isSubscriptionInferenceProvider(provider), "Subscription login is only for Claude or Codex.");
      return await subscriptionAuthOf(deps).startLogin(provider);
    },
    skipCursorLoginWall: async (raw) => {
      optionalInvoke(deps.settingsStore, "setCursorLoginWallSkipped", true);
      const requested = req(raw).provider;
      if (isSandInferenceProvider(requested)) {
        invoke(deps.settingsStore, "setInferenceProvider", requested);
        const hasRuntimeSettings = typeof Reflect.get(deps.settingsStore, "getBoxRuntime") === "function" && typeof Reflect.get(deps.settingsStore, "setBoxRuntime") === "function";
        const currentRuntime = hasRuntimeSettings ? invoke(deps.settingsStore, "getBoxRuntime") : undefined;
        const nextRuntime = isSandBoxRuntime(currentRuntime) ? coerceBoxRuntimeForProvider(currentRuntime, requested) : undefined;
        if (nextRuntime != null && nextRuntime !== currentRuntime) {
          invoke(deps.settingsStore, "setBoxRuntime", nextRuntime);
          const runtimeSettingsPath = String(Reflect.get(deps.settingsStore, "settingsPath") ?? "");
          // Subscription providers run on the desktop host, not the Docker VM.
          if (nextRuntime === "local-docker" && !isSubscriptionInferenceProvider(requested)) await (deps.startLocalDockerBox ?? startLocalDockerBox)(runtimeSettingsPath).catch((error: unknown) => reportDesktopEdgeFailure("box-runtime", "attach-local-vm", error));
          optionalInvoke(deps.boxRecovery, "restartCoordinator");
        }
      }
      const provider = invoke(deps.settingsStore, "getInferenceProvider");
      const resolved = isSandInferenceProvider(provider) ? provider : "cursor";
      return {
        skipped: true,
        provider: resolved,
        loginWallSkipped: true,
        local: await inferenceRouterLocal(deps),
        computers: providerComputersOf(deps, resolved),
      };
    },
    getProviderComputers: async () => {
      const provider = invoke(deps.settingsStore, "getInferenceProvider");
      const resolved = isSandInferenceProvider(provider) ? provider : "cursor";
      return { provider: resolved, computers: providerComputersOf(deps, resolved) };
    },
    setProviderComputer: async (raw) => {
      const kind = req(raw).kind;
      invariant(isProviderComputerKind(kind), "Unknown computer kind.");
      const enabled = req(raw).enabled === true;
      const provider = invoke(deps.settingsStore, "getInferenceProvider");
      const resolved = isSandInferenceProvider(provider) ? provider : "cursor";
      const current = providerComputersOf(deps, resolved);
      const next = { ...current.map, [resolved]: activateProviderComputer(resolved, current.map[resolved], kind, enabled) };
      invoke(deps.settingsStore, "setProviderComputers", next);
      const selected = next[resolved].selectedScreen;
      if (enabled && kind === "local-docker") await ensureBoxRuntime(deps, "local-docker", { restart: false });
      return { provider: resolved, computers: { map: next, selectedScreen: selected, activated: next[resolved].activated } };
    },
    setComputerScreen: async (raw) => {
      const screen = req(raw).screen;
      invariant(isProviderComputerKind(screen), "Unknown computer screen.");
      const provider = invoke(deps.settingsStore, "getInferenceProvider");
      const resolved = isSandInferenceProvider(provider) ? provider : "cursor";
      const current = providerComputersOf(deps, resolved);
      const nextConfig = selectProviderComputerScreen(resolved, current.map[resolved], screen);
      const next = { ...current.map, [resolved]: nextConfig };
      invoke(deps.settingsStore, "setProviderComputers", next);
      return { provider: resolved, computers: { map: next, selectedScreen: nextConfig.selectedScreen, activated: nextConfig.activated }, computerImpact: { restartCoordinator: false, recreateComputer: false, markUnreachable: false, recoverComputer: false, changeProvider: false } };
    },
    getBoxRuntime: async () => { const mode = invoke(deps.settingsStore, "getBoxRuntime"); invariant(isSandBoxRuntime(mode), "Unknown box runtime."); const settingsPath = String(Reflect.get(deps.settingsStore, "settingsPath")); return { mode, status: await (deps.getLocalDockerStatus ?? getLocalDockerStatus)(settingsPath), windows365: await describeWindows365Session(settingsPath), account: getAccountComputerStatus(), openGrok: { ...getOpenGrokServerStatus(), configuredUrl: invoke(deps.settingsStore, "getOpenGrokGatewayUrl") ?? null } }; },
    setBoxRuntime: async (raw) => { const requested = req(raw).mode; invariant(isSandBoxRuntime(requested), "Unknown box runtime."); const provider = invoke(deps.settingsStore, "getInferenceProvider"); const mode = coerceBoxRuntimeForProvider(requested, isSandInferenceProvider(provider) ? provider : "cursor"); const settingsPath = String(Reflect.get(deps.settingsStore, "settingsPath")); const previous = invoke(deps.settingsStore, "getBoxRuntime"); invoke(deps.settingsStore, "setBoxRuntime", mode); /* Crossing between backends changes who the account belongs to, so the old session cannot survive it: signing in to an OpenGrok server must sign you out of Cursor, and leaving must sign you out of the server. One account, never two. */ if ((previous === "opengrok") !== (mode === "opengrok")) { try { await Promise.resolve(invoke(deps.cursorAccount, "logout")); } catch { /* already signed out */ } } try { if (mode === "local-docker") await (deps.startLocalDockerBox ?? startLocalDockerBox)(settingsPath); } catch (error) { invoke(deps.settingsStore, "setBoxRuntime", previous); throw error; } invoke(deps.boxRecovery, "restartCoordinator"); return { mode, status: await (deps.getLocalDockerStatus ?? getLocalDockerStatus)(settingsPath), windows365: await describeWindows365Session(settingsPath), account: getAccountComputerStatus(), openGrok: { ...getOpenGrokServerStatus(), configuredUrl: invoke(deps.settingsStore, "getOpenGrokGatewayUrl") ?? null } }; },
    getRemoteControl: async () => {
      const gatewayUrl = invoke(deps.settingsStore, "getOpenGrokGatewayUrl");
      if (typeof gatewayUrl !== "string" || gatewayUrl.length === 0) return { available: false, enrolled: false };
      const secrets = await import("./secrets/secret-store.js");
      const machineId = (await secrets.readSecret(OPENGROK_DAEMON_MACHINE_SECRET)) ?? "";
      const hasToken = ((await secrets.readSecret(OPENGROK_DAEMON_TOKEN_SECRET)) ?? "").length > 0;
      // Turn off keeps the machine id so Turn on can re-enrol the same computer.
      if (machineId.length === 0 || !hasToken) {
        return { available: true, enrolled: false, ...(machineId.length > 0 ? { machineId } : {}) };
      }
      try {
        const { callOpenGrokAccountApi } = await import("./box/opengrok-account-call.js");
        const policy = await callOpenGrokAccountApi(openGrokAccountSecrets(deps, gatewayUrl), OPENGROK_ACCESS_TOKEN_SECRET, gatewayUrl, {
          path: "/local-exec/policy", query: { machine: machineId },
        }) as Record<string, unknown> | undefined;
        const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
        return {
          available: true, enrolled: true, machineId,
          mode: typeof policy?.mode === "string" ? policy.mode : "never",
          allow: strings(policy?.allow), deny: strings(policy?.deny),
        };
      } catch (error) {
        return { available: true, enrolled: true, machineId, error: String(error instanceof Error ? error.message : error) };
      }
    },
    enrolRemoteControl: async (raw) => {
      const label = req(raw).label;
      invariant(typeof label === "string" && label.length > 0 && label.length <= 120, "enrolRemoteControl requires a bounded label.");
      const gatewayUrl = invoke(deps.settingsStore, "getOpenGrokGatewayUrl");
      invariant(typeof gatewayUrl === "string" && gatewayUrl.length > 0, "No OpenGrok server is configured.");
      const secrets = await import("./secrets/secret-store.js");
      const { callOpenGrokAccountApi } = await import("./box/opengrok-account-call.js");
      const secretsHandle = openGrokAccountSecrets(deps, gatewayUrl);
      const remembered = (await secrets.readSecret(OPENGROK_DAEMON_MACHINE_SECRET)) ?? "";
      const reply = await callOpenGrokAccountApi(secretsHandle, OPENGROK_ACCESS_TOKEN_SECRET, gatewayUrl, {
        path: "/local-exec/daemon", method: "POST",
        body: remembered.length > 0 ? { label, machineId: remembered } : { label },
      }) as Record<string, unknown> | undefined;
      const machineId = typeof reply?.machineId === "string" ? reply.machineId : "";
      const token = typeof reply?.token === "string" ? reply.token : "";
      invariant(machineId.length > 0 && token.length > 0, "The server did not return a machine and a token.");
      // Shown once by the server, so it is stored here and never asked for again.
      await secrets.writeSecret(OPENGROK_DAEMON_TOKEN_SECRET, token);
      await secrets.writeSecret(OPENGROK_DAEMON_MACHINE_SECRET, machineId);
      // A fresh enrolment, and Turn on after Turn off, both land in Never. Card
      // Always/Never presses then write nothing, so lift Never to Ask.
      try {
        const policy = await callOpenGrokAccountApi(secretsHandle, OPENGROK_ACCESS_TOKEN_SECRET, gatewayUrl, {
          path: "/local-exec/policy", query: { machine: machineId },
        }) as Record<string, unknown> | undefined;
        const mode = typeof policy?.mode === "string" ? policy.mode : "never";
        if (mode === "never") {
          await callOpenGrokAccountApi(secretsHandle, OPENGROK_ACCESS_TOKEN_SECRET, gatewayUrl, {
            path: "/local-exec/policy", method: "PUT", body: { machineId, mode: "ask" },
          });
        }
      } catch { /* enrolled; they can still pick a mode in Settings */ }
      return { machineId };
    },
    stopRemoteControl: async () => {
      const gatewayUrl = invoke(deps.settingsStore, "getOpenGrokGatewayUrl");
      invariant(typeof gatewayUrl === "string" && gatewayUrl.length > 0, "No OpenGrok server is configured.");
      const secrets = await import("./secrets/secret-store.js");
      const machineId = (await secrets.readSecret(OPENGROK_DAEMON_MACHINE_SECRET)) ?? "";
      invariant(machineId.length > 0, "This computer is not enrolled for remote control.");
      const { callOpenGrokAccountApi } = await import("./box/opengrok-account-call.js");
      // Mode never first: the server must stop dispatching before we drop the
      // local token. The machine id stays so Turn on re-enrols the same computer.
      await callOpenGrokAccountApi(openGrokAccountSecrets(deps, gatewayUrl), OPENGROK_ACCESS_TOKEN_SECRET, gatewayUrl, {
        path: "/local-exec/policy", method: "PUT", body: { machineId, mode: "never" },
      });
      await secrets.deleteSecret(OPENGROK_DAEMON_TOKEN_SECRET);
      return { enrolled: false };
    },
    revokeRemoteControl: async () => {
      const gatewayUrl = invoke(deps.settingsStore, "getOpenGrokGatewayUrl");
      const secrets = await import("./secrets/secret-store.js");
      const machineId = (await secrets.readSecret(OPENGROK_DAEMON_MACHINE_SECRET)) ?? "";
      // The local credential goes first: if the server call fails, this machine
      // has still stopped being able to act, which is the safer half to lose.
      await secrets.deleteSecret(OPENGROK_DAEMON_TOKEN_SECRET);
      await secrets.deleteSecret(OPENGROK_DAEMON_MACHINE_SECRET);
      if (typeof gatewayUrl === "string" && gatewayUrl.length > 0 && machineId.length > 0) {
        try {
          const { callOpenGrokAccountApi } = await import("./box/opengrok-account-call.js");
          await callOpenGrokAccountApi(openGrokAccountSecrets(deps, gatewayUrl), OPENGROK_ACCESS_TOKEN_SECRET, gatewayUrl, {
            path: `/local-exec/daemon/${encodeURIComponent(machineId)}`, method: "DELETE",
          });
        } catch { /* the credential is already gone from this machine */ }
      }
      return { enrolled: false };
    },
    setRemoteControlMode: async (raw) => {
      const mode = req(raw).mode;
      invariant(mode === "never" || mode === "ask" || mode === "bypass", "Unknown remote control mode.");
      const gatewayUrl = invoke(deps.settingsStore, "getOpenGrokGatewayUrl");
      invariant(typeof gatewayUrl === "string" && gatewayUrl.length > 0, "No OpenGrok server is configured.");
      const secrets = await import("./secrets/secret-store.js");
      const machineId = (await secrets.readSecret(OPENGROK_DAEMON_MACHINE_SECRET)) ?? "";
      invariant(machineId.length > 0, "This computer is not enrolled for remote control.");
      const { callOpenGrokAccountApi } = await import("./box/opengrok-account-call.js");
      await callOpenGrokAccountApi(openGrokAccountSecrets(deps, gatewayUrl), OPENGROK_ACCESS_TOKEN_SECRET, gatewayUrl, {
        path: "/local-exec/policy", method: "PUT", body: { machineId, mode },
      });
      return { mode };
    },
    deleteRemoteControlRule: async (raw) => {
      const kind = req(raw).kind; const pattern = req(raw).pattern;
      invariant(kind === "allow" || kind === "deny", "A standing rule is allow or deny.");
      invariant(typeof pattern === "string" && pattern.length > 0, "A standing rule needs its pattern.");
      const gatewayUrl = invoke(deps.settingsStore, "getOpenGrokGatewayUrl");
      invariant(typeof gatewayUrl === "string" && gatewayUrl.length > 0, "No OpenGrok server is configured.");
      const secrets = await import("./secrets/secret-store.js");
      const machineId = (await secrets.readSecret(OPENGROK_DAEMON_MACHINE_SECRET)) ?? "";
      invariant(machineId.length > 0, "This computer is not enrolled for remote control.");
      const { callOpenGrokAccountApi } = await import("./box/opengrok-account-call.js");
      // The server matches the pattern exactly, so it is passed back untouched
      // from what getRemoteControl (GET /local-exec/policy) handed the UI.
      await callOpenGrokAccountApi(openGrokAccountSecrets(deps, gatewayUrl), OPENGROK_ACCESS_TOKEN_SECRET, gatewayUrl, {
        path: "/local-exec/policy/rule", method: "DELETE", body: { machineId, kind, pattern },
      });
      return { kind, pattern };
    },
    getAgentAutoReview: async (raw) => {
      const agentId = req(raw).agentId;
      invariant(typeof agentId === "string" && agentId.length > 0, "getAgentAutoReview needs an agent id.");
      const gatewayUrl = invoke(deps.settingsStore, "getOpenGrokGatewayUrl");
      if (typeof gatewayUrl !== "string" || gatewayUrl.length === 0) return { available: false };
      try {
        const secrets = openGrokAccountSecrets(deps, gatewayUrl);
        const { callOpenGrokAccountApi } = await import("./box/opengrok-account-call.js");
        const [policy, effective] = await Promise.all([
          callOpenGrokAccountApi(secrets, OPENGROK_ACCESS_TOKEN_SECRET, gatewayUrl, { path: "/auto-review/policy" }),
          callOpenGrokAccountApi(secrets, OPENGROK_ACCESS_TOKEN_SECRET, gatewayUrl, { path: "/auto-review/effective", query: { coworkerId: agentId } }),
        ]);
        const coworkers = typeof policy === "object" && policy != null ? (policy as Record<string, unknown>).coworkers : undefined;
        const row = typeof coworkers === "object" && coworkers != null ? (coworkers as Record<string, unknown>)[agentId] ?? null : null;
        return { available: true, row, effective: effective ?? null };
      } catch (error) {
        return { available: true, error: String(error instanceof Error ? error.message : error) };
      }
    },
    setAgentAutoReview: async (raw) => {
      const r = req(raw);
      const agentId = r.agentId;
      invariant(typeof agentId === "string" && agentId.length > 0, "setAgentAutoReview needs an agent id.");
      const enabled = r.enabled === true ? true : r.enabled === false ? false : null;
      // null/undefined => inherit; an array => concrete rows, trimmed with blank
      // lines dropped so the judge never sees an empty rule mid-blob ([] stays
      // [] => "" = explicit none).
      const asRows = (v: unknown): string[] | null => v === null || v === undefined ? null : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter((x) => x.length > 0) : null;
      await putAutoReviewPolicyRow(deps, {
        scopeKind: "coworker", scopeId: agentId, enabled,
        allowInstructions: autoReviewBlob(asRows(r.allowInstructions)),
        blockInstructions: autoReviewBlob(asRows(r.blockInstructions)),
      });
      return { agentId };
    },
    deleteAgentAutoReview: async (raw) => {
      const agentId = req(raw).agentId;
      invariant(typeof agentId === "string" && agentId.length > 0, "deleteAgentAutoReview needs an agent id.");
      const gatewayUrl = invoke(deps.settingsStore, "getOpenGrokGatewayUrl");
      invariant(typeof gatewayUrl === "string" && gatewayUrl.length > 0, "No OpenGrok server is configured.");
      const { callOpenGrokAccountApi } = await import("./box/opengrok-account-call.js");
      await callOpenGrokAccountApi(openGrokAccountSecrets(deps, gatewayUrl), OPENGROK_ACCESS_TOKEN_SECRET, gatewayUrl, {
        path: "/auto-review/policy", method: "DELETE", body: { scopeKind: "coworker", scopeId: agentId },
      });
      return { agentId };
    },
    getOpenGrokAgentIssues: async () => {
      const gatewayUrl = invoke(deps.settingsStore, "getOpenGrokGatewayUrl");
      if (typeof gatewayUrl !== "string" || gatewayUrl.length === 0) return { issues: [] };
      try {
        const secrets = await import("./secrets/secret-store.js");
        const { callOpenGrokGateway } = await import("./box/opengrok-gateway-call.js");
        const agents = await callOpenGrokGateway(secrets, gatewayUrl, "listAgents", {});
        const rows = Array.isArray(agents) ? agents : [];
        const issues = rows.flatMap((row) => {
          if (typeof row !== "object" || row == null) return [];
          const record = row as Record<string, unknown>;
          const id = typeof record.id === "string" ? record.id : "";
          const failure = record.computerError;
          if (id.length === 0 || typeof failure !== "object" || failure == null) return [];
          const detail = failure as Record<string, unknown>;
          return [{
            agentId: id,
            code: typeof detail.code === "string" && detail.code.length > 0 ? detail.code : "unknown",
            message: typeof detail.message === "string" ? detail.message : "",
          }];
        });
        return { issues };
      } catch {
        // A roster we cannot read is not a bot with a broken computer.
        return { issues: [] };
      }
    },
    stopOpenGrokAgentTurn: async (raw) => {
      const agentId = req(raw).agentId;
      invariant(typeof agentId === "string" && agentId.length > 0, "stopOpenGrokAgentTurn requires an agent id.");
      const gatewayUrl = invoke(deps.settingsStore, "getOpenGrokGatewayUrl");
      invariant(typeof gatewayUrl === "string" && gatewayUrl.length > 0, "No OpenGrok server is configured.");
      const secrets = await import("./secrets/secret-store.js");
      const { callOpenGrokGateway } = await import("./box/opengrok-gateway-call.js");
      const reply = await callOpenGrokGateway(secrets, gatewayUrl, "stopAgentTurn", { agentId });
      const record = typeof reply === "object" && reply != null ? (reply as Record<string, unknown>) : {};
      return { agentId, isRunning: record.isRunning === true };
    },
    resetOpenGrokComputer: async () => {
      const gatewayUrl = invoke(deps.settingsStore, "getOpenGrokGatewayUrl");
      invariant(typeof gatewayUrl === "string" && gatewayUrl.length > 0, "No OpenGrok server is configured.");
      const secrets = await import("./secrets/secret-store.js");
      const { callOpenGrokGateway } = await import("./box/opengrok-gateway-call.js");
      const { listOpenGrokComputers } = await import("./box/opengrok-signin.js");
      const access = (await secrets.readSecret(OPENGROK_ACCESS_TOKEN_SECRET)) ?? "";
      invariant(access.length > 0, "Sign in to your OpenGrok server first.");

      const listed = await listOpenGrokComputers(gatewayUrl, access);
      invariant(listed.sharingMode !== "per-org", "This computer belongs to your whole organisation. An admin can reset it from the server's admin dashboard.");

      // Reset is scoped by agent, and for a shared computer any of the account's
      // agents names the same box.
      const agents = await callOpenGrokGateway(secrets, gatewayUrl, "listAgents", {});
      const rows = Array.isArray(agents) ? agents : [];
      const agentId = rows.map((row) => (typeof row === "object" && row != null ? (row as Record<string, unknown>).id : undefined))
        .find((id): id is string => typeof id === "string" && id.length > 0);
      invariant(agentId != null, "There is no bot yet, so there is no computer to reset.");

      const status = await callOpenGrokGateway(secrets, gatewayUrl, "resetForeverBox", { agentId });
      const record = typeof status === "object" && status != null ? (status as Record<string, unknown>) : {};
      return {
        state: typeof record.state === "string" ? record.state : null,
        computerError: typeof record.computerError === "object" && record.computerError != null ? record.computerError : null,
      };
    },
    listOpenGrokComputers: async () => {
      const gatewayUrl = invoke(deps.settingsStore, "getOpenGrokGatewayUrl");
      if (typeof gatewayUrl !== "string" || gatewayUrl.length === 0) return { computers: [], computerError: null, activeKind: null, sharingMode: null, signedIn: false };
      try {
        const secretStore = await import("./secrets/secret-store.js");
        const stored = (await secretStore.readSecret(OPENGROK_ACCESS_TOKEN_SECRET)) ?? "";
        if (stored.length === 0) return { computers: [], computerError: null, activeKind: null, sharingMode: null, signedIn: false };
        let access = stored;
        try {
          const fresh = await Promise.resolve(invoke(deps.cursorAccount, "getValidAccessToken", { backendUrl: gatewayUrl }));
          if (typeof fresh === "string" && fresh.length > 0) access = fresh;
        } catch { /* refusing to refresh is not a reason to skip the call */ }
        if (access !== stored) await secretStore.writeSecret(OPENGROK_ACCESS_TOKEN_SECRET, access);
        const { listOpenGrokComputers } = await import("./box/opengrok-signin.js");
        const listed = await listOpenGrokComputers(gatewayUrl, access);
        return { computers: listed.computers, computerError: listed.computerError, activeKind: listed.activeKind, sharingMode: listed.sharingMode, signedIn: true };
      } catch (error) {
        return { computers: [], computerError: null, activeKind: null, sharingMode: null, signedIn: true, error: String(error instanceof Error ? error.message : error) };
      }
    },
    signInToOpenGrokServer: async (raw) => {
      const body = req(raw);
      const signin = await import("./box/opengrok-signin.js");
      const base = signin.assertUsableServerUrl(typeof body.gatewayUrl === "string" ? body.gatewayUrl : "");
      const params = signin.createLoginParams(base);
      // The browser step is what proves a person is here: the server binds the
      // uuid to the account only when this page is opened, and only then will
      // poll release a token to the matching verifier.
      try { void (require("electron") as { shell: { openExternal(url: string): Promise<void> } }).shell.openExternal(params.loginUrl); } catch { /* headless or blocked */ }
      const identity = await signin.pollForOpenGrokToken(base, params.uuid, params.verifier);
      const mint = await signin.mintOpenGrokGateway(base, identity.accessToken);
      const secrets = await import("./secrets/secret-store.js");
      await secrets.writeSecret(OPENGROK_ACCESS_TOKEN_SECRET, identity.accessToken);
      await secrets.writeSecret(OPENGROK_GATEWAY_TOKEN_SECRET, mint.gatewayToken);
      await secrets.writeSecret("cursor-access-token", identity.accessToken);
      await secrets.writeSecret("cursor-refresh-token", identity.refreshToken ?? identity.accessToken);
      try { await Promise.resolve(invoke(deps.cursorAccount, "adoptExternalCredentials")); } catch { /* older wiring */ }
      invoke(deps.settingsStore, "setOpenGrokGatewayUrl", mint.gatewayUrl);
      invoke(deps.boxRecovery, "restartCoordinator");
      return {
        gatewayUrl: mint.gatewayUrl,
        signedIn: true,
        email: identity.email ?? null,
        accountId: identity.accountId ?? null,
        status: getOpenGrokServerStatus(),
      };
    },
    signOutOfOpenGrokServer: async () => {
      const secrets = await import("./secrets/secret-store.js");
      for (const key of [OPENGROK_ACCESS_TOKEN_SECRET, OPENGROK_GATEWAY_TOKEN_SECRET]) {
        try { await secrets.deleteSecret(key); } catch { /* nothing stored */ }
      }
      invoke(deps.settingsStore, "setOpenGrokGatewayUrl", undefined);
      if (invoke(deps.settingsStore, "getBoxRuntime") === "opengrok") invoke(deps.settingsStore, "setBoxRuntime", "local-docker");
      noteOpenGrokServerStatus({ ok: false, detail: "Signed out.", gatewayUrl: null });
      invoke(deps.boxRecovery, "restartCoordinator");
      return { gatewayUrl: null, signedIn: false, email: null, accountId: null, status: getOpenGrokServerStatus() };
    },
    getOpenGrokServer: async () => {
      const gatewayUrl = invoke(deps.settingsStore, "getOpenGrokGatewayUrl");
      let hasToken = false;
      let signedIn = false;
      let email: string | null = null;
      try {
        const secrets = await import("./secrets/secret-store.js");
        hasToken = ((await secrets.readSecret(OPENGROK_GATEWAY_TOKEN_SECRET)) ?? "").length > 0;
        const access = (await secrets.readSecret(OPENGROK_ACCESS_TOKEN_SECRET)) ?? "";
        signedIn = access.length > 0;
        if (signedIn) email = (await import("./box/opengrok-signin.js")).readIdentityClaims(access).email ?? null;
      } catch { hasToken = false; signedIn = false; }
      return { gatewayUrl: typeof gatewayUrl === "string" ? gatewayUrl : null, hasToken, signedIn, email, status: getOpenGrokServerStatus() };
    },
    setOpenGrokServer: async (raw) => {
      const body = req(raw);
      const gatewayUrl = typeof body.gatewayUrl === "string" ? body.gatewayUrl.trim() : "";
      // An empty URL clears the mode: drop the setting and the bearer together, and
      // fall back to the local VM so the app is never left without a computer.
      if (gatewayUrl.length === 0) {
        invoke(deps.settingsStore, "setOpenGrokGatewayUrl", undefined);
        try { await (await import("./secrets/secret-store.js")).deleteSecret(OPENGROK_GATEWAY_TOKEN_SECRET); } catch { /* nothing stored */ }
        if (invoke(deps.settingsStore, "getBoxRuntime") === "opengrok") invoke(deps.settingsStore, "setBoxRuntime", "local-docker");
        noteOpenGrokServerStatus({ ok: false, detail: "Not connected yet.", gatewayUrl: null });
        invoke(deps.boxRecovery, "restartCoordinator");
        return { gatewayUrl: null, hasToken: false, status: getOpenGrokServerStatus() };
      }
      try { new URL(gatewayUrl); } catch { throw new Error("That is not a valid URL. Include the scheme, for example http://192.168.1.10:1447"); }
      invoke(deps.settingsStore, "setOpenGrokGatewayUrl", gatewayUrl);
      if (typeof body.token === "string" && body.token.trim().length > 0) await (await import("./secrets/secret-store.js")).writeSecret(OPENGROK_GATEWAY_TOKEN_SECRET, body.token.trim());
      let hasToken = false;
      try { hasToken = ((await (await import("./secrets/secret-store.js")).readSecret(OPENGROK_GATEWAY_TOKEN_SECRET)) ?? "").length > 0; } catch { hasToken = false; }
      invoke(deps.boxRecovery, "restartCoordinator");
      return { gatewayUrl, hasToken, status: getOpenGrokServerStatus() };
    },
    getWindows365Settings: async () => toWindows365PublicSettings(await readWindows365Credentials(String(Reflect.get(deps.settingsStore, "settingsPath")))),
    setWindows365Settings: async (raw) => toWindows365PublicSettings(await writeWindows365Credentials(String(Reflect.get(deps.settingsStore, "settingsPath")), req(raw))),
    getWindows365Session: async () => await describeWindows365Session(String(Reflect.get(deps.settingsStore, "settingsPath"))),
    checkoutWindows365: async () => await ensureWindows365Session(String(Reflect.get(deps.settingsStore, "settingsPath"))),
    checkinWindows365: async () => await checkinWindows365Session(String(Reflect.get(deps.settingsStore, "settingsPath"))),
    resetWindows365: async () => await resetWindows365Session(String(Reflect.get(deps.settingsStore, "settingsPath"))),
    testWindows365: async () => await testWindows365Credentials(String(Reflect.get(deps.settingsStore, "settingsPath"))),
    deleteTranscriptEntries: (raw) => { const { agentId, entryIds } = req(raw); invariant(typeof agentId === "string" && agentId.length > 0 && Array.isArray(entryIds), "A transcript deletion names its agent and entry ids."); return deps.deleteTranscriptEntries({ agentId, entryIds: entryIds.filter((id): id is string => typeof id === "string") }); },
    addCollectionMessages: async (raw) => {
      const { agentId, entryIds, target, collectionId, name } = req(raw);
      invariant(typeof agentId === "string" && agentId.length > 0 && Array.isArray(entryIds), "Sharing to a collection names its agent and entry ids.");
      const add = deps.addCollectionMessages;
      invariant(add != null, "Collections are not available in this build.");
      return cloneableRecord(await add({
        agentId,
        entryIds: entryIds.filter((id): id is string => typeof id === "string"),
        ...(typeof target === "string" ? { target } : {}),
        ...(typeof collectionId === "string" ? { collectionId } : {}),
        ...(typeof name === "string" ? { name } : {}),
      }));
    },
    listCollections: async () => {
      const list = deps.listCollections;
      invariant(list != null, "Collections are not available in this build.");
      return cloneableRecord(await list());
    },

    getEgressTunnelEnabled: () => invoke(deps.boxToggleStore, "getEgressTunnelEnabled"),
    setEgressTunnelEnabled: (raw) => { const enabled = req(raw).enabled === true; invoke(deps.boxToggleStore, "setEgressTunnelEnabled", enabled); invoke(egressController(deps), "setEnabled", enabled); deps.emitEgressTunnelChanged(enabled); return enabled; },
    getEgressTunnelStatus: () => invoke(egressController(deps), "getStatus"),
    getWebauthnProxyEnabled: () => invoke(deps.boxToggleStore, "getWebauthnProxyEnabled"),
    setWebauthnProxyEnabled: async (raw) => { const enabled = req(raw).enabled === true; invoke(deps.boxToggleStore, "setWebauthnProxyEnabled", enabled); deps.emitWebauthnProxyChanged(enabled); const mirrored = sandWebauthnProxyMirroredEnablement(enabled, deps.platform); for (let attempt = 0; attempt < 3; attempt += 1) { const applied = await deps.syncHostSettingsToBox({ webauthnProxyEnabled: mirrored }); if (applied?.webauthnProxyEnabled === mirrored) break; await (deps.delay ?? sleep)(250 * (attempt + 1)); } return invoke(deps.boxToggleStore, "getWebauthnProxyEnabled"); },
    getOnboardingSeen: async () => await Promise.resolve(invoke(deps.onboardingSeen, "reconcile")) === true,
    setOnboardingSeen: (raw) => { const seen = req(raw).seen; if (typeof seen === "boolean") void Promise.resolve(invoke(deps.onboardingSeen, "apply", seen)); },

    openExternal: (raw) => invoke(deps.shell, "openExternalUrl", req(raw).url),
    openCloudAgent: async (raw) => { const bcId = typeof req(raw).bcId === "string" ? (req(raw).bcId as string).trim() : ""; if (bcId.length === 0) return; const base = process.env.SAND_CURSOR_WEBSITE_URL?.trim() || process.env.CURSOR_WEBSITE_URL?.trim() || "https://cursor.com"; await Promise.resolve(invoke(deps.shell, "openInSystemBrowser", new URL(`/agents/${encodeURIComponent(bcId)}`, base).toString())); },
    submitFeedback: (raw) => invoke(deps.shell, "submitFeedback", raw),
    markDeepLinksReady: () => { invoke(deps.shell, "markDeepLinksReady"); },
    getBoxMigrationStatus: () => invoke(deps.boxRecovery, "readBoxMigrationStatus"),
    forceReconnectGateway: () => { invoke(deps.boxRecovery, "restartCoordinator"); },
    forceRecreateComputer: () => invoke(deps.boxRecovery, "forceRecreateComputer"),
    updateComputer: async (raw) => { const { id } = req(raw); invariant(typeof id === "string", "A computer update names the agent by its string id."); const force = req(raw).force === true; const result = req(await Promise.resolve(invoke(deps.boxRecovery, "recreateComputer", { preserveData: true, force }))); if (result.status !== "dev-fallback") return result; await Promise.resolve(invoke(deps.boxRecovery, "updateForeverBox", { id, force })); return { status: "dev-fallback-finished" }; },

    getWindowState: () => invoke(deps.windowChrome, "getWindowState"), minimizeWindow: () => { invoke(deps.windowChrome, "minimize"); }, toggleMaximizeWindow: () => { invoke(deps.windowChrome, "toggleMaximize"); }, closeWindow: () => { invoke(deps.windowChrome, "close"); },
    setTitleBarOverlayTone: (raw) => { invoke(deps.windowChrome, "setTitleBarOverlayTone", req(raw).isOverlayTone === true); },
    resizeWindowWidth: (raw) => { const delta = req(raw).deltaWidth; return typeof delta === "number" && Number.isFinite(delta) && delta !== 0 ? invoke(deps.windowChrome, "resizeWidth", delta) : 0; },
    pickAvatarSource: () => invoke(deps.avatarImages, "pickSource"), pickAvatarFile: () => invoke(deps.avatarImages, "pickFile"), generateAgentAvatarImage: (raw) => invoke(deps.avatarImages, "generateImage", req(raw).description),
    resolveAttachmentMedia: (raw) => invoke(deps.attachments, "resolveMedia", req(raw).source), readAttachmentText: (raw) => invoke(deps.attachments, "readText", req(raw).path), readAttachmentBytes: (raw) => invoke(deps.attachments, "readBytes", req(raw).path, req(raw).maxBytes), stageAttachmentBytes: (raw) => invoke(deps.attachments, "stageBytes", req(raw)), downloadAttachment: (raw) => invoke(deps.attachments, "download", req(raw).path, req(raw).suggestedName), commitStagedAttachments: (raw) => invoke(deps.attachments, "commitStaged", req(raw).paths, req(raw).filenames), discardStagedAttachment: (raw) => invoke(deps.attachments, "discardStaged", req(raw).path), getLinkMetadata: (raw) => invoke(deps.attachments, "getLinkMetadata", req(raw).url),
    getCursorAuthStatus: () => invoke(deps.cursorAccount, "getAuthStatus"), loginCursor: () => invoke(deps.cursorAccount, "login"), cancelCursorLogin: () => invoke(deps.cursorAccount, "cancelLogin"), logoutCursor: () => invoke(deps.cursorAccount, "logout"), updateCursorAccountName: (raw) => invoke(deps.cursorAccount, "updateAccountName", req(raw).name), getCursorAvatar: () => invoke(deps.cursorAccount, "getAvatar"), getCursorWeeklyUsage: () => invoke(deps.cursorAccount, "getWeeklyUsage"), getCursorUsageSummary: () => invoke(deps.cursorAccount, "getUsageSummary"), getCursorPrReviewPreferences: () => invoke(deps.cursorAccount, "getPrReviewPreferences"), getCursorPrivacyModeEnabled: () => invoke(deps.cursorAccount, "getPrivacyModeEnabled"), getSandAccess: () => invoke(deps.cursorAccount, "getSandAccess"), getSandAccessFresh: () => invoke(deps.cursorAccount, "getSandAccessFresh"), invokeCursorDashboardAction: (raw) => invoke(deps.cursorAccount, "invokeDashboardAction", raw), cancelCursorSandTrial: () => invoke(deps.cursorAccount, "cancelTrial"),
    transcribeAudio: async (raw) => {
      const request = req(raw);
      // The 0.18 renderer hands audio across the contextBridge, which can
      // deliver a plain clone instead of a typed array — decode all shapes.
      const audio = asAttachmentBytes(request.audio);
      invariant(audio != null && audio.length > 0, "transcribeAudio requires non-empty audio bytes.");
      const mimeType = typeof request.mimeType === "string" && request.mimeType.length > 0 ? request.mimeType : "audio/webm";
      const language = typeof request.language === "string" && request.language.length > 0 ? request.language : undefined;
      const transcribeRequest = { audio, mimeType, ...(language === undefined ? {} : { language }) };
      const startedAtMs = Date.now();
      const trace: Record<string, unknown> = { bytes: audio.length, mimeType, ...(language === undefined ? {} : { language }) };
      const finish = <T extends { text?: unknown }>(engine: string, result: T): T => {
        void appendTranscribeLog({ ...trace, engine, durationMs: Date.now() - startedAtMs, textChars: typeof result?.text === "string" ? result.text.length : -1 });
        return result;
      };
      // Order: the user's opted-in Gemini transcription, then the official
      // Cursor transcription (needs a Cursor access token), then a local
      // whisper.cpp install for routed (logged-out) sessions.
      if (optionalInvoke(deps.settingsStore, "getGeminiTranscribeEnabled") === true) {
        const hinted = optionalInvoke(deps.settingsStore, "getGeminiTranscribeLanguages");
        trace.geminiLanguages = Array.isArray(hinted) ? hinted : [];
        const gemini = await transcribeWithGemini(transcribeRequest, {
          apiKey: await geminiKeyOf(deps),
          ...(Array.isArray(hinted) && hinted.length > 0 ? { languageCodes: hinted as string[] } : {}),
          onFailure: (reason) => { trace.geminiError = reason; },
        });
        if (gemini != null) return finish("gemini", gemini);
      }
      let cursorError: unknown;
      try { const manager = await deps.ensureTranscriptionManager(); return finish("cursor", req(await Promise.resolve(invoke(manager, "transcribe", transcribeRequest))) as { text: string; transcriptionTimeMs: number }); }
      catch (error) { cursorError = error; trace.cursorError = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200); }
      // The renderer's locale (en-US) forces whisper to English, which mangles
      // mixed speech. When the configured transcription languages go beyond
      // English, let whisper auto-detect instead.
      const configuredTags = optionalInvoke(deps.settingsStore, "getGeminiTranscribeLanguages");
      const englishOnly = !Array.isArray(configuredTags) || configuredTags.length === 0 || configuredTags.every((tag) => String(tag).toLowerCase().startsWith("en"));
      const local = await transcribeWithLocalWhisper(englishOnly ? transcribeRequest : { audio, mimeType });
      if (local != null && local.text.length > 0) return finish("whisper", local);
      trace.whisperError = local == null ? "unavailable-or-failed" : "empty-transcript";
      void appendTranscribeLog({ ...trace, engine: "none", durationMs: Date.now() - startedAtMs });
      throw cursorError;
    },
    getHardwareAcceleration: () => ({
      enabled: (optionalInvoke(deps.settingsStore, "getHardwareAccelerationEnabled") as boolean | undefined) ?? deps.platform === "darwin",
      platformDefault: deps.platform === "darwin",
      // Chromium fixes the GPU decision at startup; changes apply on relaunch.
      restartRequired: true,
    }),
    setHardwareAcceleration: (raw) => {
      const enabled = req(raw).enabled;
      invariant(typeof enabled === "boolean", "setHardwareAcceleration requires enabled: boolean.");
      invoke(deps.settingsStore, "setHardwareAccelerationEnabled", enabled);
      return {
        enabled,
        platformDefault: deps.platform === "darwin",
        restartRequired: true,
      };
    },
    clearAgentMediaCache: async (raw) => {
      const id = typeof req(raw).id === "string" ? req(raw).id as string : "";
      if (id.length === 0) return cloneableRecord({ cleared: 0 });
      try {
        const result = await deps.clearAgentImageMetadata?.({ id });
        return cloneableRecord(typeof result === "object" && result != null ? result as UnknownRecord : { cleared: 0 });
      } catch { return cloneableRecord({ cleared: 0 }); }
    },
    getTranscribeSettings: async () => cloneableRecord({
      geminiEnabled: optionalInvoke(deps.settingsStore, "getGeminiTranscribeEnabled") === true,
      geminiKeySet: await geminiKeyOf(deps) != null,
      languages: optionalInvoke(deps.settingsStore, "getGeminiTranscribeLanguages") ?? [],
      model: GEMINI_TRANSCRIBE_MODEL,
      lastAttempt: await lastTranscribeAttempt(),
    }),
    setTranscribeSettings: async (raw) => {
      const request = req(raw);
      if (typeof request.geminiEnabled === "boolean") invoke(deps.settingsStore, "setGeminiTranscribeEnabled", request.geminiEnabled);
      if (typeof request.languages === "string" || Array.isArray(request.languages)) invoke(deps.settingsStore, "setGeminiTranscribeLanguages", request.languages);
      return cloneableRecord({
        geminiEnabled: optionalInvoke(deps.settingsStore, "getGeminiTranscribeEnabled") === true,
        geminiKeySet: await geminiKeyOf(deps) != null,
        languages: optionalInvoke(deps.settingsStore, "getGeminiTranscribeLanguages") ?? [],
        model: GEMINI_TRANSCRIBE_MODEL,
      });
    },
    getExperimentsSnapshot: async () => invoke(req(await Promise.resolve(invoke(deps.experiments, "ensureService"))), "getSnapshot"),
    applyFeatureFlagOverride: async (raw) => { const service = req(await Promise.resolve(invoke(deps.experiments, "ensureService"))); invoke(service, "applyFeatureFlagOverrideCommand", req(raw).command); },
    refreshFeatureFlags: async () => { const service = req(await Promise.resolve(invoke(deps.experiments, "ensureService"))); await Promise.resolve(invoke(service, "refreshNow")); },
    startRpcTraceWindow: async () => { const service = req(await Promise.resolve(invoke(deps.experiments, "ensureService"))); const snapshot = req(invoke(service, "getSnapshot")); if (snapshot.featureFlags == null || invoke(deps.experiments, "isTelemetryDisabled") === true) return false; return invoke(deps.experiments, "startRpcTraceWindow"); },
  };
  for (const name of ["getDesktopEnvironment", "getSidebarCollapsed", "setSidebarCollapsed", "reportAgentLoad", "reportAccessBlocked", "reportAgentsUnreachable", "reportRecoveryAction", "reportRebuildLifecycle", "reportReconciliation", "reportBoxVisibility", "reportSendLatency", "reportSendAck", "reportReactionAck", "reportRenderTtfr", "reportRenderStream", "reportVncSession", "reportVncLiveness", "reportOpenComputer", "reportUpdatePrompt", "reportSigninGate", "reportOnboardingStep", "reportClientFailure", "listSecrets", "revealSecret", "upsertSecrets", "removeSecrets", "getMcpState", "getEffectivePlugins", "getMcpCatalog", "getMcpTeamPopularity", "getMcpPluginLogo", "installEntry", "updatePluginInstall", "removeMcpServer", "uninstallPlugin", "authenticateMcpServer", "renameMcpAccount", "removeMcpAccount", "setMcpCustomInstructions", "listMcpServerTools", "toggleMcpToolDisabled"]) handlers[name] = unserved;
  return handlers;
}

/** Exact `edgeFamily()("appWindow", ...)` stamp applied by every emitted group. */
export function createMainEdgeServedHandlers(deps: MainEdgeDeps): ServedMainEdgeHandlerMap {
  const handlers = createMainEdgeHandlers(deps);
  return Object.fromEntries(
    Object.entries(handlers).map(([name, run]) => [name, { trust: "appWindow", run }]),
  );
}
