export function isValidAttachmentUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "file:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
