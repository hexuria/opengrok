import type { Windows365TokenProvider } from "./windows365-token.js";

export class Windows365UnavailableError extends Error {
  constructor(message: string) { super(message); this.name = "Windows365UnavailableError"; }
}
export class Windows365NotReadyError extends Windows365UnavailableError {
  constructor(status: string) {
    super(`The Windows 365 Cloud PC is not ready yet (status ${status}).`);
    this.name = "Windows365NotReadyError";
  }
}
export class Windows365AuthError extends Windows365UnavailableError {
  constructor(message: string) { super(message); this.name = "Windows365AuthError"; }
}
export class Windows365PoolEmptyError extends Windows365UnavailableError {
  constructor() {
    super("The Windows 365 pool has no Cloud PC available.");
    this.name = "Windows365PoolEmptyError";
  }
}

export interface Windows365Checkout {
  readonly sessionId: string;
  readonly status: string;
  readonly computerUrl: string;
  readonly computerId: string;
  readonly screenshareUrl?: string;
  readonly seeUrl?: string;
}

export interface Windows365DeviceStatus {
  readonly status: string;
}

export interface Windows365McpResult {
  readonly jsonrpc?: string;
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

export interface Windows365ClientOptions {
  readonly sessionBaseUrl: string;
  readonly poolId: string;
  readonly tokens: Windows365TokenProvider;
  readonly fetchImpl?: typeof fetch;
  readonly checkoutTimeoutMs?: number;
  readonly deviceTimeoutMs?: number;
}

export interface Windows365Client {
  checkout(input: { readonly userObjectId: string; readonly sessionId: string }): Promise<Windows365Checkout>;
  checkin(sessionId: string): Promise<void>;
  status(computerUrl: string, computerId: string): Promise<Windows365DeviceStatus>;
  waitUntilReady(computerUrl: string, computerId: string, options?: { readonly timeoutMs?: number; readonly intervalMs?: number }): Promise<Windows365DeviceStatus>;
  mcp(computerUrl: string, computerId: string, method: string, params?: Record<string, unknown>, options?: { readonly notification?: boolean; readonly timeoutMs?: number }): Promise<Windows365McpResult | undefined>;
  screenshare(computerUrl: string, computerId: string, action: "Start" | "Stop" | "TakeControl" | "ReleaseControl"): Promise<{ readonly seeUrl?: string; readonly ok?: boolean; readonly error?: string }>;
}

function computerIdFromUrl(computerUrl: string, fallback?: string): string {
  if (fallback != null && fallback.length > 0) return fallback;
  const match = computerUrl.match(/\/computers\/([^/?#]+)/);
  if (match?.[1] == null) throw new Windows365UnavailableError("Windows 365 checkout did not return a computer id.");
  return match[1];
}

function deviceBase(computerUrl: string): string {
  const url = new URL(computerUrl);
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

export function createWindows365Client(options: Windows365ClientOptions): Windows365Client {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sessionBase = options.sessionBaseUrl.replace(/\/$/, "");
  const checkoutTimeoutMs = options.checkoutTimeoutMs ?? 35_000;
  const deviceTimeoutMs = options.deviceTimeoutMs ?? 35_000;
  let nextMcpId = 1;

  async function authorizedHeaders(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await options.tokens.getToken()}` };
  }

  async function readJson(response: Response): Promise<Record<string, unknown> | null> {
    return await response.json().catch(() => null) as Record<string, unknown> | null;
  }

  function throwForSession(status: number, body: Record<string, unknown> | null): never {
    const detail = typeof body?.error === "string" ? body.error : typeof body?.message === "string" ? body.message : `HTTP ${status}`;
    if (status === 401 || status === 403) throw new Windows365AuthError(`Windows 365 refused the request (${detail}).`);
    if (status === 409 || /no .*available|pool.*(empty|exhausted)/i.test(detail)) throw new Windows365PoolEmptyError();
    throw new Windows365UnavailableError(`Windows 365 checkout failed: ${detail}`);
  }

  return {
    async checkout(input) {
      const headers = { ...(await authorizedHeaders()), "user-object-id": input.userObjectId, "x-ms-sessionId": input.sessionId };
      let response: Response;
      try {
        response = await fetchImpl(`${sessionBase}/api/pools/${encodeURIComponent(options.poolId)}/sessions?api-version=2.0`, {
          method: "POST",
          headers,
          signal: AbortSignal.timeout(checkoutTimeoutMs),
        });
      } catch (error) {
        throw new Windows365UnavailableError(`Windows 365 checkout could not be reached (${error instanceof Error ? error.message : String(error)}).`);
      }
      const body = await readJson(response);
      if (!response.ok) throwForSession(response.status, body);
      const computerUrl = typeof body?.computerUrl === "string" ? body.computerUrl : "";
      if (computerUrl.length === 0) throw new Windows365UnavailableError("Windows 365 checkout returned no computerUrl.");
      const sessionId = typeof body?.sessionId === "string" ? body.sessionId : input.sessionId;
      return {
        sessionId,
        status: typeof body?.status === "string" ? body.status : "Succeeded",
        computerUrl,
        computerId: computerIdFromUrl(computerUrl, typeof body?.computerId === "string" ? body.computerId : undefined),
        ...(typeof body?.screenshareUrl === "string" ? { screenshareUrl: body.screenshareUrl } : {}),
      };
    },

    async checkin(sessionId) {
      const headers = { ...(await authorizedHeaders()), "x-ms-sessionId": sessionId };
      let response: Response;
      try {
        response = await fetchImpl(`${sessionBase}/api/sessions/${encodeURIComponent(sessionId)}?api-version=2.0`, {
          method: "DELETE",
          headers,
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        throw new Windows365UnavailableError(`Windows 365 checkin could not be reached (${error instanceof Error ? error.message : String(error)}).`);
      }
      if (response.status === 404 || response.status === 204) return;
      if (!response.ok) {
        const body = await readJson(response);
        if (response.status === 401 || response.status === 403) throw new Windows365AuthError(`Windows 365 refused checkin (${typeof body?.error === "string" ? body.error : `HTTP ${response.status}`}).`);
        throw new Windows365UnavailableError(`Windows 365 checkin failed (HTTP ${response.status}).`);
      }
    },

    async status(computerUrl, computerId) {
      const headers = { ...(await authorizedHeaders()), "x-ms-computerId": computerId };
      let response: Response;
      try {
        response = await fetchImpl(`${deviceBase(computerUrl)}/status?api-version=1.0`, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(deviceTimeoutMs),
        });
      } catch (error) {
        throw new Windows365UnavailableError(`Windows 365 status could not be reached (${error instanceof Error ? error.message : String(error)}).`);
      }
      const body = await readJson(response);
      if (response.status === 503) throw new Windows365NotReadyError(typeof body?.status === "string" ? body.status : "Waiting");
      if (response.status === 401 || response.status === 403) throw new Windows365AuthError("Windows 365 refused the status request.");
      if (!response.ok) throw new Windows365UnavailableError(`Windows 365 status failed (HTTP ${response.status}).`);
      return {
        status: typeof body?.status === "string" ? body.status : typeof body?.state === "string" ? body.state : "Waiting",
      };
    },

    async waitUntilReady(computerUrl, computerId, wait) {
      const timeoutMs = wait?.timeoutMs ?? 300_000;
      const intervalMs = wait?.intervalMs ?? 2_500;
      const deadline = Date.now() + timeoutMs;
      let last = "Waiting";
      while (Date.now() < deadline) {
        try {
          const current = await this.status(computerUrl, computerId);
          last = current.status;
          if (current.status === "Ready") return current;
        } catch (error) {
          if (error instanceof Windows365AuthError) throw error;
          if (error instanceof Windows365NotReadyError || error instanceof Windows365UnavailableError) last = "Waiting";
          else throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
      throw new Windows365NotReadyError(last);
    },

    async mcp(computerUrl, computerId, method, params, mcpOptions) {
      const headers = { ...(await authorizedHeaders()), "x-ms-computerId": computerId, "content-type": "application/json" };
      const notification = mcpOptions?.notification === true;
      const message: Record<string, unknown> = { jsonrpc: "2.0", method };
      if (!notification) message.id = nextMcpId++;
      if (params != null) message.params = params;
      let response: Response;
      try {
        response = await fetchImpl(`${deviceBase(computerUrl)}/mcp?api-version=1.0`, {
          method: "POST",
          headers,
          body: JSON.stringify(message),
          signal: AbortSignal.timeout(mcpOptions?.timeoutMs ?? deviceTimeoutMs),
        });
      } catch (error) {
        throw new Windows365UnavailableError(`Windows 365 MCP could not be reached (${error instanceof Error ? error.message : String(error)}).`);
      }
      if (notification) return undefined;
      if (response.status === 503) throw new Windows365NotReadyError("Waiting");
      if (response.status === 401 || response.status === 403) throw new Windows365AuthError("Windows 365 refused the MCP request.");
      const body = await response.json().catch(() => null) as Windows365McpResult | null;
      if (!response.ok) throw new Windows365UnavailableError(`Windows 365 MCP failed (HTTP ${response.status}).`);
      if (body?.error != null) throw new Windows365UnavailableError(body.error.message ?? `Windows 365 MCP error ${body.error.code ?? ""}`.trim());
      return body ?? {};
    },

    async screenshare(computerUrl, computerId, action) {
      const headers = { ...(await authorizedHeaders()), "x-ms-computerId": computerId };
      let response: Response;
      try {
        response = await fetchImpl(`${deviceBase(computerUrl)}/screenshare?screenshareAction=${encodeURIComponent(action)}&api-version=1.0`, {
          method: "POST",
          headers,
          signal: AbortSignal.timeout(deviceTimeoutMs),
        });
      } catch (error) {
        throw new Windows365UnavailableError(`Windows 365 screenshare could not be reached (${error instanceof Error ? error.message : String(error)}).`);
      }
      const body = await readJson(response);
      if (response.status === 503) throw new Windows365NotReadyError("Waiting");
      if (response.status === 401 || response.status === 403) throw new Windows365AuthError("Windows 365 refused the screenshare request.");
      if (!response.ok) throw new Windows365UnavailableError(`Windows 365 screenshare ${action} failed (HTTP ${response.status}).`);
      return {
        ...(typeof body?.seeUrl === "string" ? { seeUrl: body.seeUrl } : {}),
        ...(typeof body?.ok === "boolean" ? { ok: body.ok } : {}),
        ...(typeof body?.error === "string" ? { error: body.error } : {}),
      };
    },
  };
}
