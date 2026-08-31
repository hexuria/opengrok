import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entry, name) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), name));
  const outfile = path.join(temporary, "mod.mjs");
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  return { temporary, mod: await import(pathToFileURL(outfile).href + "?" + Date.now()) };
}

test("Cmd+V and Ctrl+V are host paste keys; other chords are not", async () => {
  const { temporary, mod } = await bundle("source/electron-preload/box-vnc-clipboard-paste.ts", "vnc-paste-key-");
  try {
    assert.equal(mod.isHostPasteKey({ key: "v", metaKey: true }), true);
    assert.equal(mod.isHostPasteKey({ key: "V", ctrlKey: true }), true);
    assert.equal(mod.isHostPasteKey({ key: "v" }), false);
    assert.equal(mod.isHostPasteKey({ key: "c", metaKey: true }), false);
    assert.equal(mod.isHostPasteKey({ key: "v", metaKey: true, altKey: true }), false);
    assert.equal(mod.isHostPasteKey({ key: "v", ctrlKey: true, altKey: true }), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("paste-and-key script syncs RFB clipboard then sends Ctrl+V; warm script only syncs", async () => {
  const { temporary, mod } = await bundle("source/electron-preload/box-vnc-clipboard-paste.ts", "vnc-paste-script-");
  try {
    const warm = mod.buildHostClipboardPasteScript("hello");
    assert.match(warm, /clipboardPasteFrom/);
    assert.match(warm, /"hello"/);
    assert.doesNotMatch(warm, /sendKey/);

    const paste = mod.buildHostClipboardPasteAndKeyScript("hello from laptop");
    assert.match(paste, /clipboardPasteFrom/);
    assert.match(paste, /"hello from laptop"/);
    assert.match(paste, /sendKey/);
    assert.match(paste, /0xffe3/);
    assert.match(paste, /KeyV/);
    assert.match(paste, /0x76/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Mac key remap keeps Cmd+A/C/X/Z and does not send Cmd+V itself", async () => {
  const { temporary, mod } = await bundle("source/electron-preload/preload-vnc.ts", "vnc-mac-keys-");
  try {
    const script = mod.buildVncMacKeyMappingScript();
    assert.match(script, /KeyA:/);
    assert.match(script, /KeyC:/);
    assert.match(script, /KeyX:/);
    assert.match(script, /KeyZ:/);
    assert.doesNotMatch(script, /KeyV:\s*0x76/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

function createFakeBridge() {
  const rendererListeners = new Map();
  const documentListeners = new Map();
  let now = 1_000;
  const reads = [];
  const scripts = [];
  const textarea = { value: "" };
  let clipboard = "laptop text";
  let prevented = 0;
  const document = {
    documentElement: { classList: { contains: () => false, remove() {} } },
    visibilityState: "visible",
    getElementById: (id) => (id === "noVNC_clipboard_text" ? textarea : null),
    addEventListener(type, listener) {
      const list = documentListeners.get(type) ?? [];
      list.push(listener);
      documentListeners.set(type, list);
    },
  };
  const windowPort = { addEventListener() {} };
  const frame = {
    executeJavaScript(script) {
      scripts.push(script);
      return Promise.resolve(true);
    },
  };
  const edge = {
    readClipboard: async () => {
      reads.push(clipboard);
      return clipboard;
    },
    writeClipboard: async () => {},
    reportUserPresence: async () => {},
  };
  const renderer = {
    on(channel, listener) {
      rendererListeners.set(channel, listener);
    },
    sendToHost() {},
  };
  return {
    rendererListeners,
    documentListeners,
    reads,
    scripts,
    prevented: () => prevented,
    setNow(value) {
      now = value;
    },
    options: {
      renderer,
      edge,
      frame,
      window: windowPort,
      document,
      location: { pathname: "/vnc.html", search: "?sandInteractive=1" },
      startPolling: () => ({ dispose() {} }),
      isTextarea: (value) => value === textarea,
      now: () => now,
    },
    emitVisible() {
      rendererListeners.get("sand:vnc-viewer-visible")?.(null, true);
    },
    dispatchKey(event) {
      const wrapped = {
        preventDefault() {
          prevented += 1;
        },
        stopImmediatePropagation() {},
        ...event,
      };
      for (const listener of documentListeners.get("keydown") ?? []) listener(wrapped);
    },
    dispatchMouseDown() {
      for (const listener of documentListeners.get("mousedown") ?? []) listener({});
    },
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

test("Cmd+V on the interactive viewer syncs then sends Ctrl+V, even right after a click", async () => {
  const { temporary, mod } = await bundle("source/electron-preload/preload-vnc.ts", "vnc-bridge-paste-");
  try {
    const fake = createFakeBridge();
    mod.installVncClipboardBridge(fake.options);
    fake.emitVisible();
    await flush();
    assert.equal(fake.reads.length, 1);
    assert.match(fake.scripts[0], /clipboardPasteFrom/);
    assert.doesNotMatch(fake.scripts[0], /sendKey/);

    fake.dispatchMouseDown();
    await flush();
    assert.equal(fake.reads.length, 1, "mousedown within the throttle window must not sync again");

    fake.dispatchKey({ key: "v", metaKey: true });
    await flush();
    assert.equal(fake.prevented(), 1);
    assert.equal(fake.reads.length, 2, "Cmd+V must not inherit the mousedown throttle");
    assert.match(fake.scripts[1], /clipboardPasteFrom/);
    assert.match(fake.scripts[1], /sendKey/);
    assert.match(fake.scripts[1], /KeyV/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("preview VNC (no sandInteractive) never installs a paste key handler", async () => {
  const { temporary, mod } = await bundle("source/electron-preload/preload-vnc.ts", "vnc-bridge-preview-");
  try {
    const fake = createFakeBridge();
    fake.options.location = { pathname: "/vnc.html", search: "" };
    mod.installVncClipboardBridge(fake.options);
    fake.emitVisible();
    fake.dispatchKey({ key: "v", metaKey: true });
    await flush();
    assert.equal(fake.documentListeners.get("keydown"), undefined);
    assert.equal(fake.reads.length, 0);
    assert.equal(fake.scripts.length, 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
