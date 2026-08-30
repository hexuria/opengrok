export interface DocumentationChunk {
  readonly docName: string;
  readonly pageUrl: string;
  readonly documentationChunk: string;
}

export interface DocumentationResult {
  readonly chunks: readonly DocumentationChunk[];
}

// Extracted from the documentation-rendering branch of
// ../packages/agent/dist/context-processing.js as an uncomposed leaf.
// The parent processSelectedContext function remains absent.
export function renderDocumentationContext(result: DocumentationResult | undefined): string | undefined {
  if (result === undefined || result.chunks.length === 0) {
    return undefined;
  }
  let docsText = `<documentation_context>
## Potentially Relevant Documentation:
-------
`;
  for (const chunk of result.chunks) {
    docsText += `Document Name: ${chunk.docName}
Document URL: ${chunk.pageUrl}
Document content:
${chunk.documentationChunk}
____

`;
  }
  docsText += `</documentation_context>`;
  return docsText;
}
