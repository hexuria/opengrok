import type {
  InteractionQuery,
  InteractionResponse,
  InteractionUpdate,
} from "../proto/generated/agent/v1/agent_pb.js";
import {
  fromRedactedInteractionQuery,
  fromRedactedInteractionResponse,
  fromRedactedInteractionUpdate,
  toRedactedInteractionQuery,
  toRedactedInteractionResponse,
  toRedactedInteractionUpdate,
} from "../redacted-protos/generated/agent/v1/agent_redacted.js";
import { PrivacyCapability } from "../redaction/classification.js";
import type { PrivacyMode } from "../redaction/privacy-mode.js";

type MaybePromise<T> = T | Promise<T>;

export interface InteractionListenerAdapter<Context, Update, Query, Response> {
  sendUpdate(ctx: Context, update: Update): MaybePromise<void>;
  query(ctx: Context, query: Query): MaybePromise<Response>;
  enqueuePostTurnEndedWork?: ((work: () => Promise<unknown>) => void) | undefined;
  flushPostTurnEndedWork?: ((ctx: Context) => MaybePromise<void>) | undefined;
}

type RedactedInteractionUpdate = ReturnType<typeof toRedactedInteractionUpdate>;
type RedactedInteractionQuery = ReturnType<typeof toRedactedInteractionQuery>;
type RedactedInteractionResponse = ReturnType<typeof toRedactedInteractionResponse>;

export function toUnredactedInteractionListener<Context>(
  delegate: InteractionListenerAdapter<
    Context,
    RedactedInteractionUpdate,
    RedactedInteractionQuery,
    RedactedInteractionResponse
  >,
  privacyMode: PrivacyMode,
): InteractionListenerAdapter<Context, InteractionUpdate, InteractionQuery, InteractionResponse> {
  return {
    async sendUpdate(ctx, update) {
      await delegate.sendUpdate(ctx, toRedactedInteractionUpdate(update, privacyMode));
    },
    async query(ctx, query) {
      const redactedResponse = await delegate.query(ctx, toRedactedInteractionQuery(query, privacyMode));
      return (fromRedactedInteractionResponse as unknown as (
        value: RedactedInteractionResponse,
        purpose: PrivacyCapability,
      ) => InteractionResponse)(
        redactedResponse,
        PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
      );
    },
    enqueuePostTurnEndedWork: delegate.enqueuePostTurnEndedWork
      ? work => delegate.enqueuePostTurnEndedWork!(work)
      : undefined,
    flushPostTurnEndedWork: delegate.flushPostTurnEndedWork
      ? ctx => delegate.flushPostTurnEndedWork!(ctx)
      : undefined,
  };
}

export function toRedactedInteractionListener<Context>(
  delegate: InteractionListenerAdapter<Context, InteractionUpdate, InteractionQuery, InteractionResponse>,
  privacyMode: PrivacyMode,
): InteractionListenerAdapter<
  Context,
  RedactedInteractionUpdate,
  RedactedInteractionQuery,
  RedactedInteractionResponse
> {
  return {
    async sendUpdate(ctx, update) {
      await delegate.sendUpdate(
        ctx,
        (fromRedactedInteractionUpdate as unknown as (
          value: RedactedInteractionUpdate,
          purpose: PrivacyCapability,
        ) => InteractionUpdate)(update, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
      );
    },
    async query(ctx, query) {
      const response = await delegate.query(
        ctx,
        (fromRedactedInteractionQuery as unknown as (
          value: RedactedInteractionQuery,
          purpose: PrivacyCapability,
        ) => InteractionQuery)(query, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
      );
      return toRedactedInteractionResponse(response, privacyMode);
    },
    enqueuePostTurnEndedWork: delegate.enqueuePostTurnEndedWork
      ? work => delegate.enqueuePostTurnEndedWork!(work)
      : undefined,
    flushPostTurnEndedWork: delegate.flushPostTurnEndedWork
      ? ctx => delegate.flushPostTurnEndedWork!(ctx)
      : undefined,
  };
}
