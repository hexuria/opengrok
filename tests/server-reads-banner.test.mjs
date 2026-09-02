import assert from "node:assert/strict";
import test from "node:test";

import { SERVER_READS_BANNER_HELPER, SERVER_READS_TEXT_SOURCE } from "../scripts/lib/server-reads-banner.mjs";

const text = new Function(`${SERVER_READS_TEXT_SOURCE} return __sandServerReadsText;`)();

test("the banner says exactly what is old, and nothing when reads are live", () => {
  assert.equal(text(null), null);
  assert.equal(text({ state: "live", since: null, cached: false, message: null }), null);
  assert.match(text({ state: "stale", since: 1, cached: true, cachedAt: null, message: "x" }), /Showing what was loaded earlier/);
  assert.match(text({ state: "stale", since: 1, cached: true, cachedAt: Date.UTC(2026, 8, 2, 7, 40), message: "x" }), /Showing what was loaded at /, "the time is when the roster was last live, not when it first failed");
  assert.equal(text({ state: "stale", since: 1, cached: false, message: "x" }), "Your server can’t be reached, and nothing from it has loaded yet.");
});

/** The smallest document the helper needs: elements it can create, append and remove. */
function fakeDocument() {
  const made = [];
  const element = (tag) => {
    const el = { tag, children: [], attrs: {}, textContent: "", className: "", type: "", listeners: {},
      appendChild(child) { this.children.push(child); child.parent = this; return child; },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); },
      setAttribute(k, v) { this.attrs[k] = v; },
      addEventListener(k, fn) { this.listeners[k] = fn; } };
    made.push(el);
    return el;
  };
  const body = element("body");
  const head = element("head");
  // No agent rows on this fake page unless a test says otherwise.
  return { document: { createElement: element, body, head, documentElement: head, querySelector: () => null }, made, body };
}

test("the helper subscribes through the desktop bridge and paints the banner from the state it is given", () => {
  const { document, body } = fakeDocument();
  let subscriber = null;
  const window = { desktop: { agent: { onServerReads: (fn) => { subscriber = fn; return () => {}; } } } };
  const location = { reload() { this.reloaded = true; } };
  const timers = [];
  const setTimeout = (fn, ms) => { timers.push([fn, ms]); return timers.length; };
  new Function("document", "window", "location", "setTimeout", SERVER_READS_BANNER_HELPER)(document, window, location, setTimeout);
  assert.ok(subscriber, "subscribed on load");

  subscriber({ state: "stale", since: 1, cached: true, message: "pool timed out" });
  const banner = body.children.find((c) => c.className === "sand-server-reads");
  assert.ok(banner, "banner painted");
  assert.equal(banner.attrs.role, "status");
  assert.match(banner.children[0].textContent, /can’t be reached/);
  banner.children[1].listeners.click();
  assert.equal(location.reloaded, true, "Retry reloads, which re-reads through the cache");

  // The roster is empty (this fake page has no agent rows), so the server coming back is worth a
  // reload: the page has nothing else to refresh from.
  location.reloaded = false;
  subscriber({ state: "live", since: null, cached: false, cachedAt: null, message: null });
  assert.match(banner.textContent, /Your server is back; refreshing/);
  assert.equal(timers.length, 1, "a reload is scheduled, not fired mid-render");
  timers[0][0]();
  assert.equal(location.reloaded, true);
});

test("when the server returns and the page still shows its roster, the banner simply goes", () => {
  const { document, body } = fakeDocument();
  let subscriber = null;
  const window = { desktop: { agent: { onServerReads: (fn) => { subscriber = fn; return () => {}; } } } };
  const location = { reload() { this.reloaded = true; } };
  const timers = [];
  document.querySelector = () => ({ tag: "agent-row" }); // a roster is on screen
  new Function("document", "window", "location", "setTimeout", SERVER_READS_BANNER_HELPER)(document, window, location, (fn, ms) => { timers.push([fn, ms]); });
  subscriber({ state: "stale", since: 1, cached: true, cachedAt: 1, message: "x" });
  subscriber({ state: "live", since: null, cached: false, cachedAt: null, message: null });
  assert.ok(!body.children.some((c) => c.className === "sand-server-reads"));
  assert.equal(timers.length, 0, "no reload when there is a roster to keep");
  assert.equal(location.reloaded, undefined);
});

test("without the bridge method the helper does nothing and throws nothing", () => {
  const { document } = fakeDocument();
  assert.doesNotThrow(() => new Function("document", "window", "location", SERVER_READS_BANNER_HELPER)(document, { desktop: { agent: {} } }, {}));
  assert.doesNotThrow(() => new Function("document", "window", "location", SERVER_READS_BANNER_HELPER)(document, {}, {}));
});
