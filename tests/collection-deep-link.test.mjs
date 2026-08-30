import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadDeepLink() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-collection-deep-link-"));
  const output = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/shared/deep-link.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

const MINTED_ID = "col0a1b2c3d4e5f6g7";

test("/v1/collection accepts minted ids on both protocol schemes and canonicalizes to opengrok", async () => {
  const loaded = await loadDeepLink();
  try {
    const { buildCollectionDeepLinkUrl, parseSandDeepLink, canonicalSandDeepLinkUrl } = loaded.module;
    const url = buildCollectionDeepLinkUrl(MINTED_ID);
    assert.equal(url, `opengrok://app/v1/collection?id=${MINTED_ID}`);

    const parsed = parseSandDeepLink(url);
    assert.deepEqual(parsed.link, { version: 1, route: "collection", collectionId: MINTED_ID, source: "protocol" });
    assert.equal(parsed.canonicalUrl, url);
    assert.equal(canonicalSandDeepLinkUrl(parsed.link), url);

    // sand:// stays a first-class alias (it is the scheme Cursor's auth
    // callback owns), but every canonical form is the brand scheme.
    const viaSand = parseSandDeepLink(`sand://app/v1/collection?id=${MINTED_ID}`);
    assert.equal(viaSand.link.route, "collection");
    assert.equal(viaSand.canonicalUrl, url);

    const bookmarks = parseSandDeepLink("opengrok://app/v1/collection?id=bookmarks");
    assert.equal(bookmarks.link.collectionId, "bookmarks");
    assert.equal(bookmarks.canonicalUrl, "opengrok://app/v1/collection?id=bookmarks");
  } finally {
    await loaded.dispose();
  }
});

test("/v1/collection rejects malformed ids, extra query, and every https form", async () => {
  const loaded = await loadDeepLink();
  try {
    const { parseSandDeepLink } = loaded.module;
    const rejected = [
      "opengrok://app/v1/collection",
      "opengrok://app/v1/collection?id=",
      "opengrok://app/v1/collection?id=a/b",
      "opengrok://app/v1/collection?id=a%2Fb",
      `opengrok://app/v1/collection?id=${"a".repeat(129)}`,
      `opengrok://app/v1/collection?id=${MINTED_ID}&extra=1`,
      `opengrok://app/v1/collection?collection=${MINTED_ID}`,
      `opengrok://other/v1/collection?id=${MINTED_ID}`,
      `opengrok://app/v1/collection/${MINTED_ID}`,
      `opengrok://app:9000/v1/collection?id=${MINTED_ID}`,
      // Collection links are minted locally and must never arrive over the web.
      `https://cursor.com/sand/link/v1/collection?id=${MINTED_ID}`,
      `https://cursor.com/v1/collection?id=${MINTED_ID}`,
      `opengrok://app/v1/collection?id=${MINTED_ID}#frag`,
    ];
    for (const candidate of rejected) assert.equal(parseSandDeepLink(candidate), null, candidate);
  } finally {
    await loaded.dispose();
  }
});

test("existing /v1/message and /v1/info deep links are unchanged", async () => {
  const loaded = await loadDeepLink();
  try {
    const { parseSandDeepLink, buildSandMessageDeepLinkUrl, SAND_OPEN_DEEP_LINK_URL } = loaded.module;

    const messageUrl = buildSandMessageDeepLinkUrl("agent-7", "t3s0");
    assert.equal(messageUrl, "opengrok://app/v1/message?agent=agent-7&id=t3s0");
    const message = parseSandDeepLink(messageUrl);
    assert.deepEqual(message.link, { version: 1, route: "message", agentId: "agent-7", messageId: "t3s0", source: "protocol" });
    assert.equal(message.canonicalUrl, messageUrl);

    const hinted = parseSandDeepLink("opengrok://app/v1/message?agent=agent-7&id=t3s0&i=42");
    assert.equal(hinted.link.indexHint, 42);
    assert.equal(hinted.canonicalUrl, messageUrl);

    assert.equal(parseSandDeepLink("opengrok://app/v1/message?agent=agent-7"), null);
    assert.equal(parseSandDeepLink("opengrok://app/v1/message?agent=a/b&id=t3s0"), null);

    const open = parseSandDeepLink(SAND_OPEN_DEEP_LINK_URL);
    assert.equal(open.link.route, "open");

    const info = parseSandDeepLink("sand://app/v1/info?topic=deep-links");
    assert.deepEqual(info.link, { version: 1, route: "info", topic: "deep-links", source: "protocol" });
    assert.equal(info.canonicalUrl, "sand://app/v1/info?topic=deep-links");

    const httpsInfo = parseSandDeepLink("https://cursor.com/sand/link/v1/info?topic=deep-links");
    assert.equal(httpsInfo.link.source, "https");
  } finally {
    await loaded.dispose();
  }
});
