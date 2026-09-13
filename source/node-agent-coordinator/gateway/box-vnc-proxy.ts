import {
  SAND_BOX_FORK_NOVNC_PORT,
  SAND_BOX_PRIMARY_NOVNC_PORT,
  buildSandBoxNoVncUrl,
  isSandSpecialTreatmentNoVncUrl
} from "../../packages/constants/sand-box.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

export interface VncProxyDescriptor {
  primaryUrl: string;
  forkBaseUrl: string;
  networkToken: string;
}

export interface ForeverBoxWindowStatus {
  vncUrl: string;
  [key: string]: unknown;
}

export interface ForeverBoxStatus {
  vncUrl?: string | null;
  windows?: ForeverBoxWindowStatus[] | null;
  [key: string]: unknown;
}

/**
 * A URL the forever-box pane can actually load. Empty string, whitespace, and
 * non-http(s) values are how a dead noVNC iframe used to appear: the renderer
 * treated "" as "we have a screen" and `new URL("")` threw in the quality patch.
 */
export function presentBoxScreenUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return trimmed;
  } catch {
    return null;
  }
}

export function proxifyBoxVncUrl(vncUrl: string, vncProxy: VncProxyDescriptor): string {
  let parsed: URL;
  try {
    parsed = new URL(vncUrl);
  } catch {
    return vncUrl;
  }
  // Guest noVNC (ascii hosted, grok-box :6080) authenticates with `password=`.
  // Cursor's in-box proxy uses `network_token`. Rewriting a password URL through
  // the pod proxy would load the wrong desktop — including loopback:6080, which
  // is both grok-box's published viewer and SAND_BOX_PRIMARY_NOVNC_PORT.
  if (parsed.searchParams.has("password")) return vncUrl;
  if (!LOOPBACK_HOSTS.has(parsed.hostname) || !parsed.pathname.endsWith("/vnc.html")) return vncUrl;
  const port = Number.parseInt(parsed.port, 10);
  if (port === SAND_BOX_PRIMARY_NOVNC_PORT) return vncProxy.primaryUrl;
  if (port === SAND_BOX_FORK_NOVNC_PORT) {
    return buildSandBoxNoVncUrl(vncProxy.forkBaseUrl, vncProxy.networkToken, forkDisplayToken(parsed), isSandSpecialTreatmentNoVncUrl(vncProxy.primaryUrl));
  }
  return vncUrl;
}

function forkDisplayToken(parsed: URL): string | undefined {
  const path = parsed.searchParams.get("path");
  const queryIndex = path?.indexOf("?") ?? -1;
  if (path == null || queryIndex < 0) return undefined;
  const token = new URLSearchParams(path.slice(queryIndex + 1)).get("token");
  return token != null && token.length > 0 ? token : undefined;
}

function presentOrProxify(vncUrl: unknown, vncProxy: VncProxyDescriptor | null): string | null {
  const present = presentBoxScreenUrl(vncUrl);
  if (present == null) return null;
  return vncProxy == null ? present : proxifyBoxVncUrl(present, vncProxy);
}

export function proxifyForeverBoxStatus<T extends ForeverBoxStatus>(status: T, vncProxy: VncProxyDescriptor | null): T {
  const vncUrl = presentOrProxify(status.vncUrl, vncProxy);
  if (status.windows == null) return { ...status, vncUrl } as T;
  return {
    ...status,
    vncUrl,
    windows: status.windows.map((window) => ({
      ...window,
      vncUrl: presentOrProxify(window.vncUrl, vncProxy) ?? window.vncUrl,
    })),
  } as T;
}
