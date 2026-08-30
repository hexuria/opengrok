import { SAND_DEFAULT_MODEL_ID } from "../../../shared/agents/agent-model.js";
import { createCursorGenerateImageService } from "../../../shared/node/cursor-backend/cursor-generate-image.js";

export class SandGenerateImagePersistError extends Error {}
export interface GenerateImageAuth { readonly getAccessToken: () => Promise<string>; readonly getMachineId: () => Promise<string> }
export interface GeneratedImage { readonly imageData: string; readonly mimeType: string }
export interface PersistedImage { readonly absolutePath: string }
export function createSandGenerateImageService<Context>(auth: GenerateImageAuth, options: {
  readonly persistImage: (bytes: Uint8Array, mimeType: string) => Promise<PersistedImage | null>;
  readonly onRequestId?: (id: string) => void;
}) {
  const generateImage = createCursorGenerateImageService({
    getAccessToken: auth.getAccessToken,
    getMachineId: auth.getMachineId,
    modelId: process.env.SAND_AGENT_MODEL ?? SAND_DEFAULT_MODEL_ID,
    maxMode: true,
    ...(options.onRequestId === undefined ? {} : { onRequestId: options.onRequestId }),
  });
  return async (ctx: Context, description: string, _filePath: string, referenceImages: readonly { data: string; mimeType: string }[]) => {
    const generated = await generateImage(ctx, description, referenceImages);
    const persisted = await options.persistImage(Buffer.from(generated.imageData, "base64"), generated.mimeType);
    if (persisted == null) throw new SandGenerateImagePersistError("Failed to save the generated image into the agent's media store.");
    return { filePath: persisted.absolutePath, imageData: generated.imageData };
  };
}
