import type { Context } from "../context/core.js";
import { appendGitDiagnostics } from "../git-core/diagnostics.js";
import { createCounter, createHistogram } from "../metrics/index.js";
import { createWritableIterable, WriteIterableClosedError } from "../utils/writable-iterable.js";
import type { RegisteredControlledResource } from "./resource-provider.js";
import {
  ExecClientControlMessage,
  ExecClientHeartbeat,
  ExecClientMessage,
  ExecClientStreamClose,
  ExecClientThrow,
  ExecServerMessage,
} from "../proto/generated/agent/v1/exec_pb.js";
import type { ExecServerControlMessage } from "../proto/generated/agent/v1/agent_service_pb.js";
import type { HookAdditionalContext } from "../proto/generated/agent/v1/hook_additional_context_pb.js";

const logger = {
  name: "SimpleControlledExecManager",
  error(_ctx: Context, message: string, error: unknown): void {
    console.error(message, error);
  },
};
const AGENT_STORE_CONFLICT_HOOK_EVENT_NAME = "agentStoreConflict";
const EXEC_HEARTBEAT_INTERVAL_MS = 3_000;

const controlledExecDuration = createHistogram("agent_exec.controlled.exec.duration_ms", {
  description: "Duration of controlled exec operations in milliseconds",
  labelNames: ["exec_case"],
});
const controlledExecSuccess = createCounter("agent_exec.controlled.exec.success", {
  description: "Count of successful controlled exec operations",
  labelNames: ["exec_case"],
});
const controlledExecError = createCounter("agent_exec.controlled.exec.error", {
  description: "Count of failed controlled exec operations",
  labelNames: ["exec_case"],
});

export class ControlledExecDisposedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlledExecDisposedError";
  }
}

function getExecClientErrorCode(error: unknown): string | undefined {
  if (error instanceof ControlledExecDisposedError) return "EXEC_BACKEND_UNAVAILABLE";
  if (error instanceof Error && error.name === "AgentExecStreamStartTimeoutError") return "AGENT_EXEC_STREAM_START_TIMEOUT";
  return undefined;
}

export interface ControlledExecutor<Args, Result> {
  execute(ctx: Context, args: Args, options: { execId?: string | undefined; hookContextCollector: HookAdditionalContext[]; deliverAgentStoreConflictNotices: boolean }): Promise<Result>;
}
export interface ControlledStreamExecutor<Args, Event> {
  execute(ctx: Context, args: Args, options: { execId?: string | undefined; hookContextCollector: HookAdditionalContext[]; deliverAgentStoreConflictNotices: boolean }): AsyncIterable<Event>;
}

export interface ControlledExecHandler {
  handle(ctx: Context, message: ExecServerMessage): AsyncIterable<ExecClientMessage> | undefined;
}

export class SimpleControlledExecHandler<Args, Result> {
  constructor(
    private readonly exec: ControlledExecutor<Args, Result>,
    private readonly deserializeArgs: (message: ExecServerMessage) => { id: number; args: Args } | undefined,
    private readonly serializeResult: (id: number, result: Result) => ExecClientMessage,
  ) {}
  handle(ctx: Context, serverMessage: ExecServerMessage): AsyncIterable<ExecClientMessage> | undefined {
    const decoded = this.deserializeArgs(serverMessage);
    if (decoded === undefined) return undefined;
    const self = this;
    return (async function* () {
      const start = performance.now();
      const hookContextCollector: HookAdditionalContext[] = [];
      const result = await self.exec.execute(ctx, decoded.args, {
        execId: serverMessage.execId as string | undefined,
        hookContextCollector,
        deliverAgentStoreConflictNotices: serverMessage.acceptHookAdditionalContexts === true,
      });
      const message = self.serializeResult(decoded.id, result);
      message.localExecutionTimeMs = Math.round(Math.max(0, performance.now() - start));
      if (hookContextCollector.length > 0) message.hookAdditionalContexts = hookContextCollector;
      yield message;
    })();
  }
}

export class SimpleControlledStreamExecHandler<Args, Event> {
  constructor(
    private readonly exec: ControlledStreamExecutor<Args, Event>,
    private readonly deserializeArgs: (message: ExecServerMessage) => { id: number; args: Args } | undefined,
    private readonly serializeStream: (id: number, event: Event) => ExecClientMessage,
  ) {}
  handle(ctx: Context, serverMessage: ExecServerMessage): AsyncIterable<ExecClientMessage> | undefined {
    const decoded = this.deserializeArgs(serverMessage);
    if (decoded === undefined) return undefined;
    const self = this;
    return (async function* () {
      const start = performance.now();
      const hookContextCollector: HookAdditionalContext[] = [];
      try {
        for await (const event of self.exec.execute(ctx, decoded.args, {
          execId: serverMessage.execId as string | undefined,
          hookContextCollector,
          deliverAgentStoreConflictNotices: serverMessage.acceptHookAdditionalContexts === true,
        })) {
          const message = self.serializeStream(decoded.id, event);
          message.localExecutionTimeMs = Math.round(Math.max(0, performance.now() - start));
          yield message;
        }
      } finally {
        const conflicts = hookContextCollector.filter((candidate) => candidate.hookEventName === AGENT_STORE_CONFLICT_HOOK_EVENT_NAME);
        if (conflicts.length > 0) yield new ExecClientMessage({ id: decoded.id, hookAdditionalContexts: conflicts });
      }
    })();
  }
}

export interface ControlledResourceRegistry {
  entries(): Array<readonly [RegisteredControlledResource, unknown]>;
}

export interface SimpleControlledExecManagerOptions {
  includeGitStderrInThrows?: boolean | (() => boolean);
}

export class SimpleControlledExecManager {
  private readonly handlers: ControlledExecHandler[] = [];
  private readonly runningExecs = new Map<number, (reason?: unknown) => void>();
  private readonly includeGitStderrInThrows: () => boolean;

  constructor(options?: SimpleControlledExecManagerOptions) {
    const includeStderr = options?.includeGitStderrInThrows !== undefined ? options.includeGitStderrInThrows : false;
    this.includeGitStderrInThrows = typeof includeStderr === "function" ? includeStderr : () => includeStderr;
  }

  register(handler: ControlledExecHandler): void {
    this.handlers.push(handler);
  }

  handleControlMessage(serverMessage: ExecServerControlMessage): void {
    if (serverMessage.message.case === "abort") {
      const id = (serverMessage.message.value as { id: number }).id;
      this.runningExecs.get(id)?.();
    }
  }

  handle(ctx: Context, serverMessage: ExecServerMessage): AsyncIterable<ExecClientMessage | ExecClientControlMessage> {
    const [execCtx, execCtxCancel] = ctx.withCancel();
    this.runningExecs.set(serverMessage.id, execCtxCancel);
    const execCase = serverMessage.message.case !== undefined ? serverMessage.message.case : "unknown";

    for (const handler of this.handlers) {
      const result = handler.handle(execCtx, serverMessage);
      if (result === undefined) continue;

      const outputStream = createWritableIterable<ExecClientMessage | ExecClientControlMessage>();
      let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
      const scheduleHeartbeat = (): void => {
        heartbeatTimer = setTimeout(() => {
          outputStream.write(new ExecClientControlMessage({
            message: { case: "heartbeat", value: new ExecClientHeartbeat({ id: serverMessage.id }) },
          })).then(scheduleHeartbeat).catch(() => {});
        }, EXEC_HEARTBEAT_INTERVAL_MS);
      };
      scheduleHeartbeat();
      const startTime = performance.now();

      const run = async (): Promise<void> => {
        try {
          for await (const message of result) await outputStream.write(message);
          await outputStream.write(new ExecClientControlMessage({
            message: { case: "streamClose", value: new ExecClientStreamClose({ id: serverMessage.id }) },
          }));
          controlledExecSuccess.increment(execCtx, 1, { exec_case: execCase });
        } catch (error) {
          if (error instanceof WriteIterableClosedError) return;
          controlledExecError.increment(execCtx, 1, { exec_case: execCase });
          const stackTrace = error instanceof Error ? error.stack : undefined;
          const errorCode = getExecClientErrorCode(error);
          await outputStream.write(new ExecClientControlMessage({
            message: {
              case: "throw",
              value: new ExecClientThrow({
                id: serverMessage.id,
                error: error instanceof Error
                  ? appendGitDiagnostics(error.message, error, { includeStderr: this.includeGitStderrInThrows() })
                  : "Unknown error",
                ...(stackTrace !== undefined ? { stackTrace } : {}),
                ...(errorCode !== undefined ? { errorCode } : {}),
              }),
            },
          }));
        } finally {
          controlledExecDuration.histogram(execCtx, performance.now() - startTime, { exec_case: execCase });
          clearTimeout(heartbeatTimer);
          outputStream.close();
          this.runningExecs.delete(serverMessage.id);
        }
      };
      void run();
      return outputStream;
    }

    this.runningExecs.delete(serverMessage.id);
    const errorMessage = `No handler found for server message of type ${serverMessage.message.case}`;
    logger.error(ctx, errorMessage, { messageCase: serverMessage.message.case });
    controlledExecError.increment(ctx, 1, { exec_case: execCase });
    return (async function* () {
      yield new ExecClientControlMessage({ message: { case: "throw", value: new ExecClientThrow({ id: serverMessage.id, error: errorMessage }) } });
      yield new ExecClientControlMessage({ message: { case: "streamClose", value: new ExecClientStreamClose({ id: serverMessage.id }) } });
    })();
  }

  static fromResources(resources: ControlledResourceRegistry, options?: SimpleControlledExecManagerOptions): SimpleControlledExecManager {
    const execManager = new SimpleControlledExecManager(options);
    for (const [resource, implementation] of resources.entries()) {
      resource.registerControlledImplementation(implementation, execManager);
    }
    return execManager;
  }
}
