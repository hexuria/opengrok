import { RequestedFilePathRejectedReason } from "../proto/generated/agent/v1/record_screen_exec_pb.js";

export function sanitizeToolCallId(toolCallId: string): string {
  return toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function validateAndNormalizeSaveAsFilename(saveAsFilename: string, artifactsDir: string):
  | { readonly success: true; readonly filename: string }
  | { readonly success: false; readonly reason: RequestedFilePathRejectedReason } {
  let filename = saveAsFilename.trim();
  if (filename.startsWith(artifactsDir)) {
    filename = filename.slice(artifactsDir.length);
    if (filename.startsWith("/")) {
      filename = filename.slice(1);
    }
  }
  filename = filename.trim();
  if (filename.length === 0) {
    return { success: false, reason: RequestedFilePathRejectedReason.UNSPECIFIED };
  }
  if (filename.includes("/") || filename.includes("\\")) {
    return { success: false, reason: RequestedFilePathRejectedReason.SLASHES_NOT_ALLOWED };
  }
  filename = filename.replace(/[^a-zA-Z0-9 ._-]/g, "_");
  filename = filename.trim();
  if (filename.length === 0) {
    return { success: false, reason: RequestedFilePathRejectedReason.UNSPECIFIED };
  }
  if (filename.length > 128) {
    filename = filename.slice(0, 128).trim();
  }
  if (!filename.toLowerCase().endsWith(".mp4")) {
    filename = `${filename}.mp4`;
  }
  return { success: true, filename };
}
