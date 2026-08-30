import { errorMessage } from "../../shared/errors.js";
import { renderMcpOAuthErrorPage, renderMcpOAuthSuccessPage } from "../../shared/mcp-oauth-callback-page.js";
import type { CoordinatorLogger, McpOAuthLoopbackRegistry } from "./mcp-oauth-loopback-registry.js";

export interface McpOAuthCallbackListenerArgs {
  redirectUrl: string;
  resolve(state: string): { serverName: string } | undefined;
  onCallback(value: { code: string; state: string }): Promise<void>;
  onSettled(state: string): void;
  log: CoordinatorLogger;
}

export async function startMcpOAuthCallbackListener(args: McpOAuthCallbackListenerArgs, registry: McpOAuthLoopbackRegistry): Promise<{ close(): void }> {
  const redirectUrl = new URL(args.redirectUrl);
  const release = await registry.acquire(redirectUrl, async (requestUrl, _request, response) => {
    if (requestUrl.pathname !== redirectUrl.pathname) return false;
    const state = requestUrl.searchParams.get("state");
    const pending = state != null ? args.resolve(state) : undefined;
    if (state == null || pending == null) return false;
    const serverName = pending.serverName;
    try {
      const error = requestUrl.searchParams.get("error");
      if (error != null) {
        response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        response.end(renderMcpOAuthErrorPage({ serverName }));
        return true;
      }
      const code = requestUrl.searchParams.get("code");
      if (code == null || code.length === 0) {
        response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        response.end(renderMcpOAuthErrorPage({ serverName }));
        return true;
      }
      await args.onCallback({ code, state });
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(renderMcpOAuthSuccessPage({ serverName }));
      return true;
    } catch (error) {
      response.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      response.end(renderMcpOAuthErrorPage({ serverName }));
      args.log.warn({ kind: "callback-forward-failed", detail: errorMessage(error) });
      return true;
    } finally {
      args.onSettled(state);
    }
  });
  return { close() { void release(); } };
}
