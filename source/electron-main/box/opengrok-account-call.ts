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

const PLAIN_TEXT_REFUSAL_MAX_LENGTH = 240;

/**
 * A non-JSON refusal body, if it is safe to show as-is.
 *
 * The server answers some refusals as a bare plain-text string, not JSON -
 * 400 "a model is required", 401 "sign in first", 429 "wait a moment before
 * testing another route" - and those sentences are the one thing a person
 * needs to see (429 in particular tells them exactly what to do: wait). But
 * "the body wasn't JSON" also covers an HTML error page from a proxy in
 * front of the server, or any other body nobody meant as a message, so this
 * is bounded: short, one line, and not markup.
 */
function plainTextRefusal(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > PLAIN_TEXT_REFUSAL_MAX_LENGTH) return null;
  if (trimmed.includes("\n") || trimmed.startsWith("<")) return null;
  return trimmed;
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
    const plainText = stated.length === 0 ? plainTextRefusal(text) : null;
    throw new Error(stated.length > 0 ? stated : plainText ?? `${call.path} failed (${response.status}).`);
  }
  return parsed;
}
