import { promises as fs } from "node:fs";
import { join } from "node:path";
import { SandClientPersistenceStore, type ClientPersistenceFiles } from "../../shared/client-persistence-store.js";
import { CLIENT_PERSISTENCE_CHANNELS } from "../../shared/persistence.js";
import { assertTrustedCoordinatorPortRequester } from "../coordinator/coordinator-port-ipc-guard.js";
import { createBoxSecretsPushTelemetry, type BoxSecretsPushAttempt } from "../telemetry/box-secrets-push-telemetry.js";
import { assertTrustedClientPersistenceSender, assertTrustedSecretsSender } from "./secrets-ipc-guard.js";
import {
  SandSecureStorageUnavailableError,
  SandUserSecretsStore,
  type SandUserSecretsStore as UserSecretsStore,
} from "./user-secrets-store.js";

export class SandBoxSecretsPushQuiescedError extends Error {
  constructor() { super("Box secrets pushes are quiesced for quit"); }
}

export function createNodeClientPersistenceFiles(): ClientPersistenceFiles {
  return {
    joinPath: (dir, name) => join(dir, name),
    ensureDir: async (dir) => { await fs.mkdir(dir, { recursive: true }); },
    listFiles: (dir) => fs.readdir(dir),
    readTextFile: (path) => fs.readFile(path, "utf8"),
    writeTextFile: async (path, data) => { await fs.writeFile(path, data, { encoding: "utf8", mode: 0o600 }); },
    rename: (from, to) => fs.rename(from, to),
    removeFile: async (path) => { await fs.rm(path, { force: true }); },
    fileSize: async (path) => { const stats = await fs.stat(path); return stats.isFile() ? stats.size : null; },
  };
}

export interface BoxSecretsPushReport {
  readonly outcome: "ok" | "failed";
  readonly trigger: string;
  readonly accountScope?: string | undefined;
  readonly departing?: boolean;
  readonly secretCount?: number;
  readonly applied?: boolean;
  readonly scope?: { readonly accountScope?: string | undefined };
  readonly errorClass?: "keychain_locked" | "other" | "host_unreachable";
}

export function createBoxSecretsPush(deps: {
  readonly userSecretsStore: Pick<UserSecretsStore, "exportSnapshot">;
  readonly isAccountDeparting: () => boolean;
  readonly setBoxSecrets: (request: { readonly secrets: Record<string, string> }) => Promise<{ readonly isApplied?: boolean }>;
  readonly report: (report: BoxSecretsPushAttempt) => void;
}): {
  push(trigger: string): Promise<boolean>;
  pushOrThrow(trigger: string): Promise<void>;
  quiesce(): Promise<void>;
} {
  const attempt = async (trigger: string): Promise<{ ok: true } | { ok: false; error: unknown }> => {
    const departing = deps.isAccountDeparting();
    let snapshot: Awaited<ReturnType<typeof deps.userSecretsStore.exportSnapshot>>;
    try { snapshot = await deps.userSecretsStore.exportSnapshot(); }
    catch (error) {
      deps.report({ outcome: "failed", trigger, errorClass: error instanceof SandSecureStorageUnavailableError ? "keychain_locked" : "other" });
      return { ok: false, error };
    }
    const sentCount = Object.keys(snapshot.secrets).length;
    try {
      const status = await deps.setBoxSecrets({ secrets: snapshot.secrets });
      deps.report({ outcome: "ok", trigger, accountScope: snapshot.accountScope, departing, secretCount: sentCount, applied: status.isApplied === true });
      return { ok: true };
    } catch (error) {
      deps.report({ outcome: "failed", trigger, scope: { accountScope: snapshot.accountScope }, errorClass: "host_unreachable", secretCount: sentCount });
      return { ok: false, error };
    }
  };
  let queue: Promise<{ ok: true } | { ok: false; error: unknown }> = Promise.resolve({ ok: true });
  let quiesced = false;
  const enqueue = (trigger: string): Promise<{ ok: true } | { ok: false; error: unknown }> => {
    if (quiesced) return Promise.resolve({ ok: false, error: new SandBoxSecretsPushQuiescedError() });
    const run = queue.then(() => quiesced ? { ok: false as const, error: new SandBoxSecretsPushQuiescedError() } : attempt(trigger));
    queue = run;
    return run;
  };
  return {
    push: async (trigger) => (await enqueue(trigger)).ok,
    pushOrThrow: async (trigger) => { const result = await enqueue(trigger); if (!result.ok) throw result.error; },
    quiesce: async () => { quiesced = true; await queue; },
  };
}

export function createTrustedSenderGuards<TContents>(
  getTrustedContents: () => TContents | null | undefined,
): {
  assertTrustedSecretsSender(event: { readonly sender: unknown; readonly senderFrame: unknown }): void;
  assertTrustedClientPersistenceSender(event: { readonly sender: unknown; readonly senderFrame: unknown }): void;
  assertTrustedCoordinatorPortRequester(event: { readonly sender: unknown; readonly senderFrame: unknown }): void;
} {
  const guardContext = (event: { readonly sender: unknown; readonly senderFrame: unknown }) => {
    const contents = getTrustedContents();
    return { sender: event.sender, senderFrame: event.senderFrame, trustedContents: contents ?? null, trustedMainFrame: contents == null ? null : Reflect.get(contents, "mainFrame") ?? null };
  };
  return {
    assertTrustedSecretsSender: (event) => assertTrustedSecretsSender(guardContext(event)),
    assertTrustedClientPersistenceSender: (event) => assertTrustedClientPersistenceSender(guardContext(event)),
    assertTrustedCoordinatorPortRequester: (event) => assertTrustedCoordinatorPortRequester(guardContext(event)),
  };
}

export function parseSecretEntries(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value == null) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export interface SecretsIpcMain {
  handle(channel: string, listener: (event: any, request: any) => unknown): void;
}

export function registerSecretsIpc(deps: {
  readonly ipcMain: SecretsIpcMain;
  readonly guards: ReturnType<typeof createTrustedSenderGuards>;
  readonly stores: {
    readonly userSecretsStore: Pick<UserSecretsStore, "listKeys" | "isPersistent" | "reveal" | "upsert" | "remove">;
    readonly clientPersistenceStore: Pick<SandClientPersistenceStore, "read" | "write" | "remove" | "listKeys" | "migrateFromLocalStorage">;
  };
  readonly pushBoxSecrets: () => Promise<boolean>;
}): void {
  const { ipcMain, guards, pushBoxSecrets } = deps;
  const { userSecretsStore, clientPersistenceStore } = deps.stores;
  ipcMain.handle("sand:secrets-list", async (event) => {
    guards.assertTrustedSecretsSender(event);
    return { keys: await userSecretsStore.listKeys(), isPersistent: userSecretsStore.isPersistent() };
  });
  ipcMain.handle("sand:secrets-reveal", async (event, request) => {
    guards.assertTrustedSecretsSender(event);
    if (typeof request.key !== "string") return null;
    return userSecretsStore.reveal(request.key);
  });
  ipcMain.handle("sand:secrets-upsert", async (event, request) => {
    guards.assertTrustedSecretsSender(event);
    await userSecretsStore.upsert(parseSecretEntries(request.entries));
    return { synced: await pushBoxSecrets() };
  });
  ipcMain.handle("sand:secrets-delete", async (event, request) => {
    guards.assertTrustedSecretsSender(event);
    const keys = Array.isArray(request.keys) ? request.keys.filter((key: unknown): key is string => typeof key === "string") : [];
    await userSecretsStore.remove(keys);
    return { synced: await pushBoxSecrets() };
  });
  ipcMain.handle(CLIENT_PERSISTENCE_CHANNELS.read, async (event, request) => {
    guards.assertTrustedClientPersistenceSender(event);
    return typeof request.key === "string" ? clientPersistenceStore.read(request.key) : null;
  });
  ipcMain.handle(CLIENT_PERSISTENCE_CHANNELS.write, async (event, request) => {
    guards.assertTrustedClientPersistenceSender(event);
    if (typeof request.key !== "string" || typeof request.value !== "string") throw new Error("client persistence: write needs a string key and value");
    await clientPersistenceStore.write(request.key, request.value);
  });
  ipcMain.handle(CLIENT_PERSISTENCE_CHANNELS.remove, async (event, request) => {
    guards.assertTrustedClientPersistenceSender(event);
    if (typeof request.key === "string") await clientPersistenceStore.remove(request.key);
  });
  ipcMain.handle(CLIENT_PERSISTENCE_CHANNELS.listKeys, async (event, request) => {
    guards.assertTrustedClientPersistenceSender(event);
    return typeof request.prefix === "string" ? clientPersistenceStore.listKeys(request.prefix) : [];
  });
  ipcMain.handle(CLIENT_PERSISTENCE_CHANNELS.migrate, async (event, request) => {
    guards.assertTrustedClientPersistenceSender(event);
    const entries = Array.isArray(request.entries) ? request.entries.filter((entry: unknown): entry is { key: string; value: string } => (
      typeof entry === "object" && entry != null && "key" in entry && "value" in entry
      && typeof entry.key === "string" && typeof entry.value === "string"
    )) : [];
    return clientPersistenceStore.migrateFromLocalStorage(entries);
  });
}

export function createSecretsStores(
  clientPersistenceDir: string,
  getAccountScope: () => string | undefined,
  push: {
    readonly reportTelemetry: (level: "info" | "warn", metadata: Readonly<Record<string, string>>) => void;
    readonly isSignedIn: () => boolean;
    readonly isAccountDeparting: () => boolean;
    readonly setBoxSecrets: (request: { readonly secrets: Record<string, string> }) => Promise<{ readonly isApplied?: boolean }>;
  },
): {
  readonly userSecretsStore: SandUserSecretsStore;
  readonly clientPersistenceStore: SandClientPersistenceStore;
  readonly pushBoxSecrets: ReturnType<typeof createBoxSecretsPush>;
  readonly pushTelemetry: ReturnType<typeof createBoxSecretsPushTelemetry>;
} {
  const userSecretsStore = new SandUserSecretsStore(undefined, getAccountScope);
  const pushTelemetry = createBoxSecretsPushTelemetry({
    report: push.reportTelemetry,
    isSignedIn: push.isSignedIn,
  });
  return {
    userSecretsStore,
    clientPersistenceStore: new SandClientPersistenceStore(clientPersistenceDir, createNodeClientPersistenceFiles()),
    pushBoxSecrets: createBoxSecretsPush({
      userSecretsStore,
      isAccountDeparting: push.isAccountDeparting,
      setBoxSecrets: push.setBoxSecrets,
      report: pushTelemetry.record,
    }),
    pushTelemetry,
  };
}
