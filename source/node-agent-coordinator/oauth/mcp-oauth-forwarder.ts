import { createRealExpiryPolicy, type ExpiryPolicy } from "../../internal/scheduling.js";
import { errorMessage } from "../../shared/errors.js";
import { startMcpOAuthCallbackListener, type McpOAuthCallbackListenerArgs } from "./mcp-oauth-callback-listener.js";
import { McpOAuthLoopbackRegistry, type CoordinatorLogger } from "./mcp-oauth-loopback-registry.js";

export const MCP_OAUTH_PENDING_TTL_MS = 11 * 60 * 1_000;

function expiryKey(origin: string, state: string): string {
  return JSON.stringify([origin, state]);
}

interface PendingAuth {
  serverName: string;
  expiry: { dispose(): void };
}

export class OAuthPendingRegistry {
  private readonly byOrigin = new Map<string, Map<string, PendingAuth>>();

  add(origin: string, state: string, auth: PendingAuth): void {
    let states = this.byOrigin.get(origin);
    if (states == null) { states = new Map(); this.byOrigin.set(origin, states); }
    states.set(state, auth);
  }

  resolve(origin: string, state: string): string | undefined {
    return this.byOrigin.get(origin)?.get(state)?.serverName;
  }

  remove(origin: string, state: string): PendingAuth | undefined {
    const states = this.byOrigin.get(origin);
    const auth = states?.get(state);
    if (states == null || auth == null) return undefined;
    states.delete(state);
    if (states.size === 0) this.byOrigin.delete(origin);
    return auth;
  }

  removeServer(serverName: string): PendingAuth[] {
    const removed: PendingAuth[] = [];
    for (const [origin, states] of [...this.byOrigin]) {
      for (const [state, auth] of [...states]) {
        if (auth.serverName !== serverName) continue;
        states.delete(state);
        removed.push(auth);
      }
      if (states.size === 0) this.byOrigin.delete(origin);
    }
    return removed;
  }

  removeAll(): PendingAuth[] {
    const removed = [...this.byOrigin.values()].flatMap((states) => [...states.values()]);
    this.byOrigin.clear();
    return removed;
  }

  hasPendingFor(origin: string): boolean {
    return this.byOrigin.has(origin);
  }
}

export interface McpOAuthPendingPayload {
  redirectUrl: string;
  state: string;
  serverName: string;
}

interface OAuthListener { close(): void }
type StartListener = (args: McpOAuthCallbackListenerArgs, registry: McpOAuthLoopbackRegistry) => Promise<OAuthListener>;

export interface McpOAuthForwarderDependencies {
  completion: { completeMcpOAuth(value: { code: string; state: string }): Promise<unknown> };
  log: CoordinatorLogger;
  pendingEvents: { subscribe(listener: (pending: McpOAuthPendingPayload) => void): { dispose(): void } };
  pendingExpiry?: ExpiryPolicy;
  startListener?: StartListener;
}

export class McpOAuthForwarder {
  private readonly listeners = new Map<string, OAuthListener>();
  private readonly pending = new OAuthPendingRegistry();
  private readonly loopbackPool: McpOAuthLoopbackRegistry;
  private readonly subscription: { dispose(): void };
  private readonly completion: McpOAuthForwarderDependencies["completion"];
  private readonly log: CoordinatorLogger;
  private readonly pendingExpiry: ExpiryPolicy;
  private readonly startListener: StartListener;

  constructor(deps: McpOAuthForwarderDependencies) {
    this.completion = deps.completion;
    this.log = deps.log;
    this.pendingExpiry = deps.pendingExpiry ?? createRealExpiryPolicy({ name: "mcp-oauth-pending", ttlMs: MCP_OAUTH_PENDING_TTL_MS });
    this.startListener = deps.startListener ?? startMcpOAuthCallbackListener;
    this.loopbackPool = new McpOAuthLoopbackRegistry(deps.log);
    this.subscription = deps.pendingEvents.subscribe((pending) => { void this.handlePending(pending); });
  }

  private async handlePending(payload: McpOAuthPendingPayload): Promise<void> {
    let origin: string;
    try { origin = new URL(payload.redirectUrl).origin; }
    catch (error) {
      this.log.warn({ kind: "invalid-redirect-url", serverName: payload.serverName, detail: errorMessage(error) });
      return;
    }
    this.track(origin, payload.state, payload.serverName);
    if (this.listeners.has(origin)) return;
    try {
      const listener = await this.startListener({
        redirectUrl: payload.redirectUrl,
        resolve: (state) => {
          const serverName = this.pending.resolve(origin, state);
          return serverName != null ? { serverName } : undefined;
        },
        onCallback: async ({ code, state }) => { await this.completion.completeMcpOAuth({ code, state }); },
        onSettled: (state) => { this.forget(origin, state); },
        log: this.log
      }, this.loopbackPool);
      if (this.listeners.has(origin)) listener.close();
      else { this.listeners.set(origin, listener); this.closeDrainedListeners(); }
    } catch (error) {
      this.forget(origin, payload.state);
      this.log.warn({ kind: "listener-start-failed", serverName: payload.serverName, detail: errorMessage(error) });
    }
  }

  dispose(): void {
    this.subscription.dispose();
    for (const listener of this.listeners.values()) listener.close();
    this.listeners.clear();
    for (const auth of this.pending.removeAll()) auth.expiry.dispose();
    void this.loopbackPool.dispose();
  }

  private track(origin: string, state: string, serverName: string): void {
    const superseded = this.pending.removeServer(serverName);
    for (const auth of superseded) auth.expiry.dispose();
    this.pending.remove(origin, state)?.expiry.dispose();
    const expiry = this.pendingExpiry.arm(expiryKey(origin, state), () => { this.forget(origin, state); });
    this.pending.add(origin, state, { serverName, expiry });
    this.closeDrainedListeners();
  }

  private forget(origin: string, state: string): void {
    const auth = this.pending.remove(origin, state);
    if (auth == null) return;
    auth.expiry.dispose();
    this.closeDrainedListeners();
  }

  private closeDrainedListeners(): void {
    for (const [origin, listener] of [...this.listeners]) {
      if (this.pending.hasPendingFor(origin)) continue;
      listener.close();
      this.listeners.delete(origin);
    }
  }
}
