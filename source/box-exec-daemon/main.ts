import path from "node:path";

import { startBoxExecDaemon } from "./server.js";

export async function runBoxExecDaemonEntrypoint(): Promise<void> {
  const workspaceRoot = path.resolve(process.env.SAND_BOX_WORKSPACE_ROOT ?? process.cwd());
  const portText = process.env.SAND_BOX_EXEC_DAEMON_PORT;
  const handle = await startBoxExecDaemon({
    workspaceRoot,
    ...(portText == null ? {} : { port: Number.parseInt(portText, 10) }),
    ...(process.env.SAND_BOX_TERMINALS_DIRECTORY == null ? {} : { terminalsDirectory: process.env.SAND_BOX_TERMINALS_DIRECTORY }),
    ...(process.env.SAND_BOX_EXEC_DAEMON_AUTH_TOKEN == null ? {} : { authToken: process.env.SAND_BOX_EXEC_DAEMON_AUTH_TOKEN }),
  });
  process.stdout.write(`${JSON.stringify({ event: "box-exec-daemon-ready", url: handle.url, workspaceRoot: handle.workspaceRoot, terminalsDirectory: handle.terminalsDirectory })}\n`);
  const shutdown = async () => {
    await handle.stop();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
}
