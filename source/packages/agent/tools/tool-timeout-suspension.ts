import { createKey, type Context } from "../../context/core.js";

export interface ToolExecutionTimeoutSuspension { suspend(): () => void }
export const toolExecutionTimeoutSuspensionKey = createKey<ToolExecutionTimeoutSuspension | undefined>(Symbol("toolExecutionTimeoutSuspension"), undefined);
export async function withToolExecutionTimeoutSuspended<T>(ctx: Context, fn: () => T | Promise<T>): Promise<T> {
  const suspension = ctx.get(toolExecutionTimeoutSuspensionKey);
  if (suspension === undefined) return await fn();
  const resume = suspension.suspend();
  try { return await fn(); } finally { resume(); }
}
