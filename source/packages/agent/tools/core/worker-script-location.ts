import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Exact retained export from ../packages/agent/dist/tools/core/worker-script-location.js.
// Mac/Windows host region 575897–575918 is byte-identical (SHA-256
// a26fe2c42ff66264a8a7a180f2bd85d8972a984fb2c025eb3b8f3d35b84751fe).
export function resolveWorkerLocation(moduleUrl: string, representativeWorker: string): {
  dir: string;
  extension: "ts" | "js";
} {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  if (fs.existsSync(path.join(moduleDir, `${representativeWorker}.ts`))) {
    return { dir: moduleDir, extension: "ts" };
  }
  if (fs.existsSync(path.join(moduleDir, `${representativeWorker}.js`))) {
    return { dir: moduleDir, extension: "js" };
  }
  const entry = process.argv[1];
  if (entry) {
    const entryDir = path.dirname(entry);
    if (fs.existsSync(path.join(entryDir, `${representativeWorker}.js`))) {
      return { dir: entryDir, extension: "js" };
    }
  }
  return { dir: moduleDir, extension: "js" };
}
