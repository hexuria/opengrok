import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DeadlinePolicy } from "../../../internal/scheduling.js";
import { errorLogTag } from "../../errors.js";
import { getSandBackendClientHeaders } from "../sand-client-metadata.js";
import { parseRetryAfterHeaderMs } from "../../retry-after.js";
import { reportExperimentsDiagnostic } from "./experiments-diagnostics.js";

export const STATSIG_CLIENT_KEY = "client-Bm4HJ0aDjXHQVsoACMREyLNxm5p6zzuzhO50MgtoT5D";
export const STATSIG_LOG_EVENT_PROXY_URL = "https://api3.cursor.sh/tev1/v1";
export const BOOTSTRAP_CACHE_FILENAME = "sand-statsig-bootstrap.json";

export function sandStatsigNetworkUrlAllowed(url: string): boolean { return url.includes("/rgstr"); }
export function sandStatsigNetworkOverride(url: string, args: RequestInit, fetchImpl: typeof fetch = fetch): Promise<Response> { return sandStatsigNetworkUrlAllowed(url) ? fetchImpl(url, args) : Promise.resolve(new Response(null, { status: 204 })); }
export function extractStatsigUser(config: string): Record<string, unknown> { const parsed = JSON.parse(config) as { user?: unknown }; return typeof parsed.user === "object" && parsed.user != null && !Array.isArray(parsed.user) ? parsed.user as Record<string, unknown> : {}; }
export function readStatsigBootstrapUserId(config: string): string | null { try { const user = extractStatsigUser(config); return typeof user.userID === "string" ? user.userID : null; } catch (error) { reportExperimentsDiagnostic({ kind: "bootstrap_config_unparseable", errorClass: errorLogTag(error) }); return null; } }

export function createCursorChecksum(machineId: string, now = Date.now()): string {
  const unixKiloSeconds = Math.floor(now / 1e6);
  const bytes = new Uint8Array([unixKiloSeconds >> 40 & 255, unixKiloSeconds >> 32 & 255, unixKiloSeconds >> 24 & 255, unixKiloSeconds >> 16 & 255, unixKiloSeconds >> 8 & 255, unixKiloSeconds & 255]);
  let lastByte = 165; for (let index = 0; index < bytes.length; index += 1) { const current = bytes[index] ?? 0; bytes[index] = (current ^ lastByte) + index % 256; lastByte = bytes[index] ?? 0; }
  return `${Buffer.from(bytes).toString("base64url")}${machineId}`;
}

function applyLocalCliModeHeader(headers: Headers, env: NodeJS.ProcessEnv): void { if (env.CURSOR_AGENT_CLI_LOCAL_MODE === "true") headers.set("local-cli-mode", "true"); }
export async function fetchStatsigBootstrap(options: {
  readonly backendUrl: string; readonly deadline: DeadlinePolicy;
  readonly getAccessToken: (options: { backendUrl: string }) => Promise<string>;
  readonly getMachineId: () => Promise<string>; readonly fetchImpl?: typeof fetch; readonly env?: NodeJS.ProcessEnv | undefined;
}): Promise<{ config?: string; retryAfterMs?: number }> {
  const accessToken = await options.getAccessToken({ backendUrl: options.backendUrl }).catch((error) => { reportExperimentsDiagnostic({ kind: "bootstrap_anonymous", errorClass: errorLogTag(error) }); return undefined; });
  const machineId = await options.getMachineId();
  const headers = new Headers({ "content-type": "application/json", "x-cursor-checksum": createCursorChecksum(machineId), ...getSandBackendClientHeaders(options.env), "x-ghost-mode": "true", "x-request-id": randomUUID() });
  if (accessToken != null) headers.set("authorization", `Bearer ${accessToken}`);
  applyLocalCliModeHeader(headers, options.env ?? process.env);
  return options.deadline.run(async (signal) => {
    const response = await (options.fetchImpl ?? fetch)(new URL("aiserver.v1.AnalyticsService/BootstrapStatsig", options.backendUrl), { method: "POST", headers, body: "{}", signal });
    if (!response.ok) { const retryAfterMs = parseRetryAfterHeaderMs(response.headers.get("retry-after")); return retryAfterMs === undefined ? {} : { retryAfterMs }; }
    const data = await response.json() as unknown;
    if (typeof data !== "object" || data == null || !("config" in data)) return {};
    const config = (data as Record<string, unknown>).config; return typeof config === "string" ? { config } : {};
  });
}

export interface CachedStatsigBootstrap { readonly config: string; readonly userId: string | null; readonly fetchedAtMs?: number; }
export function bootstrapCachePath(cacheDir: string): string { return join(cacheDir, BOOTSTRAP_CACHE_FILENAME); }
export function loadCachedBootstrap(cacheDir: string): CachedStatsigBootstrap | null { try { const path = bootstrapCachePath(cacheDir); if (!existsSync(path)) return null; const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; if (typeof parsed.config !== "string") return null; const fetchedAtMs = parsed.fetchedAtMs; return { config: parsed.config, userId: typeof parsed.userId === "string" ? parsed.userId : null, ...(typeof fetchedAtMs === "number" && Number.isFinite(fetchedAtMs) && fetchedAtMs >= 0 ? { fetchedAtMs } : {}) }; } catch (error) { reportExperimentsDiagnostic({ kind: "bootstrap_cache_read_failed", errorClass: errorLogTag(error) }); return null; } }
export async function saveCachedBootstrap(cacheDir: string, cache: CachedStatsigBootstrap): Promise<void> { try { const path = bootstrapCachePath(cacheDir); await mkdir(dirname(path), { recursive: true }); const temp = `${path}.${process.pid}.tmp`; await writeFile(temp, JSON.stringify(cache), "utf8"); await rename(temp, path); } catch (error) { reportExperimentsDiagnostic({ kind: "bootstrap_cache_write_failed", errorClass: errorLogTag(error) }); } }
