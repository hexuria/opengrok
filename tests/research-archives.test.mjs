import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
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

test("preserved release inventories describe their artifacts exactly", {
  skip: existsSync(originalRoot) ? false : "research-archives/ is restored from stow; skip when absent",
}, async () => {
  const versions = (await readdir(originalRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

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
      const expected = artifact.sourceUrl == null
        ? ["architecture", "bytes", "path", "platform", "provenance", "sha256", "sourceUrl"]
        : ["architecture", "bytes", "path", "platform", "sha256", "sourceUrl"];
      assert.deepEqual(keys.filter((key) => key !== "provenance" || expected.includes("provenance")), expected, `${version} ${artifact.path}`);
      assert.match(artifact.path, /^(macos-arm64|windows-x64)\/[^/]+\.(dmg|exe|asar)$/);
      assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
      assert.equal(Number.isInteger(artifact.bytes) && artifact.bytes > 0, true);
      if (artifact.sourceUrl != null) {
        assert.match(artifact.sourceUrl, /^https:\/\//);
      } else {
        assert.equal(typeof artifact.provenance, "string");
        assert.ok(artifact.provenance.length > 0, `${version} ${artifact.path} needs provenance`);
      }

      const file = path.join(archiveRoot, artifact.path);
      assert.ok(file.startsWith(`${archiveRoot}${path.sep}`));
      const metadata = await statOrNull(file);
      if (metadata == null) continue;
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
