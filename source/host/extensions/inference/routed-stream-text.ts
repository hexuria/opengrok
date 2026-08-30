export function streamTextDelta(event: {
  readonly type?: string;
  readonly textDelta?: unknown;
  readonly text?: unknown;
  readonly delta?: unknown;
  readonly error?: unknown;
}): string {
  if (event.type === "error") {
    const error = event.error;
    throw error instanceof Error ? error : new Error(typeof error === "string" && error.length > 0 ? error : "The model stream failed.");
  }
  if (event.type !== "text-delta") return "";
  if (typeof event.textDelta === "string" && event.textDelta.length > 0) return event.textDelta;
  if (typeof event.text === "string" && event.text.length > 0) return event.text;
  if (typeof event.delta === "string" && event.delta.length > 0) return event.delta;
  return "";
}

export function emptyRoutedReplyMessage(providerLabel: string): string {
  return `${providerLabel} returned no text. Try again, or pick another model in Settings → Router.`;
}
