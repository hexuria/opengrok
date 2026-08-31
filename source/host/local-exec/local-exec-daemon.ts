import { join } from "node:path";

import { GATEWAY_NETWORK_TOKEN_HEADER } from "../../shared/gateway-wire.js";
import { SAND_LOCAL_EXEC_SUPERVISED_WINDOW_MS } from "../../shared/local-exec-daemon.js";
import { SAND_LOCAL_TOOLS_DISABLED_MESSAGE } from "../../shared/local-tool-permission-machinery.js";
import { getSandBackendClientHeaders } from "../../shared/node/sand-client-metadata.js";
import { SandSettingsStore } from "../../shared/node/settings/sand-settings-store.js";
import { getSandVariant } from "../../shared/node/sand-variant.js";
import { errorLogTag } from "../../shared/errors.js";
import { getSandRootDir } from "../host-paths.js";
import {
  clearLocalExecDaemonDiscoveryIfMatches, getLocalExecDaemonConnectionPath, getLocalExecDaemonCredentialPath, getLocalExecDaemonDiscoveryPath,
  getLocalExecSupervisorHeartbeatPath, readLocalExecDaemonConnection, readLocalExecDaemonCredential, readLocalExecSupervisorHeartbeat,
  writeLocalExecDaemonConnection, writeLocalExecDaemonDiscovery, type LocalExecConnection
} from "./local-exec-daemon-protocol.js";
import { SandLocalExecProvider, type LocalExecExecutor, type SandLocalExecProviderOptions } from "./local-exec-provider.js";

export class SandLocalExecConnectionError extends Error {}
export const NO_LOCAL_EXEC_CONNECTION_MESSAGE = "local-exec daemon has no gateway connection yet (waiting for the desktop to hand one off)";
export const LOCAL_EXEC_CONNECTION_PATH = "/sand-box/local-exec-connection";

export async function resolveLocalExecConnectionFromBackend(args: { readonly backendUrl: string; readonly credential: string; readonly fetchImpl?: typeof fetch }): Promise<LocalExecConnection | null> {
  const fetchImpl = args.fetchImpl ?? fetch; let response: Response;
  try { response = await fetchImpl(new URL(LOCAL_EXEC_CONNECTION_PATH, args.backendUrl).toString(), { method: "POST", headers: { "content-type": "application/json", ...getSandBackendClientHeaders() }, body: JSON.stringify({ credential: args.credential }) }); }
  catch { return null; }
  if (!response.ok) return null; let parsed: unknown;
  try { parsed = await response.json(); } catch { return null; }
  if (typeof parsed !== "object" || parsed == null) return null; const value = parsed as Record<string, unknown>;
  const baseUrl = typeof value.baseUrl === "string" ? value.baseUrl : ""; if (baseUrl.length === 0) return null;
  const token = typeof value.token === "string" && value.token.length > 0 ? value.token : undefined; const networkToken = typeof value.networkToken === "string" ? value.networkToken : "";
  return { baseUrl, ...(token === undefined ? {} : { token }), ...(networkToken.length === 0 ? {} : { headers: { [GATEWAY_NETWORK_TOKEN_HEADER]: networkToken } }) };
}

/**
 * Whether this Mac accepts bot commands — the on/off switch, read from the
 * local-tool permission. An enrolled machine is on unless it was explicitly
 * turned off (`never`); the legacy `always`/`ask` both mean on, because in the
 * one-consent-model world the only per-command question lives on the server
 * card. The admin ceiling still forces off through `getLocalToolPermission`.
 */
export function isLocalToolPermissionOn(permission: "always" | "ask" | "never"): boolean {
  return permission !== "never";
}

interface LocalToolPermissionStore { getLocalToolPermission(): "always" | "ask" | "never"; }
interface ProviderLifecycle { start(): void; close(): void; }
export interface RunLocalExecDaemonOptions {
  readonly connectionPath?: string; readonly credentialPath?: string; readonly supervisorHeartbeatPath?: string; readonly discoveryPath?: string;
  readonly publishDiscovery?: boolean;
  readonly settingsStore?: LocalToolPermissionStore; readonly executor?: LocalExecExecutor;
  readonly providerFactory?: (options: SandLocalExecProviderOptions) => ProviderLifecycle;
  readonly resolveConnectionFromBackend?: typeof resolveLocalExecConnectionFromBackend;
  readonly now?: () => number; readonly pid?: number;
  readonly entryRealpath?: string; readonly generationToken?: string;
}

function gatewayOrigin(url: string): string | null {
  try { return new URL(url).origin; } catch { return null; }
}

/**
 * Whether the handed-off credential belongs to the backend now in use.
 *
 * The desktop writes this credential once, naming the backend that issued it,
 * and the daemon spends it whenever its connection goes stale - asking that
 * backend for a fresh one. Crossing backends leaves the old file behind, and
 * spending it then does real damage: the previous backend answers with a
 * perfectly valid connection to a computer this account no longer uses, that
 * answer overwrites the descriptor the desktop just wrote, and every frame
 * after it is posted into a 404. Nothing recovers, because each stale refresh
 * repeats the substitution.
 *
 * So a credential is spent only when the backend that issued it is the one the
 * current connection already points at. With no connection yet there is nothing
 * to contradict - that is the bootstrap the handoff exists for, and it stands.
 */
export function localExecHandoffServesConnection(
  handoff: { readonly backendUrl: string },
  connection: { readonly baseUrl: string } | null,
): boolean {
  if (connection == null) return true;
  const issued = gatewayOrigin(handoff.backendUrl);
  const inUse = gatewayOrigin(connection.baseUrl);
  if (issued == null || inUse == null) return false;
  return issued === inUse;
}

export async function runLocalExecDaemon(options: RunLocalExecDaemonOptions = {}): Promise<{ close(): Promise<void> }> {
  const connectionPath = options.connectionPath ?? getLocalExecDaemonConnectionPath(); const credentialPath = options.credentialPath ?? getLocalExecDaemonCredentialPath(); const heartbeatPath = options.supervisorHeartbeatPath ?? getLocalExecSupervisorHeartbeatPath();
  const discoveryPath = options.discoveryPath ?? getLocalExecDaemonDiscoveryPath(); const publishDiscovery = options.publishDiscovery !== false; const backendResolver = options.resolveConnectionFromBackend ?? resolveLocalExecConnectionFromBackend;
  const now = options.now ?? Date.now; const pid = options.pid ?? process.pid; const startedAt = now(); const entryRealpath = options.entryRealpath; const generationToken = options.generationToken; if (publishDiscovery && (entryRealpath == null || generationToken == null)) throw new SandLocalExecConnectionError("local-exec daemon discovery requires canonical entry identity and generation token"); const ownedDiscovery = entryRealpath == null || generationToken == null ? null : { pid, startedAt, entryRealpath, generationToken }; let lastInflightCount = 0; let publishing = false; let publishPending = false;
  const publishDaemonDiscovery = async (): Promise<void> => { publishPending = true; if (publishing) return; publishing = true; try { while (publishPending) { publishPending = false; await writeLocalExecDaemonDiscovery({ pid, startedAt, entryRealpath: entryRealpath!, generationToken: generationToken!, inflightCount: lastInflightCount }, discoveryPath).catch((error) => console.error(`[local-exec-daemon] discovery publish failed (previous record stands): ${errorLogTag(error)}`)); } } finally { publishing = false; } };
  const settingsStore = options.settingsStore ?? new SandSettingsStore(join(getSandRootDir(), "settings.json"));
  const executor = options.executor;
  if (executor === undefined) throw new SandLocalExecConnectionError("local-exec executor runtime is not configured");
  const providerOptions: SandLocalExecProviderOptions = {
    executor,
    resolveConnection: async () => { const connection = await readLocalExecDaemonConnection(connectionPath); if (connection == null) throw new SandLocalExecConnectionError(NO_LOCAL_EXEC_CONNECTION_MESSAGE); return connection; },
    onConnectionStale: async () => { const handoff = await readLocalExecDaemonCredential(credentialPath); if (handoff == null) return; const current = await readLocalExecDaemonConnection(connectionPath); if (!localExecHandoffServesConnection(handoff, current)) return; const fresh = await backendResolver({ backendUrl: handoff.backendUrl, credential: handoff.credential }); if (fresh != null) await writeLocalExecDaemonConnection(fresh, connectionPath); },
    // The Mac switch is on/off now: the local brake, nothing more. There is no
    // daemon-side "ask" and no approvalId check - per-command consent is the
    // server's card, the one surface that reaches a phone and never expires.
    // Once this machine accepts commands, the server's dispatch is authority;
    // an off switch is the only local refusal. `isLocalToolPermissionOn` maps
    // the switch: an enrolled machine is on unless it is explicitly `never`.
    isLocalUseBlocked: () => isLocalToolPermissionOn(settingsStore.getLocalToolPermission()) ? undefined : SAND_LOCAL_TOOLS_DISABLED_MESSAGE,
    ...(publishDiscovery ? { onInflightChange: (count: number) => { lastInflightCount = count; void publishDaemonDiscovery(); } } : {}),
    isSupervised: async () => { const heartbeat = await readLocalExecSupervisorHeartbeat(heartbeatPath); return now() - heartbeat.at <= SAND_LOCAL_EXEC_SUPERVISED_WINDOW_MS; },
    variant: getSandVariant()
  };
  const provider = options.providerFactory?.(providerOptions) ?? new SandLocalExecProvider(providerOptions); provider.start(); if (publishDiscovery) await publishDaemonDiscovery();
  return { close: async () => { provider.close(); if (publishDiscovery && ownedDiscovery != null) await clearLocalExecDaemonDiscoveryIfMatches(ownedDiscovery, discoveryPath).catch((error) => console.error(`[local-exec-daemon] failed to clear discovery record on close: ${errorLogTag(error)}`)); } };
}
