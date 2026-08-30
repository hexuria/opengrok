import { BaseMiddleware, type PromptExecutor } from "../base.js";
import { createLogger } from "../../context/logger.js";
import { MAX_IMAGE_SIZE_BYTES, resizeImageBufferIfNeeded } from "../../utils/image-resize.js";

type Loose = Record<string, any>;
const logger = createLogger("@anysphere/chat-inference/image-resizing-middleware");
export const IMAGE_RESIZE_CONCURRENCY = 4;

export async function resizeImagesInMessage(context: any, message: Loose): Promise<Loose> {
  if (message.role === "user") {
    if (typeof message.content === "string" || !Array.isArray(message.content)) return message;
    let hasUpdates = false;
    const content: Loose[] = [];
    for (const part of message.content as Loose[]) {
      if (part.type !== "image") {
        content.push(part);
        continue;
      }
      if (!(part.image instanceof Uint8Array)) {
        content.push(part);
        continue;
      }
      try {
        const resized = await resizeImageBufferIfNeeded(Buffer.from(part.image));
        const changed = resized.data.length !== part.image.length || resized.mimeType !== part.mimeType;
        if (changed) {
          hasUpdates = true;
          logger.info(context, "Resized image in user message", {
            originalSize: part.image.length,
            newSize: resized.data.length,
            newMimeType: resized.mimeType,
          });
          content.push({ ...part, image: resized.data, mimeType: resized.mimeType });
        } else content.push(part);
      } catch (error) {
        if (part.image.length > MAX_IMAGE_SIZE_BYTES) {
          hasUpdates = true;
          logger.error(context, "Failed to resize oversized image, dropping it", error, { originalSize: part.image.length });
          content.push({ type: "text", text: `[image omitted: failed to process ${part.image.length} bytes (${part.mimeType ?? "unknown"})]` });
        } else {
          logger.error(context, "Failed to resize image, keeping original", error);
          content.push(part);
        }
      }
    }
    return hasUpdates ? { ...message, content } : message;
  }

  if (message.role === "tool") {
    if (!Array.isArray(message.content)) return message;
    let messageHasUpdates = false;
    const content = [...message.content] as Loose[];
    for (let partIndex = 0; partIndex < message.content.length; partIndex += 1) {
      const part = message.content[partIndex] as Loose;
      if (part.type !== "tool-result" || !Array.isArray(part.experimental_content)) continue;
      let experimentalHasUpdates = false;
      const experimental = [...part.experimental_content] as Loose[];
      for (let expContentIndex = 0; expContentIndex < part.experimental_content.length; expContentIndex += 1) {
        const expPart = part.experimental_content[expContentIndex] as Loose;
        if (expPart.type !== "image" || typeof expPart.data !== "string") continue;
        let imageBuffer: Buffer;
        try {
          imageBuffer = Buffer.from(expPart.data, "base64");
        } catch (error) {
          logger.error(context, "Failed to decode base64 image in tool result", error, { partIndex, expContentIndex });
          continue;
        }
        try {
          const resized = await resizeImageBufferIfNeeded(imageBuffer);
          const changed = resized.data.length !== imageBuffer.length || resized.mimeType !== expPart.mimeType;
          if (changed) {
            experimentalHasUpdates = true;
            messageHasUpdates = true;
            logger.info(context, "Resized image in tool result", {
              partIndex,
              expContentIndex,
              originalSize: imageBuffer.length,
              newSize: resized.data.length,
              newMimeType: resized.mimeType,
            });
            experimental[expContentIndex] = { ...expPart, data: Buffer.from(resized.data).toString("base64"), mimeType: resized.mimeType };
          }
        } catch (error) {
          if (imageBuffer.length > MAX_IMAGE_SIZE_BYTES) {
            experimentalHasUpdates = true;
            messageHasUpdates = true;
            logger.error(context, "Failed to resize oversized image in tool result, dropping it", error, { partIndex, expContentIndex, originalSize: imageBuffer.length });
            experimental[expContentIndex] = { type: "text", text: `[image omitted: failed to process ${imageBuffer.length} bytes (${expPart.mimeType ?? "unknown"})]` };
          } else {
            logger.error(context, "Failed to resize image in tool result, keeping original", error, { partIndex, expContentIndex });
          }
        }
      }
      if (experimentalHasUpdates) content[partIndex] = { ...part, experimental_content: experimental };
    }
    if (messageHasUpdates) return { ...message, content };
  }
  return message;
}

export async function resizeImagesInMessages(context: any, messages: readonly Loose[]): Promise<Loose[]> {
  const results = new Array<Loose>(messages.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < messages.length) {
      const index = nextIndex++;
      results[index] = await resizeImagesInMessage(context, messages[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(IMAGE_RESIZE_CONCURRENCY, messages.length) }, worker));
  return results;
}

interface StreamResult {
  readonly fullStream: AsyncIterable<Loose>;
  readonly response: Promise<unknown>;
  readonly usage: Promise<unknown>;
  readonly providerMetadata: Promise<unknown>;
  readonly extendedUsage: Promise<unknown>;
  readonly invocationId: Promise<unknown>;
}

export class ImageResizingPromptExecutor extends BaseMiddleware<Loose> {
  override stream(context: any, invocationId?: string, tools?: readonly Loose[], options?: Loose): StreamResult {
    const messages = this.innerExecutor.getMessages();
    const processingPromise = (async (): Promise<StreamResult> => {
      const processed = await resizeImagesInMessages(context, messages);
      this.innerExecutor.clearMessages();
      this.innerExecutor.appendMessages(processed);
      return this.innerExecutor.stream(context, invocationId, tools, options) as StreamResult;
    })();
    return {
      fullStream: (async function*(): AsyncGenerator<Loose> {
        const result = await processingPromise;
        yield* result.fullStream;
      })(),
      response: processingPromise.then((result) => result.response),
      usage: processingPromise.then((result) => result.usage),
      providerMetadata: processingPromise.then((result) => result.providerMetadata),
      extendedUsage: processingPromise.then((result) => result.extendedUsage),
      invocationId: processingPromise.then((result) => result.invocationId),
    };
  }
}

export function createImageResizingMiddleware(): (executor: PromptExecutor<Loose>) => ImageResizingPromptExecutor {
  return (executor) => new ImageResizingPromptExecutor(executor);
}

export const imageResizingMiddleware = createImageResizingMiddleware();
