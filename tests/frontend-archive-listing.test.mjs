import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load(entry) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-archive-"));
  const outfile = path.join(temporary, "module.mjs");
  await build({ entryPoints: [path.join(repoRoot, entry)], outfile, bundle: true, format: "esm", platform: "node", loader: { ".css": "empty" }, jsx: "automatic", define: { "process.env.NODE_ENV": "\"test\"", "import.meta.env": "{}" } });
  const loaded = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

// The archive reader lists zip, tar and gzip members without inflating anything but the gzip wrapper —
// the way a desktop file manager peeks inside. Built with the system zip/tar so the fixtures are real.
test("zip, tar.gz and .gz archives list their members with sizes", async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), "grok-archive-fixture-"));
  const { loaded, cleanup } = await load("frontend/src/recovered/features/conversation/workspace/file-viewer.tsx");
  try {
    await mkdir(path.join(work, "src/deep"), { recursive: true });
    await writeFile(path.join(work, "src/main.rs"), "fn main() {}\n");
    await writeFile(path.join(work, "src/deep/notes.md"), "# hi\n".repeat(300));
    await writeFile(path.join(work, "README.md"), "read me\n");
    execFileSync("zip", ["-q", "-r", "bundle.zip", "src", "README.md"], { cwd: work });
    execFileSync("tar", ["-czf", "bundle.tar.gz", "src", "README.md"], { cwd: work });
    execFileSync("gzip", ["-k", "README.md"], { cwd: work });
    const zip = await loaded.listArchiveEntries("bundle.zip", new Uint8Array(await readFile(path.join(work, "bundle.zip"))));
    // macOS zip/tar add AppleDouble "._" sidecars for extended attributes; they are real members, just not ours to assert on.
    const ours = (entry) => !entry.directory && !/(^|\/)\._/u.test(entry.path);
    const zipFiles = zip.filter(ours).map((entry) => [entry.path, entry.size]).sort();
    assert.deepEqual(zipFiles, [["README.md", 8], ["src/deep/notes.md", 1500], ["src/main.rs", 13]]);
    assert.ok(zip.some((entry) => entry.directory && entry.path === "src/"));
    assert.ok(zip.every((entry) => entry.directory || entry.modifiedMs != null));
    const tgz = await loaded.listArchiveEntries("bundle.tar.gz", new Uint8Array(await readFile(path.join(work, "bundle.tar.gz"))));
    const tgzFiles = tgz.filter(ours).map((entry) => [entry.path, entry.size]).sort();
    assert.deepEqual(tgzFiles, [["README.md", 8], ["src/deep/notes.md", 1500], ["src/main.rs", 13]]);
    const gz = await loaded.listArchiveEntries("README.md.gz", new Uint8Array(await readFile(path.join(work, "README.md.gz"))));
    assert.deepEqual(gz, [{ path: "README.md", size: 8, modifiedMs: null, directory: false }]);
    assert.equal(await loaded.listArchiveEntries("thing.7z", new Uint8Array([1, 2, 3])), null);
    assert.equal(loaded.listZipEntries(new Uint8Array(40)), null);
  } finally {
    await cleanup();
    await rm(work, { recursive: true, force: true });
  }
});
