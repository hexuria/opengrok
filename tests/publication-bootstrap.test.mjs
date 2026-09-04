import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const bindingsManifestPath = path.join(
  repositoryRoot,
  "manifests/reconstruction/electron-main-production-bindings-manifest.json",
);

test("checked-in production bindings resolve only to reviewed source", {
  skip: existsSync(bindingsManifestPath) ? false : "manifests/ is restored from stow; skip when absent",
}, async () => {
  const manifestPath = bindingsManifestPath;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.ok(manifest.bindings.length > 0);
  for (const binding of manifest.bindings) {
    assert.match(binding.module, /^\.\.\/\.\.\/source\//);
    const resolved = path.resolve(path.dirname(manifestPath), binding.module);
    assert.ok(resolved.startsWith(`${path.join(repositoryRoot, "source")}${path.sep}`));
    await access(resolved);
  }
});

test("the public tree has no Cursor grokbot CDN URL", async () => {
  const needle = ["downloads.cursor.com", "grokbot"].join("/");
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("git", ["grep", "-n", "-F", needle, "--", "."], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }));
  } catch (error) {
    if (error?.code === 1) {
      assert.equal(String(error.stdout ?? "").trim(), "");
      return;
    }
    throw error;
  }
  assert.equal(stdout.trim(), "", "tracked files must not mention the vendor grokbot CDN");
});
