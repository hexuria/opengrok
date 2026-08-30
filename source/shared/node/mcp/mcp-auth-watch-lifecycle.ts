import {
  DEFAULT_MCP_ACCOUNT_KEY,
  provisionalMcpAccountServerIdentifier,
  stripMarkupAndBoundConnectorError,
} from "../../mcp.js";
import { isDeadlineExceededConnectError } from "../../connect-errors.js";
import { brandedEnumOf } from "../../errors/bounded.js";
import { SandError } from "../../errors/registry.js";
import {
  createDeadlinePolicy,
  createPollingPolicy,
  realClock,
  type Clock,
  type DeadlinePolicy,
  type PollingPolicy,
} from "../../../internal/scheduling.js";
import { validateAuthorizationUrl } from "./mcp-catalog-cache.js";
import {
  normalizeAccountKey,
  type DisplayServer,
} from "./mcp-display-runtime.js";
import { authWatchKey } from "./mcp-auth-watch.js";
import { MCP_OAUTH_LOOPBACK_CALLBACK_URL } from "./mcp-oauth-loopback.js";
import { parseInt32McpServerId, validateMcpServerId } from "./mcp-server-id.js";
import { reportMcpHostEdgeFailure } from "./mcp-diagnostics.js";
export const CONNECTOR_AUTH_START_REFUSAL_REASONS = [
  "not_configured",
  "admin_blocked",
  "stdio_unsupported",
  "invalid_auth_url",
  "no_auth_link",
  "unreachable",
] as const;
export const CONNECTOR_AUTH_START_FAILURE_REASONS = [
  "probe_failed",
  "rpc_timeout",
] as const;
const startRefusalReason = brandedEnumOf(
  CONNECTOR_AUTH_START_REFUSAL_REASONS,
  "no_auth_link",
);
const startFailureReason = brandedEnumOf(
  CONNECTOR_AUTH_START_FAILURE_REASONS,
  "probe_failed",
);
interface Watch {
  serverId: string;
  accountKey: string;
  serverName: string;
  serverIdentifier?: string;
  serverUrl: string;
  requestingAgentId: string | null;
  poll: { dispose(): void };
  suppressFirstPoll: boolean;
  expiresAtMs: number;
  isPolling: boolean;
}
export class SandMcpAuthWatchLifecycle {
  private pending = new Map<string, Watch>();
  private observer: ((completion: any) => void) | null = null;
  private readonly authWatchPollDeadline: DeadlinePolicy;
  private readonly authWatchPolling: PollingPolicy;
  private readonly clock: Clock;
  constructor(
    private readonly deps: {
      backendMcpExec: any;
      authWatchPollIntervalMs: number;
      authWatchTimeoutMs: number;
      authWatchPollTimeoutMs: number;
      resolveDisplayServer(
        id: string,
        options?: { requireFreshRead: boolean },
      ): Promise<DisplayServer | undefined>;
      reload(): Promise<void>;
      onConnectorAuth?(event: Record<string, unknown>): void;
      clock?: Clock;
    },
  ) {
    this.clock = deps.clock ?? realClock;
    this.authWatchPollDeadline = createDeadlinePolicy(this.clock, {
      name: "mcp-auth-watch-poll",
      timeoutMs: deps.authWatchPollTimeoutMs,
    });
    this.authWatchPolling = createPollingPolicy(this.clock, {
      name: "mcp-auth-watch",
      intervalMs: deps.authWatchPollIntervalMs,
    });
  }
  setAuthCompletionObserver(observer: (completion: any) => void): void {
    this.observer = observer;
  }
  private refused(reason: string, serverId: string, serverName?: string): void {
    this.deps.onConnectorAuth?.({
      phase: "flow_started",
      outcome: "failed",
      serverId,
      serverName,
      error: SandError.connectorAuthStartRefused({
        reason: startRefusalReason(reason),
      }),
    });
  }
  async authenticateServer(
    rawId: string,
    rawKey: string = DEFAULT_MCP_ACCOUNT_KEY,
    requestingAgentId: string | null = null,
    forceReauth = false,
    trigger: string | null = null,
  ): Promise<any> {
    const serverId = validateMcpServerId(rawId),
      accountKey = normalizeAccountKey(rawKey),
      server = await this.deps.resolveDisplayServer(serverId);
    if (trigger === "connector_card")
      this.deps.onConnectorAuth?.({
        phase: "card_clicked",
        outcome: "ok",
        serverName: server?.name,
        serverId,
      });
    if (server == null) {
      this.refused("not_configured", serverId);
      return { status: "not-configured", serverName: serverId };
    }
    if (server.disabledByTeamAdminPolicy) {
      let blocked = false;
      try {
        const fresh = await this.deps.resolveDisplayServer(serverId, {
          requireFreshRead: true,
        });
        blocked =
          fresh == null || fresh.disabledByTeamAdminPolicy === true;
      } catch {}
      if (blocked) {
        const watches = this.clearPendingAuthWatchesForServer(serverId);
        try {
          await this.deps.reload();
        } catch {}
        watches.forEach((watch) => this.notifyWatchCancelled(watch));
        this.refused("admin_blocked", serverId, server.name);
        return {
          status: "not-supported",
          serverName: server.name,
          message:
            "This connector is disabled by your team admin's MCP policy, so it can't be authenticated.",
        };
      }
    }
    if ("command" in server.config) {
      this.refused("stdio_unsupported", serverId, server.name);
      return {
        status: "not-supported",
        serverName: server.name,
        message:
          "This connector runs on Grok Bot's computer and does not use browser sign-in. Configure credentials via its env settings instead.",
      };
    }
    let status: any;
    try {
      status = await this.deps.backendMcpExec.checkAuthStatus({
        serverId: parseInt32McpServerId(serverId),
        accountKey,
        oauthRedirectUri: MCP_OAUTH_LOOPBACK_CALLBACK_URL,
        forceReauth,
      });
    } catch (error) {
      this.deps.onConnectorAuth?.({
        phase: "flow_started",
        outcome: "failed",
        serverName: server.name,
        serverId,
        error: SandError.connectorAuthStartFailed({
          reason: startFailureReason(
            isDeadlineExceededConnectError(error)
              ? "rpc_timeout"
              : "probe_failed",
          ),
        }),
      });
      throw error;
    }
    if (
      !forceReauth &&
      (status.hasValidToken || (status.isAvailable && !status.requiresAuth))
    ) {
      await this.deps.reload();
      return { status: "already-authenticated", serverName: server.name };
    }
    const fail = async (state: string, message: string) => {
      if (forceReauth) {
        this.clearPendingAuthWatchCancelled(serverId, accountKey);
        await this.deps.reload();
      }
      return { status: state, serverName: server.name, message };
    };
    if (status.requiresAuth && status.authUrl) {
      const authorizationUrl = validateAuthorizationUrl(
        status.authUrl,
        server.config.url,
      );
      if (authorizationUrl == null) {
        this.refused("invalid_auth_url", serverId, server.name);
        return fail(
          "not-supported",
          "Only HTTPS authentication URLs are supported unless the MCP server is running on localhost.",
        );
      }
      const slotIdentifier =
        server.accounts?.find((slot) => slot.accountKey === accountKey)
          ?.serverIdentifier ??
        (server.serverIdentifier == null
          ? undefined
          : provisionalMcpAccountServerIdentifier(
              server.serverIdentifier,
              accountKey,
            ));
      this.beginPendingAuthWatch({
        serverId,
        accountKey,
        serverName: server.name,
        ...(slotIdentifier == null ? {} : { serverIdentifier: slotIdentifier }),
        serverUrl: server.config.url,
        requestingAgentId,
        forceReauth,
      });
      this.deps.onConnectorAuth?.({
        phase: "flow_started",
        outcome: "ok",
        serverName: server.name,
        serverId,
        reauth: forceReauth,
      });
      return { status: "started", authorizationUrl, serverName: server.name };
    }
    const detail = stripMarkupAndBoundConnectorError(status.error ?? "");
    if (!status.isAvailable && !status.requiresAuth) {
      this.refused("unreachable", serverId, server.name);
      return fail(
        "unreachable",
        detail || "The connector reported no details.",
      );
    }
    this.refused("no_auth_link", serverId, server.name);
    return fail(
      "not-supported",
      detail || "This connector did not provide a sign-in link.",
    );
  }
  beginPendingAuthWatch(
    args: Omit<
      Watch,
      "poll" | "suppressFirstPoll" | "expiresAtMs" | "isPolling"
    > & { forceReauth: boolean },
  ): void {
    const key = authWatchKey(args.serverId, args.accountKey),
      existing = this.pending.get(key),
      requestingAgentId =
        args.requestingAgentId ?? existing?.requestingAgentId ?? null;
    this.clearPendingAuthWatchCancelled(args.serverId, args.accountKey);
    const watch: Watch = {
      ...args,
      requestingAgentId,
      poll: { dispose() {} },
      suppressFirstPoll: args.forceReauth,
      expiresAtMs: this.clock.now() + this.deps.authWatchTimeoutMs,
      isPolling: false,
    };
    this.pending.set(key, watch);
    watch.poll = this.authWatchPolling.start(async () => {
      try {
        await this.pollPendingAuthWatch(key);
      } catch (error) {
        reportMcpHostEdgeFailure("auth-watch-poll", error);
      }
    });
  }
  clearPendingAuthWatch(id: string, key: string): Watch | null {
    const watch = this.pending.get(authWatchKey(id, key));
    if (watch == null) return null;
    watch.poll.dispose();
    this.pending.delete(authWatchKey(id, key));
    return watch;
  }
  clearPendingAuthWatchCancelled(id: string, key: string): Watch | null {
    const watch = this.clearPendingAuthWatch(id, key);
    if (watch != null)
      this.deps.onConnectorAuth?.({
        phase: "token_stored",
        outcome: "cancelled",
        serverName: watch.serverName,
        serverId: watch.serverId,
      });
    return watch;
  }
  notifyWatchCancelled(watch: Watch): void {
    this.notify({
      serverId: watch.serverId,
      accountKey: watch.accountKey,
      serverName: watch.serverName,
      ...(watch.serverIdentifier == null
        ? {}
        : { serverIdentifier: watch.serverIdentifier }),
      requestingAgentId: watch.requestingAgentId,
      outcome: "cancelled",
    });
  }
  noteAuthCompletedElsewhere(rawId: string, rawKey: string): string | null {
    let id: string, key: string;
    try {
      id = validateMcpServerId(rawId);
      key = normalizeAccountKey(rawKey);
    } catch {
      return null;
    }
    const watch = this.clearPendingAuthWatch(id, key);
    return watch?.requestingAgentId ?? null;
  }
  clearPendingAuthWatchesForServer(id: string): Watch[] {
    const cleared: Watch[] = [];
    for (const watch of [...this.pending.values()])
      if (watch.serverId === id) {
        this.clearPendingAuthWatchCancelled(watch.serverId, watch.accountKey);
        cleared.push(watch);
      }
    return cleared;
  }
  clearAllPendingAuthWatches(): void {
    for (const watch of [...this.pending.values()])
      this.clearPendingAuthWatch(watch.serverId, watch.accountKey);
  }
  clearAllPendingAuthWatchesCancelled(): void {
    for (const watch of [...this.pending.values()])
      this.clearPendingAuthWatchCancelled(watch.serverId, watch.accountKey);
  }
  async pollPendingAuthWatch(key: string): Promise<void> {
    const watch = this.pending.get(key);
    if (watch == null || watch.isPolling) return;
    if (watch.suppressFirstPoll) {
      watch.suppressFirstPoll = false;
      return;
    }
    if (this.clock.now() >= watch.expiresAtMs) {
      this.clearPendingAuthWatch(watch.serverId, watch.accountKey);
      this.deps.onConnectorAuth?.({
        phase: "token_stored",
        outcome: "timeout",
        serverName: watch.serverName,
        serverId: watch.serverId,
        error: SandError.connectorAuthAbandoned(),
      });
      return;
    }
    watch.isPolling = true;
    try {
      const landed = await this.authWatchPollDeadline.run(async () => {
        const serverUrl = watch.serverUrl.trim();
        if (serverUrl.length === 0) return false;
        const results = await this.deps.backendMcpExec.validateTokens([
          { serverUrl, accountKey: watch.accountKey },
        ]);
        return results.some(
          (item: any) =>
            item.serverUrl === serverUrl &&
            item.accountKey === watch.accountKey &&
            item.hasValidToken,
        );
      });
      if (!landed || this.pending.get(key) !== watch) return;
      let current: DisplayServer | undefined,
        failed = false;
      try {
        current = await this.authWatchPollDeadline.run(() =>
          this.deps.resolveDisplayServer(watch.serverId, {
            requireFreshRead: true,
          }),
        );
      } catch {
        failed = true;
      }
      if (this.pending.get(key) !== watch) return;
      if (!failed && (current == null || current.disabledByTeamAdminPolicy)) {
        this.clearPendingAuthWatchCancelled(watch.serverId, watch.accountKey);
        try {
          await this.deps.reload();
        } catch {}
        this.notifyWatchCancelled(watch);
        return;
      }
      this.clearPendingAuthWatch(watch.serverId, watch.accountKey);
      this.notify({
        serverId: watch.serverId,
        accountKey: watch.accountKey,
        serverName: watch.serverName,
        ...(watch.serverIdentifier == null
          ? {}
          : { serverIdentifier: watch.serverIdentifier }),
        requestingAgentId: watch.requestingAgentId,
      });
      try {
        await this.deps.reload();
      } catch {}
    } catch {
    } finally {
      watch.isPolling = false;
    }
  }
  private notify(completion: any): void {
    if (completion.outcome !== "cancelled")
      this.deps.onConnectorAuth?.({
        phase: "token_stored",
        outcome: "ok",
        serverName: completion.serverName,
        serverId: completion.serverId,
      });
    try {
      this.observer?.(completion);
    } catch {}
  }
}
