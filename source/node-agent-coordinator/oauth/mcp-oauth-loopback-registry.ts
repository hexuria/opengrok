import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { errorMessage } from "../../shared/errors.js";

export interface CoordinatorLogger {
  warn(event: Record<string, unknown>): void;
}

export type McpOAuthLoopbackHandler = (requestUrl: URL, request: IncomingMessage, response: ServerResponse) => boolean | Promise<boolean>;

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections?.();
  });
}

export function parseLoopbackRedirect(redirectUrl: URL): { port: number } {
  if (redirectUrl.protocol !== "http:" || (redirectUrl.hostname !== "127.0.0.1" && redirectUrl.hostname !== "localhost")) {
    throw new Error("MCP OAuth redirect_uri must be a localhost HTTP URL.");
  }
  const port = Number.parseInt(redirectUrl.port, 10);
  if (!Number.isInteger(port) || port <= 0) throw new Error("MCP OAuth redirect_uri must include a port.");
  return { port };
}

export function loopbackBindHosts(redirectHost: string): string[] {
  return redirectHost === "localhost" ? ["127.0.0.1", "::1"] : [redirectHost];
}

interface LoopbackEntry {
  servers: Server[];
  handlers: Set<McpOAuthLoopbackHandler>;
}

export class McpOAuthLoopbackRegistry {
  private readonly origins = new Map<string, Promise<LoopbackEntry>>();

  constructor(private readonly log: CoordinatorLogger) {}

  async acquire(redirectUrl: URL, handler: McpOAuthLoopbackHandler): Promise<() => Promise<void>> {
    const { port } = parseLoopbackRedirect(redirectUrl);
    const origin = redirectUrl.origin;
    let entryPromise = this.origins.get(origin);
    if (entryPromise == null) {
      entryPromise = this.bindOrigin(origin, port, redirectUrl.hostname);
      this.origins.set(origin, entryPromise);
      const pending = entryPromise;
      void pending.catch(() => { if (this.origins.get(origin) === pending) this.origins.delete(origin); });
    }
    const entry = await entryPromise;
    entry.handlers.add(handler);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      entry.handlers.delete(handler);
      if (entry.handlers.size === 0) {
        if (this.origins.get(origin) === entryPromise) this.origins.delete(origin);
        await this.closeServers(entry.servers);
      }
    };
  }

  private async bindOrigin(origin: string, port: number, redirectHost: string): Promise<LoopbackEntry> {
    const servers: Server[] = [];
    const errors: Error[] = [];
    for (const host of loopbackBindHosts(redirectHost)) {
      const server = createServer((request, response) => { void this.dispatch(origin, request, response); });
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => reject(error);
          server.once("error", onError);
          server.listen(port, host, () => { server.off("error", onError); resolve(); });
        });
        servers.push(server);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
        server.close();
      }
    }
    if (servers.length === 0) throw errors[0] ?? new Error(`MCP OAuth loopback callback could not bind port ${port}.`);
    return { servers, handlers: new Set() };
  }

  private async closeServers(servers: Server[]): Promise<void> {
    await Promise.all(servers.filter((server) => server.listening).map(closeHttpServer));
  }

  async dispose(): Promise<void> {
    const entryPromises = [...this.origins.values()];
    this.origins.clear();
    for (const entryPromise of entryPromises) {
      try {
        const entry = await entryPromise;
        entry.handlers.clear();
        await this.closeServers(entry.servers);
      } catch { /* failed binds are already closed */ }
    }
  }

  private async dispatch(origin: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const entryPromise = this.origins.get(origin);
    if (entryPromise == null) { response.writeHead(404); response.end("Not found"); return; }
    let entry: LoopbackEntry;
    try { entry = await entryPromise; }
    catch { response.writeHead(404); response.end("Not found"); return; }
    let requestUrl: URL;
    try { requestUrl = new URL(request.url ?? "/", origin); }
    catch { response.writeHead(400); response.end("Bad request"); return; }
    for (const handler of [...entry.handlers]) {
      try { if (await handler(requestUrl, request, response)) return; }
      catch (error) {
        this.log.warn({ kind: "callback-handler-failed", detail: errorMessage(error) });
        if (response.headersSent) return;
      }
    }
    if (!response.headersSent) { response.writeHead(404); response.end("Not found"); }
  }
}
