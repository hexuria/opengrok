export interface ExtraContextBlobStore<Context = unknown> {
  getBlob(ctx: Context, blobId: Uint8Array): Promise<Uint8Array | undefined>;
}

export type ExtraContextDataOrBlobId =
  | { readonly case: "data"; readonly value: string }
  | { readonly case: "blobId"; readonly value: Uint8Array }
  | { readonly case: undefined; readonly value?: undefined };

export interface ExtraContextEntry {
  readonly dataOrBlobId: ExtraContextDataOrBlobId;
}

export interface SelectedExtraContext {
  readonly extraContextEntries: readonly ExtraContextEntry[];
  readonly extraContext: readonly string[];
}

// Extracted from ../packages/agent/dist/context-processing.js as an
// uncomposed extra-context hydration leaf. The parent processSelectedContext
// function remains absent.
export async function hydrateSelectedExtraContext<Context>(
  ctx: Context,
  selectedContext: SelectedExtraContext,
  blobStore: ExtraContextBlobStore<Context> | undefined,
): Promise<string[]> {
  const extraContextsToInclude: string[] = [];
  const seenExtraContexts = new Set<string>();
  const textDecoder = new TextDecoder();
  const appendExtraContext = (value: string): void => {
    if (value.length === 0 || seenExtraContexts.has(value)) {
      return;
    }
    seenExtraContexts.add(value);
    extraContextsToInclude.push(value);
  };
  const hydratedExtraContextEntries = await Promise.all(
    selectedContext.extraContextEntries.map(async (entry) => {
      if (entry.dataOrBlobId.case === undefined) {
        return undefined;
      }
      if (entry.dataOrBlobId.case === "data") {
        return entry.dataOrBlobId.value;
      }
      if (entry.dataOrBlobId.case === "blobId") {
        if (!blobStore) {
          throw new Error("Blob store is required to hydrate extra context blob");
        }
        const blob = await blobStore.getBlob(ctx, entry.dataOrBlobId.value);
        if (!blob) {
          throw new Error("Extra context blob not found");
        }
        return textDecoder.decode(blob);
      }
      return undefined;
    }),
  );
  for (const extraContext of hydratedExtraContextEntries) {
    if (extraContext !== undefined) {
      appendExtraContext(extraContext);
    }
  }
  for (const extraContext of selectedContext.extraContext) {
    appendExtraContext(extraContext);
  }
  return extraContextsToInclude;
}
