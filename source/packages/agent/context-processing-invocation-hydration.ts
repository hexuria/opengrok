import type { Context } from "../context/core.js";
import { InvocationContext, type InvocationContext as InvocationContextMessage } from "../proto/generated/agent/v1/selected_context_pb.js";

export interface InvocationContextBlobStore {
  getBlob(ctx: Context, blobId: Uint8Array): Promise<Uint8Array | undefined>;
}

export interface HydrateInvocationContextArgs {
  readonly ctx: Context;
  readonly invocationContext?: InvocationContextMessage | undefined;
  readonly blobStore?: InvocationContextBlobStore | undefined;
}

// Extracted from ../packages/agent/dist/context-processing.js as an exact
// invocation-reference hydration leaf. Invocation rendering and the parent
// processSelectedContext function remain absent.
export async function hydrateSelectedInvocationContext({
  ctx,
  invocationContext,
  blobStore,
}: HydrateInvocationContextArgs): Promise<InvocationContextMessage | undefined> {
  if (!invocationContext) {
    return undefined;
  }
  if (invocationContext.data.case === "blobId") {
    if (!blobStore) {
      throw new Error("Blob store is required to hydrate invocation context blob");
    }
    const blobData = await blobStore.getBlob(ctx, invocationContext.data.value);
    if (!blobData) {
      throw new Error("Invocation context blob not found");
    }
    return InvocationContext.fromBinary(blobData);
  }
  return invocationContext;
}
