import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { delay } from "../../shared/node/async.js";
import { parseJwtPayload } from "../../shared/node/cursor-token.js";
import { findSystemErrno } from "../../shared/system-errno.js";
import { reportDesktopEdgeFailure } from "../desktop-edge-failures.js";
import { captureSandSentryWarning } from "../telemetry/sentry.js";
import { shouldPersistSecretsOnDisk as persistSecretsOnDisk } from "../../shared/cursor-session-policy.js";

export const SECRETS_FILENAME = "sand-secrets.json";
export const SCOPED_CIPHERTEXT_PREFIX = "scoped:v1:";
export const ACCOUNT_SCOPE_PATTERN = /^[0-9a-f]{64}$/u;
export const ACCESS_TOKEN_KEY = "cursor-access-token";
export const REFRESH_TOKEN_KEY = "cursor-refresh-token";
export const CURSOR_AUTH_KEYS = [ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY] as const;
export const LEGACY_PLAINTEXT_PREFIX = "plaintext:v1:";

export function encodePlaintextSecret(value: string): string {
  return `${LEGACY_PLAINTEXT_PREFIX}${Buffer.from(value, "utf8").toString("base64")}`;
}

export function decodePlaintextSecret(stored: string): string | null {
  if (!stored.startsWith(LEGACY_PLAINTEXT_PREFIX)) return null;
  return Buffer.from(stored.slice(LEGACY_PLAINTEXT_PREFIX.length), "base64").toString("utf8");
}

export function shouldPersistSecretsOnDisk(env: NodeJS.ProcessEnv = process.env, filePath = ""): boolean {
  return persistSecretsOnDisk(env, filePath);
}
export const SECURE_STORAGE_READY_TIMEOUT_MS = 5_000;
export const SECURE_STORAGE_POLL_INTERVAL_MS = 200;

export type SecretStorageMode = "encrypted" | "in-memory";
export function resolveSecretStorageMode(args: { readonly isEncryptionAvailable: boolean }): SecretStorageMode {
  return args.isEncryptionAvailable ? "encrypted" : "in-memory";
}

export interface SecureStorageCodec {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
  setUsePlainTextEncryption?(enabled: boolean): void;
}

export interface StoredEncryptedSecret {
  readonly accountScope: string | null;
  readonly ciphertextBase64: string;
}

export function accountScopeFromAccessToken(accessToken: string): string | null {
  const sub = parseJwtPayload(accessToken)?.sub;
  if (sub == null || sub.length === 0) return null;
  return createHash("sha256").update(sub).digest("hex");
}

export function parseStoredEncryptedSecret(stored: string): StoredEncryptedSecret | null {
  if (!stored.startsWith(SCOPED_CIPHERTEXT_PREFIX)) return { accountScope: null, ciphertextBase64: stored };
  const separatorIndex = stored.indexOf(":", SCOPED_CIPHERTEXT_PREFIX.length);
  if (separatorIndex < 0) return null;
  const accountScope = stored.slice(SCOPED_CIPHERTEXT_PREFIX.length, separatorIndex);
  const ciphertextBase64 = stored.slice(separatorIndex + 1);
  if (!ACCOUNT_SCOPE_PATTERN.test(accountScope) || ciphertextBase64.length === 0) return null;
  return { accountScope, ciphertextBase64 };
}

export function withoutCursorAuth(map: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  if (!CURSOR_AUTH_KEYS.some((key) => key in map)) return map;
  const next = { ...map };
  for (const key of CURSOR_AUTH_KEYS) delete next[key];
  return next;
}

export function canKeepCursorAuthRecovery(
  map: Readonly<Record<string, string>>,
  accessToken: string,
): boolean {
  const incomingScope = accountScopeFromAccessToken(accessToken);
  if (incomingScope == null) return false;
  const stored = map[ACCESS_TOKEN_KEY];
  if (stored == null || stored.startsWith(LEGACY_PLAINTEXT_PREFIX)) return false;
  return parseStoredEncryptedSecret(stored)?.accountScope === incomingScope;
}

interface ElectronSecretStorageRuntime {
  readonly app: {
    readonly isPackaged: boolean;
    getPath(name: "userData"): string;
  };
  readonly safeStorage: {
    isEncryptionAvailable(): boolean;
    encryptString(value: string): Buffer;
    decryptString(value: Buffer): string;
    getSelectedStorageBackend(): string;
    setUsePlainTextEncryption(enabled: boolean): void;
  };
}

let diskCachePromise: Promise<Record<string, string>> | undefined;
let diskMutationTail = Promise.resolve();
const sessionSecrets = new Map<string, string>();
let warnedInMemory = false;
let linuxBasicTextOptedIn = false;

function electronSecretStorageRuntime(): ElectronSecretStorageRuntime {
  const moduleName = "electron";
  return require(moduleName) as ElectronSecretStorageRuntime;
}

function isSecureStorageSimulatedUnavailable(): boolean {
  return !electronSecretStorageRuntime().app.isPackaged
    && process.env.SAND_SIMULATE_SECURE_STORAGE_UNAVAILABLE === "1";
}

function ensureLinuxBasicTextOptIn(): void {
  if (linuxBasicTextOptedIn || process.platform !== "linux") return;
  try {
    const { safeStorage } = electronSecretStorageRuntime();
    if (safeStorage.getSelectedStorageBackend() === "basic_text") {
      safeStorage.setUsePlainTextEncryption(true);
      linuxBasicTextOptedIn = true;
    }
  } catch (error) {
    reportDesktopEdgeFailure("secret-store", "linux-backend", error);
  }
}

function isOsEncryptionAvailable(): boolean {
  if (isSecureStorageSimulatedUnavailable()) return false;
  ensureLinuxBasicTextOptIn();
  return electronSecretStorageRuntime().safeStorage.isEncryptionAvailable();
}

export function initializeSecureStorage(): void {
  isOsEncryptionAvailable();
}

function currentMode(): SecretStorageMode {
  return resolveSecretStorageMode({ isEncryptionAvailable: isOsEncryptionAvailable() });
}

function warnInMemoryOnce(): void {
  if (warnedInMemory) return;
  warnedInMemory = true;
  captureSandSentryWarning("[sand] OS secure storage (keychain/keyring) is unavailable; Cursor tokens are kept in memory for this session only and will NOT persist across restart. Set up a system keychain/keyring for persistent encrypted sign-in.");
}

function getStorePath(): string {
  return join(electronSecretStorageRuntime().app.getPath("userData"), SECRETS_FILENAME);
}

function encryptSecret(key: string, value: string): string {
  const ciphertextBase64 = electronSecretStorageRuntime().safeStorage.encryptString(value).toString("base64");
  const accountScope = key === ACCESS_TOKEN_KEY ? accountScopeFromAccessToken(value) : null;
  return accountScope == null
    ? ciphertextBase64
    : `${SCOPED_CIPHERTEXT_PREFIX}${accountScope}:${ciphertextBase64}`;
}

async function stampUnscopedAccessToken(args: {
  readonly stored: string;
  readonly encrypted: StoredEncryptedSecret;
  readonly value: string;
}): Promise<void> {
  const { stored, encrypted, value } = args;
  const accountScope = accountScopeFromAccessToken(value);
  if (accountScope == null || encrypted.accountScope != null) return;
  try {
    await updateDisk((map) => {
      if (map[ACCESS_TOKEN_KEY] !== stored) return map;
      return {
        ...map,
        [ACCESS_TOKEN_KEY]: `${SCOPED_CIPHERTEXT_PREFIX}${accountScope}:${encrypted.ciphertextBase64}`,
      };
    });
  } catch (error) {
    reportDesktopEdgeFailure("secret-store", "write", error);
  }
}

async function loadFromDisk(): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(getStorePath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") result[key] = value;
    }
    return result;
  } catch (error) {
    if (findSystemErrno(error) === "ENOENT") return {};
    throw error;
  }
}

async function getDiskCache(): Promise<Record<string, string>> {
  const pending = diskCachePromise ??= loadFromDisk();
  try {
    return await pending;
  } catch (error) {
    if (diskCachePromise === pending) diskCachePromise = undefined;
    throw error;
  }
}

async function writeAtomic(map: Readonly<Record<string, string>>): Promise<void> {
  const storePath = getStorePath();
  await fs.mkdir(dirname(storePath), { recursive: true });
  const temporaryPath = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(map, null, 2), { encoding: "utf-8", mode: 0o600 });
  await fs.rename(temporaryPath, storePath);
}

async function updateDisk(
  update: (map: Readonly<Record<string, string>>) => Readonly<Record<string, string>>,
): Promise<void> {
  const operation = diskMutationTail.then(async () => {
    const current = await getDiskCache();
    const next = update(current);
    if (next === current) return;
    await writeAtomic(next);
    diskCachePromise = Promise.resolve(next as Record<string, string>);
  });
  diskMutationTail = operation.then(() => undefined, () => undefined);
  await operation;
}

async function migrateLegacyPlaintext(args: {
  readonly key: string;
  readonly stored: string;
  readonly value: string;
}): Promise<void> {
  const { key, stored, value } = args;
  if (isOsEncryptionAvailable()) {
    await updateDisk((map) => map[key] !== stored ? map : { ...map, [key]: encryptSecret(key, value) });
  } else {
    warnInMemoryOnce();
    if (!sessionSecrets.has(key)) sessionSecrets.set(key, value);
    await updateDisk((map) => {
      if (map[key] !== stored) return map;
      const next = { ...map };
      delete next[key];
      return next;
    });
  }
}

export async function readSecret(key: string): Promise<string | null> {
  const session = sessionSecrets.get(key);
  if (session != null) return session;
  const map = await getDiskCache();
  const stored = map[key];
  if (stored == null) return null;
  if (stored.startsWith(LEGACY_PLAINTEXT_PREFIX)) {
    const value = decodePlaintextSecret(stored);
    if (value == null) return null;
    if (!shouldPersistSecretsOnDisk(process.env, getStorePath())) await migrateLegacyPlaintext({ key, stored, value });
    return value;
  }
  if (!isOsEncryptionAvailable()) return null;
  const encrypted = parseStoredEncryptedSecret(stored);
  if (encrypted == null) return null;
  try {
    const value = electronSecretStorageRuntime().safeStorage.decryptString(Buffer.from(encrypted.ciphertextBase64, "base64"));
    if (key === ACCESS_TOKEN_KEY) await stampUnscopedAccessToken({ stored, encrypted, value });
    if (shouldPersistSecretsOnDisk(process.env, getStorePath())) {
      await updateDisk((map) => map[key] !== stored ? map : { ...map, [key]: encodePlaintextSecret(value) });
    }
    return value;
  } catch {
    return null;
  }
}

export async function writeSecret(key: string, value: string): Promise<void> {
  if (value.length === 0) {
    await deleteSecret(key);
    return;
  }
  if (shouldPersistSecretsOnDisk(process.env, getStorePath())) {
    await updateDisk((map) => ({ ...map, [key]: encodePlaintextSecret(value) }));
    sessionSecrets.delete(key);
    return;
  }
  if (currentMode() === "encrypted") {
    await updateDisk((map) => ({ ...map, [key]: encryptSecret(key, value) }));
    sessionSecrets.delete(key);
    return;
  }
  warnInMemoryOnce();
  if (key === ACCESS_TOKEN_KEY) {
    await updateDisk((map) => canKeepCursorAuthRecovery(map, value) ? map : withoutCursorAuth(map));
  }
  sessionSecrets.set(key, value);
}

export async function deleteSecret(key: string): Promise<void> {
  sessionSecrets.delete(key);
  await updateDisk((map) => {
    if (!(key in map)) return map;
    const next = { ...map };
    delete next[key];
    return next;
  });
}

export function isEncryptedStorageAvailable(): boolean {
  return currentMode() === "encrypted";
}

export async function waitForEncryptedStorage(
  isAvailable: () => boolean = isEncryptedStorageAvailable,
  options: { readonly timeoutMs?: number; readonly intervalMs?: number } = {},
): Promise<boolean> {
  if (isAvailable()) return true;
  const timeoutMs = options.timeoutMs ?? SECURE_STORAGE_READY_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? SECURE_STORAGE_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(intervalMs);
    if (isAvailable()) return true;
  }
  return false;
}

export class DesktopSecretStore {
  private diskCachePromise: Promise<Record<string, string>> | undefined;
  private diskMutationTail = Promise.resolve();
  private readonly sessionSecrets = new Map<string, string>();
  private warnedInMemory = false;
  private linuxBasicTextOptedIn = false;

  constructor(private readonly options: {
    readonly filePath: string;
    readonly safeStorage: SecureStorageCodec;
    readonly isPackaged: boolean;
    readonly platform?: NodeJS.Platform;
    readonly env?: NodeJS.ProcessEnv;
    readonly warn?: (message: string) => void;
    readonly reportFailure?: (operation: "linux-backend" | "write", error: unknown) => void;
    readonly now?: () => number;
    readonly delay?: (ms: number) => Promise<void>;
    readonly persistPlaintext?: boolean;
  }) {}

  private persistPlaintext(): boolean {
    return this.options.persistPlaintext === true
      || shouldPersistSecretsOnDisk(this.options.env ?? process.env, this.options.filePath);
  }

  initializeSecureStorage(): void {
    this.isOsEncryptionAvailable();
  }

  currentMode(): SecretStorageMode {
    return resolveSecretStorageMode({ isEncryptionAvailable: this.isOsEncryptionAvailable() });
  }

  isEncryptedStorageAvailable(): boolean {
    return this.currentMode() === "encrypted";
  }

  async waitForEncryptedStorage(waitOptions: { readonly timeoutMs?: number; readonly intervalMs?: number } = {}): Promise<boolean> {
    if (this.isEncryptedStorageAvailable()) return true;
    const timeoutMs = waitOptions.timeoutMs ?? SECURE_STORAGE_READY_TIMEOUT_MS;
    const intervalMs = waitOptions.intervalMs ?? SECURE_STORAGE_POLL_INTERVAL_MS;
    const now = this.options.now ?? Date.now;
    const delay = this.options.delay ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      await delay(intervalMs);
      if (this.isEncryptedStorageAvailable()) return true;
    }
    return false;
  }

  async readSecret(key: string): Promise<string | null> {
    const session = this.sessionSecrets.get(key);
    if (session != null) return session;
    const map = await this.getDiskCache();
    const stored = map[key];
    if (stored == null) return null;
    if (stored.startsWith(LEGACY_PLAINTEXT_PREFIX)) {
      const value = decodePlaintextSecret(stored);
      if (value == null) return null;
      if (!this.persistPlaintext()) await this.migrateLegacyPlaintext({ key, stored, value });
      return value;
    }
    if (!this.isOsEncryptionAvailable()) return null;
    const encrypted = parseStoredEncryptedSecret(stored);
    if (encrypted == null) return null;
    try {
      const value = this.options.safeStorage.decryptString(Buffer.from(encrypted.ciphertextBase64, "base64"));
      if (key === ACCESS_TOKEN_KEY) await this.stampUnscopedAccessToken({ stored, encrypted, value });
      if (this.persistPlaintext()) {
        await this.updateDisk((map) => map[key] !== stored ? map : { ...map, [key]: encodePlaintextSecret(value) });
      }
      return value;
    } catch {
      return null;
    }
  }

  async writeSecret(key: string, value: string): Promise<void> {
    if (value.length === 0) {
      await this.deleteSecret(key);
      return;
    }
    if (this.persistPlaintext()) {
      await this.updateDisk((map) => ({ ...map, [key]: encodePlaintextSecret(value) }));
      this.sessionSecrets.delete(key);
      return;
    }
    if (this.currentMode() === "encrypted") {
      await this.updateDisk((map) => ({ ...map, [key]: this.encryptSecret(key, value) }));
      this.sessionSecrets.delete(key);
      return;
    }
    this.warnInMemoryOnce();
    if (key === ACCESS_TOKEN_KEY) {
      await this.updateDisk((map) => canKeepCursorAuthRecovery(map, value) ? map : withoutCursorAuth(map));
    }
    this.sessionSecrets.set(key, value);
  }

  async deleteSecret(key: string): Promise<void> {
    this.sessionSecrets.delete(key);
    await this.updateDisk((map) => {
      if (!(key in map)) return map;
      const next = { ...map };
      delete next[key];
      return next;
    });
  }

  private isSecureStorageSimulatedUnavailable(): boolean {
    return !this.options.isPackaged && (this.options.env ?? process.env).SAND_SIMULATE_SECURE_STORAGE_UNAVAILABLE === "1";
  }

  private ensureLinuxBasicTextOptIn(): void {
    if (this.linuxBasicTextOptedIn || (this.options.platform ?? process.platform) !== "linux") return;
    try {
      if (this.options.safeStorage.getSelectedStorageBackend?.() === "basic_text") {
        this.options.safeStorage.setUsePlainTextEncryption?.(true);
        this.linuxBasicTextOptedIn = true;
      }
    } catch (error) {
      this.options.reportFailure?.("linux-backend", error);
    }
  }

  private isOsEncryptionAvailable(): boolean {
    if (this.isSecureStorageSimulatedUnavailable()) return false;
    this.ensureLinuxBasicTextOptIn();
    return this.options.safeStorage.isEncryptionAvailable();
  }

  private warnInMemoryOnce(): void {
    if (this.warnedInMemory) return;
    this.warnedInMemory = true;
    this.options.warn?.("[sand] OS secure storage (keychain/keyring) is unavailable; Cursor tokens are kept in memory for this session only and will NOT persist across restart. Set up a system keychain/keyring for persistent encrypted sign-in.");
  }

  private encryptSecret(key: string, value: string): string {
    const ciphertextBase64 = this.options.safeStorage.encryptString(value).toString("base64");
    const accountScope = key === ACCESS_TOKEN_KEY ? accountScopeFromAccessToken(value) : null;
    return accountScope == null ? ciphertextBase64 : `${SCOPED_CIPHERTEXT_PREFIX}${accountScope}:${ciphertextBase64}`;
  }

  private async stampUnscopedAccessToken(args: { readonly stored: string; readonly encrypted: StoredEncryptedSecret; readonly value: string }): Promise<void> {
    const accountScope = accountScopeFromAccessToken(args.value);
    if (accountScope == null || args.encrypted.accountScope != null) return;
    try {
      await this.updateDisk((map) => map[ACCESS_TOKEN_KEY] !== args.stored ? map : {
        ...map,
        [ACCESS_TOKEN_KEY]: `${SCOPED_CIPHERTEXT_PREFIX}${accountScope}:${args.encrypted.ciphertextBase64}`,
      });
    } catch (error) {
      this.options.reportFailure?.("write", error);
    }
  }

  private async migrateLegacyPlaintext(args: { readonly key: string; readonly stored: string; readonly value: string }): Promise<void> {
    if (this.isOsEncryptionAvailable()) {
      await this.updateDisk((map) => map[args.key] !== args.stored ? map : { ...map, [args.key]: this.encryptSecret(args.key, args.value) });
    } else {
      this.warnInMemoryOnce();
      if (!this.sessionSecrets.has(args.key)) this.sessionSecrets.set(args.key, args.value);
      await this.updateDisk((map) => {
        if (map[args.key] !== args.stored) return map;
        const next = { ...map };
        delete next[args.key];
        return next;
      });
    }
  }

  private async loadFromDisk(): Promise<Record<string, string>> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.options.filePath, "utf-8"));
      if (typeof parsed !== "object" || parsed === null) return {};
      return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    } catch (error) {
      if (typeof error === "object" && error != null && "code" in error && error.code === "ENOENT") return {};
      throw error;
    }
  }

  private async getDiskCache(): Promise<Record<string, string>> {
    const pending = this.diskCachePromise ??= this.loadFromDisk();
    try {
      return await pending;
    } catch (error) {
      if (this.diskCachePromise === pending) this.diskCachePromise = undefined;
      throw error;
    }
  }

  private async writeAtomic(map: Readonly<Record<string, string>>): Promise<void> {
    await fs.mkdir(dirname(this.options.filePath), { recursive: true });
    const temporary = `${this.options.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(map, null, 2), { encoding: "utf-8", mode: 0o600 });
    await fs.rename(temporary, this.options.filePath);
  }

  private async updateDisk(update: (map: Readonly<Record<string, string>>) => Readonly<Record<string, string>>): Promise<void> {
    const operation = this.diskMutationTail.then(async () => {
      const current = await this.getDiskCache();
      const next = update(current);
      if (next === current) return;
      await this.writeAtomic(next);
      this.diskCachePromise = Promise.resolve(next as Record<string, string>);
    });
    this.diskMutationTail = operation.then(() => undefined, () => undefined);
    await operation;
  }
}
