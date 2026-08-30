import { createDeadlinePolicy, realClock } from "../../../internal/scheduling.js";
import { defineHostExtension } from "../../../internal/host-extensions.js";
import { SAND_WEBAUTHN_CEREMONY_TIMEOUT_MS, type WebAuthnCeremony, type WebAuthnResponseFrame } from "../../../shared/webauthn-gateway.js";
import { HostExtensions } from "../extension-ids.generated.js";
import { SandWebAuthnBridge } from "./webauthn-proxy-bridge.js";
import { applyWebAuthnProxyMarker } from "./webauthn-proxy-marker.js";

interface TelemetryDependency { readonly logs: { readonly reportWebAuthnProxy: (report: Record<string, unknown>) => void } }

export const webauthnProxyExtension = defineHostExtension({
  id: HostExtensions.WebauthnProxy,
  dependencies: [HostExtensions.Telemetry],
  start: (context) => {
    const telemetry = context.deps[HostExtensions.Telemetry] as TelemetryDependency;
    const bridge = new SandWebAuthnBridge({
      clock: realClock,
      ceremonyDeadline: createDeadlinePolicy(realClock, { name: "sand-webauthn-ceremony", timeoutMs: SAND_WEBAUTHN_CEREMONY_TIMEOUT_MS }),
      report: (report) => telemetry.logs.reportWebAuthnProxy(report)
    });
    return {
      requestCeremony: (ceremony: WebAuthnCeremony) => bridge.requestCeremony(ceremony),
      registerProvider: (send: Parameters<typeof bridge.registerProvider>[0]) => bridge.registerProvider(send),
      submitResponses: (batch: { providerId?: string; frames: readonly WebAuthnResponseFrame[] }) => bridge.submitResponses(batch),
      applyEnablement: (enabled: boolean) => applyWebAuthnProxyMarker(enabled)
    };
  }
});

