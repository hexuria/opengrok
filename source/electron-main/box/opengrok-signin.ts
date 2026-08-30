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
const ENSURE_BOX_PATH = "/aiserver.v1.GrokBotService/EnsureSandBox";
const SIGN_IN_TIMEOUT_MS = 15_000;

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
 * Sign in and mint, in one step, because a half-signed-in state helps nobody:
 * without the gateway bearer the app cannot reach the server anyway.
 */
export async function signInToOpenGrok(
  gatewayUrlInput: string,
  deps: { readonly randomId: () => string } = { randomId: () => Math.random().toString(36).slice(2) },
): Promise<OpenGrokMint> {
  const base = gatewayUrlInput.trim().replace(/\/+$/, "");
  if (base.length === 0) throw new Error("Enter your OpenGrok server URL first.");
  try { new URL(base); } catch { throw new Error("That is not a valid URL. Include the scheme, for example http://192.168.1.10:1447"); }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SIGN_IN_TIMEOUT_MS);
  try {
    const uuid = deps.randomId();
    const verifier = deps.randomId();
    const pollUrl = `${joinUrl(base, AUTH_POLL_PATH)}?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`;
    const pollResponse = await fetch(pollUrl, { headers: { accept: "application/json" }, signal: controller.signal });
    if (!pollResponse.ok) throw new Error(`The server refused the sign-in (${pollResponse.status}). Check the URL.`);
    const poll = (await pollResponse.json()) as Record<string, unknown>;
    const accessToken = typeof poll.accessToken === "string" ? poll.accessToken : "";
    if (accessToken.length === 0) throw new Error("The server did not return an access token.");

    const box = await postJson(joinUrl(base, ENSURE_BOX_PATH), accessToken, controller.signal);
    const gatewayUrl = typeof box.gatewayUrl === "string" && box.gatewayUrl.length > 0 ? box.gatewayUrl : base;
    const gatewayToken = typeof box.gatewayToken === "string" ? box.gatewayToken : "";
    if (gatewayToken.length === 0) throw new Error("The server signed you in but minted no gateway token.");

    return {
      gatewayUrl,
      gatewayToken,
      identity: {
        accessToken,
        ...(typeof poll.refreshToken === "string" ? { refreshToken: poll.refreshToken } : {}),
        ...readIdentityClaims(accessToken),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
