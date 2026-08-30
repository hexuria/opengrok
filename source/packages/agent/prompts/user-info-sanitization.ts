// Extracted from ../packages/agent/dist/prompts/user-info.js.
// Keep credential redaction independent from the broader user-info composition.
export function sanitizeRemoteUrlForPrompt(remoteUrl: string): string {
  const trimmedRemoteUrl = remoteUrl.trim();
  if (trimmedRemoteUrl === "") {
    return trimmedRemoteUrl;
  }
  try {
    const parsedRemoteUrl = new URL(trimmedRemoteUrl);
    parsedRemoteUrl.username = "";
    parsedRemoteUrl.password = "";
    return parsedRemoteUrl.toString();
  } catch {
    return trimmedRemoteUrl;
  }
}
