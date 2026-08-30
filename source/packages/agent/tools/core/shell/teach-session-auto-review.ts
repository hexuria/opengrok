export const SAND_TEACH_SESSIONS_DIR = "/workspace/teach-sessions";
const TEACH_FRAME_PREFIX = "/tmp/teach_frame";
const PROC_PREFIX = "/proc/";
const DEV_PREFIX = "/dev/";
const ABSOLUTE_PATH = /(?:^|[\s="'`<(])(\/(?:workspace|tmp|proc|home|etc|root|var|opt|usr|dev|bin|sbin)[^\s"'`;|&<>]*|\/(?=$|[\s;|&]))/g;
const ALLOWED_ABSOLUTE_PREFIXES = [
  `${SAND_TEACH_SESSIONS_DIR}/`,
  TEACH_FRAME_PREFIX,
  PROC_PREFIX,
  DEV_PREFIX,
] as const;

function isAllowedTeachAbsolutePath(path: string): boolean {
  if (path === SAND_TEACH_SESSIONS_DIR || path.startsWith(`${SAND_TEACH_SESSIONS_DIR}/`)) return true;
  return ALLOWED_ABSOLUTE_PREFIXES.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix));
}

export function isSandTeachSessionShellCommand(command: string, workingDirectory?: string): boolean {
  const text = workingDirectory == null || workingDirectory.length === 0 ? command : `${workingDirectory}\n${command}`;
  if (!text.includes(SAND_TEACH_SESSIONS_DIR)) return false;
  for (const match of text.matchAll(ABSOLUTE_PATH)) {
    const path = match[1];
    if (path == null || path.length === 0) continue;
    if (!isAllowedTeachAbsolutePath(path)) return false;
  }
  return true;
}

export function failOpenIsolatedBoxClassifierError(surface: "host_machine" | "isolated_box"): boolean {
  return surface === "isolated_box";
}
