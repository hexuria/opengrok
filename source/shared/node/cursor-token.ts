import { createHash } from "node:crypto";

export const DEFAULT_CURSOR_BACKEND_URL = "https://api2.cursor.sh";
export const PROD_AUTH_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";
export const DEV_AUTH_CLIENT_ID = "OzaBXLClY5CAGxNzUhQ2vlknpi07tGuE";
export const TOKEN_REFRESH_LEEWAY_MS = 5 * 60 * 1_000;

export interface JwtPayload { readonly email?: string; readonly exp?: number; readonly sub?: string; readonly [key: string]: unknown; }

export function parseJwtPayload(token: string): JwtPayload | null {
  const [, payload] = token.split(".");
  if (payload == null || payload.length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.email !== undefined && typeof record.email !== "string") return null;
    if (record.exp !== undefined && typeof record.exp !== "number") return null;
    if (record.sub !== undefined && typeof record.sub !== "string") return null;
    return record as JwtPayload;
  } catch { return null; }
}

export function accountCacheScope(accessToken: string): string {
  return createHash("sha256").update(parseJwtPayload(accessToken)?.sub ?? accessToken).digest("hex");
}

export function isTokenExpiringSoon(token: string, now = Date.now()): boolean {
  const payload = parseJwtPayload(token);
  return payload?.exp == null || payload.exp * 1_000 - now < TOKEN_REFRESH_LEEWAY_MS;
}

export function getAccessTokenExpiryMs(token: string): number | null {
  const exp = parseJwtPayload(token)?.exp;
  return exp == null || !Number.isFinite(exp) ? null : exp * 1_000;
}

/**
 * Which backend answers for the account.
 *
 * There is ONE account in this app, and this is what decides who it belongs to.
 * Pointing it at an OpenGrok server is what makes that server the account
 * authority - not a second account beside the Cursor one, which is the mistake
 * this hook exists to avoid. The main process installs a resolver that consults
 * settings; everything else keeps calling this and is none the wiser.
 */
let backendUrlResolver: (() => string | undefined) | null = null;

export function setBackendUrlResolver(resolve: (() => string | undefined) | null): void {
  backendUrlResolver = resolve;
}

export function getConfiguredBackendUrl(env: NodeJS.ProcessEnv = process.env): string {
  let configured: string | undefined;
  try { configured = backendUrlResolver?.() ?? undefined; } catch { configured = undefined; }
  const raw = (configured != null && configured.trim().length > 0)
    ? configured.trim()
    : env.SAND_BACKEND_URL ?? env.CURSOR_API_BASE_URL ?? DEFAULT_CURSOR_BACKEND_URL;
  return new URL(raw).toString();
}

export function getAuthClientId(backendUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SAND_AUTH_CLIENT_ID;
  if (configured != null && configured.length > 0) return configured;
  const hostname = new URL(backendUrl).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".lclhst.build") || hostname === "dev-staging.cursor.sh" ? DEV_AUTH_CLIENT_ID : PROD_AUTH_CLIENT_ID;
}

export function isDevAuthBackend(backendUrl: string): boolean { return getAuthClientId(backendUrl) !== PROD_AUTH_CLIENT_ID; }
export function shouldRefreshAccessToken(backendUrl: string, accessToken: string): boolean { return isTokenExpiringSoon(accessToken) || isDevAuthBackend(backendUrl); }
