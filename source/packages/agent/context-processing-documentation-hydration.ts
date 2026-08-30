import type { Context } from "../context/core.js";
import type { SelectedDocumentation } from "../proto/generated/agent/v1/selected_context_pb.js";

export interface DocumentationIdentifier {
  readonly docId: string;
  readonly name: string;
}

export interface DocumentationHydrationService<TResult = unknown> {
  hydrateDocumentation(
    ctx: Context,
    documentationIdentifiers: readonly DocumentationIdentifier[],
    conversationQuery: unknown,
  ): Promise<TResult>;
}

export interface HydrateDocumentationArgs<TResult = unknown> {
  readonly ctx: Context;
  readonly documentations: readonly SelectedDocumentation[];
  readonly documentationHydrationService: DocumentationHydrationService<TResult>;
  readonly conversationQuery: unknown;
}

// Extracted from ../packages/agent/dist/context-processing.js as an exact
// documentation-service hydration leaf. Documentation rendering and the
// parent processSelectedContext function remain absent.
export async function hydrateSelectedDocumentation<TResult>({
  ctx,
  documentations,
  documentationHydrationService,
  conversationQuery,
}: HydrateDocumentationArgs<TResult>): Promise<TResult | undefined> {
  if (documentations.length === 0) {
    return undefined;
  }
  const documentationIdentifiers = documentations.map(doc => ({
    docId: doc.docId,
    name: doc.name,
  }));
  return documentationHydrationService.hydrateDocumentation(ctx, documentationIdentifiers, conversationQuery);
}
