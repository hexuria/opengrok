import type { ChildProcess, SpawnOptions } from "node:child_process";

import { createSpan, reportEvent } from "../context/otel.js";
import type { Context } from "../context/core.js";
import { createWritableIterable } from "../utils/writable-iterable.js";
import { getZshPath } from "./platform-shell.js";
import { attachShellOutputStreams } from "./output-limiter.js";
import { getSudoAliasInjection } from "./sudo.js";
import { SHELL_ENV_OVERRIDES } from "./types.js";
import { resolveSandboxPolicyForWorkspace } from "./sandbox/policy-merge.js";
import { captureSandboxDenies } from "./sandbox/macos/seatbelt.js";
import { ZSH_STATE_LIGHT_MARKER, default as dumpZshStateLight } from "./dump_zsh_state_light.js";
import {
  attachShellStateOutput,
  createShellExitEvent,
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
type ZshLightExecuteOptions = Omit<TerminalExecuteOptions, "sandboxPolicy" | "outputLimiterOptions"> & {
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
const isMacOS = process.platform === "darwin";

function requireSpawnWithSignal(): SpawnWithSignal {
  return spawnWithSignalBinding;
}

async function captureSandboxDenies2(child: ChildProcess): Promise<readonly unknown[]> {
  return isMacOS ? captureSandboxDenies(child) : [];
}

function getZshPath2(): string {
  return getZshPath();
}

export async function initZshLightState(options?: ZshLightExecuteOptions): Promise<ZshLightState> {
  const env = {
    ...process.env,
    ...SHELL_ENV_OVERRIDES,
    ...options?.env,
  };
  const stateMarker = "__CURSOR_STATE_MARKER__";
  const args = [
    "-o",
    "extendedglob",
    "-ilc",
    `${dumpZshStateLight} builtin printf '${stateMarker}\\n'; dump_zsh_state_light`,
  ];
  const child = requireSpawnWithSignal()(getZshPath2(), args, {
    env,
    // Only provide stdio for 0/1/2 to avoid extra FDs being inherited by background processes.
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  }, { type: "insecure_none" }, options?.signal);
  let fullOutput = "";
  child.stdout?.on("data", (data: Buffer | string) => {
    fullOutput += data.toString();
  });
  child.on("error", (error) => {
    console.warn(`[shell-exec] zsh-light state init spawn failed; falling back to empty state: ${error instanceof Error ? error.message : String(error)}`);
  });
  await new Promise<void>((resolve) => {
    child.on("close", () => resolve());
  });
  const snapshot = fullOutput.includes(stateMarker) ? fullOutput.slice(fullOutput.indexOf(`${stateMarker}\n`) + stateMarker.length + 1) : fullOutput;
  const markerLine = `${ZSH_STATE_LIGHT_MARKER}\n`;
  const stateWithoutMarker = snapshot.startsWith(markerLine) ? snapshot.slice(markerLine.length) : `${process.cwd()}\n`;
  const { cwd, rest } = splitPwdAndState(stateWithoutMarker);
  return new ZshLightState(cwd, rest);
}

class ZshLightState {
  constructor(
    private cwd: string,
    private state: string,
  ) {}

  async getCwd(): Promise<string> {
    return this.cwd;
  }

  clone(workingDirectory?: string): ZshLightState {
    return new ZshLightState(workingDirectory ?? this.cwd, this.state);
  }

  async *execute(ctx: Context, command: string, options: ZshLightExecuteOptions = {}): AsyncIterable<TerminalEvent> {
    using span = createSpan(ctx.withName("ZshLightState.execute"));
    const pipeStdin = options.pipeStdin ?? false;
    const iterable = createWritableIterable<TerminalEvent>();
    const cwd = options.workingDirectory ?? this.cwd;
    const env = {
      ...process.env,
      ...SHELL_ENV_OVERRIDES,
      ...options.env,
    };
    let core = "builtin eval \"$1\"";
    if (!pipeStdin) core += " < /dev/null";
    const sudoAliasInjection = getSudoAliasInjection(env);
    const commandScript = `builtin export PATH="/usr/bin:/bin:/usr/sbin:/sbin\${PATH:+:$PATH}"; snap=$(command cat <&3); builtin unsetopt aliases 2>/dev/null; builtin unalias -m '*' 2>/dev/null || true; ${dumpZshStateLight} builtin eval "$snap" && { builtin unsetopt nounset 2>/dev/null || true; builtin eval "\${__CURSOR_SANDBOX_ENV_RESTORE:-}" 2>/dev/null; builtin export PWD="$(builtin pwd)"; builtin setopt aliases 2>/dev/null; ${sudoAliasInjection}${core}; }; COMMAND_EXIT_CODE=$?; dump_zsh_state_light >&4; builtin exit $COMMAND_EXIT_CODE`;
    const args = ["-c", commandScript, "--", command];
    const sandboxWorkspaceRoot = options.sandboxWorkspaceRoot ?? cwd;
    const resolvedPolicy = await resolveSandboxPolicyForWorkspace(sandboxWorkspaceRoot, options.sandboxPolicy);
    const sandboxPolicy = resolvedPolicy.policy.type !== "insecure_none"
      ? { ...resolvedPolicy.policy, sandboxWorkspaceRoot }
      : resolvedPolicy.policy;
    const child = requireSpawnWithSignal()(getZshPath2(), args, {
      env,
      stdio: [pipeStdin ? "pipe" : "ignore", "pipe", "pipe", "pipe", "pipe"],
      cwd,
      detached: true,
    }, sandboxPolicy, options.signal);
    let newState = "";
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
    child.on("error", (error) => {
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
          iterable.throw(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
      await outputPump.flush();
      if (!options.signal?.aborted) {
        const markerLine = `${ZSH_STATE_LIGHT_MARKER}\n`;
        if (newState.startsWith(markerLine)) {
          const stateWithoutMarker = newState.slice(markerLine.length);
          const next = splitPwdAndState(stateWithoutMarker);
          if (next.cwd.startsWith("/")) {
            this.state = next.rest;
            this.cwd = next.cwd;
          }
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
    const inputFd = child.stdio[3];
    if (inputFd !== null && inputFd !== undefined && "write" in inputFd && "end" in inputFd) {
      writeShellStatePipe(inputFd, this.state);
    }
    const outputFd = child.stdio[4];
    if (outputFd !== null && outputFd !== undefined) {
      attachShellStateOutput(outputFd, (text) => {
        newState += text;
      });
    }
    yield* iterable;
  }
}

void initZshLightState;
