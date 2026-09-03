import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = async () => import(pathToFileURL(path.join(repoRoot, "source/shared/node/atomic-write.ts")).href);

test("atomic write replaces an existing file", async () => {
  const { writeFileAtomic } = await load();
  const directory = await mkdtemp(path.join(tmpdir(), "opengrok-atomic-"));
  const target = path.join(directory, "store.json");
  await writeFile(target, "old\n");
  await writeFileAtomic(target, "new\n", { mode: 0o600 });
  assert.equal(await readFile(target, "utf8"), "new\n");
});

test("atomic write can replace the same file many times in a row", async () => {
  const { writeFileAtomic } = await load();
  const directory = await mkdtemp(path.join(tmpdir(), "opengrok-atomic-loop-"));
  const target = path.join(directory, "store.json");
  for (let index = 0; index < 20; index += 1) {
    await writeFileAtomic(target, `v${index}\n`, { mode: 0o600 });
  }
  assert.equal(await readFile(target, "utf8"), "v19\n");
});
