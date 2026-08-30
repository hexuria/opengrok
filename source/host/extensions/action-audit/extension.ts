import { defineHostExtension } from "../../../internal/host-extensions.js";
import { createRealPollingPolicy } from "../../../internal/scheduling.js";
import { HostExtensions } from "../extension-ids.generated.js";
import { createSandAuditBatchSender } from "./action-audit-backend.js";
import { ACTION_AUDIT_FLUSH_INTERVAL_MS, createSandActionAuditor } from "./action-audit-service.js";

interface ActionAuditAuth {
  getAccessToken(options: { readonly backendUrl: string }): Promise<string>;
  getMachineId(): Promise<string>;
}

export const actionAuditExtension = defineHostExtension({
  id: HostExtensions.ActionAudit,
  dependencies: [HostExtensions.Auth, HostExtensions.Experiments, HostExtensions.Telemetry],
  start: (context) => {
    const auth = context.deps[HostExtensions.Auth] as ActionAuditAuth;
    const experiments = context.deps[HostExtensions.Experiments] as { checkGate(name: string): boolean | Promise<boolean> };
    const telemetry = context.deps[HostExtensions.Telemetry] as { logs: { reportHostExtensionDiagnostic(value: unknown): void } };
    const service = createSandActionAuditor({
      isBackendForwardingEnabled: () => experiments.checkGate("sand_action_audit_logs"),
      sendBatch: createSandAuditBatchSender({ getAccessToken: auth.getAccessToken, getMachineId: auth.getMachineId }),
      report: (diagnostic) => telemetry.logs.reportHostExtensionDiagnostic(diagnostic),
      flushPolicy: createRealPollingPolicy({ name: "action-audit-flush", intervalMs: ACTION_AUDIT_FLUSH_INTERVAL_MS })
    });
    context.onStop(() => service.dispose());
    return service.auditor;
  }
});
