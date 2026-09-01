import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const originalRoot = path.join(repositoryRoot, "research-archives", "original");

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function statOrNull(file) {
  try { return await lstat(file); } catch { return null; }
}

// The manifests are tracked here as documentation; the binaries they describe
// live in the private .stow archive (research-archives/README.md), so a clean
// checkout has the inventory without the payload. Manifest integrity is
// therefore always checked, and byte/digest verification runs only where the
// archive is actually present.
test("preserved release inventories describe their artifacts exactly", async () => {
  const versions = (await readdir(originalRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.ok(versions.includes("0.18.0"), "the 0.18.0 base release must stay inventoried");

  for (const version of versions) {
    const archiveRoot = path.join(originalRoot, version);
    const manifest = JSON.parse(await readFile(path.join(archiveRoot, "artifacts.json"), "utf8"));
    assert.deepEqual(Object.keys(manifest).sort(), ["artifacts", "product", "schemaVersion", "version"]);
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.product, "Grok Bot");
    assert.equal(manifest.version, version);
    assert.ok(manifest.artifacts.length > 0, `${version} must inventory at least one artifact`);

    for (const artifact of manifest.artifacts) {
      const keys = Object.keys(artifact).sort();
      // `provenance` is required exactly when there is no public source URL to
      // cite — 0.30 was lifted from an auto-updated install, not an installer.
      const expected = artifact.sourceUrl == null
        ? ["architecture", "bytes", "path", "platform", "provenance", "sha256", "sourceUrl"]
        : ["architecture", "bytes", "path", "platform", "sha256", "sourceUrl"];
      assert.deepEqual(keys.filter((key) => key !== "provenance" || expected.includes("provenance")), expected, `${version} ${artifact.path}`);
      assert.match(artifact.path, /^(macos-arm64|windows-x64)\/[^/]+\.(dmg|exe|asar)$/);
      assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
      assert.equal(Number.isInteger(artifact.bytes) && artifact.bytes > 0, true);
      if (artifact.sourceUrl != null) {
        assert.match(artifact.sourceUrl, /^https:\/\/downloads\.cursor\.com\/grokbot\/stable\//);
      } else {
        assert.equal(typeof artifact.provenance, "string");
        assert.ok(artifact.provenance.length > 0, `${version} ${artifact.path} needs provenance`);
      }

      const file = path.join(archiveRoot, artifact.path);
      assert.ok(file.startsWith(`${archiveRoot}${path.sep}`));
      const metadata = await statOrNull(file);
      if (metadata == null) continue; // binary lives in the .stow archive only
      // A checkout without `git lfs pull` leaves a ~130-byte pointer in place
      // of the artifact. That is "not materialised here", the same case as
      // absent, not a mismatch to fail on: CI restores the archive without LFS
      // because these are release DMGs worth hundreds of megabytes.
      if (metadata.size < 1024) {
        const head = await readFile(file, "utf8").catch(() => "");
        if (head.startsWith("version https://git-lfs.github.com/spec/v1")) continue;
      }
      assert.equal(metadata.isFile(), true);
      assert.equal(metadata.isSymbolicLink(), false);
      assert.equal(metadata.size, artifact.bytes, `${artifact.path} requires git lfs pull`);
      assert.equal(await sha256(file), artifact.sha256);
    }

    const sums = await readFile(path.join(archiveRoot, "SHA256SUMS"), "utf8");
    for (const artifact of manifest.artifacts) {
      assert.ok(
        sums.includes(`${artifact.sha256}  ${artifact.path}`),
        `${version} SHA256SUMS must agree with artifacts.json for ${artifact.path}`,
      );
    }
  }
});
