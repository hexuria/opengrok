import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { homedir } from "node:os";

import type { SandInferenceProvider } from "../inference-router.js";
import { getLocalInferenceCliStatus, resolveClaudeCodeCliPath, resolveCodexCliPath } from "./inference-router-local.js";

export const SUBSCRIPTION_INFERENCE_PROVIDERS = ["claude-code", "codex"] as const;
export type SubscriptionInferenceProvider = (typeof SUBSCRIPTION_INFERENCE_PROVIDERS)[number];

export const CLAUDE_AUTH_STATUS_ARGS = ["auth", "status", "--json"] as const;
export const CLAUDE_SUBSCRIPTION_LOGIN_ARGS = ["/login"] as const;
export const CLAUDE_SUBSCRIPTION_LOGOUT_ARGS = ["/logout"] as const;
export const CODEX_LOGIN_STATUS_ARGS = ["login", "status"] as const;
export const CODEX_SUBSCRIPTION_LOGIN_ARGS = ["login"] as const;
export const CODEX_SUBSCRIPTION_LOGOUT_ARGS = ["logout"] as const;
export const SUBSCRIPTION_CLI_STATUS_TIMEOUT_MS = 8_000;
export const SUBSCRIPTION_CLI_LOGOUT_TIMEOUT_MS = 12_000;

export interface SubscriptionCliAuthStatus {
  readonly provider: SubscriptionInferenceProvider;
  readonly installed: boolean;
  readonly authenticated: boolean;
  readonly executablePath: string | null;
  readonly loginCommand: readonly string[];
  readonly prompt: string;
}

export interface SubscriptionCliRunResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SubscriptionCliRunnerOptions {
  readonly timeoutMs: number;
  readonly env: NodeJS.ProcessEnv;
}

export type SubscriptionCliRunner = (
  file: string,
  args: readonly string[],
  options: SubscriptionCliRunnerOptions,
) => Promise<SubscriptionCliRunResult>;

export type SubscriptionCliLoginStarter = (
  file: string,
  args: readonly string[],
  options: { readonly env: NodeJS.ProcessEnv; readonly platform: NodeJS.Platform; readonly mode?: "terminal" | "background" },
) => Promise<{ readonly started: boolean }>;

export const CODEX_INSTALL_COMMAND_POSIX = "curl -fsSL https://chatgpt.com/codex/install.sh | sh";
export const CODEX_INSTALL_COMMAND_WINDOWS = "powershell -ExecutionPolicy ByPass -c \"irm https://chatgpt.com/codex/install.ps1 | iex\"";

export function codexInstallCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? CODEX_INSTALL_COMMAND_WINDOWS : CODEX_INSTALL_COMMAND_POSIX;
}

/** Opens the user's terminal with the Codex install command so a missing CLI is one keystroke from fixed. */
export async function openCodexInstallTerminal(options: { readonly platform?: NodeJS.Platform; readonly env?: NodeJS.ProcessEnv } = {}): Promise<{ readonly opened: boolean }> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const command = codexInstallCommand(platform);
  try {
    if (platform === "darwin") {
      const script = `tell application "Terminal"\nactivate\ndo script ${JSON.stringify(command)}\nend tell`;
      const opened = await defaultSubscriptionCliRunner("/usr/bin/osascript", ["-e", script], { timeoutMs: SUBSCRIPTION_CLI_STATUS_TIMEOUT_MS, env });
      return { opened: opened.ok };
    }
    if (platform === "win32") {
      const child = spawn("cmd.exe", ["/c", "start", "powershell", "-NoExit", "-ExecutionPolicy", "ByPass", "-c", "irm https://chatgpt.com/codex/install.ps1 | iex"], { detached: true, stdio: "ignore", env });
      child.unref();
      return { opened: true };
    }
    return { opened: false };
  } catch { return { opened: false }; }
}

export interface SubscriptionCliAuthPort {
  getStatus(provider: SubscriptionInferenceProvider): Promise<SubscriptionCliAuthStatus>;
  startLogin(provider: SubscriptionInferenceProvider): Promise<{ readonly started: boolean; readonly status: SubscriptionCliAuthStatus }>;
  logout(provider: SubscriptionInferenceProvider): Promise<{ readonly loggedOut: boolean; readonly status: SubscriptionCliAuthStatus }>;
}

export interface SelectSubscriptionProviderResult {
  readonly ok: boolean;
  readonly provider: SandInferenceProvider;
  readonly loginStarted: boolean;
  readonly error?: string;
  readonly local: {
    readonly codex: SubscriptionCliAuthStatus;
    readonly "claude-code": SubscriptionCliAuthStatus;
  };
}

export function isSubscriptionInferenceProvider(value: unknown): value is SubscriptionInferenceProvider {
  return value === "claude-code" || value === "codex";
}

export function subscriptionLoginArgs(provider: SubscriptionInferenceProvider): readonly string[] {
  return provider === "codex" ? CODEX_SUBSCRIPTION_LOGIN_ARGS : CLAUDE_SUBSCRIPTION_LOGIN_ARGS;
}

export function subscriptionLogoutArgs(provider: SubscriptionInferenceProvider): readonly string[] {
  return provider === "codex" ? CODEX_SUBSCRIPTION_LOGOUT_ARGS : CLAUDE_SUBSCRIPTION_LOGOUT_ARGS;
}

export function subscriptionLogoutCommandLine(executablePath: string | null, provider: SubscriptionInferenceProvider): readonly string[] {
  return [executablePath ?? (provider === "codex" ? "codex" : "claude"), ...subscriptionLogoutArgs(provider)];
}

export function subscriptionStatusArgs(provider: SubscriptionInferenceProvider): readonly string[] {
  return provider === "codex" ? CODEX_LOGIN_STATUS_ARGS : CLAUDE_AUTH_STATUS_ARGS;
}

export function subscriptionLoginCommandLine(executablePath: string | null, provider: SubscriptionInferenceProvider): readonly string[] {
  return [executablePath ?? (provider === "codex" ? "codex" : "claude"), ...subscriptionLoginArgs(provider)];
}

export function subscriptionCliEnvironment(
  provider: SubscriptionInferenceProvider,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  if (provider === "codex") {
    // Official Codex turns must use the ChatGPT subscription login, not a leaked API key.
    delete env.OPENAI_API_KEY;
  } else {
    delete env.ANTHROPIC_API_KEY;
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
  }
  return env;
}

export function parseClaudeAuthStatusJson(stdout: string, stderr = ""): boolean {
  for (const text of [stdout, stderr]) {
    const trimmed = text.trim();
    if (trimmed.length === 0) continue;
    try {
      const status: unknown = JSON.parse(trimmed);
      if (typeof status === "object" && status != null && "loggedIn" in status && (status as { loggedIn?: unknown }).loggedIn === true) {
        return true;
      }
    } catch {
      // The official CLI can exit 1 while still emitting valid JSON. Ignore junk.
    }
  }
  return false;
}

export function parseCodexLoginStatusText(stdout: string, stderr = ""): boolean {
  return /^logged in\b/im.test(`${stdout}\n${stderr}`);
}

export function subscriptionAuthPrompt(status: Pick<SubscriptionCliAuthStatus, "provider" | "installed" | "authenticated" | "loginCommand">, loginStarted = false): string {
  const command = status.loginCommand.join(" ");
  if (status.authenticated) {
    return status.provider === "codex"
      ? "Signed in with the official Codex/ChatGPT subscription."
      : "Signed in with the official Claude Pro/Max subscription.";
  }
  if (!status.installed) {
    return status.provider === "codex"
      ? `Codex CLI is not installed. Download it with \`${codexInstallCommand()}\`, then choose Codex again.`
      : "Claude Code is not installed. Install Claude Code, run `claude /login`, then choose Claude again.";
  }
  if (loginStarted) {
    return status.provider === "codex"
      ? "Finish the ChatGPT sign-in in the browser tab that just opened."
      : `Complete the official Claude Pro/Max login that just opened (\`${command}\`), then choose Claude again.`;
  }
  return status.provider === "codex"
    ? "Codex is not signed in. Click Sign in to start the official ChatGPT login."
    : `Claude is not signed in. Run \`${command}\` and complete the official Claude Pro/Max login.`;
}

export function defaultSubscriptionCliRunner(
  file: string,
  args: readonly string[],
  options: SubscriptionCliRunnerOptions,
): Promise<SubscriptionCliRunResult> {
  return new Promise((resolve) => {
    // cwd is the home dir so a version-manager shim (nodenv/asdf) resolves the
    // user's global toolchain instead of whatever directory the app started in.
    execFile(file, [...args], {
      timeout: options.timeoutMs,
      env: options.env,
      cwd: homedir(),
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({
        ok: error == null,
        stdout: stdout?.toString() ?? "",
        stderr: stderr?.toString() ?? "",
      });
    });
  });
}

export async function defaultSubscriptionCliLoginStarter(
  file: string,
  args: readonly string[],
  options: { readonly env: NodeJS.ProcessEnv; readonly platform: NodeJS.Platform; readonly mode?: "terminal" | "background" },
): Promise<{ readonly started: boolean }> {
  // `codex login` runs its own localhost callback server and opens the browser,
  // so it launches silently in the background; `claude /login` is an interactive
  // TUI and still needs a real terminal.
  const openInTerminal = async (): Promise<boolean> => {
    if (options.platform !== "darwin") return false;
    const command = [file, ...args].map(shellSingleQuote).join(" ");
    const script = `tell application "Terminal"\nactivate\ndo script ${JSON.stringify(command)}\nend tell`;
    const opened = await defaultSubscriptionCliRunner("/usr/bin/osascript", ["-e", script], {
      timeoutMs: SUBSCRIPTION_CLI_STATUS_TIMEOUT_MS,
      env: options.env,
    });
    return opened.ok;
  };
  if (options.mode !== "background" && await openInTerminal()) return { started: true };
  try {
    const child = spawn(file, [...args], {
      detached: true,
      stdio: "ignore",
      env: options.env,
      cwd: homedir(),
    });
    // A login that dies within the grace window never opened its browser (bad
    // PATH, version-manager shim on the wrong runtime, missing binary). Its
    // stdio is discarded, so the only honest recovery is a visible terminal
    // where the user's own shell runs the same command.
    const diedEarly = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { settle(false); }, 1_500);
      const settle = (value: boolean) => { clearTimeout(timer); child.off("exit", onExit); child.off("error", onExit); resolve(value); };
      const onExit = () => { settle(true); };
      child.once("exit", onExit);
      child.once("error", onExit);
    });
    if (!diedEarly) {
      child.unref();
      return { started: true };
    }
  } catch {
    // fall through to the terminal below
  }
  return { started: await openInTerminal() };
}

export function createSubscriptionCliAuthPort(deps: {
  readonly runCli?: SubscriptionCliRunner;
  readonly startLogin?: SubscriptionCliLoginStarter;
  readonly resolveClaudePath?: () => string | null;
  readonly resolveCodexPath?: () => string | null;
  readonly fileCodexAuthenticated?: () => boolean;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly openInstallTerminal?: (options: { readonly platform?: NodeJS.Platform; readonly env?: NodeJS.ProcessEnv }) => Promise<{ readonly opened: boolean }>;
}): SubscriptionCliAuthPort {
  const runCli = deps.runCli ?? defaultSubscriptionCliRunner;
  const startLogin = deps.startLogin ?? defaultSubscriptionCliLoginStarter;
  const resolveClaudePath = deps.resolveClaudePath ?? resolveClaudeCodeCliPath;
  const resolveCodexPath = deps.resolveCodexPath ?? resolveCodexCliPath;
  const fileCodexAuthenticated = deps.fileCodexAuthenticated ?? (() => getLocalInferenceCliStatus().codex.authenticated);
  const platform = deps.platform ?? process.platform;
  const sourceEnv = deps.env ?? process.env;

  const readStatus = async (provider: SubscriptionInferenceProvider): Promise<SubscriptionCliAuthStatus> => {
    const executablePath = provider === "codex" ? resolveCodexPath() : resolveClaudePath();
    const loginCommand = subscriptionLoginCommandLine(executablePath, provider);
    if (executablePath == null) {
      const authenticated = provider === "codex" && fileCodexAuthenticated();
      const status = { provider, installed: authenticated, authenticated, executablePath: null, loginCommand };
      return { ...status, prompt: subscriptionAuthPrompt(status) };
    }
    const result = await runCli(executablePath, [...subscriptionStatusArgs(provider)], {
      timeoutMs: SUBSCRIPTION_CLI_STATUS_TIMEOUT_MS,
      env: subscriptionCliEnvironment(provider, sourceEnv),
    });
    const authenticated = provider === "codex"
      ? parseCodexLoginStatusText(result.stdout, result.stderr) || fileCodexAuthenticated()
      : parseClaudeAuthStatusJson(result.stdout, result.stderr);
    const status = { provider, installed: true, authenticated, executablePath, loginCommand };
    return { ...status, prompt: subscriptionAuthPrompt(status) };
  };

  return {
    getStatus: readStatus,
    async startLogin(provider) {
      const before = await readStatus(provider);
      if (before.authenticated) return { started: false, status: before };
      if (before.executablePath == null) {
        // Missing CLI: hand the user the installer instead of failing silently.
        if (provider === "codex") await (deps.openInstallTerminal ?? openCodexInstallTerminal)({ platform, env: sourceEnv });
        return { started: false, status: before };
      }
      let started = false;
      try {
        started = (await startLogin(before.executablePath, subscriptionLoginArgs(provider), {
          env: subscriptionCliEnvironment(provider, sourceEnv),
          platform,
          mode: provider === "codex" ? "background" : "terminal",
        })).started;
      } catch {
        started = false;
      }
      const after = await readStatus(provider);
      const status = { ...after, prompt: subscriptionAuthPrompt(after, started && !after.authenticated) };
      return { started, status };
    },
    async logout(provider) {
      const before = await readStatus(provider);
      if (!before.authenticated) return { loggedOut: true, status: before };
      if (before.executablePath == null) return { loggedOut: false, status: before };
      try {
        await runCli(before.executablePath, [...subscriptionLogoutArgs(provider)], {
          timeoutMs: SUBSCRIPTION_CLI_LOGOUT_TIMEOUT_MS,
          env: subscriptionCliEnvironment(provider, sourceEnv),
        });
      } catch {
        // Official logout is best-effort; status below is the source of truth.
      }
      const after = await readStatus(provider);
      return { loggedOut: !after.authenticated, status: after };
    },
  };
}

export async function readSubscriptionLocalStatus(auth: SubscriptionCliAuthPort): Promise<SelectSubscriptionProviderResult["local"]> {
  const [claude, codex] = await Promise.all([auth.getStatus("claude-code"), auth.getStatus("codex")]);
  return { "claude-code": claude, codex };
}

export async function selectSubscriptionInferenceProvider(input: {
  readonly requested: SandInferenceProvider;
  readonly current: SandInferenceProvider;
  readonly auth: SubscriptionCliAuthPort;
}): Promise<SelectSubscriptionProviderResult> {
  const local = await readSubscriptionLocalStatus(input.auth);
  // Persist the route even when Claude/Codex are not signed in yet. Official
  // CLI login is a Settings action (`startSubscriptionLogin`), not a gate on
  // picking the provider. Turns still fail closed until the CLI is authenticated.
  return { ok: true, provider: input.requested, loginStarted: false, local };
}

export type PreviousProviderLogoutKind = "cursor" | "claude-code" | "codex" | "none";

export async function logoutPreviousInferenceProvider(input: {
  readonly previous: SandInferenceProvider;
  readonly next: SandInferenceProvider;
  readonly auth: SubscriptionCliAuthPort;
  readonly logoutCursor?: () => Promise<unknown>;
}): Promise<{
  readonly previous: SandInferenceProvider;
  readonly next: SandInferenceProvider;
  readonly loggedOut: PreviousProviderLogoutKind;
  readonly sessionCleared: boolean;
}> {
  if (input.previous === input.next) {
    return { previous: input.previous, next: input.next, loggedOut: "none", sessionCleared: false };
  }
  // A Claude/Codex CLI login belongs to the user's machine, not to this app:
  // running `claude /logout` / `codex logout` on a router switch destroys the
  // user's own CLI session (deletes ~/.codex/auth.json), and the way back is a
  // full browser login. Each provider keeps its own login; only the app-owned
  // Cursor session is cleared, and only when a policy hands us the logout.
  if (input.previous === "cursor" && input.logoutCursor != null) {
    await input.logoutCursor();
    return { previous: input.previous, next: input.next, loggedOut: "cursor", sessionCleared: true };
  }
  return { previous: input.previous, next: input.next, loggedOut: "none", sessionCleared: false };
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
