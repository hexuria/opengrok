import type { IncomingMessage, ServerResponse } from "node:http";
import type { MockGrokBotStore } from "./store.js";

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": payload.byteLength,
  });
  response.end(payload);
}

async function drainBody(request: IncomingMessage): Promise<void> {
  for await (const _chunk of request) {
    // Mock teach helpers accept GET or POST; the body is unused.
  }
}

function teachPath(pathname: string): "start" | "stop" | undefined {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  if (normalized === "/mock/teach/start") return "start";
  if (normalized === "/mock/teach/stop") return "stop";
  return undefined;
}

/**
 * Mock-only Teach-a-task helpers. GrokBotService has no Teach RPC
 * (recovered 30 + ported 46). Barok can call these instead of /api/teach.
 */
export function tryHandleTeachHttp(
  request: IncomingMessage,
  response: ServerResponse,
  store: MockGrokBotStore,
): boolean {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const action = teachPath(url.pathname);
  if (action == null) return false;

  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "POST") {
    response.writeHead(405, { allow: "GET, POST" });
    response.end();
    return true;
  }

  const apply = (): void => {
    sendJson(response, 200, store.setTeachRecording(action === "start"));
  };

  if (method === "POST") {
    void drainBody(request).then(apply).catch(() => {
      sendJson(response, 500, { error: "mock teach failed" });
    });
    return true;
  }

  apply();
  return true;
}
