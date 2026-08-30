import { runBoxExecDaemonEntrypoint } from "./main.js";

void runBoxExecDaemonEntrypoint().catch(error => {
  process.stderr.write(`box-exec-daemon: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
