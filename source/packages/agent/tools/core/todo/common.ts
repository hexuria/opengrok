import { JSONParser } from "@streamparser/json";
import { z } from "zod";

import { PrivacyCapability } from "../../../../redaction/classification.js";
import { fromRedactedTodoItem } from "../../../../redacted-protos/generated/agent/v1/todo_tool_redacted.js";
import { ToolCall } from "../../../../proto/generated/agent/v1/agent_pb.js";
import {
  TodoItem,
  TodoStatus,
  UpdateTodosArgs,
  UpdateTodosToolCall,
} from "../../../../proto/generated/agent/v1/todo_tool_pb.js";
import { lenientEnum } from "../../lenient-enum.js";

const todoStatusSchema = lenientEnum(
  z.enum(["pending", "in_progress", "completed", "cancelled"]),
);
const todoItemSchema = z.object({
  id: z.string(),
  content: z.string().optional(),
  status: todoStatusSchema,
});

type RawTodo = z.infer<typeof todoItemSchema>;
type RedactedTodoItem = Parameters<typeof fromRedactedTodoItem>[0];
const unwrapTodoItem = fromRedactedTodoItem as (
  todo: RedactedTodoItem,
  purpose: PrivacyCapability,
) => TodoItem;

export function stringToTodoStatus(status: RawTodo["status"]): TodoStatus {
  switch (status) {
    case "pending": return TodoStatus.PENDING;
    case "in_progress": return TodoStatus.IN_PROGRESS;
    case "completed": return TodoStatus.COMPLETED;
    case "cancelled": return TodoStatus.CANCELLED;
    default: {
      const _exhaustive: never = status;
      return TodoStatus.UNSPECIFIED;
    }
  }
}

export function todoStatusToString(status: TodoStatus): string {
  switch (status) {
    case TodoStatus.PENDING: return "pending";
    case TodoStatus.IN_PROGRESS: return "in_progress";
    case TodoStatus.COMPLETED: return "completed";
    case TodoStatus.CANCELLED: return "cancelled";
    default: return "unspecified";
  }
}

export function formatTodosForSummarization(
  todoItems: readonly RedactedTodoItem[],
): string | undefined {
  if (todoItems.length === 0) return undefined;
  return todoItems.map(todo => {
    const unwrapped = unwrapTodoItem(todo, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
    const statusStr = todoStatusToString(unwrapped.status).toUpperCase();
    return `- **${statusStr}**: ${unwrapped.content} (id: ${unwrapped.id})`;
  }).join("\n");
}

export function createTodoItem(rawTodo: RawTodo, existingTodo?: TodoItem): TodoItem {
  return new TodoItem({
    id: rawTodo.id,
    content: rawTodo.content || existingTodo?.content || "",
    status: stringToTodoStatus(rawTodo.status),
    createdAt: existingTodo?.createdAt || BigInt(Date.now()),
    updatedAt: BigInt(Date.now()),
  });
}

export function createUpdateTodosToolCall(updateTodosTool: UpdateTodosToolCall): ToolCall {
  return new ToolCall({
    tool: { case: "updateTodosToolCall", value: updateTodosTool },
  });
}

export function createStreamingTodoParser(
  ctx: unknown,
  interactionHandler: {
    emitPartialToolCall(
      ctx: unknown,
      toolCallId: string,
      toolCall: ToolCall,
    ): unknown;
  },
  meta: { readonly toolCallId: string },
  existingTodosMap: ReadonlyMap<string, TodoItem>,
): { parser: JSONParser; streamedTodos: RawTodo[] } {
  const parser = new JSONParser({ emitPartialTokens: true });
  const streamedTodos: RawTodo[] = [];
  parser.onValue = ({ value, key, stack }) => {
    if (
      stack.length === 2 &&
      typeof key === "number" &&
      value &&
      typeof value === "object" &&
      "id" in value &&
      "status" in value
    ) {
      const todoItem = todoItemSchema.parse(value);
      streamedTodos.push(todoItem);
      const partialTodos = streamedTodos.map(todo => {
        const existing = existingTodosMap.get(todo.id);
        return createTodoItem(todo, existing);
      });
      interactionHandler.emitPartialToolCall(
        ctx,
        meta.toolCallId,
        createUpdateTodosToolCall(new UpdateTodosToolCall({
          args: new UpdateTodosArgs({ todos: partialTodos }),
        })),
      );
    }
  };
  return { parser, streamedTodos };
}
