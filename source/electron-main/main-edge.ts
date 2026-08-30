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
import { isSandInferenceProvider, parseOpenRouterModelId } from "../shared/inference-router.js";
import { getLocalInferenceCliStatus } from "../shared/node/inference-router-local.js";
import { coerceBoxRuntimeForProvider, isSandBoxRuntime, OPENGROK_ACCESS_TOKEN_SECRET, OPENGROK_GATEWAY_TOKEN_SECRET } from "../shared/box-runtime.js";
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
    setAutoReviewInstructions: async (raw) => { const value = req(raw).instructions; const instructions = typeof value === "object" && value != null && !Array.isArray(value) ? value as { isEnabled?: unknown; allowInstructions?: unknown; blockInstructions?: unknown } : undefined; const normalized = normalizeSandAutoReviewInstructions(instructions); invoke(deps.settingsStore, "setAutoReviewInstructions", normalized); try { await deps.syncHostSettingsToBox({ autoReviewInstructions: normalized }); } catch (error) { reportDesktopEdgeFailure("host-settings", "auto-review", error); } return invoke(deps.settingsStore, "getAutoReviewInstructions"); },
    getLocalToolPermission: () => invoke(deps.settingsStore, "getLocalToolPermission"),
    getLocalToolPermissionCeiling: () => invoke(deps.settingsStore, "getLocalToolPermissionCeiling") ?? null,
    setLocalToolPermission: async (raw) => { invoke(deps.settingsStore, "setLocalToolPermission", normalizeSandLocalToolPermission(req(raw).permission)); for (let attempt = 0; attempt < 3; attempt += 1) { const permission = invoke(deps.settingsStore, "getLocalToolPermission"); try { const applied = await deps.syncHostSettingsToBox({ localToolPermission: permission }); if (applied?.localToolPermission === permission) break; } catch (error) { reportDesktopEdgeFailure("host-settings", "local-tool-retry", error); } await (deps.delay ?? sleep)(250 * (attempt + 1)); } return invoke(deps.settingsStore, "getLocalToolPermission"); },
    recordLocalToolApproval: async (raw) => { const { approvalId, action, target } = req(raw); invariant(typeof approvalId === "string" && approvalId.length > 0 && isSandLocalToolAction(action) && typeof target === "string", "A local-tool approval needs its request id and action."); await deps.recordLocalToolApproval({ id: approvalId, action, target }); },
    clearLocalToolApprovals: async () => { await deps.clearLocalToolApprovals().catch((error: unknown) => reportDesktopEdgeFailure("local-tool-approvals", "clear", error)); },

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
        if (nextRuntime === "local-docker") await (deps.startLocalDockerBox ?? startLocalDockerBox)(runtimeSettingsPath).catch((error: unknown) => reportDesktopEdgeFailure("box-runtime", "attach-local-vm", error));
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
          if (nextRuntime === "local-docker") await (deps.startLocalDockerBox ?? startLocalDockerBox)(runtimeSettingsPath).catch((error: unknown) => reportDesktopEdgeFailure("box-runtime", "attach-local-vm", error));
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
    listOpenGrokComputers: async () => {
      const gatewayUrl = invoke(deps.settingsStore, "getOpenGrokGatewayUrl");
      if (typeof gatewayUrl !== "string" || gatewayUrl.length === 0) return { computers: [], signedIn: false };
      try {
        const secretStore = await import("./secrets/secret-store.js");
        const stored = (await secretStore.readSecret(OPENGROK_ACCESS_TOKEN_SECRET)) ?? "";
        if (stored.length === 0) return { computers: [], signedIn: false };
        let access = stored;
        try {
          const fresh = await Promise.resolve(invoke(deps.cursorAccount, "getValidAccessToken", { backendUrl: gatewayUrl }));
          if (typeof fresh === "string" && fresh.length > 0) access = fresh;
        } catch { /* refusing to refresh is not a reason to skip the call */ }
        if (access !== stored) await secretStore.writeSecret(OPENGROK_ACCESS_TOKEN_SECRET, access);
        const { listOpenGrokComputers } = await import("./box/opengrok-signin.js");
        return { computers: await listOpenGrokComputers(gatewayUrl, access), signedIn: true };
      } catch (error) {
        return { computers: [], signedIn: true, error: String(error instanceof Error ? error.message : error) };
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
