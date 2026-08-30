import { AiService } from "../../../packages/proto/generated/aiserver/v1/aiserver_connect.js";
import { GenerateImageReferenceImage, RunGenerateImageRequest } from "../../../packages/proto/generated/aiserver/v1/aiserver_pb.js";
import { createSandCursorBackendClient, type SandInferenceOptions } from "./cursor-inference.js";

export class SandGenerateImageError extends Error {}
export class SandGenerateImageModelRestrictedError extends Error { constructor(message: string) { super(message); this.name = "SandGenerateImageModelRestrictedError"; } }

export function createCursorGenerateImageService(options: Omit<SandInferenceOptions, "backendUrl"> & { readonly modelId: string; readonly maxMode?: boolean }) {
  const client = createSandCursorBackendClient(AiService, options);
  return async (_context: unknown, description: string, referenceImages?: readonly { data: string; mimeType: string }[]) => {
    const response = await client.runGenerateImage(new RunGenerateImageRequest({
      description,
      referenceImages: (referenceImages ?? []).map((image) => new GenerateImageReferenceImage({ data: image.data, mimeType: image.mimeType })),
      modelId: options.modelId,
      maxMode: options.maxMode ?? false,
    }));
    switch (response.result.case) {
      case "success": return { imageData: response.result.value.imageData, mimeType: response.result.value.mimeType };
      case "error": if (response.result.value.modelRestricted) throw new SandGenerateImageModelRestrictedError(response.result.value.error); throw new SandGenerateImageError(response.result.value.error);
      case undefined: throw new SandGenerateImageError("Image generation returned no result.");
    }
  };
}
