export interface UploadedDocumentInfo {
  readonly path: string;
}

// Extracted from the uploaded-documents branch of
// ../packages/agent/dist/context-processing.js as an uncomposed leaf.
// The parent processSelectedContext function remains absent.
export function renderUploadedDocumentsContext(
  documents: readonly UploadedDocumentInfo[],
): string | undefined {
  if (documents.length === 0) {
    return undefined;
  }
  const documentsList = documents.map((document) => `- ${document.path}`).join("\n");
  return `<uploaded_documents>
The following documents have been saved to your filesystem. You can read them using your file-reading tool or other tools:
${documentsList}
</uploaded_documents>`;
}
