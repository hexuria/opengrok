import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ELECTRON_ENTITLEMENTS_PATH } from "../scripts/lib/codesign.mjs";
import {
  distributionZipPath,
  dittoZipArguments,
  notarytoolSubmitArguments,
  releaseMacosApp,
  resolveNotaryCredentials,
  shouldNotarize,
  staplerStapleArguments,
} from "../scripts/lib/macos-release.mjs";
import { SYSTEM_TOOLS } from "../scripts/lib/system-tools.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SECURITY_OUTPUT = `
  1) 1111111111111111111111111111111111111111 "Developer ID Application: Example Dev (TEAMID1234)"
     1 valid identities found
`;

test("ditto zip keeps the parent .app and skips Apple notary unless opted in", () => {
  const appPath = "/tmp/Open Grok.app";
  const zipPath = distributionZipPath(appPath);
  assert.equal(zipPath, "/tmp/Open Grok.zip");
  assert.deepEqual(dittoZipArguments(appPath, zipPath), ["-c", "-k", "--keepParent", appPath, zipPath]);
  assert.throws(() => dittoZipArguments("", zipPath), /application bundle path/);
  assert.throws(() => dittoZipArguments(appPath, ""), /zip destination path/);
  assert.throws(() => distributionZipPath("/tmp/Open Grok"), /\.app/);

  assert.equal(shouldNotarize({}), false);
  assert.equal(shouldNotarize({ SAND_NOTARIZE: "0" }), false);
  assert.equal(shouldNotarize({ SAND_NOTARY_KEYCHAIN_PROFILE: "AC_PASSWORD" }), false);
  assert.equal(shouldNotarize({ SAND_NOTARIZE: "1" }), true);
  assert.equal(resolveNotaryCredentials({}), null);
  assert.deepEqual(
    resolveNotaryCredentials({ SAND_NOTARIZE: "1", SAND_NOTARY_KEYCHAIN_PROFILE: "AC_PASSWORD" }),
    { type: "keychain-profile", profile: "AC_PASSWORD" },
  );
  assert.deepEqual(
    resolveNotaryCredentials({
      SAND_NOTARIZE: "true",
      SAND_NOTARY_API_KEY: "/tmp/AuthKey.p8",
      SAND_NOTARY_API_KEY_ID: "KEYID",
      SAND_NOTARY_ISSUER: "ISSUER",
    }),
    { type: "api-key", key: "/tmp/AuthKey.p8", keyId: "KEYID", issuer: "ISSUER" },
  );
  assert.throws(
    () => resolveNotaryCredentials({ SAND_NOTARIZE: "1" }),
    /SAND_NOTARY_KEYCHAIN_PROFILE/,
  );
  assert.deepEqual(
    notarytoolSubmitArguments("/tmp/Open Grok.zip", { type: "keychain-profile", profile: "AC_PASSWORD" }),
    ["notarytool", "submit", "/tmp/Open Grok.zip", "--wait", "--keychain-profile", "AC_PASSWORD"],
  );
  assert.deepEqual(
    staplerStapleArguments("/tmp/Open Grok.app"),
    ["stapler", "staple", "/tmp/Open Grok.app"],
  );
});

test("release-macos signs with timestamp and zips without calling notarytool", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opengrok-macos-release-"));
  const appPath = path.join(root, "Open Grok.app");
  await mkdir(appPath);
  const calls = [];
  try {
    const result = await releaseMacosApp({
      appPath,
      env: { SAND_NOTARY_KEYCHAIN_PROFILE: "AC_PASSWORD" },
      listIdentities: async () => SECURITY_OUTPUT,
      runCommand: async (command, args) => { calls.push({ command, args }); },
    });
    assert.equal(result.identity, "Developer ID Application: Example Dev (TEAMID1234)");
    assert.equal(result.zipPath, path.join(root, "Open Grok.zip"));
    assert.equal(result.notarized, false);
    assert.deepEqual(calls, [
      {
        command: "/usr/bin/codesign",
        args: [
          "--force",
          "--deep",
          "--timestamp",
          "--options",
          "runtime",
          "--entitlements",
          ELECTRON_ENTITLEMENTS_PATH,
          "--sign",
          "Developer ID Application: Example Dev (TEAMID1234)",
          appPath,
        ],
      },
      {
        command: SYSTEM_TOOLS.codesign,
        args: ["--verify", "--deep", "--strict", appPath],
      },
      {
        command: SYSTEM_TOOLS.ditto,
        args: ["-c", "-k", "--keepParent", appPath, result.zipPath],
      },
    ]);
    assert.equal(calls.some((call) => call.args?.includes("notarytool") || call.args?.includes("stapler")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release-macos notarizes and staples only when SAND_NOTARIZE is set", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opengrok-macos-notary-"));
  const appPath = path.join(root, "Open Grok.app");
  await mkdir(appPath);
  const calls = [];
  try {
    const result = await releaseMacosApp({
      appPath,
      env: { SAND_NOTARIZE: "1", SAND_NOTARY_KEYCHAIN_PROFILE: "AC_PASSWORD" },
      listIdentities: async () => SECURITY_OUTPUT,
      runCommand: async (command, args) => { calls.push({ command, args }); },
    });
    assert.equal(result.notarized, true);
    assert.deepEqual(
      calls.filter((call) => call.command === SYSTEM_TOOLS.xcrun),
      [
        {
          command: SYSTEM_TOOLS.xcrun,
          args: ["notarytool", "submit", result.zipPath, "--wait", "--keychain-profile", "AC_PASSWORD"],
        },
        {
          command: SYSTEM_TOOLS.xcrun,
          args: ["stapler", "staple", appPath],
        },
      ],
    );
    assert.equal(calls.filter((call) => call.command === SYSTEM_TOOLS.ditto).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release-macos refuses a missing app and incomplete notary credentials without contacting Apple", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opengrok-macos-release-missing-"));
  const calls = [];
  const runCommand = async (command, args) => { calls.push({ command, args }); };
  try {
    await assert.rejects(
      () => releaseMacosApp({
        appPath: path.join(root, "Open Grok.app"),
        env: {},
        runCommand,
      }),
      /npm run package first/,
    );
    const appPath = path.join(root, "Open Grok.app");
    await mkdir(appPath);
    await assert.rejects(
      () => releaseMacosApp({
        appPath,
        env: { SAND_NOTARIZE: "1" },
        listIdentities: async () => SECURITY_OUTPUT,
        runCommand,
      }),
      /SAND_NOTARY_KEYCHAIN_PROFILE/,
    );
    assert.equal(calls.length, 0);
    await assert.rejects(
      () => releaseMacosApp({
        appPath,
        env: { SAND_CODESIGN_IDENTITY: "-" },
        runCommand,
      }),
      /Developer ID/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package stays on local signing; release-macos is the distribution entry", async () => {
  const pack = await readFile(path.join(repoRoot, "scripts", "package-macos.mjs"), "utf8");
  const release = await readFile(path.join(repoRoot, "scripts", "release-macos.mjs"), "utf8");
  assert.match(pack, /signAppBundle\(/);
  assert.doesNotMatch(pack, /signAppBundleForDistribution/);
  assert.match(release, /releaseMacosApp/);
  assert.doesNotMatch(release, /notarytool/);
});
