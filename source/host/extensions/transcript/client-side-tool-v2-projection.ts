import type { ToolCall } from "../../../packages/proto/generated/agent/v1/agent_pb.js";
import { GenerateImageResult } from "../../../packages/proto/generated/agent/v1/generate_image_tool_pb.js";
import { RecordScreenArgs, RecordScreenResult } from "../../../packages/proto/generated/agent/v1/record_screen_exec_pb.js";
import { Struct } from "@bufbuild/protobuf";
import {
  AskQuestionParams,
  AskQuestionParams_Option,
  AskQuestionParams_Question,
  AskQuestionResult2,
  AskQuestionResult_Answer,
  CallMcpToolParams,
  CallMcpToolResult,
  ClientSideToolV2,
  ClientSideToolV2Call,
  ClientSideToolV2Result,
  ComputerUseParams,
  ComputerUseResult2,
  EditFileResult_FileDiff,
  EditFileResult_FileDiff_ChunkDiff,
  EditFileV2Params,
  EditFileV2Result,
  GetMcpToolsParams,
  GetMcpToolsResult,
  ListMcpResourcesParams,
  ListMcpResourcesResult,
  ListMcpResourcesResult_MCPResource,
  McpAuthParams,
  McpAuthResult2,
  ReadFileV2Params,
  ReadFileV2Result,
  ReadMcpResourceParams,
  ReadMcpResourceResult,
  RunTerminalCommandEndedReason,
  RunTerminalCommandV2Params,
  RunTerminalCommandV2Result,
  TaskV2Params,
  TaskV2Result,
  ToolResultError,
  WebFetchParams,
  WebFetchResult2,
  WebSearchParams,
  WebSearchResult2,
  WebSearchResult_WebReference,
} from "../../../packages/proto/generated/aiserver/v1/tools_pb.js";

// Generated-message evidence is present in both immutable shipped processes:
// renderer index-UbX-y3il.js offsets 3097937/3102316 and host-main.cjs
// generated tools region beginning at byte 44081. This projector only maps the
// agent ToolCall oneofs whose fields can be projected without inventing data.

export type ProjectedClientSideToolV2 =
  | { readonly kind: "call"; readonly value: ClientSideToolV2Call }
  | { readonly kind: "result"; readonly value: ClientSideToolV2Result };

type RecordValue = Record<string, any>;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function errorResult(tool: ClientSideToolV2, toolCallId: string, message: string): ProjectedClientSideToolV2 {
  return {
    kind: "result",
    value: new ClientSideToolV2Result({
      tool,
      toolCallId,
      error: new ToolResultError({
        clientVisibleErrorMessage: message,
        modelVisibleErrorMessage: message,
      }),
    }),
  };
}

function callResult(
  tool: ClientSideToolV2,
  toolCallId: string,
  resultCase: ClientSideToolV2Result["result"],
): ProjectedClientSideToolV2 {
  return { kind: "result", value: new ClientSideToolV2Result({ tool, toolCallId, result: resultCase }) };
}

function terminalResult(raw: RecordValue | undefined): { case?: string; value?: RecordValue } | undefined {
  return raw?.result as { case?: string; value?: RecordValue } | undefined;
}

function failureMessage(result: { case?: string; value?: RecordValue }): string {
  const value = result.value ?? {};
  return text(value.errorMessage ?? value.error ?? value.reason) || `Tool failed: ${result.case ?? "unknown"}`;
}

function baseCall(tool: ClientSideToolV2, callId: string, name: string, args: RecordValue, modelCallId: string, isStreaming: boolean) {
  return { tool, toolCallId: callId, name, rawArgs: JSON.stringify(args), isStreaming, ...(modelCallId ? { modelCallId } : {}) };
}

function shellResult(toolCallId: string, raw: RecordValue): ProjectedClientSideToolV2 | null {
  const result = raw.result as { case?: string; value?: RecordValue } | undefined;
  if (result?.case == null || result.value == null) return null;
  if (result.case === "permissionDenied") return errorResult(ClientSideToolV2.RUN_TERMINAL_COMMAND_V2, toolCallId, `Permission denied: ${text(result.value.reason ?? result.value.error)}`);
  if (result.case === "spawnError") return errorResult(ClientSideToolV2.RUN_TERMINAL_COMMAND_V2, toolCallId, text(result.value.error) || "Command could not be started");
  const value = result.value;
  const output = text(value.interleavedOutput) || [text(value.stdout), text(value.stderr)].filter(Boolean).join("\n");
  const endedReason = result.case === "success"
    ? RunTerminalCommandEndedReason.EXECUTION_COMPLETED
    : result.case === "rejected"
      ? RunTerminalCommandEndedReason.UNSPECIFIED
      : result.case === "timeout"
        ? RunTerminalCommandEndedReason.IDLE_TIMEOUT
        : value.aborted === true
          ? RunTerminalCommandEndedReason.EXECUTION_ABORTED
          : RunTerminalCommandEndedReason.EXECUTION_FAILED;
  return {
    kind: "result",
    value: new ClientSideToolV2Result({
      tool: ClientSideToolV2.RUN_TERMINAL_COMMAND_V2,
      toolCallId,
      result: {
        case: "runTerminalCommandV2Result",
        value: new RunTerminalCommandV2Result({
          output,
          outputRaw: output,
          exitCode: typeof value.exitCode === "number" ? value.exitCode : 0,
          ...(typeof value.exitCode === "number" ? { exitCodeV2: value.exitCode } : {}),
          ...(result.case === "rejected" ? { rejected: true } : {}),
          poppedOutIntoBackground: raw.isBackground === true,
          isRunningInBackground: raw.isBackground === true,
          resultingWorkingDirectory: text(value.workingDirectory),
          endedReason,
        }),
      },
    }),
  };
}

function editResult(toolCallId: string, raw: RecordValue): ProjectedClientSideToolV2 | null {
  const result = raw.result as { case?: string; value?: RecordValue } | undefined;
  if (result?.case == null || result.value == null) return null;
  const value = result.value;
  if (result.case !== "success" && result.case !== "rejected") {
    const message = text(value.error ?? value.reason) || `Edit failed: ${result.case}`;
    return errorResult(ClientSideToolV2.EDIT_FILE_V2, toolCallId, result.case.includes("PermissionDenied") ? `Permission denied: ${message}` : message);
  }
  const diffString = text(value.diffString);
  const diff = diffString.length === 0 ? undefined : new EditFileResult_FileDiff({
    chunks: [new EditFileResult_FileDiff_ChunkDiff({ diffString })],
  });
  return {
    kind: "result",
    value: new ClientSideToolV2Result({
      tool: ClientSideToolV2.EDIT_FILE_V2,
      toolCallId,
      result: {
        case: "editFileV2Result",
        value: new EditFileV2Result({
          fileWasCreated: value.beforeFullFileContent == null,
          ...(typeof value.beforeFullFileContent === "string" ? { contentsBeforeEdit: value.beforeFullFileContent } : {}),
          ...(typeof value.afterFullFileContent === "string" ? { contentsAfterEdit: value.afterFullFileContent } : {}),
          ...(diff === undefined ? {} : { diff }),
          ...(result.case === "rejected" ? { rejected: true } : {}),
          resultForModel: text(value.message ?? value.reason),
        }),
      },
    }),
  };
}

export function projectAgentToolCallToClientSideToolV2(
  phase: "toolCallStarted" | "partialToolCall" | "toolCallCompleted",
  callId: string,
  toolCall: ToolCall,
  modelCallId = "",
  surfaceName = "",
): ProjectedClientSideToolV2 | null {
  if (callId.length === 0) return null;
  if (toolCall.tool.case === "shellToolCall") {
    const shell = toolCall.tool.value as unknown as RecordValue;
    const args = shell.args as RecordValue | undefined;
    if (phase === "toolCallCompleted") return shell.result == null ? null : shellResult(callId, shell.result as RecordValue);
    if (args == null || text(args.command).length === 0) return null;
    return {
      kind: "call",
      value: new ClientSideToolV2Call({
        tool: ClientSideToolV2.RUN_TERMINAL_COMMAND_V2,
        toolCallId: callId,
        ...(modelCallId.length === 0 ? {} : { modelCallId }),
        name: surfaceName || "Shell",
        rawArgs: JSON.stringify({ command: args.command, cwd: args.workingDirectory }),
        isStreaming: phase === "partialToolCall",
        params: {
          case: "runTerminalCommandV2Params",
          value: new RunTerminalCommandV2Params({
            command: text(args.command),
            ...(text(args.workingDirectory).length === 0 ? {} : { cwd: text(args.workingDirectory) }),
            isBackground: args.isBackground === true,
            requireUserApproval: args.skipApproval !== true,
          }),
        },
      }),
    };
  }
  if (toolCall.tool.case === "editToolCall") {
    const edit = toolCall.tool.value as unknown as RecordValue;
    const args = edit.args as RecordValue | undefined;
    if (phase === "toolCallCompleted") return edit.result == null ? null : editResult(callId, edit.result as RecordValue);
    if (args == null || text(args.path).length === 0) return null;
    return {
      kind: "call",
      value: new ClientSideToolV2Call({
        tool: ClientSideToolV2.EDIT_FILE_V2,
        toolCallId: callId,
        ...(modelCallId.length === 0 ? {} : { modelCallId }),
        name: "Edit",
        rawArgs: JSON.stringify({ path: args.path }),
        isStreaming: phase === "partialToolCall",
        params: {
          case: "editFileV2Params",
          value: new EditFileV2Params({
            relativeWorkspacePath: text(args.path),
            ...(typeof args.streamContent === "string" ? { streamingContent: args.streamContent } : {}),
          }),
        },
      }),
    };
  }
  if (toolCall.tool.case === "readToolCall") {
    const read = toolCall.tool.value as unknown as RecordValue;
    const args = read.args as RecordValue | undefined;
    if (phase === "toolCallCompleted") {
      const result = terminalResult(read.result as RecordValue | undefined);
      if (result?.case == null || result.value == null) return null;
      if (result.case !== "success") return errorResult(ClientSideToolV2.READ_FILE_V2, callId, failureMessage(result));
      const value = result.value;
      if ((value.output as RecordValue | undefined)?.case !== "content") {
        return errorResult(ClientSideToolV2.READ_FILE_V2, callId, "Read completed with non-text content; bytes remain available in ordinary transcript transport");
      }
      const contents = text((value.output as RecordValue).value);
      return callResult(ClientSideToolV2.READ_FILE_V2, callId, {
        case: "readFileV2Result",
        value: new ReadFileV2Result({ contents, numCharactersInRequestedRange: contents.length, totalLinesInFile: Number(value.totalLines ?? 0) }),
      });
    }
    if (args == null || text(args.path).length === 0) return null;
    return { kind: "call", value: new ClientSideToolV2Call({
      ...baseCall(ClientSideToolV2.READ_FILE_V2, callId, surfaceName || "Read", args, modelCallId, phase === "partialToolCall"),
      params: { case: "readFileV2Params", value: new ReadFileV2Params({ targetFile: text(args.path), offset: args.offset, limit: args.limit, enableLineNumbers: args.includeLineNumbers }) },
    }) };
  }
  if (toolCall.tool.case === "mcpToolCall") {
    const mcp = toolCall.tool.value as unknown as RecordValue;
    const args = mcp.args as RecordValue | undefined;
    if (phase === "toolCallCompleted") {
      const result = terminalResult(mcp.result as RecordValue | undefined);
      if (result?.case == null || result.value == null) return null;
      if (result.case !== "success") return errorResult(ClientSideToolV2.CALL_MCP_TOOL, callId, failureMessage(result));
      const value = result.value;
      const structured = value.structuredContent instanceof Struct
        ? value.structuredContent
        : Struct.fromJson({ content: Array.isArray(value.content) ? value.content.map((item: any) => item.toJson?.() ?? item) : [], isError: value.isError === true });
      return callResult(ClientSideToolV2.CALL_MCP_TOOL, callId, { case: "callMcpToolResult", value: new CallMcpToolResult({ server: text(args?.serverIdentifier), toolName: text(args?.toolName ?? args?.name), result: structured }) });
    }
    if (args == null || text(args.toolName ?? args.name).length === 0) return null;
    return { kind: "call", value: new ClientSideToolV2Call({
      ...baseCall(ClientSideToolV2.CALL_MCP_TOOL, callId, text(args.name) || "MCP", args, modelCallId, phase === "partialToolCall"),
      params: { case: "callMcpToolParams", value: new CallMcpToolParams({ server: text(args.serverIdentifier ?? args.providerIdentifier), toolName: text(args.toolName ?? args.name), toolArgs: new Struct({ fields: args.args ?? {} }) }) },
    }) };
  }
  if (toolCall.tool.case === "taskToolCall") {
    const task = toolCall.tool.value as unknown as RecordValue;
    const args = task.args as RecordValue | undefined;
    if (phase === "toolCallCompleted") {
      const result = terminalResult(task.result as RecordValue | undefined);
      if (result?.case == null || result.value == null) return null;
      if (result.case !== "success") return errorResult(ClientSideToolV2.TASK_V2, callId, failureMessage(result));
      return callResult(ClientSideToolV2.TASK_V2, callId, { case: "taskV2Result", value: new TaskV2Result({ agentId: result.value.agentId, isBackground: result.value.isBackground === true, cloudAgentBcId: task.cloudAgentBcId }) });
    }
    if (args == null || text(args.prompt).length === 0) return null;
    return { kind: "call", value: new ClientSideToolV2Call({
      ...baseCall(ClientSideToolV2.TASK_V2, callId, "Task", args, modelCallId, phase === "partialToolCall"),
      params: { case: "taskV2Params", value: new TaskV2Params({ description: text(args.description), prompt: text(args.prompt), subagentType: text(args.subagentType), model: args.model, name: text(args.description), mode: Number(args.mode ?? 0) as any }) },
    }) };
  }
  if (toolCall.tool.case === "listMcpResourcesToolCall") {
    const resource = toolCall.tool.value as unknown as RecordValue;
    const args = resource.args as RecordValue | undefined;
    if (phase === "toolCallCompleted") {
      const result = terminalResult(resource.result as RecordValue | undefined);
      if (result?.case == null || result.value == null) return null;
      if (result.case !== "success") return errorResult(ClientSideToolV2.LIST_MCP_RESOURCES, callId, failureMessage(result));
      return callResult(ClientSideToolV2.LIST_MCP_RESOURCES, callId, { case: "listMcpResourcesResult", value: new ListMcpResourcesResult({ resources: (result.value.resources ?? []).map((r: any) => new ListMcpResourcesResult_MCPResource(r)) }) });
    }
    if (args == null) return null;
    return { kind: "call", value: new ClientSideToolV2Call({ ...baseCall(ClientSideToolV2.LIST_MCP_RESOURCES, callId, "ListMcpResources", args, modelCallId, phase === "partialToolCall"), params: { case: "listMcpResourcesParams", value: new ListMcpResourcesParams({ server: args.server }) } }) };
  }
  if (toolCall.tool.case === "readMcpResourceToolCall") {
    const resource = toolCall.tool.value as unknown as RecordValue;
    const args = resource.args as RecordValue | undefined;
    if (phase === "toolCallCompleted") {
      const result = terminalResult(resource.result as RecordValue | undefined);
      if (result?.case == null || result.value == null) return null;
      if (result.case !== "success") return errorResult(ClientSideToolV2.READ_MCP_RESOURCE, callId, failureMessage(result));
      return callResult(ClientSideToolV2.READ_MCP_RESOURCE, callId, { case: "readMcpResourceResult", value: new ReadMcpResourceResult(result.value as any) });
    }
    if (args == null || !text(args.server) || !text(args.uri)) return null;
    return { kind: "call", value: new ClientSideToolV2Call({ ...baseCall(ClientSideToolV2.READ_MCP_RESOURCE, callId, "ReadMcpResource", args, modelCallId, phase === "partialToolCall"), params: { case: "readMcpResourceParams", value: new ReadMcpResourceParams({ server: text(args.server), uri: text(args.uri), downloadPath: args.downloadPath }) } }) };
  }
  if (toolCall.tool.case === "askQuestionToolCall") {
    const ask = toolCall.tool.value as unknown as RecordValue;
    const args = ask.args as RecordValue | undefined;
    if (phase === "toolCallCompleted") {
      const result = terminalResult(ask.result as RecordValue | undefined);
      if (result?.case == null || result.value == null) return null;
      if (result.case === "error" || result.case === "rejected") return errorResult(ClientSideToolV2.ASK_QUESTION, callId, failureMessage(result));
      return callResult(ClientSideToolV2.ASK_QUESTION, callId, { case: "askQuestionResult", value: new AskQuestionResult2({ isAsync: result.case === "async", answers: (result.value.answers ?? []).map((a: any) => new AskQuestionResult_Answer({ questionId: text(a.questionId), selectedOptionIds: a.selectedOptionIds ?? [], freeformText: a.freeformText })) }) });
    }
    if (args == null) return null;
    const questions = (args.questions ?? []).map((q: any) => new AskQuestionParams_Question({ id: text(q.id), prompt: text(q.prompt), allowMultiple: q.allowMultiple === true, options: (q.options ?? []).map((o: any) => new AskQuestionParams_Option({ id: text(o.id), label: text(o.label) })) }));
    return { kind: "call", value: new ClientSideToolV2Call({ ...baseCall(ClientSideToolV2.ASK_QUESTION, callId, "AskQuestion", args, modelCallId, phase === "partialToolCall"), params: { case: "askQuestionParams", value: new AskQuestionParams({ title: text(args.title), questions, runAsync: args.runAsync === true }) } }) };
  }
  if (toolCall.tool.case === "mcpAuthToolCall") {
    const auth = toolCall.tool.value as unknown as RecordValue;
    const args = auth.args as RecordValue | undefined;
    if (phase === "toolCallCompleted") {
      const result = terminalResult(auth.result as RecordValue | undefined);
      if (result?.case == null || result.value == null) return null;
      if (result.case !== "success") return errorResult(ClientSideToolV2.MCP_AUTH, callId, failureMessage(result));
      return callResult(ClientSideToolV2.MCP_AUTH, callId, { case: "mcpAuthResult", value: new McpAuthResult2({ success: true, message: text(result.value.serverIdentifier) }) });
    }
    if (args == null || !text(args.serverIdentifier)) return null;
    return { kind: "call", value: new ClientSideToolV2Call({ ...baseCall(ClientSideToolV2.MCP_AUTH, callId, "McpAuth", args, modelCallId, phase === "partialToolCall"), params: { case: "mcpAuthParams", value: new McpAuthParams({ serverIdentifier: text(args.serverIdentifier) }) } }) };
  }
  if (toolCall.tool.case === "webSearchToolCall") {
    const search = toolCall.tool.value as unknown as RecordValue;
    const args = search.args as RecordValue | undefined;
    if (phase === "toolCallCompleted") {
      const result = terminalResult(search.result as RecordValue | undefined);
      if (result?.case == null || result.value == null) return null;
      if (result.case === "error") return errorResult(ClientSideToolV2.WEB_SEARCH, callId, failureMessage(result));
      return callResult(ClientSideToolV2.WEB_SEARCH, callId, { case: "webSearchResult", value: new WebSearchResult2({ rejected: result.case === "rejected", isFinal: true, references: (result.value.references ?? []).map((r: any) => new WebSearchResult_WebReference(r)) }) });
    }
    if (args == null || !text(args.searchTerm)) return null;
    return { kind: "call", value: new ClientSideToolV2Call({ ...baseCall(ClientSideToolV2.WEB_SEARCH, callId, "WebSearch", args, modelCallId, phase === "partialToolCall"), params: { case: "webSearchParams", value: new WebSearchParams({ searchTerm: text(args.searchTerm) }) } }) };
  }
  if (toolCall.tool.case === "webFetchToolCall") {
    const fetch = toolCall.tool.value as unknown as RecordValue;
    const args = fetch.args as RecordValue | undefined;
    if (phase === "toolCallCompleted") {
      const result = terminalResult(fetch.result as RecordValue | undefined);
      if (result?.case == null || result.value == null) return null;
      const value = result.value;
      return callResult(ClientSideToolV2.WEB_FETCH, callId, { case: "webFetchResult", value: new WebFetchResult2({ url: text(value.url ?? args?.url), ...(result.case === "success" ? { markdown: text(value.markdown) } : { error: failureMessage(result) }) }) });
    }
    if (args == null || !text(args.url)) return null;
    return { kind: "call", value: new ClientSideToolV2Call({ ...baseCall(ClientSideToolV2.WEB_FETCH, callId, "WebFetch", args, modelCallId, phase === "partialToolCall"), params: { case: "webFetchParams", value: new WebFetchParams({ url: text(args.url) }) } }) };
  }
  if (toolCall.tool.case === "computerUseToolCall") {
    const computer = toolCall.tool.value as unknown as RecordValue;
    const args = computer.args as RecordValue | undefined;
    if (phase === "toolCallCompleted") {
      if (computer.result == null) return null;
      return callResult(ClientSideToolV2.COMPUTER_USE, callId, { case: "computerUseResult", value: new ComputerUseResult2(computer.result as any) });
    }
    if (args == null) return null;
    return { kind: "call", value: new ClientSideToolV2Call({ ...baseCall(ClientSideToolV2.COMPUTER_USE, callId, "Computer", args, modelCallId, phase === "partialToolCall"), params: { case: "computerUseParams", value: new ComputerUseParams({ actions: args.actions ?? [] }) } }) };
  }
  if (toolCall.tool.case === "generateImageToolCall") {
    const image = toolCall.tool.value as unknown as RecordValue;
    const args = image.args as RecordValue | undefined;
    if (phase === "toolCallCompleted") {
      if (image.result == null) return null;
      return callResult(ClientSideToolV2.GENERATE_IMAGE, callId, { case: "generateImageResult", value: new GenerateImageResult(image.result as any) });
    }
    if (args == null || !text(args.description)) return null;
    return { kind: "call", value: new ClientSideToolV2Call(baseCall(ClientSideToolV2.GENERATE_IMAGE, callId, "GenerateImage", args, modelCallId, phase === "partialToolCall")) };
  }
  if (toolCall.tool.case === "recordScreenToolCall") {
    const screen = toolCall.tool.value as unknown as RecordValue;
    const args = screen.args as RecordValue | undefined;
    if (phase === "toolCallCompleted") {
      if (screen.result == null) return null;
      return callResult(ClientSideToolV2.RECORD_SCREEN, callId, { case: "recordScreenResult", value: new RecordScreenResult(screen.result as any) });
    }
    if (args == null) return null;
    return { kind: "call", value: new ClientSideToolV2Call({ ...baseCall(ClientSideToolV2.RECORD_SCREEN, callId, "RecordScreen", args, modelCallId, phase === "partialToolCall"), params: { case: "recordScreenParams", value: new RecordScreenArgs(args as any) } }) };
  }
  if (toolCall.tool.case === "getMcpToolsToolCall") {
    const discovery = toolCall.tool.value as unknown as RecordValue;
    const args = discovery.args as RecordValue | undefined;
    if (phase === "toolCallCompleted") {
      const result = terminalResult(discovery.result as RecordValue | undefined);
      if (result?.case == null || result.value == null) return null;
      if (result.case !== "success") return errorResult(ClientSideToolV2.GET_MCP_TOOLS, callId, failureMessage(result));
      return callResult(ClientSideToolV2.GET_MCP_TOOLS, callId, { case: "getMcpToolsResult", value: new GetMcpToolsResult({ content: text(result.value.content), outputFilePath: result.value.outputFilePath }) });
    }
    if (args == null) return null;
    return { kind: "call", value: new ClientSideToolV2Call({ ...baseCall(ClientSideToolV2.GET_MCP_TOOLS, callId, "GetMcpTools", args, modelCallId, phase === "partialToolCall"), params: { case: "getMcpToolsParams", value: new GetMcpToolsParams({ server: args.server, toolName: args.toolName, pattern: args.pattern }) } }) };
  }
  return null;
}
