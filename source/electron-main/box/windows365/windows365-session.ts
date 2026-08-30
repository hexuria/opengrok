import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  createWindows365Client,
  Windows365AuthError,
  Windows365UnavailableError,
  type Windows365Checkout,
  type Windows365Client,
} from "./windows365-client.js";
import {
  readWindows365Credentials,
  windows365CredentialsAreComplete,
  type Windows365Credentials,
} from "./windows365-credentials.js";
import { createWindows365TokenProvider } from "./windows365-token.js";

export interface StoredWindows365Session {
  readonly sessionId: string;
  readonly computerId: string;
  readonly computerUrl: string;
  readonly screenshareUrl?: string;
  readonly seeUrl?: string;
  readonly status: string;
  readonly checkedOutAtMs: number;
}

export interface Windows365LiveSession extends StoredWindows365Session {
  readonly phase: "idle" | "checking-out" | "ready" | "error";
  readonly detail: string;
  readonly configured: boolean;
}

export function sessionFilePath(settingsPath: string): string {
  return join(dirname(settingsPath), "windows365-session.json");
}

export function shouldReuseWindows365Session(
  session: StoredWindows365Session | null,
  reuseSession: boolean,
): boolean {
  return reuseSession && session != null && session.computerUrl.length > 0 && session.computerId.length > 0 && session.sessionId.length > 0;
}

export async function readStoredWindows365Session(settingsPath: string): Promise<StoredWindows365Session | null> {
  try {
    const parsed = JSON.parse(await readFile(sessionFilePath(settingsPath), "utf8")) as Record<string, unknown>;
    if (typeof parsed.sessionId !== "string" || typeof parsed.computerId !== "string" || typeof parsed.computerUrl !== "string") return null;
    return {
      sessionId: parsed.sessionId,
      computerId: parsed.computerId,
      computerUrl: parsed.computerUrl,
      ...(typeof parsed.screenshareUrl === "string" ? { screenshareUrl: parsed.screenshareUrl } : {}),
      ...(typeof parsed.seeUrl === "string" ? { seeUrl: parsed.seeUrl } : {}),
      status: typeof parsed.status === "string" ? parsed.status : "Unknown",
      checkedOutAtMs: typeof parsed.checkedOutAtMs === "number" ? parsed.checkedOutAtMs : 0,
    };
  } catch {
    return null;
  }
}

async function writeStoredWindows365Session(settingsPath: string, session: StoredWindows365Session): Promise<void> {
  const target = sessionFilePath(settingsPath);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

async function clearStoredWindows365Session(settingsPath: string): Promise<void> {
  await rm(sessionFilePath(settingsPath), { force: true });
}

function clientFor(credentials: Windows365Credentials, fetchImpl?: typeof fetch): Windows365Client {
  return createWindows365Client({
    sessionBaseUrl: credentials.sessionBaseUrl,
    poolId: credentials.poolId,
    tokens: createWindows365TokenProvider({
      tenantId: credentials.tenantId,
      clientId: credentials.clientId,
      source: { kind: "client-secret", secret: credentials.clientSecret },
      scope: credentials.tokenScope,
      ...(fetchImpl == null ? {} : { fetchImpl }),
    }),
    ...(fetchImpl == null ? {} : { fetchImpl }),
  });
}

async function attachScreenshare(
  client: Windows365Client,
  checkout: Pick<Windows365Checkout, "sessionId" | "computerId" | "computerUrl" | "screenshareUrl" | "seeUrl">,
): Promise<StoredWindows365Session> {
  let seeUrl = checkout.seeUrl;
  const screenshareUrl = checkout.screenshareUrl;
  try {
    const started = await client.screenshare(checkout.computerUrl, checkout.computerId, "Start");
    if (started.seeUrl != null) seeUrl = started.seeUrl;
  } catch {
    // Screenshare Start is best-effort; checkout still stands.
  }
  return {
    sessionId: checkout.sessionId,
    computerId: checkout.computerId,
    computerUrl: checkout.computerUrl,
    ...(screenshareUrl == null ? {} : { screenshareUrl }),
    ...(seeUrl == null ? {} : { seeUrl }),
    status: "Ready",
    checkedOutAtMs: Date.now(),
  };
}

export async function describeWindows365Session(settingsPath: string, fetchImpl?: typeof fetch): Promise<Windows365LiveSession> {
  const credentials = await readWindows365Credentials(settingsPath);
  const stored = await readStoredWindows365Session(settingsPath);
  if (!windows365CredentialsAreComplete(credentials)) {
    return {
      sessionId: "",
      computerId: "",
      computerUrl: "",
      status: "unconfigured",
      checkedOutAtMs: 0,
      phase: "idle",
      detail: "Add Windows 365 for Agents credentials under Settings → Router → Computer.",
      configured: false,
    };
  }
  if (!shouldReuseWindows365Session(stored, credentials.reuseSession) || stored == null) {
    return {
      sessionId: credentials.accountSessionId,
      computerId: "",
      computerUrl: "",
      status: "idle",
      checkedOutAtMs: 0,
      phase: "idle",
      detail: "This account can check out a Cloud PC from your pool. Every Grok Bot shares that machine until you check it in.",
      configured: true,
    };
  }
  try {
    const client = clientFor(credentials, fetchImpl);
    const current = await client.status(stored.computerUrl, stored.computerId);
    if (current.status === "Ready") {
      return { ...stored, status: current.status, phase: "ready", detail: "Cloud PC is ready. This account keeps the same machine until you check it in.", configured: true };
    }
    return { ...stored, status: current.status, phase: "checking-out", detail: `Cloud PC status: ${current.status}.`, configured: true };
  } catch (error) {
    if (error instanceof Windows365AuthError) {
      return { ...stored, phase: "error", detail: error.message, configured: true };
    }
    return {
      sessionId: credentials.accountSessionId,
      computerId: "",
      computerUrl: "",
      status: "idle",
      checkedOutAtMs: stored.checkedOutAtMs,
      phase: "idle",
      detail: "The previous Cloud PC session is gone. Connect again to check out a machine.",
      configured: true,
    };
  }
}

export async function ensureWindows365Session(settingsPath: string, fetchImpl?: typeof fetch): Promise<Windows365LiveSession> {
  const credentials = await readWindows365Credentials(settingsPath);
  if (!windows365CredentialsAreComplete(credentials)) {
    throw new Windows365UnavailableError("Windows 365 is not configured. Add tenant, app, pool, secret, and Entra user id under Settings → Router → Computer.");
  }
  const client = clientFor(credentials, fetchImpl);
  const stored = await readStoredWindows365Session(settingsPath);
  if (shouldReuseWindows365Session(stored, credentials.reuseSession) && stored != null) {
    try {
      const current = await client.status(stored.computerUrl, stored.computerId);
      if (current.status === "Ready") {
        const live = stored.seeUrl == null ? await attachScreenshare(client, stored) : stored;
        if (live !== stored) await writeStoredWindows365Session(settingsPath, live);
        return { ...live, status: "Ready", phase: "ready", detail: "Reusing this account's Cloud PC.", configured: true };
      }
    } catch (error) {
      if (error instanceof Windows365AuthError) throw error;
    }
  }
  const checkout = await client.checkout({
    userObjectId: credentials.userObjectId,
    sessionId: credentials.accountSessionId,
  });
  await client.waitUntilReady(checkout.computerUrl, checkout.computerId, { timeoutMs: 180_000, intervalMs: 2_500 });
  const live = await attachScreenshare(client, checkout);
  await writeStoredWindows365Session(settingsPath, live);
  return { ...live, phase: "ready", detail: "Cloud PC checked out. This account will reuse it until you check it in.", configured: true };
}

export async function checkinWindows365Session(settingsPath: string, fetchImpl?: typeof fetch): Promise<Windows365LiveSession> {
  const credentials = await readWindows365Credentials(settingsPath);
  const stored = await readStoredWindows365Session(settingsPath);
  if (stored != null && windows365CredentialsAreComplete(credentials)) {
    try {
      await clientFor(credentials, fetchImpl).checkin(stored.sessionId);
    } catch (error) {
      if (!(error instanceof Windows365UnavailableError)) throw error;
    }
  }
  await clearStoredWindows365Session(settingsPath);
  return await describeWindows365Session(settingsPath, fetchImpl);
}

export async function resetWindows365Session(settingsPath: string, fetchImpl?: typeof fetch): Promise<Windows365LiveSession> {
  await checkinWindows365Session(settingsPath, fetchImpl);
  return await ensureWindows365Session(settingsPath, fetchImpl);
}

export async function testWindows365Credentials(settingsPath: string, fetchImpl?: typeof fetch): Promise<{ readonly ok: boolean; readonly detail: string }> {
  const credentials = await readWindows365Credentials(settingsPath);
  if (!windows365CredentialsAreComplete(credentials)) {
    return { ok: false, detail: "Fill in tenant, client, secret, pool, session URL, and Entra user object id." };
  }
  try {
    await createWindows365TokenProvider({
      tenantId: credentials.tenantId,
      clientId: credentials.clientId,
      source: { kind: "client-secret", secret: credentials.clientSecret },
      scope: credentials.tokenScope,
      ...(fetchImpl == null ? {} : { fetchImpl }),
    }).getToken();
    return { ok: true, detail: "Microsoft signed the app in. Connect from the computer pane to check out a Cloud PC." };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
