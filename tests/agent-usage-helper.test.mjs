import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_USAGE_HELPER } from "../scripts/lib/agent-usage-helper.mjs";

/** A settings pane with the Model block in it, a body for the modal, and the doors the helper calls. */
function fakePage({ usage, spend, limit, catalogue, saveResult, agent = "cw_1" } = {}) {
  const element = (tag) => {
    const e = { tag, children: [], attrs: {}, style: {}, _text: "", className: "", parent: null, isConnected: true, listeners: {}, value: "", disabled: false, hidden: false, title: "",
      get textContent() { return this._text; }, set textContent(v) { this._text = v; this.children = []; },
      get previousElementSibling() { const s = this.parent?.children ?? []; return s[s.indexOf(this) - 1] ?? null; },
      appendChild(c) { c.remove(); this.children.push(c); c.parent = this; return c; },
      append(...cs) { cs.forEach((c) => this.appendChild(c)); },
      insertAdjacentElement(where, c) { c.remove(); const s = this.parent.children; s.splice(s.indexOf(this) + (where === "afterend" ? 1 : 0), 0, c); c.parent = this.parent; return c; },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; },
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; },
      addEventListener(k, fn) { this.listeners[k] = fn; }, focus() {},
      querySelector(sel) { const m = sel.match(/^\.([\w-]+)$/); return m ? this.children.find((c) => c.className === m[1]) ?? null : null; } };
    return e;
  };
  const pane = element("div"); pane.className = "sand-agent-settings";
  const model = element("div"); model.className = "sand-lp-model"; pane.appendChild(model);
  const item = { getAttribute: (k) => (k === "data-agent-id" ? agent : k === "aria-label" ? "New Bot" : null), textContent: "New Bot" };
  const body = element("body"); const head = element("head");
  const docListeners = {};
  const document = { createElement: element, head, body, documentElement: element("html"),
    querySelector: (sel) => (sel.startsWith(".sand-agent-item") ? item : sel === ".sand-lp-usage" ? pane.querySelector(".sand-lp-usage") : null),
    querySelectorAll: (sel) => (sel === ".sand-agent-settings" ? [pane] : []),
    addEventListener: (k, fn) => { docListeners[k] = fn; }, removeEventListener: (k) => { delete docListeners[k]; } };
  const calls = { usage: [], spend: [], limit: [], save: [] };
  const answer = (v) => (v instanceof Error ? Promise.reject(v) : Promise.resolve(typeof v === "function" ? v() : v));
  const agentApi = {
    getCoworkerUsage: (id, w) => { calls.usage.push([id, w]); return answer(usage); },
    getCoworkerSpend: (id) => { calls.spend.push(id); return answer(spend); },
    getCoworkerLimit: (id) => { calls.limit.push(id); return answer(limit); },
    setCoworkerLimit: (id, cap, dayCap) => { calls.save.push([id, cap, dayCap]); return answer(saveResult ?? { saved: true }); },
  };
  const window = { desktop: { agent: agentApi } };
  if (catalogue !== undefined) window.__sandModels = { catalogue: () => Promise.resolve(catalogue), shown: (r, id) => (r?.points?.[id]?.shownX ? ` ×${r.points[id].shownX}` : ""), hover: () => "" };
  const globals = { document, window, MutationObserver: class { observe() {} }, setInterval: () => 1, clearInterval() {}, setTimeout: (fn) => { fn(); return 1; }, Date };
  new Function(...Object.keys(globals), AGENT_USAGE_HELPER)(...Object.values(globals));
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => globalThis.setTimeout(r, 0)); };
  return { api: window.__sandUsage, pane, model, body, calls, docListeners, settle };
}

const USAGE = { available: true, window: "month", usage: { metered: true, seat: "subscription", keyPrefix: "oag_live_c27dbfc", window: "month",
  models: [
    { modelId: "xai/grok-4.6", requests: 4, inputTokens: 6204, outputTokens: 12, cacheReadTokens: 6144, cacheWriteTokens: 0, costUsd: "0.000000", listUsd: "0.008300", points: 41500 },
    { modelId: "openai/gpt-5.5", requests: 1, inputTokens: 20000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: "0.130000", listUsd: "0.130000", points: 650000 },
  ], totals: {} } };
const LIMIT = { available: true, limit: { cap: 100000, effectiveCap: 100000, usedPoints: 41500, dayCap: null, usedToday: 4580, dayFreesAt: null,
  pool: { max: 1000000, used: 41620, resetsAt: "2026-10-01T00:00:00Z", setBy: "admin" }, reference: { usdPerMtok: "0.200000" } } };
const CAT = { available: true, models: ["xai/grok-4.6", "openai/gpt-5.5", "openai/gpt-5-mini"], model: "xai/grok-4.6", points: { "xai/grok-4.6": { inputX: "10", outputX: "30", shownX: "10" }, "openai/gpt-5.5": { shownX: "25" }, "openai/gpt-5-mini": null } };
const notFound = { available: true, window: "month", error: "/coworkers/cw_1/usage failed (404)." };
const spendOnly = { available: true, spend: { metered: true, seat: "subscription", keyPrefix: "oag_live_c27dbfc", windows: [
  { window: "5h", usedUsd: "0.000000", limitUsd: null, freesAt: "2026-09-03T03:29:11Z", requests: 4, counterfactualUsd: "0.008300" },
  { window: "month", usedUsd: "0.000000", limitUsd: null, freesAt: "2026-10-01T00:00:00Z", requests: 4, counterfactualUsd: "0.008300" } ] } };

test("the table sums what it shows, and a filter narrows both rows and totals", () => {
  const { api } = fakePage();
  const all = api.table(USAGE.usage, "all");
  assert.equal(all.rows.length, 2);
  assert.deepEqual([all.totals.requests, all.totals.tokIn, all.totals.tokOut, all.totals.points, all.totals.pointsKnown], [5, 26204, 1012, 691500, true]);
  assert.equal(all.totals.list.toFixed(4), "0.1383");
  const one = api.table(USAGE.usage, "openai/gpt-5.5");
  assert.equal(one.rows.length, 1);
  assert.equal(one.totals.points, 650000);
  const older = api.table({ models: [{ modelId: "All models", requests: 4, listUsd: "0.0083", costUsd: "0", points: null }] }, "all");
  assert.equal(older.totals.pointsKnown, false, "an older server sends no points; the total says so instead of 0");
});

test("figures: points with thousands, money to the cent or four places, the dollar behind a point figure", () => {
  const { api } = fakePage();
  assert.equal(api.pts(41500), "41,500");
  assert.equal(api.pts(null), "—");
  assert.equal(api.money("0.008300"), "$0.0083");
  assert.equal(api.money("1.5"), "$1.50");
  assert.equal(api.usdOfPoints(1000000, "0.200000"), "≈ $0.20", "one million points at $0.20 per million is twenty cents");
  assert.equal(api.usdOfPoints(100000, "0.200000"), "≈ $0.02");
  assert.equal(api.usdOfPoints(100000, null), "", "no reference, no dollar");
});

test("the pane line: from per-model usage when served, from the meter otherwise", () => {
  const { api } = fakePage();
  assert.equal(api.summary(USAGE, null), "5 requests this month · 691,500 points");
  assert.equal(api.summary({ usage: { models: [] } }, null), "nothing this month");
  assert.equal(api.summary(null, spendOnly), "4 requests · $0.0083 on API this month");
  assert.equal(api.summary(null, { spend: { metered: false, note: "the deployment's key carried this turn", windows: [] } }), "not metered: the deployment's key carried this turn");
});

test("limits text: the pool with its dollar equivalent and who set it; the no-cap line", () => {
  const { api } = fakePage();
  const t = api.limitsText(LIMIT.limit, "0.200000");
  assert.match(t.pool, /^Your pool: 41,620 of 1,000,000 used \(≈ \$0\.20\), set by your admin, resets /);
  assert.equal(t.none, "", "a cap is set, nothing to add");
  const bare = api.limitsText({ cap: null, dayCap: null, pool: {} }, null);
  assert.equal(bare.pool, "No pool. Your admin has not set one.");
  assert.match(bare.none, /^No limits\./);
  const pooled = api.limitsText({ cap: null, dayCap: null, pool: { max: 5 } }, null);
  assert.equal(pooled.none, "No cap on this coworker; it draws on your pool.");
});

test("the pane keeps one line under Model with an Open button; the line reads the month", async () => {
  const { pane, model, calls, settle } = fakePage({ usage: USAGE });
  await settle();
  const box = pane.querySelector(".sand-lp-usage");
  assert.ok(box, "mounted");
  assert.equal(box.previousElementSibling, model, "under Model");
  assert.deepEqual(calls.usage, [["cw_1", "month"]]);
  assert.equal(box.parts.sum.textContent, "5 requests this month · 691,500 points");
  assert.equal(box.parts.open.textContent, "Open");
});

test("on an older server the line falls back to the meter, and the modal says what is not served", async () => {
  const { pane, body, calls, settle, api } = fakePage({ usage: notFound, spend: spendOnly, limit: { available: true, error: "/coworkers/cw_1/limit failed (404)." }, catalogue: CAT });
  await settle();
  const box = pane.querySelector(".sand-lp-usage");
  assert.equal(box.parts.sum.textContent, "4 requests · $0.0083 on API this month");
  assert.deepEqual(calls.spend, ["cw_1"]);
  const m = api.open("cw_1");
  await settle();
  assert.equal(body.children[0].attrs.role, "dialog");
  assert.equal(m.parts.sub.textContent, "Subscription seat · key oag_live_c27dbfc…");
  assert.match(m.parts.note.textContent, /^Per-model usage is not served by this server yet; this is the meter's total for the window\./);
  const rows = m.parts.tbody.children;
  assert.equal(rows[0].children[0].textContent, "All models");
  assert.equal(rows[0].children[1].textContent, "4");
  assert.equal(rows[0].children[3].textContent, "$0.0083", "list cost from the meter's counterfactual");
  assert.equal(rows[0].children[5].textContent, "—", "no points from a meter");
  assert.equal(m.parts.limNote.textContent, "Limits are not served by this server yet.");
  assert.equal(m.parts.cap.disabled, true);
});

test("the modal: per-model rows with ×N, totals, the period switch re-reads, the filter narrows, Escape closes", async () => {
  const { body, calls, settle, api, docListeners } = fakePage({ usage: USAGE, limit: LIMIT, catalogue: CAT });
  const m = api.open("cw_1");
  await settle();
  const scrim = body.children[0];
  assert.equal(scrim.className, "sand-us-scrim");
  assert.equal(scrim.attrs["aria-modal"], "true");
  assert.equal(m.parts.sub.textContent, "Subscription seat · key oag_live_c27dbfc…");
  let rows = m.parts.tbody.children;
  assert.equal(rows.length, 3, "two models and a totals row");
  assert.equal(rows[0].children[0].textContent, "xai/grok-4.6 ×10");
  assert.equal(rows[0].children[2].textContent, "6,204 / 12");
  assert.equal(rows[0].children[5].textContent, "41,500");
  assert.equal(rows[2].children[0].textContent, "This month");
  assert.equal(rows[2].children[5].textContent, "691,500");
  const options = m.parts.filter.children.map((o) => o.textContent);
  assert.deepEqual(options, ["All models", "xai/grok-4.6 ×10", "openai/gpt-5.5 ×25", "openai/gpt-5-mini"], "the picker's list, plus every model used");
  m.parts.periods[1].listeners.click();
  await settle();
  assert.deepEqual(calls.usage.slice(-1), [["cw_1", "24h"]]);
  assert.equal(m.parts.periods[1].attrs["aria-pressed"], "true");
  assert.equal(m.parts.periods[3].attrs["aria-pressed"], "false");
  m.parts.filter.value = "openai/gpt-5.5"; m.parts.filter.listeners.change();
  rows = m.parts.tbody.children;
  assert.equal(rows.length, 2);
  assert.equal(rows[1].children[0].textContent, "Last 24 hours · openai/gpt-5.5");
  assert.equal(rows[1].children[5].textContent, "650,000");
  docListeners.keydown({ key: "Escape", preventDefault() {} });
  assert.equal(body.children.length, 0, "closed");
  assert.equal(api.current(), null);
});

test("the limits section: fields carry their dollar equivalents, Save sends whole points or null, refusals show", async () => {
  const { calls, settle, api } = fakePage({ usage: USAGE, limit: LIMIT, catalogue: CAT, saveResult: { saved: false, error: "a cap above your pool of 1,000,000" } });
  const m = api.open("cw_1");
  await settle();
  assert.equal(m.parts.cap.value, "100,000");
  assert.equal(m.parts.capEq.textContent, "≈ $0.02");
  assert.equal(m.parts.dayCap.value, "");
  assert.match(m.parts.dayCapEq.textContent, /^none = off/);
  assert.match(m.parts.pool.textContent, /^Your pool: 41,620 of 1,000,000 used/);
  assert.equal(m.parts.save.disabled, true, "nothing changed yet");
  m.parts.dayCap.value = "20,000"; m.parts.dayCap.listeners.input();
  assert.equal(m.parts.dayCapEq.textContent, "≈ $0.0040");
  assert.equal(m.parts.save.disabled, false);
  m.parts.cap.value = "abc"; m.parts.cap.listeners.input();
  assert.equal(m.parts.save.disabled, true);
  assert.equal(m.parts.saveNote.textContent, "whole points only");
  m.parts.cap.value = ""; m.parts.cap.listeners.input();
  m.parts.save.listeners.click();
  await settle();
  assert.deepEqual(calls.save, [["cw_1", null, 20000]], "an empty cap is null, a typed brake is a whole number");
  assert.equal(m.parts.saveNote.textContent, "Not saved: a cap above your pool of 1,000,000");
});
