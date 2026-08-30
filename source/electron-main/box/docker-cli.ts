import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DOCKER_CLI_NOT_FOUND = "Docker CLI not found. Grok Bot is a GUI app, so it cannot see a shell-only PATH. Install Docker Desktop or set DOCKER_BIN to the docker executable.";

export function dockerCliCandidates(env: NodeJS.ProcessEnv = process.env, homeDir = homedir()): string[] {
  const configured = env.DOCKER_BIN?.trim();
  return [
    ...(configured != null && configured.length > 0 ? [configured] : []),
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    "/Applications/Docker.app/Contents/Resources/bin/docker",
    join(homeDir, ".docker", "bin", "docker"),
  ];
}

export function dockerSearchPath(env: NodeJS.ProcessEnv = process.env, homeDir = homedir()): string {
  const configured = env.DOCKER_BIN?.trim();
  const directories = [
    ...(configured != null && configured.length > 0 ? [dirname(configured)] : []),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/Applications/Docker.app/Contents/Resources/bin",
    join(homeDir, ".docker", "bin"),
    env.PATH ?? "",
  ].filter((directory) => directory.length > 0);
  return [...new Set(directories)].join(":");
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
