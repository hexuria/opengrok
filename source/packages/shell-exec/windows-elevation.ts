import { existsSync } from "node:fs";
// win32 explicitly: this code only ever runs on Windows, and building the
// paths with the host's separators would produce nonsense when the logic is
// exercised from macOS or Linux (as the tests and CI matrix do).
import { win32 } from "node:path";

/**
 * Elevation on Windows, which is a different problem from POSIX sudo.
 *
 * UAC draws its consent prompt on the secure desktop: no application can
 * render it, read it, or answer it. So there is no password to intercept and
 * no card to show - the user's click on the real UAC dialog IS the consent,
 * and that prompt is unavoidable by design.
 *
 * What we can choose is how the elevated process is launched. Windows Sudo
 * (Windows 11 24H2 and later) has an `--inline` mode that keeps the child on
 * the current console, so stdout and stderr come back to the caller. The
 * older `Start-Process -Verb RunAs` route elevates but inherits no stdio, so
 * an agent gets no output at all - useless for the thing an agent is for.
 * Rather than fake that with temp-file capture we cannot verify, an absent
 * Windows Sudo is reported as an actionable failure.
 */

export type WindowsElevationPlan =
  | { readonly kind: "elevate"; readonly command: string }
  | { readonly kind: "unavailable"; readonly reason: string };

export const WINDOWS_SUDO_MISSING_REASON =
  "This command needs administrator rights, and Windows Sudo is not available. "
  + "Enable it in Settings > System > For developers > Enable sudo (Windows 11 24H2 or later), "
  + "then try again. Without it an elevated command cannot return its output.";

/** Locates Windows Sudo (`sudo.exe`) the way a GUI app must: without a shell PATH. */
export function findWindowsSudo(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const system32 = win32.join(env.SystemRoot ?? "C:\\Windows", "System32", "sudo.exe");
  if (exists(system32)) return system32;
  for (const directory of (env.PATH ?? env.Path ?? "").split(";").filter(Boolean)) {
    const candidate = win32.join(directory, "sudo.exe");
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** True when the command's first word is `sudo`, the POSIX spelling agents use. */
export function commandRequestsElevation(command: string): boolean {
  return /^\s*sudo(\s|$)/.test(command);
}

/**
 * Rewrites a `sudo ...` command for Windows. `--inline` is what keeps the
 * elevated child attached to this console so its output is still captured;
 * UAC still prompts, which is the point.
 */
export function planWindowsElevation(command: string, sudoPath: string | null): WindowsElevationPlan {
  if (!commandRequestsElevation(command)) return { kind: "elevate", command };
  if (sudoPath == null) return { kind: "unavailable", reason: WINDOWS_SUDO_MISSING_REASON };
  const rest = command.replace(/^\s*sudo\s*/, "");
  if (rest.trim().length === 0) return { kind: "unavailable", reason: "`sudo` needs a command to run." };
  return { kind: "elevate", command: `& ${JSON.stringify(sudoPath)} --inline ${rest}` };
}

/** PowerShell that fails the turn with the reason, instead of a confusing error. */
export function windowsElevationFailureCommand(reason: string): string {
  return `Write-Error ${JSON.stringify(reason)}; exit 1`;
}
