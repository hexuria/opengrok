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
  const appPath = path.join("/tmp", "Open Grok.app");
  const zipPath = distributionZipPath(appPath);
  assert.equal(zipPath, path.join(path.dirname(appPath), "Open Grok.zip"));
  assert.deepEqual(dittoZipArguments(appPath, zipPath), ["-c", "-k", "--keepParent", appPath, zipPath]);
  assert.throws(() => dittoZipArguments("", zipPath), /application bundle path/);
  assert.throws(() => dittoZipArguments(appPath, ""), /zip destination path/);
  assert.throws(() => distributionZipPath(path.join("/tmp", "Open Grok")), /\.app/);

  assert.equal(shouldNotarize({}), false);
  assert.equal(shouldNotarize({ SAND_NOTARIZE: "0" }), false);
  assert.equal(shouldNotarize({ SAND_NOTARY_KEYCHAIN_PROFILE: "AC_PASSWORD" }), false);
  assert.equal(shouldNotarize({ SAND_NOTARIZE: "1" }), true);
  assert.equal(resolveNotaryCredentials({}), null);
  assert.deepEqual(
    resolveNotaryCredentials({ SAND_NOTARIZE: "1", SAND_NOTARY_KEYCHAIN_PROFILE: "AC_PASSWORD" }),
    { type: "keychain-profile", profile: "AC_PASSWORD" },
  );
  const apiKeyPath = path.join("/tmp", "AuthKey.p8");
  assert.deepEqual(
    resolveNotaryCredentials({
      SAND_NOTARIZE: "true",
      SAND_NOTARY_API_KEY_PATH: apiKeyPath,
      SAND_NOTARY_API_KEY_ID: "KEYID",
      SAND_NOTARY_ISSUER: "ISSUER",
    }),
    { type: "api-key", key: apiKeyPath, keyId: "KEYID", issuer: "ISSUER" },
  );
  assert.throws(
    () => resolveNotaryCredentials({ SAND_NOTARIZE: "1" }),
    /SAND_NOTARY_KEYCHAIN_PROFILE/,
  );
  assert.throws(
    () => resolveNotaryCredentials({
      SAND_NOTARIZE: "1",
      SAND_NOTARY_API_KEY_PATH: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
      SAND_NOTARY_API_KEY_ID: "KEYID",
      SAND_NOTARY_ISSUER: "ISSUER",
    }),
    /path to a \.p8 file/,
  );
  const zipForNotary = path.join("/tmp", "Open Grok.zip");
  assert.deepEqual(
    notarytoolSubmitArguments(zipForNotary, { type: "keychain-profile", profile: "AC_PASSWORD" }),
    ["notarytool", "submit", zipForNotary, "--wait", "--keychain-profile", "AC_PASSWORD"],
  );
  assert.deepEqual(
    notarytoolSubmitArguments(zipForNotary, { type: "api-key", key: apiKeyPath, keyId: "KEYID", issuer: "ISSUER" }),
    ["notarytool", "submit", zipForNotary, "--wait", "--key", apiKeyPath, "--key-id", "KEYID", "--issuer", "ISSUER"],
  );
  assert.deepEqual(
    staplerStapleArguments(appPath),
    ["stapler", "staple", appPath],
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

test("release-macos submits notarytool with a .p8 path, not key contents", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opengrok-macos-notary-key-"));
  const appPath = path.join(root, "Open Grok.app");
  const keyPath = path.join(root, "AuthKey.p8");
  await mkdir(appPath);
  const calls = [];
  try {
    const result = await releaseMacosApp({
      appPath,
      env: {
        SAND_NOTARIZE: "1",
        SAND_NOTARY_API_KEY_PATH: keyPath,
        SAND_NOTARY_API_KEY_ID: "KEYID",
        SAND_NOTARY_ISSUER: "ISSUER",
      },
      listIdentities: async () => SECURITY_OUTPUT,
      runCommand: async (command, args) => { calls.push({ command, args }); },
    });
    assert.equal(result.notarized, true);
    assert.deepEqual(
      calls.find((call) => call.args?.[0] === "notarytool")?.args,
      ["notarytool", "submit", result.zipPath, "--wait", "--key", keyPath, "--key-id", "KEYID", "--issuer", "ISSUER"],
    );
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
      /Developer ID Application/,
    );
    await assert.rejects(
      () => releaseMacosApp({
        appPath,
        env: { SAND_CODESIGN_IDENTITY: "Apple Development: Example Dev (TEAMID5678)" },
        runCommand,
      }),
      /Developer ID Application/,
    );
    await assert.rejects(
      () => releaseMacosApp({
        appPath,
        env: { SAND_CODESIGN_IDENTITY: "2".repeat(40) },
        listIdentities: async () => SECURITY_OUTPUT,
        runCommand,
      }),
      /Developer ID Application/,
    );
    const hashResult = await releaseMacosApp({
      appPath,
      env: { SAND_CODESIGN_IDENTITY: "1".repeat(40) },
      listIdentities: async () => SECURITY_OUTPUT,
      runCommand,
    });
    assert.equal(hashResult.identity, "1".repeat(40));
    assert.equal(calls.at(-3)?.args.at(-2), "1".repeat(40));
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
