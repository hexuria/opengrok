import type { Context } from "../../packages/context/core.js";
import type { PrivacyMode } from "../../packages/redaction/privacy-mode.js";
import {
  createTurnAgentRunInputProjection,
  createTurnAgentStreamStart,
  type BuiltTurnAgentForRun,
  type TurnAgentMcpTurnProvider,
} from "./turn-agent-composition.js";
import {
  createOuterStreamLifecycle,
  type OuterStreamLifecycleInput,
  type OuterStreamPersistence,
  type StreamAttemptHost,
} from "./stream-attempt.js";
import type {
  ConversationAction,
  ConversationStateStructure,
} from "../../packages/proto/generated/agent/v1/agent_pb.js";

/**
 * The exact generated-action-to-Agent stream boundary, kept inactive until
 * the remaining shell/read/await factory graph is released. The built Agent
 * already owns the real prompt session, resource accessor, summarization
 * handler, receiver, state/tool inputs, and lazy tool generator.
 */
export interface InactiveTurnAgentStreamStartInput {
  readonly runCtx: Context;
  readonly resumeFrom?: ConversationStateStructure;
  readonly persistCheckpoint: (
    checkpointCtx: Context,
    checkpoint: ConversationStateStructure,
  ) => Promise<void> | void;
}

export interface InactiveTurnAgentStreamPathInput {
  readonly builtAgent: Pick<BuiltTurnAgentForRun, "agent">;
  readonly assembleGeneratedTurnAction: (runCtx: Context) => Promise<ConversationAction>;
  readonly getConversationState: () => ConversationStateStructure;
  readonly privacyMode: PrivacyMode;
  readonly mcp?: TurnAgentMcpTurnProvider;
  readonly onMcpDiscoveryFailed?: (error: unknown) => void;
}

export interface InactiveTurnAgentStreamLifecycleInput {
  readonly attempt: Omit<
    StreamAttemptHost<Context, ConversationStateStructure, ConversationStateStructure>,
    "startStream" | "persistCheckpoint"
  >;
  readonly persistence: OuterStreamPersistence<Context, ConversationStateStructure>;
  readonly cleanup?: () => void | Promise<void>;
  readonly onCompleted?: (state: ConversationStateStructure) => void | Promise<void>;
}

export interface InactiveTurnAgentStreamPath {
  startStream(input: InactiveTurnAgentStreamStartInput): Promise<ConversationStateStructure>;
  createLifecycle(input: InactiveTurnAgentStreamLifecycleInput): ReturnType<
    typeof createOuterStreamLifecycle<Context, ConversationStateStructure>
  >;
}

export interface TurnAgentStreamLifecycleInput
  extends InactiveTurnAgentStreamPathInput,
    InactiveTurnAgentStreamLifecycleInput {}

export interface TurnAgentStreamLifecycle {
  run(context: Context): Promise<ConversationStateStructure>;
}

/**
 * Composes the already-recovered generated action, MCP/state projection, and
 * redacted Agent stream start. No structural action coercion or persistence
 * policy is introduced here; the outer attempt/lifecycle owner remains the
 * caller and receives the checkpoint callback unchanged.
 */
export function createInactiveTurnAgentStreamPath(
  input: InactiveTurnAgentStreamPathInput,
): InactiveTurnAgentStreamPath {
  let streamStart: Promise<ReturnType<typeof createTurnAgentStreamStart>> | undefined;
  const getStreamStart = (runCtx: Context) => {
    streamStart ??= (async () => {
      const projected = await createTurnAgentRunInputProjection({
        runCtx,
        createAction: input.assembleGeneratedTurnAction,
        ...(input.mcp === undefined ? {} : { mcp: input.mcp }),
        ...(input.onMcpDiscoveryFailed === undefined
          ? {}
          : { onMcpDiscoveryFailed: input.onMcpDiscoveryFailed }),
        getConversationState: input.getConversationState,
      });
      return createTurnAgentStreamStart({
        agent: input.builtAgent,
        baseState: projected.baseState,
        action: projected.action,
        privacyMode: input.privacyMode,
        mcpTools: projected.mcpTools,
      });
    })();
    return streamStart;
  };
  const path: InactiveTurnAgentStreamPath = {
    async startStream(streamInput) {
      const start = await getStreamStart(streamInput.runCtx);
      return start.startStream(
        streamInput.runCtx,
        streamInput.resumeFrom,
        streamInput.persistCheckpoint,
      );
    },
    createLifecycle(lifecycleInput) {
      const attempt: OuterStreamLifecycleInput<
        Context,
        ConversationStateStructure
      >["attempt"] = {
        ...lifecycleInput.attempt,
        startStream: (runCtx, resumeFrom, persistCheckpoint) =>
          path.startStream({
            runCtx,
            ...(resumeFrom === undefined ? {} : { resumeFrom }),
            persistCheckpoint,
          }),
      };
      return createOuterStreamLifecycle({
        attempt,
        persistence: lifecycleInput.persistence,
        ...(lifecycleInput.cleanup === undefined
          ? {}
          : { cleanup: lifecycleInput.cleanup }),
        ...(lifecycleInput.onCompleted === undefined
          ? {}
          : { onCompleted: lifecycleInput.onCompleted }),
      });
    },
  };
  return path;
}

/**
 * Owns one complete, dormant turn lifecycle from generated action production
 * through the real Agent stream and outer checkpoint/final persistence. The
 * projection is deliberately created for each run so action, MCP discovery,
 * state cloning, redaction, retry resume, and generation guards retain their
 * per-turn identity. This owner is not installed in SandAgentRunner until the
 * mandatory external Shell/Read factory closure is released.
 */
export function createTurnAgentStreamLifecycle(
  input: TurnAgentStreamLifecycleInput,
): TurnAgentStreamLifecycle {
  return {
    async run(context) {
      const projected = await createTurnAgentRunInputProjection({
        runCtx: context,
        createAction: input.assembleGeneratedTurnAction,
        ...(input.mcp === undefined ? {} : { mcp: input.mcp }),
        ...(input.onMcpDiscoveryFailed === undefined
          ? {}
          : { onMcpDiscoveryFailed: input.onMcpDiscoveryFailed }),
        getConversationState: input.getConversationState,
      });
      const streamStart = createTurnAgentStreamStart({
        agent: input.builtAgent,
        baseState: projected.baseState,
        action: projected.action,
        privacyMode: input.privacyMode,
        mcpTools: projected.mcpTools,
      });
      const attempt: OuterStreamLifecycleInput<
        Context,
        ConversationStateStructure
      >["attempt"] = {
        ...input.attempt,
        startStream: (attemptCtx, resumeFrom, persistCheckpoint) =>
          streamStart.startStream(attemptCtx, resumeFrom, persistCheckpoint),
      };
      return createOuterStreamLifecycle({
        attempt,
        persistence: input.persistence,
        ...(input.cleanup === undefined ? {} : { cleanup: input.cleanup }),
        ...(input.onCompleted === undefined
          ? {}
          : { onCompleted: input.onCompleted }),
      }).run(context);
    },
  };
}
