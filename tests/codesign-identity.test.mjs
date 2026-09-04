import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AD_HOC_CODESIGN_IDENTITY,
  CODESIGN_IDENTITY_ENV,
  ELECTRON_ENTITLEMENTS_PATH,
  codesignArguments,
  distributionCodesignArguments,
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
      "--deep",
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
  assert.throws(
    () => distributionCodesignArguments("/Applications/Example.app", AD_HOC_CODESIGN_IDENTITY),
    /Developer ID/,
  );
  assert.throws(
    () => distributionCodesignArguments("/Applications/Example.app", ""),
    /Developer ID/,
  );

  const calls = [];
  const identity = await signAppBundleForDistribution(
    "/Applications/Example.app",
    async (command, args) => { calls.push({ command, args }); },
    { env: {}, listIdentities: async () => SECURITY_OUTPUT },
  );
  assert.equal(identity, identityName);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/usr/bin/codesign");
  assert.deepEqual(calls[0].args, distributionCodesignArguments("/Applications/Example.app", identityName));
  assert.equal(calls[0].args.includes("--timestamp=none"), false);

  const entitlements = await readFile(ELECTRON_ENTITLEMENTS_PATH, "utf8");
  assert.match(entitlements, /com\.apple\.security\.cs\.allow-jit/);
  assert.match(entitlements, /com\.apple\.security\.cs\.allow-unsigned-executable-memory/);
  assert.match(entitlements, /com\.apple\.security\.cs\.disable-library-validation/);
  assert.doesNotMatch(entitlements, /com\.apple\.security\.app-sandbox/);
});
