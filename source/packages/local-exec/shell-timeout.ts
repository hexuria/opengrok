import { TimeoutBehavior } from "../proto/generated/agent/v1/shell_exec_pb.js";

export const DEFAULT_SHELL_FOREGROUND_TIMEOUT_MS = 30_000;
export function resolveShellTimeoutMs(args: { timeout: number; isBackground: boolean; timeoutBehavior?: TimeoutBehavior; hardTimeout?: number }): number {
  if (args.timeout !== 0) return args.timeout;
  if (args.isBackground || args.timeoutBehavior === TimeoutBehavior.BACKGROUND || (args.hardTimeout !== undefined && args.hardTimeout > 0)) return 0;
  return DEFAULT_SHELL_FOREGROUND_TIMEOUT_MS;
}
