import { ToolCall } from "../../../proto/generated/agent/v1/agent_pb.js";
import {
  WebFetchArgs,
  WebFetchError,
  WebFetchRejected,
  WebFetchResult,
  WebFetchSuccess,
  WebFetchToolCall,
} from "../../../proto/generated/agent/v1/web_fetch_tool_pb.js";
import type { Context } from "../../../context/core.js";
import { createSpan } from "../../../context/otel.js";
import { createStringResult } from "../../../chat-inference/prompt-executor.js";
import { writeToAgentToolsFile, describeOutputLocation, AGENT_TOOLS_FILE_WRITE_THRESHOLD_BYTES } from "../../../agent-exec/agent-tools-file.js";
import type { ResourceAccessor } from "../../../agent-exec/resource-provider.js";
import type { RemoteExecManager } from "../../../agent-exec/remote.js";
import { writeExecutorResource } from "../../../agent-exec/write.js";
import { queryWebFetch, type InteractionQueryListener } from "../../../agent-core/interaction-queries.js";
import { isLoopbackIpHost, isPrivateIpHost } from "../../utils/ip.js";
import {
  ToolCallArgParseError,
  ToolCallError,
  ToolCallRejectedError,
  ToolTimeoutError,
  createZodAgentTool,
  withSafeParsedArgs,
} from "../common.js";
import { z } from "zod";

const MAX_CONTENT_SIZE = 100_000;

export interface WebFetchServiceResult {
  readonly content?: string;
  readonly error?: string;
  readonly isTimeout?: boolean;
}

export interface WebFetchToolDependencies {
  readonly webFetchService: (context: Context, url: string) => Promise<WebFetchServiceResult>;
  readonly promptVersion?: string;
  readonly useMinimalHarness?: boolean;
  readonly projectFolder?: string;
  readonly osPlatform?: string;
  readonly resourceAccessor?: ResourceAccessor<RemoteExecManager>;
  readonly stripCredentialedUrls?: boolean;
}

function createWebFetchToolCall(value: WebFetchToolCall): ToolCall {
  return new ToolCall({ tool: { case: "webFetchToolCall", value } });
}

function toolName(promptVersion: string): string {
  if (promptVersion === "dsv3-1018" || promptVersion === "dsv3-1205") return "mcp_web_fetch";
  if (["cursor-0226", "latest", "gpt5-codex", "codex-cloud", "haiku"].includes(promptVersion)) return "WebFetch";
  throw new Error(`Unhandled version: ${promptVersion}`);
}

function truncateContent(content: string): string {
  if (content.length <= MAX_CONTENT_SIZE) return content;
  const omitted = content.slice(MAX_CONTENT_SIZE);
  const lines = (omitted.match(/\n/g) ?? []).length + 1;
  return `${content.slice(0, MAX_CONTENT_SIZE)}\n\n...[${lines} line${lines === 1 ? "" : "s"} truncated]`;
}

function localNetworkRejection(url: URL): string | undefined {
  const host = url.hostname.toLowerCase();
  const display = url.port.length > 0 ? `${host}:${url.port}` : host;
  if (host === "localhost" || host.endsWith(".localhost") || isLoopbackIpHost(host)) return `Cannot fetch from localhost (${display}) because this tool runs from an isolated server.`;
  if (isPrivateIpHost(host)) return `Cannot fetch from private IP (${display}) because this tool runs from an isolated server.`;
  return undefined;
}

function description(promptVersion: string, minimal: boolean): string {
  if (minimal) return "Fetch content from a URL and return it as readable markdown. Prefer this over shell for web content because shell egress is more restricted.";
  return `Fetch content from a specified URL and return its contents in a readable markdown format. Use this tool when you need to retrieve and analyze webpage content.

- The URL must be a fully-formed, valid URL.
- This tool is read-only and will not work for requests intended to have side effects.
- This fetch tries to return live results but may return previously cached content.
- Authentication is not supported, and an error will be returned if the URL requires authentication.
- If the URL is returning a non-200 status code, the tool will not return the content and will instead return an error message.
- This fetch runs from an isolated server. Hosts like localhost or private IPs will not work.
- This tool does not support fetching binary content, e.g. media or PDFs.
`;
}

function stripCredentials(url: string, enabled: boolean): string {
  if (!enabled) return url;
  try {
    const parsed = new URL(url);
    if (parsed.username.length === 0 && parsed.password.length === 0) return url;
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

export function createWebFetchTool(dependencies: WebFetchToolDependencies) {
  const promptVersion = dependencies.promptVersion ?? "latest";
  const parameters = z.object({ url: z.string().describe("The URL to fetch. The content will be converted to a readable markdown format.") });
  const execute = async (context: Context, interactionHandler: { readonly listener: InteractionQueryListener<Context>; executeToolCall: (context: Context, toolCall: ToolCall, id: string, run: (context: Context) => Promise<WebFetchResult>, merge: (result: WebFetchResult) => ToolCall) => Promise<WebFetchResult> }, rawArgs: z.infer<typeof parameters>, meta: { readonly toolCallId: string }): Promise<WebFetchResult> => {
    const url = stripCredentials(rawArgs.url, dependencies.stripCredentialedUrls === true);
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new ToolCallArgParseError("Invalid URL: must include http:// or https://"); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new ToolCallArgParseError(`Invalid URL protocol: ${parsed.protocol} (must be http or https)`);
    const rejection = localNetworkRejection(parsed);
    if (rejection !== undefined) throw new ToolCallArgParseError(rejection);
    const args = new WebFetchArgs({ url, toolCallId: meta.toolCallId });
    const baseToolCall = new WebFetchToolCall({ args });
    const span = createSpan(context.withName("webFetchExecute"));
    return interactionHandler.executeToolCall(span.ctx, createWebFetchToolCall(baseToolCall), meta.toolCallId, async innerContext => {
      const response = await queryWebFetch(interactionHandler.listener, innerContext, args);
      if (response.result.case === "rejected") throw new ToolCallRejectedError(response.result.value.reason || "User rejected the web fetch");
      const fetched = await dependencies.webFetchService(innerContext, url);
      if (fetched.error !== undefined) {
        if (fetched.isTimeout === true) throw new ToolTimeoutError({ clientVisibleErrorMessage: fetched.error, modelVisibleErrorMessage: fetched.error, error: fetched.error });
        return new WebFetchResult({ result: { case: "error", value: new WebFetchError({ url, error: fetched.error }) } });
      }
      const content = fetched.content ?? "";
      if (dependencies.projectFolder !== undefined && dependencies.resourceAccessor !== undefined && Buffer.byteLength(content, "utf8") > AGENT_TOOLS_FILE_WRITE_THRESHOLD_BYTES) {
        const location = await writeToAgentToolsFile(innerContext, dependencies.resourceAccessor.get(writeExecutorResource), { content, projectDir: dependencies.projectFolder, osPlatform: dependencies.osPlatform, toolCallId: meta.toolCallId });
        if (location !== undefined) return new WebFetchResult({ result: { case: "success", value: new WebFetchSuccess({ url, markdown: content, outputLocation: location }) } });
      }
      return new WebFetchResult({ result: { case: "success", value: new WebFetchSuccess({ url, markdown: truncateContent(content) }) } });
    }, result => createWebFetchToolCall(new WebFetchToolCall({ ...baseToolCall, result })));
  };
  return createZodAgentTool("WEB_FETCH", {
    name: toolName(promptVersion),
    descriptionGenerator: () => description(promptVersion, dependencies.useMinimalHarness === true),
    parameters,
    execute: withSafeParsedArgs(parameters, execute, createWebFetchToolCall(new WebFetchToolCall())),
    render: async (_context: Context, result: WebFetchResult) => {
      switch (result.result.case) {
        case "success": return createStringResult(`# Content from ${result.result.value.url}\n\n${result.result.value.outputLocation === undefined ? truncateContent(result.result.value.markdown) : describeOutputLocation(result.result.value.outputLocation)}`);
        case "error": return createStringResult(result.result.value.url.length > 0 ? `Error fetching URL ${result.result.value.url}: ${result.result.value.error}` : `Error: ${result.result.value.error}`);
        case "rejected": return createStringResult(result.result.value.reason.length > 0 ? `Web fetch rejected: ${result.result.value.reason}` : "The web fetch was rejected by the user.");
        case undefined: return createStringResult("Unknown error");
      }
    },
    serializeError: (error: unknown) => createWebFetchToolCall(new WebFetchToolCall({ result: new WebFetchResult({ result: error instanceof ToolCallRejectedError
      ? { case: "rejected", value: new WebFetchRejected({ reason: error.message }) }
      : { case: "error", value: new WebFetchError({ error: error instanceof ToolCallError ? error.clientVisibleErrorMessage : "An error occurred while fetching the URL" }) } }) })),
  });
}
