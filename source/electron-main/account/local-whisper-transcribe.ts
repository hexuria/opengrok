import { execFile } from "node:child_process";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { getSandRootDir } from "../../host/host-paths.js";

const TRANSCRIBE_TIMEOUT_MS = 60_000;
const WHISPER_CLI_CANDIDATES = ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"];
const FFMPEG_CANDIDATES = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"];

export interface LocalWhisperDeps {
  readonly execFile?: (file: string, args: readonly string[], options: { timeout: number }) => Promise<{ stdout: string }>;
  readonly whisperCliPath?: string | null;
  readonly ffmpegPath?: string | null;
  readonly modelPath?: string | null;
  readonly env?: NodeJS.ProcessEnv;
}

async function firstAccessible(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* keep looking */ }
  }
  return null;
}

async function resolveWhisperCli(env: NodeJS.ProcessEnv): Promise<string | null> {
  const explicit = env.SAND_WHISPER_CLI?.trim();
  return explicit != null && explicit.length > 0 ? explicit : await firstAccessible(WHISPER_CLI_CANDIDATES);
}

async function resolveModel(env: NodeJS.ProcessEnv): Promise<string | null> {
  const explicit = env.SAND_WHISPER_MODEL?.trim();
  if (explicit != null && explicit.length > 0) return explicit;
  const modelDir = join(getSandRootDir(), "whisper");
  try {
    const models = (await readdir(modelDir)).filter((name) => name.startsWith("ggml-") && name.endsWith(".bin")).sort();
    const first = models[0];
    return first == null ? null : join(modelDir, first);
  } catch { return null; }
}

export function whisperLanguageTag(language: string | undefined): string | null {
  if (language == null) return null;
  const primary = language.split("-")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z]{2,3}$/.test(primary) ? primary : null;
}

export function audioFileExtension(mimeType: string): string {
  const bare = (mimeType.split(";")[0] ?? mimeType).trim().toLowerCase();
  if (bare === "audio/webm" || bare === "video/webm") return "webm";
  if (bare === "audio/mp4" || bare === "audio/m4a" || bare === "audio/x-m4a") return "m4a";
  if (bare === "audio/mpeg" || bare === "audio/mp3") return "mp3";
  if (bare === "audio/ogg") return "ogg";
  if (bare === "audio/wav" || bare === "audio/x-wav" || bare === "audio/wave") return "wav";
  return "bin";
}

/**
 * Offline speech-to-text for routed (Cursor-logged-out) sessions: the official
 * transcription needs a Cursor access token, so fall back to a local
 * whisper.cpp CLI (brew install whisper-cpp) with a ggml model stored under
 * sand-data/whisper. Recordings arrive as webm/opus, so ffmpeg resamples to
 * the 16 kHz mono wav whisper expects.
 */
export async function transcribeWithLocalWhisper(
  args: { readonly audio: Uint8Array; readonly mimeType: string; readonly language?: string },
  deps: LocalWhisperDeps = {},
): Promise<{ text: string; transcriptionTimeMs: number } | null> {
  const env = deps.env ?? process.env;
  const whisperCli = deps.whisperCliPath !== undefined ? deps.whisperCliPath : await resolveWhisperCli(env);
  const model = deps.modelPath !== undefined ? deps.modelPath : await resolveModel(env);
  const ffmpeg = deps.ffmpegPath !== undefined ? deps.ffmpegPath : env.SAND_FFMPEG?.trim() || await firstAccessible(FFMPEG_CANDIDATES);
  if (whisperCli == null || model == null || ffmpeg == null || args.audio.length === 0) return null;
  const run = deps.execFile ?? (async (file: string, cliArgs: readonly string[], options: { timeout: number }) => {
    const { stdout } = await promisify(execFile)(file, [...cliArgs], { timeout: options.timeout, maxBuffer: 16 * 1024 * 1024 });
    return { stdout };
  });
  const startedAtMs = Date.now();
  const workDir = await mkdtemp(join(tmpdir(), "sand-whisper-"));
  try {
    const inputPath = join(workDir, `input.${audioFileExtension(args.mimeType)}`);
    const wavPath = join(workDir, "input-16k.wav");
    await writeFile(inputPath, args.audio);
    await run(ffmpeg, ["-y", "-loglevel", "error", "-i", inputPath, "-ar", "16000", "-ac", "1", "-f", "wav", wavPath], { timeout: TRANSCRIBE_TIMEOUT_MS });
    const language = whisperLanguageTag(args.language);
    const { stdout } = await run(whisperCli, [
      "-m", model,
      "-f", wavPath,
      "--no-timestamps",
      ...(language == null ? [] : ["-l", language]),
    ], { timeout: TRANSCRIBE_TIMEOUT_MS });
    return { text: stdout.trim(), transcriptionTimeMs: Date.now() - startedAtMs };
  } catch { return null; }
  finally { await rm(workDir, { recursive: true, force: true }).catch(() => { /* best effort */ }); }
}
