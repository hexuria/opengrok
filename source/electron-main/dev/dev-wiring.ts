import { isSandThemePreference, type SandThemePreference } from "../../shared/desktop.js";
import { getAttachProdBoxStatus, writeAttachProdBoxPrefs } from "./dev-attach-prod-box.js";
import { SAND_DEV_CAPABILITY_ENV } from "./dev-capability.js";
import { startDevControlServer, type DevThemeController } from "./dev-control-server.js";

export interface DevLoginService {
  devLogin(options: { readonly tier?: string; readonly email?: string }): Promise<{ readonly kind: string; readonly email?: string }>;
}
export async function maybeDevLoginFromEnv(service: DevLoginService, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const tier = env.SAND_DEV_LOGIN;
  const email = env.SAND_DEV_LOGIN_EMAIL;
  if (!((tier != null && tier.length > 0) || (email != null && email.length > 0))) return;
  try {
    const status = await service.devLogin({ ...(tier === undefined ? {} : { tier }), ...(email === undefined ? {} : { email }) });
    const who = status.kind === "logged-in" && status.email != null ? ` as ${status.email}` : "";
    console.log(`[sand] dev-login: ${status.kind}${who}`);
  } catch (error) {
    console.error(`[sand] dev-login failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseRestartExitCode(raw: string | undefined): number | undefined {
  if (raw == null || raw.length === 0) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function createDevRestartExit(exitApp: (exitCode: number) => void): (exitCode: number) => void {
  return (restartExitCode) => { const timer = setTimeout(() => exitApp(restartExitCode), 0); timer.unref?.(); };
}

export interface IpcMainPort {
  handle(channel: string, listener: (event: unknown, request?: any) => unknown): void;
}
export interface DevWiringDependencies {
  readonly ipcMain: IpcMainPort;
  readonly isPackaged: boolean;
  readonly env?: NodeJS.ProcessEnv;
  skipOnboarding(): void;
  exitForDevRestart(exitCode: number): void;
  readonly legs: {
    listAgents(): Promise<unknown>;
    createAgent(request: { readonly name: unknown; readonly description: unknown; readonly origin: "dev" }): Promise<unknown>;
    deleteAgents(request: { readonly ids: unknown }): Promise<unknown>;
    getConversationOutline(request: { readonly id: unknown }): Promise<unknown>;
    getSubagents(request: { readonly id: unknown }): Promise<unknown>;
  };
  reloadMainWindow(): void;
  isGatewayOfflineInduced(): boolean;
  applyGatewayOffline(induced: boolean): Promise<unknown>;
  clearHasSeenOnboarding(): void;
  emitForceOnboarding(): void;
  readonly themeController: DevThemeController;
  broadcast(channel: string, payload: unknown): void;
  emitDevBoxRebuild(): void;
  onControlServerBindError?(port: number, error: Error): void;
}

export function registerDevWiring(deps: DevWiringDependencies): void {
  const env = deps.env ?? process.env;
  const { ipcMain, skipOnboarding, exitForDevRestart } = deps;
  if (!deps.isPackaged && env[SAND_DEV_CAPABILITY_ENV] === "1") {
    ipcMain.handle("sand:dev-skip-onboarding", () => { skipOnboarding(); });
    ipcMain.handle("sand:dev-agents-list", async () => await deps.legs.listAgents());
    ipcMain.handle("sand:dev-agents-create", async (_event, request) => await deps.legs.createAgent({ name: request.name, description: request.description, origin: "dev" }));
    ipcMain.handle("sand:dev-agents-delete-many", async (_event, request) => await deps.legs.deleteAgents({ ids: request.ids }));
    ipcMain.handle("sand:dev-conversation-outline-get", async (_event, request) => await deps.legs.getConversationOutline({ id: request.id }));
    ipcMain.handle("sand:dev-subagents-get", async (_event, request) => await deps.legs.getSubagents({ id: request.id }));
  }
  if (!deps.isPackaged) {
    ipcMain.handle("sand:attach-prod-box-status", () => getAttachProdBoxStatus(env));
    ipcMain.handle("sand:attach-prod-box-set-enabled", (_event, request) => {
      writeAttachProdBoxPrefs(request.enabled === true);
      const status = getAttachProdBoxStatus(env);
      const exitCode = parseRestartExitCode(env.SAND_RESTART_EXIT_CODE);
      if (request.isRestartMainApp !== false && exitCode != null) exitForDevRestart(exitCode);
      return status;
    });
  }
  const restartExitCode = parseRestartExitCode(env.SAND_RESTART_EXIT_CODE);
  if (restartExitCode != null) ipcMain.handle("sand:dev-restart", () => { exitForDevRestart(restartExitCode); });
  if (!deps.isPackaged) {
    startDevControlServer({
      ...(restartExitCode === undefined ? {} : { restartExitCode }),
      env,
      reloadMainWindow: deps.reloadMainWindow,
      isGatewayOfflineInduced: deps.isGatewayOfflineInduced,
      applyGatewayOffline: deps.applyGatewayOffline,
      skipOnboarding,
      restartOnboarding: () => { deps.clearHasSeenOnboarding(); deps.emitForceOnboarding(); },
      themeController: deps.themeController,
      broadcast: deps.broadcast,
      emitDevBoxRebuild: deps.emitDevBoxRebuild,
      exitForDevRestart,
      onBindError: (port, error) => deps.onControlServerBindError?.(port, error) ?? console.warn(`[sand] dev control server failed to bind :${port}:`, error),
    });
  }
}

export { isSandThemePreference };
export type { SandThemePreference };
