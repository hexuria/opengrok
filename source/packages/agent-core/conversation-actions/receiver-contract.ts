import type { Context } from "../../context/core.js";
import type { ConversationAction } from "../../proto/generated/agent/v1/agent_pb.js";

/**
 * Exact receiver surface consumed by the immutable user-message turn loop.
 * Queue ownership and claimed-injection delivery remain external to Agent Core.
 */
export interface ConversationActionReceiverEntry {
  readonly action: ConversationAction;
}

export interface ConversationActionReceiver {
  peek(ctx: Context): Promise<ConversationActionReceiverEntry | undefined>;
  pop(ctx: Context): Promise<undefined>;
  peekIsClaimedInjection?(): boolean;
  failConsumedInjectionDelivery?(): void;
  getContextInjectionToolSignal?(): unknown;
}
