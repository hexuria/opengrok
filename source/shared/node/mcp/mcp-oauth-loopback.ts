import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  createRealExpiryPolicy,
  createRealPollingPolicy,
  createRealRetryPolicy,
  type ExpiryPolicy,
  type PollingPolicy,
  type RetryPolicy,
} from "../../../internal/scheduling.js";
import {
  isDeadlineExceededConnectError,
  isRateLimitConnectError,
  isTransientConnectError,
} from "../../connect-errors.js";
import { brandedEnumOf } from "../../errors/bounded.js";
import { SandError } from "../../errors/registry.js";
import {
  renderMcpOAuthErrorPage as renderErrorPage,
  renderMcpOAuthSuccessPage as renderSuccessPage,
} from "../../mcp-oauth-callback-page.js";
const renderMcpOAuthSuccessPage = (args: {
  serverName: string | undefined;
}): string =>
  renderSuccessPage(
    args.serverName == null ? undefined : { serverName: args.serverName },
  );
const renderMcpOAuthErrorPage = (args: {
  serverName: string | undefined;
}): string =>
  renderErrorPage(
    args.serverName == null ? undefined : { serverName: args.serverName },
  );
export const MCP_OAUTH_LOOPBACK_CALLBACK_URL =
  "http://localhost:8787/callback";
const BACKEND_MCP_OAUTH_PENDING_STATE_TTL_MS = 15 * 60 * 1_000;
const MCP_OAUTH_PENDING_TTL_MS = BACKEND_MCP_OAUTH_PENDING_STATE_TTL_MS + 60_000;
const MCP_OAUTH_COMPLETION_RETRY_DELAY_MS = 500;
const MCP_OAUTH_BIND_RETRY_INTERVAL_MS = 2_000;
export const CONNECTOR_OAUTH_CALLBACK_FAILURE_REASONS = [
  "provider_error",
  "missing_code",
  "completion_rejected",
  "completion_timeout",
] as const;
const callbackFailureReason = brandedEnumOf(
  CONNECTOR_OAUTH_CALLBACK_FAILURE_REASONS,
  "completion_rejected",
);
const isLoopback = (host: string): boolean =>
  ["localhost", "127.0.0.1", "[::1]", "::1"].includes(host);
const loopbackBindHosts = (redirectHost: string): readonly string[] =>
  redirectHost === "localhost" ? ["127.0.0.1", "::1"] : [redirectHost];
export function parseMcpOAuthLoopbackAuthorization(
  url: string,
  callback = MCP_OAUTH_LOOPBACK_CALLBACK_URL,
): { state: string } | null {
  let authorization: URL, loopback: URL;
  try {
    authorization = new URL(url);
    loopback = new URL(callback);
  } catch {
    return null;
  }
  const raw = authorization.searchParams.get("redirect_uri"),
    state = authorization.searchParams.get("state");
  if (raw == null || state == null || state.length === 0) return null;
  let redirect: URL;
  try {
    redirect = new URL(raw);
  } catch {
    return null;
  }
  return redirect.protocol === "http:" &&
    isLoopback(redirect.hostname) &&
    redirect.port === loopback.port &&
    redirect.pathname === loopback.pathname
    ? { state }
    : null;
}
export function createSandMcpOAuthLoopback(deps: {
  completeOAuth(args: { stateId: string; code: string }): Promise<void>;
  log(message: string): void;
  loopbackRedirectUrl?: string;
  pendingExpiry?: ExpiryPolicy;
  completionRetry?: RetryPolicy;
  bindRetry?: PollingPolicy;
  onCallback?(event: Record<string, unknown>): void;
}) {
  const callback = deps.loopbackRedirectUrl ?? MCP_OAUTH_LOOPBACK_CALLBACK_URL,
    redirect = new URL(callback),
    expiry =
      deps.pendingExpiry ??
      createRealExpiryPolicy({
        name: "sand-mcp-oauth-loopback-pending",
        ttlMs: MCP_OAUTH_PENDING_TTL_MS,
      }),
    retry =
      deps.completionRetry ??
      createRealRetryPolicy({
        name: "sand-mcp-oauth-loopback-completion",
        maxAttempts: 2,
        initialDelayMs: MCP_OAUTH_COMPLETION_RETRY_DELAY_MS,
        maxDelayMs: MCP_OAUTH_COMPLETION_RETRY_DELAY_MS,
        shouldRetry: (error) =>
          isTransientConnectError(error) && !isRateLimitConnectError(error),
      }),
    bindRetry =
      deps.bindRetry ??
      createRealPollingPolicy({
        name: "sand-mcp-oauth-loopback-bind-retry",
        intervalMs: MCP_OAUTH_BIND_RETRY_INTERVAL_MS,
      }),
    bindHosts = loopbackBindHosts(redirect.hostname),
    port = Number.parseInt(redirect.port, 10);
  type Pending = {
    serverName?: string | undefined;
    expiry: { dispose(): void };
    completing: Promise<{ kind: string }> | null;
  };
  const pending = new Map<string, Pending>(),
    servers = new Map<string, Server>();
  let bindAttempt: Promise<void> | null = null,
    bindPoll: { dispose(): void } | null = null,
    disposed = false,
    logged = false,
    serversClosed = Promise.resolve();
  const closeServers = async (items: Server[]): Promise<void> => {
    await Promise.all(
      items
        .filter((server) => server.listening)
        .map(
          (server) =>
            new Promise<void>((resolve) => {
              server.close(() => resolve());
              server.closeIdleConnections?.();
            }),
        ),
    );
  };
  const stopBindPoll = () => {
    bindPoll?.dispose();
    bindPoll = null;
  };
  const closeIfDrained = () => {
    if (pending.size > 0) return;
    stopBindPoll();
    logged = false;
    if (servers.size === 0) return;
    const items = [...servers.values()];
    servers.clear();
    serversClosed = serversClosed
      .then(() => closeServers(items))
      .catch(() => undefined);
  };
  const settle = (state: string) => {
    const auth = pending.get(state);
    if (auth == null) return;
    pending.delete(state);
    auth.expiry.dispose();
    closeIfDrained();
  };
  const complete = async (state: string, auth: Pending, url: URL) => {
    const serverName = auth.serverName;
    const fail = (reason: string) =>
      deps.onCallback?.({
        phase: "callback_received",
        outcome: "failed",
        serverName,
        error: SandError.connectorOauthCallbackFailed({
          reason: callbackFailureReason(reason),
        }),
      });
    if (url.searchParams.get("error") != null) {
      fail("provider_error");
      settle(state);
      return { kind: "refused" };
    }
    const code = url.searchParams.get("code");
    if (code == null || code.length === 0) {
      fail("missing_code");
      settle(state);
      return { kind: "refused" };
    }
    try {
      await retry.runWithRetry(() =>
        deps.completeOAuth({ stateId: state, code }),
      );
      deps.onCallback?.({
        phase: "callback_received",
        outcome: "ok",
        serverName,
      });
      settle(state);
      return { kind: "success" };
    } catch (error) {
      fail(
        isDeadlineExceededConnectError(error)
          ? "completion_timeout"
          : "completion_rejected",
      );
      deps.log(
        `[sand:mcp] loopback OAuth completion failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (isTransientConnectError(error)) auth.completing = null;
      else settle(state);
      return { kind: "failed" };
    }
  };
  const handle = async (url: URL, method: string, response: ServerResponse) => {
    if (method !== "GET") {
      response.writeHead(405).end("Method not allowed");
      return;
    }
    if (url.pathname !== redirect.pathname) {
      response.writeHead(404).end("Not found");
      return;
    }
    const state = url.searchParams.get("state"),
      auth = state == null ? undefined : pending.get(state);
    if (state == null || auth == null) {
      response.writeHead(404).end("Not found");
      return;
    }
    const serverName = auth.serverName;
    auth.completing ??= complete(state, auth, url);
    const outcome = await auth.completing,
      success = outcome.kind === "success";
    const statusCode = success ? 200 : outcome.kind === "refused" ? 400 : 500;
    const body =
      success
        ? renderMcpOAuthSuccessPage({ serverName })
        : renderMcpOAuthErrorPage({ serverName });
    response.writeHead(statusCode, {
      "Content-Type": "text/html; charset=utf-8",
      Connection: "close",
    });
    response.end(body);
  };
  const listener = (request: IncomingMessage, response: ServerResponse) => {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", redirect.origin);
    } catch {
      response.writeHead(400).end("Bad request");
      return;
    }
    void handle(url, request.method ?? "GET", response);
  };
  const bindMissing = async () => {
    await serversClosed;
    if (disposed || pending.size === 0) return;
    const errors: unknown[] = [];
    for (const host of bindHosts) {
      if (servers.has(host)) continue;
      const server = createServer(listener);
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => reject(error);
          server.once("error", onError);
          server.listen(port, host, () => {
            server.off("error", onError);
            resolve();
          });
        });
        if (disposed || pending.size === 0) server.close();
        else {
          server.unref();
          servers.set(host, server);
        }
      } catch (error) {
        errors.push(error);
        server.close();
      }
    }
    if (servers.size === bindHosts.length) {
      stopBindPoll();
      if (logged) {
        deps.log("[sand:mcp] loopback OAuth listener bound after retry");
        logged = false;
      }
    } else if (errors.length > 0 && !logged) {
      logged = true;
      deps.log(
        `[sand:mcp] loopback OAuth listener failed to bind port ${port} (retrying while auth is pending): ${errors[0] instanceof Error ? errors[0].message : String(errors[0])}`,
      );
    }
  };
  const ensureBound = async (): Promise<void> => {
    bindAttempt ??= bindMissing().finally(() => {
      bindAttempt = null;
    });
    await bindAttempt;
    if (
      !disposed &&
      pending.size > 0 &&
      servers.size < bindHosts.length &&
      bindPoll == null
    )
      bindPoll = bindRetry.start(ensureBound);
  };
  return {
    async registerPendingAuthFromUrl({
      authorizationUrl,
      serverName,
    }: {
      authorizationUrl: string;
      serverName?: string;
    }): Promise<boolean> {
      if (disposed) return false;
      const parsed = parseMcpOAuthLoopbackAuthorization(
        authorizationUrl,
        callback,
      );
      if (parsed == null) return false;
      const known = pending.get(parsed.state);
      if (known != null) {
        known.expiry.dispose();
        known.expiry = expiry.arm(parsed.state, () => settle(parsed.state));
        if (known.serverName == null && serverName != null)
          known.serverName = serverName;
        return true;
      }
      pending.set(parsed.state, {
        serverName,
        expiry: expiry.arm(parsed.state, () => settle(parsed.state)),
        completing: null,
      });
      await ensureBound();
      return true;
    },
    async dispose(): Promise<void> {
      disposed = true;
      for (const auth of pending.values()) auth.expiry.dispose();
      pending.clear();
      stopBindPoll();
      try {
        await bindAttempt;
      } catch {}
      const items = [...servers.values()];
      servers.clear();
      await closeServers(items);
      await serversClosed;
    },
  };
}
