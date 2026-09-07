import type { IncomingMessage, ServerResponse } from "node:http";
import { MockOpenGrokAccount } from "./opengrok-account.js";
import type { MockGrokBotStore } from "./store.js";

/*
 * The account API's HTTP face. Tried before the Connect adapter, the same way
 * the auth and teach helpers are, because these paths are plain JSON and not
 * RPC at all.
 *
 * Auth is deliberately permissive: the real server only asks that you are
 * signed in (`account_from_bearer`), and the desktop sends whatever account
 * token it holds. Any non-empty bearer passes here. Sending none does NOT, so
 * the signed-out path stays reachable — that is a real client branch and it
 * would never be exercised if the mock let everyone through.
 */

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, { "content-type": "application/json", "content-length": payload.byteLength });
  response.end(payload);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed === "object" && parsed != null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function bearer(request: IncomingMessage): string {
  const header = request.headers.authorization;
  if (typeof header !== "string") return "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? "";
}

/*
 * The account routes this mock answers; anything else falls through to Connect.
 *
 * Three separate members, not `{ kind: "models" | "coworkers" }` — a union in
 * the discriminant's own type is not a discriminated union, and narrowing it
 * cannot exclude the member, so the id below stops being reachable.
 */
type AccountRoute =
  | { readonly kind: "models" }
  | { readonly kind: "coworkers" }
  | { readonly kind: "coworker"; readonly id: string };

function accountRoute(pathname: string): AccountRoute | null {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  if (normalized === "/models") return { kind: "models" };
  if (normalized === "/coworkers") return { kind: "coworkers" };
  const coworker = /^\/coworkers\/([^/]+)$/.exec(normalized);
  if (coworker?.[1] != null) return { kind: "coworker", id: decodeURIComponent(coworker[1]) };
  return null;
}

export interface OpenGrokAccountHttpOptions {
  readonly store: MockGrokBotStore;
  readonly account: MockOpenGrokAccount;
}

/**
 * Serve `/models`, `/coworkers` and `PATCH /coworkers/{id}`.
 *
 * The coworker rows are read from the mock store rather than invented, so the
 * ids match the agents the app is already showing and the picker opens on a
 * real pin instead of an empty box.
 */
export function tryHandleOpenGrokAccountHttp(
  request: IncomingMessage,
  response: ServerResponse,
  options: OpenGrokAccountHttpOptions,
): boolean {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const route = accountRoute(url.pathname);
  if (route == null) return false;

  if (bearer(request).length === 0) {
    sendJson(response, 401, { error: "sign in first" });
    return true;
  }

  const method = request.method ?? "GET";
  const agents = options.store.listAgents().map((agent) => ({ id: agent.id, name: agent.name }));

  if (route.kind === "models") {
    if (method !== "GET") {
      response.writeHead(405, { allow: "GET" });
      response.end();
      return true;
    }
    sendJson(response, 200, options.account.catalogue());
    return true;
  }

  if (route.kind === "coworkers") {
    if (method !== "GET") {
      response.writeHead(405, { allow: "GET" });
      response.end();
      return true;
    }
    sendJson(response, 200, options.account.coworkers(agents));
    return true;
  }

  if (method !== "PATCH") {
    response.writeHead(405, { allow: "PATCH" });
    response.end();
    return true;
  }
  void readJsonBody(request).then((body) => {
    const model = body.model;
    if (typeof model !== "string" || model.length === 0) {
      sendJson(response, 400, { error: "a pin needs a model" });
      return;
    }
    const known = agents.some((agent) => agent.id === route.id);
    if (!known) {
      sendJson(response, 404, { error: `no coworker ${route.id}` });
      return;
    }
    sendJson(response, 200, options.account.pin(route.id, model));
  }).catch(() => {
    sendJson(response, 500, { error: "mock pin failed" });
  });
  return true;
}
