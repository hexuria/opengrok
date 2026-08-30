import path from "node:path";

import type { Context } from "../context/core.js";
import { createLogger } from "../context/logger.js";
import { writeExecutorResource } from "../agent-exec/write.js";
import { WriteArgs } from "../proto/generated/agent/v1/write_exec_pb.js";
import type { AttachmentPathRequestContext } from "./context-processing-path-trust.js";
import { sanitizeFilename } from "../utils/path-matchers.js";

interface CodeSelectionWriteExecutor {
  execute(ctx: Context, args: WriteArgs): Promise<unknown>;
}

export interface CodeSelectionResourceAccessor {
  get(resource: typeof writeExecutorResource): CodeSelectionWriteExecutor;
}

export interface WriteCodeSelectionToFileArgs {
  readonly ctx: Context;
  readonly content: string;
  readonly originalPath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly index: number;
  readonly requestContext: AttachmentPathRequestContext | undefined;
  readonly resourceAccessor: CodeSelectionResourceAccessor | undefined;
}

const logger = createLogger("@anysphere/agent/context-processing");

// Extracted from ../packages/agent/dist/context-processing.js as an
// uncomposed long-code-selection file-spill leaf. The parent
// processSelectedContext function remains absent.
export async function writeCodeSelectionToFile({
  ctx,
  content,
  originalPath,
  startLine,
  endLine,
  index,
  requestContext,
  resourceAccessor,
}: WriteCodeSelectionToFileArgs): Promise<{ path: string } | undefined> {
  const writeToUploadsDir = async (fileBytes: Uint8Array, safeFilename: string): Promise<{ path: string } | undefined> => {
    const projectFolder = requestContext?.env?.projectFolder;
    const workspaceRootPath = requestContext?.env?.workspacePaths?.[0];
    const documentRootPath = projectFolder ?? workspaceRootPath;
    if (!resourceAccessor || documentRootPath === undefined) {
      return undefined;
    }
    const uploadsDir = path.join(documentRootPath, "uploads");
    const filePath = path.join(uploadsDir, safeFilename);
    const writeExecutor = resourceAccessor.get(writeExecutorResource);
    await writeExecutor.execute(ctx, new WriteArgs({
      path: filePath,
      fileBytes: new Uint8Array(fileBytes),
      returnFileContentAfterWrite: false,
    }));
    return { path: filePath };
  };

  try {
    const originalBasename = path.basename(originalPath) || "selection";
    const originalExt = path.extname(originalBasename);
    const stem = originalExt.length > 0
      ? originalBasename.slice(0, -originalExt.length)
      : originalBasename;
    const safeStem = sanitizeFilename(stem) || "selection";
    const safeExt = originalExt.length > 0
      ? sanitizeFilename(originalExt.replace(/^\./, "")) || "txt"
      : "txt";
    const safeFilename = `${safeStem}-L${startLine}-L${endLine}-${index}.${safeExt}`;
    const fileBytes = new TextEncoder().encode(content);
    return await writeToUploadsDir(fileBytes, safeFilename);
  } catch (error) {
    logger.warn(ctx, "Failed to write long code selection to file", {
      originalPath,
      startLine,
      endLine,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
