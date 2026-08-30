export interface SummarizationImagePart {
  readonly image: unknown;
  readonly mimeType?: unknown;
}

export interface SummarizationToolExperimentalImage {
  readonly type?: unknown;
  readonly data?: unknown;
  readonly mimeType?: unknown;
}

export interface SummarizationMessagePart {
  readonly type?: unknown;
  readonly image?: unknown;
  readonly mimeType?: unknown;
  readonly experimental_content?: readonly SummarizationToolExperimentalImage[] | undefined;
}

export interface SummarizationImageMessage {
  readonly role: string;
  readonly content: string | readonly SummarizationMessagePart[];
}

const DEFAULT_IMAGE_MIME_TYPE = "image/png";
const DATA_OR_REMOTE_URL_PREFIX = /^(data:|https?:|blob:)/i;

function resolveImageMimeType(mimeType: unknown): string {
  const trimmed = (mimeType as string | null | undefined)?.trim();
  return trimmed !== undefined && trimmed !== "" ? trimmed : DEFAULT_IMAGE_MIME_TYPE;
}

export function toUserMessageImagePart(part: SummarizationImagePart): {
  type: "image";
  image: unknown;
  mimeType?: unknown;
} {
  if (typeof part.image !== "string") {
    return Object.assign(
      { type: "image" as const, image: part.image },
      part.mimeType !== undefined ? { mimeType: part.mimeType } : {},
    );
  }
  const image = DATA_OR_REMOTE_URL_PREFIX.test(part.image)
    ? part.image
    : `data:${resolveImageMimeType(part.mimeType)};base64,${part.image}`;
  return Object.assign(
    { type: "image" as const, image },
    part.mimeType !== undefined ? { mimeType: part.mimeType } : {},
  );
}

export function findLatestImagePart(messages: readonly SummarizationImageMessage[]): SummarizationImagePart | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "tool") {
      const content = message.content as readonly SummarizationMessagePart[];
      for (let partIndex = content.length - 1; partIndex >= 0; partIndex--) {
        const experimentalContent = content[partIndex]!.experimental_content;
        if (experimentalContent === undefined) continue;
        for (let itemIndex = experimentalContent.length - 1; itemIndex >= 0; itemIndex--) {
          const item = experimentalContent[itemIndex]!;
          if (item.type === "image" && typeof item.data === "string") {
            return Object.assign(
              { image: item.data },
              typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {},
            );
          }
        }
      }
      continue;
    }
    if (message.role === "user" && Array.isArray(message.content)) {
      for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex--) {
        const part = message.content[partIndex]!;
        if (part.type === "image") {
          return Object.assign(
            { image: part.image },
            part.mimeType !== undefined ? { mimeType: part.mimeType } : {},
          );
        }
      }
    }
  }
  return null;
}
