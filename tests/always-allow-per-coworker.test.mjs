import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as acorn from "acorn";

import {
  ALLOW_RULE_CEILING,
  ALWAYS_ALLOW_ANCHORS,
  OPENGROK_MODE_STORAGE_KEY,
  patchOriginalAlwaysAllowScope,
} from "../scripts/lib/always-allow-patch.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cardChunk = path.join(repoRoot, "src/app/dist/renderer/assets/view-QqBtBG74.js");

const parses = (source) => acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" });

function readCardChunk() {
  try {
    return readFileSync(cardChunk, "utf8");
  } catch {
    return null; // the recovered app is not in every checkout; the fixture tests still run
  }
}

// The card that asks "may this run?" is lazily imported and lives in neither chunk the rest of
// the pipeline patches. Upstream writes an accepted rule to the GLOBAL allow list, so one answer
// on one coworker's card silently governs every coworker.
test("the anchors match exactly once in the real approval-card chunk", () => {
  const source = readCardChunk();
  if (source === null) return; // nothing to pin without the recovered app
  for (const anchor of ALWAYS_ALLOW_ANCHORS) {
    let count = 0;
    let at = 0;
    while ((at = source.indexOf(anchor, at)) !== -1) {
      count += 1;
      at += anchor.length;
    }
    assert.equal(count, 1, `anchor matched ${count} times: ${anchor.slice(0, 60)}`);
  }
});

test("patching the real chunk parses, is idempotent, and glues no call to a keyword", () => {
  const source = readCardChunk();
  if (source === null) return;
  const patched = patchOriginalAlwaysAllowScope(source);
  parses(patched);
  assert.ok(patched.includes("de(r.autoReviewInstructions,N,s)"), "the coworker id reaches the writer");
  assert.ok(patched.includes("__sandAlwaysAllowForCoworker"), "the writer is injected");
  assert.equal(patchOriginalAlwaysAllowScope(patched), patched, "a second pass changes nothing");
  assert.ok(
    !/[\p{ID_Continue}$]__sand(PerCoworkerAllow|AlwaysAllowForCoworker)\(/u.test(patched),
    "a call glued onto the token before it would be an undeclared identifier at run time",
  );
});

test("an anchor that stopped matching fails the patch instead of shipping", () => {
  assert.throws(() => patchOriginalAlwaysAllowScope("const a = 1;"), /matched 0 times/);
});

/** Run the injected helpers against a fake bridge, the way the page would. */
function runHelpers({ mode, bridge }) {
  const source = readCardChunk();
  if (source === null) return null;
  const patched = patchOriginalAlwaysAllowScope(source);
  const start = patched.indexOf("function __sandPerCoworkerAllow()");
  const end = patched.indexOf("async function de(");
  const helpers = patched.slice(start, end);
  const store = new Map();
  if (mode) store.set(OPENGROK_MODE_STORAGE_KEY, "1");
  const localStorage = { getItem: (key) => store.get(key) ?? null };
  const globalThisStub = { desktop: bridge === null ? undefined : { agent: bridge } };
  const factory = new Function(
    "localStorage",
    "globalThis",
    `${helpers} return { perCoworker: __sandPerCoworkerAllow, write: __sandAlwaysAllowForCoworker };`,
  );
  return factory(localStorage, globalThisStub);
}

test("on an OpenGrok server the rule goes to that coworker's own list, and the block list survives", async () => {
  const calls = [];
  const helpers = runHelpers({
    mode: true,
    bridge: {
      getAgentAutoReview: async (agentId) => {
        calls.push(["get", agentId]);
        return { available: true, row: { enabled: true, allowInstructions: "old rule", blockInstructions: "never this" } };
      },
      setAgentAutoReview: async (agentId, policy) => { calls.push(["set", agentId, policy]); },
    },
  });
  if (helpers === null) return;
  assert.equal(await helpers.write("cw_1", "run `ls`"), true);
  assert.deepEqual(calls[0], ["get", "cw_1"]);
  const [, agentId, policy] = calls[1];
  assert.equal(agentId, "cw_1");
  assert.deepEqual(policy.allowInstructions, ["old rule", "run `ls`"], "appended, not replaced");
  assert.deepEqual(policy.blockInstructions, ["never this"], "the whole-row PUT would erase this if it were dropped");
  assert.equal(policy.enabled, true);
});

test("a rule already on the coworker is not written twice", async () => {
  let writes = 0;
  const helpers = runHelpers({
    mode: true,
    bridge: {
      getAgentAutoReview: async () => ({ available: true, row: { allowInstructions: ["run `ls`"] } }),
      setAgentAutoReview: async () => { writes += 1; },
    },
  });
  if (helpers === null) return;
  assert.equal(await helpers.write("cw_1", "run `ls`"), true);
  assert.equal(writes, 0);
});

test("the coworker list is capped like the global one, oldest dropped", async () => {
  let written = null;
  const existing = Array.from({ length: ALLOW_RULE_CEILING }, (_, index) => `rule ${index}`);
  const helpers = runHelpers({
    mode: true,
    bridge: {
      getAgentAutoReview: async () => ({ available: true, row: { allowInstructions: existing } }),
      setAgentAutoReview: async (_id, policy) => { written = policy.allowInstructions; },
    },
  });
  if (helpers === null) return;
  await helpers.write("cw_1", "the newest");
  assert.equal(written.length, ALLOW_RULE_CEILING);
  assert.equal(written.at(-1), "the newest");
  assert.equal(written[0], "rule 1", "the oldest rule aged out");
});

// The coworker tier only exists on an OpenGrok server. On the Cursor route, or when the bridge
// or the server cannot answer, the original global write must still happen: a rule the person
// was told was saved must not vanish.
test("it declines, so the global path runs, when there is no coworker tier to write to", async () => {
  const bridge = {
    getAgentAutoReview: async () => ({ available: true, row: {} }),
    setAgentAutoReview: async () => {},
  };
  const off = runHelpers({ mode: false, bridge });
  if (off === null) return;
  assert.equal(await off.write("cw_1", "run `ls`"), false, "Cursor route: no coworker tier");

  const noBridge = runHelpers({ mode: true, bridge: null });
  assert.equal(await noBridge.write("cw_1", "run `ls`"), false, "no desktop bridge");

  const unavailable = runHelpers({
    mode: true,
    bridge: { getAgentAutoReview: async () => ({ available: false }), setAgentAutoReview: async () => {} },
  });
  assert.equal(await unavailable.write("cw_1", "run `ls`"), false, "no server configured");

  const refused = runHelpers({
    mode: true,
    bridge: { getAgentAutoReview: async () => ({ available: true, error: "boom" }), setAgentAutoReview: async () => {} },
  });
  assert.equal(await refused.write("cw_1", "run `ls`"), false, "the server refused the read");

  const noAgent = runHelpers({ mode: true, bridge: {} });
  assert.equal(await noAgent.write("cw_1", "run `ls`"), false, "an older bridge without the methods");

  assert.equal(await off.write("", "run `ls`"), false, "no coworker on the card");
  assert.equal(await off.write("cw_1", ""), false, "no rule proposed");
});
