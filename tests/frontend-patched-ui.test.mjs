import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FRONTEND = path.join(repoRoot, "frontend");
const PATCHED = path.join(FRONTEND, "src/production/patched-ui/index.ts");
const present = existsSync(PATCHED);

/**
 * frontend/ is gitignored and restored from stow. A public clone without it
 * still runs the helper tests; CI with stow restored runs these ports so the
 * default Vite packager keeps coverage of the React ports.
 */
test("frontend patched-ui skip contract: import ports when frontend/ is present, skip when absent", async () => {
  const packager = await readFile(path.join(repoRoot, "scripts/package-macos.mjs"), "utf8");
  assert.match(packager, /import \{ buildReconstructedAsar \} from "\.\/clean-build\.mjs"/);
  assert.match(packager, /await buildReconstructedAsar\(\)/);
  assert.doesNotMatch(packager, /buildFidelityReconstructedAsar/, "default packager ships the Vite UI");
  if (!present) {
    assert.equal(existsSync(path.join(FRONTEND, "src")), false, "a tree without frontend/src skips the React ports");
    return;
  }
  assert.ok(existsSync(PATCHED), "patched-ui index is the import door");
});

function whenFrontend(name, fn) {
  test(name, { skip: present ? false : "frontend/ is restored from stow; skip when absent" }, fn);
}

async function loadPatched() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "patched-ui-"));
  const outfile = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [PATCHED],
    outfile,
    bundle: true,
    format: "esm",
    platform: "neutral",
  });
  const loaded = await import(pathToFileURL(outfile).href + "?" + Date.now());
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

const readFrontend = (relative) => readFile(path.join(repoRoot, relative), "utf8");

whenFrontend("settings registry: Computer, Dictation, Usage always visible", async () => {
  const { loaded, cleanup } = await loadPatched();
  try {
    assert.deepEqual(loaded.PATCHED_SETTINGS_SECTIONS.map((s) => `${s.id}|${s.label}|${s.icon}`), [
      "general|General|settings-gear",
      "router|Computer|device-desktop",
      "dictation|Dictation|mic",
      "usage|Usage|chart-bars",
      "beta|Updates|cloud-download",
    ]);
    assert.equal(loaded.patchedSettingsSectionsForUsage().length, 5);
    assert.equal(loaded.patchedSettingsSectionsForUsage(loaded.PATCHED_SETTINGS_SECTIONS, false).some((s) => s.id === "usage"), true);
  } finally {
    await cleanup();
  }
});

whenFrontend("login-wall skip admits a completed OpenGrok server login", async () => {
  const { loaded, cleanup } = await loadPatched();
  try {
    const store = new Map();
    const storage = { getItem: (k) => store.get(k) ?? null, setItem(k, v) { store.set(k, v); }, removeItem(k) { store.delete(k); } };
    assert.equal(loaded.maySkipLoginWall(storage), false);
    loaded.rememberLoginWallSkip(storage);
    assert.equal(loaded.maySkipLoginWall(storage), true);
    loaded.forgetLoginWallSkip(storage);
    assert.equal(loaded.maySkipLoginWall(storage), false);
    store.set(loaded.OPENGROK_MODE_KEY, "1");
    assert.equal(loaded.maySkipLoginWall(storage), false, "OpenGrok mode alone is not a session");
    loaded.rememberLoginWallSkip(storage);
    assert.equal(loaded.maySkipLoginWall(storage), true, "a finished OpenGrok login must leave the provider picker");
    const throwing = { getItem: () => { throw new Error("blocked"); } };
    assert.equal(loaded.maySkipLoginWall(throwing), false);
  } finally {
    await cleanup();
  }
});

whenFrontend("brand strings swap only in OpenGrok mode", async () => {
  const { loaded, cleanup } = await loadPatched();
  try {
    const store = new Map();
    const storage = { getItem: (k) => store.get(k) ?? null };
    const text = "Grok Bot can run commands on your computer.";
    assert.equal(loaded.brandText(text, storage), text);
    store.set(loaded.OPENGROK_MODE_STORAGE_KEY, "1");
    assert.equal(loaded.BRAND_OPEN_NAME, "Open Grok");
    assert.equal(loaded.brandText(text, storage), "Open Grok can run commands on your computer.");
    assert.equal(loaded.brandedDocumentTitle("Grok Bot", storage), "Open Grok");
    assert.equal(loaded.brandedDocumentTitle("Settings", storage), "Settings");
    const throwing = { getItem: () => { throw new Error("blocked"); } };
    assert.equal(loaded.brandText(text, throwing), text, "blocked storage keeps the official name");
  } finally {
    await cleanup();
  }
});

whenFrontend("model combobox: labels, groups, filter, stale pin, typed id", async () => {
  const { loaded, cleanup } = await loadPatched();
  try {
    const { labelOf, optionsFor } = loaded;
    assert.equal(labelOf("xai/grok-4.6@sub"), "xAI: grok-4.6 · subscription");
    assert.equal(labelOf("openai/gpt-5.5"), "OpenAI: gpt-5.5");
    assert.equal(labelOf("oag/auto"), "OAG: auto");
    assert.equal(labelOf("anthropic/claude-opus-4-6@api"), "Anthropic: claude-opus-4-6 · API");
    assert.equal(labelOf("foo/bar-1"), "Foo: bar-1");
    assert.equal(labelOf("just-a-name"), "just-a-name");
    assert.equal(labelOf("xai/grok-4.6@weird"), "xAI: grok-4.6 · weird");
    assert.equal(labelOf(null), "");
    const CATALOGUE = ["oag/auto", "xai/grok-4.6", "xai/grok-4.6@sub", "openai/gpt-5-mini", "openai/gpt-5.5"];
    assert.deepEqual(optionsFor(CATALOGUE, "xai/grok-4.6@sub", "").map((o) => o.group + " | " + o.id), [
      "Let the gateway choose | oag/auto",
      "Pin a model | xai/grok-4.6",
      "Pin a model | xai/grok-4.6@sub",
      "Pin a model | openai/gpt-5-mini",
      "Pin a model | openai/gpt-5.5",
    ]);
    assert.deepEqual(optionsFor(CATALOGUE, null, "grok").map((o) => o.id), ["xai/grok-4.6", "xai/grok-4.6@sub", "grok"]);
    assert.deepEqual(optionsFor(CATALOGUE, null, "openai: gpt-5.5").map((o) => o.id), ["openai/gpt-5.5", "openai: gpt-5.5"]);
    assert.deepEqual(optionsFor(CATALOGUE, null, "OpenAI").map((o) => o.id).slice(0, 2), ["openai/gpt-5-mini", "openai/gpt-5.5"]);
    assert.deepEqual(optionsFor(CATALOGUE, null, "subscription").map((o) => o.id), ["xai/grok-4.6@sub", "subscription"]);
    const stale = optionsFor(CATALOGUE, "openai/gpt-5.6-luna", "").at(-1);
    assert.equal(stale.id, "openai/gpt-5.6-luna");
    assert.equal(stale.group, "Not in the catalogue");
    assert.deepEqual(optionsFor(CATALOGUE, null, "openai/gpt-6").map((o) => o.group), ["Use exactly what you typed"]);
    assert.deepEqual(optionsFor(CATALOGUE, null, "openai/gpt-5.5").map((o) => o.id), ["openai/gpt-5.5"]);
    assert.deepEqual(loaded.comboboxMove(false, 0, 5, 1), { open: true, active: 0 }, "ArrowDown from closed opens on the first option");
    assert.deepEqual(loaded.comboboxMove(true, 0, 5, 1), { open: true, active: 1 });
    assert.deepEqual(loaded.comboboxMove(true, 0, 5, -1), { open: true, active: 4 }, "ArrowUp wraps");
  } finally {
    await cleanup();
  }
});

whenFrontend("usage short numbers, money, table, summary, cap room", async () => {
  const { loaded, cleanup } = await loadPatched();
  try {
    const { short, exact, usd, usdExact, pts, money, usdOfPoints, table, summary, seatLine, limitsText, capText, capExact, sortRows } = loaded;
    const cases = [[0, "0"], [4, "4"], [999, "999"], [1000, "1k"], [1200, "1.2k"], [3294, "3.29k"], [10000, "10k"],
      [41310, "41.3k"], [54540, "54.5k"], [999000, "999k"], [999999, "1m"], [1100000, "1.1m"], [12345678, "12.3m"],
      [900000000, "900m"], [1200000000, "1.2b"], [1500000000000, "1.5t"]];
    for (const [n, want] of cases) assert.equal(short(n), want, `${n}`);
    assert.equal(short(-41310), "-41.3k");
    assert.equal(exact(1234567, "point"), "1,234,567 points");
    assert.equal(exact(1, "request"), "1 request");
    assert.equal(usd(0.0083), "$0.0083");
    assert.equal(usd(1.5), "$1.50");
    assert.equal(usd(1234.56), "$1,234.56");
    assert.equal(usd(12345), "$12.3k");
    assert.equal(usd(2400000), "$2.4m");
    assert.equal(usdExact(0.0083), "$0.008300");
    assert.equal(usdExact(12345), "$12,345.00");
    assert.equal(pts(41500), "41.5k");
    assert.equal(pts(null), "—");
    assert.equal(money("0.008300"), "$0.0083");
    assert.equal(usdOfPoints(1000000, "0.200000"), "≈ $0.20");
    const USAGE = { usage: { models: [
      { modelId: "xai/grok-4.6", requests: 4, inputTokens: 6204, outputTokens: 12, listUsd: "0.008300", costUsd: "0.000000", points: 41500 },
      { modelId: "openai/gpt-5.5", requests: 1, inputTokens: 20000, outputTokens: 1000, listUsd: "0.130000", costUsd: "0.130000", points: 650000 },
    ] } };
    const all = table(USAGE.usage, "all");
    assert.equal(all.rows.length, 2);
    assert.deepEqual([all.totals.requests, all.totals.tokIn, all.totals.tokOut, all.totals.points, all.totals.pointsKnown], [5, 26204, 1012, 691500, true]);
    assert.equal(all.totals.list.toFixed(4), "0.1383");
    const older = table({ models: [{ modelId: "All models", requests: 4, listUsd: "0.0083", costUsd: "0", points: null }] }, "all");
    assert.equal(older.totals.pointsKnown, false);
    assert.equal(summary(USAGE, null), "5 requests this month · 692k points");
    assert.equal(summary({ usage: { models: [] } }, null), "nothing this month");
    const spendOnly = { spend: { metered: true, seat: "subscription", windows: [
      { window: "5h", usedUsd: "0.000000", counterfactualUsd: "0.008300", requests: 4, freesAt: "2026-09-03T03:29:11Z" },
      { window: "month", usedUsd: "0.000000", counterfactualUsd: "0.008300", requests: 4, freesAt: "2026-10-01T00:00:00Z" },
    ] } };
    assert.equal(summary(null, spendOnly), "4 requests · $0.0083 on API this month");
    assert.equal(seatLine({ metered: true, seat: "api" }), "API key");
    assert.equal(capText({ cap: null, effectiveCap: 12000000, usedPoints: 10000000 }, "0.200000"), "none = your pool · 2m left");
    assert.equal(capText({ cap: 5000000, effectiveCap: 3000000, usedPoints: 1000000 }, "0.200000"), "≈ $1.00 · effective 3m · 2m left");
    assert.equal(capExact({ cap: 5000000, effectiveCap: 3000000, usedPoints: 1000000 }), "cap 5,000,000 points · effective ceiling 3,000,000 · 1,000,000 used · 2,000,000 left");
    assert.equal(capText({ cap: 0 }, "0.2"), "0 = nothing may run");
    const t = limitsText({ cap: 100000, pool: { max: 1000000, used: 41620, setBy: "admin", resetsAt: "2026-10-01T00:00:00Z" } }, "0.200000");
    assert.match(t.pool, /^Your pool: 41\.6k of 1m used \(≈ \$0\.20\), set by your admin, resets /);
    const sorted = sortRows([{ model: "a", points: 5, list: 1 }, { model: "b", points: null, list: 9 }, { model: "c", points: 50, list: 0 }]);
    assert.deepEqual(sorted.map((r) => r.model), ["c", "a", "b"]);
  } finally {
    await cleanup();
  }
});

whenFrontend("auto-review persist: inherit with nothing deletes the row", async () => {
  const { loaded, cleanup } = await loadPatched();
  try {
    assert.deepEqual(loaded.rowsOf("read files\nrun tests"), ["read files", "run tests"]);
    assert.deepEqual(loaded.rowsOf(["read files"]), ["read files"]);
    assert.equal(loaded.autoReviewModeFromRow({ enabled: true }), "on");
    assert.equal(loaded.autoReviewModeFromRow({ enabled: false }), "off");
    assert.equal(loaded.autoReviewModeFromRow(null), "inherit");
    assert.deepEqual(loaded.autoReviewPersistPayload("inherit", [], []), { kind: "delete" });
    assert.deepEqual(loaded.autoReviewPersistPayload("on", ["read files"], []), {
      kind: "set",
      body: { enabled: true, allowInstructions: ["read files"], blockInstructions: [] },
    });
    assert.deepEqual(loaded.autoReviewPersistPayload("inherit", ["read files"], []), {
      kind: "set",
      body: { enabled: null, allowInstructions: ["read files"], blockInstructions: null },
    });
    assert.equal(loaded.autoReviewTabLabel("allow", 1), "Allow (1)");
    assert.equal(loaded.AUTO_REVIEW_MANAGE_LABEL, "Manage…");
    assert.equal(loaded.AUTO_REVIEW_PANE_TITLE, "Auto-review");
  } finally {
    await cleanup();
  }
});

whenFrontend("select/delete/collections rail contracts", async () => {
  const { loaded, cleanup } = await loadPatched();
  try {
    const labelled = (id) => `sand-conversation-entry-${id}-author sand-conversation-entry-${id}-timestamp`;
    const el = (attrs) => ({ getAttribute: (k) => attrs[k] ?? null, classList: { contains: (c) => c === "sand-transcript-row" } });
    assert.deepEqual(loaded.idsOf(el({ "aria-labelledby": labelled("e_01a0-6162"), "data-row-key": "nonce:509379ce" })), ["e_01a0-6162"]);
    assert.deepEqual(loaded.idsOf(el({ "aria-labelledby": labelled("e_9"), "data-row-key": "e_9" })), ["e_9"]);
    assert.deepEqual(loaded.idsOf(el({ "data-row-key": "t12u" })), []);
    assert.deepEqual(loaded.idsOf(el({ "data-row-key": "e_7", "data-entry-id": "e_7" })), []);
    assert.deepEqual(loaded.idsOf(el({ "data-row-key": "e_7", "data-entry-ids": "e_7 e_8" })), ["e_7", "e_8"]);
    const recovered = el({ "aria-labelledby": labelled("e_1"), "data-entry-id": "e_1", "data-index": "0" });
    assert.deepEqual(loaded.idsOf(recovered), ["e_1"], "a recovered row is labelled, not keyed");
    assert.equal(loaded.selectableRowsIn({ querySelectorAll: () => [recovered] }).length, 1);
    assert.equal(loaded.selectableRowsIn({ querySelectorAll: () => [el({ "data-entry-id": "e_7" })] }).length, 0, "a borrowed data-entry-id without a label is not a bubble");
    assert.deepEqual(loaded.filterTombstonedEntries([{ id: "e_1" }, { id: "e_2" }], "cw_1", { cw_1: ["e_1"] }).map((e) => e.id), ["e_2"]);
    assert.deepEqual(loaded.filterTombstonedEntries([{ id: "e_1" }], "cw_1", {}).map((e) => e.id), ["e_1"]);
    assert.equal(loaded.SELECT_COUNT_TEXT(1), "1 selected");
    assert.equal(loaded.SELECT_ADD_LOADED_LABEL(2), "Add the 2 loaded messages to the selection");
    assert.equal(loaded.SELECT_ADD_LOADED_TEXT(0), "All loaded added");
    assert.equal(loaded.COLLECTIONS_RAIL_ARIA_LABEL, "Collections");
    assert.equal(loaded.COLLECTIONS_RAIL_PLACEMENT, "before-new");
    assert.equal(loaded.DELETE_CONFIRM_COPY, "Delete this message?");
    assert.equal(loaded.deleteFailureCopy("not-found"), "Couldn’t delete: not-found.");
    assert.equal(loaded.deletedCount({ deleted: 1 }), 1);
    assert.equal(loaded.deletedCount({ deleted: ["e1"] }), 1);
    assert.match(loaded.deleteConfirmCopy(1, true), /Delete 1 message for everyone/);
    assert.match(loaded.deleteConfirmCopy(2, false), /Hide 2 messages on this device/);
  } finally {
    await cleanup();
  }
});

whenFrontend("always-allow writes the coworker list, seeds inherit, falls back to global", async () => {
  const { loaded, cleanup } = await loadPatched();
  try {
    const store = new Map([[loaded.OPENGROK_MODE_STORAGE_KEY, "1"]]);
    const storage = { getItem: (k) => store.get(k) ?? null };
    const calls = [];
    const bridge = {
      getAgentAutoReview: async (id) => {
        calls.push(["get", id]);
        return { available: true, row: { enabled: true, allowInstructions: "old rule", blockInstructions: "never this" } };
      },
      setAgentAutoReview: async (id, policy) => { calls.push(["set", id, policy]); },
    };
    assert.equal(await loaded.alwaysAllowForCoworker("cw_1", "run `ls`", { storage, bridge }), true);
    assert.deepEqual(calls[1][2].allowInstructions, ["old rule", "run `ls`"]);
    assert.deepEqual(calls[1][2].blockInstructions, ["never this"]);
    assert.equal(await loaded.alwaysAllowForCoworker("cw_1", "run `ls`", { storage, bridge: {
      getAgentAutoReview: async () => ({ available: true, row: { allowInstructions: ["run `ls`"] } }),
      setAgentAutoReview: async () => { throw new Error("should not write"); },
    } }), true);
    let written = null;
    const existing = Array.from({ length: loaded.ALLOW_RULE_CEILING }, (_, i) => `rule ${i}`);
    await loaded.alwaysAllowForCoworker("cw_1", "the newest", {
      storage,
      bridge: {
        getAgentAutoReview: async () => ({ available: true, row: { allowInstructions: existing } }),
        setAgentAutoReview: async (_id, policy) => { written = policy.allowInstructions; },
      },
    });
    assert.equal(written.length, loaded.ALLOW_RULE_CEILING);
    assert.equal(written.at(-1), "the newest");
    assert.equal(written[0], "rule 1");
    assert.equal(await loaded.alwaysAllowForCoworker("cw_1", "run `ls`", { storage: { getItem: () => null }, bridge }), false);
    assert.equal(await loaded.alwaysAllowForCoworker("cw_1", "run `ls`", { storage, bridge: null }), false);
    written = null;
    await loaded.alwaysAllowForCoworker("cw_1", "run `ls`", {
      storage,
      bridge: {
        getAgentAutoReview: async () => ({
          available: true,
          row: { enabled: true, allowInstructions: null, blockInstructions: null },
          effective: { enabled: true, allowInstructions: "read files under my project\nrun tests", blockInstructions: "" },
        }),
        setAgentAutoReview: async (_id, policy) => { written = policy; },
      },
    });
    assert.deepEqual(written.allowInstructions, ["read files under my project", "run tests", "run `ls`"]);
    assert.equal(written.blockInstructions, null);
    const long = "x".repeat(loaded.ALLOW_RULE_MAX_CHARS + 50);
    written = null;
    await loaded.alwaysAllowForCoworker("cw_1", long, {
      storage,
      bridge: {
        getAgentAutoReview: async () => ({ available: true, row: { allowInstructions: [] } }),
        setAgentAutoReview: async (_id, policy) => { written = policy; },
      },
    });
    assert.equal(written.allowInstructions[0].length, loaded.ALLOW_RULE_MAX_CHARS);
    assert.equal(loaded.alwaysAllowSettledNote("coworker", "run `ls`"), "A rule always allowing this was added to this coworker’s Auto-review settings: “run `ls`”");
    assert.equal(loaded.alwaysAllowSettledNote("global"), "A rule always allowing this was added to your Auto-review settings");
  } finally {
    await cleanup();
  }
});

whenFrontend("math kit converts \\( \\) and \\[ \\] and never treats $5 as math", async () => {
  const { loaded, cleanup } = await loadPatched();
  try {
    assert.equal(loaded.MATH_SINGLE_DOLLAR_DISABLED, true);
    assert.equal(loaded.convertLatexDelimiters("see \\(x^2\\) here"), "see $$x^2$$ here");
    assert.match(loaded.convertLatexDelimiters("\\[a+b\\]"), /\$\$\na\+b\n\$\$/);
    assert.equal(loaded.convertLatexDelimiters("`$5 and \\(x\\)` keep code"), "`$5 and \\(x\\)` keep code");
    const segs = loaded.splitMathSegments("area is \\(x^2\\) units");
    assert.deepEqual(segs.map((s) => s.kind), ["text", "math", "text"]);
    assert.equal(segs[1].text, "x^2");
    assert.equal(segs[1].displayMode, false);
    const dollars = loaded.splitMathSegments("$5 and $6");
    assert.equal(dollars.length, 1);
    assert.equal(dollars[0].kind, "text");
  } finally {
    await cleanup();
  }
});

whenFrontend("layout estimator matches live y7n", async () => {
  const { loaded, cleanup } = await loadPatched();
  try {
    assert.equal(loaded.imageTileBox(null, 10, 320), null);
    const strip = loaded.imageTileBox(272, 54, 320);
    assert.deepEqual(strip, { width: 272, height: 54 });
    const banner = loaded.imageTileBox(1102, 264, 320);
    assert.deepEqual(banner, { width: 320, height: 200 }, "y7n keeps height at min(200, naturalH) when the width cap binds");
    const tall = loaded.imageTileBox(100, 1000, 560);
    assert.equal(tall.height, 200);
    const tiny = loaded.imageTileBox(50, 50, 320);
    assert.deepEqual(tiny, { width: 50, height: 50 });
    assert.equal(loaded.estimateMediaHeight(1102, 264, 320), 200);
    assert.equal(loaded.shouldLetterbox(10, 10, 200, 200), true);
    assert.equal(loaded.shouldLetterbox(400, 400, 200, 200), false);
    assert.equal(loaded.variantWidth(186, 2, 1120), 384);
    assert.equal(loaded.layoutLintArmed({ getItem: () => null }), false);
    assert.equal(loaded.layoutLintArmed({ getItem: () => "1" }), true);
  } finally {
    await cleanup();
  }
});

whenFrontend("React ports are wired: Computer/Dictation/Usage, panes, rail, hosts", async () => {
  const surface = await readFrontend("frontend/src/recovered/features/settings/overlay/desktop-surface.tsx");
  assert.match(surface, /PATCHED_SETTINGS_SECTIONS/);
  assert.match(surface, /DictationPanel/);
  assert.match(surface, /RouterUsagePanel/);
  assert.match(surface, /showUsage=\{true\}/);
  // The Computer tab carries the machine-consent rows from the patched build (this computer, remote control, performance).
  assert.match(surface, /<ComputerRuntimeSettingsPanel bridge=\{bridge\.agent\} computer=\{computer\} \/>\s+<LocalComputerGroup \/>\s+<RemoteControlGroup \/>\s+<HardwareAccelerationGroup \/>/);
  assert.doesNotMatch(surface, /<RouterSettingsPanel/, "the Computer tab has no Provider/Account/Usage groups, as in the patched build");
  const runtime = await readFrontend("frontend/src/recovered/features/settings/overlay/computer-runtime.tsx");
  assert.match(runtime, /\{ value: "opengrok", label: "OpenGrok Server"/);
  assert.match(runtime, /if \(mode === "opengrok"\) return \(\s+<div className="sand-computer-runtime-section">\s+<OpenGrokComputersGroup \/>/);
  const openGrok = await readFrontend("frontend/src/production/patched-ui/OpenGrokComputers.tsx");
  assert.match(openGrok, /listOpenGrokComputers\?\.\(\)/);
  assert.match(openGrok, /"Your computer" : ready \? "Available to your org" : "Set up by your org admin"/);
  assert.match(openGrok, /sand-opengrok-changed/);
  const localComputer = await readFrontend("frontend/src/production/patched-ui/LocalComputerPanel.tsx");
  for (const label of ["This computer accepts bot commands", "Allow administrator (sudo) commands", "Bots using this computer", "Standing rules", "Turn off", "Forget this computer", "Hardware acceleration"]) assert.ok(localComputer.includes(`label="${label}"`), label);
  assert.match(localComputer, /setLocalComputerName\?\.\(next\)/);
  assert.match(localComputer, /sudoAskpass\?\.set\(true\)/);
  assert.match(localComputer, /value: "bypass", label: "Always allow"/);
  assert.match(localComputer, /addRemoteControlRule\?\.\(kind, pattern\)/);
  const renderer = await readFrontend("frontend/src/production/ProductionRenderer.tsx");
  assert.match(renderer, /AgentModelCombobox/);
  assert.match(renderer, /AgentUsagePane/);
  assert.match(renderer, /AutoReviewPane/);
  assert.match(renderer, /DeleteMessageHost/);
  assert.match(renderer, /SelectMessagesHost/);
  assert.match(renderer, /maySkipLoginWall/);
  assert.match(renderer, /shouldShowCursorLoginWall\(account, \{ skipped: subscriptionReady \}\)/);
  assert.match(renderer, /filterTombstonedEntries/);
  assert.match(renderer, /CollectionsRailButton/);
  const sidebar = await readFrontend("frontend/src/recovered/features/conversation/workspace/sidebar.tsx");
  assert.match(sidebar, /data-agent-id=\{agent\.id\}/);
  const actions = await readFrontend("frontend/src/recovered/features/conversation/cards/transcript-card/auto-review-actions.ts");
  assert.match(actions, /alwaysAllowForCoworker/);
  assert.match(
    actions,
    /from "\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/production\/patched-ui"/,
    "auto-review-actions is one directory deeper than workspace/ and must climb to frontend/src",
  );
  const approval = await readFrontend("frontend/src/recovered/features/conversation/cards/transcript-card/views/auto-review-approval.tsx");
  assert.match(approval, /alwaysAllowSettledNote/);
  const menu = await readFrontend("frontend/src/recovered/features/conversation/cards/transcript-card/message-actions.tsx");
  assert.match(menu, /Select messages/);
  assert.match(menu, /Delete message/);
  const transcript = await readFrontend("frontend/src/recovered/features/conversation/workspace/transcript.tsx");
  assert.match(transcript, /convertLatexDelimiters/);
  assert.match(transcript, /--sand-ts-progress/);
  assert.match(transcript, /event\.deltaX/);
  assert.match(
    transcript,
    /data-role="assistant"[\s\S]{0,180}className="sand-row-timestamp"/,
    "send-message (left) rows own the same pan timestamp as user rows",
  );
  const mediaViewer = await readFrontend("frontend/src/recovered/features/conversation/workspace/media-viewer.tsx");
  assert.match(mediaViewer, /className="sand-file-card"/);
  assert.match(mediaViewer, /desktop-download/);
  assert.match(transcript, /splitMathSegments/);
  assert.match(transcript, /<p>\{renderAssistantInlineText\(visible\.text\)\}<\/p>/);
  const view = await readFrontend("frontend/src/recovered/features/conversation/workspace/view.css");
  assert.match(view, /\.sand-message \{[^}]*width: max-content;/);
  assert.match(view, /\.sand-message \{[^}]*min-width: auto;/);
  assert.match(view, /\.sand-message \{[^}]*overflow-wrap: break-word;/);
  assert.doesNotMatch(view, /\.sand-message \{[^}]*overflow-wrap: anywhere;/);
  assert.match(view, /\.sand-message-action-anchor \{[^}]*max-width: min\(88%, 640px, calc\(100% - 82px\)\);/);
  assert.match(view, /\.sand-message-action-anchor \{[^}]*min-width: auto;/);
  assert.match(view, /\.sand-message-action-anchor::after \{[^}]*width: 128px;/);
  assert.match(view, /\.sand-transcript-row\[data-role="user"\] \.sand-message-action-anchor \{[^}]*margin: 12px 0 0 82px;/);
  assert.match(view, /\.sand-message-prose \{[^}]*min-width: 0;/);
  assert.match(view, /\.sand-message-prose \{[^}]*overflow-wrap: anywhere;/);
  assert.doesNotMatch(view, /\.sand-message-prose \{[^}]*max-width: 100%/);
  assert.match(view, /\.sand-message-hover-actions \{[^}]*left: 100%;/s);
  assert.match(view, /\.sand-message-hover-actions \{[^}]*transform: translateY\(-50%\);/s);
  assert.match(view, /\.sand-transcript-row\[data-role="user"\] \.sand-message-hover-actions \{[^}]*right: 100%;/s);
  assert.doesNotMatch(view, /\.sand-message-hover-actions \{[^}]*bottom: -30px;/s);
  assert.doesNotMatch(view, /\.sand-message-hover-actions \{[^}]*transform: translateY\(-100%\);/s);
  assert.match(view, /\.sand-row-timestamp \{/);
  assert.match(view, /opacity: var\(--sand-ts-progress, 0\)/);
  assert.doesNotMatch(view, /\.sand-transcript-row:hover \.sand-row-timestamp/);
  assert.match(view, /\.sand-file-card \{/);
  assert.match(view, /\.sand-message-block \{/);
  assert.match(view, /\.sand-virtual-transcript \{[^}]*overflow-x: hidden;/);
  assert.match(view, /\.sand-virtual-transcript \{[^}]*padding: 16px 16px 16px;/);
  assert.match(view, /\.sand-prompt-shell \{[^}]*border-radius: 999px;/);
  assert.match(view, /\.sand-message-typing \{[^}]*background: transparent;/);
  assert.doesNotMatch(view, /\.sand-message-typing \{[^}]*background: var\(--cursor-bg-secondary\)/);
  // The transcript no longer reasons about who is drawing dots: there is one
  // indicator, the coworker's mark above the composer (operator's call,
  // 2026-09-07).
  assert.doesNotMatch(transcript, /hasStreamingDots/);
  assert.match(view, /\.sand-prompt-shell \{[^}]*box-shadow: none;/);
  assert.match(view, /\.sand-prompt-shell \{[^}]*backdrop-filter: none;/);
  assert.match(view, /\.sand-chat-input-dock \{[^}]*margin-top: 0;/);
  assert.match(view, /\.sand-jump-bottom \{/);
  assert.match(view, /\.sand-code-block \{[^}]*background: var\(--cursor-bg-editor/);
  assert.match(view, /\.sand-code-block \{[^}]*color: var\(--cursor-syntax-foreground/);
  assert.match(view, /\.sand-code-block \{[^}]*border: 1px solid var\(--cursor-stroke-tertiary/);
  assert.doesNotMatch(view, /\.sand-code-block \{[^}]*background: #1a1d19/);
  assert.doesNotMatch(view, /\.sand-code-block \{[^}]*color: #d9ded4/);
  // Fenced code is token-coloured through shiki's css-variables theme, mapped onto the Cursor palette like official.
  const highlighter = await readFrontend("frontend/src/recovered/features/conversation/workspace/code-highlighter.ts");
  const bootstrap = JSON.parse(await readFrontend("frontend/manifests/renderer-bootstrap.json"));
  assert.match(highlighter, /createCssVariablesTheme\(\{ name: CODE_HIGHLIGHT_THEME, variablePrefix: "--shiki-"/);
  assert.match(highlighter, /export const CODE_HIGHLIGHT_THEME = "css-variables";/);
  assert.match(highlighter, /createJavaScriptRegexEngine\(\{ forgiving: true \}\)/);
  assert.equal((highlighter.match(/^import \w+ from "@shikijs\/langs\//gm) ?? []).length, 77, "same grammar set as the official chunk");
  assert.match(highlighter, /shell: "shellscript"/); assert.match(highlighter, /zsh: "bash"/);
  assert.match(transcript, /import\("\.\/code-highlighter"\)/, "grammars stay behind a lazy boundary");
  assert.doesNotMatch(transcript, /^import (?!type ).*from "\.\/code-highlighter"/m);
  assert.match(transcript, /lines == null \? code : <HighlightedCodeLines lines=\{lines\} \/>/);
  assert.ok(bootstrap.lazyBoundaries.some((boundary) => boundary.cleanDynamicEntry === "src/recovered/features/conversation/workspace/code-highlighter.ts"));
  assert.match(view, /\.sand-code-block \{[^}]*--shiki-token-keyword: var\(--cursor-syntax-keyword\);/);
  assert.match(view, /\.sand-code-block \{[^}]*--shiki-token-type: var\(--cursor-syntax-type, var\(--cursor-syntax-constant\)\);/);
  assert.match(view, /\.sand-code-block \{[^}]*--shiki-foreground: var\(--cursor-syntax-foreground\);/);
  assert.doesNotMatch(view, /hljs/);
  assert.match(view, /\.sand-message-prose a \{[^}]*color: var\(--cursor-text-link/);
  assert.doesNotMatch(view, /\.sand-message-prose a \{[^}]*color: #bfe86b/);
  assert.match(view, /\.sand-message\[data-role="user"\] \{[^}]*color: var\(--sand-text-on-color/);
  assert.match(view, /\.sand-message \{[^}]*padding: 7px 16px;/);
  assert.match(transcript, /sand-jump-bottom/);
  assert.match(view, /\.sand-attachment__image \{[^}]*max-height: 480px;/);
  assert.doesNotMatch(view, /\.sand-prompt-shell \{[^}]*border-radius: 24px;/);
  const computerPane = await readFrontend("frontend/src/recovered/features/computer/shell/view.tsx");
  assert.doesNotMatch(computerPane, /ComputerScreenSwitcher/);
  assert.doesNotMatch(computerPane, /ComputerRuntimeDock/);
  assert.match(computerPane, /sand-info-pane__computer/);
  assert.match(computerPane, /const onHostKey = useCallback/);
  assert.match(computerPane, /data-open=\{isOpen \|\| undefined\}/);
  assert.match(computerPane, /aspectRatio: "16 \/ 9"/);
  assert.match(computerPane, /Math.max\(bounds.width \/ framebuffer.width, bounds.height \/ framebuffer.height\)/);
  const teachTopBar = await readFrontend("frontend/src/recovered/features/computer/teach-recording/view.tsx");
  assert.match(teachTopBar, /sand-computer-top-bar/);
  assert.match(teachTopBar, /Teach a task/);
  const teachMark = await readFrontend("frontend/src/recovered/features/computer/teach-recording/primitives.tsx");
  assert.match(teachMark, /fill="#ff263c"/);
  const teachComposition = await readFrontend("frontend/src/recovered/features/computer/teach-recording/composition.ts");
  assert.doesNotMatch(teachComposition, /openTrigger === "preview"/);
  const productionCss = await readFrontend("frontend/src/production/production.css");
  assert.match(productionCss, /overflow: hidden/);
  assert.match(productionCss, /100cqh \* 16 \/ 9/);
  assert.match(productionCss, /display: none !important/);
  assert.match(productionCss, /color-scheme: dark/);
  assert.match(productionCss, /fill: #ff263c/);
  assert.match(productionCss, /-webkit-app-region: no-drag;/);
  assert.match(productionCss, /html:has\(\.sand-computer-fullscreen\[data-open\]\) \.sand-workspace-rail/);
  assert.match(productionCss, /html:has\(\.sand-computer-fullscreen\[data-open\]\) \.sand-cover-drag/);
  assert.match(productionCss, /\.sand-computer-fullscreen\[data-open\]:not\(#\\#\)/);
  const vncWebview = await readFrontend("frontend/src/recovered/features/computer/shell/vnc-webview.tsx");
  assert.match(vncWebview, /callbacksRef/);
  assert.match(vncWebview, /\[bridge, forwardedRef, isInteractive, isViewerVisible, openedAtMs, src\]/);
  const routinesView = await readFrontend("frontend/src/recovered/features/automations/routines/view.tsx");
  assert.match(routinesView, /export function InfoPaneRoutines/);
  assert.match(routinesView, /Add routine/);
  assert.match(renderer, /InfoPaneRoutines/);
  assert.match(renderer, /startCreate: routinesCreate/);
  assert.match(renderer, /setRoutinesInfoPaneOpen\(true\)/);
  assert.match(renderer, /if \(routinesInfoPaneOpen\)/);
  assert.match(routinesView, /Back to screen/);
  assert.match(routinesView, /name="chevron-left"/);
  assert.match(routinesView, /name="chevrons-right"/);
  assert.doesNotMatch(routinesView, />Cancel</);
  assert.match(routinesView, /<RoutineRunHistory snapshot=\{runHistory\} \/>/);
  assert.match(routinesView, /sand-automation-toolbar/);
  assert.match(routinesView, /SandSwitch checked=\{enabled\} disabled=\{pending\}/);
  assert.match(routinesView, /variant="monochrome"/);
  assert.match(routinesView, /variant="secondary">\{running \? "Running…" : "Test run"\}/);
  assert.doesNotMatch(routinesView, /SandSwitch[^>]*disabled=\{create/);
  const routinesCss = await readFrontend("frontend/src/recovered/features/automations/routines/view.css");
  assert.match(routinesCss, /--sand-routine-inline: 12px/);
  assert.match(routinesCss, /background: var\(--sand-bg-elevated\)/);
  assert.match(routinesCss, /background: var\(--sand-fill-control-checked\)/);
  assert.match(routinesCss, /background: var\(--sand-fill-secondary\)/);
  assert.match(routinesCss, /padding: 8px 0 6px/);
  assert.match(routinesCss, /padding: 0 var\(--sand-routine-inline\)/);
  assert.match(routinesCss, /padding: 4px var\(--sand-routine-inline\) 12px/);
  assert.match(routinesCss, /border: 1px solid var\(--sand-border-default\)/);
  assert.match(routinesCss, /\.sand-automation-form \.sand-trigger-card:not\(\[data-filled\]\) \.sand-trigger-card__add \{[^}]*color: var\(--sand-text-secondary\)/s);
  assert.match(routinesCss, /\.sand-trigger-card__item:hover/);
  assert.match(routinesCss, /\.sand-trigger-card__remove/);
  assert.doesNotMatch(routinesCss, /--cursor-bg-input/);
  assert.doesNotMatch(routinesCss, /--sand-bg-base/);
  assert.doesNotMatch(routinesCss, /--cursor-bg-accent/);
  const formPrimitives = await readFrontend("frontend/src/recovered/ui/sand-form-primitives.tsx");
  assert.match(formPrimitives, /var\(--sand-fill-control-checked\)/);
  assert.match(formPrimitives, /var\(--sand-fill-control-track\)/);
  const triggerEditor = await readFrontend("frontend/src/recovered/features/automations/routines/schedule-editor.tsx");
  assert.match(triggerEditor, /platform: "webhook", label: "Webhook"/);
  assert.ok(triggerEditor.indexOf("Webhook") < triggerEditor.indexOf("On a schedule"));
  assert.match(triggerEditor, /When a webhook fires/);
  assert.match(triggerEditor, /createPortal/);
  assert.match(triggerEditor, /data-portaled="true"/);
  assert.match(routinesCss, /app-region: no-drag/);
  assert.match(routinesCss, /\[data-portaled\]/);
  assert.match(renderer, /setRoutinesInfoPaneOpen\(false\); setComputerInfoOpen\(false\)/);
  assert.doesNotMatch(
    routinesView.slice(routinesView.indexOf("export function InfoPaneRoutines")),
    /RoutineEditor/,
    "the screen-sidebar list must not inline the create/edit form",
  );
  assert.match(mediaViewer, /maxWidth: imageTileContextWidth\(\)/);
  assert.doesNotMatch(mediaViewer, /maxWidth: 320/);
  assert.match(view, /\.sand-transcript-row \{[^}]*margin: 0 0 8px;/);
  assert.match(view, /\.sand-virtual-transcript > \.sand-message-action-anchor \{[^}]*margin: 0 0 8px;/);
  assert.match(view, /\.sand-transcript-row\[data-role="user"\] \{[^}]*align-items: flex-end;/);
  assert.match(view, /\.sand-transcript-row\[data-role="assistant"\] \{[^}]*align-items: flex-start;/);
  // Official 0.18 hover actions are ghost buttons (measured 2026-09-07): transparent at rest, ghost fill on hover.
  assert.match(view, /\.sand-message-hover-actions__button \{[^}]*background: transparent;/);
  assert.match(view, /\.sand-message-hover-actions__button:hover \{[^}]*--sand-fill-ghost-hover/);
  assert.match(view, /\.sand-message-more-menu \{[^}]*background: var\(--cursor-bg-elevated\);/);
  assert.doesNotMatch(view, /\.sand-message-hover-actions__button \{[^}]*#20231f/);
  assert.doesNotMatch(view, /\.sand-message-more-menu \{[^}]*#20231f/);
  assert.match(sidebar, /rosterNavAgentsFromUnpinned\(unpinned, sections\)/);
  assert.match(sidebar, /listedUnpinned\.map/);
  const math = await readFrontend("frontend/src/recovered/features/conversation/workspace/math.tsx");
  assert.match(math, /splitMathSegments\(text\)/);
  const attachment = await readFrontend("frontend/src/recovered/features/conversation/cards/transcript-card/views/attachment.tsx");
  assert.match(attachment, /imageTileBox/);
  const media = await readFrontend("frontend/src/recovered/features/conversation/workspace/media-viewer.tsx");
  assert.match(media, /imageTileBox/);
  const selectHost = await readFrontend("frontend/src/production/patched-ui/SelectMessagesHost.tsx");
  assert.match(selectHost, /sand-sel-layer/);
  assert.match(selectHost, /sand-sel-box/);
  assert.match(selectHost, /SELECT_GUTTER_PX/);
  assert.match(selectHost, /SELECTABLE_ROW_SELECTOR/);
  assert.match(selectHost, /selectableRowsIn/);
  assert.match(selectHost, /sand-tombstones-changed/);
  assert.match(selectHost, /shiftKey/);
  assert.match(selectHost, /New collection/);
  assert.match(selectHost, /confirmDelete/);
  assert.match(selectHost, /!delFn \|\| !n/);
  const combobox = await readFrontend("frontend/src/production/patched-ui/AgentModelCombobox.tsx");
  assert.match(combobox, /comboboxMove/);
  assert.match(combobox, /inputRef\.current\?\.select/);
  assert.match(combobox, /onFocus=\{\(\) => \{ try \{ inputRef\.current\?\.select\(\); \} catch \{\} setFilter\(""\); show\(\); \}\}/);
  const surfaceOpenRouter = await readFrontend("frontend/src/recovered/features/settings/overlay/desktop-surface.tsx");
  assert.match(surfaceOpenRouter, /OpenRouterModelField model=\{openRouterModel\}/);
  const deleteHost = await readFrontend("frontend/src/production/patched-ui/DeleteMessageHost.tsx");
  assert.match(deleteHost, /findRow\(id\)\?\.appendChild\(box\)/);
});

whenFrontend("settings General tab matches the 0.43 Settings dialog: shell, cards, switch, select", async () => {
  // Measured live over CDP against Grok Bot 0.43.0 on 2026-09-05.
  const view = await readFrontend("frontend/src/recovered/features/settings/overlay/view.css");
  const shell = await readFrontend("frontend/src/recovered/features/settings/overlay/view.tsx");
  const panels = await readFrontend("frontend/src/recovered/features/settings/overlay/panels.tsx");
  const autoReview = await readFrontend("frontend/src/recovered/features/settings/overlay/auto-review.tsx");
  const card = await readFrontend("frontend/src/recovered/features/settings/overlay/settings-card.tsx");
  const formCss = await readFrontend("frontend/src/recovered/ui/sand-form-primitives.css");
  const formTsx = await readFrontend("frontend/src/recovered/ui/sand-form-primitives.tsx");
  const floating = await readFrontend("frontend/src/recovered/ui/sand-floating-primitives.tsx");
  const floatingCss = await readFrontend("frontend/src/recovered/ui/sand-floating-primitives.css");
  const installer = await readFrontend("frontend/src/recovered/features/runtime-theme-token-installer.ts");
  // Shell: 900x702, 198px nav on bg-subtle, 8px nav rows, tokens only.
  assert.match(view, /\.sand-settings-dialog \{[^}]*width: min\(900px, calc\(100vw - 32px\)\)/);
  assert.match(view, /\.sand-settings-dialog \{[^}]*height: min\(702px, calc\(100vh - 32px\)\)/);
  assert.match(view, /\.sand-settings-dialog \{[^}]*border: 1px solid var\(--cursor-stroke-secondary\)/);
  assert.doesNotMatch(view, /\.sand-settings-dialog \{[^}]*#414141/);
  assert.doesNotMatch(view, /\.sand-settings-dialog \{[^}]*Inter/);
  assert.match(view, /\.sand-settings-nav \{[^}]*width: 198px[^}]*background: var\(--sand-bg-subtle\)/);
  assert.match(view, /\.sand-settings-nav__item \{[^}]*padding: 7px 9px[^}]*border-radius: 8px/);
  assert.match(view, /\.sand-settings-nav__item:hover:not\(:disabled\) \{ background: var\(--cursor-bg-tertiary\); \}/);
  assert.match(view, /\.sand-settings-nav__item\[data-active\] \{ background: var\(--sand-fill-ghost-selected\); \}/);
  assert.match(view, /\.sand-settings-panel__header > h2 \{[^}]*font-size: 17px[^}]*line-height: 24px/);
  assert.match(view, /\.sand-settings-pane \{[^}]*padding: 22px 32px 28px/);
  assert.match(shell, /<header className="sand-settings-panel__header"><h2 id=\{headingId\}>/);
  assert.match(shell, /size=\{15\}/, "nav icons are 15px like official");
  // Sections: caption + one card, rows split by a 0.5px hairline.
  assert.match(card, /className="sand-settings-card"/);
  assert.match(view, /\.sand-settings-group > h3 \{[^}]*font-size: 12px[^}]*color: var\(--sand-text-secondary\)|\.sand-settings-group > h3 \{[^}]*color: var\(--sand-text-secondary\)[^}]*font-size: 12px/);
  assert.match(view, /\.sand-settings-card \{[^}]*background: var\(--sand-fill-neutral-subtle\)[^}]*border-radius: var\(--cursor-radius-xl, 14px\)/);
  assert.match(view, /\.sand-settings-card > \* \+ \*::before \{[^}]*height: \.5px[^}]*background: var\(--sand-border-default\)/);
  assert.match(view, /\.sand-settings-card__row \{[^}]*padding: 12px 14px/);
  assert.match(panels, /<SettingsGroup title="Bot">/);
  assert.doesNotMatch(panels, /<SettingsGroup title="Agent">/);
  assert.match(panels, /<SettingsCardRow id=\{sandSettingRowId\("theme"\)\} label="Theme">/);
  assert.match(panels, /<SettingsCardRow id=\{sandSettingRowId\("timezone"\)\} label="Timezone">/);
  assert.match(panels, /className="sand-account-card__name"/);
  assert.match(view, /\.sand-account-card__avatar \{[^}]*width: 44px/);
  assert.match(autoReview, /<SettingsCardRow description="Grok Bot checks each action[^"]*" id=\{sandSettingRowId\("auto-review"\)\} label="Auto-review">/);
  assert.match(autoReview, /<SettingsCardRow className="sand-auto-review" stack>/);
  assert.doesNotMatch(autoReview, /SandTextField/);
  // Switch: single 32x20 pill, control-checked fill, 12px knob travel.
  assert.match(formTsx, /ariaLabel/);
  assert.doesNotMatch(formTsx, /translateX\(16px\)/);
  assert.match(formCss, /\[role="switch"\] \{[^}]*width: 32px/);
  assert.match(formCss, /\[role="switch"\]\[aria-checked="true"\] > span \{[^}]*translate\(calc\(12px \* var\(--sand-inline-sign, 1\)\), -50%\)/);
  assert.match(formCss, /\[role="switch"\]\[aria-checked="true"\]:hover:not\(:disabled\) \{[^}]*--sand-fill-control-checked-hover/);
  // Select trigger: label + 10px chevron, 28px tall, neutral-subtle on border-subtle.
  assert.match(floating, /<span className="ui-select-trigger__label">/);
  assert.match(floating, /name="chevron-down" size=\{10\}/);
  assert.match(floatingCss, /\.ui-select-trigger \{[^}]*min-height: 28px[^}]*padding: 4px 5px 4px 7px/);
  assert.match(floatingCss, /\.ui-select-trigger \{[^}]*border: 1px solid var\(--sand-border-subtle\)/);
  assert.doesNotMatch(view, /\.sand-settings-dialog \.ui-select-trigger \{/);
  // Tokens corrected to the live 0.43 values.
  assert.match(installer, /--sand-font-weight-regular: 420/);
  assert.match(installer, /--cursor-font-weight-normal: 420/);
  assert.match(installer, /"--sand-text-disabled","light":"#14141474"/);
  assert.match(installer, /"--sand-border-focus","light":"#141414","dark":"#fcfcfc"/, "focus ring is black on light, white on dark; never blue");
  assert.doesNotMatch(view, /--cursor-text-blue-primary|--cursor-bg-blue-primary/, "no blue in the settings furniture");
  // The other tabs share the same card rows; the legacy boxed-row CSS is gone.
  for (const file of ["frontend/src/recovered/features/settings/overlay/computer-runtime.tsx", "frontend/src/recovered/features/settings/overlay/computer-view.tsx", "frontend/src/recovered/features/settings/overlay/provider-computers.tsx", "frontend/src/production/patched-ui/RouterUsagePanel.tsx", "frontend/src/production/patched-ui/DictationPanel.tsx", "frontend/src/production/patched-ui/OpenRouterModelField.tsx"]) {
    const source = await readFrontend(file);
    assert.match(source, /SettingsCardRow/, `${file} uses the shared card row`);
    assert.doesNotMatch(source, /className="sand-settings-row/, `${file} dropped the legacy row box`);
    assert.doesNotMatch(source, /sand-settings-copy|sand-provider-usage-card/, `${file} dropped legacy row copy`);
  }
  assert.doesNotMatch(panels, /sand-settings-row"|sand-settings-copy|sand-provider-usage-card|sand-usage-state|#ef8585/);
  assert.match(panels, /<SettingsGroup title="Updates">/);
  assert.match(panels, /label=\{<>Grok Bot <bdi>\{status\.currentVersion\}<\/bdi>/);
  assert.match(panels, /label="Auto-update when idle"/);
  assert.doesNotMatch(view, /\.sand-settings-row \{|\.sand-settings-copy \{|\.sand-provider-usage-card|\.sand-settings-uptodate-banner|\.sand-settings-dialog button:not/);
  assert.match(view, /\.sand-settings-status \{[^}]*border-radius: 10px/);
  const kitCss = await readFrontend("frontend/src/recovered/ui/sand-kit-primitives.css");
  assert.doesNotMatch(kitCss, /background: var\(--cursor-accent\);\n  color: var\(--cursor-base\);/);
  assert.match(kitCss, /\.sand-kit-button\.sand-18he5m:not\(#\\#\):not\(#\\#\):not\(#\\#\),\n\.sand-kit-button\.sand-6y9aml:not\(#\\#\):not\(#\\#\):not\(#\\#\) \{\n  background-color: var\(--sand-fill-danger\);/, "danger primary fill beats the stylex background reset");
  assert.match(kitCss, /\.sand-kit-button\.sand-1yrsyyn:not\(#\\#\):not\(#\\#\):not\(#\\#\):not\(#\\#\):not\(#\\#\) \{\n  padding: 6px 10px;/, "button labels are vertically centred (symmetric padding beats the stylex padding-top)");
  const computerView = await readFrontend("frontend/src/recovered/features/settings/overlay/computer-view.tsx");
  assert.match(computerView, /<SettingsStatusPill icon="check-circle">\{UP_TO_DATE_COPY\}<\/SettingsStatusPill>/);
  assert.match(computerView, /onClick=\{controller\.requestUpdate\}[^\n]*\{controller\.updateLabel\}<\/SandButton>\n\s+\{upToDate && state\.isDevBuild/, "the Update button stays visible when the computer is current");
});

whenFrontend("first-run is loader then provider picker, not the shell", async () => {
  const renderer = await readFrontend("frontend/src/production/ProductionRenderer.tsx");
  assert.match(renderer, /if \(bridge != null && account == null\)/);
  assert.match(renderer, /if \(showSignIn && bridge != null && account != null\)/);
  assert.match(renderer, /from "\.\.\/recovered\/features\/account\/session\/provider-landing"/);
  const landing = await readFrontend("frontend/src/recovered/features/account/session/provider-landing.tsx");
  // One provider: the OpenGrok server. No picker, no server-URL field; the URL is configuration.
  assert.match(landing, /export type FirstRunProvider = "opengrok";/);
  assert.doesNotMatch(landing, /id: "cursor"|id: "claude-code"|id: "codex"|Choose a provider|Server URL|<input/);
  assert.match(landing, /signInToOpenGrokServer\(""\)/, "an empty URL means the configured server");
  assert.match(landing, /server\?\.configuredUrl/);
  assert.match(landing, /OPENGROK_SERVER_UNCONFIGURED/);
  assert.match(landing, /<Mascot3D className="sand-onboarding__mark" size=\{88\} \/>/, "the sign-in mark is the live 3D mascot");
  const mascotComponent = await readFrontend("frontend/src/production/patched-ui/Mascot3D.tsx");
  assert.match(mascotComponent, /radialGradient/, "shaded sphere");
  assert.match(mascotComponent, /Math\.cos\(lat\) \* Math\.sin\(lon\)/, "eyes are projected onto the sphere");
  assert.match(mascotComponent, /st\.targetYaw = st\.pointerYaw >= 0 \? -Math\.PI : Math\.PI/, "turns its back away from the pointer when it comes close");
  assert.match(mascotComponent, /light-dark\(#0b0b0b, #f2f2f2\)/, "black on light, white on dark");
  assert.doesNotMatch(landing, /MascotLottie|lottie/);
  assert.match(mascotComponent, /const EYE_RX = 9; const EYE_RY = 15;/, "tall oval eyes");
  assert.match(mascotComponent, /window\.addEventListener\("pointerdown", onDown/, "a click blinks");
  assert.match(mascotComponent, /eye\.setAttribute\("cy", String\(C \+ R \* 0\.82 \* p\.y\)\)/, "screen y is down: pointer up looks up");
  assert.match(mascotComponent, /if \(near\) st\.bounceAt = performance\.now\(\);/, "turning away hops");
  assert.match(mascotComponent, /project\(st\.yaw \+ Math\.PI, st\.pitch \* 0\.4\)/, "the 8 sits on the back of the sphere");
  assert.match(mascotComponent, />8<\/text>/);
  assert.match(mascotComponent, /const BLINK_MS = 460;/, "a blink you can see, closing into two dashes");
  const character = await readFrontend("frontend/src/recovered/features/agent-character/character.tsx");
  assert.match(character, /resolvedColor === "black" \? \{ light: "light-dark\(#000000, #FFFFFF\)"/, "the brand mark is solid, not a black-to-white gradient");
  // Where the eyes look is part of the beat script now (choreography.ts) rather
  // than a wander timer, so every bot maps the same action to the same look;
  // a pointer, when one is steering, still wins.
  assert.match(character, /const steered = isFollowingPointer \|\| followTarget != null;/);
  assert.match(character, /const target = steered \? gazeRef\.current : pose\.gaze;/);
  assert.match(character, /characterPose\(beats, elapsed\)/);
  const landingCss = await readFrontend("frontend/src/production/production.css");
  assert.match(landingCss, /\.sand-onboarding__brand h1 \{ font-size: 72px;/, "the O sits just under the 69px visible ball");
  assert.match(landingCss, /p\.sand-onboarding__lede \{ max-width: 336px;/);
  assert.match(landing, /cancelOpenGrokSignIn/, "a stuck browser step can be cancelled or restarted");
  assert.doesNotMatch(landing, /Opening your browser/, "the button never goes dead while the browser step is pending");
  assert.match(landing, /Your bots live on your own server, and the work runs there\./);
  assert.match(landing, /Signing in opens your browser to your server\./);
  assert.match(landing, /finishWithoutCursor/);
  assert.match(landing, /writeOpenGrokMode\(true\)/);
  const mainEdge = await readFrontend("source/electron-main/main-edge.ts");
  assert.match(mainEdge, /configuredOpenGrokServerUrl\(deps\)/);
  assert.match(mainEdge, /OPENGROK_SERVER_URL_ENV = "OPENGROK_SERVER_URL"/);
  const services = await readFrontend("source/electron-main/main-production-services.ts");
  assert.match(services, /opengrokServerUrl/);
  const asar = await readFrontend("scripts/lib/build-asar.mjs");
  assert.match(asar, /stagedPackage\.opengrokServerUrl = serverUrl/);
  // onReady both opens the shell and re-reads who the sign-in finished as.
  assert.match(renderer, /onReady=\{\(\) => \{\n\s*setSubscriptionReady\(true\);/);
  assert.match(renderer, /bridge\.cursorAccount\.getStatus\(\)\.then\(\(status\) => observeAccountRef\.current\(status\)\)/);
  // The sign-in page has one provider now; there is no picker to go back to.
  assert.match(landing, /className="sand-onboarding__signin"/);
  assert.match(renderer, /title=\{BRAND_OPEN_NAME\}/);
  assert.match(renderer, /BRAND_OPEN_NAME/);
  const status = await readFrontend("frontend/src/recovered/features/account/session/sign-in-status.tsx");
  assert.match(status, /onSkip == null \? null/);
  assert.match(status, /className="sand-onboarding__cta"/);
  const css = await readFrontend("frontend/src/production/production.css");
  const ctaRule = css.match(/button\.sand-onboarding__cta \{[^}]+\}/)?.[0] ?? "";
  assert.match(css, /button\.sand-onboarding__signin \{[^}]*background: var\(--sand-fill-primary\);/, "the one sign-in pill is near-black, never accent");
  assert.doesNotMatch(css, /sand-onboarding__providers|sand-onboarding__gateway/);
  assert.match(ctaRule, /background: var\(--sand-fill-primary\);/);
  assert.match(ctaRule, /color: var\(--sand-text-on-primary\);/);
  assert.doesNotMatch(css, /\.sand-onboarding__landing button \{[^}]*--cursor-bg-accent/);
  assert.doesNotMatch(css, /\.sand-onboarding__landing button \{[^}]*--cursor-accent/);
  assert.doesNotMatch(ctaRule, /--cursor-bg-accent|--cursor-accent|#4f8cff|#1084fe/);
});

whenFrontend("openAgent does not bump the tail generation until it actually fetches", async () => {
  const renderer = await readFrontend("frontend/src/production/ProductionRenderer.tsx");
  const start = renderer.indexOf("const openAgent = useCallback");
  const fetch = renderer.indexOf("await client.call(\"openAgentTail\"", start);
  const bump = renderer.indexOf("++openAgentRequestGenerationRef.current", start);
  const guard = renderer.indexOf("if (!shouldOpen || hasLoadedEntries || client == null)", start);
  assert.ok(start >= 0 && fetch > start && bump > start && guard > start);
  assert.ok(guard < bump, "a second openAgent for the pending agent must not invalidate the in-flight tail");
  assert.ok(bump < fetch);
});

whenFrontend("dragging the rail past the expanded minimum uncollapses it", async () => {
  const layout = await readFrontend("frontend/src/recovered/features/conversation/workspace/sidebar-layout-state.ts");
  assert.match(layout, /export function sidebarLayoutFromResize/);
  assert.match(layout, /current\.isCollapsed && width >= SIDEBAR_LAYOUT_BOUNDS\.minExpandedWidth/);
  assert.match(layout, /isCollapsed: false/);
  const renderer = await readFrontend("frontend/src/production/ProductionRenderer.tsx");
  assert.match(renderer, /sidebarLayoutFromResize\(base, expandedWidth\)/);
});

whenFrontend("workspace chrome: right info pane, cover-drag, collapsed rail, new-agent roster", async () => {
  const renderer = await readFrontend("frontend/src/production/ProductionRenderer.tsx");
  assert.doesNotMatch(
    renderer,
    /WorkspaceIndicator/,
    "agent name belongs in the chat header, not over the traffic-light band",
  );
  assert.match(renderer, /className="sand-workspace-grid"/);
  assert.match(renderer, /const detailsPaneTrack = detailsPaneOpen/);
  assert.match(renderer, /minmax\(0, 1fr\) \$\{detailsPaneTrack\}/);
  assert.doesNotMatch(renderer, /minmax\(0, 1fr\) auto/);
  assert.match(renderer, /setAgents\(\(current\) => current\.some/);
  assert.match(renderer, /menuPlacement=\{renderedSidebarLayout\.isCollapsed \? "right-start" : "bottom-start"\}/);
  assert.match(renderer, /className="sand-agents-sidebar__dock"/);
  assert.match(renderer, /className="sand-workspace-rail__main"/);
  // New Bot moved OUT of the dock and onto the sidebar's brand row, next to the
  // name: a control that makes a new coworker belongs above the list of
  // coworkers, not under it. Deliberate departure from official 0.18, asked for
  // by the operator on 2026-09-07 — do not "restore" the dock entry.
  assert.doesNotMatch(renderer, />New Bot</);
  assert.match(renderer, /label="Collections"/);
  assert.match(renderer, />Groups</);
  assert.match(renderer, /sessionActive=\{subscriptionReady \|\| account\?\.kind === "logged-in"\}/);
  assert.match(renderer, /onSessionCleared/);
  assert.match(renderer, /forgetLoginWallSkip/);
  assert.match(renderer, /logOut: UI_TEXT\.signOut/);
  const production = await readFrontend("frontend/src/production/production.css");
  assert.match(production, /\.sand-workspace-grid \{/);
  assert.match(production, /\.sand-info-pane\[data-open\] \{/);
  assert.match(production, /\.sand-shell \{[^}]*--sand-info-pane-width: 320px;/s);
  assert.match(
    production,
    /\.sand-info-pane\[data-open\]:not\(#\\#\):not\(#\\#\):not\(#\\#\):not\(#\\#\):not\(#\\#\) \{[^}]*max-width: calc\(var\(--sand-info-pane-width, 320px\)/s,
  );
  assert.doesNotMatch(
    production,
    /\.sand-info-pane\[data-open\] \{[^}]*max-width: min\(480px/s,
    "open details must not grow past --sand-info-pane-width into an empty chrome column",
  );
  assert.match(production, /\.sand-info-pane__inner:not\(#\\#\):not\(#\\#\):not\(#\\#\):not\(#\\#\):not\(#\\#\) \{[^}]*width: 100%;/s);
  assert.match(production, /\.sand-info-pane__resize-handle:not\(#\\#\):not\(#\\#\):not\(#\\#\):not\(#\\#\):not\(#\\#\) \{[^}]*left: 0;/s);
  assert.match(production, /\.sand-computer-preview__frame \{[^}]*max-width: 100%;/s);
  assert.match(production, /\.sand-workspace-rail\[data-sidebar-collapsed\]/);
  assert.match(production, /padding-top: var\(--sand-titlebar-block, 52px\);/);
  assert.match(production, /\.sand-workspace-rail \{[^}]*background: var\(--cursor-bg-chrome\);/s);
  assert.match(production, /\.sand-workspace-rail \{[^}]*border-right: \.5px solid var\(--sand-border-weak\);/s);
  assert.match(production, /\.sand-agents-sidebar__brand \{/);
  assert.doesNotMatch(production, /\.sand-agents-sidebar__account > button > span:first-child \{[^}]*--sand-fill-accent/);
  const sidebar = await readFrontend("frontend/src/recovered/features/conversation/workspace/sidebar.tsx");
  assert.match(sidebar, /className="sand-agents-sidebar__brand"/);
  assert.match(sidebar, /BRAND_OPEN_NAME/);
  assert.match(sidebar, /sand-agents-sidebar__expand/);
  assert.match(sidebar, /onToggleCollapsed/);
  // The rail's toggle is the sidebar glyph, not a back arrow, and the rail no
  // longer carries the brand mark: it read as another agent above the agents
  // (operator's call, 2026-09-07).
  assert.match(sidebar, /name="layout-sidebar-left"/);
  assert.doesNotMatch(sidebar, /isCollapsed \? "md" : "sm"/);
  assert.match(sidebar, /agentId="open-grok-brand"/);
  assert.match(sidebar, /shape="blob"/);
  // New Bot is on the brand row now, inside the expanded branch only: the rail
  // is a column of coworkers and a toggle, nothing else. It used to be the last
  // item in the dock (operator's call, 2026-09-07) — do not restore it there.
  assert.match(sidebar, /aria-label="New Bot" className="sand-agents-sidebar__new"/);
  assert.doesNotMatch(sidebar, /isCollapsed[\s\S]{0,200}sand-agents-sidebar__new/);
  assert.match(renderer, /onToggleCollapsed=/);
  assert.match(production, /sand-agents-sidebar__dock-label/);
  // ONE vertical spec for both states: every row in the sidebar column is
  // --sand-sidebar-row tall with --sand-sidebar-gap between, so collapsing to
  // the rail moves things sideways and never up or down. The rail therefore
  // carries a search cell of its own, or it would be one row short and
  // everything below it would jump (operator's call, 2026-09-07).
  assert.match(production, /--sand-sidebar-row: 54px;/);
  // A send that failed reads as a centred line in the conversation, not under
  // the composer, where the grid put it below the text in the pill and flex put
  // it above the text in the box (operator's call, 2026-09-07).
  const composerSource = await readFrontend("frontend/src/recovered/features/conversation/workspace/composer.tsx");
  const workspaceView = await readFrontend("frontend/src/recovered/features/conversation/workspace/view.css");
  const transcript = await readFrontend("frontend/src/recovered/features/conversation/workspace/transcript.tsx");
  const rendererSource = await readFrontend("frontend/src/production/ProductionRenderer.tsx");
  assert.doesNotMatch(composerSource, /className="sand-prompt-attachment-notice"/);
  assert.match(workspaceView, /\.sand-transcript-notice \{/);
  assert.match(rendererSource, /notice=\{notice\}/);
  // A row carrying a client-side delivery state is our own send, whatever the
  // stored entry's role says — it belongs on the right, with its Resend and
  // Delete actions.
  assert.match(transcript, /const sideRoleOf =/);
  assert.match(transcript, /data-role=\{sideRoleOf\(entry\)\}/);
  // The unlabelled title-bar dot and the unstyled roster reconnect notice are
  // both unmounted; the reconnect banner says it once, centred.
  assert.doesNotMatch(rendererSource, /<WindowStatusBadge/);
  const connection = await readFrontend("frontend/src/recovered/features/root-resilience/connection-state.ts");
  assert.match(connection, /void RosterReconnectNotice;\n  return null;/);
  // The banner centres itself; this rule only drops it below the title bar.
  // Setting left/width/transform here pinned the pill off the left edge.
  assert.match(workspaceView, /\.sand-computer-reconnect-banner:not\(#\\#\):not\(#\\#\) \{[^}]*transform: none;/);
  assert.doesNotMatch(workspaceView, /\.sand-computer-reconnect-banner[^{]*\{[^}]*translateX/);
  // The row menu is official's shape: left-aligned rows with glyphs and rules.
  assert.match(production, /\.sand-agent-row-menu \{/);
  /*
   * Electron resolves -webkit-app-region: drag in the OS, BEFORE the page sees
   * the mouse, so it ignores z-index and ignores what is painted on top. The
   * rail is a full-height drag strip whose only holes are its own buttons (the
   * roster rows), and a surface portalled to <body> is not its descendant — so
   * a context menu opened low on the roster was dead wherever it covered the
   * empty rail below the last row: no hover, no click, and a drag moved the
   * window (operator's report, 2026-09-07). Anything that floats over the rail
   * must punch its own no-drag hole. Do not remove these.
   */
  /*
   * THE INVARIANT: nothing below the title bar is a drag region. One strip
   * exists, .sand-cover-drag across the top 52px. The rail was a full-height
   * drag strip and the chat header was one too, which is what produced three
   * dead-spot bugs; they are not any more. Verify with
   * docs/research/tools/cdp-drag-regions.mjs, which exits 1 on a violation.
   */
  assert.doesNotMatch(production, /\.sand-workspace-rail \{[^}]*app-region: drag;/s, "the rail must not be a drag region");
  assert.doesNotMatch(workspaceView, /\.sand-chat-header \{[^}]*app-region: drag;/s, "nor the chat header");
  assert.match(production, /\.sand-agent-hover-card \*,[\s\S]*?app-region: no-drag;/);
  assert.match(production, /\[data-ui-dialog-root\] \*,/);
  // The other half: a menu is dismissed by clicking AWAY from it, and the empty
  // chrome is where people aim. A click on bare drag region never reaches the
  // page, so the outside-press listener never fires and the menu will not close.
  assert.match(production, /html:has\(\[data-component="menu-popup"\]\) \.sand-workspace-rail,/);
  assert.match(production, /html:has\(\[data-ui-dialog-root\]\) \.sand-chat-header \{[^}]*app-region: no-drag !important;/s);
  // Tooltips and hover cards close on pointer movement, never on a click. If they
  // were listed the title bar would stop dragging for as long as one is on screen.
  assert.doesNotMatch(production, /html:has\(\[data-component="tooltip-popup"\]\)/);
  assert.doesNotMatch(production, /html:has\(\.sand-agent-hover-card\)/);
  const floating = await readFrontend("frontend/src/recovered/ui/sand-floating-primitives.css");
  assert.match(floating, /\[data-sand-floating-surface="true"\] \*\s*\{[^}]*app-region: no-drag;/s);
  // Never stretch a row's children: the leading glyph is one of them, and a
  // width:100% on it pushed every label out of the menu.
  assert.doesNotMatch(production, /\.sand-agent-row-menu[^{]*> span[^{]*\{[^}]*width: 100%/);
  assert.match(production, /\.sand-agent-row-menu \.ui-icon:not\(#\\#\):not\(#\\#\) \{[^}]*width: 14px;/);
  // A disabled row is dimmed text and nothing else. The secondary button keeps a
  // fill when disabled, which made "Move up" and "Move down" read as the
  // selected rows — the opposite of what they are.
  assert.match(production, /:disabled \{\s*background: transparent;/);
  assert.match(production, /:hover:not\(:disabled\) \{ background: var\(--cursor-bg-secondary\); \}/);
  assert.match(production, /--sand-sidebar-gap: 4px;/);
  assert.match(production, /\.sand-agents-sidebar__rail-search \{/);
  assert.match(sidebar, /className="sand-agents-sidebar__rail-search"/);
  assert.doesNotMatch(production, /--sand-rail-gap/, "the rail no longer keeps a rhythm of its own");
  const hover = await readFrontend("frontend/src/recovered/features/conversation/workspace/view.css");
  assert.match(hover, /\.sand-agent-hover-card \{/);
  assert.match(hover, /width: 260px;/);
  assert.match(hover, /position: fixed;/);
  assert.match(hover, /z-index: var\(--sand-layer-popover\);/);
  const preview = await readFrontend("frontend/src/recovered/features/conversation/workspace/sidebar-agent-preview-content.tsx");
  assert.match(preview, /rect\.right - 9/);
  assert.doesNotMatch(preview, /#20231f/);
  const previewHeader = await readFrontend("frontend/src/recovered/features/conversation/workspace/sidebar-agent-preview-header.tsx");
  assert.match(previewHeader, /size: "xs"/);
  const chrome = await readFrontend("frontend/src/recovered/features/window-chrome/view.css");
  assert.match(chrome, /\.sand-cover-drag \{[^}]*z-index: 0;/);
  assert.match(chrome, /\.sand-cover-drag \{[^}]*pointer-events: none;/);
  const header = await readFrontend("frontend/src/recovered/features/conversation/workspace/view.css");
  // The header was a drag region in official 0.18 and here until 2026-09-07.
  // It is not any more: .sand-cover-drag covers the same 52px band, and a drag
  // region under an overlay is a dead spot no z-index can beat. See the
  // invariant pinned further up this file.
  assert.doesNotMatch(header, /\.sand-chat-header \{[^}]*app-region: drag;/s);
  assert.match(chrome, /\.sand-cover-drag \{[^}]*app-region: drag;/s, "the one strip that stays");
  const model = await readFrontend("frontend/src/production/model.ts");
  assert.match(model, /isRecord\(value\) && Array\.isArray\(value\.agents\)/);
  const computer = await readFrontend("frontend/src/recovered/features/computer/shell/view.tsx");
  assert.doesNotMatch(computer, /if \(isInfoOpen && !active\) return null;/);
  const menu = await readFrontend("frontend/src/recovered/features/account/session/menu.tsx");
  assert.match(menu, /account\.displayName == null && \(account\.email == null \|\| account\.email\.length === 0\)/);
  assert.match(menu, /placement=\{menuPlacement\}/);
  assert.match(menu, /sessionActive = false/);
  assert.match(menu, /const signedIn = account\?\.kind === "logged-in" \|\| sessionActive/);
  assert.match(menu, /\{signedIn \?/);
  const signOut = await readFrontend("frontend/src/recovered/features/account/session/sign-out.tsx");
  assert.match(signOut, /onSessionCleared\?\.\(\)/);
});

/**
 * Transcript images are served over sand-media://. The recovered renderer only
 * trusted that scheme for media-src, and V1 added it to img-src with a patch
 * (router-renderer-patch.mjs, "img-src media scheme"). The Vite shell carries
 * its own CSP, so the same allowance has to live there: without it every
 * transcript <img> gets a 200 from the protocol handler and still decodes to
 * 0x0 while video plays — found by the mock-cards fixture catalogue.
 */
test("frontend CSP lets <img> load sand-media:// like media-src already does", { skip: !present }, async () => {
  const html = await readFile(path.join(FRONTEND, "index.html"), "utf8");
  const csp = /content="([^"]*)"/.exec(html.match(/<meta[^>]*Content-Security-Policy[^>]*>/)?.[0] ?? "")?.[1] ?? "";
  const directive = (name) => csp.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name} `)) ?? "";
  assert.match(directive("media-src"), /\bsand-media:/);
  assert.match(directive("img-src"), /\bsand-media:/, "img-src must trust the scheme the transcript serves images from");
});
