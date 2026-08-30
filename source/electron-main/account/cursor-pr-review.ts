import { BackgroundComposerService } from "../../packages/proto/generated/aiserver/v1/background_composer_connect.js";
import { GetBackgroundComposerUserSettingsRequest } from "../../packages/proto/generated/aiserver/v1/background_composer_pb.js";
import { DashboardService } from "../../packages/proto/generated/aiserver/v1/dashboard_connect.js";
import { GetTeamAdminSettingsRequest } from "../../packages/proto/generated/aiserver/v1/dashboard_pb.js";
import { createSandCursorBackendClient } from "../../shared/node/cursor-backend/cursor-inference.js";
import { getOrCreateMachineId } from "./cursor-machine-id.js";

export const PR_REVIEW_REQUEST_TIMEOUT_MS = 10_000;
export type PrReviewDestination = "github" | "graphite" | "reviewCursor";
export interface SandPrReviewPreferences { readonly user: PrReviewDestination | undefined; readonly team: PrReviewDestination | undefined }
export type PrReviewAccessTokenReader = (options?: { readonly backendUrl?: string }) => Promise<string>;

export function narrowDestination(mode: number): PrReviewDestination | undefined {
  switch (mode) {
    case 1: return "github";
    case 2: return "graphite";
    case 3: return "reviewCursor";
    default: return undefined;
  }
}

export function teamDestination(response: {
  readonly pullRequestPreferences?: { readonly prReviewOpenDestination: number };
  readonly backgroundAgentSettings?: { readonly prReviewOpenDestination: number };
}): PrReviewDestination | undefined {
  return narrowDestination(response.pullRequestPreferences?.prReviewOpenDestination ?? 0)
    ?? narrowDestination(response.backgroundAgentSettings?.prReviewOpenDestination ?? 0);
}

async function fetchUserDestination(getAccessToken: PrReviewAccessTokenReader): Promise<PrReviewDestination | undefined> {
  const client = createSandCursorBackendClient(BackgroundComposerService, {
    getAccessToken,
    getMachineId: () => getOrCreateMachineId(),
  });
  const response = await client.getBackgroundComposerUserSettings(
    new GetBackgroundComposerUserSettingsRequest({}),
    { timeoutMs: PR_REVIEW_REQUEST_TIMEOUT_MS },
  );
  return narrowDestination(response.prReviewOpenDestination ?? 0);
}

async function fetchTeamDestination(getAccessToken: PrReviewAccessTokenReader): Promise<PrReviewDestination | undefined> {
  const client = createSandCursorBackendClient(DashboardService, {
    getAccessToken,
    getMachineId: () => getOrCreateMachineId(),
  });
  const response = await (client as unknown as {
    getTeamAdminSettingsOrEmptyIfNotInTeam(request: GetTeamAdminSettingsRequest, options: { readonly timeoutMs: number }): Promise<Parameters<typeof teamDestination>[0]>;
  }).getTeamAdminSettingsOrEmptyIfNotInTeam(
    new GetTeamAdminSettingsRequest({}),
    { timeoutMs: PR_REVIEW_REQUEST_TIMEOUT_MS },
  );
  return teamDestination(response);
}

export async function fetchSandPrReviewPreferences(
  getAccessToken: PrReviewAccessTokenReader,
  ports?: {
    readonly fetchUser: (getAccessToken: PrReviewAccessTokenReader, timeoutMs: number) => Promise<{ readonly prReviewOpenDestination: number }>;
    readonly fetchTeam: (getAccessToken: PrReviewAccessTokenReader, timeoutMs: number) => Promise<Parameters<typeof teamDestination>[0]>;
  }
): Promise<SandPrReviewPreferences> {
  if (ports === undefined) return await Promise.all([fetchUserDestination(getAccessToken), fetchTeamDestination(getAccessToken)]).then(([user, team]) => ({ user, team }));
  const [user, team] = await Promise.all([
    ports.fetchUser(getAccessToken, PR_REVIEW_REQUEST_TIMEOUT_MS).then((response) => narrowDestination(response.prReviewOpenDestination)),
    ports.fetchTeam(getAccessToken, PR_REVIEW_REQUEST_TIMEOUT_MS).then(teamDestination),
  ]);
  return { user, team };
}
