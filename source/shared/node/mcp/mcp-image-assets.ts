import { generatedMcpResultFactory } from "./mcp-result-factory.js";

export interface McpContentItem {
  content: { case: string | undefined; value?: any };
}
export interface McpResultLike {
  result: { case: string | undefined; value?: any };
}
export interface McpResultFactory {
  textItem(text: string): McpContentItem;
  success<T extends McpResultLike>(original: T, content: McpContentItem[]): T;
}

export function describeSavedImage(image: {
  fileUrl: string;
  width?: number;
  height?: number;
}): string {
  const dimensions =
    image.width != null && image.height != null
      ? ` (${image.width}x${image.height})`
      : "";
  return `Saved this image to disk at ${image.fileUrl}${dimensions}. To show it to the user, pass that path to SendMessage as {"type":"attachment","url":"${image.fileUrl}"}.`;
}

export async function augmentMcpResultWithSavedImages<T extends McpResultLike>(
  result: T,
  persistImage: (
    data: string,
    mimeType: string,
  ) => Promise<{ fileUrl: string; width?: number; height?: number } | null>,
  factory: McpResultFactory = generatedMcpResultFactory,
): Promise<T> {
  if (result.result.case !== "success") return result;
  const success = result.result.value as { content: McpContentItem[] };
  if (!success.content.some((item) => item.content.case === "image"))
    return result;
  const augmented: McpContentItem[] = [];
  for (const item of success.content) {
    augmented.push(item);
    if (item.content.case !== "image") continue;
    const image = item.content.value as { data: string; mimeType: string };
    if (image.data.length === 0) continue;
    let saved = null;
    try {
      saved = await persistImage(image.data, image.mimeType);
    } catch {}
    if (saved != null)
      augmented.push(factory.textItem(describeSavedImage(saved)));
  }
  return factory.success(result, augmented);
}
