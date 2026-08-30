import path from "node:path";

import type { Context } from "../context/core.js";
import { WriteArgs } from "../proto/generated/agent/v1/write_exec_pb.js";
import { writeExecutorResource } from "../agent-exec/write.js";
import { sanitizeFilename } from "../utils/path-matchers.js";

interface ImageWriteExecutor {
  execute(ctx: Context, args: WriteArgs): Promise<unknown>;
}

export interface ImageResourceAccessor {
  get(resource: typeof writeExecutorResource): ImageWriteExecutor;
}

export interface SelectedImageFilePathInput {
  readonly ctx: Context;
  readonly imageData: Uint8Array | undefined;
  readonly selectedImage: {
    readonly path?: string | undefined;
    readonly uuid?: string | undefined;
  };
  readonly resolvedMimeType: string;
  readonly index: number;
  readonly enableImageFiles: boolean;
  readonly requestContext: {
    readonly env?: {
      readonly projectFolder?: string | undefined;
      readonly workspacePaths: readonly string[];
    } | undefined;
  } | undefined;
  readonly resourceAccessor: ImageResourceAccessor | undefined;
}

// Extracted from ../packages/agent/dist/context-processing.js as an
// uncomposed selected-image file-spill/path leaf. The parent image processor
// and processSelectedContext function remain absent.
export function writeSelectedImageToProjectAssets({
  ctx,
  imageData,
  selectedImage,
  resolvedMimeType,
  index,
  enableImageFiles,
  requestContext,
  resourceAccessor,
}: SelectedImageFilePathInput): string | undefined {
  let imageFilePath: string | undefined;
  if (imageData) {
    if (enableImageFiles && resourceAccessor && requestContext?.env !== undefined &&
      requestContext.env.projectFolder !== undefined && requestContext.env.projectFolder !== "") {
      try {
        const mimeType = resolvedMimeType;
        const originalPath = selectedImage.path;
        const extensionFromPath = originalPath !== undefined
          ? path.extname(originalPath).replace(/^\./, "").toLowerCase()
          : undefined;
        let extension = "png";
        if (extensionFromPath && extensionFromPath !== "") {
          extension = extensionFromPath === "jpeg" ? "jpg" : extensionFromPath;
        } else if (mimeType.includes("jpeg") || mimeType.includes("jpg")) {
          extension = "jpg";
        } else if (mimeType.includes("gif")) {
          extension = "gif";
        } else if (mimeType.includes("webp")) {
          extension = "webp";
        }
        const originalFilename = originalPath !== undefined ? path.basename(originalPath) : undefined;
        const baseFilename = originalFilename !== undefined && originalFilename !== ""
          ? path.basename(originalFilename, path.extname(originalFilename))
          : selectedImage.uuid || `image-${Date.now()}-${index}`;
        const safeBaseFilename = sanitizeFilename(baseFilename) || `image-${Date.now()}-${index}`;
        const fileName = `${safeBaseFilename}.${extension}`;
        const workspaceRoot = requestContext.env.workspacePaths[0];
        if (workspaceRoot !== undefined && originalPath !== undefined && originalPath !== "") {
          const normalizedOriginalPath = path.normalize(originalPath);
          const normalizedWorkspaceRoot = path.normalize(workspaceRoot);
          const relativePath = path.relative(normalizedWorkspaceRoot, normalizedOriginalPath);
          if (!relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
            imageFilePath = normalizedOriginalPath;
          }
        }
        if (imageFilePath === undefined) {
          const projectFolder = requestContext.env.projectFolder;
          const assetsDir = path.join(projectFolder, "assets");
          const filePath = path.join(assetsDir, fileName);
          imageFilePath = filePath;
          const writeExecutor = resourceAccessor.get(writeExecutorResource);
          void writeExecutor.execute(ctx, new WriteArgs({
            path: filePath,
            fileBytes: new Uint8Array(imageData),
            returnFileContentAfterWrite: false,
          })).then(() => {}).catch(() => {});
        }
      } catch (_error) {}
    }
  }
  return imageFilePath;
}
