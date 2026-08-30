import { ToolCall } from "../../../proto/generated/agent/v1/agent_pb.js";
import {
  WebSearchArgs,
  WebSearchError,
  WebSearchRejected,
  WebSearchResult,
  WebSearchSuccess,
  WebSearchToolCall,
} from "../../../proto/generated/agent/v1/web_search_tool_pb.js";
import type { Context } from "../../../context/core.js";
import { createSpan } from "../../../context/otel.js";
import { createStringResult } from "../../../chat-inference/prompt-executor.js";
import { writeToAgentToolsFile, describeOutputLocation, AGENT_TOOLS_FILE_WRITE_THRESHOLD_BYTES } from "../../../agent-exec/agent-tools-file.js";
import type { ResourceAccessor } from "../../../agent-exec/resource-provider.js";
import type { RemoteExecManager } from "../../../agent-exec/remote.js";
import { writeExecutorResource } from "../../../agent-exec/write.js";
import { queryWebSearch, type InteractionQueryListener } from "../../../agent-core/interaction-queries.js";
import { buildWebSearchYearGuidance } from "../../../utils/web-search-year-guidance.js";
import { withRemoteHooks } from "./remote-hooks.js";
import {
  CustomToolCallError,
  ToolCallError,
  ToolCallRejectedError,
  createZodAgentTool,
  withSafeParsedArgs,
} from "../common.js";
import { ToolErrorClassification } from "../core.js";
import { z } from "zod";

const NO_DISK_INLINE_CAP_CHARS = 30_000;
const WEB_SEARCH_MAX_FILE_SIZE = 5 * 1024 * 1024;

export interface WebSearchServiceResult {
  readonly answer?: string;
  readonly documents: readonly { readonly title: string; readonly url: string; readonly text: string }[];
}

export interface WebSearchServiceRequest {
  readonly searchTerm: string;
  readonly explanation?: string;
}

export interface WebSearchToolOptions {
  readonly variant?: "exa";
  readonly useMinimalHarness?: boolean;
  readonly conversationStartedDate?: string;
  readonly projectFolder?: string;
  readonly osPlatform?: string;
  readonly resourceAccessor?: ResourceAccessor<RemoteExecManager>;
  readonly enableExecuteHookExec?: boolean;
  readonly configuredSteps?: readonly string[];
  readonly model?: unknown;
}

export interface WebSearchToolDependencies {
  readonly webSearchService: (context: Context, args: WebSearchServiceRequest) => Promise<WebSearchServiceResult>;
  readonly promptVersion?: string;
  readonly useMinimalHarness?: boolean;
  readonly conversationStartedDate?: string;
  readonly projectFolder?: string;
  readonly osPlatform?: string;
  readonly resourceAccessor?: ResourceAccessor<RemoteExecManager>;
  readonly enableExecuteHookExec?: boolean;
  readonly configuredSteps?: readonly string[];
  readonly model?: unknown;
}

interface DiskWriteContext {
  readonly resourceAccessor: ResourceAccessor<RemoteExecManager>;
  readonly projectFolder: string;
  readonly osPlatform?: string;
}

function createWebSearchToolCall(value: WebSearchToolCall): ToolCall {
  return new ToolCall({ tool: { case: "webSearchToolCall", value } });
}

function normalizeArgs(args: { readonly search_term: string; readonly explanation?: string }): WebSearchServiceRequest {
  return { searchTerm: args.search_term, ...(args.explanation === undefined ? {} : { explanation: args.explanation }) };
}

const API_REQUEST_FAILED_STATUS_REGEX = /\bAPI request failed:\s*(\d{3})\b/i;

function getErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
  return undefined;
}

function parseProviderStatusFromMessage(message: string): number | undefined {
  const match = API_REQUEST_FAILED_STATUS_REGEX.exec(message);
  if (match === null) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function classifyWebSearchProviderError(error: unknown): CustomToolCallError | undefined {
  const messages: string[] = [];
  const directMessage = getErrorMessage(error);
  if (directMessage !== undefined) messages.push(directMessage);
  const cause = typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined;
  const causeMessage = getErrorMessage(cause);
  if (causeMessage !== undefined) messages.push(causeMessage);
  for (const message of messages) {
    const status = parseProviderStatusFromMessage(message);
    if (status === undefined || status !== 429 && status < 500) continue;
    return new CustomToolCallError(ToolErrorClassification.PROVIDER_ERROR, {
      clientVisibleErrorMessage: "The web search provider returned an error; this may be temporary. Please try again.",
      modelVisibleErrorMessage: "The web search provider returned an error; this may be temporary. Please try again.",
      error: `${message}. provider_status=${status}`,
    });
  }
  return undefined;
}

const exaParametersSchema = z.preprocess(
  raw => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const input = raw as Record<string, unknown>;
    if (input.search_term === undefined) {
      const alias = typeof input.query === "string" ? input.query : typeof input.searchTerm === "string" ? input.searchTerm : undefined;
      if (alias !== undefined) {
        const { query: _query, searchTerm: _searchTerm, ...rest } = input;
        return { ...rest, search_term: alias };
      }
    }
    return input;
  },
  z.object({
    search_term: z.string().describe("The search term to look up on the web. Be specific and include relevant keywords for better results. For technical queries, include version numbers or dates if relevant."),
    explanation: z.string().optional().describe("One sentence explanation as to why this tool is being used, and how it contributes to the goal."),
  }).transform(data => ({ variant: "exa" as const, search_term: data.search_term, explanation: data.explanation })),
);

function getParametersSchema(variant: "exa") {
  switch (variant) {
    case "exa": return exaParametersSchema;
  }
}

function createHookInput(args: { readonly search_term: string; readonly explanation?: string }): { search_term: string; explanation?: string } {
  return { search_term: args.search_term, ...(args.explanation === undefined ? {} : { explanation: args.explanation }) };
}

function applyUpdatedHookInput(args: { search_term: string; explanation?: string }, input: Record<string, unknown>): void {
  if (typeof input.search_term === "string") args.search_term = input.search_term;
  if (typeof input.explanation === "string") args.explanation = input.explanation;
}

function resultToString(result: WebSearchResult): string {
  switch (result.result.case) {
    case "success":
      return result.result.value.references.map(reference => {
        const maybeUrl = reference.url !== undefined && reference.url !== "" ? `\nURL: ${reference.url}` : "";
        return `Title: ${reference.title}${maybeUrl}\nContent: ${reference.chunk}\n---\n`;
      }).join("\n");
    case "error": return `Error: ${result.result.value.error}`;
    case "rejected": return result.result.value.reason ? `Web search rejected: ${result.result.value.reason}` : "The web search was rejected by the user.";
    case undefined: return "Unknown error";
    default: return "Unknown error";
  }
}

async function buildReferencesFromServiceResult(context: Context, serviceResult: WebSearchServiceResult, toolCallId: string, diskWriteContext: DiskWriteContext | undefined): Promise<Array<{ title: string; url: string; chunk: string }>> {
  const references: Array<{ title: string; url: string; chunk: string }> = [];
  const answer = serviceResult.answer !== undefined && serviceResult.answer !== "" ? serviceResult.answer : undefined;
  if (answer !== undefined) references.push({ title: "Web search results", url: "", chunk: answer });
  for (const document of serviceResult.documents) {
    let chunk: string | undefined;
    if (diskWriteContext !== undefined && Buffer.byteLength(document.text, "utf8") > AGENT_TOOLS_FILE_WRITE_THRESHOLD_BYTES) {
      const outputLocation = await writeToAgentToolsFile(context, diskWriteContext.resourceAccessor.get(writeExecutorResource), {
        content: document.text,
        projectDir: diskWriteContext.projectFolder,
        osPlatform: diskWriteContext.osPlatform,
        toolCallId,
        maxSize: WEB_SEARCH_MAX_FILE_SIZE,
      });
      if (outputLocation !== undefined) {
        chunk = `${describeOutputLocation(outputLocation, { leadText: "Full page text" })}\nUse shell / grep / read_file on this path to inspect the page; no follow-up fetch is needed.`;
      }
    }
    if (chunk === undefined) {
      if (answer !== undefined) continue;
      chunk = document.text.slice(0, NO_DISK_INLINE_CAP_CHARS);
    }
    references.push({ title: document.title, url: document.url, chunk });
  }
  return references;
}

function getToolName(promptVersion: string): string {
  switch (promptVersion) {
    case "dsv3-1018": return "web_search";
    case "cursor-0226":
    case "dsv3-1205":
    case "latest":
    case "gpt5-codex":
    case "codex-cloud":
    case "haiku": return "WebSearch";
    default: throw new Error(`Unhandled version: ${promptVersion}`);
  }
}

function getRequiredConversationStartedDate(conversationStartedDate: string | undefined): string {
  if (conversationStartedDate === undefined) throw new Error("conversationStartedDate is required for WebSearch prompts with year guidance");
  return conversationStartedDate;
}

function getBaseDescription(promptVersion: string, useMinimalHarness: boolean, conversationStartedDate: string | undefined): string {
  if (useMinimalHarness) return "Search the web for up-to-date information and return snippets and URLs. Prefer this over shell for web searches because shell egress is more restricted.";
  switch (promptVersion) {
    case "gpt5-codex":
    case "codex-cloud":
    case "cursor-0226": return "Search web for real-time info on any topic; use for up-to-date facts not in training data, like current events or tech updates. Results include snippets and URLs.";
    case "dsv3-1205":
    case "dsv3-1018": return "Search the web for real-time information about any topic. Use this tool when you need up-to-date information that might not be available in your training data, or when you need to verify facts. The search results will include relevant snippets and URLs from web pages. This is particularly useful for questions about current events, technology updates, or any topic that requires recent information.";
    case "latest":
    case "haiku": {
      const yearGuidance = buildWebSearchYearGuidance(getRequiredConversationStartedDate(conversationStartedDate));
      return `Search the web for real-time information about any topic. Returns summarized information from search results and relevant URLs.\n\nUse this tool when you need up-to-date information that might not be available or correct in your training data, or when you need to verify facts.\nThis includes queries about:\n- Libraries, frameworks, and tools whose APIs, best practices, or usage instructions are frequently updated. ("How do I run Postgres in a container?")\n- Current events or technology news. ("Which AI model is best for coding?")\n- Informational queries similar to what you might Google ("kubernetes operator for mysql")\n\n${yearGuidance}`;
    }
    default: throw new Error(`Unhandled version: ${promptVersion}`);
  }
}

type WebSearchFactory = ReturnType<typeof createZodAgentTool>;

export function createWebSearchTool(
  webSearchService: (context: Context, args: WebSearchServiceRequest) => Promise<WebSearchServiceResult>,
  promptVersion?: string,
  options?: WebSearchToolOptions,
): WebSearchFactory;
export function createWebSearchTool(dependencies: WebSearchToolDependencies): WebSearchFactory;
export function createWebSearchTool(
  webSearchServiceOrDependencies: ((context: Context, args: WebSearchServiceRequest) => Promise<WebSearchServiceResult>) | WebSearchToolDependencies,
  promptVersion?: string,
  options?: WebSearchToolOptions,
): WebSearchFactory {
  let legacyObjectForm = false;
  if (typeof webSearchServiceOrDependencies !== "function") {
    legacyObjectForm = true;
    const dependencies = webSearchServiceOrDependencies;
    webSearchServiceOrDependencies = dependencies.webSearchService;
    promptVersion = dependencies.promptVersion;
    options = {
      ...(dependencies.useMinimalHarness === undefined ? {} : { useMinimalHarness: dependencies.useMinimalHarness }),
      ...(dependencies.conversationStartedDate === undefined ? {} : { conversationStartedDate: dependencies.conversationStartedDate }),
      ...(dependencies.projectFolder === undefined ? {} : { projectFolder: dependencies.projectFolder }),
      ...(dependencies.osPlatform === undefined ? {} : { osPlatform: dependencies.osPlatform }),
      ...(dependencies.resourceAccessor === undefined ? {} : { resourceAccessor: dependencies.resourceAccessor }),
      ...(dependencies.enableExecuteHookExec === undefined ? {} : { enableExecuteHookExec: dependencies.enableExecuteHookExec }),
      ...(dependencies.configuredSteps === undefined ? {} : { configuredSteps: dependencies.configuredSteps }),
      ...(dependencies.model === undefined ? {} : { model: dependencies.model }),
    };
  }
  const webSearchService = webSearchServiceOrDependencies;
  const version = promptVersion ?? "latest";
  const variant = options?.variant ?? "exa";
  const parameters = getParametersSchema(variant);
  const diskWriteContext = options?.projectFolder !== undefined && options.resourceAccessor !== undefined
    ? { projectFolder: options.projectFolder, resourceAccessor: options.resourceAccessor, ...(options.osPlatform === undefined ? {} : { osPlatform: options.osPlatform }) }
    : undefined;
  const execute = async (
    parentContext: Context,
    interactionHandler: { readonly listener: InteractionQueryListener<Context>; executeToolCall: (context: Context, toolCall: ToolCall, id: string, run: (context: Context) => Promise<WebSearchResult>, merge: (result: WebSearchResult) => ToolCall, hookContextCollector?: readonly unknown[]) => Promise<WebSearchResult> },
    rawArgs: { readonly search_term: string; readonly explanation?: string },
    meta: { readonly toolCallId: string; readonly hookContextCollector?: readonly unknown[] },
  ): Promise<WebSearchResult> => {
    using span = createSpan(parentContext.withName("webSearchExecute"));
    const executeCore = async (context: Context, args: { readonly search_term: string; readonly explanation?: string }): Promise<WebSearchResult> => {
      const normalized = normalizeArgs(args);
      const searchArgs = new WebSearchArgs({ searchTerm: normalized.searchTerm, toolCallId: meta.toolCallId });
      const response = await queryWebSearch(interactionHandler.listener, context, searchArgs).catch(error => legacyObjectForm ? Promise.reject(classifyWebSearchProviderError(error) ?? error) : Promise.reject(error));
      if (response.result.case === "rejected") throw new ToolCallRejectedError(response.result.value.reason || "User rejected the web search");
      const baseToolCall = new WebSearchToolCall({ args: searchArgs });
      return interactionHandler.executeToolCall(context, createWebSearchToolCall(baseToolCall), meta.toolCallId, async innerContext => {
        let serviceResult: WebSearchServiceResult;
        try {
          serviceResult = await webSearchService(innerContext, normalized);
        } catch (error) {
          throw classifyWebSearchProviderError(error) ?? error;
        }
        const references = await buildReferencesFromServiceResult(innerContext, serviceResult, meta.toolCallId, diskWriteContext);
        return new WebSearchResult({ result: { case: "success", value: new WebSearchSuccess({ references }) } });
      }, result => createWebSearchToolCall(new WebSearchToolCall({ ...baseToolCall, result })), meta.hookContextCollector);
    };
    const enableHookExec = Boolean(options?.enableExecuteHookExec);
    if (options?.resourceAccessor !== undefined && enableHookExec) {
      const wrappedExecute = withRemoteHooks({
        executeFn: executeCore,
        config: {
          toolName: "WebSearch",
          createToolInput: createHookInput,
          applyUpdatedInput: applyUpdatedHookInput,
          createRejectedResult: (_args: unknown, reason: string) => new WebSearchResult({ result: { case: "rejected", value: new WebSearchRejected({ reason }) } }),
          createSuccessOutput: (_args: unknown, result: WebSearchResult) => {
            const references = result.result.case === "success" ? result.result.value.references.map(reference => ({ title: reference.title, url: reference.url, chunk: reference.chunk })) : [];
            return { status: "success", references_count: references.length, content: references };
          },
          getFailureInfo: (result: WebSearchResult) => {
            switch (result.result.case) {
              case "error": return { errorMessage: result.result.value.error, failureType: "error" };
              case "rejected": return { errorMessage: result.result.value.reason ?? "Web search rejected", failureType: "permission_denied" };
              case "success":
              case undefined: return undefined;
              default: return undefined;
            }
          },
        },
        requestContext: { toolCallId: meta.toolCallId },
        options: { resourceAccessor: options.resourceAccessor, enableExecuteHookExec: options.enableExecuteHookExec, configuredSteps: options.configuredSteps, model: options.model, hookContextCollector: meta.hookContextCollector },
      });
      return await wrappedExecute(span.ctx, rawArgs) as WebSearchResult;
    }
    return executeCore(span.ctx, rawArgs);
  };
  const name = getToolName(version);
  return createZodAgentTool("WEB_SEARCH", {
    name,
    descriptionGenerator: () => getBaseDescription(version, options?.useMinimalHarness ?? false, options?.conversationStartedDate),
    parameters,
    execute: withSafeParsedArgs(parameters, execute, createWebSearchToolCall(new WebSearchToolCall())),
    render: async (_context: Context, result: WebSearchResult) => createStringResult(resultToString(result)),
    serializeError: (error: unknown) => {
      if (error instanceof ToolCallRejectedError) return createWebSearchToolCall(new WebSearchToolCall({ result: new WebSearchResult({ result: { case: "rejected", value: new WebSearchRejected({ reason: error.message }) } }) }));
      return createWebSearchToolCall(new WebSearchToolCall({ result: new WebSearchResult({ result: { case: "error", value: new WebSearchError({ error: error instanceof ToolCallError ? error.clientVisibleErrorMessage : "An error occurred while searching the web" }) } }) }));
    },
  });
}
