import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AD_HOC_CODESIGN_IDENTITY,
  CODESIGN_IDENTITY_ENV,
  ELECTRON_ENTITLEMENTS_PATH,
  LOCAL_CODESIGN_OPTIONS,
  codesignArguments,
  compareSignTargetDepth,
  distributionCodesignArguments,
  listNestedDistributionSignTargets,
  parseSigningIdentities,
  pickCodesignIdentity,
  resolveCodesignIdentity,
  signAppBundle,
  signAppBundleForDistribution,
} from "../scripts/lib/codesign.mjs";

const SECURITY_OUTPUT = `
  1) 1111111111111111111111111111111111111111 "Developer ID Application: Example Dev (TEAMID1234)"
  2) 2222222222222222222222222222222222222222 "Apple Development: Example Dev (TEAMID5678)"
  3) 3333333333333333333333333333333333333333 "Apple Distribution: Example Corp (TEAMID1234)"
     3 valid identities found
`;

test("a Developer ID is preferred so privacy grants survive a rebuild", async () => {
  const identities = parseSigningIdentities(SECURITY_OUTPUT);
  assert.equal(identities.length, 3);
  assert.equal(identities[0].hash, "1111111111111111111111111111111111111111");

  // Ad-hoc signing gives a designated requirement of a bare cdhash, which
  // changes every build and takes Full Disk Access with it. Developer ID keys
  // the requirement to the team, so it survives. Apple Development is only a
  // fallback: it expires in a year and the grant lapses with it.
  assert.match(pickCodesignIdentity(identities), /^Developer ID Application:/);
  assert.match(
    pickCodesignIdentity(parseSigningIdentities(`  1) ${"A".repeat(40)} "Apple Development: Someone (TEAM)"`)),
    /^Apple Development:/,
  );
  assert.equal(pickCodesignIdentity([]), undefined);

  // A machine with no certificate must still be able to package.
  assert.equal(
    await resolveCodesignIdentity({ env: {}, listIdentities: async () => "     0 valid identities found" }),
    AD_HOC_CODESIGN_IDENTITY,
  );
  assert.equal(
    await resolveCodesignIdentity({ env: {}, listIdentities: async () => { throw new Error("no security tool"); } }),
    AD_HOC_CODESIGN_IDENTITY,
  );

  // An explicit choice always wins, so a build can be pinned or forced ad-hoc.
  assert.equal(
    await resolveCodesignIdentity({ env: { [CODESIGN_IDENTITY_ENV]: "-" }, listIdentities: async () => SECURITY_OUTPUT }),
    "-",
  );
  assert.equal(
    await resolveCodesignIdentity({ env: {}, listIdentities: async () => SECURITY_OUTPUT }),
    "Developer ID Application: Example Dev (TEAMID1234)",
  );
});

test("signing passes the resolved identity through to codesign", async () => {
  const calls = [];
  const identity = await signAppBundle(
    "/Applications/Example.app",
    async (command, args) => { calls.push({ command, args }); },
    { env: {}, listIdentities: async () => SECURITY_OUTPUT },
  );
  assert.equal(identity, "Developer ID Application: Example Dev (TEAMID1234)");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/usr/bin/codesign");
  assert.deepEqual(calls[0].args, [
    "--force",
    "--deep",
    "--timestamp=none",
    "--sign",
    "Developer ID Application: Example Dev (TEAMID1234)",
    "/Applications/Example.app",
  ]);
  assert.deepEqual(
    codesignArguments("/Applications/Example.app", "Developer ID Application: Example Dev (TEAMID1234)", LOCAL_CODESIGN_OPTIONS),
    calls[0].args,
  );

  const ignored = [];
  await signAppBundle(
    "/Applications/Example.app",
    async (_command, args) => { ignored.push(args); },
    {
      identity: "Developer ID Application: Example Dev (TEAMID1234)",
      timestamp: true,
      hardenedRuntime: true,
      entitlements: ELECTRON_ENTITLEMENTS_PATH,
    },
  );
  assert.deepEqual(ignored[0], calls[0].args);

  // Packaging must never sign an unspecified target.
  assert.throws(() => codesignArguments(""), /application bundle path/);
  assert.throws(() => codesignArguments(undefined), /application bundle path/);
});

test("distribution signing uses a timestamp, hardened runtime, and Electron entitlements", async () => {
  const identityName = "Developer ID Application: Example Dev (TEAMID1234)";
  assert.deepEqual(
    distributionCodesignArguments("/Applications/Example.app", identityName),
    [
      "--force",
      "--timestamp",
      "--options",
      "runtime",
      "--entitlements",
      ELECTRON_ENTITLEMENTS_PATH,
      "--sign",
      identityName,
      "/Applications/Example.app",
    ],
  );
  assert.equal(distributionCodesignArguments("/Applications/Example.app", identityName).includes("--deep"), false);
  assert.throws(
    () => distributionCodesignArguments("/Applications/Example.app", AD_HOC_CODESIGN_IDENTITY),
    /Developer ID Application/,
  );
  assert.throws(
    () => distributionCodesignArguments("/Applications/Example.app", ""),
    /Developer ID Application/,
  );
  assert.throws(
    () => distributionCodesignArguments("/Applications/Example.app", "Apple Development: Example Dev (TEAMID5678)"),
    /Developer ID Application/,
  );

  const calls = [];
  const identity = await signAppBundleForDistribution(
    "/Applications/Example.app",
    async (command, args) => { calls.push({ command, args }); },
    { env: {}, listIdentities: async () => SECURITY_OUTPUT, listNestedTargets: async () => [] },
  );
  assert.equal(identity, identityName);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/usr/bin/codesign");
  assert.deepEqual(calls[0].args, distributionCodesignArguments("/Applications/Example.app", identityName));
  assert.equal(calls[0].args.includes("--timestamp=none"), false);

  await assert.rejects(
    () => signAppBundleForDistribution(
      "/Applications/Example.app",
      async () => {},
      {
        env: {},
        listIdentities: async () => `  1) ${"A".repeat(40)} "Apple Development: Example Dev (TEAMID5678)"\n     1 valid identities found\n`,
        listNestedTargets: async () => [],
      },
    ),
    /Developer ID Application/,
  );

  const entitlements = await readFile(ELECTRON_ENTITLEMENTS_PATH, "utf8");
  assert.match(entitlements, /com\.apple\.security\.cs\.allow-jit/);
  assert.match(entitlements, /com\.apple\.security\.cs\.allow-unsigned-executable-memory/);
  assert.match(entitlements, /com\.apple\.security\.cs\.disable-library-validation/);
  assert.match(entitlements, /com\.apple\.security\.automation\.apple-events/);
  assert.doesNotMatch(entitlements, /com\.apple\.security\.app-sandbox/);
  assert.doesNotMatch(entitlements, /allow-dyld-environment-variables/);
});

test("distribution signing signs nested helpers inside-out without --deep", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opengrok-codesign-nested-"));
  const appPath = path.join(root, "Open Grok.app");
  const helper = path.join(appPath, "Contents", "Frameworks", "Grok Bot Helper.app");
  const framework = path.join(appPath, "Contents", "Frameworks", "Electron Framework.framework");
  const dylib = path.join(framework, "Versions", "A", "Libraries", "libffmpeg.dylib");
  const crashpad = path.join(appPath, "Contents", "Frameworks", "chrome_crashpad_handler");
  await mkdir(helper, { recursive: true });
  await mkdir(path.dirname(dylib), { recursive: true });
  await writeFile(dylib, "");
  await writeFile(crashpad, Buffer.from([0xfe, 0xed, 0xfa, 0xcf, 0, 0, 0, 0]));
  try {
    const nested = await listNestedDistributionSignTargets(appPath);
    assert.deepEqual(nested, [dylib, framework, crashpad, helper].sort(compareSignTargetDepth));
    assert.ok(nested.indexOf(dylib) < nested.indexOf(framework));
    assert.equal(nested.includes(appPath), false);

    const calls = [];
    const identityName = "Developer ID Application: Example Dev (TEAMID1234)";
    await signAppBundleForDistribution(
      appPath,
      async (_command, args) => { calls.push(args); },
      { identity: identityName },
    );
    const targets = calls.map((args) => args.at(-1));
    assert.deepEqual(targets.slice(0, -1), nested);
    assert.equal(targets.at(-1), appPath);
    for (const args of calls) {
      assert.equal(args.includes("--deep"), false);
      assert.ok(args.includes("--timestamp"));
      assert.ok(args.includes("runtime"));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
