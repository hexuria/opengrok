import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import grayMatter from "gray-matter";
import { Piscina } from "piscina";
import yaml from "js-yaml";
import { z } from "zod";

import { readExecutorResource } from "../../../../agent-exec/read.js";
import type { ResourceAccessor } from "../../../../agent-exec/resource-provider.js";
import type { RemoteExecManager } from "../../../../agent-exec/remote.js";
import type { Context } from "../../../../context/core.js";
import { createLogger } from "../../../../context/logger.js";
import { PrivacyCapability } from "../../../../redaction/classification.js";
import { fromRedactedTodoItem } from "../../../../redacted-protos/generated/agent/v1/todo_tool_redacted.js";
import { PlanRegistryEntry } from "../../../../proto/generated/agent/v1/agent_pb.js";
import { ReadArgs } from "../../../../proto/generated/agent/v1/read_exec_pb.js";
import { performWrite } from "../edit/common.js";
import { calculateDiff, type DiffWorkerInput, type DiffWorkerResult } from "../edit/diff-worker.js";
import { resolveWorkerLocation } from "../worker-script-location.js";
import { generateSeededUuid } from "../../common.js";
import { todoStatusToString } from "../todo/common.js";

const logger = createLogger("@anysphere/agent:backend-plan-utils");

export const planTodoFrontmatterSchema = z.object({
  id: z.string(),
  status: z.unknown().optional(),
}).passthrough();

export const planPhaseFrontmatterSchema = z.object({
  todos: z.array(z.unknown()).optional(),
}).passthrough();

export const planFrontmatterSchema = z.object({
  todos: z.array(z.unknown()).optional(),
  phases: z.array(z.unknown()).optional(),
}).passthrough();

const planFrontmatterStringifyOptions: Parameters<typeof yaml.safeDump>[1] = {
  indent: 2,
  lineWidth: -1,
};

export function stringifyPlanFrontmatter(
  content: string,
  data: Record<string, unknown>,
): string {
  const frontmatter = yaml.safeDump(data, planFrontmatterStringifyOptions).trim();
  const normalizedContent = content.endsWith("\n") ? content : `${content}\n`;
  if (frontmatter === "{}") return normalizedContent;
  return `---\n${frontmatter}\n---\n${normalizedContent}`;
}

export interface PlanRegistryState {
  readonly plans: ReadonlyMap<string, PlanRegistryEntry>;
}

export function getLatestPlanRegistryEntry(
  stateHandler: PlanRegistryState,
): PlanRegistryEntry | undefined {
  let latestPlanEntry: PlanRegistryEntry | undefined;
  for (const planEntry of stateHandler.plans.values()) {
    latestPlanEntry = planEntry;
  }
  return latestPlanEntry;
}

export interface TodoStateReference {
  get(ctx: Context): Promise<Parameters<typeof fromRedactedTodoItem>[0]>;
}

export interface TodoStateForPlanSync {
  readonly todos: readonly TodoStateReference[];
}

export async function buildTodoStatusMap(
  ctx: Context,
  stateHandler: TodoStateForPlanSync,
): Promise<ReadonlyMap<string, string>> {
  const todoStatuses = new Map<string, string>();
  for (const todoRef of stateHandler.todos) {
    const todo = fromRedactedTodoItem(
      await todoRef.get(ctx),
      PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
      undefined,
    );
    todoStatuses.set(todo.id, todoStatusToString(todo.status));
  }
  return todoStatuses;
}

export function updateTodoStatusArray(
  todos: readonly unknown[],
  todoStatuses: ReadonlyMap<string, string>,
): { readonly didUpdate: boolean; readonly updatedTodos: unknown[] } {
  let didUpdate = false;
  const updatedTodos = todos.map(todo => {
    const parsedTodo = planTodoFrontmatterSchema.safeParse(todo);
    if (!parsedTodo.success) return todo;
    const nextStatus = todoStatuses.get(parsedTodo.data.id);
    if (nextStatus === undefined || parsedTodo.data.status === nextStatus) return todo;
    didUpdate = true;
    return { ...parsedTodo.data, status: nextStatus };
  });
  return { didUpdate, updatedTodos };
}

export interface PlanSyncStateHandler extends TodoStateForPlanSync, PlanRegistryState {
  readonly mode: Parameters<typeof import("../edit/plan-mode-file-policy.js").assertPlanModeAllowsFileEdit>[1]["mode"];
  setTodos(todos: readonly unknown[]): void;
  recordFileState(path: string, content: string | undefined, previousContent: string | undefined): void;
}

const DIFF_SIZE_THRESHOLD = 256 * 1024;
const workerModuleUrl = typeof __filename === "string"
  ? pathToFileURL(__filename).href
  : import.meta.url;
const { dir: workerDir, extension: workerExtension } = resolveWorkerLocation(workerModuleUrl, "diff-worker");
const sanitizedEnvForWorkers = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key !== "NSOLID_STATSD" && value !== undefined));
let piscinaWorkerPool: Piscina | undefined;

function getPiscinaWorkerPool(): Piscina {
  if (piscinaWorkerPool === undefined) {
    const threads = Math.max(1, Math.floor(os.availableParallelism() / 2));
    piscinaWorkerPool = new Piscina({
      minThreads: threads,
      maxThreads: threads,
      ...(workerExtension === "ts" ? { execArgv: ["--experimental-strip-types"] } : {}),
      env: sanitizedEnvForWorkers,
    });
  }
  return piscinaWorkerPool;
}

async function getDiffString(input: DiffWorkerInput): Promise<DiffWorkerResult> {
  const totalSize = input.original.length + input.new.length;
  if (totalSize > DIFF_SIZE_THRESHOLD) {
    return await getPiscinaWorkerPool().run(input, {
      filename: path.join(workerDir, `./diff-worker.${workerExtension}`),
    }) as DiffWorkerResult;
  }
  return calculateDiff(input);
}

function stringifyPlanFrontmatterWithArtifactOptions(content: string, data: Record<string, unknown>): string {
  return grayMatter.stringify(content, data);
}

export async function syncLatestPlanTodosToFile(options: {
  readonly ctx: Context;
  readonly resourceAccessor: ResourceAccessor<RemoteExecManager>;
  readonly stateHandler: PlanSyncStateHandler;
  readonly toolCallId: string;
}): Promise<void> {
  const { ctx, resourceAccessor, stateHandler, toolCallId } = options;
  const latestPlanEntry = getLatestPlanRegistryEntry(stateHandler);
  if (latestPlanEntry?.path === undefined || latestPlanEntry.path.length === 0) return;
  const todoStatuses = await buildTodoStatusMap(ctx, stateHandler);
  if (todoStatuses.size === 0) return;
  try {
    const readExecutor = resourceAccessor.get(readExecutorResource);
    const readResult = await readExecutor.execute(ctx, new ReadArgs({ path: latestPlanEntry.path, toolCallId }), {
      execId: generateSeededUuid(`${toolCallId}-sync-plan-read`),
    });
    if (readResult.result.case !== "success") {
      logger.warn(ctx, "Failed to read latest plan file while syncing todos", { planPath: latestPlanEntry.path, resultCase: readResult.result.case });
      return;
    }
    if (readResult.result.value.output.case !== "content") {
      logger.warn(ctx, "Latest plan file is not readable as text", { planPath: latestPlanEntry.path, outputCase: readResult.result.value.output.case });
      return;
    }
    const originalContent = readResult.result.value.output.value;
    const parsedPlan = grayMatter(originalContent);
    const parsedFrontmatter = planFrontmatterSchema.safeParse(parsedPlan.data);
    if (!parsedFrontmatter.success) return;
    let updatedFrontmatter = parsedFrontmatter.data;
    let didUpdate = false;
    if (updatedFrontmatter.todos !== undefined) {
      const updatedTodos = updateTodoStatusArray(updatedFrontmatter.todos, todoStatuses);
      if (updatedTodos.didUpdate) {
        updatedFrontmatter = { ...updatedFrontmatter, todos: updatedTodos.updatedTodos };
        didUpdate = true;
      }
    }
    if (updatedFrontmatter.phases !== undefined) {
      let didUpdatePhases = false;
      const updatedPhases = updatedFrontmatter.phases.map(phase => {
        const parsedPhase = planPhaseFrontmatterSchema.safeParse(phase);
        if (!parsedPhase.success || parsedPhase.data.todos === undefined) return phase;
        const updatedTodos = updateTodoStatusArray(parsedPhase.data.todos, todoStatuses);
        if (!updatedTodos.didUpdate) return phase;
        didUpdatePhases = true;
        return { ...parsedPhase.data, todos: updatedTodos.updatedTodos };
      });
      if (didUpdatePhases) {
        updatedFrontmatter = { ...updatedFrontmatter, phases: updatedPhases };
        didUpdate = true;
      }
    }
    if (!didUpdate) return;
    const updatedContent = stringifyPlanFrontmatterWithArtifactOptions(parsedPlan.content, updatedFrontmatter);
    if (updatedContent === originalContent) return;
    const { diffString, linesAdded, linesRemoved } = await getDiffString({ original: originalContent, new: updatedContent });
    await performWrite(ctx, resourceAccessor, latestPlanEntry.path, updatedContent, {
      resultForModel: `Synced TODO states to ${latestPlanEntry.path}`,
      linesAdded,
      linesRemoved,
      diffString,
      originalContent,
    }, { toolCallId }, stateHandler);
  } catch (error) {
    logger.error(ctx, "Failed to sync latest plan file todos", error, { planPath: latestPlanEntry.path });
  }
}
