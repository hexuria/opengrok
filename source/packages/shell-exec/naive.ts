import { spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { delimiter, win32 } from "node:path";

import { createSpan, reportEvent } from "../context/otel.js";
import type { Context } from "../context/core.js";
import { createWritableIterable } from "../utils/writable-iterable.js";
import { attachShellOutputStreams } from "./output-limiter.js";
import { resolveSandboxPolicyForWorkspace } from "./sandbox/policy-merge.js";
import { captureSandboxDenies } from "./sandbox/macos/seatbelt.js";
import { spawnWithSignal } from "./core.js";
import { shouldEnableSudoAskpass, transformSudoCommand } from "./sudo.js";
import { KnownShellExecutor, SHELL_ENV_OVERRIDES } from "./types.js";
import { initBashState } from "./bash.js";
import { LazyTerminalExecutor } from "./lazy.js";
import { initPowerShellState } from "./powershell.js";
import { initZshState } from "./zsh.js";
import { initZshLightState } from "./zsh-light.js";

export type TerminalEvent =
  | { readonly type: "stdout" | "stderr"; readonly data: Buffer }
  | { readonly type: "suppressed_output" }
  | { readonly type: "stdin_ready"; readonly stdin: ChildProcessWithoutNullStreams["stdin"] | undefined; readonly pid: number | undefined }
  | { readonly type: "sandbox_denies"; readonly events: readonly unknown[] }
  | { readonly type: "exit"; readonly code: number | null; readonly data: ""; readonly aborted: boolean };

type SandboxPolicySources = NonNullable<Parameters<typeof resolveSandboxPolicyForWorkspace>[1]>;
type OutputLimiterOptions = Parameters<typeof attachShellOutputStreams>[0]["outputLimiterOptions"];

export interface TerminalExecuteOptions {
  readonly signal?: AbortSignal;
  readonly workingDirectory?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly pipeStdin?: boolean;
  readonly sandboxPolicy?: unknown;
  readonly sandboxWorkspaceRoot?: string;
  readonly bufferOutputEvents?: boolean;
  readonly outputLimiterOptions?: unknown;
}

export interface TerminalExecutor {
  getCwd(): Promise<string>;
  clone(workingDirectory?: string): TerminalExecutor;
  execute(ctx: Context, command: string, options?: TerminalExecuteOptions): AsyncIterable<TerminalEvent>;
}

export interface DefaultTerminalExecutorOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly shell?: string;
  readonly shellArgs?: readonly string[];
  readonly userTerminalHint?: string;
  readonly statefulFactories?: Partial<Record<KnownShellExecutor.Zsh | KnownShellExecutor.ZshLight | KnownShellExecutor.Bash | KnownShellExecutor.PowerShell, (options?: DefaultTerminalExecutorOptions) => Promise<TerminalExecutor>>>;
}

export class NaiveTerminalExecutor implements TerminalExecutor {
  constructor(private readonly cwd: string, private readonly options: DefaultTerminalExecutorOptions = {}) {}
  async getCwd(): Promise<string> { return this.cwd; }
  clone(workingDirectory?: string): TerminalExecutor { return new NaiveTerminalExecutor(workingDirectory ?? this.cwd, this.options); }
  async *execute(ctx: Context, command: string, options: TerminalExecuteOptions = {}): AsyncIterable<TerminalEvent> {
    using span = createSpan(ctx.withName("NaiveTerminalExecutor.execute"));
    const iterable = createWritableIterable<TerminalEvent>();
    const pipeStdin = options.pipeStdin ?? false;
    const env = {
      ...process.env,
      ...SHELL_ENV_OVERRIDES,
      ...options.env,
    };
    const transformedCommand = shouldEnableSudoAskpass(env) ? transformSudoCommand(command) : command;
    const cwd = options.workingDirectory ?? this.cwd;
    const sandboxWorkspaceRoot = options.sandboxWorkspaceRoot ?? cwd;
    const resolvedPolicy = await resolveSandboxPolicyForWorkspace(sandboxWorkspaceRoot, options.sandboxPolicy as SandboxPolicySources | undefined);
    const sandboxPolicy = resolvedPolicy.policy.type !== "insecure_none"
      ? { ...resolvedPolicy.policy, sandboxWorkspaceRoot }
      : resolvedPolicy.policy;
    const child = spawnWithSignal(this.options.shell || process.env.SHELL || "/bin/sh", [...this.options.shellArgs ?? [], "-c", transformedCommand], {
      env,
      // Use 'ignore' for stdin unless interactive, to prevent background processes from inheriting an open stdin pipe.
      stdio: [pipeStdin ? "pipe" : "ignore", "pipe", "pipe"],
    }, sandboxPolicy, options.signal);
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
      outputLimiterOptions: options.outputLimiterOptions as OutputLimiterOptions | undefined,
    });
    child.on("error", (error) => {
      iterable.throw(error);
    });
    child.on("exit", async (code) => {
      reportEvent(span.ctx, "exit");
      await outputPump.flush();
      if (sandboxPolicy.captureDenies ?? false) {
        try {
          const denyEvents = await captureSandboxDenies(child);
          if (denyEvents && denyEvents.length > 0) {
            await iterable.write({ type: "sandbox_denies", events: denyEvents });
          }
        } catch {
          // Sandbox diagnostics are best-effort after process exit.
        }
      }
      try {
        await iterable.write({
          type: "exit",
          code,
          data: "",
          aborted: options.signal?.aborted ?? false,
        });
        iterable.close();
      } catch {
        iterable.close();
      }
    });
    yield* iterable;
  }
}

export function createNaiveTerminalExecutor(options: DefaultTerminalExecutorOptions = {}): TerminalExecutor {
  return new NaiveTerminalExecutor(process.cwd(), options);
}

function commandExists(command: string): boolean { return spawnSync(command, ["--version"], { stdio: "ignore" }).error === undefined; }
function detectGitBashFromEnvironment(): string | undefined {
  if (process.platform !== "win32" || !process.env.MSYSTEM) return undefined;
  const executablePath = process.env.EXEPATH;
  if (executablePath) { const normalized = executablePath.replace(/[\\/]+$/, ""); const base = win32.basename(normalized).toLowerCase(); return base === "bash.exe" ? normalized : base === "bin" ? win32.join(normalized, "bash.exe") : win32.join(normalized, "bin", "bash.exe"); }
  return "C:\\Program Files\\Git\\bin\\bash.exe";
}

export function getSuggestedShell(userTerminalHint: string): KnownShellExecutor {
  if (userTerminalHint === KnownShellExecutor.ZshLight) return KnownShellExecutor.ZshLight;
  const shell = userTerminalHint || process.env.SHELL || ""; const windows = process.platform === "win32"; const gitBash = windows && !userTerminalHint ? detectGitBashFromEnvironment() : undefined;
  const isGitBash = gitBash !== undefined || /git.*bash\.exe$/i.test(shell) || /program.*git.*bin.*bash\.exe$/i.test(shell); const bashIsOkay = !windows || isGitBash;
  if (shell.includes("zsh")) return KnownShellExecutor.Zsh;
  if (shell.includes("bash") && bashIsOkay) return KnownShellExecutor.Bash;
  if (shell.includes("pwsh") || shell.includes("powershell")) return KnownShellExecutor.PowerShell;
  if (gitBash) return KnownShellExecutor.Bash;
  if (windows && (commandExists("pwsh") || commandExists("powershell"))) return KnownShellExecutor.PowerShell;
  if (commandExists("zsh")) return KnownShellExecutor.Zsh;
  if (commandExists("bash") && bashIsOkay) return KnownShellExecutor.Bash;
  if (commandExists("pwsh") || commandExists("powershell")) return KnownShellExecutor.PowerShell;
  return KnownShellExecutor.Naive;
}

export function createDefaultTerminalExecutor(options: DefaultTerminalExecutorOptions = {}): TerminalExecutor {
  let effective = options; const gitBashPath = options.userTerminalHint ? undefined : detectGitBashFromEnvironment(); if (gitBashPath) effective = { ...options, userTerminalHint: gitBashPath };
  const suggested = getSuggestedShell(effective.userTerminalHint ?? "");
  if (suggested === KnownShellExecutor.Naive) return createNaiveTerminalExecutor(effective);
  const override = effective.statefulFactories?.[suggested];
  if (override !== undefined) return new LazyTerminalExecutor(() => override(effective));
  switch (suggested) {
    case KnownShellExecutor.Zsh:
      return new LazyTerminalExecutor(() => initZshState(effective));
    case KnownShellExecutor.Bash:
      return new LazyTerminalExecutor(() => initBashState(effective));
    case KnownShellExecutor.PowerShell:
      return new LazyTerminalExecutor(() => initPowerShellState());
    case KnownShellExecutor.ZshLight:
      return new LazyTerminalExecutor(() => initZshLightState(effective));
    default:
      return createNaiveTerminalExecutor(effective);
  }
}
