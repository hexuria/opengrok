import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_USAGE_HELPER } from "../scripts/lib/agent-usage-helper.mjs";

/** A settings pane, the Model block already in it, and the one door the helper calls. */
function fakePage({ spend, agent = "cw_1" } = {}) {
  const element = (tag) => {
    const el = { tag, children: [], attrs: {}, style: {}, _text: "", className: "", innerHTML: "", parent: null, isConnected: true,
      get textContent() { return this._text; }, set textContent(v) { this._text = v; this.children = []; },
      get previousElementSibling() { const s = this.parent?.children ?? []; return s[s.indexOf(this) - 1] ?? null; },
      appendChild(child) { child.remove(); this.children.push(child); child.parent = this; return child; },
      insertAdjacentElement(where, child) { child.remove(); const s = this.parent.children; s.splice(s.indexOf(this) + (where === "afterend" ? 1 : 0), 0, child); child.parent = this.parent; return child; },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; },
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; },
      querySelector(sel) { const m = sel.match(/^\.([\w-]+)$/); if (m) return this.children.find((c) => c.className === m[1]) ?? null;
        const d = sel.match(/^\[data-usage-(\w+)\]$/); if (d) return this.parts?.[d[1]] ?? null; return null; } };
    return el;
  };
  const pane = element("div"); pane.className = "sand-agent-settings";
  const model = element("div"); model.className = "sand-lp-model"; pane.appendChild(model);
  const item = { getAttribute: (k) => (k === "data-agent-id" ? agent : null) };
  const head = element("head");
  const document = { createElement: element, head, documentElement: element("html"),
    querySelector: (sel) => (sel.startsWith(".sand-agent-item") ? item : sel === ".sand-lp-usage" ? pane.querySelector(".sand-lp-usage") : null),
    querySelectorAll: (sel) => (sel === ".sand-agent-settings" ? [pane] : []) };
  // innerHTML is opaque to this fake; the helper's four parts are handed to it by name.
  const realCreate = document.createElement;
  document.createElement = (tag) => { const el = realCreate(tag); if (tag === "div") { el.parts = { note: realCreate("p"), rows: realCreate("table"), err: realCreate("p") }; } return el; };
  const calls = [];
  const window = { desktop: { agent: { getCoworkerSpend: (id) => { calls.push(id); return spend instanceof Error ? Promise.reject(spend) : Promise.resolve(spend); } } } };
  const timers = [];
  const globals = { document, window, MutationObserver: class { observe() {} }, setInterval: (fn) => { timers.push(fn); return 1; }, clearInterval() {}, Date };
  new Function(...Object.keys(globals), AGENT_USAGE_HELPER)(...Object.values(globals));
  return { api: window.__sandUsage, pane, model, calls, timers, settle: () => new Promise((r) => setTimeout(r, 0)) };
}

const win = (window, extra = {}) => ({ window, usedUsd: "0.000000", limitUsd: null, freesAt: null, ...extra });
const NOW = Date.parse("2026-09-03T00:00:00Z");
// The month resets on a calendar day, written the way this machine writes dates.
const OCT_1 = "resets " + new Date(Date.parse("2026-10-01T00:00:00Z")).toLocaleDateString(undefined, { day: "numeric", month: "short" });

test("a subscription seat is worded in requests and what the same turns would have cost on an API key", () => {
  const { api } = fakePage();
  const d = api.describe({ available: true, spend: { metered: true, seat: "subscription", keyPrefix: "oag_live_c27dbfc", limits: {},
    windows: [win("5h", { requests: 2, counterfactualUsd: "0.001153", freesAt: "2026-09-03T03:29:11Z" }), win("7d", { requests: 12, counterfactualUsd: "0.41", freesAt: "2026-09-09T22:29:11Z" }), win("month", { requests: 0, counterfactualUsd: "0", freesAt: "2026-10-01T00:00:00Z" })] } }, NOW);
  assert.equal(d.hidden, false);
  assert.equal(d.note, "Subscription seat · key oag_live_c27dbfc…");
  assert.deepEqual(d.rows.map((r) => [r.label, r.figure, r.when]), [
    ["Last 5 hours", "2 requests · $0.0012 on API", "frees in 3h 29m"],
    ["Last 7 days", "12 requests · $0.41 on API", "frees in 6d 22h"],
    ["This month", "nothing yet", OCT_1],
  ]);
});

test("an API key is money against its limit, and a window with nothing in it says so", () => {
  const { api } = fakePage();
  assert.equal(api.figure(win("5h", { usedUsd: "0.120000", limitUsd: "5.000000", requests: 3 }), "api"), "$0.12 of $5.00 · 3 requests");
  assert.equal(api.figure(win("7d", { usedUsd: "1.500000" }), "api"), "$1.50 · no limit");
  assert.equal(api.figure(win("month", { limitUsd: "20.000000" }), "api"), "nothing yet · limit $20.00");
  assert.equal(api.figure(win("month"), "api"), "nothing yet");
});

test("without the server's seat hint, zero cost beside a real counterfactual reads as a subscription", () => {
  const { api } = fakePage();
  assert.equal(api.figure(win("5h", { counterfactualUsd: "0.30", requests: 4 }), null), "4 requests · $0.30 on API");
  assert.equal(api.figure(win("5h", { usedUsd: "0.25", requests: 4 }), null), "$0.25 · no limit · 4 requests");
  assert.equal(api.figure(win("5h"), null), "nothing yet", "an older server sends neither field");
  assert.equal(api.figure(win("5h", { freesAt: "2026-09-03T03:29:11Z" }), null), "$0.00 spent", "but a window that frees something has spend in it, priced at zero");
  assert.equal(api.figure(win("month", { freesAt: "2026-10-01T00:00:00Z", limitUsd: "5" }), "api"), "nothing yet · limit $5.00", "the month always has a reset date; that is not spend");
  assert.equal(api.figure(win("5h", { freesAt: "2026-09-03T03:29:11Z", requests: 0 }), null), "nothing yet", "a count of zero is the server's word over the clock");
});

test("on an older server the month cannot tell on its own: spend in a shorter window is spend in the month", () => {
  const { api } = fakePage();
  const d = api.describe({ available: true, spend: { metered: true, windows: [win("5h", { freesAt: "2026-09-03T03:29:11Z" }), win("month", { freesAt: "2026-10-01T00:00:00Z" })] } }, NOW);
  assert.deepEqual(d.rows.map((r) => r.figure), ["$0.00 spent", "$0.00 spent"]);
  const e = api.describe({ available: true, spend: { metered: true, windows: [win("5h"), win("month", { freesAt: "2026-10-01T00:00:00Z" })] } }, NOW);
  assert.deepEqual(e.rows.map((r) => r.figure), ["nothing yet", "nothing yet"]);
});

test("a coworker that is not metered says why, in the server's words", () => {
  const { api } = fakePage();
  const d = api.describe({ available: true, spend: { metered: false, note: "the deployment's key carried this turn", windows: [] } });
  assert.equal(d.note, "Not metered: the deployment's key carried this turn");
  assert.deepEqual(d.rows, []);
  assert.equal(api.describe({ available: false }).hidden, true, "a route with no OpenGrok server has no meter");
  assert.match(api.describe({ available: true, error: "pool timed out" }).error, /could not be asked\. pool timed out/);
});

test("the block mounts directly under the Model block, keyed on the coworker, and reads the meter", async () => {
  const { pane, model, calls, settle } = fakePage({ spend: { available: true, spend: { metered: true, seat: "api", windows: [win("5h", { usedUsd: "0.5" })] } } });
  await settle();
  const box = pane.querySelector(".sand-lp-usage");
  assert.ok(box, "mounted");
  assert.equal(box.previousElementSibling, model, "under Model");
  assert.equal(box.getAttribute("data-lp-usage"), "cw_1");
  assert.deepEqual(calls, ["cw_1"]);
  assert.equal(box.parts.note.textContent, "API key");
  assert.equal(box.parts.rows.children.length, 1);
  assert.equal(box.parts.rows.children[0].children[1].textContent, "$0.50 · no limit");
});

test("a server that cannot be asked leaves a sentence, not a stuck 'Reading the meter'", async () => {
  const { pane, settle } = fakePage({ spend: new Error("ECONNREFUSED") });
  await settle();
  const box = pane.querySelector(".sand-lp-usage");
  assert.match(box.parts.err.textContent, /could not be asked\. ECONNREFUSED/);
});
