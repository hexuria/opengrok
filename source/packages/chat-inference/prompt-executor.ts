export interface TextResult { content: Array<{ type: "text"; text: string }>; isError: boolean }
export interface ImageResult { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; isError: boolean }
export function createStringResult(content: string, isError = false): TextResult { return { content: [{ type: "text", text: content }], isError }; }
export function createImageResult(imageData: string, mimeType: string, textContent?: string, isError = false): ImageResult {
  const content: ImageResult["content"] = [];
  if (textContent) content.push({ type: "text", text: textContent });
  content.push({ type: "image", data: imageData, mimeType });
  return { content, isError };
}
export class OutputTokensLimitExceededError extends Error { constructor(message = "Provider exceeded max output tokens") { super(message); this.name = "OutputTokensLimitExceededError"; } }
export class InputTokenLimitError extends Error { constructor(message = "Input token limit exceeded") { super(message); this.name = "InputTokenLimitError"; } }
export class ProactiveSummarizationThresholdError extends Error { constructor(message = "Configured summarization threshold reached") { super(message); this.name = "ProactiveSummarizationThresholdError"; } }
