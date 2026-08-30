import type { ChildProcess, SpawnOptions } from "node:child_process";

import { createSpan, reportEvent } from "../context/otel.js";
import type { Context } from "../context/core.js";
import { createWritableIterable } from "../utils/writable-iterable.js";
import { attachShellOutputStreams } from "./output-limiter.js";
import { getZshPath } from "./platform-shell.js";
import { getSudoAliasInjection } from "./sudo.js";
import { SHELL_ENV_OVERRIDES } from "./types.js";
import { resolveSandboxPolicyForWorkspace } from "./sandbox/policy-merge.js";
import { captureSandboxDenies } from "./sandbox/macos/seatbelt.js";
import { ZSH_STATE_END_MARKER, ZSH_STATE_START_MARKER, default as dumpZshState } from "./dump_zsh_state.js";
import { spawnWithSignal, killDetachedProcessGroup, splitPwdAndState, writeShellStatePipe, attachShellStateOutput } from "./core.js";
import { createShellExitEvent } from "./core.js";
import type { TerminalEvent, TerminalExecuteOptions } from "./naive.js";

type SandboxPolicySources = NonNullable<Parameters<typeof resolveSandboxPolicyForWorkspace>[1]>;
type OutputLimiterOptions = Parameters<typeof attachShellOutputStreams>[0]["outputLimiterOptions"];
type ZshExecuteOptions = Omit<TerminalExecuteOptions, "sandboxPolicy" | "outputLimiterOptions"> & {
  readonly sandboxPolicy?: SandboxPolicySources;
  readonly outputLimiterOptions?: OutputLimiterOptions;
  readonly closeTimeout?: number;
};
type ZshInitOptions = Pick<ZshExecuteOptions, "env" | "signal"> & {
  readonly userTerminalHint?: string;
};

const isMacOS = process.platform === "darwin";

async function captureSandboxDenies2(child: ChildProcess): Promise<readonly unknown[]> {
  return isMacOS ? captureSandboxDenies(child) : [];
}

export async function initZshState(options?: ZshInitOptions): Promise<ZshState> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...SHELL_ENV_OVERRIDES,
    ...options?.env,
  };
  const stateMarker = "__CURSOR_STATE_MARKER__";
  const args = [
    "-o",
    "extendedglob",
    "-ilc",
    `${dumpZshState} builtin printf '${stateMarker}\\n'; dump_zsh_state`,
  ];
  const child = spawnWithSignal(getZshPath(), args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  }, { type: "insecure_none" }, options?.signal);
  let fullOutput = "";
  child.stdout?.on("data", (data: Buffer | string) => {
    fullOutput += data.toString();
  });
  child.on("error", (error) => {
    console.warn(`[shell-exec] zsh state init spawn failed; falling back to empty state: ${error instanceof Error ? error.message : String(error)}`);
  });
  await new Promise<void>((resolve) => {
    child.on("close", () => resolve());
  });
  const snapshot = fullOutput;
  const startMarkerLine = `${ZSH_STATE_START_MARKER}\n`;
  const endMarkerLine = `${ZSH_STATE_END_MARKER}\n`;
  let stateWithoutMarkers: string;
  if (snapshot.startsWith(startMarkerLine) && snapshot.endsWith(endMarkerLine)) {
    stateWithoutMarkers = snapshot.slice(startMarkerLine.length);
    stateWithoutMarkers = stateWithoutMarkers.slice(0, -(ZSH_STATE_END_MARKER.length + 1));
  } else {
    stateWithoutMarkers = `${process.cwd()}\n`;
  }
  const { cwd, rest } = splitPwdAndState(stateWithoutMarkers);
  return new ZshState(cwd, rest, options?.userTerminalHint);
}

export class ZshState {
  constructor(
    private cwd: string,
    private state: string,
    private readonly userTerminalHint?: string,
  ) {}

  async getCwd(): Promise<string> {
    return this.cwd;
  }

  clone(workingDirectory?: string): ZshState {
    return new ZshState(workingDirectory ?? this.cwd, this.state, this.userTerminalHint);
  }

  async *execute(ctx: Context, command: string, options: ZshExecuteOptions = {}): AsyncIterable<TerminalEvent> {
    using span = createSpan(ctx.withName("ZshState.execute"));
    const pipeStdin = options.pipeStdin ?? false;
    const iterable = createWritableIterable<TerminalEvent>();
    const cwd = options.workingDirectory ?? this.cwd;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...SHELL_ENV_OVERRIDES,
      ...options.env,
    };
    let core = `builtin eval "$1"`;
    if (!pipeStdin) core += " < /dev/null";
    const sudoAliasInjection = getSudoAliasInjection(env);
    const commandScript = `builtin export PATH="/usr/bin:/bin:/usr/sbin:/sbin\${PATH:+:$PATH}"; snap=$(command cat <&3); builtin unsetopt aliases 2>/dev/null; builtin unalias -m '*' 2>/dev/null || true; builtin eval "$snap" && { builtin unsetopt nounset 2>/dev/null || true; builtin eval "\${__CURSOR_SANDBOX_ENV_RESTORE:-}" 2>/dev/null; builtin export PWD="$(builtin pwd)"; builtin setopt aliases 2>/dev/null; ${sudoAliasInjection}${core}; }; COMMAND_EXIT_CODE=$?; dump_zsh_state >&4; builtin exit $COMMAND_EXIT_CODE`;
    const args = ["-c", commandScript, "--", command];
    const sandboxWorkspaceRoot = options.sandboxWorkspaceRoot ?? cwd;
    const resolvedPolicy = (await resolveSandboxPolicyForWorkspace(sandboxWorkspaceRoot, options.sandboxPolicy)).policy;
    const sandboxPolicy = resolvedPolicy.type !== "insecure_none"
      ? { ...resolvedPolicy, sandboxWorkspaceRoot }
      : resolvedPolicy;
    const child = spawnWithSignal(getZshPath(), args, {
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
        const startMarkerLine = `${ZSH_STATE_START_MARKER}\n`;
        const endMarkerLine = `${ZSH_STATE_END_MARKER}\n`;
        if (newState.startsWith(startMarkerLine) && newState.endsWith(endMarkerLine)) {
          let stateWithoutMarkers = newState.slice(startMarkerLine.length);
          stateWithoutMarkers = stateWithoutMarkers.slice(0, -(ZSH_STATE_END_MARKER.length + 1));
          const next = splitPwdAndState(stateWithoutMarkers);
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
          if (hasEmittedExit) return;
          console.warn(`[shell-exec] Close event did not fire within ${timeout}ms after exit. This may indicate a background process is holding file descriptors open. Killing detached process group.`);
          killDetachedProcessGroup(child.pid, "SIGKILL");
          void emitExitAndClose(false);
        }, timeout);
      }
    });
    child.on("close", () => {
      void emitExitAndClose(true);
    });
    const inputFd = child.stdio[3];
    const outputFd = child.stdio[4];
    if (inputFd !== null && inputFd !== undefined && "write" in inputFd && "end" in inputFd) {
      writeShellStatePipe(inputFd, this.state);
    }
    attachShellStateOutput(outputFd, (text) => {
      newState += text;
    });
    yield* iterable;
  }
}
