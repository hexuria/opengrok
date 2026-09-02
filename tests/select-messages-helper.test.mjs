import assert from "node:assert/strict";
import test from "node:test";

import { SELECT_MODE_HELPER } from "../scripts/lib/select-messages-helper.mjs";

/** A transcript of fake rows and the few DOM/timer globals the helper touches. */
function fakePage({ rows, collections = true, deleteResult } = {}) {
  const element = (tag) => {
    const el = { tag, children: [], attrs: {}, style: {}, _text: "", className: "", innerHTML: "", hidden: false, disabled: false, listeners: {}, title: "",
      // As in the DOM: writing textContent drops every child.
      get textContent() { return this._text; }, set textContent(v) { this._text = v; this.children = []; },
      classList: { add(c) { el.className += ` ${c}`; }, contains(c) { return el.className.split(" ").includes(c); } },
      appendChild(child) { this.children.push(child); child.parent = this; return child; },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); },
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; },
      addEventListener(k, fn) { this.listeners[k] = fn; }, removeEventListener() {},
      contains(x) { return x === this || this.children.some((c) => c.contains?.(x)); },
      getBoundingClientRect() { return { left: 100, top: 50, right: 900, bottom: 700, width: 800, height: 650 }; },
      closest() { return null; }, focus() {} };
    return el;
  };
  const rowEls = rows.map((r, i) => { const el = element("div"); el.attrs["data-row-key"] = r.key; if (r.label) el.attrs["aria-labelledby"] = r.label; if (r.entryId) el.attrs["data-entry-id"] = r.entryId; if (r.entryIds) el.attrs["data-entry-ids"] = r.entryIds; el.attrs["data-index"] = String(i); el.getBoundingClientRect = () => ({ left: 100, top: 100 + i * 40, bottom: 130 + i * 40, height: 30, width: 800 }); return el; });
  const scroller = element("div"); scroller.querySelectorAll = (sel) => (sel === "[data-row-key]" ? rowEls : []);
  scroller.closest = () => scroller;
  const head = element("head"); const body = element("body");
  const docListeners = {};
  const document = { createElement: element, head, body,
    querySelector: (sel) => (sel === ".sand-virtual-transcript" ? scroller : null),
    querySelectorAll: () => [],
    addEventListener: (k, fn) => { docListeners[k] = fn; }, removeEventListener() {} };
  const calls = { add: [], del: [] };
  const desktop = { collections: collections ? { addMessages: (a) => { calls.add.push(a); return Promise.resolve({}); }, list: () => Promise.resolve({ collections: [{ id: "bookmarks", name: "Bookmarks", count: 2 }] }) } : undefined,
    agent: { deleteTranscriptEntries: (a) => { calls.del.push(a); return Promise.resolve(deleteResult ?? { deleted: a.entryIds.length }); } } };
  const window = { desktop, addEventListener() {}, removeEventListener() {} };
  const self = { __sandCurrentAgent: () => "cw_1", __sandDeleteAvailable: true };
  const globals = { document, window, self, localStorage: { getItem: () => null, setItem() {} }, MutationObserver: class { observe() {} disconnect() {} }, requestAnimationFrame: () => 1, setInterval: () => 1, clearInterval() {}, setTimeout: (fn) => { fn(); return 1; } };
  new Function(...Object.keys(globals), SELECT_MODE_HELPER)(...Object.values(globals));
  const bar = body.children.find((c) => c.className === "sand-sel-bar");
  return { api: window.__sandSelect, bar, rowEls, calls, docListeners, self };
}
const labelled = (id) => `sand-conversation-entry-${id}-author sand-conversation-entry-${id}-timestamp`;
const buttons = (bar) => bar.children.filter((c) => c.tag === "button");
const label = (b) => b.attrs["aria-label"] ?? b.textContent;
const count = (bar) => bar.children.find((c) => c.className === "sand-sel-count")?.textContent;

test("every entry row is selectable on every route: the id comes from the row's label, the key only as a last resort", () => {
  const { api } = fakePage({ rows: [] });
  const el = (attrs, row = true) => ({ getAttribute: (k) => attrs[k] ?? null, classList: { contains: (c) => row && c === "sand-transcript-row" } });
  assert.deepEqual(api.idsOf(el({ "aria-labelledby": labelled("e_01a0-6162"), "data-row-key": "nonce:509379ce" })), ["e_01a0-6162"], "the person's own message, keyed by nonce");
  assert.deepEqual(api.idsOf(el({ "aria-labelledby": labelled("e_9"), "data-row-key": "e_9" })), ["e_9"]);
  assert.deepEqual(api.idsOf(el({ "data-row-key": "t12u" })), ["t12u"], "a local-route id without a label");
  assert.deepEqual(api.idsOf(el({ "data-row-key": "e_7" })), ["e_7"], "a server id without a label");
  assert.deepEqual(api.idsOf(el({ "data-row-key": "e_7" , "data-entry-ids": "e_7 e_8" })), ["e_7", "e_8"], "an attachment group");
  assert.deepEqual(api.idsOf(el({ "data-row-key": "e_7" }, false)), [], "a date separator borrows the next entry's key and is not a row");
});

test("entering from a message's menu selects that message; the toolbar shows the count, the master checkbox, and icon buttons", () => {
  const { api, bar } = fakePage({ rows: [{ key: "nonce:1", label: labelled("e_1") }, { key: "e_2", label: labelled("e_2") }, { key: "e_3", label: labelled("e_3") }] });
  api.enter("e_2");
  assert.equal(api.count(), 1, "the seed counts, whatever its shape");
  assert.equal(count(bar), "1 selected");
  const b = buttons(bar);
  assert.deepEqual(b.map(label), ["Select all loaded messages", "Share to a collection", "Bookmark", "Delete", "Done"]);
  assert.equal(b[0].attrs["aria-checked"], "mixed");
  assert.equal(b[3].className.includes("sand-sel-danger"), true, "delete is the dangerous one");
  assert.ok(b[1].innerHTML.startsWith("<svg"), "icons, not words");
});

test("the master checkbox selects every loaded message and clears them again; actions are disabled at zero", async () => {
  const { api, bar, calls } = fakePage({ rows: [{ key: "nonce:1", label: labelled("e_1") }, { key: "e_2", label: labelled("e_2") }] });
  api.enter();
  assert.equal(count(bar), "0 selected");
  assert.deepEqual(buttons(bar).slice(1, 4).map((b) => b.disabled), [true, true, true], "nothing to share, bookmark or delete yet");
  buttons(bar)[0].listeners.click({ stopPropagation() {} });
  assert.equal(api.count(), 2);
  assert.equal(buttons(bar)[0].attrs["aria-checked"], "true");
  assert.equal(label(buttons(bar)[0]), "Deselect all");
  buttons(bar)[2].listeners.click({ stopPropagation() {} });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls.add, [{ agentId: "cw_1", entryIds: ["e_1", "e_2"], target: "bookmarks" }], "Bookmark sends what is selected");
  api.enter();
  buttons(bar)[0].listeners.click({ stopPropagation() {} });
  buttons(bar)[0].listeners.click({ stopPropagation() {} });
  assert.equal(api.count(), 0, "and back to none");
});

test("delete asks first, names the server when it will really delete, and sends the ids through the door", async () => {
  const { api, bar, calls } = fakePage({ rows: [{ key: "e_2", label: labelled("e_2") }] });
  api.enter("e_2");
  buttons(bar)[3].listeners.click({ stopPropagation() {} });
  assert.match(count(bar), /Delete 1 message for everyone on this server\?/);
  const del = buttons(bar).find((b) => b.textContent === "Delete");
  del.listeners.click({ stopPropagation() {} });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls.del, [{ agentId: "cw_1", entryIds: ["e_2"] }]);
  assert.equal(api.active(), false, "done: selection mode ends");
});
