export type SandPrReviewDestination = "github" | "graphite" | "reviewCursor";

export interface SandPrReviewPreferences {
  readonly user: SandPrReviewDestination | undefined;
  readonly team: SandPrReviewDestination | undefined;
}

export const NO_SAND_PR_REVIEW_PREFERENCES: SandPrReviewPreferences = {
  user: undefined,
  team: undefined,
};
