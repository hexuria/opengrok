/**
 * Signing in to an OpenGrok server.
 *
 * The two tokens are deliberately different things and are obtained in order:
 * `/auth/poll` issues the ACCOUNT token (a JWT identifying the person), and
 * `EnsureSandBox` exchanges that for the GATEWAY bearer that seam A wants.
 * Seam B rejects the gateway bearer and seam A rejects the account token, which
 * is the separation the contract asks for - so the client must hold both and
 * send the right one to each.
 *
 * Kept free of Electron and of the connector's graph: main-edge is loaded in
 * isolation by tests and must not drag either in just to sign in.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";

export interface OpenGrokIdentity {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly email?: string;
  readonly accountId?: string;
  readonly expiresAtMs?: number;
}

export interface OpenGrokMint {
  readonly gatewayUrl: string;
  readonly gatewayToken: string;
  readonly identity: OpenGrokIdentity;
}

const AUTH_POLL_PATH = "/auth/poll";
const LOGIN_PATH = "/loginDeepControl";
const ENSURE_BOX_PATH = "/aiserver.v1.GrokBotService/EnsureSandBox";
const SIGN_IN_TIMEOUT_MS = 15_000;
/** How long to wait for the person to finish the browser step. */
const BROWSER_LOGIN_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 1_500;

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * PKCE, as the client already computes it elsewhere: a random verifier, and the
 * challenge is its sha256. The server registers the challenge against the uuid
 * when the browser leg runs, then only releases a token to whoever can present
 * the matching verifier.
 */
export function createLoginParams(baseUrl: string, redirectTarget = "sand"): { uuid: string; verifier: string; challenge: string; loginUrl: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const uuid = randomUUID();
  const query = `challenge=${encodeURIComponent(challenge)}&uuid=${encodeURIComponent(uuid)}&mode=login&redirectTarget=${encodeURIComponent(redirectTarget)}`;
  return { uuid, verifier, challenge, loginUrl: `${baseUrl.replace(/\/+$/, "")}${LOGIN_PATH}?${query}` };
}

function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

/** Read the claims we show the user. A malformed token is not fatal here - the server is the judge. */
export function readIdentityClaims(accessToken: string): { email?: string; accountId?: string; expiresAtMs?: number } {
  try {
    const payload = accessToken.split(".")[1];
    if (payload == null) return {};
    const claims = JSON.parse(base64UrlDecode(payload)) as Record<string, unknown>;
    return {
      ...(typeof claims.email === "string" ? { email: claims.email } : {}),
      ...(typeof claims.sub === "string" ? { accountId: claims.sub } : {}),
      ...(typeof claims.exp === "number" ? { expiresAtMs: claims.exp * 1000 } : {}),
    };
  } catch {
    return {};
  }
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

async function postJson(url: string, token: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
    signal,
  });
  const text = await response.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  if (!response.ok) {
    const message = typeof parsed === "object" && parsed != null && typeof (parsed as Record<string, unknown>).message === "string"
      ? String((parsed as Record<string, unknown>).message)
      : `${response.status} ${text.slice(0, 120)}`;
    throw new Error(message);
  }
  return (typeof parsed === "object" && parsed != null ? parsed : {}) as Record<string, unknown>;
}

/**
 * Wait for the person to finish the browser step. The server answers 404 with
 * "pending" until the challenge has been completed with a matching verifier,
 * and 200 with the tokens once it has - so a 404 here means keep waiting, not
 * failure. The token is consumed on success: one challenge, one token, and a
 * replay is a 404 again.
 */
export async function pollForOpenGrokToken(
  baseUrl: string,
  uuid: string,
  verifier: string,
  options: { readonly timeoutMs?: number; readonly signal?: AbortSignal; readonly sleep?: (ms: number) => Promise<void> } = {},
): Promise<OpenGrokIdentity> {
  const base = baseUrl.replace(/\/+$/, "");
  const deadline = Date.now() + (options.timeoutMs ?? BROWSER_LOGIN_TIMEOUT_MS);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const url = `${joinUrl(base, AUTH_POLL_PATH)}?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    if (options.signal?.aborted === true) throw new Error("Sign-in was cancelled.");
    let response: Response;
    try {
      response = await fetch(url, { headers: { accept: "application/json" }, ...(options.signal == null ? {} : { signal: options.signal }) });
    } catch {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    lastStatus = response.status;
    if (response.ok) {
      const poll = (await response.json()) as Record<string, unknown>;
      const accessToken = typeof poll.accessToken === "string" ? poll.accessToken : "";
      if (accessToken.length === 0) throw new Error("The server did not return an access token.");
      return {
        accessToken,
        ...(typeof poll.refreshToken === "string" ? { refreshToken: poll.refreshToken } : {}),
        ...readIdentityClaims(accessToken),
      };
    }
    // 404 is "not yet"; anything else is the server saying no.
    if (response.status !== 404) throw new Error(`The server refused the sign-in (${response.status}).`);
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(lastStatus === 404
    ? "Sign-in timed out. Finish the sign-in page in your browser, then try again."
    : "Sign-in timed out before the server answered.");
}

/** Exchange the account token for the gateway bearer. Seam B mints what seam A wants. */
export async function mintOpenGrokGateway(baseUrl: string, accessToken: string): Promise<{ gatewayUrl: string; gatewayToken: string }> {
  const base = baseUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SIGN_IN_TIMEOUT_MS);
  try {
    const box = await postJson(joinUrl(base, ENSURE_BOX_PATH), accessToken, controller.signal);
    const gatewayUrl = typeof box.gatewayUrl === "string" && box.gatewayUrl.length > 0 ? box.gatewayUrl : base;
    const gatewayToken = typeof box.gatewayToken === "string" ? box.gatewayToken : "";
    if (gatewayToken.length === 0) throw new Error("The server signed you in but minted no gateway token.");
    return { gatewayUrl, gatewayToken };
  } finally {
    clearTimeout(timer);
  }
}

export function assertUsableServerUrl(gatewayUrlInput: string): string {
  const base = gatewayUrlInput.trim().replace(/\/+$/, "");
  if (base.length === 0) throw new Error("Enter your OpenGrok server URL first.");
  try { new URL(base); } catch { throw new Error("That is not a valid URL. Include the scheme, for example http://192.168.1.10:1447"); }
  return base;
}

const LIST_COMPUTERS_PATH = "/aiserver.v1.GrokBotService/ListGrokBotUserComputers";

export interface OpenGrokComputer {
  readonly id: string;
  readonly label: string;
  readonly kind?: string;
  readonly state?: string;
  /** False when the organisation has not set this kind up yet. */
  readonly configured?: boolean;
}

/**
 * The computers the SERVER offers, which is the honest source once it owns the
 * bots: a box, a Cloud PC, whatever has been registered there. An empty list is
 * a real answer, not a failure - it means none have been added yet.
 */
export async function listOpenGrokComputers(baseUrl: string, accessToken: string): Promise<readonly OpenGrokComputer[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SIGN_IN_TIMEOUT_MS);
  try {
    const body = await postJson(joinUrl(baseUrl.replace(/\/+$/, ""), LIST_COMPUTERS_PATH), accessToken, controller.signal);
    const rows = Array.isArray(body.computers) ? body.computers : [];
    return rows.flatMap((row) => {
      if (typeof row !== "object" || row == null) return [];
      const record = row as Record<string, unknown>;
      const id = typeof record.id === "string" && record.id.length > 0 ? record.id
        : typeof record.computerId === "string" ? record.computerId : "";
      if (id.length === 0) return [];
      const label = typeof record.name === "string" && record.name.length > 0 ? record.name
        : typeof record.label === "string" && record.label.length > 0 ? record.label : id;
      return [{
        id, label,
        ...(typeof record.kind === "string" ? { kind: record.kind } : {}),
        ...(typeof record.state === "string" ? { state: record.state } : {}),
        ...(typeof record.configured === "boolean" ? { configured: record.configured } : {}),
      }];
    });
  } finally {
    clearTimeout(timer);
  }
}
