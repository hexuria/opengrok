import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";

import { createContext } from "../../packages/context/core.js";
import { pingBoxClassified } from "./box-remote-accessor.js";
import type { ErasedProductionBoxGeneratedPorts } from "./production.js";
import { DEFAULT_AUTH_TOKEN, EXEC_DAEMON_PORT } from "./loopback-sand-box.js";

export const BOX_EXEC_DAEMON_ENTRY_RELATIVE = "../box-exec-daemon/main.cjs";
export const BOX_EXEC_DAEMON_START_TIMEOUT_MS = 20_000;
export const BOX_EXEC_DAEMON_STOP_TIMEOUT_MS = 5_000;

export interface OwnedBoxExecDaemon {
  readonly pid: number;
  readonly entryPath: string;
  readonly ready: Promise<void>;
  close(): Promise<void>;
}

export interface BoxExecDaemonProcessOptions {
  readonly entryPath: string;
  readonly generated: ErasedProductionBoxGeneratedPorts;
  readonly host?: "127.0.0.1";
  readonly port?: number;
  readonly authToken?: string;
  readonly workspaceRoot: string;
  readonly terminalsDirectory: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly execPath?: string;
  readonly startTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly log?: Pick<Console, "log" | "error">;
}

export function resolveBoxExecDaemonEntry(hostEntry = process.argv[1]): string {
  if (hostEntry == null || hostEntry.length === 0) {
    throw new Error("cannot resolve box exec-daemon entry without a host process entry");
  }
  return path.resolve(path.dirname(hostEntry), BOX_EXEC_DAEMON_ENTRY_RELATIVE);
}

async function portAcceptsConnections(host: string, port: number): Promise<boolean> {
  return await new Promise(resolve => {
    const socket = createConnection({ host, port });
    const settle = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.setTimeout(300, () => settle(false));
  });
}

function childExit(child: ChildProcess): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  return new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, milliseconds));
}

export async function startBoxExecDaemonProcess(options: BoxExecDaemonProcessOptions): Promise<OwnedBoxExecDaemon> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? EXEC_DAEMON_PORT;
  const authToken = options.authToken ?? DEFAULT_AUTH_TOKEN;
  const log = options.log ?? console;
  if (await portAcceptsConnections(host, port)) {
    throw new Error(`refusing contaminated box exec-daemon startup: ${host}:${port} is already bound`);
  }
  await access(options.entryPath);
  await mkdir(options.workspaceRoot, { recursive: true });
  await mkdir(options.terminalsDirectory, { recursive: true });
  const child = spawn(options.execPath ?? process.execPath, [options.entryPath], {
    cwd: path.dirname(options.entryPath),
    env: {
      ...(options.env ?? process.env),
      SAND_BOX_EXEC_DAEMON_PORT: String(port),
      SAND_BOX_EXEC_DAEMON_AUTH_TOKEN: authToken,
      SAND_BOX_WORKSPACE_ROOT: options.workspaceRoot,
      SAND_BOX_TERMINALS_DIRECTORY: options.terminalsDirectory,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.pid === undefined) throw new Error("box exec-daemon child did not receive a pid");
  const exited = childExit(child);
  child.stdout?.on("data", chunk => log.log(`[box-exec-daemon] ${String(chunk).trimEnd()}`));
  child.stderr?.on("data", chunk => log.error(`[box-exec-daemon] ${String(chunk).trimEnd()}`));

  const ready = (async () => {
    const deadline = Date.now() + (options.startTimeoutMs ?? BOX_EXEC_DAEMON_START_TIMEOUT_MS);
    while (Date.now() < deadline) {
      const result = await Promise.race([
        pingBoxClassified(createContext(), { host, port, authToken }, options.generated, 500),
        exited.then(status => { throw new Error(`box exec-daemon exited before readiness: ${JSON.stringify(status)}`); }),
      ]);
      if (result.outcome === "ok") return;
      await delay(100);
    }
    throw new Error(`box exec-daemon did not answer authenticated generated Ping at ${host}:${port}`);
  })();

  try {
    await ready;
  } catch (error) {
    child.kill("SIGTERM");
    await exited;
    throw error;
  }

  let closed = false;
  return {
    pid: child.pid,
    entryPath: options.entryPath,
    ready,
    async close() {
      if (closed) return;
      closed = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      const stopped = await Promise.race([
        exited.then(() => true),
        delay(options.stopTimeoutMs ?? BOX_EXEC_DAEMON_STOP_TIMEOUT_MS).then(() => false),
      ]);
      if (!stopped) {
        child.kill("SIGKILL");
        await exited;
        throw new Error(`box exec-daemon pid ${child.pid} required forced shutdown`);
      }
      if (await portAcceptsConnections(host, port)) {
        throw new Error(`box exec-daemon shutdown left ${host}:${port} bound`);
      }
    },
  };
}
