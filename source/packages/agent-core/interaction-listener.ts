import {
  AskQuestionRejected,
  AskQuestionResult,
} from "../proto/generated/agent/v1/ask_question_tool_pb.js";
import {
  CreatePlanResult,
  CreatePlanSuccess,
} from "../proto/generated/agent/v1/create_plan_tool_pb.js";
import type {
  InteractionQuery,
  InteractionResponse,
} from "../proto/generated/agent/v1/agent_pb.js";
import {
  PrManagementError,
  PrManagementResult,
} from "../proto/generated/agent/v1/pr_management_tool_pb.js";
import {
  ReplaceEnvFailure,
  ReplaceEnvResult,
} from "../proto/generated/agent/v1/replace_env_tool_pb.js";
import {
  SetupVmEnvironmentResult,
  SetupVmEnvironmentSuccess,
} from "../proto/generated/agent/v1/setup_vm_environment_tool_pb.js";
import { Responses } from "./interaction-queries.js";

export interface InteractionListenerContext {
  readonly canceled?: boolean;
}

export interface InteractionListener<Context = InteractionListenerContext> {
  sendUpdate(context: Context, update: unknown): Promise<void>;
  query(context: Context, query: InteractionQuery): Promise<InteractionResponse | undefined>;
  enqueuePostTurnEndedWork?(work: () => Promise<unknown>): void;
  flushPostTurnEndedWork?(context: Context): Promise<void>;
}

export class InteractionListenerStreamClosedError extends Error {
  override readonly name = "InteractionListenerStreamClosedError";
  override readonly cause: unknown;

  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message);
    this.cause = options.cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function createPrManagementNotAvailableResult(): PrManagementResult {
  return new PrManagementResult({
    result: {
      case: "error",
      value: new PrManagementError({
        error: "PR management is only available in cloud agents",
      }),
    },
  });
}

export async function flushPostTurnEndedWork<Context>(
  context: Context,
  listener: Pick<InteractionListener<Context>, "flushPostTurnEndedWork">,
): Promise<void> {
  await listener.flushPostTurnEndedWork?.(context);
}

export class NoopInteractionListener<Context = InteractionListenerContext>
implements InteractionListener<Context> {
  private postTurnEndedWorkQueue: Array<() => Promise<unknown>> = [];

  async sendUpdate(_context: Context, _update: unknown): Promise<void> {}

  enqueuePostTurnEndedWork(work: () => Promise<unknown>): void {
    this.postTurnEndedWorkQueue.push(work);
  }

  async flushPostTurnEndedWork(_context: Context): Promise<void> {
    const work = this.postTurnEndedWorkQueue;
    this.postTurnEndedWorkQueue = [];
    await Promise.all(work.map(async task => {
      try {
        await task();
      } catch {
        // Post-turn cleanup is deliberately best effort.
      }
    }));
  }

  async query(_context: Context, query: InteractionQuery): Promise<InteractionResponse> {
    switch (query.query.case) {
      case "webSearchRequestQuery":
        return Responses.webSearchApproved(query.id);
      case "webFetchRequestQuery":
        return Responses.webFetchApproved(query.id);
      case "askQuestionInteractionQuery":
        return Responses.askQuestion(query.id, new AskQuestionResult({
          result: {
            case: "rejected",
            value: new AskQuestionRejected({
              reason: "Questions skipped by user (CLI fallback)",
            }),
          },
        }));
      case "switchModeRequestQuery":
        return Responses.switchModeRejected(
          query.id,
          "Mode switching not supported in CLI",
        );
      case "createPlanRequestQuery":
        return Responses.createPlan(query.id, new CreatePlanResult({
          result: {
            case: "success",
            value: new CreatePlanSuccess(),
          },
        }));
      case "setupVmEnvironmentArgs":
        return Responses.setupVmEnvironment(query.id, new SetupVmEnvironmentResult({
          result: {
            case: "success",
            value: new SetupVmEnvironmentSuccess({}),
          },
        }));
      case "replaceEnvArgs":
        return Responses.replaceEnv(query.id, new ReplaceEnvResult({
          result: {
            case: "failure",
            value: new ReplaceEnvFailure({
              errorMessage: "Environment replacement is not supported in this environment",
              setupLogs: "",
            }),
          },
        }));
      case "prManagementRequestQuery":
        return Responses.prManagement(
          query.id,
          createPrManagementNotAvailableResult(),
        );
      case "mcpAuthRequestQuery":
        return Responses.mcpAuthRejected(
          query.id,
          "MCP authentication is not supported in this environment",
        );
      case "connectScmRequestQuery":
        return Responses.connectScmRejected(
          query.id,
          "Connecting GitHub is not supported in this environment",
        );
      case "generateImageRequestQuery":
        return Responses.generateImageApproved(
          query.id,
          query.query.value.args?.description,
        );
      default:
        throw new Error("Unhandled interaction query type");
    }
  }
}
