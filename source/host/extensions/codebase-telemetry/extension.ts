import { join } from "node:path";
import { createCursorChecksum, getSandInferenceBackendUrl } from "../../../shared/node/cursor-backend/cursor-inference.js";
import { getSandBackendClientHeaders } from "../../../shared/node/sand-client-metadata.js";
import { createDeadlinePolicy, createRealPollingPolicy, createRealRetryPolicy, realClock } from "../../../internal/scheduling.js";
import { defineHostExtension } from "../../../internal/host-extensions.js";
import { getSandRootDir } from "../../host-paths.js";
import { HostExtensions } from "../extension-ids.generated.js";
import { CsnapsCodebaseTelemetryAdapter } from "./codebase-telemetry-adapter.js";
import { resolveCsnapsCapability } from "./csnaps-capability.js";
import { createCodebaseTelemetryService, createSandCodebaseTelemetryLogger } from "./codebase-telemetry-service.js";
import { spawnCsnaps } from "./csnaps-process.js";
import { createSandPrivacyModeLoader, isRetryablePrivacyModeLookupError, type TelemetryAuth } from "./privacy-mode.js";

export { resolveCsnapsBinPath, resolveCsnapsCapability } from "./csnaps-capability.js";

interface CodebaseTelemetryHost {
  log(message: string): void;
  events: Parameters<typeof createCodebaseTelemetryService>[0]["events"];
}

export const codebaseTelemetryExtension = defineHostExtension({
  id: HostExtensions.CodebaseTelemetry,
  dependencies: [HostExtensions.Auth, HostExtensions.Experiments],
  start: (context) => {
    const host = context.host as CodebaseTelemetryHost;
    const deps = context.deps as { auth: Parameters<typeof createCodebaseTelemetryService>[0]["auth"] & { getMachineId(): Promise<string> }; experiments: Parameters<typeof createCodebaseTelemetryService>[0]["experiments"] };
    const logger = createSandCodebaseTelemetryLogger(host.log);
    const capability = resolveCsnapsCapability();
    if (!capability.available) {
      logger.warn(
        `Codebase Telemetry unavailable: csnaps ${capability.reason} at ${capability.executablePath}`,
      );
      return { async flushPendingUploads(): Promise<void> {} };
    }
    const service = createCodebaseTelemetryService({
      auth: deps.auth,
      experiments: deps.experiments,
      events: host.events,
      createAdapter: ({ credentials, signal }) => CsnapsCodebaseTelemetryAdapter.create({
        credentials,
        paths: { codebaseUuidStatePath: join(getSandRootDir(), "telemetry/codebase-uuids.json"), snapshotsBaseDir: "/var/lib/sand/telemetry/codebase" },
        backendUrl: getSandInferenceBackendUrl(),
        csnapsBinPath: capability.executablePath,
        spawnCsnaps,
        uploadPolling: createRealPollingPolicy({ name: "codebase-snapshot-upload", intervalMs: 5 * 60_000 }),
        createUploadCredentials: async () => ({ authToken: credentials.authToken, requestHeaders: { ...getSandBackendClientHeaders(), "x-cursor-checksum": createCursorChecksum(await deps.auth.getMachineId()), "x-ghost-mode": "false" } }),
        logger,
        signal
      }),
      loadPrivacyMode: createSandPrivacyModeLoader(deps.auth),
      policies: {
        privacyLookupDeadline: createDeadlinePolicy(realClock, { name: "codebase-telemetry-privacy-lookup", timeoutMs: 3_000 }),
        privacyLookupRetry: createRealRetryPolicy({ name: "codebase-telemetry-privacy-lookup-retry", maxAttempts: 2, initialDelayMs: 10_000, maxDelayMs: 10_000, shouldRetry: isRetryablePrivacyModeLookupError }),
        privacyRefreshPolling: createRealPollingPolicy({ name: "codebase-telemetry-privacy-refresh", intervalMs: 5 * 60_000 }),
        sessionRestartDelay: createRealRetryPolicy({ name: "codebase-telemetry-session-restart", maxAttempts: 2, initialDelayMs: 30_000, maxDelayMs: 30_000 }),
        shutdownDeadline: createDeadlinePolicy(realClock, { name: "codebase-telemetry-shutdown", timeoutMs: 30_000 })
      },
      logger
    });
    context.onStop(() => service.dispose());
    return service.api;
  }
});
