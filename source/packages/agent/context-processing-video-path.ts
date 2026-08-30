import path from "node:path";

import type { Context } from "../context/core.js";
import {
  SelectedVideo,
  type SelectedVideo as SelectedVideoValue,
} from "../proto/generated/agent/v1/selected_context_pb.js";
import {
  resolveTrustedPathOnlyAttachmentPath,
  type AttachmentPathRequestContext,
} from "./context-processing-path-trust.js";

export interface ProcessSelectedVideoPathOnlyArgs {
  readonly ctx: Context;
  readonly selectedVideo: SelectedVideoValue;
  readonly requestContext: AttachmentPathRequestContext | undefined;
}

export interface ProcessedSelectedVideoPathOnly {
  readonly processedSelectedVideo: SelectedVideoValue | undefined;
  readonly videoData: undefined;
  readonly mimeType: string;
  readonly fps: number | undefined;
  readonly filename: string;
  readonly localFilePath: string | undefined;
}

// Extracted from ../packages/agent/dist/context-processing.js as the exact
// path-only video projection. Signed-URL RPC/fetch, blob/data processing,
// filesystem materialization, and the parent processSelectedContext dispatcher
// remain absent by design.
export async function processSelectedVideoPathOnly({
  ctx,
  selectedVideo,
  requestContext,
}: ProcessSelectedVideoPathOnlyArgs): Promise<ProcessedSelectedVideoPathOnly | undefined> {
  const readableVideoPath = selectedVideo.path.trim();
  const pathOnlyVideo = !selectedVideo.dataOrBlobId?.case
    ? await resolveTrustedPathOnlyAttachmentPath(ctx, readableVideoPath, requestContext, "video", true)
    : { hasPathOnlyPayload: false, trustedPath: undefined };
  const displayFilename = selectedVideo.filename;
  const mimeType = selectedVideo.mimeType;
  const fps = selectedVideo.fps;
  if (!pathOnlyVideo.hasPathOnlyPayload) {
    return undefined;
  }
  if (pathOnlyVideo.trustedPath === undefined) {
    return {
      processedSelectedVideo: undefined,
      videoData: undefined,
      mimeType,
      fps,
      filename: displayFilename,
      localFilePath: undefined,
    };
  }
  const trustedPathOnlyVideoPath = pathOnlyVideo.trustedPath;
  if (!mimeType || !mimeType.startsWith("video/")) {
    throw new Error(`Video attachments require a video/* mime type, got ${mimeType}`);
  }
  return {
    processedSelectedVideo: new SelectedVideo({
      ...selectedVideo,
      path: trustedPathOnlyVideoPath,
    }),
    videoData: undefined,
    mimeType,
    fps,
    localFilePath: trustedPathOnlyVideoPath,
    filename: displayFilename || path.basename(trustedPathOnlyVideoPath),
  };
}
