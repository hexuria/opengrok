import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { repoRoot } from "./lib/config.mjs";

// The five shipped upstream tones are Cursor's assets and are deliberately not
// redistributed here (docs/PUBLISHING.md). These are self-authored stand-ins
// synthesised from first principles so the checked-in payload carries no
// third-party rights. Output is deterministic: rerunning the script must emit
// byte-identical files, so nothing here may read a clock or a random source.
const SAMPLE_RATE = 48_000;
const BITS_PER_SAMPLE = 16;
const PEAK = 0.72;

const outputDir = path.join(repoRoot, "frontend", "src", "recovered", "assets", "sounds");

function encodeWav(samples) {
  const dataBytes = samples.length * (BITS_PER_SAMPLE / 8);
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * (BITS_PER_SAMPLE / 8), 28);
  buffer.writeUInt16LE(BITS_PER_SAMPLE / 8, 32);
  buffer.writeUInt16LE(BITS_PER_SAMPLE, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    buffer.writeInt16LE(Math.round(clamped * 32_767), 44 + index * 2);
  }
  return buffer;
}

function render(durationMs, voice) {
  const count = Math.round(SAMPLE_RATE * durationMs / 1_000);
  const samples = new Float64Array(count);
  for (let index = 0; index < count; index += 1) samples[index] = voice(index / SAMPLE_RATE);
  return samples;
}

/**
 * Both edges of every tone are ramped. Without the ramps a 16-bit PCM buffer
 * that starts or stops mid-cycle clicks audibly on playback, which is exactly
 * the artefact these short tones would otherwise be mistaken for.
 */
function edgeGain(seconds, durationSeconds) {
  const attack = 0.0015;
  const release = 0.004;
  const rise = Math.min(1, seconds / attack);
  const fall = Math.min(1, Math.max(0, durationSeconds - seconds) / release);
  return rise * fall;
}

function decay(seconds, halfLifeSeconds) {
  return Math.pow(2, -seconds / halfLifeSeconds);
}

function sine(seconds, hertz) {
  return Math.sin(2 * Math.PI * hertz * seconds);
}

/** A rising blip: one glide from the lower to the upper partial. */
function openBlip(durationSeconds) {
  const startHertz = 740;
  const endHertz = 1_480;
  const sweep = Math.log(endHertz / startHertz) / durationSeconds;
  return (seconds) => {
    // Integrating the exponential glide keeps the phase continuous; stepping the
    // frequency per sample instead would fold audible steps into the sweep.
    const phase = 2 * Math.PI * startHertz * (Math.exp(sweep * seconds) - 1) / sweep;
    return PEAK * Math.sin(phase) * decay(seconds, durationSeconds * 0.55) * edgeGain(seconds, durationSeconds);
  };
}

/** A dry tick: one high partial damped almost immediately. */
function tick(durationSeconds, hertz) {
  return (seconds) => PEAK * (sine(seconds, hertz) * 0.8 + sine(seconds, hertz * 2.02) * 0.2)
    * decay(seconds, durationSeconds * 0.22) * edgeGain(seconds, durationSeconds);
}

function doubleTick(durationSeconds, gapSeconds, hitSeconds, hertz) {
  const hit = tick(hitSeconds, hertz);
  return (seconds) => {
    const second = seconds - gapSeconds;
    const first = seconds < hitSeconds ? hit(seconds) : 0;
    const echo = second >= 0 && second < hitSeconds ? hit(second) * 0.82 : 0;
    return (first + echo) * edgeGain(seconds, durationSeconds);
  };
}

/**
 * A struck chime: a fundamental plus inharmonic partials that fade faster than
 * it does, which is what separates a bell from a plain sustained tone.
 */
function chime(durationSeconds, fundamentalHertz, partials) {
  return (seconds) => {
    let value = 0;
    for (const [ratio, weight, halfLife] of partials) {
      value += weight * sine(seconds, fundamentalHertz * ratio) * decay(seconds, durationSeconds * halfLife);
    }
    return PEAK * value * edgeGain(seconds, durationSeconds);
  };
}

const TONES = [
  { id: "ping-1-open-blip", durationMs: 70, voice: openBlip(0.07) },
  { id: "ping-2-tick", durationMs: 28, voice: tick(0.028, 2_100) },
  { id: "ping-3-double-tick", durationMs: 88, voice: doubleTick(0.088, 0.048, 0.026, 2_400) },
  {
    id: "ping-4-chime-a",
    durationMs: 250,
    voice: chime(0.25, 880, [[1, 0.6, 0.42], [2.76, 0.26, 0.2], [5.4, 0.14, 0.1]]),
  },
  {
    id: "ping-5-chime-b",
    durationMs: 250,
    voice: chime(0.25, 1_174.66, [[1, 0.55, 0.38], [2.4, 0.28, 0.18], [3.9, 0.17, 0.09]]),
  },
];

await mkdir(outputDir, { recursive: true });
for (const tone of TONES) {
  const file = path.join(outputDir, `${tone.id}.wav`);
  const wav = encodeWav(render(tone.durationMs, tone.voice));
  await writeFile(file, wav);
  console.log(`Wrote ${path.relative(repoRoot, file)} (${tone.durationMs} ms, ${wav.byteLength} bytes).`);
}
