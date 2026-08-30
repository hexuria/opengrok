import { fetchSandAccess } from "../account/access.js";
import { createCursorAccountEdgePort, createTranscriptionManagerEnsure, type AccountRuntime } from "../account/cursor-auth-wiring.js";
import { resolveCursorAvatarDataUrl } from "../account/cursor-avatar.js";
import {
  cancelSandTrial,
  fetchSandUsageSummary,
  fetchSandWeeklyUsage,
  fetchUserPrivacyModeEnabled,
  invokeSandDashboardAction,
} from "../account/cursor-profile.js";
import { fetchSandPrReviewPreferences } from "../account/cursor-pr-review.js";
import type { ProductionServiceContext } from "../main-production-services.js";
import type { ElectronProductionAdapterBindings } from "../production-adapters.js";
import { DashboardService } from "../../packages/proto/generated/aiserver/v1/dashboard_connect.js";
import { createSandCursorBackendClient } from "../../shared/node/cursor-backend/cursor-inference.js";
import { SAND_PRODUCT_DISPLAY_NAME } from "../../shared/product-name.js";
import type { SandAccessBackend } from "../account/access.js";

function accountRuntimeOf(context: Pick<ProductionServiceContext, "requireCoordinator">): AccountRuntime | null | undefined {
  try {
    const runtime = context.requireCoordinator().getAccountRuntime?.();
    if (runtime != null && typeof (runtime as { observe?: unknown }).observe === "function" && typeof (runtime as { whenIdle?: unknown }).whenIdle === "function") {
      return runtime as AccountRuntime;
    }
  } catch {
    // The immutable root constructs the edge before the coordinator. Runtime
    // lookup remains lazy until an account operation actually settles.
  }
  return null;
}

function machineId(context: Pick<ProductionServiceContext, "machineId">): () => Promise<string> {
  return async () => context.machineId;
}

/** Artifact anchor: main.cjs:506294, `cursorAccount: createCursorAccountEdgePort({`. */
export function createElectronProductionCursorAccountBinding(): ElectronProductionAdapterBindings["cursorAccount"] {
  return {
    create(context) {
      const getMachineId = machineId(context);
      return createCursorAccountEdgePort({
        ensureCursorAuthService: () => context.requireAccount().getAuthService(),
        currentAuthStatusFreshness: () => context.requireAccount().currentAuthStatusFreshness(),
        getAccountRuntime: () => accountRuntimeOf(context),
        readSandAccess: (getAccessToken) => fetchSandAccess(getAccessToken, {
          createClient: (credentials) => createSandCursorBackendClient(DashboardService, credentials) as unknown as SandAccessBackend,
          getMachineId,
        }),
        resetMcpManager: () => context.requireMcp().resetMcpManager(),
        refreshHostMcp: () => context.requireMcp().refreshHostMcp(),
        resolveAvatar: (authId, preferredUrl) => resolveCursorAvatarDataUrl(authId, { ...(preferredUrl == null ? {} : { preferredUrl }) }),
        fetchWeeklyUsage: (getAccessToken) => fetchSandWeeklyUsage(getAccessToken, { getMachineId }),
        isUsagePageEnabled: () => context.requireExperiments().checkFeatureGate("sand_usage_page"),
        fetchUsageSummary: (getAccessToken) => fetchSandUsageSummary(getAccessToken, { getMachineId }),
        fetchPrReviewPreferences: (getAccessToken) => fetchSandPrReviewPreferences(getAccessToken),
        fetchPrivacyModeEnabled: (getAccessToken) => fetchUserPrivacyModeEnabled(getAccessToken, { getMachineId }),
        cancelTrial: (getAccessToken) => cancelSandTrial(getAccessToken, { getMachineId }),
        invokeDashboardAction: (getAccessToken, request) => invokeSandDashboardAction(getAccessToken, request, { getMachineId }),
        productDisplayName: SAND_PRODUCT_DISPLAY_NAME,
      });
    },
    createTranscriptionManager(context) {
      return createTranscriptionManagerEnsure({
        ensureCursorAuthService: () => context.requireAccount().getAuthService(),
        getMachineId: machineId(context),
      });
    },
  };
}
