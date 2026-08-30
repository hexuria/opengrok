import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { Code, ConnectError } from "@connectrpc/connect";
import { GATEWAY_NO_STORAGE_MESSAGE_MARKER } from "../../shared/gateway-reachability.js";
import { isLoopbackGatewayUrl } from "../../shared/box-runtime.js";

export const GATEWAY_DESCRIPTOR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
export const PERSISTED_GATEWAY_DESCRIPTOR_VERSION = 1;

export interface GatewayConnection {
  readonly baseUrl: string;
  readonly token?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly vncProxy?: {
    readonly primaryUrl: string;
    readonly forkBaseUrl: string;
    readonly networkToken: string;
  };
}

export interface GatewayDescriptorStore {
  read(accountScope: string): Promise<GatewayConnection | null>;
  write(accountScope: string, connection: GatewayConnection): Promise<void>;
  clear(): Promise<void>;
}

export interface GatewayDescriptorCodec {
  isAvailable(): boolean;
  encrypt(plaintext: string): string;
  decrypt(stored: string): string;
}

type FailureReporter = (operation: "read" | "decrypt" | "write" | "clear" | "refresh", error: unknown) => void;

function isBrokerDenial(error: unknown): boolean {
  if (!(error instanceof ConnectError)) return false;
  if (error.code === Code.PermissionDenied || error.code === Code.Unauthenticated) return true;
  return error.rawMessage.includes(GATEWAY_NO_STORAGE_MESSAGE_MARKER);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function isFileAbsent(error: unknown): boolean {
  return isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function parseHeaders(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.every(([, header]) => typeof header === "string")) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

export function parsePersistedGatewayConnection(value: unknown): GatewayConnection | null {
  if (!isRecord(value) || typeof value.baseUrl !== "string" || value.baseUrl.length === 0) return null;
  if (value.token !== undefined && typeof value.token !== "string") return null;
  const headers = parseHeaders(value.headers);
  if (value.headers !== undefined && headers === undefined) return null;
  let vncProxy: GatewayConnection["vncProxy"];
  if (value.vncProxy !== undefined) {
    if (!isRecord(value.vncProxy)) return null;
    const { primaryUrl, forkBaseUrl, networkToken } = value.vncProxy;
    if (typeof primaryUrl !== "string" || typeof forkBaseUrl !== "string" || typeof networkToken !== "string") return null;
    vncProxy = { primaryUrl, forkBaseUrl, networkToken };
  }
  return {
    baseUrl: value.baseUrl,
    ...(value.token === undefined ? {} : { token: value.token as string }),
    ...(headers === undefined ? {} : { headers }),
    ...(vncProxy === undefined ? {} : { vncProxy }),
  };
}

export function createPersistedGatewayDescriptorStore(options: {
  readonly filePath: string;
  readonly codec: GatewayDescriptorCodec;
  readonly now?: () => number;
  readonly maxAgeMs?: number;
  readonly reportFailure?: FailureReporter;
}): GatewayDescriptorStore {
  const now = options.now ?? (() => Date.now());
  const maxAgeMs = options.maxAgeMs ?? GATEWAY_DESCRIPTOR_MAX_AGE_MS;
  const reportFailure = options.reportFailure ?? (() => undefined);
  let lastWrittenIdentity: string | null = null;
  let storageTurn = Promise.resolve();
  const takeTurn = async <T>(operation: () => Promise<T>): Promise<T> => {
    const turn = storageTurn.then(operation);
    storageTurn = turn.then(() => undefined, () => undefined);
    return turn;
  };
  return {
    async read(accountScope) {
      if (!options.codec.isAvailable()) return null;
      let raw: string;
      try {
        raw = await fs.readFile(options.filePath, "utf8");
      } catch (error) {
        if (!isFileAbsent(error)) reportFailure("read", error);
        return null;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed) || parsed.version !== PERSISTED_GATEWAY_DESCRIPTOR_VERSION) return null;
        if (parsed.accountScope !== accountScope) return null;
        if (typeof parsed.savedAtMs !== "number" || now() - parsed.savedAtMs > maxAgeMs) return null;
        if (typeof parsed.encrypted !== "string") return null;
        return parsePersistedGatewayConnection(JSON.parse(options.codec.decrypt(parsed.encrypted)));
      } catch (error) {
        reportFailure("decrypt", error);
        return null;
      }
    },
    write(accountScope, connection) {
      if (!options.codec.isAvailable()) return Promise.resolve();
      return takeTurn(async () => {
        try {
          const payload = JSON.stringify({
            version: PERSISTED_GATEWAY_DESCRIPTOR_VERSION,
            accountScope,
            savedAtMs: now(),
            encrypted: options.codec.encrypt(JSON.stringify(connection)),
          });
          const plaintextWriteIdentity = JSON.stringify({ accountScope, connection });
          if (plaintextWriteIdentity === lastWrittenIdentity) return;
          await fs.mkdir(dirname(options.filePath), { recursive: true });
          const tempPath = `${options.filePath}.${process.pid}.${randomUUID()}.tmp`;
          await fs.writeFile(tempPath, payload, { encoding: "utf8", mode: 0o600 });
          await fs.rename(tempPath, options.filePath);
          lastWrittenIdentity = plaintextWriteIdentity;
        } catch (error) {
          reportFailure("write", error);
        }
      });
    },
    clear() {
      return takeTurn(async () => {
        lastWrittenIdentity = null;
        try {
          await fs.rm(options.filePath, { force: true });
        } catch (error) {
          reportFailure("clear", error);
        }
      });
    },
  };
}

export function createGatewayConnectFastPath(
  inner: { connect(): Promise<GatewayConnection> },
  deps: {
    readonly store: GatewayDescriptorStore;
    readonly getAccountScope: () => string | undefined;
    readonly reportFailure?: FailureReporter;
  },
): () => Promise<GatewayConnection> {
  let liveScope: string | undefined;
  let hasLiveConnection = false;
  let pendingRefresh: Promise<GatewayConnection> | null = null;
  let pendingRefreshScope: string | undefined;
  const deniedScopes = new Set<string>();
  const reportedRefreshes = new WeakSet<Promise<GatewayConnection>>();
  const resolveLive = (): Promise<GatewayConnection> => {
    const scopeAtDispatch = deps.getAccountScope();
    return inner.connect().then(
      (connection) => {
        if (deps.getAccountScope() === scopeAtDispatch) {
          hasLiveConnection = true;
          liveScope = scopeAtDispatch;
          if (scopeAtDispatch !== undefined) {
            deniedScopes.delete(scopeAtDispatch);
            void deps.store.write(scopeAtDispatch, connection);
          }
        }
        return connection;
      },
      (error: unknown) => {
        if (isBrokerDenial(error) && scopeAtDispatch !== undefined && deps.getAccountScope() === scopeAtDispatch) {
          deniedScopes.add(scopeAtDispatch);
          void deps.store.clear();
        }
        throw error;
      },
    );
  };
  const startRefresh = (scope: string | undefined): Promise<GatewayConnection> => {
    if (pendingRefresh == null || pendingRefreshScope !== scope) {
      const refresh = resolveLive().then(
        (connection) => {
          if (pendingRefresh === refresh) pendingRefresh = null;
          return connection;
        },
        (error: unknown) => {
          if (pendingRefresh === refresh) pendingRefresh = null;
          throw error;
        },
      );
      pendingRefresh = refresh;
      pendingRefreshScope = scope;
    }
    return pendingRefresh;
  };
  return async () => {
    const scope = deps.getAccountScope();
    if (hasLiveConnection && liveScope === scope) return resolveLive();
    const cached = scope === undefined || deniedScopes.has(scope) ? null : await deps.store.read(scope);
    const refresh = startRefresh(scope);
    if (cached == null || isLoopbackGatewayUrl(cached.baseUrl)) return refresh;
    if (!reportedRefreshes.has(refresh)) {
      reportedRefreshes.add(refresh);
      refresh.catch((error: unknown) => deps.reportFailure?.("refresh", error));
    }
    return cached;
  };
}
