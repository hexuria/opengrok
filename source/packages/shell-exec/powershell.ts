import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";

import { createSpan, reportEvent } from "../context/otel.js";
import type { Context } from "../context/core.js";
import { createWritableIterable } from "../utils/writable-iterable.js";
import { attachShellOutputStreams } from "./output-limiter.js";
import { getPowerShellExecutable } from "./platform-shell.js";
import { resolveSandboxPolicyForWorkspace } from "./sandbox/policy-merge.js";
import { shouldEnableSudoAskpass, transformSudoCommand } from "./sudo.js";
import { SHELL_ENV_OVERRIDES } from "./types.js";
import { splitPwdAndState, createShellExitEvent } from "./core.js";
import { spawnWithSignal } from "./core.js";
import type { SandboxExecutionPolicy } from "./sandbox/sandbox.js";
import {
  type TerminalEvent,
  type TerminalExecuteOptions,
} from "./naive.js";
import dumpPowerShellState from "./dump_powershell_state.js";

type SandboxPolicySources = NonNullable<Parameters<typeof resolveSandboxPolicyForWorkspace>[1]>;
type OutputLimiterOptions = Parameters<typeof attachShellOutputStreams>[0]["outputLimiterOptions"];
type PowerShellExecuteOptions = Omit<TerminalExecuteOptions, "sandboxPolicy" | "outputLimiterOptions"> & {
  readonly sandboxPolicy?: SandboxPolicySources;
  readonly outputLimiterOptions?: OutputLimiterOptions;
  readonly closeTimeout?: number;
};
type SpawnWithSignal = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
  sandboxPolicy: SandboxExecutionPolicy,
  signal?: AbortSignal,
) => ChildProcess;

let spawnWithSignalBinding: SpawnWithSignal = spawnWithSignal;

function requireSpawnWithSignal(): SpawnWithSignal {
  return spawnWithSignalBinding;
}

const UTF8_BOM = "\uFEFF";

async function writeFileWithBom(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, UTF8_BOM + content, { encoding: "utf8" });
}

export async function initPowerShellState(): Promise<PowerShellState> {
  return new PowerShellState(process.cwd(), "");
}

class PowerShellState {
  constructor(private cwd: string, private state: string) {}

  async getCwd(): Promise<string> {
    return this.cwd;
  }

  clone(workingDirectory?: string): PowerShellState {
    return new PowerShellState(workingDirectory ?? this.cwd, this.state);
  }

  async *execute(ctx: Context, command: string, options?: PowerShellExecuteOptions): AsyncIterable<TerminalEvent> {
    using span = createSpan(ctx.withName("PowerShellState.execute"));
    const pipeStdin = options?.pipeStdin ?? false;
    const cwd = options?.workingDirectory ?? this.cwd;
    const iterable = createWritableIterable<TerminalEvent>();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...SHELL_ENV_OVERRIDES,
      ...options?.env,
    };
    const transformedCommand = shouldEnableSudoAskpass(env) ? transformSudoCommand(command) : command;
    const tempDir = tmpdir();
    const stateOutFile = join(tempDir, `ps-state-out-${randomUUID()}.txt`);
    const commandScript = dumpPowerShellState(this.state, cwd, transformedCommand, stateOutFile);
    const scriptFile = join(tempDir, `ps-script-${randomUUID()}.ps1`);
    await writeFileWithBom(scriptFile, commandScript);
    const args = ["-ExecutionPolicy", "Bypass"];
    if (!pipeStdin) args.push("-NonInteractive");
    args.push("-File", scriptFile);
    const pwsh = getPowerShellExecutable();
    const isWindows = process.platform === "win32";
    const sandboxWorkspaceRoot = options?.sandboxWorkspaceRoot ?? cwd;
    const resolvedPolicy = (await resolveSandboxPolicyForWorkspace(sandboxWorkspaceRoot, options?.sandboxPolicy)).policy;
    const sandboxPolicy = resolvedPolicy.type !== "insecure_none" ? { ...resolvedPolicy, sandboxWorkspaceRoot } : resolvedPolicy;
    const child = requireSpawnWithSignal()(pwsh, args, {
      env,
      stdio: [pipeStdin ? "pipe" : "ignore", "pipe", "pipe"],
      cwd,
      detached: !isWindows,
    }, sandboxPolicy, options?.signal);
    child.on("spawn", async () => {
      try {
        await iterable.write({ type: "stdin_ready", stdin: child.stdin ?? undefined, pid: child.pid });
      } catch {
        // The consumer may have closed the iterable before spawn was observed.
      }
    });
    const outputPump = attachShellOutputStreams({
      stdout: child.stdout,
      stderr: child.stderr,
      writable: iterable,
      bufferOutputEvents: options?.bufferOutputEvents,
      outputLimiterOptions: options?.outputLimiterOptions,
    });
    const cleanup = async (): Promise<void> => {
      try {
        const newState = await readFile(stateOutFile, "utf8");
        const { cwd: newCwd, rest } = splitPwdAndState(newState);
        this.state = rest;
        this.cwd = newCwd.trim();
        await rm(stateOutFile).catch(() => {});
      } catch {
        // PowerShell may terminate before writing a state snapshot.
      }
      await rm(scriptFile).catch(() => {});
    };
    let exitCode: number | null = null;
    let closeTimeoutId: ReturnType<typeof setTimeout> | null = null;
    let hasEmittedExit = false;
    const emitExitAndClose = async (waitForOutputPumps: boolean): Promise<void> => {
      if (hasEmittedExit) return;
      hasEmittedExit = true;
      if (closeTimeoutId !== null) {
        clearTimeout(closeTimeoutId);
        closeTimeoutId = null;
      }
      reportEvent(span.ctx, "exit");
      if (waitForOutputPumps) {
        try {
          await outputPump.waitForOutput();
        } catch (error) {
          await cleanup();
          iterable.throw(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
      await outputPump.flush();
      try {
        await iterable.write(createShellExitEvent(exitCode, options?.signal?.aborted ?? false));
        await cleanup();
        iterable.close();
      } catch {
        iterable.close();
      }
    };
    child.on("exit", (code) => {
      exitCode = code;
      const timeout = options?.closeTimeout ?? 5_000;
      if (timeout > 0) {
        closeTimeoutId = setTimeout(() => {
          console.warn(`[shell-exec] Close event did not fire within ${timeout}ms after exit. This may indicate a background process is holding file descriptors open. Proceeding anyway to prevent hang.`);
          void emitExitAndClose(false);
        }, timeout);
      }
    });
    child.on("close", () => {
      void emitExitAndClose(true);
    });
    child.on("error", (error) => {
      void cleanup().catch(() => {});
      iterable.throw(error);
    });
    yield* iterable;
  }
}

void initPowerShellState;
