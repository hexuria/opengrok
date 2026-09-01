import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const MDM_SIGN_IN_POLICY_HEADER_NAME = "x-cursor-mdm-signin-policy";
export const SIGN_IN_POLICY_VIOLATION_ERROR = "sign_in_policy_violation";
export const SIGN_IN_POLICY_VIOLATION_MESSAGE = "Sign-in on this device is restricted by your organization's device policy. Sign in with an allowed account to continue.";
export const MACOS_POLICY_DOMAINS = ["com.todesktop.230313mzl4w4u92", "co.anysphere.cursor.dev"] as const;
export const WINDOWS_POLICY_REGISTRY_KEYS = ["HKLM\\SOFTWARE\\Policies\\Cursor\\Cursor", "HKLM\\SOFTWARE\\Policies\\Microsoft\\Cursor", "HKLM\\SOFTWARE\\Policies\\Cursor\\Cursor Dev"] as const;
export const POLICY_CACHE_TTL_MS = 30_000;

export class SignInPolicyViolationError extends Error {
  constructor() { super(SIGN_IN_POLICY_VIOLATION_MESSAGE); this.name = "SignInPolicyViolationError"; }
}

type RawPolicy = Record<string, unknown>;

function parseCsvStrings(raw: unknown): string[] {
  return (raw == null ? "" : String(raw)).split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}
function parseNumericIds(raw: unknown): number[] {
  return [...new Set(parseCsvStrings(raw).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
}
function parseOrganizationIds(raw: unknown): string[] {
  return [...new Set(parseCsvStrings(raw).filter((entry) => /^\d+$/.test(entry)).map((entry) => BigInt(entry).toString()).filter((entry) => entry !== "0"))];
}
function normalizeAllowedLoginDomain(raw: string): string | undefined {
  let domain = raw.trim().toLowerCase();
  if (domain.startsWith("@")) domain = domain.slice(1);
  return domain.length === 0 || domain.includes("@") || /\s/.test(domain) ? undefined : domain;
}
function parseEnforced(raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw === 1;
  return typeof raw === "string" && ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}
export function buildMdmSignInPolicyHeaderValue(raw: RawPolicy): string | undefined {
  const enforced = parseEnforced(raw.SignInEnforcement);
  const allowedOrganizationIds = parseOrganizationIds(raw.AllowedOrganizationIds);
  const allowedTeamIds = [...new Set([...parseNumericIds(raw.AllowedTeamIds), ...parseNumericIds(raw.AllowedTeamId)])];
  const allowedLoginEmails = [...new Set(parseCsvStrings(raw.AllowedLoginEmails).map((email) => email.toLowerCase()).filter((email) => email.includes("@")))];
  const allowedLoginDomains = [...new Set(parseCsvStrings(raw.AllowedLoginDomains).map(normalizeAllowedLoginDomain).filter((domain): domain is string => domain !== undefined))];
  if (!enforced && allowedOrganizationIds.length === 0 && allowedTeamIds.length === 0 && allowedLoginEmails.length === 0 && allowedLoginDomains.length === 0) return undefined;
  return `v1.${Buffer.from(JSON.stringify({ enforced, allowedOrganizationIds, allowedTeamIds: allowedTeamIds.map(String), allowedLoginEmails, allowedLoginDomains }), "utf-8").toString("base64url")}`;
}
function pickPolicyValues(source: RawPolicy): RawPolicy | undefined {
  const keys = ["SignInEnforcement", "AllowedOrganizationIds", "AllowedTeamIds", "AllowedTeamId", "AllowedLoginEmails", "AllowedLoginDomains"] as const;
  const picked: RawPolicy = {};
  let found = false;
  for (const key of keys) if (source[key] !== undefined) { picked[key] = source[key]; found = true; }
  return found ? picked : undefined;
}
async function readMacosManagedPreferences(): Promise<RawPolicy | undefined> {
  const paths: string[] = [];
  for (const domain of MACOS_POLICY_DOMAINS) paths.push(join("/Library/Managed Preferences", userInfo().username, `${domain}.plist`), join("/Library/Managed Preferences", `${domain}.plist`));
  let fallback: RawPolicy | undefined;
  for (const policyPath of paths) {
    try { await fs.access(policyPath); } catch { continue; }
    try {
      const { stdout } = await execFileAsync("plutil", ["-convert", "json", "-o", "-", policyPath]);
      const values = pickPolicyValues(JSON.parse(stdout) as RawPolicy);
      if (values !== undefined) { if (buildMdmSignInPolicyHeaderValue(values) !== undefined) return values; fallback ??= values; }
    } catch { /* managed policy is optional */ }
  }
  return fallback;
}
async function readWindowsPolicyRegistry(): Promise<RawPolicy | undefined> {
  let fallback: RawPolicy | undefined;
  for (const registryKey of WINDOWS_POLICY_REGISTRY_KEYS) {
    let stdout: string;
    try { ({ stdout } = await execFileAsync("reg.exe", ["query", registryKey], { windowsHide: true })); } catch { continue; }
    const values: RawPolicy = {};
    for (const line of stdout.split(/\r?\n/)) {
      const match = /^\s{4}(\S+)\s+(REG_\w+)\s+(.*)$/.exec(line);
      if (match == null) continue;
      const [, name, type, rawValue] = match;
      values[name!] = type === "REG_DWORD" ? Number.parseInt(rawValue!.trim(), 16) : rawValue!.trim();
    }
    const picked = pickPolicyValues(values);
    if (picked !== undefined) { if (buildMdmSignInPolicyHeaderValue(picked) !== undefined) return picked; fallback ??= picked; }
  }
  return fallback;
}
async function readLinuxPolicyFile(): Promise<RawPolicy | undefined> {
  try { return pickPolicyValues(JSON.parse(await fs.readFile(join(homedir(), ".cursor", "policy.json"), "utf-8")) as RawPolicy); } catch { return undefined; }
}
async function readRawPolicyValues(): Promise<RawPolicy | undefined> {
  const override = process.env.CURSOR_MDM_SIGN_IN_POLICY_JSON;
  if (override !== undefined && override.length > 0) { try { return pickPolicyValues(JSON.parse(override) as RawPolicy); } catch { return undefined; } }
  switch (process.platform) {
    case "darwin": return await readMacosManagedPreferences();
    case "win32": return await readWindowsPolicyRegistry();
    case "linux": return await readLinuxPolicyFile();
    default: return undefined;
  }
}

let cachedHeaderValue: string | undefined;
let cachedAtMs = 0;
export async function readMdmSignInPolicyHeaderValue(): Promise<string | undefined> {
  const now = Date.now();
  if (now - cachedAtMs < POLICY_CACHE_TTL_MS) return cachedHeaderValue;
  try { const raw = await readRawPolicyValues(); cachedHeaderValue = raw === undefined ? undefined : buildMdmSignInPolicyHeaderValue(raw); } catch { cachedHeaderValue = undefined; }
  cachedAtMs = now;
  return cachedHeaderValue;
}
export async function mdmSignInPolicyHeaders(): Promise<Record<string, string>> {
  const value = await readMdmSignInPolicyHeaderValue();
  return value === undefined ? {} : { [MDM_SIGN_IN_POLICY_HEADER_NAME]: value };
}
