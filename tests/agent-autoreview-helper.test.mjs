import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_AUTOREVIEW_HELPER } from "../scripts/lib/agent-autoreview-helper.mjs";

function fakePage({ row, effective, error, available = true, agent = "cw_1" } = {}) {
  const element = (tag) => {
    const e = { tag, children: [], attrs: {}, style: {}, _text: "", className: "", parent: null, isConnected: true, listeners: {}, value: "",
      get textContent() { return this._text; }, set textContent(v) { this._text = v; this.children = []; },
      appendChild(c) { c.remove(); this.children.push(c); c.parent = this; return c; },
      append(...cs) { cs.forEach((c) => this.appendChild(c)); },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; },
      addEventListener(k, fn) { this.listeners[k] = fn; },
      querySelector(sel) {
        if (sel.startsWith("[data-") || sel.startsWith("[aria-") || sel.startsWith("[role=")) {
          const m = sel.match(/\[([^=]+)=["']?([^"'\]]+)/);
          return m ? this.children.find((c) => (c.attrs[m[1]] ?? c.getAttribute?.(m[1])) === m[2]) ?? null : null;
        }
        const cls = sel.match(/^\.([\w-]+)$/);
        return cls ? this.children.find((c) => c.className === cls[1]) ?? null : null;
      } };
    return e;
  };
  const pane = element("div"); pane.className = "sand-agent-settings";
  const item = { getAttribute: (k) => (k === "data-agent-id" ? agent : null) };
  const body = element("body"); const head = element("head");
  const document = { createElement: element, head, body, documentElement: element("html"),
    querySelector: (sel) => (sel.startsWith(".sand-agent-item") ? item : sel === ".sand-lp-ar" ? pane.querySelector(".sand-lp-ar") : null),
    querySelectorAll: (sel) => (sel === ".sand-agent-settings" ? [pane] : []),
    addEventListener() {}, removeEventListener() {} };
  const calls = { get: [], set: [], del: [] };
  const payload = available === false ? { available: false } : error ? { available: true, error } : {
    available: true, row: row === undefined ? null : row, effective: effective ?? { enabled: false, decidedBy: {} },
  };
  const agentApi = {
    getAgentAutoReview: (id) => { calls.get.push(id); return Promise.resolve(payload); },
    setAgentAutoReview: (id, body) => { calls.set.push([id, body]); return Promise.resolve({ agentId: id }); },
    deleteAgentAutoReview: (id) => { calls.del.push(id); return Promise.resolve({ agentId: id }); },
  };
  const window = { desktop: { agent: agentApi } };
  const globals = { document, window, MutationObserver: class { observe() {} }, setTimeout: (fn) => { fn(); return 1; } };
  new Function(...Object.keys(globals), AGENT_AUTOREVIEW_HELPER)(...Object.values(globals));
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => globalThis.setTimeout(r, 0)); };
  return { api: window.__sandAutoReview, pane, body, calls, settle, box: () => pane.querySelector(".sand-lp-ar") };
}

test("the pane is a summary and Manage, not allow/block fields", async () => {
  const { settle, box, calls } = fakePage({ row: { enabled: true, allowInstructions: "read files\nrun tests", blockInstructions: "install software" } });
  await settle();
  const b = box();
  assert.ok(b, "mounted");
  assert.equal(b.parts.open.textContent, "Manage…");
  assert.equal(b.parts.sum.textContent, "On. 3 rules — 2 allow, 1 block.");
  assert.deepEqual(calls.get, ["cw_1"]);
  assert.equal(b.querySelector(".sand-ar-scrim"), null);
});

test("Manage opens a modal with inherit/on/off and Allow/Block tabs", async () => {
  const { settle, api, body } = fakePage({ row: { enabled: false, allowInstructions: ["read files"], blockInstructions: [] } });
  await settle();
  const m = api.open("cw_1");
  await settle();
  assert.equal(body.children[0].className, "sand-ar-scrim");
  assert.equal(body.children[0].attrs["aria-label"], "Auto-review");
  const pressed = m.parts.seg.children.filter((c) => c.attrs["aria-pressed"] === "true");
  assert.equal(pressed.length, 1);
  assert.equal(pressed[0].attrs["data-mode"], "off");
  assert.match(m.parts.tabs.children[0].textContent, /^Allow \(1\)/);
  assert.match(m.parts.tabs.children[1].textContent, /^Block \(0\)/);
});

test("adding a rule saves immediately; inherit with nothing deletes the row", async () => {
  const { settle, api, calls } = fakePage({ row: { enabled: true, allowInstructions: "", blockInstructions: "" } });
  await settle();
  const m = api.open("cw_1");
  await settle();
  m.parts.draft.value = "read files"; m.parts.addBtn.listeners.click();
  await settle();
  assert.ok(calls.set.length >= 1);
  const added = calls.set[calls.set.length - 1][1];
  assert.deepEqual(added.allowInstructions, ["read files"]);
  const on = fakePage({ row: { enabled: true, allowInstructions: "", blockInstructions: "" } });
  await on.settle();
  const m2 = on.api.open("cw_1");
  await on.settle();
  m2.parts.seg.children[0].listeners.click();
  await on.settle();
  assert.ok(on.calls.del.length >= 1, "empty inherit deletes the coworker row");
});
