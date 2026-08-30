import type { Context } from "../context/core.js";
import type { SubagentBackgroundReason } from "../proto/generated/agent/v1/agent_pb.js";
import {
  SubagentError,
  SubagentResult,
  SubagentSuccess,
  type SubagentArgs,
} from "../proto/generated/agent/v1/subagent_exec_pb.js";
import { SimpleControlledExecHandler } from "./controlled.js";
import { ExecutorResource, type Executor, type ExecutorOptions, type RemoteExecManager } from "./remote.js";
import { createResource, type ControlledExecManager } from "./resource-provider.js";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./serialization.js";

export const RUNNING_SUBAGENT_FOLLOWUP_ERROR =
  "Sub-agent is currently running. You may send the follow-up message when it has completed.";
export const RUNNING_SUBAGENT_INTERRUPT_RETRY_HINT =
  "If you intended to interrupt this agent, you may retry with `interrupt` set to true";

class SubagentHostError extends Error {
  readonly agentId: string | undefined;
  override readonly cause: unknown;

  constructor(message: string, options?: { agentId?: string | undefined; cause?: unknown }) {
    super(message);
    this.name = "SubagentHostError";
    this.agentId = options?.agentId;
    this.cause = options?.cause;
  }
}

interface SubagentRunOutcome {
  status: "success" | "error" | "aborted" | "background";
  error?: string | undefined;
  finalMessage?: string | undefined;
  toolCallCount?: number | undefined;
  backgroundReason?: SubagentBackgroundReason | undefined;
  transcriptPath?: string | undefined;
}

interface SubagentHostAdapter {
  createOrResumeSession(ctx: Context, args: SubagentArgs): Promise<string>;
  runSession(
    ctx: Context,
    agentId: string,
    args: SubagentArgs,
    options: { execId?: string | undefined },
  ): Promise<SubagentRunOutcome>;
  releaseSession?(agentId: string): void;
}

function extractAgentIdFromError(error: unknown): string | undefined {
  if (error instanceof SubagentHostError && error.agentId) {
    return error.agentId;
  }
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const record = error as { agentId?: unknown };
  if (typeof record.agentId === "string") {
    return record.agentId;
  }
  return undefined;
}

function getInFlightKey(args: SubagentArgs): string | undefined {
  if (!args.toolCallId || !args.parentConversationId) {
    return undefined;
  }
  return [
    args.parentConversationId,
    args.toolCallId,
    args.resumeAgentId ?? "",
    args.forkAgentId ?? "",
  ].join("\0");
}

const MAX_COMPLETED_TOOL_CALL_RESULTS = 1_000;

export function createSubagentExecutor(
  adapter: SubagentHostAdapter,
): Executor<SubagentArgs, SubagentResult> {
  const inFlightByToolCall = new Map<string, Promise<SubagentResult>>();
  const completedByToolCall = new Map<string, SubagentResult>();

  async function runExecute(
    ctx: Context,
    args: SubagentArgs,
    options?: ExecutorOptions,
  ): Promise<SubagentResult> {
    let agentId: string | undefined;
    try {
      agentId = await adapter.createOrResumeSession(ctx, args);
      const outcome = await adapter.runSession(ctx, agentId, args, {
        execId: options?.execId,
      });
      if (outcome.status === "error") {
        return new SubagentResult({
          result: {
            case: "error",
            value: new SubagentError({
              agentId,
              error: outcome.error!,
            }),
          },
        });
      }
      if (outcome.status === "aborted") {
        return new SubagentResult({
          result: {
            case: "error",
            value: new SubagentError({
              agentId,
              error: outcome.error ?? "Subagent was aborted by the user",
            }),
          },
        });
      }
      if (outcome.status === "background") {
        return new SubagentResult({
          result: {
            case: "success",
            value: new SubagentSuccess({
              agentId,
              finalMessage: outcome.finalMessage!,
              toolCallCount: outcome.toolCallCount ?? 0,
              backgroundReason: outcome.backgroundReason!,
              transcriptPath: outcome.transcriptPath!,
            }),
          },
        });
      }
      return new SubagentResult({
        result: {
          case: "success",
          value: new SubagentSuccess({
            agentId,
            finalMessage: outcome.finalMessage!,
            toolCallCount: outcome.toolCallCount ?? 0,
          }),
        },
      });
    } catch (error) {
      if (agentId && adapter.releaseSession) {
        adapter.releaseSession(agentId);
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorAgentId = agentId ?? extractAgentIdFromError(error) ?? args.resumeAgentId;
      return new SubagentResult({
        result: {
          case: "error",
          value: new SubagentError({
            ...(errorAgentId ? { agentId: errorAgentId } : {}),
            error: errorMessage,
          }),
        },
      });
    }
  }

  return {
    execute(ctx, args, options) {
      const key = getInFlightKey(args);
      if (key === undefined) {
        return runExecute(ctx, args, options);
      }
      const completed = completedByToolCall.get(key);
      if (completed !== undefined) {
        return Promise.resolve(completed);
      }
      const existing = inFlightByToolCall.get(key);
      if (existing !== undefined) {
        return existing;
      }
      const promise = runExecute(ctx, args, options)
        .then((result) => {
          if (result.result.case === "success") {
            completedByToolCall.set(key, result);
            if (completedByToolCall.size > MAX_COMPLETED_TOOL_CALL_RESULTS) {
              completedByToolCall.delete(completedByToolCall.keys().next().value!);
            }
          }
          return result;
        })
        .finally(() => {
          inFlightByToolCall.delete(key);
        });
      inFlightByToolCall.set(key, promise);
      return promise;
    },
  };
}

export const subagentExecutorResource = createResource<
  Executor<SubagentArgs, SubagentResult>,
  RemoteExecManager,
  ControlledExecManager
>(
  (execManager) =>
    new ExecutorResource(
      execManager,
      createServerSerializer("subagentArgs"),
      createClientDeserializer("subagentResult"),
    ),
  (implementation, controlledExecManager) =>
    controlledExecManager.register(
      new SimpleControlledExecHandler(
        implementation,
        createServerDeserializer("subagentArgs"),
        createClientSerializer("subagentResult"),
      ),
    ),
);
