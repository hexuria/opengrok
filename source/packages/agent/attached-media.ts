import { PrivacyMode, type PrivacyMode as PrivacyModeValue } from "../proto/generated/aiserver/v1/privacy_mode_pb.js";

const DEFAULT_INLINE_VIDEO_MAX_BYTES = 15 * 1024 * 1024;
const DEFAULT_SIGNED_URL_VIDEO_MAX_BYTES = 15 * 1024 * 1024;
export const GEMINI_VIDEO_SUBAGENT_MAX_BYTES = 1024 * 1024 * 1024;

interface AttachedMediaConfig {
  readonly featureFlags?: {
    readonly geminiVideoAttachmentInlineMaxBytes?: number;
    readonly geminiVideoAttachmentSignedUrlMaxBytes?: number;
  };
}

interface UploadAttachedMediaOptions {
  readonly data: BodyInit;
  readonly mimeType: string;
  readonly putUrl: string | URL;
  readonly signal?: AbortSignal;
}

export function getInlineVideoMaxBytes(config: AttachedMediaConfig): number {
  return config.featureFlags?.geminiVideoAttachmentInlineMaxBytes ?? DEFAULT_INLINE_VIDEO_MAX_BYTES;
}

export function getSignedUrlVideoMaxBytes(config: AttachedMediaConfig): number {
  return config.featureFlags?.geminiVideoAttachmentSignedUrlMaxBytes ?? DEFAULT_SIGNED_URL_VIDEO_MAX_BYTES;
}

export function isSignedUrlStorageAllowed(privacyMode: PrivacyModeValue): boolean {
  return privacyMode === PrivacyMode.NO_TRAINING ||
    privacyMode === PrivacyMode.USAGE_DATA_TRAINING_ALLOWED ||
    privacyMode === PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED;
}

export function isGeminiModelId(modelId: string | undefined): boolean {
  if (!modelId) {
    return false;
  }
  return modelId.toLowerCase().includes("gemini");
}

export async function uploadAttachedMediaToSignedUrl(options: UploadAttachedMediaOptions): Promise<void> {
  const body = options.data;
  const response = await fetch(options.putUrl, {
    method: "PUT",
    body,
    headers: {
      "Content-Type": options.mimeType,
    },
    signal: options.signal!,
  });
  if (!response.ok) {
    throw new Error(`Failed to upload attached media: ${response.status} ${response.statusText}`);
  }
}
