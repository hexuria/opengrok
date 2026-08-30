import { join } from "node:path";

import { GATEWAY_NETWORK_TOKEN_HEADER } from "../../shared/gateway-wire.js";
import { SAND_LOCAL_EXEC_SUPERVISED_WINDOW_MS } from "../../shared/local-exec-daemon.js";
import { SAND_LOCAL_TOOLS_DISABLED_MESSAGE, SAND_LOCAL_TOOLS_UNAPPROVED_MESSAGE, localToolApprovalCovers } from "../../shared/local-tool-permission-machinery.js";
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
import { getLocalToolApprovalsPath, getLocalToolRetirementsPath, readLiveLocalToolApprovals, retireLocalToolApproval } from "./local-tool-approvals.js";

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

interface LocalToolPermissionStore { getLocalToolPermission(): "always" | "ask" | "never"; }
interface ProviderLifecycle { start(): void; close(): void; }
export interface RunLocalExecDaemonOptions {
  readonly connectionPath?: string; readonly credentialPath?: string; readonly supervisorHeartbeatPath?: string; readonly discoveryPath?: string;
  readonly approvalsPath?: string; readonly retirementsPath?: string; readonly publishDiscovery?: boolean;
  readonly settingsStore?: LocalToolPermissionStore; readonly executor?: LocalExecExecutor;
  readonly providerFactory?: (options: SandLocalExecProviderOptions) => ProviderLifecycle;
  readonly resolveConnectionFromBackend?: typeof resolveLocalExecConnectionFromBackend;
  readonly now?: () => number; readonly pid?: number;
  readonly entryRealpath?: string; readonly generationToken?: string;
}

export async function runLocalExecDaemon(options: RunLocalExecDaemonOptions = {}): Promise<{ close(): Promise<void> }> {
  const connectionPath = options.connectionPath ?? getLocalExecDaemonConnectionPath(); const credentialPath = options.credentialPath ?? getLocalExecDaemonCredentialPath(); const heartbeatPath = options.supervisorHeartbeatPath ?? getLocalExecSupervisorHeartbeatPath();
  const discoveryPath = options.discoveryPath ?? getLocalExecDaemonDiscoveryPath(); const publishDiscovery = options.publishDiscovery !== false; const backendResolver = options.resolveConnectionFromBackend ?? resolveLocalExecConnectionFromBackend;
  const now = options.now ?? Date.now; const pid = options.pid ?? process.pid; const startedAt = now(); const entryRealpath = options.entryRealpath; const generationToken = options.generationToken; if (publishDiscovery && (entryRealpath == null || generationToken == null)) throw new SandLocalExecConnectionError("local-exec daemon discovery requires canonical entry identity and generation token"); const ownedDiscovery = entryRealpath == null || generationToken == null ? null : { pid, startedAt, entryRealpath, generationToken }; let lastInflightCount = 0; let publishing = false; let publishPending = false;
  const publishDaemonDiscovery = async (): Promise<void> => { publishPending = true; if (publishing) return; publishing = true; try { while (publishPending) { publishPending = false; await writeLocalExecDaemonDiscovery({ pid, startedAt, entryRealpath: entryRealpath!, generationToken: generationToken!, inflightCount: lastInflightCount }, discoveryPath).catch((error) => console.error(`[local-exec-daemon] discovery publish failed (previous record stands): ${errorLogTag(error)}`)); } } finally { publishing = false; } };
  const settingsStore = options.settingsStore ?? new SandSettingsStore(join(getSandRootDir(), "settings.json")); const approvalsPath = options.approvalsPath ?? getLocalToolApprovalsPath(); const retirementsPath = options.retirementsPath ?? getLocalToolRetirementsPath();
  const executor = options.executor;
  if (executor === undefined) throw new SandLocalExecConnectionError("local-exec executor runtime is not configured");
  const providerOptions: SandLocalExecProviderOptions = {
    executor,
    resolveConnection: async () => { const connection = await readLocalExecDaemonConnection(connectionPath); if (connection == null) throw new SandLocalExecConnectionError(NO_LOCAL_EXEC_CONNECTION_MESSAGE); return connection; },
    onConnectionStale: async () => { const handoff = await readLocalExecDaemonCredential(credentialPath); if (handoff == null) return; const fresh = await backendResolver({ backendUrl: handoff.backendUrl, credential: handoff.credential }); if (fresh != null) await writeLocalExecDaemonConnection(fresh, connectionPath); },
    isLocalUseBlocked: async ({ approvalId, describes, terminalsFolder }) => { const permission = settingsStore.getLocalToolPermission(); if (permission === "never") return SAND_LOCAL_TOOLS_DISABLED_MESSAGE; if (permission === "always") return undefined; if (approvalId == null || approvalId.length === 0 || describes == null) return SAND_LOCAL_TOOLS_UNAPPROVED_MESSAGE; const approval = (await readLiveLocalToolApprovals(approvalsPath, retirementsPath)).get(approvalId); if (approval == null) return SAND_LOCAL_TOOLS_UNAPPROVED_MESSAGE; return localToolApprovalCovers({ ...approval, ...(approval.action === "run-command" ? { resourcePath: terminalsFolder } : {}) }, describes) ? undefined : SAND_LOCAL_TOOLS_UNAPPROVED_MESSAGE; },
    onApprovalRetired: async (approvalId) => { await retireLocalToolApproval(approvalId, approvalsPath, retirementsPath).catch((error) => console.error(`[local-exec-daemon] failed to retire approval ${approvalId}: ${errorLogTag(error)}`)); },
    ...(publishDiscovery ? { onInflightChange: (count: number) => { lastInflightCount = count; void publishDaemonDiscovery(); } } : {}),
    isSupervised: async () => { const heartbeat = await readLocalExecSupervisorHeartbeat(heartbeatPath); return now() - heartbeat.at <= SAND_LOCAL_EXEC_SUPERVISED_WINDOW_MS; },
    variant: getSandVariant()
  };
  const provider = options.providerFactory?.(providerOptions) ?? new SandLocalExecProvider(providerOptions); provider.start(); if (publishDiscovery) await publishDaemonDiscovery();
  return { close: async () => { provider.close(); if (publishDiscovery && ownedDiscovery != null) await clearLocalExecDaemonDiscoveryIfMatches(ownedDiscovery, discoveryPath).catch((error) => console.error(`[local-exec-daemon] failed to clear discovery record on close: ${errorLogTag(error)}`)); } };
}
