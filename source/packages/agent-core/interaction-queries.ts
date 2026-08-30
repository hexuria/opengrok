import type { PartialMessage } from "@bufbuild/protobuf";
import {
  InteractionQuery,
  InteractionResponse,
} from "../proto/generated/agent/v1/agent_pb.js";
import {
  ConnectScmRequestResponse,
  ConnectScmRequestResponse_Approved,
  ConnectScmRequestResponse_Failed,
  ConnectScmRequestResponse_Rejected,
} from "../proto/generated/agent/v1/connect_scm_tool_pb.js";
import {
  CreatePlanRequestResponse,
  type CreatePlanResult,
} from "../proto/generated/agent/v1/create_plan_tool_pb.js";
import {
  GenerateImageRequestResponse,
  GenerateImageRequestResponse_Approved,
  GenerateImageRequestResponse_Rejected,
} from "../proto/generated/agent/v1/generate_image_tool_pb.js";
import {
  McpAuthRequestQuery,
  McpAuthRequestResponse,
  McpAuthRequestResponse_Approved,
  McpAuthRequestResponse_Rejected,
  type McpAuthArgs,
} from "../proto/generated/agent/v1/mcp_auth_tool_pb.js";
import type { PrManagementResult } from "../proto/generated/agent/v1/pr_management_tool_pb.js";
import type { ReplaceEnvResult } from "../proto/generated/agent/v1/replace_env_tool_pb.js";
import type { SetupVmEnvironmentResult } from "../proto/generated/agent/v1/setup_vm_environment_tool_pb.js";
import {
  SwitchModeRequestResponse,
  SwitchModeRequestResponse_Approved,
  SwitchModeRequestResponse_Rejected,
} from "../proto/generated/agent/v1/switch_mode_tool_pb.js";
import {
  WebFetchRequestQuery,
  WebFetchRequestResponse,
  WebFetchRequestResponse_Approved,
  WebFetchRequestResponse_Rejected,
  type WebFetchArgs,
} from "../proto/generated/agent/v1/web_fetch_tool_pb.js";
import {
  WebSearchRequestQuery,
  WebSearchRequestResponse,
  WebSearchRequestResponse_Approved,
  WebSearchRequestResponse_Rejected,
  type WebSearchArgs,
} from "../proto/generated/agent/v1/web_search_tool_pb.js";
import type { AskQuestionResult } from "../proto/generated/agent/v1/ask_question_tool_pb.js";

export interface InteractionQueryListener<Context = unknown> {
  query(context: Context, query: InteractionQuery): Promise<InteractionResponse>;
}

export class DeferredInteractionResponseError extends Error {
  constructor(readonly query: InteractionQuery) {
    super(
      `Deferred interaction response requested for query ${query.id} (${query.query.case ?? "unknown"})`,
    );
    this.name = "DeferredInteractionResponseError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export const Responses = {
  webSearchApproved(queryId: number): InteractionResponse {
    return new InteractionResponse({
      id: queryId,
      result: {
        case: "webSearchRequestResponse",
        value: new WebSearchRequestResponse({
          result: {
            case: "approved",
            value: new WebSearchRequestResponse_Approved(),
          },
        }),
      },
    });
  },
  webSearchRejected(queryId: number, reason?: string | null): InteractionResponse {
    return new InteractionResponse({
      id: queryId,
      result: {
        case: "webSearchRequestResponse",
        value: new WebSearchRequestResponse({
          result: {
            case: "rejected",
            value: new WebSearchRequestResponse_Rejected({ reason: reason ?? "" }),
          },
        }),
      },
    });
  },
  webFetchApproved(queryId: number): InteractionResponse {
    return new InteractionResponse({
      id: queryId,
      result: {
        case: "webFetchRequestResponse",
        value: new WebFetchRequestResponse({
          result: {
            case: "approved",
            value: new WebFetchRequestResponse_Approved(),
          },
        }),
      },
    });
  },
  webFetchRejected(queryId: number, reason?: string | null): InteractionResponse {
    return new InteractionResponse({
      id: queryId,
      result: {
        case: "webFetchRequestResponse",
        value: new WebFetchRequestResponse({
          result: {
            case: "rejected",
            value: new WebFetchRequestResponse_Rejected({ reason: reason ?? "" }),
          },
        }),
      },
    });
  },
  askQuestion(queryId: number, result: AskQuestionResult): InteractionResponse {
    return new InteractionResponse({
      id: queryId,
      result: {
        case: "askQuestionInteractionResponse",
        value: { result },
      },
    });
  },
  switchModeApproved(queryId: number): InteractionResponse {
    return new InteractionResponse({
      id: queryId,
      result: {
        case: "switchModeRequestResponse",
        value: new SwitchModeRequestResponse({
          result: {
            case: "approved",
            value: new SwitchModeRequestResponse_Approved(),
          },
        }),
      },
    });
  },
  switchModeRejected(queryId: number, reason?: string | null): InteractionResponse {
    return new InteractionResponse({
      id: queryId,
      result: {
        case: "switchModeRequestResponse",
        value: new SwitchModeRequestResponse({
          result: {
            case: "rejected",
            value: new SwitchModeRequestResponse_Rejected({ reason: reason ?? "" }),
          },
        }),
      },
    });
  },
  createPlan(queryId: number, result: CreatePlanResult): InteractionResponse {
    return new InteractionResponse({
      id: queryId,
      result: {
        case: "createPlanRequestResponse",
        value: new CreatePlanRequestResponse({ result }),
      },
    });
  },
  setupVmEnvironment(queryId: number, result: SetupVmEnvironmentResult): InteractionResponse {
    return new InteractionResponse({
      id: queryId,
      result: { case: "setupVmEnvironmentResult", value: result },
    });
  },
  replaceEnv(queryId: number, result: ReplaceEnvResult): InteractionResponse {
    return new InteractionResponse({
      id: queryId,
      result: { case: "replaceEnvResult", value: result },
    });
  },
  prManagement(queryId: number, result: PrManagementResult): InteractionResponse {
    return new InteractionResponse({
      id: queryId,
      result: { case: "prManagementResult", value: result },
    });
  },
  mcpAuthApproved(queryId: number): InteractionResponse {
    return new InteractionResponse({
      id: queryId,
      result: {
        case: "mcpAuthRequestResponse",
        value: new McpAuthRequestResponse({
          result: {
            case: "approved",
            value: new McpAuthRequestResponse_Approved(),
          },
        }),
      },
    });
  },
  mcpAuthRejected(queryId: number, reason?: string | null): InteractionResponse {
    return new InteractionResponse({
      id: queryId,
      result: {
        case: "mcpAuthRequestResponse",
        value: new McpAuthRequestResponse({
          result: {
            case: "rejected",
            value: new McpAuthRequestResponse_Rejected({
              reason: reason ?? "Authentication was rejected",
            }),
          },
        }),
      },
    });
  },
  connectScmApproved(queryId: number): InteractionResponse {
    return new InteractionResponse({
      id: queryId,
      result: {
        case: "connectScmRequestResponse",
        value: new ConnectScmRequestResponse({
          result: {
            case: "approved",
            value: new ConnectScmRequestResponse_Approved(),
          },
        }),
      },
    });
  },
  connectScmRejected(queryId: number, reason?: string | null): InteractionResponse {
    return new InteractionResponse({
      id: queryId,
      result: {
        case: "connectScmRequestResponse",
        value: new ConnectScmRequestResponse({
          result: {
            case: "rejected",
            value: new ConnectScmRequestResponse_Rejected({
              reason: reason ?? "Connecting GitHub was skipped",
            }),
          },
        }),
      },
    });
  },
  connectScmFailed(queryId: number, error?: string | null): InteractionResponse {
    return new InteractionResponse({
      id: queryId,
      result: {
        case: "connectScmRequestResponse",
        value: new ConnectScmRequestResponse({
          result: {
            case: "failed",
            value: new ConnectScmRequestResponse_Failed({
              error: error ?? "Failed to connect GitHub",
            }),
          },
        }),
      },
    });
  },
  generateImageApproved(queryId: number, description?: string | null): InteractionResponse {
    return new InteractionResponse({
      id: queryId,
      result: {
        case: "generateImageRequestResponse",
        value: new GenerateImageRequestResponse({
          result: {
            case: "approved",
            value: new GenerateImageRequestResponse_Approved({
              description: description ?? "",
            }),
          },
        }),
      },
    });
  },
  generateImageRejected(queryId: number, reason?: string | null): InteractionResponse {
    return new InteractionResponse({
      id: queryId,
      result: {
        case: "generateImageRequestResponse",
        value: new GenerateImageRequestResponse({
          result: {
            case: "rejected",
            value: new GenerateImageRequestResponse_Rejected({ reason: reason ?? "" }),
          },
        }),
      },
    });
  },
};

export async function queryWebSearch<Context>(
  listener: InteractionQueryListener<Context>,
  context: Context,
  args: WebSearchArgs | PartialMessage<WebSearchArgs>,
): Promise<WebSearchRequestResponse> {
  const response = await listener.query(context, new InteractionQuery({
    query: {
      case: "webSearchRequestQuery",
      value: new WebSearchRequestQuery({ args }),
    },
  }));
  if (response.result.case !== "webSearchRequestResponse" || !response.result.value) {
    throw new Error(`Unexpected response for web search query: ${response.result.case}`);
  }
  return response.result.value;
}

export async function queryWebFetch<Context>(
  listener: InteractionQueryListener<Context>,
  context: Context,
  args: WebFetchArgs | PartialMessage<WebFetchArgs>,
  options?: boolean | {
    readonly skipApproval?: boolean;
    readonly smartModeApproval?: WebFetchRequestQuery["smartModeApproval"];
  } | null,
): Promise<WebFetchRequestResponse> {
  const queryOptions = typeof options === "boolean"
    ? { skipApproval: options }
    : options ?? {};
  const response = await listener.query(context, new InteractionQuery({
    query: {
      case: "webFetchRequestQuery",
      value: new WebFetchRequestQuery({
        args,
        skipApproval: queryOptions.skipApproval ?? false,
        smartModeApproval: queryOptions.smartModeApproval!,
      }),
    },
  }));
  if (response.result.case !== "webFetchRequestResponse" || !response.result.value) {
    throw new Error(`Unexpected response for web fetch query: ${response.result.case}`);
  }
  return response.result.value;
}

export async function queryMcpAuth<Context>(
  listener: InteractionQueryListener<Context>,
  context: Context,
  args: McpAuthArgs | PartialMessage<McpAuthArgs>,
): Promise<McpAuthRequestResponse> {
  const response = await listener.query(context, new InteractionQuery({
    query: {
      case: "mcpAuthRequestQuery",
      value: new McpAuthRequestQuery({ args }),
    },
  }));
  if (response.result.case !== "mcpAuthRequestResponse" || !response.result.value) {
    throw new Error(`Unexpected response for MCP auth query: ${response.result.case}`);
  }
  return response.result.value;
}
