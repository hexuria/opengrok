export const EGRESS_TUNNEL_WS_PORT = 8790;

export interface BoxConnectionInfo {
  readonly baseUrl: string;
  readonly token?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly vncProxy?: unknown;
}

export interface EgressTunnelConfig {
  readonly url: string;
  readonly bearer: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly allowPrivateTargets: boolean;
}

export function deriveEgressTunnelWsUrl(baseUrl: string, podProxied: boolean): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  if (podProxied) {
    const [firstLabel, ...rest] = url.hostname.split(".");
    if (firstLabel == null || !/-\d+$/.test(firstLabel)) return null;
    url.hostname = [firstLabel.replace(/-\d+$/, `-${EGRESS_TUNNEL_WS_PORT}`), ...rest].join(".");
  } else {
    url.port = String(EGRESS_TUNNEL_WS_PORT);
  }
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  url.pathname = "/";
  url.search = "";
  return url.toString();
}

export function boxConnectionToEgressConfig(info: BoxConnectionInfo): EgressTunnelConfig | null {
  if (info.token == null || info.token.length === 0) return null;
  const url = deriveEgressTunnelWsUrl(info.baseUrl, info.vncProxy != null);
  if (url == null) return null;
  return {
    url,
    bearer: info.token,
    ...(info.headers != null ? { headers: info.headers } : {}),
    allowPrivateTargets: false,
  };
}
