import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { getBoxSecretsStorePath } from "../../host/extensions/secrets/secrets-service.js";

export const GEMINI_TRANSCRIBE_MODEL = "gemini-3.5-transcribe";

/**
 * Measured behavior of gemini-3.5-transcribe on code-switched audio: with two
 * or more languageCodes (in any order) the model transcribes only the dominant
 * language and silently drops segments in the others, while a single
 * non-English hint keeps BOTH that language and English intact. English needs
 * no hint, so strip en-* whenever another language is selected.
 */
export function effectiveGeminiLanguageCodes(tags: readonly string[]): string[] {
  const nonEnglish = tags.filter((tag) => !tag.toLowerCase().startsWith("en"));
  return nonEnglish.length > 0 ? nonEnglish : [...tags];
}
const GEMINI_TRANSCRIBE_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TRANSCRIBE_MODEL}:generateContent`;
const GEMINI_TRANSCRIBE_TIMEOUT_MS = 60_000;
const FFMPEG_CANDIDATES = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"];

export interface GeminiTranscribeDeps {
  readonly fetch?: typeof fetch;
  readonly apiKey?: string | null;
  readonly ffmpegPath?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly readSecrets?: () => Promise<Record<string, string>>;
  /** Hint list for audioTranscriptionConfig.languageCodes (e.g. ["fil-PH", "en-US"]); empty means auto-detect. */
  readonly languageCodes?: readonly string[];
  /** Called with a short reason whenever the Gemini attempt cannot produce a transcript. */
  readonly onFailure?: (reason: string) => void;
}

async function persistedSecretRecord(): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(getBoxSecretsStorePath(), "utf8")) as { secrets?: unknown };
    const secrets = parsed?.secrets;
    if (typeof secrets !== "object" || secrets == null || Array.isArray(secrets)) return {};
    return Object.fromEntries(Object.entries(secrets).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch { return {}; }
}

export async function resolveGeminiApiKey(deps: Pick<GeminiTranscribeDeps, "env" | "readSecrets"> = {}): Promise<string | null> {
  const env = deps.env ?? process.env;
  const fromEnv = env.GEMINI_API_KEY?.trim();
  if (fromEnv != null && fromEnv.length > 0) return fromEnv;
  const secrets = await (deps.readSecrets ?? persistedSecretRecord)();
  const fromSecrets = secrets.GEMINI_API_KEY?.trim();
  return fromSecrets != null && fromSecrets.length > 0 ? fromSecrets : null;
}

async function firstAccessible(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* keep looking */ }
  }
  return null;
}

/** Gemini's audio understanding accepts flac/wav/mp3/ogg but not webm, so recordings are re-muxed to FLAC first (like Google's Jot sample app). */
async function toFlac(audio: Uint8Array, mimeType: string, ffmpegPath: string | null): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  const bare = (mimeType.split(";")[0] ?? mimeType).trim().toLowerCase();
  if (["audio/flac", "audio/wav", "audio/x-wav", "audio/mp3", "audio/mpeg", "audio/ogg", "audio/aac", "audio/aiff"].includes(bare)) {
    return { bytes: audio, mimeType: bare };
  }
  if (ffmpegPath == null) return null;
  const workDir = await mkdtemp(join(tmpdir(), "sand-gemini-audio-"));
  try {
    const inputPath = join(workDir, "input");
    const flacPath = join(workDir, "input.flac");
    await writeFile(inputPath, audio);
    await promisify(execFile)(ffmpegPath, ["-y", "-loglevel", "error", "-i", inputPath, "-ar", "16000", "-ac", "1", flacPath], { timeout: GEMINI_TRANSCRIBE_TIMEOUT_MS, windowsHide: true });
    return { bytes: new Uint8Array(await readFile(flacPath)), mimeType: "audio/flac" };
  } catch { return null; }
  finally { await rm(workDir, { recursive: true, force: true }).catch(() => { /* best effort */ }); }
}

/**
 * Speech-to-text through the user's own Gemini API key (Settings → Router →
 * Transcription). Works on the free AI Studio tier; returns null when the
 * feature cannot run so the caller can fall through to other transcribers.
 */
export async function transcribeWithGemini(
  args: { readonly audio: Uint8Array; readonly mimeType: string; readonly language?: string },
  deps: GeminiTranscribeDeps = {},
): Promise<{ text: string; transcriptionTimeMs: number } | null> {
  const fail = (reason: string): null => { deps.onFailure?.(reason); return null; };
  if (args.audio.length === 0) return fail("empty-audio");
  const apiKey = deps.apiKey !== undefined ? deps.apiKey : await resolveGeminiApiKey(deps);
  if (apiKey == null || apiKey.length === 0) return fail("no-api-key");
  const ffmpeg = deps.ffmpegPath !== undefined ? deps.ffmpegPath : (deps.env ?? process.env).SAND_FFMPEG?.trim() || await firstAccessible(FFMPEG_CANDIDATES);
  const audio = await toFlac(args.audio, args.mimeType, ffmpeg);
  if (audio == null) return fail("audio-conversion-failed");
  const startedAtMs = Date.now();
  const run = deps.fetch ?? fetch;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GEMINI_TRANSCRIBE_TIMEOUT_MS);
    let response: Response;
    try {
      response = await run(GEMINI_TRANSCRIBE_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        // The transcribe models ignore text prompts, and audioTranscriptionConfig
        // with wordTimestamp:true is mandatory — without it the transcript part
        // comes back empty (verified live; matches Google's Jot sample app).
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ inline_data: { mime_type: audio.mimeType, data: Buffer.from(audio.bytes).toString("base64") } }] }],
          generationConfig: {
            temperature: 0,
            audioTranscriptionConfig: {
              wordTimestamp: true,
              diarization: false,
              ...(deps.languageCodes != null && deps.languageCodes.length > 0 ? { languageCodes: effectiveGeminiLanguageCodes(deps.languageCodes) } : {}),
            },
          },
        }),
        signal: controller.signal,
      });
    } finally { clearTimeout(timer); }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return fail(`http-${response.status}${detail.length > 0 ? `: ${detail.slice(0, 200)}` : ""}`);
    }
    const payload = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> };
    const text = (payload.candidates ?? [])
      .flatMap((candidate) => candidate.content?.parts ?? [])
      .map((part) => typeof part.text === "string" ? part.text : "")
      .join("")
      .trim();
    return text.length === 0 ? fail("empty-transcript") : { text, transcriptionTimeMs: Date.now() - startedAtMs };
  } catch (error) { return fail(`request-failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`); }
}
