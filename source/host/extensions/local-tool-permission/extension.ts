import { defineHostExtension } from "../../../internal/host-extensions.js";
import type { SandLocalToolPermission } from "../../../shared/local-tool-permission.js";
import { HostExtensions } from "../extension-ids.generated.js";
import { SandLocalToolPermissionController } from "./local-tool-permission-controller.js";
import { resolveLocalToolPermissionAsk, type LocalToolPermissionResolutionArgs, type LocalToolPermissionTranscript } from "./local-tool-permission-resolution.js";

interface SettingsApi { getLocalToolPermission(): SandLocalToolPermission; setLocalToolPermission(permission: "always" | "never"): void; }
interface TelemetryApi { readonly logs: { reportLocalToolPermissionStrandedRetirement(): void } }
interface PermissionHost { readonly events: { emit(topic: string, payload: unknown): Promise<void> }; readonly whenBackgroundWorkReady: Promise<void>; log(message: string): void; }
export type LocalToolPermissionExtensionApi = SandLocalToolPermissionController & { bindAskSurfaces(provider: (agentId: string) => boolean): void; bindLiveComputerCheck(provider: (agentId: string) => boolean): void; resolveAsk(args: LocalToolPermissionResolutionArgs): Promise<void>; };

export const localToolPermissionExtension = defineHostExtension<LocalToolPermissionExtensionApi, PermissionHost>({
  id: HostExtensions.LocalToolPermission, dependencies: [HostExtensions.Settings, HostExtensions.Telemetry, HostExtensions.Transcript],
  start: (context) => {
    const settings = context.deps[HostExtensions.Settings] as SettingsApi; const telemetry = context.deps[HostExtensions.Telemetry] as TelemetryApi; const transcript = context.deps[HostExtensions.Transcript] as LocalToolPermissionTranscript;
    let canAsk: (agentId: string) => boolean = () => false; let hasLiveComputer: (agentId: string) => boolean = () => false;
    const controller = new SandLocalToolPermissionController({ getPermission: () => settings.getLocalToolPermission(), setPermission: (permission) => settings.setLocalToolPermission(permission), onApprovalRetired: (approvalId) => { void context.host.events.emit("local-tool-permission.approval-retired", { approvalId }); }, canAsk: (agentId) => canAsk(agentId), hasLiveComputer: (agentId) => hasLiveComputer(agentId) });
    const bootSweepStartedAtMs = Date.now(); void context.host.whenBackgroundWorkReady.then(() => transcript.widgetResponses.expireAllPendingLocalToolPermissionCards?.({ ifPendingBeforeMs: bootSweepStartedAtMs }).catch(() => context.host.log("local-tool ask boot sweep failed")));
    return Object.assign(controller, { bindAskSurfaces: (provider: (agentId: string) => boolean) => { canAsk = provider; }, bindLiveComputerCheck: (provider: (agentId: string) => boolean) => { hasLiveComputer = provider; }, resolveAsk: (args: LocalToolPermissionResolutionArgs) => resolveLocalToolPermissionAsk({ asks: controller, transcript, onStrandedRetirement: () => telemetry.logs.reportLocalToolPermissionStrandedRetirement() }, args) });
  }
});
