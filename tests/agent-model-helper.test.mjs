import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_MODEL_HELPER } from "../scripts/lib/agent-model-helper.mjs";

/** A settings pane and the one door the Model block calls. */
function fakePage({ model = "xai/grok-4.6@sub", models, points, note, error, available = true, saveResult, agent = "cw_1" } = {}) {
  const element = (tag) => {
    const e = { tag, children: [], attrs: {}, style: {}, _text: "", className: "", id: "", title: "", value: "", hidden: false,
      type: "", autocomplete: "", spellcheck: true, parent: null, isConnected: true, listeners: {},
      get textContent() { return this._text; }, set textContent(v) { this._text = v; this.children = []; },
      appendChild(c) { c.remove(); this.children.push(c); c.parent = this; return c; },
      append(...cs) { cs.forEach((c) => this.appendChild(c)); },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; },
      removeAttribute(k) { delete this.attrs[k]; },
      addEventListener(k, fn) { this.listeners[k] = fn; },
      focus() { this.listeners.focus?.(); }, select() {}, scrollIntoView() {},
      getBoundingClientRect() { return { top: 300, bottom: 330, left: 0, right: 300, width: 300, height: 30 }; },
      querySelector(sel) { const m = sel.match(/^\.([\w-]+)$/); return m ? this.children.find((c) => c.className === m[1]) ?? null : null; } };
    return e;
  };
  const pane = element("div"); pane.className = "sand-agent-settings";
  const item = { getAttribute: (k) => (k === "data-agent-id" ? agent : null) };
  const head = element("head");
  const document = { createElement: element, head, documentElement: element("html"),
    querySelector: (sel) => (sel.startsWith(".sand-agent-item") ? item : null),
    querySelectorAll: (sel) => (sel === ".sand-agent-settings" ? [pane] : []) };
  const calls = { get: [], set: [] };
  const answer = available === false ? { available: false } : error ? { available: true, error } : {
    available: true, model, models: models ?? ["oag/auto", "xai/grok-4.6", "xai/grok-4.6@sub", "openai/gpt-5-mini", "openai/gpt-5.5"],
    points: points ?? { "xai/grok-4.6": { shownX: "10", inputX: "10", outputX: "30" }, "xai/grok-4.6@sub": { shownX: "10" }, "openai/gpt-5.5": { shownX: "25" } },
    ...(note == null ? {} : { note }),
  };
  const agentApi = {
    getAgentModel: (id) => { calls.get.push(id); return Promise.resolve(answer); },
    setAgentModel: (id, m) => { calls.set.push([id, m]); return Promise.resolve(saveResult ?? { saved: true, model: m }); },
  };
  const window = { desktop: { agent: agentApi }, innerHeight: 900 };
  const globals = { document, window, MutationObserver: class { observe() {} }, setTimeout: (fn) => { fn(); return 1; }, Date };
  new Function(...Object.keys(globals), AGENT_MODEL_HELPER)(...Object.values(globals));
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => globalThis.setTimeout(r, 0)); };
  return { api: window.__sandModels, pane, calls, settle, box: () => pane.querySelector("sand-lp-model") ?? pane.children.find((c) => c.className === "sand-lp-model") };
}

const CATALOGUE = ["oag/auto", "xai/grok-4.6", "xai/grok-4.6@sub", "openai/gpt-5-mini", "openai/gpt-5.5"];

test("a route id is written out for a person", () => {
  const { api } = fakePage();
  assert.equal(api.label("xai/grok-4.6@sub"), "xAI: grok-4.6 · subscription");
  assert.equal(api.label("openai/gpt-5.5"), "OpenAI: gpt-5.5");
  assert.equal(api.label("oag/auto"), "OAG: auto");
  assert.equal(api.label("anthropic/claude-opus-4-6@api"), "Anthropic: claude-opus-4-6 · API");
  assert.equal(api.label("foo/bar-1"), "Foo: bar-1", "an unknown vendor is capitalised, not dropped");
  assert.equal(api.label("just-a-name"), "just-a-name", "no vendor, no colon");
  assert.equal(api.label("xai/grok-4.6@weird"), "xAI: grok-4.6 · weird", "an unknown suffix is spelled as it stands");
  assert.equal(api.label(null), "");
});

test("the options are grouped: the ladder, then the models, then anything unusual", () => {
  const { api } = fakePage();
  const all = api.options(CATALOGUE, "xai/grok-4.6@sub", "");
  assert.deepEqual(all.map((o) => o.group + " | " + o.id), [
    "Let the gateway choose | oag/auto",
    "Pin a model | xai/grok-4.6",
    "Pin a model | xai/grok-4.6@sub",
    "Pin a model | openai/gpt-5-mini",
    "Pin a model | openai/gpt-5.5",
  ]);
  assert.equal(all[1].label, "xAI: grok-4.6");
});

test("typing filters over the written label and the raw id alike", () => {
  const { api } = fakePage();
  assert.deepEqual(api.options(CATALOGUE, null, "grok").map((o) => o.id), ["xai/grok-4.6", "xai/grok-4.6@sub", "grok"]);
  assert.deepEqual(api.options(CATALOGUE, null, "openai: gpt-5.5").map((o) => o.id), ["openai/gpt-5.5", "openai: gpt-5.5"], "the written label is searchable as it reads, colon and all");
  assert.deepEqual(api.options(CATALOGUE, null, "OpenAI").map((o) => o.id).slice(0, 2), ["openai/gpt-5-mini", "openai/gpt-5.5"], "matching is case-insensitive");
  assert.deepEqual(api.options(CATALOGUE, null, "subscription").map((o) => o.id), ["xai/grok-4.6@sub", "subscription"], "the spelled-out suffix is searchable");
});

test("a pin the gateway has stopped advertising is still offered, in its own group", () => {
  const { api } = fakePage();
  const opts = api.options(CATALOGUE, "openai/gpt-5.6-luna", "");
  const stale = opts[opts.length - 1];
  assert.equal(stale.id, "openai/gpt-5.6-luna");
  assert.equal(stale.group, "Not in the catalogue");
  assert.equal(stale.label, "OpenAI: gpt-5.6-luna");
  assert.equal(api.options(CATALOGUE, "openai/gpt-5.6-luna", "grok").some((o) => o.id === "openai/gpt-5.6-luna"), false, "and it filters out like anything else");
});

test("what you typed is offered last, and never twice", () => {
  const { api } = fakePage();
  const typed = api.options(CATALOGUE, null, "openai/gpt-6");
  assert.deepEqual(typed.map((o) => o.group), ["Use exactly what you typed"]);
  assert.equal(typed[0].id, "openai/gpt-6");
  const exact = api.options(CATALOGUE, null, "openai/gpt-5.5");
  assert.deepEqual(exact.map((o) => o.id), ["openai/gpt-5.5"], "an exact id is the catalogue's row, not a second literal one");
});

test("the block shows the pin's label, its multiplier and how many others there are", async () => {
  const { settle, box, calls } = fakePage();
  await settle();
  const b = box();
  assert.equal(b.parts.input.value, "xAI: grok-4.6 · subscription");
  assert.equal(b.parts.input.title, "xai/grok-4.6@sub", "the raw id is a hover away");
  assert.equal(b.parts.mult.textContent, "×10");
  assert.equal(b.parts.note.textContent, "Running on xAI: grok-4.6 · subscription. 4 others the gateway advertises.");
  assert.deepEqual(calls.get, ["cw_1"]);
});

test("focus opens the list, typing narrows it, the arrows move a cursor that never leaves the input", async () => {
  const { settle, box } = fakePage();
  await settle();
  const b = box();
  const { input, list } = b.parts;
  input.listeners.focus();
  assert.equal(list.hidden, false);
  assert.equal(input.getAttribute("aria-expanded"), "true");
  assert.equal(input.getAttribute("aria-controls"), list.id);
  const rows = () => list.children.filter((c) => c.className.startsWith("lp-opt"));
  assert.equal(rows().length, 5);
  assert.equal(input.getAttribute("aria-activedescendant"), list.id + "-0");
  input.value = "grok"; input.listeners.input();
  assert.deepEqual(rows().map((r) => r.children[0].textContent), ["xAI: grok-4.6", "xAI: grok-4.6 · subscription", "grok"]);
  input.listeners.keydown({ key: "ArrowDown", preventDefault() {} });
  assert.equal(input.getAttribute("aria-activedescendant"), list.id + "-1");
  assert.equal(rows()[1].className.includes("on"), true, "the second row is the one under the cursor");
  input.listeners.keydown({ key: "ArrowUp", preventDefault() {} });
  input.listeners.keydown({ key: "ArrowUp", preventDefault() {} });
  assert.equal(input.getAttribute("aria-activedescendant"), list.id + "-2", "and it wraps");
});

test("Enter saves the model under the cursor; the list closes and the label follows", async () => {
  const { settle, box, calls } = fakePage();
  await settle();
  const b = box();
  const { input, list } = b.parts;
  input.listeners.focus();
  input.value = "5.5"; input.listeners.input();
  input.listeners.keydown({ key: "Enter", preventDefault() {} });
  await settle();
  assert.deepEqual(calls.set, [["cw_1", "openai/gpt-5.5"]]);
  assert.equal(list.hidden, true);
  assert.equal(input.getAttribute("aria-expanded"), "false");
  assert.equal(b.parts.err.textContent, "");
});

test("clicking an option saves it too, and a refusal is shown in the server's words", async () => {
  const { settle, box, calls } = fakePage({ saveResult: { saved: false, error: "no such model on this route" } });
  await settle();
  const b = box();
  b.parts.input.listeners.focus();
  const row = b.parts.list.children.filter((c) => c.className.startsWith("lp-opt"))[3];
  row.listeners.mousedown({ preventDefault() {} });
  await settle();
  assert.deepEqual(calls.set, [["cw_1", "openai/gpt-5-mini"]]);
  assert.equal(b.parts.err.textContent, "Not saved: no such model on this route");
});

test("Escape closes without saving and puts the label back", async () => {
  const { settle, box, calls } = fakePage();
  await settle();
  const b = box();
  const { input, list } = b.parts;
  input.listeners.focus();
  input.value = "gpt"; input.listeners.input();
  input.listeners.keydown({ key: "Escape", preventDefault() {}, stopPropagation() {} });
  assert.equal(list.hidden, true);
  assert.equal(input.value, "xAI: grok-4.6 · subscription");
  assert.deepEqual(calls.set, []);
  input.listeners.focus();
  input.value = "gpt"; input.listeners.input();
  input.listeners.blur();
  assert.equal(input.value, "xAI: grok-4.6 · subscription", "and so does looking away");
  assert.deepEqual(calls.set, []);
});

test("a mock door with no catalogue says so and still takes a typed pin", async () => {
  const { settle, box, calls } = fakePage({ models: [], model: "", note: "This deployment's model door is a mock." });
  await settle();
  const b = box();
  assert.equal(b.parts.note.textContent, "This deployment's model door is a mock.");
  assert.equal(b.parts.mult.textContent, "");
  b.parts.input.listeners.focus();
  b.parts.input.value = "openai/gpt-6"; b.parts.input.listeners.input();
  b.parts.input.listeners.keydown({ key: "Enter", preventDefault() {} });
  await settle();
  assert.deepEqual(calls.set, [["cw_1", "openai/gpt-6"]]);
});

test("a route with no OpenGrok server hides the block; a server that cannot be asked says so", async () => {
  const hidden = fakePage({ available: false });
  await hidden.settle();
  assert.equal(hidden.box().style.display, "none");
  const broken = fakePage({ error: "pool timed out" });
  await broken.settle();
  assert.equal(broken.box().parts.err.textContent, "pool timed out");
  assert.equal(broken.box().parts.note.textContent, "The server could not be asked.");
});
