import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

/**
 * The artifact-private process forwarding branch used only for an explicit
 * `insecure_none` policy. It is intentionally not exported from the package
 * root and is not selected by any recovered caller.
 */
export function spawnUnsafe(command: string, args: readonly string[] = [], options: SpawnOptions = {}): ChildProcess {
  return spawn(command, args, options);
}
