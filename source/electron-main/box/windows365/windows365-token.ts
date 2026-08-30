export type Windows365TokenSource =
  | { readonly kind: "client-secret"; readonly secret: string }
  | { readonly kind: "client-secret-file"; readonly path: string }
  | { readonly kind: "federated"; readonly tokenFile: string };

export interface Windows365TokenOptions {
  readonly tenantId: string;
  readonly clientId: string;
  readonly source: Windows365TokenSource;
  readonly scope: string;
  readonly fetchImpl?: typeof fetch;
  readonly readFile?: (path: string) => Promise<string>;
  readonly now?: () => number;
}

export interface Windows365TokenProvider {
  getToken(): Promise<string>;
}

const DEFAULT_SCOPE = "api://W365Agents-Prod/.default";

export function defaultWindows365TokenScope(): string {
  return DEFAULT_SCOPE;
}

export function createWindows365TokenProvider(options: Windows365TokenOptions): Windows365TokenProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const readFile = options.readFile ?? (async (path: string) => {
    const { readFile: read } = await import("node:fs/promises");
    return read(path, "utf8");
  });
  const now = options.now ?? Date.now;
  let cached: { token: string; expiresAtMs: number } | undefined;

  async function mint(): Promise<{ token: string; expiresAtMs: number }> {
    const body = new URLSearchParams({
      client_id: options.clientId,
      scope: options.scope,
      grant_type: "client_credentials",
    });
    if (options.source.kind === "client-secret") {
      body.set("client_secret", options.source.secret);
    } else if (options.source.kind === "client-secret-file") {
      const secret = (await readFile(options.source.path)).trim();
      if (secret.length === 0) throw new Error("Windows 365 client secret file is empty.");
      body.set("client_secret", secret);
    } else {
      const assertion = (await readFile(options.source.tokenFile)).trim();
      if (assertion.length === 0) throw new Error("Windows 365 federated credential file is empty.");
      body.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
      body.set("client_assertion", assertion);
    }
    let response: Response;
    try {
      response = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(options.tenantId)}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new Error(`Windows 365 token request failed (${error instanceof Error ? error.message : String(error)}).`);
    }
    const payload = await response.json().catch(() => null) as { access_token?: string; expires_in?: number; error?: string; error_description?: string } | null;
    if (!response.ok || payload?.access_token == null) {
      throw new Error(`Windows 365 authentication failed: ${payload?.error_description ?? payload?.error ?? `HTTP ${response.status}`}.`);
    }
    const lifetimeMs = Math.max(30, Number(payload.expires_in) || 3600) * 1_000;
    return { token: payload.access_token, expiresAtMs: now() + lifetimeMs - 60_000 };
  }

  return {
    async getToken() {
      if (cached != null && cached.expiresAtMs > now()) return cached.token;
      cached = await mint();
      return cached.token;
    },
  };
}
