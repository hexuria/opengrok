import { homedir } from "node:os";
import { join } from "node:path";

export const HASH_LENGTH = 7;
export const MAX_SOCKET_PATH_LENGTH = 104;
export const WINDOWS_SOCK_LENGTH = "worker.sock".length;
export const MAX_PREFIX_LENGTH_BEFORE_HASH = MAX_SOCKET_PATH_LENGTH - 1 - HASH_LENGTH - 1 - WINDOWS_SOCK_LENGTH;
export const MAX_FULL_PATH_LENGTH = MAX_SOCKET_PATH_LENGTH - WINDOWS_SOCK_LENGTH - 1;

export function getConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CURSOR_CONFIG_DIR;
  if (override?.trim()) return override;
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg?.trim()) return join(xdg, "cursor");
  return join(homedir(), ".cursor");
}
