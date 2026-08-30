import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

import { createSpan, reportEvent } from "../context/otel.js";
import type { Context } from "../context/core.js";
import { createWritableIterable } from "../utils/writable-iterable.js";
import { attachShellOutputStreams } from "./output-limiter.js";
import { getBashPath, windowsPathToGitBash } from "./platform-shell.js";
import { getSudoAliasInjection } from "./sudo.js";
import { SHELL_ENV_OVERRIDES } from "./types.js";
import { resolveSandboxPolicyForWorkspace } from "./sandbox/policy-merge.js";
import { captureSandboxDenies } from "./sandbox/macos/seatbelt.js";
import { BASH_STATE_END_MARKER, BASH_STATE_START_MARKER, default as dumpBashState } from "./dump_bash_state.js";
import {
  attachShellStateOutput,
  createShellExitEvent,
  parseShellStateOutput,
  splitPwdAndState,
  writeShellStatePipe,
} from "./core.js";
import { spawnWithSignal } from "./core.js";
import type { SandboxExecutionPolicy } from "./sandbox/sandbox.js";
import {
  type TerminalEvent,
  type TerminalExecuteOptions,
} from "./naive.js";

type SandboxPolicySources = NonNullable<Parameters<typeof resolveSandboxPolicyForWorkspace>[1]>;
type OutputLimiterOptions = Parameters<typeof attachShellOutputStreams>[0]["outputLimiterOptions"];
type BashExecuteOptions = Omit<TerminalExecuteOptions, "sandboxPolicy" | "outputLimiterOptions"> & {
  readonly sandboxPolicy?: SandboxPolicySources;
  readonly outputLimiterOptions?: OutputLimiterOptions;
  readonly closeTimeout?: number;
};
type BashInitOptions = Pick<BashExecuteOptions, "env" | "signal"> & {
  readonly userTerminalHint?: string;
};
type SpawnWithSignal = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
  sandboxPolicy: SandboxExecutionPolicy,
  signal?: AbortSignal,
) => ChildProcess;

let spawnWithSignalBinding: SpawnWithSignal = spawnWithSignal;
const isMacOS = process.platform === "darwin";

function requireSpawnWithSignal(): SpawnWithSignal {
  return spawnWithSignalBinding;
}

async function captureSandboxDenies2(child: ChildProcess): Promise<readonly unknown[]> {
  return isMacOS ? captureSandboxDenies(child) : [];
}

export async function initBashState(options?: BashInitOptions): Promise<BashState> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...SHELL_ENV_OVERRIDES,
    ...options?.env,
  };
  const stateMarker = "__CURSOR_STATE_MARKER__";
  const args = [
    "-O",
    "extglob",
    "-ilc",
    `${dumpBashState} builtin printf '${stateMarker}\\n'; dump_bash_state`,
  ];
  const bashPath = getBashPath(options?.userTerminalHint);
  if (!bashPath) throw new Error("Can't find Bash");
  const child = requireSpawnWithSignal()(bashPath, args, {
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  }, { type: "insecure_none" }, options?.signal);
  let fullOutput = "";
  child.stdout?.on("data", (data: Buffer | string) => {
    fullOutput += data.toString();
  });
  child.on("error", (error) => {
    console.warn(`[shell-exec] bash state init spawn failed; falling back to empty state: ${error instanceof Error ? error.message : String(error)}`);
  });
  await new Promise<void>((resolve) => {
    child.on("close", () => resolve());
  });
  const snapshot = parseShellStateOutput(fullOutput, stateMarker);
  const startMarkerLine = `${BASH_STATE_START_MARKER}\n`;
  const endMarkerLine = `${BASH_STATE_END_MARKER}\n`;
  let stateWithoutMarkers: string;
  if (snapshot.startsWith(startMarkerLine) && snapshot.endsWith(endMarkerLine)) {
    stateWithoutMarkers = snapshot.slice(startMarkerLine.length);
    stateWithoutMarkers = stateWithoutMarkers.slice(0, -(BASH_STATE_END_MARKER.length + 1));
  } else {
    stateWithoutMarkers = `${process.cwd()}\n`;
  }
  const { cwd, rest } = splitPwdAndState(stateWithoutMarkers);
  const useFileStateTransport = process.platform === "win32";
  const initialCwd = process.platform === "win32" ? process.cwd() : cwd;
  return new BashState(initialCwd, rest, options?.userTerminalHint, useFileStateTransport);
}

class BashState {
  constructor(
    private cwd: string,
    private state: string,
    private readonly userTerminalHint?: string,
    private readonly useFileStateTransport = false,
  ) {}

  async getCwd(): Promise<string> {
    return this.cwd;
  }

  clone(workingDirectory?: string): BashState {
    return new BashState(workingDirectory ?? this.cwd, this.state, this.userTerminalHint, this.useFileStateTransport);
  }

  async *execute(ctx: Context, command: string, options: BashExecuteOptions = {}): AsyncIterable<TerminalEvent> {
    using span = createSpan(ctx.withName("BashState.execute"));
    const pipeStdin = options.pipeStdin ?? false;
    const iterable = createWritableIterable<TerminalEvent>();
    const cwd = options.workingDirectory ?? this.cwd;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...SHELL_ENV_OVERRIDES,
      ...options.env,
    };
    let core = "builtin eval \"$1\"";
    if (!pipeStdin) core += " < /dev/null";
    const sudoAliasInjection = getSudoAliasInjection(env);
    const useFileTransport = this.useFileStateTransport;
    let tempDir: string | undefined;
    let stateInputPath: string | undefined;
    let stateOutputPath: string | undefined;
    if (useFileTransport) {
      tempDir = await mkdtemp(join(tmpdir(), "cursor-bash-state-"));
      stateInputPath = join(tempDir, "state-in");
      stateOutputPath = join(tempDir, "state-out");
      await writeFile(stateInputPath, this.state, "utf8");
      await writeFile(stateOutputPath, "", "utf8").catch(() => {});
      env.CURSOR_STATE_INPUT_FILE = windowsPathToGitBash(stateInputPath);
      env.CURSOR_STATE_OUTPUT_FILE = windowsPathToGitBash(stateOutputPath);
    }
    const stateLoader = useFileTransport ? 'snap=$(command cat "$CURSOR_STATE_INPUT_FILE")' : "snap=$(command cat <&3)";
    const stateWriter = useFileTransport
      ? 'mkdir -p "$(dirname "$CURSOR_STATE_OUTPUT_FILE")" 2>/dev/null; dump_bash_state > "$CURSOR_STATE_OUTPUT_FILE"'
      : "dump_bash_state >&4";
    const commandScript = `${stateLoader} && builtin shopt -s extglob && builtin eval -- "$snap" && { builtin set +u 2>/dev/null || true; builtin eval "\${__CURSOR_SANDBOX_ENV_RESTORE:-}" 2>/dev/null; builtin export PWD="$(builtin pwd)"; builtin shopt -s expand_aliases 2>/dev/null; ${sudoAliasInjection}${core}; }; COMMAND_EXIT_CODE=$?; ${stateWriter}; builtin exit $COMMAND_EXIT_CODE`;
    const args = ["-O", "extglob", "-c", commandScript, "--", command];
    const bashPath = getBashPath(this.userTerminalHint);
    if (!bashPath) throw new Error("Can't find Bash");
    const sandboxWorkspaceRoot = options.sandboxWorkspaceRoot ?? cwd;
    const resolvedPolicy = (await resolveSandboxPolicyForWorkspace(sandboxWorkspaceRoot, options.sandboxPolicy)).policy;
    const sandboxPolicy = resolvedPolicy.type !== "insecure_none" ? { ...resolvedPolicy, sandboxWorkspaceRoot } : resolvedPolicy;
    let newState = "";
    const readStateFromTransport = async (): Promise<void> => {
      if (!useFileTransport) return;
      if (!stateOutputPath) {
        newState = this.state;
        return;
      }
      try {
        newState = await readFile(stateOutputPath, "utf8");
      } catch (error) {
        console.warn("[shell-exec] Failed to read bash state file", error);
        newState = this.state;
      }
    };
    const cleanupStateFiles = async (): Promise<void> => {
      if (!tempDir) return;
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch {
        // Temporary state cleanup is best-effort after process completion.
      }
    };
    let child: ChildProcess;
    try {
      child = requireSpawnWithSignal()(bashPath, args, {
        env,
        stdio: [pipeStdin ? "pipe" : "ignore", "pipe", "pipe", "pipe", "pipe"],
        cwd,
        detached: true,
      }, sandboxPolicy, options.signal);
    } catch (error) {
      await cleanupStateFiles();
      throw error;
    }
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
      bufferOutputEvents: options.bufferOutputEvents,
      outputLimiterOptions: options.outputLimiterOptions,
    });
    child.on("error", async (error) => {
      await cleanupStateFiles();
      iterable.throw(error);
    });
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
          await cleanupStateFiles();
          iterable.throw(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
      await outputPump.flush();
      if (!options.signal?.aborted) {
        await readStateFromTransport();
        const startMarkerLine = `${BASH_STATE_START_MARKER}\n`;
        const endMarkerLine = `${BASH_STATE_END_MARKER}\n`;
        if (newState.startsWith(startMarkerLine) && newState.endsWith(endMarkerLine)) {
          let stateWithoutMarkers = newState.slice(startMarkerLine.length);
          stateWithoutMarkers = stateWithoutMarkers.slice(0, -(BASH_STATE_END_MARKER.length + 1));
          const next = splitPwdAndState(stateWithoutMarkers);
          this.state = next.rest;
          if (process.platform !== "win32" && next.cwd.startsWith("/")) this.cwd = next.cwd;
        }
      }
      if (sandboxPolicy.captureDenies === true) {
        try {
          const denyEvents = await captureSandboxDenies2(child);
          if (denyEvents.length > 0) await iterable.write({ type: "sandbox_denies", events: denyEvents });
        } catch {
          // Sandbox diagnostics are best-effort after process exit.
        }
      }
      try {
        await iterable.write(createShellExitEvent(exitCode, options.signal?.aborted ?? false));
        iterable.close();
      } catch {
        iterable.close();
      }
      await cleanupStateFiles();
    };
    child.on("exit", (code) => {
      exitCode = code;
      const timeout = options.closeTimeout ?? 5_000;
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
    if (!useFileTransport) {
      const inputFd = child.stdio[3];
      if (inputFd !== null && inputFd !== undefined && "write" in inputFd && "end" in inputFd) writeShellStatePipe(inputFd, this.state);
      const outputFd = child.stdio[4];
      if (outputFd !== null && outputFd !== undefined) attachShellStateOutput(outputFd, (text) => { newState += text; });
    }
    yield* iterable;
  }
}

void initBashState;
