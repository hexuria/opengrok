import { reportDesktopEdgeFailure } from "../desktop-edge-failures.js";
import type { ElectronProductionAdapterBindings } from "../production-adapters.js";
import type { ProductionServiceContext } from "../main-production-services.js";
import { createProductionExperimentsAdapter } from "./experiments.js";
import { requireFunction } from "./provider-guards.js";

/**
 * Zero-input production composition for the emitted experiments runtime.
 *
 * Artifact anchor: main.cjs:506018, `var experimentsRuntime =
 * createExperimentsRuntime({`. The authenticated account service is created
 * earlier in the ready chain, and feature-flag overrides use the coordinator's
 * generated `setHostSettings` leg exactly as the shipped main process does.
 */
export function createElectronProductionExperimentsBinding():
  ElectronProductionAdapterBindings["experiments"] {
  const requirePushHostSettings = (context: ProductionServiceContext) =>
    requireFunction(
      context.coordinatorResync?.pushHostSettings,
      "experiments.coordinatorResync.pushHostSettings",
    );
  return createProductionExperimentsAdapter({
    async getAuthService(context: ProductionServiceContext) {
      const account = context.requireAccount();
      const getAuthService = requireFunction(
        account?.getAuthService,
        "experiments.account.getAuthService",
      );
      requirePushHostSettings(context);
      return await getAuthService.call(account);
    },
    async pushFeatureFlagOverrides(
      context: ProductionServiceContext,
      overrides: Record<string, unknown>,
    ) {
      const pushHostSettings = requirePushHostSettings(context);
      return await pushHostSettings({ featureFlagOverrides: overrides });
    },
    reportEdgeFailure: reportDesktopEdgeFailure,
  });
}
