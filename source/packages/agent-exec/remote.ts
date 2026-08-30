import type { Context } from "../context/core.js";
import { createSpan, getSpanContextData } from "../context/otel.js";
import { createCounter } from "../metrics/index.js";
import { ExecClientMessage, ExecServerMessage, SpanContext } from "../proto/generated/agent/v1/exec_pb.js";
import type { HookAdditionalContext } from "../proto/generated/agent/v1/hook_additional_context_pb.js";
import { getFirstItem } from "../utils/async-iterator.js";

const logger = {
  name: "ExecutorResource",
  info(_ctx: Context, message: string, metadata: unknown): void {
    console.info(message, metadata);
  },
};
const hookAdditionalContextDelivered = createCounter("agent_exec.hook_additional_context.delivered", {
  description: "Hook additional_context carriers drained into the caller collector",
  labelNames: ["hook_event_name"],
});

export interface ExecutorOptions {
  execId?: string | undefined;
  hookContextCollector?: HookAdditionalContext[];
  deliverAgentStoreConflictNotices?: boolean;
  enableAgentStoreConflictNotices?: boolean;
}
export interface Executor<Args, Result> { execute(ctx: Context, args: Args, options?: ExecutorOptions): Promise<Result> }
export interface StreamExecutor<Args, Event> { execute(ctx: Context, args: Args, options?: ExecutorOptions): AsyncIterable<Event> }
export interface RemoteExecManager {
  createExecInstance(ctx: Context, createMessage: (id: number) => ExecServerMessage): AsyncIterable<ExecClientMessage>;
}

export class ExecutorResource<Args, Result> implements Executor<Args, Result> {
  constructor(
    private readonly execManager: RemoteExecManager,
    private readonly serializeArgs: (id: number, args: Args) => Pick<ExecServerMessage, "id" | "message">,
    private readonly deserializeResult: (message: ExecClientMessage) => Result | undefined,
  ) {}

  async execute(parentCtx: Context, args: Args, options?: ExecutorOptions): Promise<Result> {
    using span = createSpan(parentCtx.withName("ExecutorResource.execute"));
    const ctx = span.ctx;
    if (options?.execId !== undefined) span.span.setAttribute("exec.id", options.execId);
    const spanContextData = getSpanContextData(ctx);
    const spanContext = spanContextData ? new SpanContext(spanContextData) : undefined;
    const messageStream = this.execManager.createExecInstance(ctx, (id) => {
      const serialized = this.serializeArgs(id, args);
      return new ExecServerMessage({
        id: serialized.id,
        message: serialized.message,
        execId: options?.execId!,
        spanContext: spanContext!,
        acceptHookAdditionalContexts: options?.hookContextCollector !== undefined,
      });
    });
    const initial = await getFirstItem(messageStream);
    if (initial === undefined) throw new Error("No exec result");
    let result = initial.firstItem;
    let rest = initial.rest;
    const collect = (message: ExecClientMessage): void => {
      const carriers = message.hookAdditionalContexts;
      if (options?.hookContextCollector !== undefined && carriers.length > 0) {
        options.hookContextCollector.push(...carriers);
        for (const carrier of carriers) {
          hookAdditionalContextDelivered.increment(ctx, 1, {
            hook_event_name: carrier.hookEventName,
          });
        }
      }
    };
    collect(result);
    let value = this.deserializeResult(result);
    while (value === undefined) {
      const next = await getFirstItem(rest);
      if (next === undefined) throw new Error("No result value");
      result = next.firstItem;
      rest = next.rest;
      collect(result);
      value = this.deserializeResult(result);
    }
    void (async () => {
      try {
        for await (const message of rest) collect(message);
      } catch (error) {
        logger.info(ctx, "Ignoring exec stream shutdown during detached drain", { error });
      }
    })().catch(() => {});
    return value;
  }
}

export class StreamExecutorResource<Args, Event> implements StreamExecutor<Args, Event> {
  constructor(
    private readonly execManager: RemoteExecManager,
    private readonly serializeArgs: (id: number, args: Args) => Pick<ExecServerMessage, "id" | "message">,
    private readonly deserializeStream: (message: ExecClientMessage) => Event | undefined,
  ) {}

  async *execute(parentCtx: Context, args: Args, options?: ExecutorOptions): AsyncIterable<Event> {
    using span = createSpan(parentCtx.withName("StreamExecutorResource.execute"));
    const ctx = span.ctx;
    const spanContextData = getSpanContextData(ctx);
    const spanContext = spanContextData ? new SpanContext(spanContextData) : undefined;
    const messageStream = this.execManager.createExecInstance(ctx, (id) => {
      const serialized = this.serializeArgs(id, args);
      return new ExecServerMessage({
        id: serialized.id,
        message: serialized.message,
        execId: options?.execId!,
        spanContext: spanContext!,
        acceptHookAdditionalContexts: options?.hookContextCollector !== undefined || options?.deliverAgentStoreConflictNotices === true,
      });
    });
    for await (const message of messageStream) {
      const carriers = message.hookAdditionalContexts;
      if (options?.hookContextCollector !== undefined && carriers.length > 0) options.hookContextCollector.push(...carriers);
      const value = this.deserializeStream(message);
      if (value !== undefined) yield value;
    }
  }
}
