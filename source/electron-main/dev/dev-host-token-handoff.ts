import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import { getSandRootDir } from "../../host/host-paths.js";
import { realClock, type Clock } from "../../internal/scheduling.js";
import { getConfiguredBackendUrl } from "../../shared/node/cursor-token.js";

export const REWRITE_INTERVAL_MS = 60_000;
export interface DevTokenAuthService {
  getValidAccessToken(options: { readonly backendUrl: string }): Promise<string>;
  peekAccessToken(): Promise<string | null>;
  subscribe(listener: () => void): () => void;
}
export interface DevHostTokenHandoffDependencies {
  readonly tokenPath?: string;
  readonly backendUrl?: string;
  readonly clock?: Clock;
  readonly pid?: number;
  readonly uuid?: () => string;
  reportFailure?(surface: "dev-token-handoff", operation: "token-clear" | "write", error: unknown): void;
}

export function getDevHostTokenPath(): string { return join(getSandRootDir(), "host-token.json"); }

export async function writeHostAccessToken(accessToken: string, deps: DevHostTokenHandoffDependencies = {}): Promise<void> {
  const path = deps.tokenPath ?? getDevHostTokenPath();
  await fs.mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${deps.pid ?? process.pid}.${(deps.uuid ?? randomUUID)()}.tmp`;
  try {
    await fs.writeFile(tempPath, JSON.stringify({ accessToken }, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.rename(tempPath, path);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

export function startDevHostTokenHandoff(authService: DevTokenAuthService, deps: DevHostTokenHandoffDependencies = {}): () => void {
  let lastToken = "";
  let isStopped = false;
  const tokenPath = deps.tokenPath ?? getDevHostTokenPath();
  const sync = async (): Promise<void> => {
    if (isStopped) return;
    let accessToken: string;
    try { accessToken = await authService.getValidAccessToken({ backendUrl: deps.backendUrl ?? getConfiguredBackendUrl() }); }
    catch {
      if (await authService.peekAccessToken() == null) {
        lastToken = "";
        await fs.rm(tokenPath, { force: true }).catch((error) => deps.reportFailure?.("dev-token-handoff", "token-clear", error));
      }
      return;
    }
    if (accessToken === lastToken) return;
    try { await writeHostAccessToken(accessToken, { ...deps, tokenPath }); lastToken = accessToken; }
    catch (error) { deps.reportFailure?.("dev-token-handoff", "write", error); }
  };
  void sync();
  const unsubscribe = authService.subscribe(() => { void sync(); });
  const clock = deps.clock ?? realClock;
  let rewriteArm: { dispose(): void } | undefined;
  const armRewrite = (): void => {
    rewriteArm = clock.schedule(REWRITE_INTERVAL_MS, () => { void sync(); armRewrite(); });
  };
  armRewrite();
  return () => { isStopped = true; unsubscribe(); rewriteArm?.dispose(); };
}
