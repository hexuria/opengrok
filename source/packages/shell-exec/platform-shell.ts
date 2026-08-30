import { existsSync } from "node:fs";
import path from "node:path";
import { findActualExecutable } from "../utils/find-executable.js";

export function getBashPath(userTerminalHint?: string): string | null {
  if (process.platform === "win32") {
    const pathMustMatch = /git.*bash/i;
    if (userTerminalHint && pathMustMatch.test(userTerminalHint)) return userTerminalHint;
    const gitBashPath = findActualExecutable("bash", [], pathMustMatch).cmd;
    if (pathMustMatch.test(gitBashPath)) return gitBashPath;
    return null;
  }
  const shell = process.env.SHELL;
  if (shell?.includes("bash")) return shell;
  return findActualExecutable("bash", []).cmd;
}

export function windowsPathToGitBash(windowsPath: string): string {
  if (process.platform !== "win32") return windowsPath;
  const normalized = path.normalize(windowsPath);
  const driveLetter = normalized[0]?.toLowerCase();
  if (driveLetter && normalized[1] === ":" && normalized[2] === path.sep) {
    return `/${driveLetter}${normalized.slice(2).replace(/\\/g, "/")}`;
  }
  return normalized.replace(/\\/g, "/");
}

export function getPowerShellExecutable(): string {
  if (process.platform !== "win32") {
    const shell = process.env.SHELL;
    if (shell?.includes("pwsh") || shell?.includes("powershell")) return shell;
  }
  let executable = findActualExecutable("pwsh", []).cmd;
  if (executable !== "pwsh") return executable;
  executable = findActualExecutable("powershell", []).cmd;
  if (executable !== "powershell") return executable;
  if (process.platform === "win32") {
    executable = path.join(process.env.SYSTEMROOT!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (existsSync(executable)) return executable;
  }
  throw new Error("Neither 'pwsh' (PowerShell Core) nor 'powershell' (Windows PowerShell) found in PATH");
}

export function getZshPath(): string {
  const shell = process.env.SHELL;
  if (shell?.includes("zsh")) return shell;
  return findActualExecutable("zsh", []).cmd;
}
