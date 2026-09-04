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
 * still runs the helper tests; CI with stow restored runs these ports so PR8
 * can flip the packager without losing coverage.
 */
test("frontend patched-ui skip contract: import ports when frontend/ is present, skip when absent", async () => {
  const packager = await readFile(path.join(repoRoot, "scripts/package-macos.mjs"), "utf8");
  assert.doesNotMatch(packager, /package-vite/, "PR8 flips the packager; this PR does not");
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

whenFrontend("login-wall skip is refused on an OpenGrok server", async () => {
  const { loaded, cleanup } = await loadPatched();
  try {
    const store = new Map();
    const storage = { getItem: (k) => store.get(k) ?? null, setItem(k, v) { store.set(k, v); } };
    assert.equal(loaded.maySkipLoginWall(storage), false);
    loaded.rememberLoginWallSkip(storage);
    assert.equal(loaded.maySkipLoginWall(storage), true);
    store.set(loaded.OPENGROK_MODE_KEY, "1");
    assert.equal(loaded.maySkipLoginWall(storage), false, "an OpenGrok server is a backend: the wall stands");
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
  const renderer = await readFrontend("frontend/src/production/ProductionRenderer.tsx");
  assert.match(renderer, /AgentModelCombobox/);
  assert.match(renderer, /AgentUsagePane/);
  assert.match(renderer, /AutoReviewPane/);
  assert.match(renderer, /DeleteMessageHost/);
  assert.match(renderer, /SelectMessagesHost/);
  assert.match(renderer, /maySkipLoginWall/);
  assert.match(renderer, /shouldShowCursorLoginWall\(account, \{ skipped: subscriptionReady \}\)/);
  assert.match(renderer, /filterTombstonedEntries/);
  const sidebar = await readFrontend("frontend/src/recovered/features/conversation/workspace/sidebar.tsx");
  assert.match(sidebar, /CollectionsRailButton/);
  assert.match(sidebar, /data-agent-id=\{agent\.id\}/);
  const actions = await readFrontend("frontend/src/recovered/features/conversation/cards/transcript-card/auto-review-actions.ts");
  assert.match(actions, /alwaysAllowForCoworker/);
  const approval = await readFrontend("frontend/src/recovered/features/conversation/cards/transcript-card/views/auto-review-approval.tsx");
  assert.match(approval, /alwaysAllowSettledNote/);
  const menu = await readFrontend("frontend/src/recovered/features/conversation/cards/transcript-card/message-actions.tsx");
  assert.match(menu, /Select messages/);
  assert.match(menu, /Delete message/);
  const transcript = await readFrontend("frontend/src/recovered/features/conversation/workspace/transcript.tsx");
  assert.match(transcript, /convertLatexDelimiters/);
  assert.match(transcript, /splitMathSegments/);
  assert.match(transcript, /<p>\{renderAssistantInlineText\(visible\.text\)\}<\/p>/);
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
