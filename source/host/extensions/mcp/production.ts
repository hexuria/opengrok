import type { HostExtensionContext } from "../../../internal/host-extensions.js";
import {
  createRealPollingPolicy
} from "../../../internal/scheduling.js";
import { getSandInferenceBackendUrl } from "../../../shared/node/cursor-backend/cursor-inference.js";
import { cleanupLegacyMcpAuthCredentials } from "../../../shared/node/mcp/mcp-auth-cleanup.js";
import type { CapableBox } from "../../box/box-capabilities.js";
import { getSandRootDir } from "../../host-paths.js";
import type { McpExtensionContext, McpPluginSkillsService } from "./extension.js";
import {
  removeWorkflowLiveReferences,
  sweepLegacyPluginSkillReferences,
  type LegacyReferenceSweepDeps
} from "./legacy-live-references.js";
import {
  createMcpService,
  type McpHostService,
  type PluginSkillsPort
} from "./mcp-service.js";
import {
  createSharedInstalledPluginsLoader,
  SandPluginSkillsService,
  toPluginSkillInfo,
  PLUGIN_SKILLS_REFRESH_INTERVAL_MS
} from "./plugin-skills.js";
import {
  SandSkillPublishService,
  createSandSkillPublishClient,
  type SandSkillPublishServiceOptions,
} from "./skill-publish.js";

export interface McpProductionAuth {
  getAccessToken(args: { backendUrl: string }): Promise<string>;
  getMachineId(): Promise<string>;
  peekAccessToken(): string | null;
  subscribeToRenewal(listener: (event: { outcome: string; isFirstCredential?: boolean }) => void): () => void;
}

interface McpProductionDeps {
  auth: McpProductionAuth;
  experiments: { isSparsePluginClonesEnabled(): boolean };
  "forever-box": { readonly box: CapableBox };
  settings: unknown;
  telemetry: {
    logs: {
      reportMcpDiscoveryFailed(event: unknown): void;
      reportConnectorAuth(event: unknown): void;
      reportPluginSkillsSync(event: unknown): void;
      reportSkillPublishEdgeFailed(event: unknown): void;
    };
  };
}

type ProductionContext = HostExtensionContext<{ log(message: string): void }> & {
  readonly deps: McpProductionDeps;
};

/** Artifact construction at host-main.cjs:624398-624511. */
export function createMcpProductionExtras(
  context: ProductionContext
): Omit<McpExtensionContext, "deps" | "onStop"> {
  const sandRootDir = getSandRootDir();
  const auth = context.deps.auth;
  const log = (message: string): void => context.host.log(message);
  const pluginPort = (service: McpPluginSkillsService): PluginSkillsPort => ({
    sync: async (trigger) => (await service.sync(trigger)).map(record => toPluginSkillInfo(record)),
    status: () => ({ authBlocked: service.currentAuthBlocked() }),
    removeLiveReferences: (sourceUrls) => removeWorkflowLiveReferences(sandRootDir, sourceUrls)
  });

  return {
    createPluginSkills() {
      return new SandPluginSkillsService({
        sandRootDir,
        load: createSharedInstalledPluginsLoader({
          sandRootDir,
          auth,
          isSparsePluginClonesEnabled: () => context.deps.experiments.isSparsePluginClonesEnabled(),
          log
        }),
        log,
        reportSync: event => context.deps.telemetry.logs.reportPluginSkillsSync(event)
      });
    },
    createPolling: () => createRealPollingPolicy({
      name: "sand-plugin-skills-refresh",
      intervalMs: PLUGIN_SKILLS_REFRESH_INTERVAL_MS
    }),
    createService(pluginSkills) {
      const service: McpHostService = createMcpService({
        auth,
        foreverBox: context.deps["forever-box"],
        settings: context.deps.settings,
        pluginSkills: pluginPort(pluginSkills),
        onDiscoveryFailed: event => context.deps.telemetry.logs.reportMcpDiscoveryFailed(event),
        onConnectorAuth: event => context.deps.telemetry.logs.reportConnectorAuth(event),
        log
      });
      return service;
    },
    createSkillPublish(pluginSkills) {
      const options: SandSkillPublishServiceOptions = {
        sandRootDir,
        client: createSandSkillPublishClient({ auth }),
        pluginSkills,
        log,
        reportEdgeFailed: event => context.deps.telemetry.logs.reportSkillPublishEdgeFailed(event)
      };
      return new SandSkillPublishService(options);
    },
    cleanupLegacyAuth: async () => {
      return await cleanupLegacyMcpAuthCredentials(sandRootDir);
    },
    sweepLegacyReferences: async () => {
      await sweepLegacyPluginSkillReferences({
        sandRootDir,
        auth,
        backendUrl: getSandInferenceBackendUrl(),
        log
      });
    }
  };
}
