const CALL_TIMEOUT_MS = 30_000;

export interface OpenGrokAccountSecrets {
  readSecret(key: string): Promise<string | null>;
}

export interface OpenGrokAccountCall {
  readonly path: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly body?: Record<string, unknown>;
  readonly query?: Record<string, string>;
}

/**
 * Call one of the server's account-scoped endpoints from the main process.
 *
 * Distinct from the gateway call beside it, and deliberately so: the gateway
 * bearer says which gateway may be spoken to and is shared by everyone using
 * that server, while these endpoints act on one person's own machines and
 * policy. They authenticate with the account token, which names who is asking.
 *
 * Sending the gateway bearer here would authorise anybody on the server to
 * change anybody's remote-control policy, so it is not sent at all.
 */
export async function callOpenGrokAccountApi(
  secrets: OpenGrokAccountSecrets,
  accessTokenKey: string,
  baseUrl: string,
  call: OpenGrokAccountCall,
): Promise<unknown> {
  if (!call.path.startsWith("/") || call.path.includes("..")) {
    throw new Error(`Refusing to call ${JSON.stringify(call.path)}.`);
  }
  const base = baseUrl.replace(/\/+$/, "");
  if (base.length === 0) throw new Error("No OpenGrok server is configured.");

  const token = await secrets.readSecret(accessTokenKey);
  if (token == null || token.length === 0) throw new Error("Sign in to your OpenGrok server first.");

  const url = new URL(`${base}${call.path}`);
  for (const [key, value] of Object.entries(call.query ?? {})) url.searchParams.set(key, value);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: call.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(call.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let parsed: unknown;
  try { parsed = text.length === 0 ? undefined : JSON.parse(text); } catch { parsed = undefined; }
  if (!response.ok) {
    const stated = typeof parsed === "object" && parsed != null && typeof (parsed as Record<string, unknown>).error === "string"
      ? String((parsed as Record<string, unknown>).error)
      : "";
    throw new Error(stated.length > 0 ? stated : `${call.path} failed (${response.status}).`);
  }
  return parsed;
}
