import { resolveGeminiApiKey } from "./gemini-transcribe.js";

export const GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image";
const GEMINI_IMAGE_TIMEOUT_MS = 90_000;

export interface GeminiImageDeps {
  readonly fetch?: typeof fetch;
  readonly apiKey?: string | null;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Avatar generation for routed (Cursor-logged-out) sessions through the user's
 * own Gemini key — the same key the Dictation tab stores. Returns null when
 * the feature cannot run so the caller can surface the original Cursor error.
 */
export async function generateAvatarImageWithGemini(
  description: string,
  deps: GeminiImageDeps = {},
): Promise<{ imageData: string; mimeType: string } | null> {
  const apiKey = deps.apiKey !== undefined ? deps.apiKey : await resolveGeminiApiKey(deps);
  if (apiKey == null || apiKey.length === 0) return null;
  const env = deps.env ?? process.env;
  const model = env.SAND_GEMINI_IMAGE_MODEL?.trim() || GEMINI_IMAGE_MODEL;
  const run = deps.fetch ?? fetch;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GEMINI_IMAGE_TIMEOUT_MS);
    let response: Response;
    try {
      response = await run(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: `Generate a single square profile avatar image, centered subject, no text. ${description}` }] }],
          generationConfig: { responseModalities: ["IMAGE"] },
        }),
        signal: controller.signal,
      });
    } finally { clearTimeout(timer); }
    if (!response.ok) return null;
    const payload = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: unknown; data?: unknown } }> } }> };
    for (const part of payload.candidates?.[0]?.content?.parts ?? []) {
      const inline = part.inlineData;
      if (inline != null && typeof inline.data === "string" && inline.data.length > 0) {
        return { imageData: inline.data, mimeType: typeof inline.mimeType === "string" && inline.mimeType.length > 0 ? inline.mimeType : "image/png" };
      }
    }
    return null;
  } catch { return null; }
}
