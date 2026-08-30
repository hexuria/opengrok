import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { isSandThemePreference, type SandThemePreference } from "../../shared/desktop.js";
import { resolveDevControlPort } from "./dev-controls-gate.js";
import { getSimulatedGatewayLatencyMs, setSimulatedGatewayLatencyMs } from "./dev-network-latency.js";

export interface DevThemeController {
  getState(): unknown;
  setPreference(preference: SandThemePreference): unknown;
}
export interface DevControlServerDependencies {
  readonly restartExitCode?: number;
  reloadMainWindow(): void;
  isGatewayOfflineInduced(): boolean;
  applyGatewayOffline(induced: boolean): Promise<unknown>;
  skipOnboarding(): void;
  restartOnboarding(): void;
  readonly themeController: DevThemeController;
  broadcast(channel: string, payload: unknown): void;
  emitDevBoxRebuild(): void;
  exitForDevRestart(exitCode: number): void;
  onBindError(port: number, error: Error): void;
  readonly env?: NodeJS.ProcessEnv;
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
}

export function handleDevControlRequest(req: IncomingMessage, res: ServerResponse, deps: DevControlServerDependencies): void {
  if (req.method === "GET" && req.url?.startsWith("/network-latency")) { json(res, 200, { ms: getSimulatedGatewayLatencyMs() }); return; }
  if (req.method === "GET" && req.url === "/gateway-offline") { json(res, 200, { induced: deps.isGatewayOfflineInduced() }); return; }
  if (req.method === "GET" && req.url === "/theme") { json(res, 200, deps.themeController.getState()); return; }
  if ((req.method === "GET" || req.method === "POST") && req.url === "/skip-onboarding") { deps.skipOnboarding(); res.writeHead(204).end(); return; }
  if (req.method !== "POST") { res.writeHead(405).end(); return; }
  if (req.url?.startsWith("/network-latency")) {
    const raw = Number(new URL(req.url, "http://127.0.0.1").searchParams.get("ms"));
    json(res, 200, { ms: setSimulatedGatewayLatencyMs(raw) }); return;
  }
  if (req.url?.startsWith("/gateway-offline")) {
    const induced = new URL(req.url, "http://127.0.0.1").searchParams.get("induced") === "1";
    void deps.applyGatewayOffline(induced).then(
      (applied) => json(res, 200, applied),
      (error: unknown) => json(res, 500, { error: error instanceof Error ? error.message : String(error) }),
    );
    return;
  }
  if (req.url?.startsWith("/theme")) {
    const preference = new URL(req.url, "http://127.0.0.1").searchParams.get("preference");
    if (!isSandThemePreference(preference)) { json(res, 400, { error: `not a theme preference: ${String(preference)}` }); return; }
    json(res, 200, deps.themeController.setPreference(preference)); return;
  }
  if (req.url === "/reload") { deps.reloadMainWindow(); res.writeHead(204).end(); return; }
  if (req.url === "/restart" && deps.restartExitCode != null) { res.writeHead(204).end(); deps.exitForDevRestart(deps.restartExitCode); return; }
  if (req.url === "/box-rebuild-start") { deps.emitDevBoxRebuild(); res.writeHead(204).end(); return; }
  if (req.url?.startsWith("/widget-gallery")) {
    const isOn = new URL(req.url, "http://127.0.0.1").searchParams.get("on") === "1";
    deps.broadcast("sand:dev-widget-gallery", { isOn }); res.writeHead(204).end(); return;
  }
  if (req.url === "/restart-onboarding") { deps.restartOnboarding(); res.writeHead(204).end(); return; }
  res.writeHead(404).end();
}

export function startDevControlServer(deps: DevControlServerDependencies): Server {
  const port = resolveDevControlPort(deps.env);
  const server = http.createServer((req, res) => handleDevControlRequest(req, res, deps));
  server.on("error", (error) => deps.onBindError(port, error));
  server.listen(port, "127.0.0.1");
  return server;
}
