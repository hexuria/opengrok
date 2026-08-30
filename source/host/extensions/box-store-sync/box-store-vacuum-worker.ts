import { parentPort } from "node:worker_threads";
import { invariant } from "../../../shared/invariant.js";
import { sqliteVacuumInto } from "./sqlite-snapshot.js";

const port = parentPort;
invariant(port != null, "box-store-vacuum-worker must run as a worker_thread");
port.on("message", (job: { srcPath: string; destPath: string; busyTimeoutMs: number }) => {
  try {
    sqliteVacuumInto(job.srcPath, job.destPath, job.busyTimeoutMs);
    port.postMessage({ ok: true });
  } catch (error) {
    port.postMessage({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
