function valueContainsImagePart(value: unknown, depth: number): boolean {
  if (depth > 6 || value === null || typeof value !== "object") return false;
  if ("type" in value && value.type === "image") return true;
  if (Array.isArray(value)) return value.some((item) => valueContainsImagePart(item, depth + 1));
  return Object.values(value).some((nested) => nested !== null && typeof nested === "object" && valueContainsImagePart(nested, depth + 1));
}

export function coreMessageJsonHasImage(message: unknown): boolean {
  if (message === null || typeof message !== "object" || !("content" in message) || !Array.isArray(message.content)) return false;
  return message.content.some((part) => valueContainsImagePart(part, 0));
}

interface CoreMessageImagePresenceInput { readonly role?: unknown; readonly content?: unknown }

export function computeCoreMessageImagePresence(orderedMessages: readonly CoreMessageImagePresenceInput[]): { containsImage: boolean; suffixNumberOfTurnsWithoutImages: number } {
  let suffixNumberOfTurnsWithoutImages = 0;
  for (let index = orderedMessages.length - 1; index >= 0; index--) {
    const message = orderedMessages[index]!;
    if (coreMessageJsonHasImage(message)) return { containsImage: true, suffixNumberOfTurnsWithoutImages };
    if (message.role === "user") suffixNumberOfTurnsWithoutImages++;
  }
  return { containsImage: false, suffixNumberOfTurnsWithoutImages };
}
