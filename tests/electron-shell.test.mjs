import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { reconstructedBundleId } from "../scripts/lib/config.mjs";
import {
  MACOS_EXECUTABLE_NAME,
  NPM_ELECTRON_VERSION,
  applyMacBundleIdentity,
  electronHelperRenames,
  reconstructedUrlTypesXml,
  renameElectronShell,
  resolveNpmElectronApp,
  stageNpmElectronShell,
} from "../scripts/lib/electron-shell.mjs";
import { helperInfoPlistPath, reconstructedHelperIdentities } from "../scripts/lib/macos-helper-identity.mjs";
import {
  verifyNpmElectronMacShell,
  verifyReconstructedHelperIdentities,
  verifyReconstructedMacPackage,
} from "../scripts/lib/macos-package-verification.mjs";
import { capture } from "../scripts/lib/process.mjs";
import { SYSTEM_TOOLS } from "../scripts/lib/system-tools.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const darwin = process.platform === "darwin";

function plist(entries) {
  const body = Object.entries(entries).map(([key, value]) => `  <key>${key}</key>\n  <string>${value}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
</dict>
</plist>
`;
}

async function writeBundle({ root, folder, executable, identifier }) {
  const app = path.join(root, folder);
  await mkdir(path.join(app, "Contents", "MacOS"), { recursive: true });
  await writeFile(path.join(app, "Contents", "MacOS", executable), "stub\n", { mode: 0o755 });
  await writeFile(path.join(app, "Contents", "Info.plist"), plist({
    CFBundleDisplayName: executable,
    CFBundleExecutable: executable,
    CFBundleIdentifier: identifier,
    CFBundleName: executable,
  }));
  return app;
}

async function createFakeElectronApp(root) {
  const electronApp = path.join(root, "Electron.app");
  await writeBundle({
    root,
    folder: "Electron.app",
    executable: "Electron",
    identifier: "com.github.Electron",
  });
  const frameworks = path.join(electronApp, "Contents", "Frameworks");
  await mkdir(frameworks, { recursive: true });
  for (const helper of electronHelperRenames()) {
    await writeBundle({
      root: frameworks,
      folder: `${helper.from}.app`,
      executable: helper.from,
      identifier: helper.from === "Electron Helper" ? "com.github.Electron.helper" : `com.github.Electron.helper.${helper.from.slice("Electron Helper (".length, -1)}`,
    });
  }
  await mkdir(path.join(electronApp, "Contents", "Resources"), { recursive: true });
  await writeFile(path.join(electronApp, "Contents", "Resources", "default_app.asar"), "default\n");
  return electronApp;
}

test("helper bundle ids sit under bot.opengrok.app, not Electron or Anysphere", () => {
  const helpers = reconstructedHelperIdentities();
  assert.equal(MACOS_EXECUTABLE_NAME, "Grok Bot");
  assert.deepEqual(helpers.map(helper => helper.folder), [
    "Grok Bot Helper.app",
    "Grok Bot Helper (GPU).app",
    "Grok Bot Helper (Plugin).app",
    "Grok Bot Helper (Renderer).app",
  ]);
  assert.deepEqual(helpers.map(helper => helper.bundleId), [
    "bot.opengrok.app.helper",
    "bot.opengrok.app.helper.GPU",
    "bot.opengrok.app.helper.Plugin",
    "bot.opengrok.app.helper.Renderer",
  ]);
  assert.equal(reconstructedBundleId, "bot.opengrok.app");
  assert.deepEqual(
    reconstructedHelperIdentities("bot.example.app").map(helper => helper.bundleId),
    ["bot.example.app.helper", "bot.example.app.helper.GPU", "bot.example.app.helper.Plugin", "bot.example.app.helper.Renderer"],
  );
  assert.equal(
    helperInfoPlistPath("/tmp/Open Grok.app", "Grok Bot Helper (GPU).app"),
    path.join("/tmp/Open Grok.app", "Contents", "Frameworks", "Grok Bot Helper (GPU).app", "Contents", "Info.plist"),
  );
  assert.deepEqual(electronHelperRenames().map(helper => [helper.from, helper.to]), [
    ["Electron Helper", "Grok Bot Helper"],
    ["Electron Helper (GPU)", "Grok Bot Helper (GPU)"],
    ["Electron Helper (Plugin)", "Grok Bot Helper (Plugin)"],
    ["Electron Helper (Renderer)", "Grok Bot Helper (Renderer)"],
  ]);
  assert.match(reconstructedUrlTypesXml, /<string>sand<\/string>/);
  assert.match(reconstructedUrlTypesXml, /<string>opengrok<\/string>/);
  assert.equal(resolveNpmElectronApp(repoRoot), path.join(repoRoot, "node_modules", "electron", "dist", "Electron.app"));
});

test("package.json stays pinned to the npm Electron wrapper version", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.devDependencies.electron, NPM_ELECTRON_VERSION);
  assert.equal(NPM_ELECTRON_VERSION, "42.1.0");
});

test("staging npm Electron.app rewrites names, identity, and URL schemes", { skip: !darwin }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opengrok-electron-shell-"));
  try {
    const sourceApp = await createFakeElectronApp(root);
    const destinationApp = path.join(root, "Open Grok.app");
    const staged = await stageNpmElectronShell({
      destinationApp,
      sourceApp,
      bundleId: reconstructedBundleId,
      displayName: "Open Grok",
      productUrl: "https://OpenGrok.app",
    });
    assert.equal(staged.appPath, destinationApp);
    assert.equal(staged.sourceApp, sourceApp);

    const infoPlist = path.join(destinationApp, "Contents", "Info.plist");
    assert.equal(await capture(SYSTEM_TOOLS.plutil, ["-extract", "CFBundleIdentifier", "raw", infoPlist]), "bot.opengrok.app");
    assert.equal(await capture(SYSTEM_TOOLS.plutil, ["-extract", "CFBundleDisplayName", "raw", infoPlist]), "Open Grok");
    assert.equal(await capture(SYSTEM_TOOLS.plutil, ["-extract", "CFBundleName", "raw", infoPlist]), "Grok Bot");
    assert.equal(await capture(SYSTEM_TOOLS.plutil, ["-extract", "CFBundleExecutable", "raw", infoPlist]), "Grok Bot");
    assert.equal(await capture(SYSTEM_TOOLS.plutil, ["-extract", "GrokProductURL", "raw", infoPlist]), "https://OpenGrok.app");
    assert.equal(await capture(SYSTEM_TOOLS.plutil, ["-extract", "CFBundleURLTypes.0.CFBundleURLSchemes.0", "raw", infoPlist]), "sand");
    assert.equal(await capture(SYSTEM_TOOLS.plutil, ["-extract", "CFBundleURLTypes.1.CFBundleURLSchemes.0", "raw", infoPlist]), "opengrok");

    await readFile(path.join(destinationApp, "Contents", "MacOS", "Grok Bot"));
    await assert.rejects(readFile(path.join(destinationApp, "Contents", "MacOS", "Electron")));
    await assert.rejects(readFile(path.join(destinationApp, "Contents", "Resources", "default_app.asar")));

    for (const { folder, bundleId } of reconstructedHelperIdentities()) {
      const helperPlist = helperInfoPlistPath(destinationApp, folder);
      const helperName = folder.replace(/\.app$/, "");
      assert.equal(await capture(SYSTEM_TOOLS.plutil, ["-extract", "CFBundleIdentifier", "raw", helperPlist]), bundleId);
      assert.equal(await capture(SYSTEM_TOOLS.plutil, ["-extract", "CFBundleExecutable", "raw", helperPlist]), helperName);
      await readFile(path.join(destinationApp, "Contents", "Frameworks", folder, "Contents", "MacOS", helperName));
    }
    assert.deepEqual(
      (await verifyReconstructedHelperIdentities({ reconstructedApp: destinationApp })).map(helper => helper.bundleId),
      reconstructedHelperIdentities().map(helper => helper.bundleId),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rename and identity helpers refuse an unspecified bundle", async () => {
  await assert.rejects(() => renameElectronShell(""), /application bundle path/);
  await assert.rejects(() => applyMacBundleIdentity({}), /application bundle path/);
  await assert.rejects(() => stageNpmElectronShell({}), /destinationApp/);
  await assert.rejects(() => verifyNpmElectronMacShell({}), /electronApp and reconstructedApp/);
  await assert.rejects(() => verifyReconstructedHelperIdentities({}), /reconstructedApp/);
  await assert.rejects(
    () => verifyReconstructedMacPackage({}),
    /reconstructedApp, sourceUnpackedRoot, and packagedUnpackedRoot/,
  );
});
