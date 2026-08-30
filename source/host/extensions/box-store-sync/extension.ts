import { defineHostExtension } from "../../../internal/host-extensions.js";
import {
  createDebouncePolicy,
  createPollingPolicy,
  createRetryPolicy,
  realClock,
} from "../../../internal/scheduling.js";
import { HostExtensions } from "../extension-ids.generated.js";
import type { AgentStoreClientDependencies } from "./agent-store-sand-files.js";
import { pinBoxStoreDiagnosticsReporter } from "./box-store-diagnostics.js";
import {
  CHROME_SESSION_STAGE_MAX_ATTEMPTS,
  CHROME_SESSION_STAGE_RETRY_DELAY_MS,
  isChromeSessionStageRetryable,
} from "./chrome-session-stage.js";
import {
  BOX_STORE_DB_DEBOUNCE_MS,
  CHROME_SESSION_CHANGE_DEBOUNCE_MS,
  BOX_STORE_MANIFEST_RETRY_ATTEMPTS,
  BOX_STORE_MANIFEST_RETRY_DELAY_MS,
  BOX_STORE_SYNC_INTERVAL_MS,
  createBoxStoreSyncService,
  type BoxStoreTelemetry,
} from "./box-store-sync-service.js";
import { BoxStoreCanonicalWriteConflictError } from "./object-store-port.js";

interface BoxStoreHost {
  isIdle(): boolean;
  log(message: string): void;
}

interface BoxStoreAuth extends AgentStoreClientDependencies {}

interface BoxStoreSourceMap {
  getOrCreateBoxStore(): Promise<{ sourceId: string }>;
}

interface BoxStoreLogs extends BoxStoreTelemetry {
  reportHostExtensionDiagnostic(diagnostic: Record<string, unknown>): void;
}

export const boxStoreSyncExtension = defineHostExtension<unknown, BoxStoreHost>({
  id: HostExtensions.BoxStoreSync,
  dependencies: [
    HostExtensions.Auth,
    HostExtensions.Mcp,
    HostExtensions.SourceMap,
    HostExtensions.Telemetry,
  ],
  start: (context) => {
    const auth = context.deps[HostExtensions.Auth] as BoxStoreAuth;
    const sourceMap = context.deps[HostExtensions.SourceMap] as BoxStoreSourceMap;
    const telemetry = context.deps[HostExtensions.Telemetry] as { logs: BoxStoreLogs };
    pinBoxStoreDiagnosticsReporter(
      (diagnostic) => telemetry.logs.reportHostExtensionDiagnostic(diagnostic),
    );
    const service = createBoxStoreSyncService({
      auth,
      sourceMap,
      telemetry: telemetry.logs,
      isIdle: context.host.isIdle,
      polling: createPollingPolicy(realClock, {
        name: "box-store-sync-cycle",
        intervalMs: BOX_STORE_SYNC_INTERVAL_MS,
      }),
      storeDbDebounce: createDebouncePolicy(realClock, {
        name: "box-store-sync-store-db",
        delayMs: BOX_STORE_DB_DEBOUNCE_MS,
      }),
      chromeSessionDebounce: createDebouncePolicy(realClock, {
        name: "box-store-sync-chrome-session",
        delayMs: CHROME_SESSION_CHANGE_DEBOUNCE_MS,
      }),
      manifestRetry: createRetryPolicy(realClock, {
        name: "box-store-sync-manifest-cas",
        maxAttempts: BOX_STORE_MANIFEST_RETRY_ATTEMPTS,
        initialDelayMs: BOX_STORE_MANIFEST_RETRY_DELAY_MS,
        maxDelayMs: BOX_STORE_MANIFEST_RETRY_DELAY_MS,
        shouldRetry: (error) => error instanceof BoxStoreCanonicalWriteConflictError,
      }),
      chromeStageRetry: createRetryPolicy(realClock, {
        name: "box-store-sync-chrome-stage",
        maxAttempts: CHROME_SESSION_STAGE_MAX_ATTEMPTS,
        initialDelayMs: CHROME_SESSION_STAGE_RETRY_DELAY_MS,
        maxDelayMs: CHROME_SESSION_STAGE_RETRY_DELAY_MS,
        shouldRetry: isChromeSessionStageRetryable,
      }),
      clock: realClock,
      log: context.host.log,
    });
    context.onStop(() => service.dispose());
    service.start();
    return service.api;
  },
});
