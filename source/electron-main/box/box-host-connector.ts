import type { PartialMessage } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { AUTOMATION_FAILURE_HINT_HEADER, SAND_UPDATE_REQUIRED_HINT } from "./account-computer-status.js";
import { type EnsureSandBoxRequest, type EnsureSandBoxResponse, type ForceRecreateSandBoxRequest, type RecreateSandBoxRequest, type RecreateSandBoxResponse } from "../../packages/proto/generated/aiserver/v1/sand_box_pb.js";
import { GrokBotService } from "../../packages/proto/generated/aiserver/v1/grok_bot_connect.js";
import { ErrorDetails } from "../../packages/proto/generated/aiserver/v1/utils_pb.js";
import { createSandCursorBackendClient, getSandInferenceBackendUrl } from "../../shared/node/cursor-backend/cursor-inference.js";
import { getAccessTokenExpiryMs, getConfiguredBackendUrl } from "../../shared/node/cursor-token.js";
import { getSandBackendClientHeaders } from "../../shared/node/sand-client-metadata.js";
import { parseSandBoxMigrationOperationId } from "../../shared/box-migration.js";
import { GATEWAY_ACCESS_DENIED_MESSAGE_MARKER, CLOUD_AGENT_STORAGE_DISABLED, GATEWAY_NO_STORAGE_MESSAGE_MARKER, SAND_BOX_BLOCKED, SAND_BOX_BLOCK_REASON_KEY, encodeSandBoxBlockedMessage, type SandBoxBlockedInfo } from "../../shared/gateway-reachability.js";
import { GATEWAY_NETWORK_TOKEN_HEADER } from "../../shared/gateway-wire.js";
import { createGatewayConnectFastPath, type GatewayConnection, type GatewayDescriptorStore } from "./gateway-descriptor-cache.js";
import type { RecreateResult } from "./box-recreate-commands.js";

export const LOCAL_EXEC_DAEMON_CREDENTIAL_PATH = "/sand-box/local-exec-daemon-credential";
export const GATEWAY_URL_ENV = "SAND_HOST_GATEWAY_URL";
export const GATEWAY_TOKEN_ENV = "SAND_HOST_GATEWAY_TOKEN";
export const GATEWAY_NETWORK_TOKEN_ENV = "SAND_HOST_GATEWAY_NETWORK_TOKEN";
export const BOX_BLOCKED_FALLBACK_HOLD_MS = 60_000;
export const BOX_BLOCKED_MAX_HOLD_MS = 15 * 60_000;

export { AUTOMATION_FAILURE_HINT_HEADER, formatAccountComputerError, getAccountComputerStatus, noteAccountComputerStatus, SAND_UPDATE_REQUIRED_HINT, type AccountComputerStatus } from "./account-computer-status.js";

export class SandBoxHostConnectError extends Error {}
export class SandComputerRecreateRefusedError extends Error {}

export interface BrokerBox { gatewayUrl: string; gatewayToken: string; networkToken: string; vncUrl: string; forkVncBaseUrl: string }
export interface BrokerClient {
  ensureSandBox(request: PartialMessage<EnsureSandBoxRequest>): Promise<EnsureSandBoxResponse>;
  recreateSandBox(request: PartialMessage<RecreateSandBoxRequest>): Promise<RecreateSandBoxResponse>;
  forceRecreateSandBox(request: PartialMessage<ForceRecreateSandBoxRequest>): Promise<RecreateSandBoxResponse>;
}
export interface BrokerDeps {
  getAccessToken(options: { backendUrl: string }): Promise<string>;
  getMachineId(): Promise<string> | string;
}

export interface SandRemoteHostConnector {
  connect(): Promise<GatewayConnection>;
  recreate?(args: { readonly preserveData: boolean; readonly force?: boolean }): Promise<RecreateResult>;
  forceRecreate?(): Promise<RecreateResult>;
  issueLocalExecDaemonCredential?(): Promise<{ readonly credential: string; readonly backendUrl: string; readonly expiresAtMs?: number } | undefined>;
  issueInferenceCredential?(): Promise<{ readonly accessToken: string; readonly backendUrl: string; readonly expiresAtMs: number } | undefined>;
}

export function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (value == null) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1_000, BOX_BLOCKED_MAX_HOLD_MS) : undefined;
}

export function buildConnection(baseUrl: string, token: string, networkToken: string, vncUrls?: { primaryUrl: string; forkBaseUrl: string }): GatewayConnection {
  const isPodProxied = networkToken.length > 0 && vncUrls != null && vncUrls.primaryUrl.length > 0 && vncUrls.forkBaseUrl.length > 0;
  return {
    baseUrl,
    ...(token.length > 0 ? { token } : {}),
    ...(networkToken.length > 0 ? { headers: { [GATEWAY_NETWORK_TOKEN_HEADER]: networkToken } } : {}),
    ...(isPodProxied ? { vncProxy: { ...vncUrls, networkToken } } : {}),
  };
}

function readBlockedInfoOrEmpty(error: ConnectError): SandBoxBlockedInfo {
  const details = error.findDetails(ErrorDetails)[0]?.details;
  return {
    reason: details?.additionalInfo[SAND_BOX_BLOCK_REASON_KEY] ?? "",
    title: details?.title ?? "",
    detail: details?.detail ?? "",
  };
}
function blockedError(info: SandBoxBlockedInfo, cause?: ConnectError): ConnectError {
  return new ConnectError(encodeSandBoxBlockedMessage(info), cause?.code ?? Code.ResourceExhausted, cause?.metadata, undefined, cause);
}

export class BrokeredHostConnector {
  private blocked: { info: SandBoxBlockedInfo; untilMs: number } | undefined;
  private readonly client: BrokerClient;
  constructor(private readonly deps: BrokerDeps, client?: BrokerClient, private readonly updateSink?: { noteBackendUpdateRequirement(required: boolean): void }) {
    this.client = client ?? createSandCursorBackendClient(GrokBotService, deps);
  }

  async connect(): Promise<GatewayConnection> {
    if (this.blocked != null && Date.now() < this.blocked.untilMs) throw blockedError(this.blocked.info);
    let box: BrokerBox;
    try { box = await this.client.ensureSandBox({}); }
    catch (error) {
      if (error instanceof ConnectError && error.metadata.get(AUTOMATION_FAILURE_HINT_HEADER) === CLOUD_AGENT_STORAGE_DISABLED) throw new ConnectError(GATEWAY_NO_STORAGE_MESSAGE_MARKER, error.code, error.metadata, undefined, error);
      if (error instanceof ConnectError && error.metadata.get(AUTOMATION_FAILURE_HINT_HEADER) === SAND_BOX_BLOCKED) {
        const info = readBlockedInfoOrEmpty(error);
        this.blocked = { info, untilMs: Date.now() + (parseRetryAfterMs(error.metadata.get("retry-after")) ?? BOX_BLOCKED_FALLBACK_HOLD_MS) };
        throw blockedError(info, error);
      }
      if (error instanceof ConnectError && error.metadata.get(AUTOMATION_FAILURE_HINT_HEADER) === SAND_UPDATE_REQUIRED_HINT) this.updateSink?.noteBackendUpdateRequirement(true);
      if (error instanceof ConnectError && error.metadata.get(AUTOMATION_FAILURE_HINT_HEADER) == null && (error.code === Code.Unauthenticated || error.code === Code.PermissionDenied)) throw new ConnectError(GATEWAY_ACCESS_DENIED_MESSAGE_MARKER, error.code, error.metadata, undefined, error);
      throw error;
    }
    this.blocked = undefined;
    this.updateSink?.noteBackendUpdateRequirement(false);
    if (box.gatewayUrl.length === 0) throw new SandBoxHostConnectError("Broker did not expose the in-box Sand gateway (gateway_url empty); the backend stamps it on every box — check the backend version/logs.");
    let connection = buildConnection(box.gatewayUrl, box.gatewayToken, box.networkToken, { primaryUrl: box.vncUrl, forkBaseUrl: box.forkVncBaseUrl });
    const accountHeaders = await this.openGrokAccountHeaders(box.gatewayUrl);
    if (accountHeaders != null) connection = { ...connection, headers: { ...(connection.headers ?? {}), ...accountHeaders } };
    try {
      console.log(`[sand][remote-box] account computer gateway=${new URL(box.gatewayUrl).host} vncProxy=${connection.vncProxy == null ? "no" : "yes"}`);
    } catch {
      console.log("[sand][remote-box] account computer connected");
    }
    return connection;
  }

  /**
   * The account this gateway call is for, when the gateway is our own server.
   *
   * Asks for a *valid* token rather than a stored one: an access token lives an
   * hour, and a stale one identifies nobody. A failure here is not a reason to
   * refuse the call - without the header the server falls back to its configured
   * account, which is what happened before this existed.
   */
  private async openGrokAccountHeaders(gatewayUrl: string): Promise<Record<string, string> | undefined> {
    let backendUrl: string;
    try {
      backendUrl = getConfiguredBackendUrl();
      if (new URL(gatewayUrl).origin !== new URL(backendUrl).origin) return undefined;
    } catch { return undefined; }
    try {
      const accessToken = await this.deps.getAccessToken({ backendUrl });
      return accessToken.length === 0 ? undefined : { [OPENGROK_ACCOUNT_HEADER]: accessToken };
    } catch { return undefined; }
  }

  async recreate({ preserveData, force = false }: { preserveData: boolean; force?: boolean }) {
    const result = await this.client.recreateSandBox({ preserveData, force });
    if (!result.started) throw new SandComputerRecreateRefusedError(`Couldn't ${preserveData ? "update" : "reset"} the computer${result.reason.length > 0 ? ` (${result.reason})` : ""}. It is unchanged.`);
    const operationId = parseSandBoxMigrationOperationId(result.operationId);
    return operationId == null ? { status: "started-untrackable" as const } : { status: "started" as const, operationId };
  }
  async forceRecreate() {
    const result = await this.client.forceRecreateSandBox({});
    if (result.started) {
      const operationId = parseSandBoxMigrationOperationId(result.operationId);
      return operationId == null ? { status: "started-untrackable" as const } : { status: "started" as const, operationId };
    }
    return { status: "rejected" as const, reason: `Couldn't reset the computer${result.reason.length > 0 ? ` (${result.reason})` : ""}. It is unchanged.` };
  }
  async issueLocalExecDaemonCredential(): Promise<{ credential: string; backendUrl: string; expiresAtMs?: number } | undefined> {
    const backendUrl = getSandInferenceBackendUrl();
    let accessToken: string;
    try { accessToken = await this.deps.getAccessToken({ backendUrl }); } catch { return undefined; }
    let response: Response;
    try { response = await fetch(new URL(LOCAL_EXEC_DAEMON_CREDENTIAL_PATH, backendUrl).toString(), { method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", ...getSandBackendClientHeaders(), "x-ghost-mode": "true" }, body: "{}" }); } catch { return undefined; }
    if (!response.ok) return undefined;
    let parsed: unknown; try { parsed = await response.json(); } catch { return undefined; }
    if (typeof parsed !== "object" || parsed == null) return undefined;
    const credential = Reflect.get(parsed, "credential");
    if (typeof credential !== "string" || credential.length === 0) return undefined;
    const expiresAtMs = Reflect.get(parsed, "expiresAtMs");
    return { credential, backendUrl, ...(typeof expiresAtMs === "number" ? { expiresAtMs } : {}) };
  }
  async issueInferenceCredential(): Promise<{ accessToken: string; backendUrl: string; expiresAtMs: number } | undefined> {
    const backendUrl = getSandInferenceBackendUrl();
    try {
      const accessToken = await this.deps.getAccessToken({ backendUrl });
      if (accessToken.length === 0) return undefined;
      return { accessToken, backendUrl, expiresAtMs: getAccessTokenExpiryMs(accessToken) ?? Date.now() + 10 * 60_000 };
    } catch { return undefined; }
  }
}

/** Names whose account a gateway call is for; the server verifies the signature. */
export const OPENGROK_ACCOUNT_HEADER = "x-opengrok-account";

export class EnvDescriptorHostConnector {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}
  async connect(): Promise<GatewayConnection> {
    const baseUrl = this.env[GATEWAY_URL_ENV]?.trim();
    if (baseUrl == null || baseUrl.length === 0) throw new SandBoxHostConnectError(`${GATEWAY_URL_ENV} is not set`);
    return buildConnection(baseUrl, this.env[GATEWAY_TOKEN_ENV]?.trim() ?? "", this.env[GATEWAY_NETWORK_TOKEN_ENV]?.trim() ?? "");
  }
}

export function createRemoteHostConnector(deps: BrokerDeps, env: NodeJS.ProcessEnv = process.env, updateSink?: { noteBackendUpdateRequirement(required: boolean): void }, descriptorFastPath?: { store: GatewayDescriptorStore; getAccountScope(): string | undefined }): SandRemoteHostConnector {
  if ((env[GATEWAY_URL_ENV]?.trim() ?? "").length > 0) return new EnvDescriptorHostConnector(env);
  const broker = new BrokeredHostConnector(deps, undefined, updateSink);
  if (descriptorFastPath == null) return broker;
  return { connect: createGatewayConnectFastPath(broker, descriptorFastPath), recreate: broker.recreate.bind(broker), forceRecreate: broker.forceRecreate.bind(broker), issueLocalExecDaemonCredential: broker.issueLocalExecDaemonCredential.bind(broker), issueInferenceCredential: broker.issueInferenceCredential.bind(broker) };
}
