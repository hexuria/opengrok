export interface Executor<Args = unknown, Result = unknown, Context = unknown, Options = unknown> {
  execute(ctx: Context, args: Args, options?: Options): Promise<Result>;
}
type ConversationArgs = { conversationId?: string };
type SyncArgs = ConversationArgs & { writtenPaths?: readonly string[]; timeoutMs?: number; eager?: boolean };

export function conflictNoticeSyncAndPeek(executor: Executor, ctx: unknown, args?: SyncArgs | null, options?: unknown): Promise<unknown> {
  return executor.execute(ctx, {
    op: "syncAndPeek",
    ...(args?.conversationId !== undefined ? { conversationId: args.conversationId } : {}),
    ...(args?.writtenPaths !== undefined ? { writtenPaths: args.writtenPaths } : {}),
    ...(args?.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    ...(args?.eager === true ? { eager: true } : {}),
  }, options);
}
export function conflictNoticePeek(executor: Executor, ctx: unknown, args?: ConversationArgs | null, options?: unknown): Promise<unknown> {
  return executor.execute(ctx, { op: "peek", ...(args?.conversationId !== undefined ? { conversationId: args.conversationId } : {}) }, options);
}
export async function conflictNoticeAck(executor: Executor, ctx: unknown, eventIds: readonly string[], args?: ConversationArgs | null, options?: unknown): Promise<void> {
  if (eventIds.length === 0) return;
  await executor.execute(ctx, { op: "ack", eventIds, ...(args?.conversationId !== undefined ? { conversationId: args.conversationId } : {}) }, options);
}
export async function conflictNoticeRelease(executor: Executor, ctx: unknown, eventIds: readonly string[], args?: ConversationArgs | null, options?: unknown): Promise<void> {
  if (eventIds.length === 0) return;
  await executor.execute(ctx, { op: "release", eventIds, ...(args?.conversationId !== undefined ? { conversationId: args.conversationId } : {}) }, options);
}
export async function conflictNoticeNoteDeferredEagerWrittenPaths(executor: Executor, ctx: unknown, writtenPaths: readonly string[], args?: ConversationArgs | null, options?: unknown): Promise<void> {
  if (writtenPaths.length === 0) return;
  await executor.execute(ctx, { op: "noteDeferredEagerWrittenPaths", writtenPaths, ...(args?.conversationId !== undefined ? { conversationId: args.conversationId } : {}) }, options);
}

export class RemoteAgentStoreConflictNoticeStub implements Executor<Record<string, unknown>, Record<string, unknown>> {
  async execute(_ctx: unknown, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (args.op === "ack") return { kind: "acked", count: 0 };
    if (args.op === "release") return { kind: "released", count: 0 };
    if (args.op === "noteDeferredEagerWrittenPaths") return { kind: "noted", count: 0 };
    return { kind: "not-applicable" };
  }
}

export const agentStoreConflictNoticeExecutorResource = createResource(
  (_remote: unknown) => new RemoteAgentStoreConflictNoticeStub(),
  (_implementation: RemoteAgentStoreConflictNoticeStub, _controlled: unknown) => {},
);
import { createResource } from "./resource-provider.js";
