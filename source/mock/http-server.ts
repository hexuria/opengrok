import { connectNodeAdapter } from "@connectrpc/connect-node";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tryHandleAuthHttp } from "./auth-http.js";
import { DEFAULT_MOCK_HOST, DEFAULT_MOCK_PORT } from "./constants.js";
import { createMockServices, type MockRouterOptions } from "./routes.js";
import { tryHandleTeachHttp } from "./teach-http.js";

export interface MockListenOptions extends MockRouterOptions {
  readonly host?: string;
  readonly port?: number;
}

export function resolveMockListenOptions(env: NodeJS.ProcessEnv = process.env): { host: string; port: number } {
  const parsed = Number.parseInt(env.SAND_MOCK_PORT ?? "", 10);
  return {
    host: env.SAND_MOCK_HOST != null && env.SAND_MOCK_HOST.length > 0 ? env.SAND_MOCK_HOST : DEFAULT_MOCK_HOST,
    port: Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MOCK_PORT,
  };
}

export function createMockHttpHandler(options: MockRouterOptions = {}): (request: IncomingMessage, response: ServerResponse) => void {
  const services = createMockServices({
    holdWatchStreams: true,
    ...options,
  });
  const connect = connectNodeAdapter({ routes: services.routes });
  return (request, response) => {
    if (tryHandleAuthHttp(request, response, services.profile)) return;
    if (tryHandleTeachHttp(request, response, services.store)) return;
    connect(request, response);
  };
}

export function listenMockServer(options: MockListenOptions = {}): Promise<Server> {
  const host = options.host ?? DEFAULT_MOCK_HOST;
  const port = options.port ?? DEFAULT_MOCK_PORT;
  const server = createServer(createMockHttpHandler(options));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

export function mockServerUrl(server: Server): string {
  const address = server.address();
  if (address == null || typeof address === "string") {
    return `http://${DEFAULT_MOCK_HOST}:${DEFAULT_MOCK_PORT}`;
  }
  const host = address.address === "::" ? "127.0.0.1" : address.address;
  return `http://${host}:${address.port}`;
}
