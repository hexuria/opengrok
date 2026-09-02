import assert from "node:assert/strict";
import test from "node:test";

import { DELETE_MESSAGE_HELPER } from "../scripts/lib/delete-message-helper.mjs";

/** The smallest page the helper needs: a head, a row for one entry id, elements it can build. */
function fakePage({ available, deleteResult, deleteError, pending } = {}) {
  const element = (tag) => {
    const el = { tag, children: [], attrs: {}, textContent: "", className: "", type: "", disabled: false, listeners: {},
      appendChild(child) { this.children.push(child); child.parent = this; return child; },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; },
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; },
      addEventListener(k, fn) { this.listeners[k] = fn; }, focus() {},
      hasAttribute(k) { return k in this.attrs; }, get isConnected() { return this.parent != null; } };
    return el;
  };
  const row = element("div"); row.attrs["aria-labelledby"] = "sand-conversation-entry-e1-author sand-conversation-entry-e1-timestamp";
  if (pending) row.attrs["data-pending"] = "true";
  const pendingRow = element("div"); pendingRow.attrs["aria-labelledby"] = "sand-conversation-entry-e2-author"; pendingRow.attrs["data-pending"] = "true";
  const docListeners = {};
  const document = { createElement: element, head: element("head"), documentElement: element("html"),
    // Live rows carry the entry id in aria-labelledby; data-row-key is the nonce on the person's own rows.
    querySelector: (sel) => (sel === '.sand-virtual-transcript .sand-transcript-row[aria-labelledby*="sand-conversation-entry-e1-"]' ? row : sel === '.sand-virtual-transcript .sand-transcript-row[aria-labelledby*="sand-conversation-entry-e2-"]' ? pendingRow : null),
    addEventListener: (k, fn) => { docListeners[k] = fn; } };
  const calls = [];
  const desktop = {
    getTranscriptDeletion: () => Promise.resolve({ available, route: available ? "opengrok" : "cursor", reason: null }),
    deleteTranscriptEntries: (args) => { calls.push(args); return deleteError ? Promise.reject(deleteError) : Promise.resolve(deleteResult); },
  };
  const self = { __sandCurrentAgent: () => "cw_1" };
  const window = { desktop: { agent: desktop } };
  new Function("document", "window", "self", DELETE_MESSAGE_HELPER)(document, window, self);
  return { document, row, pendingRow, self, calls, docListeners, ask: desktop };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const strip = (row) => row.children.find((c) => c.className === "sand-delete-confirm");

test("the item exists only where deletion is available, asked once at boot", async () => {
  const yes = fakePage({ available: true });
  const no = fakePage({ available: false });
  await tick();
  assert.equal(yes.self.__sandDeleteAvailable, true);
  assert.equal(no.self.__sandDeleteAvailable, false, "Cursor: no item");
});

test("Delete message asks once inside the row, then deletes through the desktop and lets the stream remove the row", async () => {
  const page = fakePage({ available: true, deleteResult: { deleted: 1 } });
  assert.equal(page.self.__sandDeleteMessage("e1", ""), true);
  const box = strip(page.row);
  assert.ok(box, "the question is in the row");
  assert.equal(box.attrs.role, "alertdialog");
  const [text, ok, cancel] = box.children;
  assert.equal(text.textContent, "Delete this message?");
  assert.equal(ok.textContent, "Delete");
  assert.equal(cancel.textContent, "Cancel");
  assert.equal(page.calls.length, 0, "nothing is deleted before the answer");
  ok.listeners.click();
  assert.deepEqual(page.calls, [{ agentId: "cw_1", entryIds: ["e1"] }]);
  await tick();
  assert.equal(strip(page.row), undefined, "the question goes; the row itself is the stream's to remove");
  assert.equal(page.self.__sandDeleteMessage("nope", ""), false, "an id with no row does nothing");
});

test("Cancel and Escape withdraw the question; a refusal is shown in the row", async () => {
  const page = fakePage({ available: true, deleteResult: { deleted: [], blocked: [{ id: "e1", reason: "not-found" }] } });
  page.self.__sandDeleteMessage("e1", "cw_9");
  strip(page.row).children[2].listeners.click();
  assert.equal(strip(page.row), undefined, "Cancel");
  page.self.__sandDeleteMessage("e1", "cw_9");
  page.docListeners.keydown({ key: "Escape" });
  assert.equal(strip(page.row), undefined, "Escape");
  page.self.__sandDeleteMessage("e1", "cw_9");
  strip(page.row).children[1].listeners.click();
  assert.equal(page.calls.at(-1).agentId, "cw_9", "the menu's agent hint wins over the current agent");
  await tick();
  assert.equal(strip(page.row).children[0].textContent, "Couldn’t delete: not-found.");
  const failing = fakePage({ available: true, deleteError: new Error("transcript unavailable") });
  failing.self.__sandDeleteMessage("e1", "");
  strip(failing.row).children[1].listeners.click();
  await tick();
  assert.equal(strip(failing.row).children[0].textContent, "Couldn’t delete: transcript unavailable.");
});

test("a message still on its way to the server gets a plain answer, not a delete", () => {
  const page = fakePage({ available: true });
  assert.equal(page.self.__sandDeleteMessage("e2", ""), true);
  const box = strip(page.pendingRow);
  assert.match(box.children[0].textContent, /hasn’t reached the server yet/);
  assert.equal(box.children.length, 2, "just the note and OK");
  box.children[1].listeners.click();
  assert.equal(strip(page.pendingRow), undefined);
  assert.equal(page.calls.length, 0);
});

test("the question is put back on its row when the row re-rendered under it", async () => {
  const page = fakePage({ available: true, deleteResult: { deleted: 0, blocked: [{ id: "e1", reason: "branch-root-with-children" }] } });
  page.self.__sandDeleteMessage("e1", "");
  const box = strip(page.row);
  box.children[1].listeners.click();
  box.remove();
  assert.equal(strip(page.row), undefined, "React re-rendered the row and dropped the strip");
  await tick();
  assert.equal(strip(page.row)?.children[0].textContent, "Couldn’t delete: branch-root-with-children.", "the answer still lands on the row");
});

test("availability is asked again when a menu is built, at most every five seconds", async () => {
  const page = fakePage({ available: true });
  let asks = 0;
  page.ask.getTranscriptDeletion = () => { asks += 1; return Promise.resolve({ available: false }); };
  page.self.__sandDeleteRefresh();
  page.self.__sandDeleteRefresh();
  assert.equal(asks, 0, "within five seconds of the boot ask, nothing is asked again");
});
