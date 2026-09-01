import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

/**
 * The artifact-private process forwarding branch used only for an explicit
 * `insecure_none` policy. It is intentionally not exported from the package
 * root and is not selected by any recovered caller.
 */
export function spawnUnsafe(command: string, args: readonly string[] = [], options: SpawnOptions = {}): ChildProcess {
  // Never flash a console window on Windows for background shell work.
  return spawn(command, args, { windowsHide: true, ...options });
}
