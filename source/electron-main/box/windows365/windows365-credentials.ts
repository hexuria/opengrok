import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const DEFAULT_WINDOWS365_SESSION_BASE_URL = "https://windows365.microsoft.com";
export const DEFAULT_WINDOWS365_TOKEN_SCOPE = "api://W365Agents-Prod/.default";

export interface Windows365Credentials {
  readonly sessionBaseUrl: string;
  readonly poolId: string;
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly userObjectId: string;
  readonly reuseSession: boolean;
  readonly tokenScope: string;
  readonly accountSessionId: string;
}

export interface Windows365PublicSettings {
  readonly sessionBaseUrl: string;
  readonly poolId: string;
  readonly tenantId: string;
  readonly clientId: string;
  readonly userObjectId: string;
  readonly reuseSession: boolean;
  readonly tokenScope: string;
  readonly hasClientSecret: boolean;
  readonly configured: boolean;
}

export interface Windows365CredentialsPatch {
  readonly sessionBaseUrl?: string;
  readonly poolId?: string;
  readonly tenantId?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly userObjectId?: string;
  readonly reuseSession?: boolean;
  readonly tokenScope?: string;
}

function credentialsPath(settingsPath: string): string {
  return join(dirname(settingsPath), "windows365-credentials.json");
}

function emptyCredentials(): Windows365Credentials {
  return {
    sessionBaseUrl: DEFAULT_WINDOWS365_SESSION_BASE_URL,
    poolId: "",
    tenantId: "",
    clientId: "",
    clientSecret: "",
    userObjectId: "",
    reuseSession: true,
    tokenScope: DEFAULT_WINDOWS365_TOKEN_SCOPE,
    accountSessionId: randomUUID(),
  };
}

function trim(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

export function windows365CredentialsAreComplete(credentials: Windows365Credentials): boolean {
  return credentials.sessionBaseUrl.length > 0
    && credentials.poolId.length > 0
    && credentials.tenantId.length > 0
    && credentials.clientId.length > 0
    && credentials.clientSecret.length > 0
    && credentials.userObjectId.length > 0;
}

export function toWindows365PublicSettings(credentials: Windows365Credentials): Windows365PublicSettings {
  return {
    sessionBaseUrl: credentials.sessionBaseUrl,
    poolId: credentials.poolId,
    tenantId: credentials.tenantId,
    clientId: credentials.clientId,
    userObjectId: credentials.userObjectId,
    reuseSession: credentials.reuseSession,
    tokenScope: credentials.tokenScope,
    hasClientSecret: credentials.clientSecret.length > 0,
    configured: windows365CredentialsAreComplete(credentials),
  };
}

export async function readWindows365Credentials(settingsPath: string): Promise<Windows365Credentials> {
  try {
    const parsed = JSON.parse(await readFile(credentialsPath(settingsPath), "utf8")) as Record<string, unknown>;
    const base = emptyCredentials();
    const accountSessionId = trim(parsed.accountSessionId);
    return {
      sessionBaseUrl: trim(parsed.sessionBaseUrl, base.sessionBaseUrl) || base.sessionBaseUrl,
      poolId: trim(parsed.poolId),
      tenantId: trim(parsed.tenantId),
      clientId: trim(parsed.clientId),
      clientSecret: typeof parsed.clientSecret === "string" ? parsed.clientSecret : "",
      userObjectId: trim(parsed.userObjectId),
      reuseSession: parsed.reuseSession !== false,
      tokenScope: trim(parsed.tokenScope, base.tokenScope) || base.tokenScope,
      accountSessionId: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(accountSessionId) ? accountSessionId : base.accountSessionId,
    };
  } catch {
    return emptyCredentials();
  }
}

export async function writeWindows365Credentials(settingsPath: string, patch: Windows365CredentialsPatch): Promise<Windows365Credentials> {
  const current = await readWindows365Credentials(settingsPath);
  const next: Windows365Credentials = {
    sessionBaseUrl: patch.sessionBaseUrl != null ? (trim(patch.sessionBaseUrl) || DEFAULT_WINDOWS365_SESSION_BASE_URL) : current.sessionBaseUrl,
    poolId: patch.poolId != null ? trim(patch.poolId) : current.poolId,
    tenantId: patch.tenantId != null ? trim(patch.tenantId) : current.tenantId,
    clientId: patch.clientId != null ? trim(patch.clientId) : current.clientId,
    clientSecret: patch.clientSecret != null && patch.clientSecret.length > 0 ? patch.clientSecret : current.clientSecret,
    userObjectId: patch.userObjectId != null ? trim(patch.userObjectId) : current.userObjectId,
    reuseSession: patch.reuseSession ?? current.reuseSession,
    tokenScope: patch.tokenScope != null ? (trim(patch.tokenScope) || DEFAULT_WINDOWS365_TOKEN_SCOPE) : current.tokenScope,
    accountSessionId: current.accountSessionId,
  };
  const target = credentialsPath(settingsPath);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
  await chmod(target, 0o600);
  return next;
}
