import { randomUUID } from "node:crypto";

import type {
  ClientSideToolV2Call,
  ClientSideToolV2Result,
} from "../../../packages/proto/generated/aiserver/v1/tools_pb.js";
import {
  CLIENT_SIDE_TOOL_V2_ACCOUNT_SLOT,
  CLIENT_SIDE_TOOL_V2_WIRE_VERSION,
  encodeClientSideToolV2Message,
  type ClientSideToolV2TransportEvent,
} from "../../../shared/rpc/client-side-tool-v2-transport.js";

export type ClientSideToolV2ProducedValue =
  | { readonly kind: "call"; readonly value: ClientSideToolV2Call }
  | { readonly kind: "result"; readonly value: ClientSideToolV2Result };

/** Host ordering and lifecycle authority for the typed tool side stream. */
export class ClientSideToolV2Producer {
  readonly #epoch: string;
  readonly #sequences = new Map<string, number>();
  readonly #openCalls = new Map<string, Set<string>>();

  constructor(epoch = randomUUID()) {
    this.#epoch = epoch;
  }

  publish(agentId: string, produced: ClientSideToolV2ProducedValue): ClientSideToolV2TransportEvent | null {
    if (agentId.length === 0 || produced.value.toolCallId.length === 0) return null;
    const open = this.#openCalls.get(agentId) ?? new Set<string>();
    if (produced.kind === "call") {
      open.add(produced.value.toolCallId);
      this.#openCalls.set(agentId, open);
    } else {
      if (!open.has(produced.value.toolCallId)) return null;
      open.delete(produced.value.toolCallId);
      if (open.size === 0) this.#openCalls.delete(agentId);
    }
    const sequence = this.nextSequence(agentId);
    return {
      version: CLIENT_SIDE_TOOL_V2_WIRE_VERSION,
      kind: produced.kind,
      accountSlot: CLIENT_SIDE_TOOL_V2_ACCOUNT_SLOT,
      agentId,
      epoch: this.#epoch,
      sequence,
      message: produced.kind === "call"
        ? encodeClientSideToolV2Message("call", produced.value)
        : encodeClientSideToolV2Message("result", produced.value),
    };
  }

  reset(agentId: string): ClientSideToolV2TransportEvent | null {
    if (agentId.length === 0) return null;
    this.#openCalls.delete(agentId);
    return {
      version: CLIENT_SIDE_TOOL_V2_WIRE_VERSION,
      kind: "reset",
      accountSlot: CLIENT_SIDE_TOOL_V2_ACCOUNT_SLOT,
      agentId,
      epoch: this.#epoch,
      sequence: this.nextSequence(agentId),
    };
  }

  private nextSequence(agentId: string): number {
    const next = (this.#sequences.get(agentId) ?? 0) + 1;
    this.#sequences.set(agentId, next);
    return next;
  }
}
