import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-local-whisper-"));
  const outfile = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/electron-main/account/local-whisper-transcribe.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    packages: "external",
  });
  const loaded = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

test("local whisper converts via ffmpeg then transcribes with the language tag", async () => {
  const { loaded, cleanup } = await load();
  try {
    const { transcribeWithLocalWhisper } = loaded;
    const calls = [];
    const result = await transcribeWithLocalWhisper(
      { audio: Uint8Array.from([1, 2, 3]), mimeType: "audio/webm;codecs=opus", language: "en-US" },
      {
        whisperCliPath: "/fake/whisper-cli",
        ffmpegPath: "/fake/ffmpeg",
        modelPath: "/fake/ggml-base.bin",
        execFile: async (file, args) => { calls.push({ file, args: [...args] }); return { stdout: " Hello there. \n" }; },
      },
    );
    assert.equal(result.text, "Hello there.");
    assert.equal(typeof result.transcriptionTimeMs, "number");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].file, "/fake/ffmpeg");
    assert.equal(calls[0].args.includes("16000"), true);
    assert.equal(calls[0].args.some((arg) => arg.endsWith("input.webm")), true);
    assert.equal(calls[1].file, "/fake/whisper-cli");
    assert.deepEqual(calls[1].args.slice(-2), ["-l", "en"]);
    assert.equal(calls[1].args.includes("--no-timestamps"), true);
  } finally {
    await cleanup();
  }
});

test("local whisper returns null when the CLI, model, or ffmpeg is missing", async () => {
  const { loaded, cleanup } = await load();
  try {
    const { transcribeWithLocalWhisper } = loaded;
    const base = { audio: Uint8Array.from([1]), mimeType: "audio/webm" };
    const fake = async () => ({ stdout: "x" });
    assert.equal(await transcribeWithLocalWhisper(base, { whisperCliPath: null, ffmpegPath: "/f", modelPath: "/m", execFile: fake }), null);
    assert.equal(await transcribeWithLocalWhisper(base, { whisperCliPath: "/w", ffmpegPath: null, modelPath: "/m", execFile: fake }), null);
    assert.equal(await transcribeWithLocalWhisper(base, { whisperCliPath: "/w", ffmpegPath: "/f", modelPath: null, execFile: fake }), null);
    const failing = async () => { throw new Error("boom"); };
    assert.equal(await transcribeWithLocalWhisper(base, { whisperCliPath: "/w", ffmpegPath: "/f", modelPath: "/m", execFile: failing }), null);
  } finally {
    await cleanup();
  }
});

test("mime extensions and language tags normalize", async () => {
  const { loaded, cleanup } = await load();
  try {
    const { audioFileExtension, whisperLanguageTag } = loaded;
    assert.equal(audioFileExtension("audio/webm;codecs=opus"), "webm");
    assert.equal(audioFileExtension("audio/mp4;codecs=mp4a.40.2"), "m4a");
    assert.equal(audioFileExtension("audio/wav"), "wav");
    assert.equal(audioFileExtension("application/octet-stream"), "bin");
    assert.equal(whisperLanguageTag("en-US"), "en");
    assert.equal(whisperLanguageTag("fil-PH"), "fil");
    assert.equal(whisperLanguageTag(undefined), null);
    assert.equal(whisperLanguageTag("!!"), null);
  } finally {
    await cleanup();
  }
});
