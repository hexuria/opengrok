import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

import { appVariant, isV2Variant, outputApp, reconstructedBundleId, reconstructedName, reconstructedUrlSchemes } from "../scripts/lib/config.mjs";
import { reconstructedUrlTypesXml, urlTypesXmlFor } from "../scripts/lib/electron-shell.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(sourcePath) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-app-variant-"));
  const output = path.join(temporary, "module.mjs");
  await build({ entryPoints: [path.join(repoRoot, sourcePath)], outfile: output, bundle: true, format: "esm", platform: "node", target: "node22", external: ["electron"] });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

// V1 (main) and V2 (this branch) install and run side by side. Everything that
// would collide is keyed off the variant: bundle name and id, URL schemes,
// user-data dir, data root. See CLAUDE.md, "V1 and V2 side by side".
test("packaging identity follows app-variant.json", async () => {
  const declared = JSON.parse(await readFile(path.join(repoRoot, "app-variant.json"), "utf8")).variant;
  assert.equal(appVariant, process.env.OPENGROK_APP_VARIANT?.trim().toLowerCase() || declared);
  if (isV2Variant) {
    assert.equal(path.basename(outputApp), "Open Grok V2.app");
    assert.equal(reconstructedBundleId, "bot.opengrok.app.v2");
    assert.equal(reconstructedName, "Open Grok V2");
    assert.deepEqual(reconstructedUrlSchemes, ["opengrokv2"], "V2 leaves sand:// and opengrok:// to V1");
  } else {
    assert.equal(path.basename(outputApp), "Open Grok.app");
    assert.equal(reconstructedBundleId, "bot.opengrok.app");
    assert.deepEqual(reconstructedUrlSchemes, ["sand", "opengrok"]);
  }
  assert.equal(reconstructedUrlTypesXml, urlTypesXmlFor(reconstructedUrlSchemes));
  assert.match(urlTypesXmlFor(["sand", "opengrok"]), /<string>sand<\/string>.*<string>opengrok<\/string>/);
});

test("the runtime tells V2 apart by bundle name and keeps its profile, data root and scheme separate", async () => {
  const loaded = await loadModule("source/electron-main/startup/desktop-user-data-bootstrap.ts");
  try {
    const { isReconstructedDesktopApp, resolveOpenGrokAppVariant, userDataDirNameForVariant, dataRootForVariant, RECONSTRUCTED_APP_BUNDLE_NAMES } = loaded.module;
    assert.ok(RECONSTRUCTED_APP_BUNDLE_NAMES.includes("Open Grok V2.app"));
    assert.equal(isReconstructedDesktopApp("/Applications/Open Grok V2.app/Contents/MacOS/Grok Bot", {}), true);
    assert.equal(resolveOpenGrokAppVariant("/Applications/Open Grok V2.app/Contents/MacOS/Grok Bot", {}), "v2");
    assert.equal(resolveOpenGrokAppVariant("/Applications/Open Grok.app/Contents/MacOS/Grok Bot", {}), "v1");
    assert.equal(resolveOpenGrokAppVariant("/x/Electron", { OPENGROK_APP_VARIANT: "v2" }), "v2");
    assert.equal(userDataDirNameForVariant("v1"), "OpenGrok");
    assert.equal(userDataDirNameForVariant("v2"), "OpenGrok V2");
    assert.equal(dataRootForVariant("v1", "/home/u"), null, "V1 keeps the canonical ~/.grokbot settlement");
    assert.equal(dataRootForVariant("v2", "/home/u"), path.join("/home/u", ".grokbot-v2"));
  } finally {
    await loaded.dispose();
  }
  const links = await loadModule("source/shared/deep-link.ts");
  try {
    const { parseSandDeepLink, OPENGROK_V2_DEEP_LINK_SCHEME } = links.module;
    assert.equal(OPENGROK_V2_DEEP_LINK_SCHEME, "opengrokv2");
    const parsed = parseSandDeepLink("opengrokv2://app/v1/collection?id=bookmarks");
    assert.equal(parsed?.link.route, "collection");
    assert.equal(parsed?.link.collectionId, "bookmarks");
    assert.equal(parseSandDeepLink("opengrok://app/v1/collection?id=bookmarks")?.link.route, "collection", "V1 links still parse");
    assert.equal(parseSandDeepLink("opengrokv3://app/v1/collection?id=bookmarks"), null, "unknown schemes stay rejected");
  } finally {
    await links.dispose();
  }
  const auth = await loadModule("source/electron-main/auth/auth-callback-registration.ts");
  try {
    const calls = [];
    const result = auth.module.registerAuthCallbackProtocol({ app: { setAsDefaultProtocolClient: (scheme) => { calls.push(scheme); return true; } }, isPackaged: true, isLabBuild: false, env: {}, skip: true });
    assert.deepEqual(calls, [], "V2 never claims sand://");
    assert.equal(result.skipped, true);
    assert.equal(result.protocolScheme, "sand", "the scheme itself is untouched");
  } finally {
    await auth.dispose();
  }
});
