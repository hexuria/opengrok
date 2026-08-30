import { defineHostExtension } from "../../../internal/host-extensions.js";
import { HostExtensions } from "../extension-ids.generated.js";
import { createAttachmentsService, type AttachmentsServiceDependencies } from "./attachments-service.js";

export const attachmentsExtension = defineHostExtension({
  id: HostExtensions.Attachments,
  dependencies: [HostExtensions.Auth, HostExtensions.ForeverBox, HostExtensions.Telemetry],
  start: (context) => {
    const deps = context.deps as { auth: AttachmentsServiceDependencies<unknown>["auth"]; "forever-box": { box: AttachmentsServiceDependencies<unknown>["box"] }; telemetry: { logs: { reportHostExtensionDiagnostic(value: Record<string, unknown>): void } } };
    return createAttachmentsService({ auth: deps.auth, box: deps["forever-box"].box, ctx: {}, report: (diagnostic) => deps.telemetry.logs.reportHostExtensionDiagnostic(diagnostic) });
  }
});
