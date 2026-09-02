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
  const addRow = (r) => { const i = rowEls.length; const el = element("div"); el.attrs["data-row-key"] = r.key; if (r.label) el.attrs["aria-labelledby"] = r.label; el.attrs["data-index"] = String(i); el.getBoundingClientRect = () => ({ left: 100, top: 100 + i * 40, bottom: 130 + i * 40, height: 30, width: 800 }); rowEls.push(el); return el; };
  scroller.closest = () => scroller;
  const head = element("head"); const body = element("body");
  const docListeners = {};
  const document = { createElement: element, head, body,
    querySelector: (sel) => (sel === ".sand-virtual-transcript" ? scroller : null),
    querySelectorAll: () => [],
    addEventListener: (k, fn) => { docListeners[k] = fn; }, removeEventListener() {} };
  const calls = { add: [], del: [] };
  const desktop = { collections: collections ? { addMessages: (a) => { calls.add.push(a); return Promise.resolve({}); }, list: () => Promise.resolve({ collections: [{ id: "bookmarks", name: "Bookmarks", count: 2 }] }) } : undefined,
    agent: { deleteTranscriptEntries: (a) => { calls.del.push(a); return deleteResult instanceof Error ? Promise.reject(deleteResult) : Promise.resolve(deleteResult ?? { deleted: a.entryIds.length }); } } };
  const window = { desktop, addEventListener() {}, removeEventListener() {} };
  const self = { __sandCurrentAgent: () => "cw_1", __sandDeleteAvailable: true };
  const stored = {};
  // Deferred, as in the DOM: a result message must be readable before the bar restores itself.
  const timers = [];
  const globals = { document, window, self, localStorage: { getItem: (k) => stored[k] ?? null, setItem(k, v) { stored[k] = v; } }, MutationObserver: class { observe() {} disconnect() {} }, requestAnimationFrame: () => 1, setInterval: () => 1, clearInterval() {}, setTimeout: (fn) => { timers.push(fn); return timers.length; } };
  new Function(...Object.keys(globals), SELECT_MODE_HELPER)(...Object.values(globals));
  const bar = body.children.find((c) => c.className === "sand-sel-bar");
  return { api: window.__sandSelect, bar, rowEls, addRow, calls, docListeners, self, stored, document, ask: desktop, timers };
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
  assert.deepEqual(api.idsOf(el({ "data-row-key": "t12u" })), [], "a row with no entry label is not a bubble");
  assert.deepEqual(api.idsOf(el({ "data-row-key": "e_7", "data-entry-id": "e_7" })), [], "a borrowed data-entry-id (separators, cards) is not a bubble either");
  assert.deepEqual(api.idsOf(el({ "data-row-key": "e_7" , "data-entry-ids": "e_7 e_8" })), ["e_7", "e_8"], "an attachment group");
  assert.deepEqual(api.idsOf(el({ "data-row-key": "e_7" }, false)), [], "a date separator borrows the next entry's key and is not a row");
});

test("entering from a message's menu selects that message; the toolbar shows Add loaded, the count, Clear, and icon buttons", () => {
  const { api, bar } = fakePage({ rows: [{ key: "nonce:1", label: labelled("e_1") }, { key: "e_2", label: labelled("e_2") }, { key: "e_3", label: labelled("e_3") }] });
  api.enter("e_2");
  assert.equal(api.count(), 1, "the seed counts, whatever its shape");
  assert.equal(count(bar), "1 selected");
  const b = buttons(bar);
  assert.deepEqual(b.map(label), ["Add the 2 loaded messages to the selection", "Clear the selection", "Share to a collection", "Bookmark", "Delete", "Done"]);
  assert.equal(b[0].disabled, false);
  assert.equal(b[4].className.includes("sand-sel-danger"), true, "delete is the dangerous one");
  assert.ok(b[2].innerHTML.startsWith("<svg"), "icons for the actions");
});

test("Add loaded only ever adds, and says so when there is nothing left to add", async () => {
  const page = fakePage({ rows: [{ key: "nonce:1", label: labelled("e_1") }, { key: "e_2", label: labelled("e_2") }] });
  const { api, bar, calls } = page;
  api.enter();
  assert.equal(count(bar), "0 selected");
  assert.deepEqual(buttons(bar).slice(1, 4).map((b) => b.disabled), [true, true, true], "nothing to share, bookmark or delete yet");
  buttons(bar)[0].listeners.click({ stopPropagation() {} });
  assert.equal(api.count(), 2);
  assert.equal(buttons(bar)[0].disabled, true, "everything loaded is in");
  assert.equal(buttons(bar)[0].children.at(-1).textContent, "All loaded added");
  buttons(bar)[0].listeners.click({ stopPropagation() {} });
  assert.equal(api.count(), 2, "pressing it again never removes anything");
  buttons(bar)[3].listeners.click({ stopPropagation() {} });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls.add, [{ agentId: "cw_1", entryIds: ["e_1", "e_2"], target: "bookmarks" }], "Bookmark sends what is selected");
});

test("messages loaded later can still be added; the button counts only what is new", () => {
  const page = fakePage({ rows: [{ key: "e_1", label: labelled("e_1") }] });
  page.api.enter();
  buttons(page.bar)[0].listeners.click({ stopPropagation() {} });
  assert.equal(page.api.count(), 1);
  page.addRow({ key: "e_2", label: labelled("e_2") });
  page.addRow({ key: "e_3", label: labelled("e_3") });
  page.api.paint();
  assert.equal(label(buttons(page.bar)[0]), "Add the 2 loaded messages to the selection", "the two that scrolled in");
  buttons(page.bar)[0].listeners.click({ stopPropagation() {} });
  assert.deepEqual(page.api.ids(), ["e_1", "e_2", "e_3"]);
});

test("Clear takes the selection back to nothing, and goes away at zero", () => {
  const { api, bar } = fakePage({ rows: [{ key: "e_1", label: labelled("e_1") }] });
  api.enter("e_1");
  const clear = buttons(bar).find((b) => label(b) === "Clear the selection");
  clear.listeners.click({ stopPropagation() {} });
  assert.equal(api.count(), 0);
  assert.equal(buttons(bar).some((b) => label(b) === "Clear the selection"), false);
});

test("delete asks first, names the server when it will really delete, and sends the ids through the door", async () => {
  const { api, bar, calls } = fakePage({ rows: [{ key: "e_2", label: labelled("e_2") }] });
  api.enter("e_2");
  buttons(bar).find((b) => label(b) === "Delete").listeners.click({ stopPropagation() {} });
  assert.match(count(bar), /Delete 1 message for everyone on this server\?/);
  const del = buttons(bar).find((b) => b.textContent === "Delete");
  del.listeners.click({ stopPropagation() {} });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls.del, [{ agentId: "cw_1", entryIds: ["e_2"] }]);
  assert.equal(api.active(), false, "done: selection mode ends");
});

const clickDelete = (bar) => { buttons(bar).find((b) => label(b) === "Delete" || label(b) === "Hide on this device").listeners.click({ stopPropagation() {} }); buttons(bar).find((b) => b.textContent === "Delete" || b.textContent === "Hide").listeners.click({ stopPropagation() {} }); };
const settle = () => new Promise((r) => setImmediate(r));

test("a server count short of the selection is reported, not passed off as done; the rest stay selected", async () => {
  const page = fakePage({ rows: [{ key: "e_1", label: labelled("e_1") }, { key: "e_2", label: labelled("e_2") }], deleteResult: { deleted: 1 } });
  page.api.enter(); page.api.addLoaded();
  clickDelete(page.bar);
  await settle();
  assert.equal(count(page.bar), "Deleted 1 of 2; the rest are still selected.");
  assert.equal(page.api.active(), true);
});

test("the local router's list is honoured; blocked ids are named and stay selected", async () => {
  const page = fakePage({ rows: [{ key: "t1u", label: labelled("t1u") }, { key: "t2u", label: labelled("t2u") }], deleteResult: { deleted: ["t1u"], blocked: [{ id: "t2u", reason: "pending" }] } });
  page.api.enter(); page.api.addLoaded();
  clickDelete(page.bar);
  await settle();
  assert.equal(count(page.bar), "1 deleted · 1 blocked (pending)");
  assert.deepEqual(page.api.ids(), ["t2u"]);
});

test("a failure where the server can delete is a failure, not a device hide; only Cursor hides", async () => {
  const server = fakePage({ rows: [{ key: "e_1", label: labelled("e_1") }], deleteResult: new Error("transcript unavailable") });
  server.api.enter("e_1");
  clickDelete(server.bar);
  await settle();
  assert.equal(count(server.bar), "Couldn’t delete: transcript unavailable.");
  assert.equal(server.stored["sandTombstones.v1"], undefined, "nothing hidden on this device");
  const cursor = fakePage({ rows: [{ key: "t1u", label: labelled("t1u") }], deleteResult: new Error("no such method") });
  cursor.self.__sandDeleteAvailable = false;
  cursor.api.enter("t1u");
  assert.equal(buttons(cursor.bar).some((b) => label(b) === "Hide on this device"), true);
  clickDelete(cursor.bar);
  await settle();
  assert.match(JSON.parse(cursor.stored["sandTombstones.v1"]).cw_1.join(","), /t1u/, "hidden on this device, as the button said");
});

test("switching chats ends the selection instead of sending one chat's ids with another's agent", () => {
  const page = fakePage({ rows: [{ key: "e_1", label: labelled("e_1") }] });
  page.api.enter("e_1");
  page.self.__sandCurrentAgent = () => "cw_2";
  page.api.paint();
  assert.equal(page.api.active(), false);
});

test("Escape inside the collection-name field, or with a menu open, is not the end of the selection", () => {
  const page = fakePage({ rows: [{ key: "e_1", label: labelled("e_1") }] });
  page.api.enter("e_1");
  page.docListeners.keydown({ key: "Escape", target: { tagName: "INPUT" }, preventDefault() {}, stopPropagation() {} });
  assert.equal(page.api.active(), true, "the field's own Escape handles it");
  const plain = page.document.querySelector;
  page.document.querySelector = (sel) => (sel.includes("[role=menu]") ? {} : plain(sel));
  page.docListeners.keydown({ key: "Escape", target: { tagName: "DIV" }, preventDefault() {}, stopPropagation() {} });
  assert.equal(page.api.active(), true, "a menu is open; Escape is its");
  page.document.querySelector = plain;
  page.docListeners.keydown({ key: "Escape", target: { tagName: "DIV" }, preventDefault() {}, stopPropagation() {} });
  assert.equal(page.api.active(), false);
});

test("a hyphenated server id round-trips through the label; a bare key never counts", () => {
  const { api } = fakePage({ rows: [] });
  const el = (attrs) => ({ getAttribute: (k) => attrs[k] ?? null, classList: { contains: (c) => c === "sand-transcript-row" } });
  assert.deepEqual(api.idsOf(el({ "data-row-key": "e_01a0:attachment-group" })), []);
  assert.deepEqual(api.idsOf(el({ "aria-labelledby": labelled("e_01a06178-67db-7711-9936-8be4a4324a60"), "data-row-key": "nonce:1" })), ["e_01a06178-67db-7711-9936-8be4a4324a60"]);
});
