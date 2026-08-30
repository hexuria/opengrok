import {
  CLIENT_SIDE_TOOL_V2_ACCOUNT_SLOT,
  CLIENT_SIDE_TOOL_V2_FAMILY,
  decodeClientSideToolV2Message,
  materializeClientSideToolV2RendererEvent,
  parseClientSideToolV2TransportEvent,
  type ClientSideToolV2TransportUpdate,
} from "../shared/rpc/client-side-tool-v2-transport.js";

interface AgentFence {
  epoch: string;
  sequence: number;
  retiredEpochs: Set<string>;
  updatesByToolCallId: Map<string, ClientSideToolV2TransportUpdate[]>;
}

/**
 * Validates the host stream once, retains a bounded call/result replay, and
 * materializes Uint8Array protobuf frames only at the renderer-facing port.
 */
export class ClientSideToolV2Relay {
  readonly #agents = new Map<string, AgentFence>();

  constructor(readonly postEvent: (family: string, payload: unknown) => void) {}

  accept(raw: unknown): boolean {
    const event = parseClientSideToolV2TransportEvent(raw);
    if (event == null || event.accountSlot !== CLIENT_SIDE_TOOL_V2_ACCOUNT_SLOT) return false;
    let fence = this.#agents.get(event.agentId);
    if (fence == null) {
      fence = { epoch: event.epoch, sequence: 0, retiredEpochs: new Set(), updatesByToolCallId: new Map() };
      this.#agents.set(event.agentId, fence);
    } else if (event.epoch !== fence.epoch) {
      if (fence.retiredEpochs.has(event.epoch)) return false;
      fence.retiredEpochs.add(fence.epoch);
      fence.epoch = event.epoch;
      fence.sequence = 0;
      fence.updatesByToolCallId.clear();
    }
    if (event.sequence <= fence.sequence) return false;
    fence.sequence = event.sequence;
    if (event.kind === "reset") {
      fence.updatesByToolCallId.clear();
      this.post(event);
      return true;
    }
    const decoded = decodeClientSideToolV2Message(event.kind, event.message);
    if (decoded == null) return false;
    const toolCallId = decoded.toolCallId;
    if (event.kind === "call") {
      fence.updatesByToolCallId.set(toolCallId, [event]);
    } else {
      const lifecycle = fence.updatesByToolCallId.get(toolCallId);
      if (lifecycle == null || lifecycle[0]?.kind !== "call") return false;
      fence.updatesByToolCallId.set(toolCallId, [lifecycle[0], event]);
    }
    this.post(event);
    return true;
  }

  replay(): void {
    for (const fence of this.#agents.values()) {
      const updates = [...fence.updatesByToolCallId.values()].flat().sort((left, right) => left.sequence - right.sequence);
      for (const update of updates) this.post(update);
    }
  }

  clear(): void {
    this.#agents.clear();
  }

  private post(event: unknown): void {
    const rendererEvent = materializeClientSideToolV2RendererEvent(event);
    if (rendererEvent != null) this.postEvent(CLIENT_SIDE_TOOL_V2_FAMILY, rendererEvent);
  }
}
