import type { Context } from "../context/core.js";
import {
  SelectedGitPRDiffSelection,
  SelectedPullRequest,
  type SelectedGitPRDiffSelection as SelectedGitPRDiffSelectionMessage,
  type SelectedPullRequest as SelectedPullRequestMessage,
} from "../proto/generated/agent/v1/selected_context_pb.js";

export interface PrHydrationBlobStore {
  getBlob(ctx: Context, blobId: Uint8Array): Promise<Uint8Array | undefined>;
}

export interface HydrateSelectedPullRequestsArgs {
  readonly ctx: Context;
  readonly selectedPullRequests: readonly SelectedPullRequestMessage[];
  readonly blobStore?: PrHydrationBlobStore | undefined;
}

export interface HydrateGitPrDiffSelectionsArgs {
  readonly ctx: Context;
  readonly gitPrDiffSelections: readonly SelectedGitPRDiffSelectionMessage[];
  readonly blobStore?: PrHydrationBlobStore | undefined;
}

// Extracted from ../packages/agent/dist/context-processing.js as the exact
// selected-PR and PR-diff blob hydration pair. The parent enrichment task and
// processSelectedContext function remain absent.
export async function hydrateSelectedPullRequests({
  ctx,
  selectedPullRequests,
  blobStore,
}: HydrateSelectedPullRequestsArgs): Promise<SelectedPullRequestMessage[]> {
  return Promise.all(selectedPullRequests.map(async pr => {
    if (pr.blobId !== undefined && pr.blobId.length > 0) {
      if (!blobStore) {
        throw new Error("Blob store is required to hydrate selected pull request blob");
      }
      const blobData = await blobStore.getBlob(ctx, pr.blobId);
      if (!blobData) {
        throw new Error("Selected pull request blob not found");
      }
      return SelectedPullRequest.fromBinary(blobData);
    }
    return pr;
  }));
}

export async function hydrateGitPrDiffSelections({
  ctx,
  gitPrDiffSelections,
  blobStore,
}: HydrateGitPrDiffSelectionsArgs): Promise<SelectedGitPRDiffSelectionMessage[]> {
  return Promise.all(gitPrDiffSelections.map(async selection => {
    if (selection.blobId !== undefined && selection.blobId.length > 0) {
      if (!blobStore) {
        throw new Error("Blob store is required to hydrate git PR diff selection blob");
      }
      const blobData = await blobStore.getBlob(ctx, selection.blobId);
      if (!blobData) {
        throw new Error("Git PR diff selection blob not found");
      }
      return SelectedGitPRDiffSelection.fromBinary(blobData);
    }
    return selection;
  }));
}
