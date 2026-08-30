import type { HostExtensionContext } from "../../../internal/host-extensions.js";
import { getSandInferenceBackendUrl } from "../../../shared/node/cursor-backend/cursor-inference.js";
import { createDashboardClient } from "../../../shared/node/marketplace/cursor-marketplace-client.js";
import { getSandRootDir } from "../../host-paths.js";
import {
  fetchSandManagedSkills,
  fetchSkillCatalog,
  type ManagedSkillsClient
} from "./cursor-skills-marketplace.js";
import type { ManagedSetupContext } from "./extension.js";
import { getManagedSkillsDir } from "./managed-skills-cache.js";
import { SandManagedSkillsService } from "./managed-skills-service.js";
import {
  createSandTeamRulesResolver,
  type TeamRulesClient
} from "./team-rules.js";

export type ManagedSetupDashboardClient = ManagedSkillsClient & TeamRulesClient;

type ProductionContext = HostExtensionContext<unknown> & {
  readonly deps: ManagedSetupContext["deps"];
};

/** Artifact construction at host-main.cjs:619817-619900. */
export function createManagedSetupProductionExtras(
  context: ProductionContext
): Omit<ManagedSetupContext, "deps" | "onStop"> {
  const auth = context.deps.auth;
  const bestEffortToken = async (): Promise<string | null> => {
    try {
      const token = await auth.getAccessToken({ backendUrl: getSandInferenceBackendUrl() });
      return token.length > 0 ? token : null;
    } catch {
      return null;
    }
  };
  const createClient = (): ManagedSetupDashboardClient => createDashboardClient(
    bestEffortToken,
    async () => auth.getMachineId()
  ) as unknown as ManagedSetupDashboardClient;

  return {
    createManagedSkills({ report }) {
      return new SandManagedSkillsService({
        getCacheDir: () => getManagedSkillsDir(getSandRootDir()),
        fetch: () => fetchSandManagedSkills({ client: createClient() }),
        report
      });
    },
    createTeamRules({ report }) {
      return createSandTeamRulesResolver({ client: createClient(), report });
    },
    fetchSkillCatalog: async () => await fetchSkillCatalog(
      createClient(),
      event => context.deps.telemetry?.logs.reportHostExtensionDiagnostic(event)
    )
  };
}
