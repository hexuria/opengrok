import { gitExecFile } from "../git-core/git-exec.js";

export type ExtraGitConfig = Readonly<Record<string, string | readonly string[]>>;
export type ExtraGitConfigProvider = ExtraGitConfig | (() => ExtraGitConfig | undefined) | undefined;

function gitNonInteractiveLeadingArgs(): string[] {
  const args = ["-c", "credential.interactive=false", "-c", "core.fsmonitor=false"];
  if (process.platform === "win32") args.push("-c", "core.longpaths=true");
  return args;
}

function gitNonInteractiveExecOptions(extra?: {
  readonly cwd?: string | undefined;
  readonly sshBatchMode?: boolean | undefined;
  readonly extraGitConfig?: ExtraGitConfig | undefined;
}): { cwd: string | undefined; env: NodeJS.ProcessEnv } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: undefined,
    VSCODE_GIT_ASKPASS_NODE: undefined,
    VSCODE_GIT_ASKPASS_MAIN: undefined,
    VSCODE_GIT_ASKPASS_EXTRA_ARGS: undefined,
    GCM_INTERACTIVE: "Never",
  };
  env.GIT_CONFIG_NOSYSTEM = undefined;
  if (extra?.sshBatchMode === true) {
    const baseSshCommand = process.env.GIT_SSH_COMMAND?.trim() || "ssh";
    env.GIT_SSH_COMMAND = `${baseSshCommand} -oBatchMode=yes`;
  }
  if (extra?.extraGitConfig !== undefined) {
    const entries = Object.entries(extra.extraGitConfig).flatMap(([key, value]) =>
      Array.isArray(value) ? value.map(entry => [key, entry] as const) : [[key, value as string] as const],
    );
    env.GIT_CONFIG_COUNT = String(entries.length);
    for (const [index, [key, value]] of entries.entries()) {
      env[`GIT_CONFIG_KEY_${index}`] = key;
      env[`GIT_CONFIG_VALUE_${index}`] = value;
    }
  }
  return { cwd: extra?.cwd, env };
}

export function resolveExtraGitConfig(provider: ExtraGitConfigProvider): ExtraGitConfig | undefined {
  return typeof provider === "function" ? provider() : provider;
}

export interface ExecGitNonInteractiveOptions {
  readonly cwd?: string | undefined;
  readonly sshBatchMode?: boolean | undefined;
  readonly extraGitConfig?: ExtraGitConfig | undefined;
  readonly timeoutMs?: number | undefined;
}

export async function execGitNonInteractive(
  args: readonly string[],
  options?: ExecGitNonInteractiveOptions,
): Promise<{ stdout: string; stderr: string }> {
  const execOptions = gitNonInteractiveExecOptions({
    cwd: options?.cwd,
    sshBatchMode: options?.sshBatchMode,
    extraGitConfig: options?.extraGitConfig,
  });
  return gitExecFile("git", [...gitNonInteractiveLeadingArgs(), ...args], {
    ...execOptions,
    ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs, killSignal: "SIGTERM" } : {}),
  });
}
