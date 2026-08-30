import { filterElectronEnv } from "../env-filter.js";
import { getSandboxCacheEnv } from "./cache-env.js";
import { SandboxUnsupportedError } from "./errors.js";
import { getLastSandboxFailureReason, isSandboxHelperSupported, spawnWithSandboxHelper, type SandboxHelperPolicy } from "./helper-support.js";
import { spawnUnsafe } from "./unsafe-spawn.js";
import type { SpawnOptions, ChildProcess } from "node:child_process";

export type SandboxExecutionPolicy = SandboxHelperPolicy;

export function spawnInSandbox(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
  sandboxPolicy: SandboxExecutionPolicy,
): ChildProcess {
  options.env = filterElectronEnv(options.env);
  if (sandboxPolicy.enableSharedBuildCache) {
    options = {
      ...options,
      env: {
        ...filterElectronEnv(process.env),
        ...getSandboxCacheEnv(),
        ...options.env,
      },
    };
  }
  if (sandboxPolicy.type !== "insecure_none") {
    if (isSandboxHelperSupported()) {
      return spawnWithSandboxHelper(command, args, options, sandboxPolicy);
    }
    const failureReason = getLastSandboxFailureReason();
    throw new SandboxUnsupportedError(
      `Sandbox policy '${sandboxPolicy.type}' is not supported on this system. Ensure the sandbox helper binary is available, or use 'insecure_none'. Reason: ${failureReason || "unknown"}`,
      failureReason ?? undefined,
    );
  }
  return spawnUnsafe(command, args, options);
}
