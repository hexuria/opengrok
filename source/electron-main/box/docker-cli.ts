import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export const DOCKER_CLI_NOT_FOUND = "Docker CLI not found. Grok Bot is a GUI app, so it cannot see a shell-only PATH. Install Docker Desktop or set DOCKER_BIN to the docker executable.";

// Candidates are built for a *stated* platform (defaulting to the current
// one) with that platform's own separators, so tests can pin any OS and the
// results are identical no matter which OS runs them.
function pathToolkit(platform: NodeJS.Platform): { join: (...parts: string[]) => string; dirname: (target: string) => string; envSeparator: string } {
  const api = platform === "win32" ? win32 : posix;
  return { join: api.join, dirname: api.dirname, envSeparator: platform === "win32" ? ";" : ":" };
}

function dockerExecutableName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "docker.exe" : "docker";
}

/** GUI-app-safe install locations, per platform, before any PATH scan. */
function dockerDirectories(env: NodeJS.ProcessEnv, homeDir: string, platform: NodeJS.Platform): string[] {
  const { join } = pathToolkit(platform);
  if (platform === "win32") {
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    return [join(programFiles, "Docker", "Docker", "resources", "bin"), join(homeDir, ".docker", "bin")];
  }
  if (platform === "darwin") {
    return ["/usr/local/bin", "/opt/homebrew/bin", "/Applications/Docker.app/Contents/Resources/bin", join(homeDir, ".docker", "bin")];
  }
  // Linux: apt/dnf put docker in /usr/bin, snap in /snap/bin.
  return ["/usr/bin", "/usr/local/bin", "/snap/bin", join(homeDir, ".docker", "bin")];
}

export function dockerCliCandidates(env: NodeJS.ProcessEnv = process.env, homeDir = homedir(), platform: NodeJS.Platform = process.platform): string[] {
  const configured = env.DOCKER_BIN?.trim();
  const { join, envSeparator } = pathToolkit(platform);
  const name = dockerExecutableName(platform);
  const pathDirectories = (env.PATH ?? "").split(envSeparator).filter(Boolean);
  return [
    ...(configured != null && configured.length > 0 ? [configured] : []),
    ...dockerDirectories(env, homeDir, platform).map((directory) => join(directory, name)),
    ...pathDirectories.map((directory) => join(directory, name)),
  ];
}

export function dockerSearchPath(env: NodeJS.ProcessEnv = process.env, homeDir = homedir(), platform: NodeJS.Platform = process.platform): string {
  const configured = env.DOCKER_BIN?.trim();
  const { dirname, envSeparator } = pathToolkit(platform);
  const directories = [
    ...(configured != null && configured.length > 0 ? [dirname(configured)] : []),
    ...dockerDirectories(env, homeDir, platform),
    env.PATH ?? "",
  ].filter((directory) => directory.length > 0);
  return [...new Set(directories)].join(envSeparator);
}

/**
 * When `docker info` fails the raw output is opaque — a person just sees the
 * box never come up. The most common cause on macOS is that Docker Desktop is
 * installed but its Linux engine is not running: the CLI answers, the socket
 * exists, and every call returns a 500. This tells that apart from a genuinely
 * absent Docker so the message can be actionable, and so the app can offer to
 * start the engine rather than spin forever.
 */
export type DockerUnavailableKind = "cli-missing" | "engine-down" | "not-installed";

export const DOCKER_DESKTOP_APP = "/Applications/Docker.app";

export function classifyDockerUnavailable(output: string, hasDesktopApp: boolean): { readonly kind: DockerUnavailableKind; readonly message: string } {
  if (output.includes(DOCKER_CLI_NOT_FOUND) || /Docker is not installed/i.test(output)) {
    return { kind: "cli-missing", message: DOCKER_CLI_NOT_FOUND };
  }
  // The CLI ran and could not reach a working engine. On a machine with Docker
  // Desktop that means the app is open but its VM has not finished starting (or
  // has wedged); the fix is to start or restart it.
  if (hasDesktopApp) {
    return {
      kind: "engine-down",
      message: "Docker Desktop is installed but its engine isn't running. Open Grok is starting Docker Desktop — give it a moment to finish booting, then the local computer will connect. If it stays stuck, quit Docker Desktop from its menu-bar icon and reopen it.",
    };
  }
  return {
    kind: "not-installed",
    message: "Docker is installed but its engine isn't responding. Start your Docker engine (or install Docker Desktop), then try the local computer again.",
  };
}
