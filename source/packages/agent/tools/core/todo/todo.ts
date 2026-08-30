import { z } from "zod";

import type { Context } from "../../../../context/core.js";
import { createSpan } from "../../../../context/otel.js";
import { PrivacyCapability } from "../../../../redaction/classification.js";
import { fromRedactedTodoItem, toRedactedTodoItem } from "../../../../redacted-protos/generated/agent/v1/todo_tool_redacted.js";
import { TodoItem, UpdateTodosArgs, UpdateTodosError, UpdateTodosResult, UpdateTodosSuccess, UpdateTodosToolCall } from "../../../../proto/generated/agent/v1/todo_tool_pb.js";
import type { ResourceAccessor } from "../../../../agent-exec/resource-provider.js";
import type { RemoteExecManager } from "../../../../agent-exec/remote.js";
import { ToolCallArgParseError, createZodAgentTool, isCodexPromptVersion } from "../../common.js";
import { createStringResult } from "../../../../chat-inference/prompt-executor.js";
import { syncLatestPlanTodosToFile, type PlanSyncStateHandler } from "../create-plan/backend-plan-utils.js";
import { createTodoItem, createUpdateTodosToolCall, createStreamingTodoParser } from "./../todo/common.js";
import { createSchemaTowardsModel, renderUpdateTodosSuccessMessage, todoToolSchemaForParsing } from "./schema.js";

type RedactedTodoItem = Parameters<typeof fromRedactedTodoItem>[0];
type TodoReference = { get(ctx: Context): Promise<RedactedTodoItem> };

export interface UpdateTodosStateHandler extends PlanSyncStateHandler {
  readonly todos: readonly TodoReference[];
  getPrivacyMode(): Parameters<typeof toRedactedTodoItem>[1];
}

export interface UpdateTodosResourceAccessor extends ResourceAccessor<RemoteExecManager> {}

function getToolName(promptVersion: string): string {
  switch (promptVersion) {
    case "dsv3-1018": return "todo_write";
    case "cursor-0226":
    case "dsv3-1205":
    case "latest":
    case "gpt5-codex":
    case "codex-cloud":
    case "haiku": return "TodoWrite";
    default: throw new Error(`Unhandled version: ${promptVersion}`);
  }
}

function getDescription(promptVersion: string): string {
  switch (promptVersion) {
    case "gpt5-codex":
    case "codex-cloud":
      return `Updates the todo list. Provide a list of todo items, each with an id, content, and status. Provide merge=true to update existing tasks.

### Guidelines
- At most one task can be in_progress at a time.
- Cancel tasks that are no longer needed immediately.
- Prefer creating the first todo as in_progress
- Batch todo updates with other tool calls in parallel`;
    case "cursor-0226":
      return "Use this tool to create and manage a structured task list for your current coding session.";
    case "dsv3-1205":
    case "dsv3-1018":
    case "latest":
    case "haiku":
      return `Use this tool to create and manage a structured task list for your current coding session. This helps track progress, organize complex tasks, and demonstrate thoroughness.

Note: Other than when first creating todos, don't tell the user you're updating todos, just do it.

### When to Use This Tool

Use proactively for:
1. Complex multi-step tasks (3+ distinct steps)
2. Non-trivial tasks requiring careful planning
3. User explicitly requests todo list
4. User provides multiple tasks (numbered/comma-separated)
5. After receiving new instructions - capture requirements as todos (use merge=false to add new ones)
6. After completing tasks - mark complete with merge=true and add follow-ups
7. When starting new tasks - mark as in_progress (ideally only one at a time)

### When NOT to Use

Skip for:
1. Single, straightforward tasks
2. Trivial tasks with no organizational benefit
3. Tasks completable in < 3 trivial steps
4. Purely conversational/informational requests
5. Don't add a task to test the change unless asked, or you'll overfocus on testing

### Examples

<example>
  User: Add dark mode toggle to settings
  Assistant:
    - *Creates todo list:*
      1. Add state management [in_progress]
      2. Implement styles
      3. Update components
      4. Update components
    - [Immediately begins working on todos in the same tool call batch as the todo write]
</example>

### Task States and Management

1. **Task States:**
  - pending: Not yet started
  - in_progress: Currently working on
  - completed: Finished successfully
  - cancelled: No longer needed

2. **Task Management:**
  - Update status in real-time
  - Mark complete IMMEDIATELY after finishing
  - Only ONE task in_progress at a time
  - Complete current tasks before starting new ones

3. **Task Breakdown:**
  - Create specific, actionable items
  - Break complex tasks into manageable steps
  - Use clear, descriptive names

4. **Parallel Todo Writes:**
  - Prefer creating the first todo as in_progress
  - Start working on todos by using tool calls in the same tool call batch as the todo write
  - Batch todo updates with other tool calls for better latency and lower costs for the user

When in doubt, use this tool. Proactive task management demonstrates attentiveness and ensures complete requirements.`;
    default: throw new Error(`Unhandled version: ${promptVersion}`);
  }
}

export function createUpdateTodosTool(
  resourceAccessor: UpdateTodosResourceAccessor,
  stateHandler: UpdateTodosStateHandler,
  promptVersion = "latest",
): ReturnType<typeof createZodAgentTool> {
  const isCodexPrompt = isCodexPromptVersion(promptVersion);
  const executeCore = async (
    ctx: Context,
    _interactionHandler: unknown,
    rawArgs: z.infer<typeof todoToolSchemaForParsing>,
    meta: { readonly toolCallId: string },
  ): Promise<UpdateTodosResult> => {
    const existingMap = new Map<string, TodoItem>();
    for (const existingTodo of stateHandler.todos) {
      const value = fromRedactedTodoItem(await existingTodo.get(ctx), PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined);
      existingMap.set(value.id, value);
    }
    const todos = rawArgs.todos.map(todo => createTodoItem(todo, existingMap.get(todo.id)));
    const updatedTodos: TodoItem[] = [];
    const todoMap = new Map(existingMap);
    const mergeFlag = rawArgs.merge ?? true;
    if (mergeFlag) {
      for (const todo of todos) {
        const existingTodo = todoMap.get(todo.id);
        if ((existingTodo === undefined || existingTodo.content === "") && todo.content === "") {
          throw new ToolCallArgParseError("Invalid argument: must provide 'content' for new todos items");
        }
        const updatedTodo = new TodoItem({
          id: todo.id,
          content: promptVersion === "dsv3-1018" ? todo.content || existingTodo?.content || "" : todo.content,
          status: todo.status,
          createdAt: existingTodo?.createdAt || todo.createdAt,
          updatedAt: todo.updatedAt,
        });
        todoMap.set(todo.id, updatedTodo);
        updatedTodos.push(updatedTodo);
      }
      stateHandler.setTodos(Array.from(todoMap.values()).map(todo => toRedactedTodoItem(todo, stateHandler.getPrivacyMode())));
    } else {
      const replacedTodos = todos.map(todo => {
        const existingTodo = todoMap.get(todo.id);
        return new TodoItem({
          id: todo.id,
          content: promptVersion === "dsv3-1018" ? todo.content || existingTodo?.content || "" : todo.content,
          status: todo.status,
          createdAt: existingTodo?.createdAt || todo.createdAt,
          updatedAt: todo.updatedAt,
        });
      });
      stateHandler.setTodos(replacedTodos.map(todo => toRedactedTodoItem(todo, stateHandler.getPrivacyMode())));
      updatedTodos.push(...replacedTodos);
    }
    await syncLatestPlanTodosToFile({ ctx, resourceAccessor, stateHandler, toolCallId: meta.toolCallId });
    return new UpdateTodosResult({
      result: {
        case: "success",
        value: new UpdateTodosSuccess({
          todos: mergeFlag
            ? await Promise.all(stateHandler.todos.map(async todo => fromRedactedTodoItem(await todo.get(ctx), PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined)))
            : updatedTodos,
          totalCount: stateHandler.todos.length,
          wasMerge: mergeFlag,
        }),
      },
    });
  };

  const execute = async (
    parentCtx: Context,
    interactionHandler: {
      emitPartialToolCall(ctx: Context, toolCallId: string, toolCall: ReturnType<typeof createUpdateTodosToolCall>): void;
      executeToolCall(ctx: Context, toolCall: ReturnType<typeof createUpdateTodosToolCall>, toolCallId: string, run: (ctx: Context) => Promise<UpdateTodosResult>, merge: (result: UpdateTodosResult) => ReturnType<typeof createUpdateTodosToolCall>): Promise<UpdateTodosResult>;
    },
    argsStream: AsyncIterable<string>,
    meta: { readonly toolCallId: string },
  ): Promise<UpdateTodosResult> => {
    using span = createSpan(parentCtx.withName("updateTodosExecute"));
    interactionHandler.emitPartialToolCall(span.ctx, meta.toolCallId, createUpdateTodosToolCall(new UpdateTodosToolCall()));
    const existingMap = new Map<string, TodoItem>();
    for (const existingTodo of stateHandler.todos) {
      const value = fromRedactedTodoItem(await existingTodo.get(parentCtx), PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined);
      existingMap.set(value.id, value);
    }
    const { parser } = createStreamingTodoParser(span.ctx, interactionHandler, meta, existingMap);
    let args = "";
    try {
      for await (const chunk of argsStream) {
        args += chunk;
        parser.write(chunk);
      }
    } catch (error) {
      throw new ToolCallArgParseError(error instanceof Error ? error.message : String(error));
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(args);
    } catch (error) {
      throw new ToolCallArgParseError(error instanceof Error ? error.message : "Invalid JSON");
    }
    const parsedArgs = todoToolSchemaForParsing.safeParse(parsedJson);
    if (!parsedArgs.success) throw new ToolCallArgParseError(`Invalid arguments: ${parsedArgs.error.message}`);
    const rawArgs = parsedArgs.data;
    const todos = rawArgs.todos.map(todo => createTodoItem(todo, existingMap.get(todo.id)));
    const updateArgs = new UpdateTodosArgs({ todos, merge: rawArgs.merge });
    const baseToolCall = new UpdateTodosToolCall({ args: updateArgs });
    return interactionHandler.executeToolCall(
      span.ctx,
      createUpdateTodosToolCall(baseToolCall),
      meta.toolCallId,
      ctx => executeCore(ctx, interactionHandler, rawArgs, meta),
      result => createUpdateTodosToolCall(new UpdateTodosToolCall({ ...baseToolCall, result })),
    );
  };

  const render = async (_ctx: Context, execResult: UpdateTodosResult): Promise<ReturnType<typeof createStringResult>> => {
    switch (execResult.result?.case) {
      case "success": return createStringResult(renderUpdateTodosSuccessMessage(execResult.result.value, promptVersion));
      case "error": return createStringResult(execResult.result.value.error);
      case undefined: return createStringResult("Unknown error");
      default: throw new Error(`Unhandled result case: ${String(execResult.result)}`);
    }
  };

  return createZodAgentTool("TODO_WRITE", {
    name: getToolName(promptVersion),
    contextType: { type: "dynamic", conciseStaticContext: "Use this tool to manage complex multi-step tasks." },
    descriptionGenerator: () => getDescription(promptVersion),
    parameters: createSchemaTowardsModel(promptVersion, { mergeTodosFirst: isCodexPrompt, minTodos: 2 }),
    execute,
    render,
    serializeError: (error: unknown) => createUpdateTodosToolCall(new UpdateTodosToolCall({
      result: new UpdateTodosResult({
        result: {
          case: "error",
          value: new UpdateTodosError({ error: error instanceof Error ? error.message : String(error) }),
        },
      }),
    })),
  });
}
