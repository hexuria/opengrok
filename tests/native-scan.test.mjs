import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("createNativeProcessScan(null) returns no processes", async () => {
  const { createNativeProcessScan } = await import(
    pathToFileURL(path.join(repoRoot, "source/electron-main/process-metrics/native-scan.ts")).href
  );
  const scan = createNativeProcessScan(null);
  assert.deepEqual(await scan([1, 2, 3]), []);
  assert.deepEqual(await scan([]), []);
});
