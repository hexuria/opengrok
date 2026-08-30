import {
  createDeadlinePolicy,
  createExpiryPolicy,
  createIdleWatchdogPolicy,
  createPollingPolicy,
  realClock,
} from "../../../internal/scheduling.js";
import { defineHostExtension } from "../../../internal/host-extensions.js";
import { getBoxStoreBackendPolicy } from "../../box/box-store-backend-policy.js";
import { resolveSandBoxIdentityTags } from "../../ports/telemetry.js";
import { pinExperimentsDiagnosticsReporter } from "../../../shared/node/experiments/experiments-diagnostics.js";
import { HostExtensions } from "../extension-ids.generated.js";
import { BOX_LOG_SHIP_INTERVAL_MS } from "./box-log-shipper.js";
import {
  DESKTOP_HEALTH_FORWARD_INTERVAL_MS,
  HostTelemetryService,
} from "./host-telemetry-service.js";
import { createHostCrashMarkerStore } from "./host-crash-marker.js";
import {
  HOST_IDENTITY_HOLD_BACKSTOP_MS,
  TELEMETRY_FLUSH_TICK_MS,
} from "./structured-log-telemetry.js";
export const FATAL_TELEMETRY_FLUSH_TIMEOUT_MS = 2_000,
  HOST_CRASH_MARKER_FORWARD_INTERVAL_MS = 5 * 60_000,
  HOST_LIFECYCLE_STUCK_MS = 5 * 60_000,
  STRUCTURED_LOG_SUBMIT_DEADLINE_MS = 15_000;
type ServiceOptions = ConstructorParameters<typeof HostTelemetryService>[0];
export const telemetryExtension = defineHostExtension({
  id: HostExtensions.Telemetry,
  dependencies: [
    HostExtensions.Auth,
    HostExtensions.Experiments,
    HostExtensions.Inference,
  ],
  start: async (context) => {
    const auth = context.deps[HostExtensions.Auth] as ServiceOptions["auth"];
    const experiments = context.deps[
      HostExtensions.Experiments
    ] as ServiceOptions["experiments"];
    const inference = context.deps[
      HostExtensions.Inference
    ] as ServiceOptions["inference"];
    const service = new HostTelemetryService({
      auth,
      experiments,
      inference,
      identityTags: {
        ...resolveSandBoxIdentityTags(),
        store_backend: getBoxStoreBackendPolicy().kind,
      },
      flushPolling: createPollingPolicy(realClock, {
        name: "sand-host-structured-log-flush",
        intervalMs: TELEMETRY_FLUSH_TICK_MS,
      }),
      submitDeadline: createDeadlinePolicy(realClock, {
        name: "sand-host-structured-log-submit",
        timeoutMs: STRUCTURED_LOG_SUBMIT_DEADLINE_MS,
      }),
      identityHoldExpiry: createExpiryPolicy(realClock, {
        name: "sand-host-telemetry-identity-hold",
        ttlMs: HOST_IDENTITY_HOLD_BACKSTOP_MS,
      }),
      boxLogPolling: createPollingPolicy(realClock, {
        name: "sand-box-log-shipping",
        intervalMs: BOX_LOG_SHIP_INTERVAL_MS,
      }),
      desktopHealthPolling: createPollingPolicy(realClock, {
        name: "sand-desktop-health-forwarding",
        intervalMs: DESKTOP_HEALTH_FORWARD_INTERVAL_MS,
      }),
      hostCrashMarkerStore: createHostCrashMarkerStore(),
      hostCrashMarkerPolling: createPollingPolicy(realClock, {
        name: "sand-host-crash-marker-forward",
        intervalMs: HOST_CRASH_MARKER_FORWARD_INTERVAL_MS,
      }),
      fatalFlushDeadline: createDeadlinePolicy(realClock, {
        name: "sand-host-fatal-telemetry-flush",
        timeoutMs: FATAL_TELEMETRY_FLUSH_TIMEOUT_MS,
      }),
      clock: realClock,
      hostLifecycleWatchdog: createIdleWatchdogPolicy(realClock, {
        name: "sand-host-lifecycle",
        idleMs: HOST_LIFECYCLE_STUCK_MS,
      }),
    });
    context.onStop(() => service.dispose());
    await service.start();
    const api = service.api();
    pinExperimentsDiagnosticsReporter((diagnostic) =>
      api.logs.reportExperimentsDiagnostic(diagnostic),
    );
    return api;
  },
});
