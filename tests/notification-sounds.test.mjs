import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const soundsDir = path.join(repoRoot, "frontend/src/recovered/assets/sounds");

async function loadModule(entry, outfileName, options = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-notification-sounds-"));
  const output = path.join(temporary, outfileName);
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    ...options,
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

const SOUND_IDS = ["ping-1-open-blip", "ping-2-tick", "ping-3-double-tick", "ping-4-chime-a", "ping-5-chime-b"];

test("notification preference guards accept only the five shipped ids and repair everything else", async () => {
  const loaded = await loadModule("source/shared/notification-sound.ts", "notification-sound.mjs");
  try {
    const shared = loaded.module;
    assert.deepEqual([...shared.SAND_NOTIFICATION_SOUND_IDS], SOUND_IDS);
    assert.deepEqual(shared.DEFAULT_NOTIFICATION_PREFERENCES, { playSound: true, sound: "ping-1-open-blip" });

    for (const id of SOUND_IDS) assert.equal(shared.isSandNotificationSoundId(id), true);
    for (const value of ["ping-6-nope", "", null, undefined, 1, {}]) {
      assert.equal(shared.isSandNotificationSoundId(value), false);
    }

    assert.equal(shared.isSandNotificationPreferences({ playSound: false, sound: "ping-2-tick" }), true);
    for (const value of [
      null,
      undefined,
      "ping-2-tick",
      [],
      { sound: "ping-2-tick" },
      { playSound: true },
      { playSound: "yes", sound: "ping-2-tick" },
      { playSound: true, sound: "ping-6-nope" },
    ]) {
      assert.equal(shared.isSandNotificationPreferences(value), false);
    }

    assert.deepEqual(shared.normalizeNotificationPreferences(undefined), shared.DEFAULT_NOTIFICATION_PREFERENCES);
    assert.deepEqual(shared.normalizeNotificationPreferences([]), shared.DEFAULT_NOTIFICATION_PREFERENCES);
    // Each field is repaired on its own so one bad key does not discard the other.
    assert.deepEqual(shared.normalizeNotificationPreferences({ playSound: false }), { playSound: false, sound: "ping-1-open-blip" });
    assert.deepEqual(shared.normalizeNotificationPreferences({ sound: "ping-5-chime-b" }), { playSound: true, sound: "ping-5-chime-b" });
    assert.deepEqual(shared.normalizeNotificationPreferences({ playSound: 1, sound: "ping-6-nope" }), shared.DEFAULT_NOTIFICATION_PREFERENCES);
    assert.deepEqual(shared.normalizeNotificationPreferences({ playSound: false, sound: "ping-3-double-tick", extra: 1 }), { playSound: false, sound: "ping-3-double-tick" });
  } finally {
    await loaded.dispose();
  }
});

test("the settings store round-trips notification preferences and defaults an older settings file", async () => {
  const loaded = await loadModule("source/shared/node/settings/sand-settings-store.ts", "sand-settings-store.mjs");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-notification-settings-"));
  try {
    const settingsPath = path.join(temporary, "settings.json");
    const store = new loaded.module.SandSettingsStore(settingsPath);

    // A settings file written before the key existed keeps the shipped default.
    store.persist(loaded.module.emptySettings());
    assert.deepEqual(store.getDesktopNotificationPreferences(), { playSound: true, sound: "ping-1-open-blip" });

    store.setDesktopNotificationPreferences({ playSound: false, sound: "ping-4-chime-a" });
    assert.deepEqual(store.getDesktopNotificationPreferences(), { playSound: false, sound: "ping-4-chime-a" });
    assert.deepEqual(
      JSON.parse(await readFile(settingsPath, "utf8")).desktopNotificationPreferences,
      { playSound: false, sound: "ping-4-chime-a" },
    );

    // A sound id this build no longer knows drops the key rather than throwing.
    const stored = JSON.parse(await readFile(settingsPath, "utf8"));
    await writeFile(settingsPath, JSON.stringify({ ...stored, desktopNotificationPreferences: { playSound: false, sound: "ping-9-retired" } }), "utf8");
    assert.deepEqual(store.getDesktopNotificationPreferences(), { playSound: true, sound: "ping-1-open-blip" });
    assert.equal(store.load().egressTunnelEnabled, false);

    // Writes normalize, so a partial value cannot land in the file.
    store.setDesktopNotificationPreferences({ sound: "ping-2-tick" });
    assert.deepEqual(store.getDesktopNotificationPreferences(), { playSound: true, sound: "ping-2-tick" });
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await loaded.dispose();
  }
});

function notificationHarness(manager, extraDeps = {}) {
  const created = [];
  const window = { isFocused: () => false, isMinimized: () => false, restore: () => {}, show: () => {}, focus: () => {} };
  const notifications = new manager({
    getWindow: () => window,
    isSupported: () => true,
    createNotification: (options) => {
      created.push(options);
      return { on: () => {}, once: () => {}, show: () => {}, close: () => {} };
    },
    openAgent: () => {},
    now: () => 1_000,
    ...extraDeps,
  });
  return { created, notifications };
}

function needsInputRun(manager, extraDeps = {}) {
  const harness = notificationHarness(manager, extraDeps);
  const agent = { id: "a1", name: "Scout", isRunning: true, notifyOnUpdatesEnabled: true, lastMessageId: "m1", lastMessagePreview: "working" };
  harness.notifications.handleAgentsEvent({ agents: [agent] });
  harness.notifications.handleAgentsEvent({ agents: [{ ...agent, awaitingUserResponse: { reason: "Pick a branch" } }] });
  return harness;
}

function doneRun(manager, extraDeps = {}) {
  const harness = notificationHarness(manager, extraDeps);
  const agent = { id: "a2", name: "Scout", isRunning: true, notifyOnUpdatesEnabled: true, lastMessageId: "m1", lastMessagePreview: "working" };
  harness.notifications.handleAgentsEvent({ agents: [agent] });
  harness.notifications.handleAgentsEvent({ agents: [{ ...agent, isRunning: false, lastMessageId: "m2", lastMessagePreview: "Shipped the patch" }] });
  return harness;
}

test("the notification manager is unchanged when the sound dependencies are omitted", async () => {
  const loaded = await loadModule("source/electron-main/notifications/os-notification-manager.ts", "os-notification-manager.mjs");
  try {
    const manager = loaded.module.SandOsNotificationManager;

    const bare = needsInputRun(manager);
    assert.deepEqual(bare.created, [{ title: "Scout needs you", body: "Pick a branch", silent: false, urgency: "critical" }]);

    const bareDone = doneRun(manager);
    assert.deepEqual(bareDone.created, [{ title: "Scout", body: "Shipped the patch", silent: true, urgency: "normal" }]);

    // With the gate closed, or with only some of the deps supplied, every
    // notification argument matches the run that supplies none of them.
    const gateOffSounds = [];
    const gateOff = needsInputRun(manager, {
      playSound: (sound) => gateOffSounds.push(sound),
      getPreferences: () => ({ playSound: true, sound: "ping-3-double-tick" }),
      isSoundsFeatureEnabled: () => false,
    });
    assert.deepEqual(gateOff.created, bare.created);
    assert.deepEqual(gateOffSounds, []);

    const noPlayer = needsInputRun(manager, {
      getPreferences: () => ({ playSound: true, sound: "ping-3-double-tick" }),
      isSoundsFeatureEnabled: () => true,
    });
    assert.deepEqual(noPlayer.created, bare.created);
  } finally {
    await loaded.dispose();
  }
});

test("an enabled sound preference silences the OS chime and plays the chosen tone", async () => {
  const loaded = await loadModule("source/electron-main/notifications/os-notification-manager.ts", "os-notification-manager.mjs");
  try {
    const manager = loaded.module.SandOsNotificationManager;

    const played = [];
    const on = needsInputRun(manager, {
      playSound: (sound) => played.push(sound),
      getPreferences: () => ({ playSound: true, sound: "ping-3-double-tick" }),
      isSoundsFeatureEnabled: () => true,
    });
    assert.deepEqual(on.created, [{ title: "Scout needs you", body: "Pick a branch", silent: true, urgency: "critical" }]);
    assert.deepEqual(played, ["ping-3-double-tick"]);

    const doneSounds = [];
    const done = doneRun(manager, {
      playSound: (sound) => doneSounds.push(sound),
      getPreferences: () => ({ playSound: true, sound: "ping-5-chime-b" }),
      isSoundsFeatureEnabled: () => true,
    });
    assert.deepEqual(done.created, [{ title: "Scout", body: "Shipped the patch", silent: true, urgency: "normal" }]);
    assert.deepEqual(doneSounds, ["ping-5-chime-b"]);

    // The gate is on but the user turned sounds off: the OS chime comes back.
    const mutedSounds = [];
    const muted = needsInputRun(manager, {
      playSound: (sound) => mutedSounds.push(sound),
      getPreferences: () => ({ playSound: false, sound: "ping-3-double-tick" }),
      isSoundsFeatureEnabled: () => true,
    });
    assert.deepEqual(muted.created, [{ title: "Scout needs you", body: "Pick a branch", silent: false, urgency: "critical" }]);
    assert.deepEqual(mutedSounds, []);
  } finally {
    await loaded.dispose();
  }
});

test("the main edge reads notification preferences freely but refuses writes behind the closed gate", async () => {
  const loaded = await loadModule("source/electron-main/main-edge.ts", "main-edge.mjs");
  try {
    let stored = { playSound: true, sound: "ping-1-open-blip" };
    let featureGates = {};
    const handlers = loaded.module.createMainEdgeHandlers({
      settingsStore: {
        getDesktopNotificationPreferences: () => stored,
        setDesktopNotificationPreferences: (value) => { stored = value; },
      },
      experiments: { ensureService: () => ({ getSnapshot: () => ({ featureGates }) }) },
    });

    assert.deepEqual(await handlers.getDesktopNotificationPreferences(), { playSound: true, sound: "ping-1-open-blip" });
    await assert.rejects(
      () => handlers.setDesktopNotificationPreferences({ preferences: { playSound: false, sound: "ping-2-tick" } }),
      (error) => error.code === loaded.module.MAIN_EDGE_NOTIFICATION_SOUNDS_UNAVAILABLE,
    );
    assert.deepEqual(stored, { playSound: true, sound: "ping-1-open-blip" });

    featureGates = { sand_notification_sounds: true };
    assert.deepEqual(
      await handlers.setDesktopNotificationPreferences({ preferences: { playSound: false, sound: "ping-2-tick" } }),
      { playSound: false, sound: "ping-2-tick" },
    );
    // The edge normalizes before it persists, so a partial payload cannot land.
    assert.deepEqual(
      await handlers.setDesktopNotificationPreferences({ preferences: { sound: "ping-9-retired" } }),
      { playSound: true, sound: "ping-1-open-blip" },
    );
  } finally {
    await loaded.dispose();
  }
});

test("the ported gate registry adds sand_notification_sounds without moving a generated flag", async () => {
  const ported = await loadModule("source/shared/node/experiments/experiment-config.ported.ts", "experiment-config.ported.mjs");
  const generated = await loadModule("source/shared/node/experiments/experiment-config.gen.ts", "experiment-config.gen.mjs");
  try {
    const merged = ported.module.FLAGS;
    assert.deepEqual(ported.module.PORTED_FLAGS.sand_notification_sounds, { client: true, default: true });
    assert.equal(Object.hasOwn(generated.module.FLAGS, "sand_notification_sounds"), false);
    assert.equal(merged.sand_notification_sounds.default, true);
    for (const [name, flag] of Object.entries(generated.module.FLAGS)) {
      assert.deepEqual(merged[name], flag, `ported registry moved generated flag ${name}`);
    }
    assert.equal(
      Object.keys(merged).length,
      Object.keys(generated.module.FLAGS).length + Object.keys(ported.module.PORTED_FLAGS).length,
    );
    const experiments = await readFile(path.join(repoRoot, "source/shared/node/experiments/cursor-experiments.ts"), "utf8");
    assert.match(experiments, /Object\.hasOwn\(PORTED_FLAGS, name\)/);
  } finally {
    await ported.dispose();
    await generated.dispose();
  }
});

test("the renderer catalog names every shipped sound and reuses one audio element", async () => {
  const loaded = await loadModule(
    "frontend/src/recovered/features/window-chrome/notification-sounds.ts",
    "notification-sounds.mjs",
    { loader: { ".wav": "dataurl" } },
  );
  try {
    const catalog = loaded.module.NOTIFICATION_SOUNDS;
    assert.deepEqual(catalog.map(({ id }) => id), SOUND_IDS);
    assert.deepEqual(catalog.map(({ label }) => label), ["Open Blip", "Tick", "Double Tick", "Chime A", "Chime B"]);
    for (const sound of catalog) assert.match(sound.url, /^data:audio\/wav/);
    assert.equal(loaded.module.notificationSoundById("ping-9-retired"), undefined);

    const elements = [];
    globalThis.Audio = class {
      constructor() {
        this.src = "";
        this.pauses = 0;
        this.plays = [];
        elements.push(this);
      }
      pause() { this.pauses += 1; }
      play() { this.plays.push(this.src); return Promise.reject(new Error("NotAllowedError")); }
    };
    try {
      loaded.module.playNotificationSound("ping-2-tick");
      loaded.module.playNotificationSound("ping-4-chime-a");
      // An unknown id never touches the element.
      loaded.module.playNotificationSound("ping-9-retired");
      loaded.module.stopNotificationSound();
      assert.equal(elements.length, 1);
      assert.deepEqual(elements[0].plays, [catalog[1].url, catalog[3].url]);
      assert.equal(elements[0].pauses, 3);
    } finally {
      delete globalThis.Audio;
    }
    // A rejected play() is swallowed rather than becoming an unhandled rejection.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    await loaded.dispose();
  }
});

test("the checked-in tones are the official 0.27 48 kHz stereo PCM WAV files", async () => {
  // Official 0.27 durations in milliseconds (stereo, so dataBytes / 4 / 48).
  const expected = {
    "ping-1-open-blip": 255,
    "ping-2-tick": 220,
    "ping-3-double-tick": 330,
    "ping-4-chime-a": 340,
    "ping-5-chime-b": 350,
  };
  for (const id of SOUND_IDS) {
    const bytes = await readFile(path.join(soundsDir, `${id}.wav`));
    assert.equal(bytes.toString("ascii", 0, 4), "RIFF", id);
    assert.equal(bytes.readUInt32LE(4), bytes.byteLength - 8, id);
    assert.equal(bytes.toString("ascii", 8, 12), "WAVE", id);
    assert.equal(bytes.toString("ascii", 12, 16), "fmt ", id);
    assert.equal(bytes.readUInt32LE(16), 16, id);
    assert.equal(bytes.readUInt16LE(20), 1, id); // PCM
    assert.equal(bytes.readUInt16LE(22), 2, id); // stereo
    assert.equal(bytes.readUInt32LE(24), 48_000, id);
    assert.equal(bytes.readUInt16LE(34), 16, id);
    assert.equal(bytes.toString("ascii", 36, 40), "data", id);
    const dataBytes = bytes.readUInt32LE(40);
    assert.equal(dataBytes, bytes.byteLength - 44, id);
    assert.equal(Math.round(dataBytes / 4 / 48), expected[id], id);
    assert.ok(bytes.byteLength > 4096, `${id} must stay above Vite's inline threshold`);

    let peak = 0;
    for (let offset = 44; offset < bytes.byteLength; offset += 2) peak = Math.max(peak, Math.abs(bytes.readInt16LE(offset)));
    assert.ok(peak > 8_000 && peak < 32_767, `${id} peak ${peak}`);
  }

  const readme = await readFile(path.join(soundsDir, "README.md"), "utf8");
  assert.match(readme, /official/i);
  assert.match(readme, /0\.27/);
  assert.match(readme, /tmp-2-tick-DY1KrPne\.wav/);
  assert.doesNotMatch(readme, /These five WAV files are \*\*self-authored\*\*/);
});
