import type { IncomingMessage, ServerResponse } from "node:http";
import { MOCK_JWT_EMAIL, MOCK_JWT_SUBJECT } from "./constants.js";
import type { MockProfile } from "./dashboard-handlers.js";
import { createMockTokenPair } from "./jwt.js";

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": payload.byteLength,
  });
  response.end(payload);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function tokensFor(profile: MockProfile, email?: string): { accessToken: string; refreshToken: string } {
  if (email != null && email.length > 0) profile.email = email;
  return createMockTokenPair({ email: profile.email, sub: profile.sub });
}

/**
 * Raw HTTP auth endpoints the reconstructed login path already calls.
 * Prefer `devLogin` + `SAND_BACKEND_URL` over a second auth system.
 */
export function tryHandleAuthHttp(
  request: IncomingMessage,
  response: ServerResponse,
  profile: MockProfile,
): boolean {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;

  if (path === "/healthz") {
    sendJson(response, 200, { ok: true, mock: true });
    return true;
  }

  if (path === "/auth/cursor_dev_session_token") {
    const email = url.searchParams.get("email") ?? profile.email;
    const pair = tokensFor(profile, email);
    sendJson(response, 200, pair);
    return true;
  }

  if (path === "/auth/poll") {
    const pair = tokensFor(profile, url.searchParams.get("email") ?? undefined);
    sendJson(response, 200, pair);
    return true;
  }

  if (path === "/oauth/token" && (request.method === "POST" || request.method === "PUT")) {
    void readJsonBody(request).then((body) => {
      const email = typeof body.email === "string" ? body.email : profile.email;
      const pair = tokensFor(profile, email);
      sendJson(response, 200, {
        access_token: pair.accessToken,
        refresh_token: pair.refreshToken,
      });
    }).catch(() => {
      sendJson(response, 500, { error: "mock oauth token failed" });
    });
    return true;
  }

  if (path === "/" && request.method === "GET") {
    sendJson(response, 200, {
      service: "grok-bot-mock",
      subject: MOCK_JWT_SUBJECT,
      email: MOCK_JWT_EMAIL,
      hint: "Set SAND_BACKEND_URL to this origin and call AuthServicePort.devLogin.",
    });
    return true;
  }

  return false;
}
