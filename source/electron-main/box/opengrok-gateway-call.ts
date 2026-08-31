import { OPENGROK_ACCESS_TOKEN_SECRET, OPENGROK_GATEWAY_TOKEN_SECRET } from "../../shared/box-runtime.js";

const CALL_TIMEOUT_MS = 30_000;

export interface OpenGrokGatewaySecrets {
  readSecret(key: string): Promise<string | null>;
}

/**
 * Call one gateway command from the main process.
 *
 * The coordinator owns the gateway for everything the renderer asks, and that
 * is right: it holds the connection, the retries and the event stream. This is
 * for the handful of things the main process must do on its own — a settings
 * action with no agent behind it — and it is deliberately plain. No retry, no
 * connection cache, no reachability tracking; if it fails, the caller says so.
 *
 * Both tokens go on the call because they answer different questions. The
 * bearer says which gateway may be spoken to at all; the account token says
 * whose account the call is for, and the server verifies it by signature. With
 * only the bearer the server would fall back to its configured account and act
 * on somebody else's computer.
 */
export async function callOpenGrokGateway(
  secrets: OpenGrokGatewaySecrets,
  gatewayUrl: string,
  method: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(method)) throw new Error(`Refusing to call a gateway method named ${JSON.stringify(method)}.`);
  const base = gatewayUrl.replace(/\/+$/, "");
  if (base.length === 0) throw new Error("No OpenGrok server is configured.");

  const [bearer, account] = await Promise.all([
    secrets.readSecret(OPENGROK_GATEWAY_TOKEN_SECRET),
    secrets.readSecret(OPENGROK_ACCESS_TOKEN_SECRET),
  ]);
  if (bearer == null || bearer.length === 0) throw new Error("Sign in to your OpenGrok server first.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${base}/api/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bearer}`,
        ...(account == null || account.length === 0 ? {} : { "x-opengrok-account": account }),
      },
      body: JSON.stringify(args),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let parsed: unknown;
  try { parsed = text.length === 0 ? undefined : JSON.parse(text); } catch { parsed = undefined; }
  if (!response.ok) {
    // The server's own words are more useful than the status, when it sends any.
    const stated = typeof parsed === "object" && parsed != null && typeof (parsed as Record<string, unknown>).error === "string"
      ? String((parsed as Record<string, unknown>).error)
      : "";
    throw new Error(stated.length > 0 ? stated : `${method} failed (${response.status}).`);
  }
  return parsed;
}
