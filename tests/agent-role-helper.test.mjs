import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_ROLE_HELPER } from "../scripts/lib/agent-role-helper.mjs";

/** A settings pane with the Model block already in it, and the two doors the Role block uses. */
function fakePage({ answer, saveResult, agent = "cw_1" } = {}) {
  const element = (tag) => {
    const e = { tag, children: [], attrs: {}, style: {}, _text: "", className: "", value: "", placeholder: "", disabled: false,
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
    activeElement: null,
    querySelector: (sel) => (sel.startsWith(".sand-agent-item") ? item : null),
    querySelectorAll: (sel) => (sel === ".sand-agent-settings" ? [pane] : []) };
  const calls = [];
  const agentApi = {
    getAgentModel: () => Promise.resolve(answer ?? { available: true, models: [], model: "m", role: "Reviews pull requests." }),
    setCoworkerRole: (id, role) => { calls.push([id, role]); return Promise.resolve(saveResult ?? { saved: true }); },
  };
  const window = { desktop: { agent: agentApi } };
  const globals = { document, window, MutationObserver: class { observe() {} }, setTimeout: (fn) => { fn(); return 1; }, Promise, Date };
  new Function(...Object.keys(globals), AGENT_ROLE_HELPER)(...Object.values(globals));
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => globalThis.setTimeout(r, 0)); };
  return { api: window.__sandRole, pane, calls, settle, box: () => pane.children.find((c) => c.className === "sand-lp-role") };
}

test("the block sits above the Model block, carrying what the server holds", async () => {
  const { pane, settle, box } = fakePage();
  await settle();
  const b = box();
  assert.ok(b, "mounted");
  assert.equal(pane.children.indexOf(b) < pane.children.indexOf(pane.querySelector(".sand-lp-model")), true, "above Model");
  assert.equal(b.parts.area.value, "Reviews pull requests.");
  assert.equal(b.parts.area.disabled, false);
  assert.equal(b.parts.note.textContent, "Sent to the model on every run, with the name and title above it.");
});

test("leaving the field saves it; an empty role clears it; nothing saves when nothing changed", async () => {
  const { settle, box, calls } = fakePage();
  await settle();
  const b = box();
  b.parts.area.listeners.blur();
  assert.deepEqual(calls, [], "unchanged text is not a save");
  b.parts.area.value = "Terse. Never guesses."; b.parts.area.listeners.input();
  b.parts.area.listeners.blur();
  await settle();
  assert.deepEqual(calls, [["cw_1", "Terse. Never guesses."]]);
  assert.equal(b.parts.note.textContent, "Saved. Every run from now on carries it.");
  b.parts.area.value = ""; b.parts.area.listeners.input(); b.parts.area.listeners.blur();
  await settle();
  assert.deepEqual(calls[1], ["cw_1", null], "an empty role is null, not an empty string");
});

test("a thousand characters is the cap, and it is refused here rather than at the server", async () => {
  const { settle, box, calls, api } = fakePage();
  await settle();
  const b = box();
  assert.equal(api.limit, 1000);
  b.parts.area.value = "x".repeat(1001); b.parts.area.listeners.input();
  assert.equal(b.parts.count.textContent, "1001 / 1000");
  assert.equal(b.parts.count.className, "lp-role-count over");
  b.parts.area.listeners.blur();
  await settle();
  assert.deepEqual(calls, [], "nothing is sent");
  assert.equal(b.parts.err.textContent, "A role is at most 1000 characters.");
  b.parts.area.value = "x".repeat(900); b.parts.area.listeners.input();
  assert.equal(b.parts.count.textContent, "900 / 1000", "the count appears as you approach the cap");
  assert.equal(b.parts.err.textContent, "", "and typing clears the complaint");
});

test("a server that does not carry a role says so and stops taking edits", async () => {
  const { settle, box, calls } = fakePage({ answer: { available: true, models: [], model: "m" } });
  await settle();
  const b = box();
  assert.equal(b.parts.area.disabled, true);
  assert.equal(b.parts.note.textContent, "This server does not carry a role yet. Saving is off until it does.");
  b.parts.area.value = "anything"; b.parts.area.listeners.blur();
  await settle();
  assert.deepEqual(calls, [], "and it does not pretend to save");
});

test("a route with no server hides the block; a refusal is shown in the server's words", async () => {
  const hidden = fakePage({ answer: { available: false } });
  await hidden.settle();
  assert.equal(hidden.box().style.display, "none");
  const refused = fakePage({ saveResult: { saved: false, error: "a role is at most 1000 characters" } });
  await refused.settle();
  const b = refused.box();
  b.parts.area.value = "new"; b.parts.area.listeners.blur();
  await refused.settle();
  assert.equal(b.parts.err.textContent, "Not saved: a role is at most 1000 characters");
  const gone = fakePage({ saveResult: { saved: false, error: "/coworkers/cw_1 failed (404)." } });
  await gone.settle();
  const g = gone.box();
  g.parts.area.value = "new"; g.parts.area.listeners.blur();
  await gone.settle();
  assert.equal(g.parts.area.disabled, true, "a 404 on save means the field is not served, not that the save failed");
  assert.equal(g.parts.note.textContent, "This server does not carry a role yet. Saving is off until it does.");
});
