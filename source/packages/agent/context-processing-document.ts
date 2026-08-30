import path from "node:path";

import type { Context } from "../context/core.js";
import { createLogger } from "../context/logger.js";
import { WriteArgs } from "../proto/generated/agent/v1/write_exec_pb.js";
import {
  SelectedDocument,
  type SelectedDocument as SelectedDocumentValue,
} from "../proto/generated/agent/v1/selected_context_pb.js";
import { writeExecutorResource } from "../agent-exec/write.js";
import {
  hydrateSelectedAttachmentData,
  type AttachmentBlobStore,
} from "./context-processing-hydration.js";
import { getSafeErrorType } from "./context-processing-error-type.js";
import { appendRandomUploadSuffix } from "./context-processing-attachment-format.js";
import {
  resolveTrustedPathOnlyAttachmentPath,
  type AttachmentPathRequestContext,
} from "./context-processing-path-trust.js";

interface DocumentWriteExecutor {
  execute(ctx: Context, args: WriteArgs): Promise<unknown>;
}

export interface DocumentResourceAccessor {
  get(resource: typeof writeExecutorResource): DocumentWriteExecutor;
}

export interface ProcessSelectedDocumentAttachmentArgs {
  readonly ctx: Context;
  readonly blobStore: AttachmentBlobStore<Context> | undefined;
  readonly selectedDocument: SelectedDocumentValue;
  readonly index: number;
  readonly requestContext: AttachmentPathRequestContext | undefined;
  readonly resourceAccessor: DocumentResourceAccessor | undefined;
}

export interface ProcessedSelectedDocumentAttachment {
  readonly selectedDocument: SelectedDocumentValue | undefined;
  readonly docData: Uint8Array | undefined;
  readonly mimeType: string;
  readonly filename: string;
  readonly documentFilePath: string | undefined;
}

const logger = createLogger("@anysphere/agent/context-processing");

// Extracted from ../packages/agent/dist/context-processing.js as an
// uncomposed document-processing media leaf. The parent processSelectedContext
// function remains absent.
export async function processSelectedDocumentAttachment({
  ctx,
  blobStore,
  selectedDocument,
  index,
  requestContext,
  resourceAccessor,
}: ProcessSelectedDocumentAttachmentArgs): Promise<ProcessedSelectedDocumentAttachment> {
  const selectedDocPath = selectedDocument.path.trim();
  const trimmedFilename = selectedDocument.filename.trim();
  const readablePath = selectedDocPath || (path.isAbsolute(trimmedFilename) ? trimmedFilename : "");
  const displayFilename = trimmedFilename && !path.isAbsolute(trimmedFilename)
    ? trimmedFilename
    : path.basename(readablePath);
  const hydratedDocument = await hydrateSelectedAttachmentData({
    ctx,
    blobStore: blobStore!,
    attachment: selectedDocument,
    dataOrBlobId: selectedDocument.dataOrBlobId,
    missingBlobError: "Document not found in blob store",
    sizeErrorLabel: "Document",
    withBlobId: (blobId: Uint8Array) => new SelectedDocument({
      ...selectedDocument,
      dataOrBlobId: {
        case: "blobId",
        value: blobId,
      },
    }),
  });
  const docData = hydratedDocument.data;
  let processedSelectedDocument = hydratedDocument.processedAttachment;
  const pathOnlyDocument = !selectedDocument.dataOrBlobId?.case
    ? await resolveTrustedPathOnlyAttachmentPath(
      ctx,
      readablePath,
      requestContext,
      "document",
      false,
    )
    : { hasPathOnlyPayload: false, trustedPath: undefined };
  if (pathOnlyDocument.trustedPath !== undefined) {
    processedSelectedDocument = new SelectedDocument({
      ...selectedDocument,
      path: pathOnlyDocument.trustedPath,
    });
  }
  let documentFilePath: string | undefined;
  const filename = displayFilename || `document-${Date.now()}-${index}`;
  if (docData) {
    const projectFolder = requestContext?.env?.projectFolder;
    const workspaceRootPath = requestContext?.env?.workspacePaths?.[0];
    const documentRootPath = projectFolder ?? workspaceRootPath;
    if (resourceAccessor && documentRootPath !== undefined) {
      try {
        const safeFilename = appendRandomUploadSuffix(filename, `document-${Date.now()}-${index}`);
        const uploadsDir = path.join(documentRootPath, "uploads");
        const filePath = path.join(uploadsDir, safeFilename);
        const writeExecutor = resourceAccessor.get(writeExecutorResource);
        await writeExecutor.execute(ctx, new WriteArgs({
          path: filePath,
          fileBytes: new Uint8Array(docData),
          returnFileContentAfterWrite: false,
        }));
        documentFilePath = filePath;
        processedSelectedDocument = new SelectedDocument({
          ...(processedSelectedDocument ?? selectedDocument),
          path: filePath,
        });
      } catch (error) {
        logger.warn(ctx, "Failed to write document to filesystem", {
          errorType: getSafeErrorType(error),
        });
        processedSelectedDocument = undefined;
      }
    }
  } else if (!docData && processedSelectedDocument && pathOnlyDocument.trustedPath !== undefined) {
    documentFilePath = pathOnlyDocument.trustedPath;
  }
  if (docData && documentFilePath === undefined) {
    processedSelectedDocument = undefined;
  }
  return {
    selectedDocument: processedSelectedDocument,
    docData,
    mimeType: selectedDocument.mimeType,
    filename,
    documentFilePath,
  };
}
