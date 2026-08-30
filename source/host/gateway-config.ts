import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

export class SandGatewayConfigError extends Error {
  constructor(message: string) { super(message); this.name = "SandGatewayConfigError"; }
}

export interface GatewayServerConfig {
  readonly host: string;
  readonly port?: number;
  readonly authToken?: string;
  readonly tls?: { readonly cert: Buffer; readonly key: Buffer };
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
export function isLoopbackHost(host: string): boolean { return LOOPBACK_HOSTS.has(host.trim().toLowerCase()); }

function isTruthyEnv(value: string | undefined): boolean {
  if (value == null) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function readPort(raw: string | undefined): number | undefined {
  if (raw == null || raw.length === 0) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function resolveTls(env: NodeJS.ProcessEnv): GatewayServerConfig["tls"] {
  const certPath = env.SAND_GATEWAY_TLS_CERT?.trim();
  const keyPath = env.SAND_GATEWAY_TLS_KEY?.trim();
  if ((certPath == null || certPath.length === 0) && (keyPath == null || keyPath.length === 0)) return undefined;
  if (certPath == null || certPath.length === 0 || keyPath == null || keyPath.length === 0) {
    throw new SandGatewayConfigError("Gateway TLS needs both SAND_GATEWAY_TLS_CERT and SAND_GATEWAY_TLS_KEY.");
  }
  try { return { cert: readFileSync(certPath), key: readFileSync(keyPath) }; }
  catch (error) { throw new SandGatewayConfigError(`Failed to read gateway TLS cert/key (${certPath}, ${keyPath}): ${String(error)}`); }
}

export function resolveGatewayServerConfig(
  env: NodeJS.ProcessEnv = process.env,
  generateToken: () => string = () => randomBytes(32).toString("base64url")
): GatewayServerConfig {
  const host = env.SAND_GATEWAY_BIND_HOST?.trim() || "127.0.0.1";
  const port = readPort(env.SAND_HOST_PORT);
  const tls = resolveTls(env);
  const pinnedToken = env.SAND_GATEWAY_TOKEN?.trim();
  const requireAuth = !isLoopbackHost(host) || isTruthyEnv(env.SAND_GATEWAY_REQUIRE_AUTH) || (pinnedToken != null && pinnedToken.length > 0);
  const authToken = requireAuth ? (pinnedToken != null && pinnedToken.length > 0 ? pinnedToken : generateToken()) : undefined;
  return { host, ...(port === undefined ? {} : { port }), ...(authToken === undefined ? {} : { authToken }), ...(tls === undefined ? {} : { tls }) };
}

export function gatewayScheme(config: GatewayServerConfig): "http" | "https" { return config.tls == null ? "http" : "https"; }
