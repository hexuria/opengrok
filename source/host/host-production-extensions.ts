import {
  defineHostExtension,
  type HostExtensionContext,
  type HostExtensionDeclaration
} from "../internal/host-extensions.js";
import { actionAuditExtension } from "./extensions/action-audit/extension.js";
import { attachmentsExtension } from "./extensions/attachments/extension.js";
import { authExtension } from "./extensions/auth/extension.js";
import { autoReviewExtension } from "./extensions/auto-review/extension.js";
import { automationsExtension } from "./extensions/automations/extension.js";
import { boxLifecycleExtension } from "./extensions/box-lifecycle/extension.js";
import { boxStoreSyncExtension } from "./extensions/box-store-sync/extension.js";
import { browserUaExtension } from "./extensions/browser-ua/extension.js";
import { cloudAgentsExtension } from "./extensions/cloud-agents/extension.js";
import { codebaseTelemetryExtension } from "./extensions/codebase-telemetry/extension.js";
import { contentSearchExtension } from "./extensions/content-search/extension.js";
import { crossUserSharingExtension } from "./extensions/cross-user-sharing/extension.js";
import { experimentsExtension } from "./extensions/experiments/extension.js";
import { HostExtensions, type HostExtensionId } from "./extensions/extension-ids.generated.js";
import { foreverBoxExtension } from "./extensions/forever-box/extension.js";
import { hostUpgradeExtension } from "./extensions/host-upgrade/extension.js";
import { inferenceExtension, type InferenceExtensionContext } from "./extensions/inference/extension.js";
import { createInferenceProductionExtras } from "./extensions/inference/production.js";
import { createLocalExecExtension } from "./extensions/local-exec/extension.js";
import { localToolPermissionExtension } from "./extensions/local-tool-permission/extension.js";
import { managedSetupExtension, type ManagedSetupContext } from "./extensions/managed-setup/extension.js";
import { createManagedSetupProductionExtras } from "./extensions/managed-setup/production.js";
import { mcpExtension, type McpExtensionContext } from "./extensions/mcp/extension.js";
import { createMcpProductionExtras } from "./extensions/mcp/production.js";
import { memoryExtension, type MemoryExtensionContext } from "./extensions/memory/extension.js";
import { createMemoryProductionExtras } from "./extensions/memory/production.js";
import { notificationsExtension } from "./extensions/notifications/extension.js";
import { notifyBusExtension } from "./extensions/notify-bus/extension.js";
import { createSecretsExtension } from "./extensions/secrets/extension.js";
import { sessionExtension, type SessionExtensionContext } from "./extensions/session/extension.js";
import { createSessionProductionExtras } from "./extensions/session/production.js";
import { settingsExtension } from "./extensions/settings/extension.js";
import { sourceMapExtension } from "./extensions/source-map/extension.js";
import { createStateBackstopExtension } from "./extensions/state-backstop/extension.js";
import { teachRecordingExtension } from "./extensions/teach-recording/extension.js";
import { telemetryExtension } from "./extensions/telemetry/extension.js";
import { transcriptExtension } from "./extensions/transcript/extension.js";
import { traysExtension } from "./extensions/trays/extension.js";
import { turnExecutionExtension } from "./extensions/turn-execution/extension.js";
import { wallpaperExtension } from "./extensions/wallpaper/extension.js";
import { webauthnProxyExtension } from "./extensions/webauthn-proxy/extension.js";
import type { ProductionSandHostPorts } from "./sand-host.js";

type DeclarationLike = {
  readonly id: string;
  readonly dependencies: readonly string[];
  start(context: any): unknown;
};

type BoundExtras = Readonly<Record<string, unknown>>;
type BoundExtrasSource<Host> = BoundExtras | ((context: HostExtensionContext<Host>) => BoundExtras);

function bindDeclaration<Host>(
  declaration: DeclarationLike,
  extras: BoundExtrasSource<Host> = {}
): HostExtensionDeclaration<unknown, Host> {
  return defineHostExtension({
    id: declaration.id,
    dependencies: declaration.dependencies,
    async start(context: HostExtensionContext<Host>) {
      const bound = typeof extras === "function" ? extras(context) : extras;
      const api = await declaration.start({ ...bound, ...context });
      return api;
    }
  });
}

export interface RecoveredProductionExtensionBindings {
  readonly stateBackstop: Parameters<typeof createStateBackstopExtension>[0];
  readonly localExecCodec: Parameters<typeof createLocalExecExtension>[0];
  readonly secretsContext: Parameters<typeof createSecretsExtension>[0];
}

/**
 * The artifact's concrete 35-slot extension table. The arguments correspond
 * only to generated clients or capsule-external codecs/services.
 */
export function createRecoveredProductionExtensionRegistry<Host extends { log(message: string): void }>(
  bindings: RecoveredProductionExtensionBindings
): Record<HostExtensionId, HostExtensionDeclaration<unknown, Host>> {
  const bind = (
    declaration: DeclarationLike,
    extras?: BoundExtrasSource<Host>
  ) => bindDeclaration<Host>(declaration, extras);

  return {
    [HostExtensions.Notifications]: bind(notificationsExtension),
    [HostExtensions.ContentSearch]: bind(contentSearchExtension),
    [HostExtensions.Memory]: bind(memoryExtension, context => createMemoryProductionExtras(context as Parameters<typeof createMemoryProductionExtras>[0])),
    [HostExtensions.CrossUserSharing]: bind(crossUserSharingExtension),
    [HostExtensions.StateBackstop]: bind(createStateBackstopExtension(bindings.stateBackstop)),
    [HostExtensions.SourceMap]: bind(sourceMapExtension),
    [HostExtensions.Telemetry]: bind(telemetryExtension),
    [HostExtensions.Trays]: bind(traysExtension),
    [HostExtensions.Auth]: bind(authExtension),
    [HostExtensions.Experiments]: bind(experimentsExtension),
    [HostExtensions.BrowserUa]: bind(browserUaExtension),
    [HostExtensions.Inference]: bind(inferenceExtension, context => createInferenceProductionExtras(context as Parameters<typeof createInferenceProductionExtras>[0])),
    [HostExtensions.LocalExec]: bind(createLocalExecExtension(bindings.localExecCodec)),
    [HostExtensions.LocalToolPermission]: bind(localToolPermissionExtension),
    [HostExtensions.Attachments]: bind(attachmentsExtension),
    [HostExtensions.ForeverBox]: bind(foreverBoxExtension),
    [HostExtensions.Secrets]: bind(createSecretsExtension(bindings.secretsContext)),
    [HostExtensions.TurnExecution]: bind(turnExecutionExtension),
    [HostExtensions.Transcript]: bind(transcriptExtension),
    [HostExtensions.Session]: bind(sessionExtension, context => createSessionProductionExtras(context as unknown as Parameters<typeof createSessionProductionExtras>[0])),
    [HostExtensions.Automations]: bind(automationsExtension),
    [HostExtensions.Settings]: bind(settingsExtension),
    [HostExtensions.BoxLifecycle]: bind(boxLifecycleExtension),
    [HostExtensions.ManagedSetup]: bind(managedSetupExtension, context => createManagedSetupProductionExtras(context as Parameters<typeof createManagedSetupProductionExtras>[0])),
    [HostExtensions.Mcp]: bind(mcpExtension, context => createMcpProductionExtras(context as unknown as Parameters<typeof createMcpProductionExtras>[0])),
    [HostExtensions.BoxStoreSync]: bind(boxStoreSyncExtension),
    [HostExtensions.CloudAgents]: bind(cloudAgentsExtension),
    [HostExtensions.ActionAudit]: bind(actionAuditExtension),
    [HostExtensions.HostUpgrade]: bind(hostUpgradeExtension),
    [HostExtensions.AutoReview]: bind(autoReviewExtension),
    [HostExtensions.CodebaseTelemetry]: bind(codebaseTelemetryExtension),
    [HostExtensions.TeachRecording]: bind(teachRecordingExtension),
    [HostExtensions.WebauthnProxy]: bind(webauthnProxyExtension),
    [HostExtensions.NotifyBus]: bind(notifyBusExtension),
    [HostExtensions.Wallpaper]: bind(wallpaperExtension)
  };
}

/** Binds the concrete recovered table into the remaining generated host ports. */
export function bindRecoveredProductionExtensions<
  Ports extends Omit<ProductionSandHostPorts, "extensionsById">
>(
  ports: Ports,
  bindings: RecoveredProductionExtensionBindings
): Ports & Pick<ProductionSandHostPorts, "extensionsById"> {
  return {
    ...ports,
    extensionsById: createRecoveredProductionExtensionRegistry(bindings)
  };
}
