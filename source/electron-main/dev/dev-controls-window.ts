import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { getSandRootDir } from "../../host/host-paths.js";
import { createDeadlinePolicy, realClock } from "../../internal/scheduling.js";
import { isSandThemePreference, type SandThemePreference } from "../../shared/desktop.js";
import { getAttachProdBoxStatus, writeAttachProdBoxPrefs } from "./dev-attach-prod-box.js";
import { resolveDevControlPort } from "./dev-controls-gate.js";
import { pokeHostUpgrade } from "./dev-host-upgrade-poke.js";

export const DEFAULT_CONTAINER_NAME = "sand-dev-box";
export const DEFAULT_GATEWAY_URL = "http://127.0.0.1:1340";
export const NOVNC_PORT = 6_080;
export const DEV_CONTROLS_GATEWAY_PROBE_TIMEOUT_MS = 2_000;
export const LOG_TAIL_LINES = 200;

export interface DevControlsCommandResult { readonly isOk: boolean; readonly exitCode: number | null; readonly output: string; readonly durationMs: number }
export interface BoxDoctorCheck { readonly isPass: boolean; readonly name: string; readonly detail: string }
export interface BoxDoctorResult { readonly isOk: boolean; readonly checks: readonly BoxDoctorCheck[]; readonly summary: string; readonly raw: string }

export function resolveDevControlsContainerName(env: NodeJS.ProcessEnv = process.env): string { return env.SAND_DEV_BOX_CONTAINER ?? DEFAULT_CONTAINER_NAME; }
export function resolveDevControlsGatewayUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.SAND_HOST_GATEWAY_URL?.trim(); return value != null && value.length > 0 ? value : DEFAULT_GATEWAY_URL;
}
export function devBoxRootHost(): string { return path.join(getSandRootDir(), "dev-box"); }
export function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"] as const; let value = bytes / 1_024; let unit = 0;
  while (value >= 1_024 && unit < units.length - 1) { value /= 1_024; unit += 1; }
  return `${value.toFixed(1)} ${units[unit]}`;
}
export function parseBoxDoctorOutput(raw: string): BoxDoctorResult {
  const checks: BoxDoctorCheck[] = []; let summary = "";
  for (const line of raw.split("\n")) {
    const check = /^\[box-doctor\]\s+(PASS|FAIL)\s+([^:]+):\s*(.*)$/.exec(line.trim());
    if (check?.[1] != null && check[2] != null && check[3] != null) {
      checks.push({ isPass: check[1] === "PASS", name: check[2].trim(), detail: check[3].trim() }); continue;
    }
    const match = /^\[box-doctor\]\s+SUMMARY:\s*(.*)$/.exec(line.trim()); if (match?.[1] != null) summary = match[1].trim();
  }
  return { isOk: checks.length > 0 && checks.every((check) => check.isPass), checks, summary, raw };
}

export function execCapture(command: string, args: readonly string[], options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv; readonly now?: () => number } ): Promise<DevControlsCommandResult> {
  const now = options.now ?? Date.now; const startedAt = now();
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    const append = (chunk: Buffer): void => { output += chunk.toString(); if (output.length > 200_000) output = output.slice(-200_000); };
    child.stdout?.on("data", append); child.stderr?.on("data", append);
    child.on("error", (error) => resolve({ isOk: false, exitCode: null, output: `${output}\n${String(error)}`.trim(), durationMs: now() - startedAt }));
    child.on("close", (code) => resolve({ isOk: code === 0, exitCode: code, output: output.trim(), durationMs: now() - startedAt }));
  });
}

export interface DevControlsWindowRuntimeOptions {
  readonly projectDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchFn?: typeof fetch;
  reportFailure?(surface: "dev-controls", operation: string, error: unknown): void;
}

export function createDevControlsWindowRuntime(options: DevControlsWindowRuntimeOptions) {
  const env = options.env ?? process.env; const fetchFn = options.fetchFn ?? fetch;
  const containerName = (): string => resolveDevControlsContainerName(env);
  const gatewayUrl = (): string => resolveDevControlsGatewayUrl(env);
  const capture = (command: string, args: readonly string[]): Promise<DevControlsCommandResult> => execCapture(command, args, { cwd: options.projectDir, env });
  const isContainerRunning = async (): Promise<boolean> => {
    const result = await capture("docker", ["inspect", "-f", "{{.State.Running}}", containerName()]); return result.isOk && result.output.trim() === "true";
  };
  const readGatewayToken = async (): Promise<string | null> => {
    const fromEnv = env.SAND_HOST_GATEWAY_TOKEN?.trim(); if (fromEnv) return fromEnv;
    try { const parsed = JSON.parse(await readFile(path.join(devBoxRootHost(), "gateway.json"), "utf8")) as { gatewayToken?: unknown }; return typeof parsed.gatewayToken === "string" ? parsed.gatewayToken : null; }
    catch { return null; }
  };
  const probeDeadline = createDeadlinePolicy(realClock, { name: "dev-controls-gateway-probe", timeoutMs: DEV_CONTROLS_GATEWAY_PROBE_TIMEOUT_MS });
  const probeGateway = async (): Promise<{ isReachable: boolean; isBusy: boolean; latencyMs: number | null }> => {
    const startedAt = Date.now();
    try {
      return await probeDeadline.run(async (signal) => {
        const response = await fetchFn(`${gatewayUrl()}/health`, { signal }); const latencyMs = Date.now() - startedAt;
        if (!response.ok) return { isReachable: false, isBusy: false, latencyMs };
        let isBusy = false; try { isBusy = ((await response.json()) as { isBusy?: unknown }).isBusy === true; } catch (error) { options.reportFailure?.("dev-controls", "health-body", error); }
        return { isReachable: true, isBusy, latencyMs };
      });
    } catch { return { isReachable: false, isBusy: false, latencyMs: null }; }
  };
  const readCopyInOutcome = async (): Promise<string> => {
    if (!await isContainerRunning()) return "unknown";
    const result = await capture("docker", ["exec", containerName(), "sh", "-c", "cat /tmp/sand-copy-in.log 2>/dev/null || true"]);
    return [...result.output.matchAll(/\[box-copy-in\] result outcome=(\S+)/g)].at(-1)?.[1] ?? "none";
  };
  return {
    async runDevBoxScript(subcommand: string, extraEnv: NodeJS.ProcessEnv = {}) {
      return await execCapture(process.execPath, [path.join(options.projectDir, "scripts", "dev-box-docker.mjs"), subcommand], { cwd: options.projectDir, env: { ...env, ELECTRON_RUN_AS_NODE: "1", ...extraEnv } });
    },
    async collectBoxStatus() {
      const [running, gateway] = await Promise.all([isContainerRunning(), probeGateway()]);
      const detail = !running ? "Container not running" : !gateway.isReachable ? "Container up, gateway not reachable yet" : `Gateway healthy${gateway.isBusy ? " (host busy)" : ""}`;
      return { containerName: containerName(), isContainerRunning: running, gatewayUrl: gatewayUrl(), isGatewayReachable: gateway.isReachable, isHostBusy: gateway.isBusy, latencyMs: gateway.latencyMs, detail };
    },
    async collectBoxHealth(): Promise<BoxDoctorResult> {
      if (!await isContainerRunning()) return { isOk: false, checks: [], summary: `Container ${containerName()} is not running`, raw: "" };
      const result = await capture("docker", ["exec", containerName(), "box-doctor"]); const health = parseBoxDoctorOutput(result.output);
      return health.checks.length > 0 ? health : { isOk: false, checks: [], summary: result.output.length > 0 ? "box-doctor produced no checks" : "box-doctor failed", raw: result.output };
    },
    async collectBoxStoreStatus() {
      const root = devBoxRootHost(); let storeId: string | null = null;
      try { storeId = (await readFile(path.join(root, "box-store-id"), "utf8")).trim() || null; } catch {}
      let manifestEntries = 0; let totalBytes = 0; let lastSnapshotMsAgo: number | null = null;
      if (storeId != null) try {
        const parsed = JSON.parse(await readFile(path.join(root, "box-store", storeId, "manifest.json"), "utf8")) as { entries?: Record<string, { size?: unknown }>; updatedAtMs?: unknown };
        const entries = parsed.entries ?? {}; manifestEntries = Object.keys(entries).length;
        for (const entry of Object.values(entries)) if (typeof entry.size === "number" && entry.size > 0) totalBytes += entry.size;
        if (typeof parsed.updatedAtMs === "number" && parsed.updatedAtMs > 0) lastSnapshotMsAgo = Math.max(0, Date.now() - parsed.updatedAtMs);
      } catch (error) { options.reportFailure?.("dev-controls", "snapshot-manifest", error); }
      return { isStoreEnabled: storeId != null, lastSnapshotMsAgo, manifestEntries, totalBytes, copyInOutcome: await readCopyInOutcome(), detail: storeId == null ? "Store not configured (run dev:box)" : lastSnapshotMsAgo == null ? "No snapshot yet" : `${manifestEntries} files, ${formatBytes(totalBytes)}` };
    },
    async snapshotBoxStoreNow(): Promise<DevControlsCommandResult> {
      const startedAt = Date.now(); const token = await readGatewayToken();
      if (token == null) return { isOk: false, exitCode: null, output: "No gateway token found (is the box up?).", durationMs: Date.now() - startedAt };
      try {
        const response = await fetchFn(`${gatewayUrl()}/api/snapshotBoxStoreNow`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ includeIdleOnly: false }) }); const text = await response.text();
        return { isOk: response.ok, exitCode: response.ok ? 0 : response.status, output: text.length > 0 ? text : `HTTP ${response.status}`, durationMs: Date.now() - startedAt };
      } catch (error) { return { isOk: false, exitCode: null, output: String(error), durationMs: Date.now() - startedAt }; }
    },
    async pokeHostUpgrade() { return await pokeHostUpgrade({ gatewayBaseUrl: gatewayUrl(), token: await readGatewayToken(), fetchFn }); },
    async tailBoxLogs() { return !await isContainerRunning() ? { isOk: false, exitCode: null, output: `Container ${containerName()} is not running.`, durationMs: 0 } : await capture("docker", ["exec", containerName(), "sh", "-c", `touch /tmp/sand-supervisor.log /tmp/sand-host.log; tail -n ${LOG_TAIL_LINES} /tmp/sand-supervisor.log /tmp/sand-host.log`]); },
    async boxStoreLogs() { return !await isContainerRunning() ? { isOk: false, exitCode: null, output: `Container ${containerName()} is not running.`, durationMs: 0 } : await capture("docker", ["exec", containerName(), "sh", "-c", `touch /tmp/sand-host.log /tmp/sand-copy-in.log; grep -hF -e '[box-store-sync]' -e '[box-copy-in]' /tmp/sand-host.log /tmp/sand-copy-in.log | tail -n ${LOG_TAIL_LINES}`]); },
    async nukeBox() { return await capture("bash", [path.join(options.projectDir, "box", "nuke-sand-box.sh")]); },
    openBoxDesktop(openExternal: (url: string) => Promise<unknown>) { const url = new URL(gatewayUrl()); url.port = String(NOVNC_PORT); url.pathname = "/vnc.html"; return openExternal(url.toString()); },
  };
}

export interface SandThemeState { readonly preference: SandThemePreference; readonly resolved: "light" | "dark" }
export function isSandThemeState(value: unknown): value is SandThemeState {
  return typeof value === "object" && value != null && !Array.isArray(value) && "preference" in value && isSandThemePreference(value.preference) && "resolved" in value && (value.resolved === "light" || value.resolved === "dark");
}
export class SandDevThemeControlError extends Error {}
export class SandDevGatewayOfflineControlError extends Error {}
export async function fetchTheme(search: string, fetchFn: typeof fetch = fetch): Promise<SandThemeState> {
  const response = await fetchFn(`http://127.0.0.1:${resolveDevControlPort()}/theme${search}`, { method: search.length === 0 ? "GET" : "POST" }); const body: unknown = await response.json();
  if (!response.ok || !isSandThemeState(body)) throw new SandDevThemeControlError(`theme control failed: HTTP ${response.status}`); return body;
}
export async function fetchGatewayOffline(search: string, fetchFn: typeof fetch = fetch): Promise<{ induced: boolean }> {
  const response = await fetchFn(`http://127.0.0.1:${resolveDevControlPort()}/gateway-offline${search}`, { method: search.length === 0 ? "GET" : "POST" }); const body: unknown = await response.json();
  if (!response.ok || typeof body !== "object" || body == null || !("induced" in body) || typeof body.induced !== "boolean") {
    const detail = typeof body === "object" && body != null && "error" in body && typeof body.error === "string" ? body.error : `gateway-offline control failed: HTTP ${response.status}`;
    throw new SandDevGatewayOfflineControlError(detail);
  }
  return { induced: body.induced };
}
export async function postDevControl(pathname: string, fetchFn: typeof fetch = fetch): Promise<void> { try { await fetchFn(`http://127.0.0.1:${resolveDevControlPort()}${pathname}`, { method: "POST" }); } catch {} }

export interface DevBrowserWindow {
  isDestroyed(): boolean; focus(): void; setMenuBarVisibility(visible: boolean): void; on(event: "closed", listener: () => void): void; loadURL(url: string): Promise<unknown>;
}
export interface DevControlsWindowElectronPort {
  readonly screen: { getPrimaryDisplay(): { workArea: { x: number; y: number; width: number; height: number } } };
  createBrowserWindow(options: Record<string, unknown>): DevBrowserWindow;
}
let devControlsWindow: DevBrowserWindow | undefined;
export function openDevControlsWindow(options: { readonly electron: DevControlsWindowElectronPort; readonly devServerUrl?: string; readonly preloadPath: string }): void {
  const devServerUrl = options.devServerUrl; if (devServerUrl == null || devServerUrl.length === 0) return;
  if (devControlsWindow != null && !devControlsWindow.isDestroyed()) { devControlsWindow.focus(); return; }
  const width = 780; const height = 600; const margin = 16; const { workArea } = options.electron.screen.getPrimaryDisplay();
  const window = options.electron.createBrowserWindow({ width, height, minWidth: 660, minHeight: 460, x: workArea.x + workArea.width - width - margin, y: workArea.y + margin, title: "Grok Bot Dev Controls", resizable: true, minimizable: true, maximizable: true, fullscreenable: false, backgroundColor: "#0f1117", autoHideMenuBar: true, webPreferences: { contextIsolation: true, nodeIntegration: false, preload: options.preloadPath, sandbox: false } });
  window.setMenuBarVisibility(false); devControlsWindow = window; window.on("closed", () => { devControlsWindow = undefined; });
  const target = new URL("src/electron-dev-controls/page/dev-controls.html", devServerUrl.endsWith("/") ? devServerUrl : `${devServerUrl}/`).href; void window.loadURL(target);
}

export { getAttachProdBoxStatus, writeAttachProdBoxPrefs };
