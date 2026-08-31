import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export interface LocalInferenceCliStatus {
  readonly installed: boolean;
  readonly authenticated: boolean;
  readonly executablePath: string | null;
  readonly prompt?: string;
}

function firstExecutable(candidates: readonly (string | undefined)[]): string | null {
  for (const candidate of candidates) if (candidate != null && candidate.length > 0 && existsSync(candidate)) return candidate;
  return null;
}

/**
 * Windows executables carry a suffix the POSIX name never has: native
 * installers ship `name.exe`, npm shims ship `name.cmd`. A bare-name
 * existsSync check finds neither, which is how "installed" CLIs read as
 * missing on Windows.
 */
export function executableNameVariants(name: string, platform: NodeJS.Platform = process.platform): string[] {
  return platform === "win32" ? [`${name}.exe`, `${name}.cmd`, name] : [name];
}

function named(directories: readonly string[], name: string): string[] {
  const variants = executableNameVariants(name);
  return directories.flatMap(directory => variants.map(variant => join(directory, variant)));
}

function pathCandidates(name: string): string[] {
  return named((process.env.PATH ?? "").split(delimiter).filter(Boolean), name);
}

/** Version-manager shim dirs; a Finder-launched app never has these on PATH. */
function shimCandidates(name: string): string[] {
  const home = homedir();
  return named([join(home, ".nodenv", "shims"), join(home, ".asdf", "shims"), join(home, ".volta", "bin")], name);
}

export function resolveCodexCliPath(): string | null {
  const home = homedir();
  return firstExecutable([process.env.CODEX_PATH, ...named([join(home, ".local", "bin"), join(home, ".codex", "bin")], "codex"), ...pathCandidates("codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex", ...shimCandidates("codex")]);
}

export function resolveClaudeCodeCliPath(): string | null {
  const home = homedir();
  return firstExecutable([process.env.CLAUDE_CODE_PATH, ...named([join(home, ".local", "bin"), join(home, ".claude", "local")], "claude"), ...pathCandidates("claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude", ...shimCandidates("claude")]);
}

export function hasUsableCodexLogin(path: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    // POSIX-only privacy check: Node synthesizes mode on Windows (0o666-ish
    // for every file), so the group/other-bits test would reject every valid
    // auth.json there. Windows relies on the profile directory's ACLs.
    if (platform !== "win32" && (stat.mode & 0o077) !== 0) return false;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    return parsed.auth_mode === "chatgpt"
      && typeof parsed.tokens?.access_token === "string" && parsed.tokens.access_token.length > 0
      && typeof parsed.tokens?.refresh_token === "string" && parsed.tokens.refresh_token.length > 0
      && typeof parsed.tokens?.id_token === "string" && parsed.tokens.id_token.length > 0
      && typeof parsed.tokens?.account_id === "string" && parsed.tokens.account_id.length > 0;
  } catch { return false; }
}

export function getLocalInferenceCliStatus(): { readonly codex: LocalInferenceCliStatus; readonly "claude-code": LocalInferenceCliStatus } {
  const home = homedir();
  const codexPath = resolveCodexCliPath();
  const claudePath = resolveClaudeCodeCliPath();
  const codexAuthPath = join(process.env.CODEX_HOME?.trim() || join(home, ".codex"), "auth.json");
  const hasCodexAuthFile = existsSync(codexAuthPath);
  const hasCodexLogin = hasUsableCodexLogin(codexAuthPath);
  return {
    // Codex inference is a Grok Bot-owned HTTP transport authenticated by the
    // existing Codex login. The CLI binary is not in the request path.
    codex: { installed: hasCodexAuthFile, authenticated: hasCodexLogin, executablePath: codexPath },
    "claude-code": { installed: claudePath != null, authenticated: existsSync(join(home, ".claude", ".credentials.json")), executablePath: claudePath },
  };
}
