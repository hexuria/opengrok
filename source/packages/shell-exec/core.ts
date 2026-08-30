import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { Writable } from "node:stream";

import { withConfiguredRipgrepEnv } from "./ripgrep.js";
import { spawnInSandbox, type SandboxExecutionPolicy } from "./sandbox/sandbox.js";

type ErrorAwareStream = { on(event: "error", listener: () => void): unknown };
type ShellStateInput = ErrorAwareStream & Pick<Writable, "write" | "end">;
type ShellStateOutput = ErrorAwareStream & { on(event: "data", listener: (data: Buffer | string) => void): unknown };
type ShellExitEvent = {
  readonly type: "exit";
  readonly code: number | null;
  readonly data: "";
  readonly aborted: boolean;
};

export function createShellExitEvent(code: number | null, aborted: boolean): ShellExitEvent {
  return { type: "exit", code, data: "", aborted };
}

function createAbortedChild(): EventEmitter {
  const error = new Error("Operation was aborted");
  error.name = "AbortError";
  const mockChild = new EventEmitter();
  process.nextTick(() => {
    mockChild.emit("error", error);
  });
  return mockChild;
}

function attachAbortSignalToChild(child: ChildProcess, detached: boolean | undefined, signal: AbortSignal): void {
  const abortHandler = (): void => {
    if (child.pid) {
      try {
        if (detached) {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            child.kill("SIGTERM");
          }
        } else {
          child.kill("SIGTERM");
        }
        const forceKillTimeout = setTimeout(() => {
          if (!child.killed && child.pid) {
            try {
              if (detached) {
                try {
                  process.kill(-child.pid, "SIGKILL");
                } catch {
                  child.kill("SIGKILL");
                }
              } else {
                child.kill("SIGKILL");
              }
            } catch {
              // The child may have exited between the graceful and forced kills.
            }
          }
        }, 1_000);
        child.once("exit", () => {
          clearTimeout(forceKillTimeout);
        });
      } catch {
        // Cancellation is best-effort after the child has been created.
      }
    }
  };
  signal.addEventListener("abort", abortHandler, { once: true });
  child.once("exit", () => {
    signal.removeEventListener("abort", abortHandler);
  });
}

export function spawnWithSignal(
  command: string,
  args?: readonly string[],
  options?: SpawnOptions,
  sandboxPolicy?: SandboxExecutionPolicy,
  signal?: AbortSignal,
): ChildProcess;
export function spawnWithSignal(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
  sandboxPolicy: SandboxExecutionPolicy = { type: "insecure_none" },
  signal?: AbortSignal,
): ChildProcess | EventEmitter {
  if (signal?.aborted) {
    return createAbortedChild();
  }
  const child = spawnInSandbox(command, args, {
    ...options,
    env: withConfiguredRipgrepEnv(options.env ?? process.env),
  }, sandboxPolicy);
  if (signal) {
    attachAbortSignalToChild(child, options.detached, signal);
  }
  return child;
}

export function killDetachedProcessGroup(
  pid: number | undefined,
  signal: NodeJS.Signals,
  forceKillAfterMs?: number,
): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    return;
  }
  if (signal === "SIGTERM" && forceKillAfterMs !== undefined && forceKillAfterMs > 0) {
    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // The process may have exited between the graceful and forced kills.
      }
    }, forceKillAfterMs);
  }
}

function ignoreStreamErrors(stream: ErrorAwareStream | null | undefined): void {
  stream?.on("error", () => {});
}

export function writeShellStatePipe(input: ShellStateInput | null | undefined, state: string): void {
  if (!input) return;
  ignoreStreamErrors(input);
  input.write(state);
  input.end();
}

export function attachShellStateOutput(
  output: ShellStateOutput | null | undefined,
  onChunk: (chunk: string) => void,
): void {
  if (!output) return;
  ignoreStreamErrors(output);
  output.on("data", (data) => onChunk(data.toString()));
}

export function splitPwdAndState(state: string): { cwd: string; rest: string } {
  const firstLineIndex = state.indexOf("\n");
  const cwd = state.substring(0, firstLineIndex);
  const rest = state.substring(firstLineIndex);
  return { cwd, rest };
}

export function parseShellStateOutput(fullOutput: string, marker: string): string {
  const markerWithNewline = `${marker}\n`;
  const markerIndex = fullOutput.indexOf(markerWithNewline);
  return markerIndex >= 0 ? fullOutput.slice(markerIndex + markerWithNewline.length) : fullOutput;
}
