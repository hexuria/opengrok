import { AiService } from "../../../packages/proto/generated/aiserver/v1/aiserver_connect.js";
import { RunWebFetchRequest, RunWebSearchRequest, type RunWebFetchResponse, type RunWebSearchResponse } from "../../../packages/proto/generated/aiserver/v1/aiserver_pb.js";
import {
  createSandCursorBackendClient,
  type SandInferenceOptions,
} from "../../../shared/node/cursor-backend/cursor-inference.js";

type CursorBackendOptions = Omit<SandInferenceOptions, "backendUrl">;

export function createCursorWebSearchService(options: CursorBackendOptions & { modelId: string }) {
  const client = createSandCursorBackendClient(AiService, options) as unknown as {
    runWebSearch(request: RunWebSearchRequest): Promise<RunWebSearchResponse>;
  };
  return async (_ctx: unknown, args: { searchTerm: string; explanation?: string }) => {
    const response = await client.runWebSearch(new RunWebSearchRequest({
      searchTerm: args.searchTerm,
      ...(args.explanation === undefined ? {} : { explanation: args.explanation }),
      modelId: options.modelId,
    }));
    return {
      answer: response.answer,
      documents: response.documents.map((document) => ({
        url: document.url,
        title: document.title,
        text: document.text,
      })),
    };
  };
}

export function createCursorWebFetchService(options: CursorBackendOptions) {
  const client = createSandCursorBackendClient(AiService, options) as unknown as {
    runWebFetch(request: RunWebFetchRequest): Promise<RunWebFetchResponse>;
  };
  return async (_ctx: unknown, url: string): Promise<{ content: string } | { error: string; isTimeout?: boolean }> => {
    const response = await client.runWebFetch(new RunWebFetchRequest({ url }));
    switch (response.result.case) {
      case "success": return { content: response.result.value.content };
      case "error": return { error: response.result.value.error, isTimeout: response.result.value.isTimeout };
      case undefined: return { error: "Web fetch returned no result." };
    }
  };
}
