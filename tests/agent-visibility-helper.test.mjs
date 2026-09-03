import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_VISIBILITY_HELPER } from "../scripts/lib/agent-visibility-helper.mjs";

function fakePage({ answer, saveResult, agent = "cw_1" } = {}) {
  const element = (tag) => {
    const e = { tag, children: [], attrs: {}, style: {}, _text: "", className: "", value: "", disabled: false,
      parent: null, isConnected: true, listeners: {},
      get textContent() { return this._text; }, set textContent(v) { this._text = v; this.children = []; },
      appendChild(c) { c.remove(); this.children.push(c); c.parent = this; return c; },
      append(...cs) { cs.forEach((c) => this.appendChild(c)); },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; },
      addEventListener(k, fn) { this.listeners[k] = fn; },
      get parentNode() { return this.parent; },
      insertBefore(node, ref) { node.remove(); const s = this.children; s.splice(s.indexOf(ref), 0, node); node.parent = this; return node; },
      querySelector(sel) { const m = sel.match(/^\.([\w-]+)$/); return m ? this.children.find((c) => c.className === m[1]) ?? null : null; } };
    return e;
  };
  const pane = element("div"); pane.className = "sand-agent-settings";
  const model = element("div"); model.className = "sand-lp-model"; pane.appendChild(model);
  const item = { getAttribute: (k) => (k === "data-agent-id" ? agent : null) };
  const document = { createElement: element, head: element("head"), documentElement: element("html"),
    querySelector: (sel) => (sel.startsWith(".sand-agent-item") ? item : null),
    querySelectorAll: (sel) => (sel === ".sand-agent-settings" ? [pane] : []) };
  const calls = [];
  const agentApi = {
    getAgentModel: () => Promise.resolve(answer ?? { available: true, models: [], model: "m", visibility: "private", canManage: true, mine: true, owner: null }),
    setCoworkerVisibility: (id, v) => { calls.push([id, v]); return Promise.resolve(saveResult ?? { saved: true }); },
  };
  const window = { desktop: { agent: agentApi } };
  const globals = { document, window, MutationObserver: class { observe() {} }, setTimeout: (fn) => { fn(); return 1; }, Promise, Date };
  new Function(...Object.keys(globals), AGENT_VISIBILITY_HELPER)(...Object.values(globals));
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => globalThis.setTimeout(r, 0)); };
  return { api: window.__sandVisibility, pane, calls, settle, box: () => pane.children.find((c) => c.className === "sand-lp-vis") };
}

test("the sentence says what it means for a person, not what the field holds", () => {
  const { api } = fakePage();
  assert.equal(api.subFor({ visibility: "private", canManage: true }), "Only you can talk to this coworker.");
  assert.equal(api.subFor({ visibility: "org", canManage: true }),
    "Everyone in your organisation can talk to this coworker, each in their own conversation and on their own budget.");
  assert.equal(api.subFor({ visibility: "org", canManage: false, owner: { name: "Priya" } }),
    "Priya's coworker, shared with your organisation. Only its owner or an admin can change that.");
  assert.equal(api.subFor({ visibility: "org", canManage: false, owner: null }),
    "Somebody else's coworker, shared with your organisation. Only its owner or an admin can change that.");
  assert.equal(api.subFor(null), "This server does not carry visibility yet.");
});

test("it shows what the server holds and saves a change", async () => {
  const { settle, box, calls } = fakePage();
  await settle();
  const b = box();
  assert.equal(b.parts.select.value, "private");
  assert.equal(b.parts.select.disabled, false);
  assert.equal(b.parts.sub.textContent, "Only you can talk to this coworker.");
  b.parts.select.value = "org"; b.parts.select.listeners.change();
  await settle();
  assert.deepEqual(calls, [["cw_1", "org"]]);
});

test("the server's verdict is rendered, never computed: a coworker you may not manage is read-only", async () => {
  const { settle, box, calls } = fakePage({ answer: { available: true, models: [], model: "m", visibility: "org", canManage: false, mine: false, owner: { id: "u2", name: "Priya" } } });
  await settle();
  const b = box();
  assert.equal(b.parts.select.disabled, true);
  assert.equal(b.parts.sub.textContent, "Priya's coworker, shared with your organisation. Only its owner or an admin can change that.");
  b.parts.select.value = "private"; b.parts.select.listeners.change();
  await settle();
  assert.deepEqual(calls, [], "a disabled control still refuses to send");
});

test("a server without the field offers no switch, and a refusal puts the old choice back", async () => {
  const bare = fakePage({ answer: { available: true, models: [], model: "m" } });
  await bare.settle();
  assert.equal(bare.box().parts.select.disabled, true);
  assert.equal(bare.box().parts.sub.textContent, "This server does not carry visibility yet.");
  const refused = fakePage({ saveResult: { saved: false, error: "only the owner or an admin may share a coworker" } });
  await refused.settle();
  const b = refused.box();
  b.parts.select.value = "org"; b.parts.select.listeners.change();
  await refused.settle();
  assert.equal(b.parts.select.value, "private", "the control goes back to what the server holds");
  assert.equal(b.parts.err.textContent, "Not saved: only the owner or an admin may share a coworker");
});
