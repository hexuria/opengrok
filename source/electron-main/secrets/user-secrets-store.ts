import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { validateBoxSecrets } from "../../shared/box-secrets.js";
import { reportDesktopEdgeFailure } from "../desktop-edge-failures.js";
import { captureSandSentryWarning } from "../telemetry/sentry.js";
import { isEncryptedStorageAvailable } from "./secret-store.js";

export const USER_SECRETS_FILENAME = "user-secrets.json";
export const LEGACY_ACCOUNT_SLOT = "legacy";

export class SandSecureStorageUnavailableError extends Error {
  constructor() { super("OS secure storage is unavailable"); }
}
export class SandBoxSecretsValidationError extends Error {}
export class SandSecretsAccountRequiredError extends Error {
  constructor() { super("Box secrets can only change while an account is signed in"); }
}

type EncryptedSecrets = Record<string, string>;
type EncryptedSecretsByAccount = Record<string, EncryptedSecrets>;

interface ElectronUserSecretsRuntime {
  readonly app: { getPath(name: "userData"): string };
  readonly safeStorage: {
    encryptString(value: string): Buffer;
    decryptString(value: Buffer): string;
  };
}

function loadElectronUserSecretsRuntime(moduleName: string): ElectronUserSecretsRuntime {
  return require(moduleName) as ElectronUserSecretsRuntime;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function defaultStorePath(): string {
  return join(loadElectronUserSecretsRuntime("electron").app.getPath("userData"), USER_SECRETS_FILENAME);
}

let warnedInMemory = false;

function warnInMemoryOnce(): void {
  if (warnedInMemory) return;
  warnedInMemory = true;
  captureSandSentryWarning("[sand] OS secure storage (keychain/keyring) is unavailable; box secrets are kept in memory for this session only and will NOT persist across restart.");
}

export function readEncryptedSecrets(value: unknown): EncryptedSecrets | undefined {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export function readEncryptedSecretsByAccount(value: unknown): EncryptedSecretsByAccount | undefined {
  if (!isRecord(value)) return undefined;
  const entries: Array<[string, EncryptedSecrets]> = [];
  for (const [accountSlot, secretsValue] of Object.entries(value)) {
    const secrets = readEncryptedSecrets(secretsValue);
    if (secrets !== undefined) entries.push([accountSlot, secrets]);
  }
  return Object.fromEntries(entries);
}

export class SandUserSecretsStore {
  private diskCache: EncryptedSecretsByAccount | undefined;
  private readonly sessionSecrets = new Map<string, Map<string, string>>();
  private readonly storePath: string;
  private readonly getAccountScope: () => string | undefined;

  constructor(storePath = defaultStorePath(), getAccountScope: () => string | undefined = () => undefined) {
    this.storePath = storePath;
    this.getAccountScope = getAccountScope;
  }

  isPersistent(): boolean { return isEncryptedStorageAvailable(); }

  async listKeys(): Promise<string[]> {
    const { disk, session } = await this.resolveCurrentSlot();
    return [...new Set([...Object.keys(disk), ...session.keys()])].sort();
  }

  async reveal(key: string): Promise<string | null> {
    const { disk, session } = await this.resolveCurrentSlot();
    const sessionValue = session.get(key);
    if (sessionValue != null) return sessionValue;
    const stored = disk[key];
    if (stored == null || !isEncryptedStorageAvailable()) return null;
    try { return loadElectronUserSecretsRuntime("electron").safeStorage.decryptString(Buffer.from(stored, "base64")); }
    catch { return null; }
  }

  async exportSnapshot(): Promise<{ readonly accountScope: string | undefined; readonly secrets: Record<string, string> }> {
    const accountScope = this.getAccountScope();
    const { disk, session } = await this.resolveSlot(accountScope);
    const secrets: Record<string, string> = {};
    const diskKeys = Object.keys(disk);
    if (diskKeys.length > 0 && !isEncryptedStorageAvailable()) throw new SandSecureStorageUnavailableError();
    for (const key of diskKeys) secrets[key] = loadElectronUserSecretsRuntime("electron").safeStorage.decryptString(Buffer.from(disk[key]!, "base64"));
    for (const [key, value] of session) secrets[key] = value;
    return { accountScope, secrets };
  }

  async upsert(entries: Readonly<Record<string, string>>): Promise<void> {
    if (this.getAccountScope() === undefined) throw new SandSecretsAccountRequiredError();
    const { diskByAccount, disk, session } = await this.resolveCurrentSlot();
    const resulting: Record<string, string> = {};
    if (isEncryptedStorageAvailable()) {
      for (const [key, blob] of Object.entries(disk)) {
        try { resulting[key] = loadElectronUserSecretsRuntime("electron").safeStorage.decryptString(Buffer.from(blob, "base64")); }
        catch (error) { reportDesktopEdgeFailure("user-secrets", "decrypt", error); }
      }
    }
    for (const [key, value] of session) resulting[key] = value;
    for (const [key, value] of Object.entries(entries)) resulting[key] = value;
    const validationError = validateBoxSecrets(resulting);
    if (validationError != null) throw new SandBoxSecretsValidationError(validationError);
    if (isEncryptedStorageAvailable()) {
      for (const [key, value] of Object.entries(entries)) {
        disk[key] = loadElectronUserSecretsRuntime("electron").safeStorage.encryptString(value).toString("base64");
        session.delete(key);
      }
      await this.persist(diskByAccount);
      return;
    }
    warnInMemoryOnce();
    for (const [key, value] of Object.entries(entries)) session.set(key, value);
  }

  async remove(keys: readonly string[]): Promise<void> {
    if (this.getAccountScope() === undefined) throw new SandSecretsAccountRequiredError();
    const { diskByAccount, disk, session } = await this.resolveCurrentSlot();
    let diskChanged = false;
    for (const key of keys) {
      session.delete(key);
      if (key in disk) { delete disk[key]; diskChanged = true; }
    }
    if (diskChanged) await this.persist(diskByAccount);
  }

  private async getDiskCache(): Promise<EncryptedSecretsByAccount> {
    if (this.diskCache !== undefined) return this.diskCache;
    this.diskCache = await this.loadFromDisk();
    return this.diskCache;
  }

  private resolveCurrentSlot() { return this.resolveSlot(this.getAccountScope()); }

  private async resolveSlot(accountSlot: string | undefined): Promise<{
    readonly diskByAccount: EncryptedSecretsByAccount;
    readonly disk: EncryptedSecrets;
    readonly session: Map<string, string>;
  }> {
    const diskByAccount = await this.getDiskCache();
    if (accountSlot === undefined) return { diskByAccount, disk: {}, session: new Map() };
    const legacyDisk = diskByAccount[LEGACY_ACCOUNT_SLOT];
    if (legacyDisk !== undefined && Object.keys(legacyDisk).length > 0) {
      diskByAccount[accountSlot] = { ...legacyDisk, ...(diskByAccount[accountSlot] ?? {}) };
      delete diskByAccount[LEGACY_ACCOUNT_SLOT];
      await this.persist(diskByAccount);
    }
    const disk = diskByAccount[accountSlot] ?? {};
    diskByAccount[accountSlot] = disk;
    let session = this.sessionSecrets.get(accountSlot);
    if (session === undefined) { session = new Map(); this.sessionSecrets.set(accountSlot, session); }
    return { diskByAccount, disk, session };
  }

  private async loadFromDisk(): Promise<EncryptedSecretsByAccount> {
    let raw: string;
    try { raw = await fs.readFile(this.storePath, "utf8"); }
    catch { return {}; }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) return {};
      if (parsed.version === 1) {
        const secrets = readEncryptedSecrets(parsed.secrets);
        return secrets === undefined ? {} : { [LEGACY_ACCOUNT_SLOT]: secrets };
      }
      if (parsed.version !== 2) return {};
      return readEncryptedSecretsByAccount(parsed.accounts) ?? {};
    } catch { return {}; }
  }

  private async persist(accounts: EncryptedSecretsByAccount): Promise<void> {
    await fs.mkdir(dirname(this.storePath), { recursive: true });
    const temporary = `${this.storePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ version: 2, accounts }, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, this.storePath);
  }
}
