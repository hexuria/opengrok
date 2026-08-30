import { protoInt64 } from "@bufbuild/protobuf";
import type { HandlerContext } from "@connectrpc/connect";
import { randomUUID } from "node:crypto";
import {
  CommitGrokBotTranscriptEntriesResponse,
  CreateGrokBotAgentRequest,
  CreateGrokBotAgentResponse,
  DeleteGrokBotAgentResponse,
  GetGrokBotSendStatusResponse,
  GrokBotAgentHarnessKind,
  GrokBotSendStatus,
  GrokBotTemporalHarnessMode,
  GrokBotTranscriptWatchConnected,
  GrokBotTranscriptWatchFrame,
  GrokBotUserMessageDelivery,
  ListGrokBotAgentsResponse,
  ListGrokBotTranscriptEntriesResponse,
  ListGrokBotUserComputersResponse,
  ReadGrokBotAgentAttachmentChunkResponse,
  SendGrokBotUserMessageResponse,
  SetGrokBotAgentClientStateResponse,
  UpdateGrokBotAgentResponse,
  type CommitGrokBotTranscriptEntriesRequest,
  type DeleteGrokBotAgentRequest,
  type GetGrokBotSendStatusRequest,
  type ListGrokBotAgentsRequest,
  type ListGrokBotTranscriptEntriesRequest,
  type ReadGrokBotAgentAttachmentChunkRequest,
  type SendGrokBotUserMessageRequest,
  type SetGrokBotAgentClientStateRequest,
  type UpdateGrokBotAgentRequest,
  type WatchGrokBotTranscriptsRequest,
} from "../packages/proto/generated/aiserver/v1/grok_bot_pb.js";
import { HEXURIA_AGENT_ID } from "./constants.js";
import type { LocalTranscriptBody } from "./fixtures.js";
import { isHostTitleJob, persistSendAttachments, stripCursorComments, userAttachmentBodies } from "./send.js";
import type { MockGrokBotStore } from "./store.js";

export interface GrokBotHandlerOptions {
  readonly store: MockGrokBotStore;
  /** When true, Watch stays open until the client aborts. HTTP default. */
  readonly holdWatchStreams?: boolean;
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (signal == null || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function cannedSendBodies(store: MockGrokBotStore, request: SendGrokBotUserMessageRequest): LocalTranscriptBody[] {
  const now = Date.now();
  const fromId = request.agentId.length > 0 ? request.agentId : HEXURIA_AGENT_ID;
  const userId = request.messageId.length > 0 ? request.messageId : `user-${randomUUID()}`;
  const caption = stripCursorComments(request.text);
  const persistUserText = caption.length > 0 && !isHostTitleJob(caption);
  const storedPaths = persistSendAttachments(
    store,
    request.attachmentPaths,
    request.attachmentNames,
  );
  const attachments = userAttachmentBodies(userId, now, storedPaths, request.attachmentNames);
  const shouldReply = persistUserText || attachments.length > 0;
  const bodies: LocalTranscriptBody[] = [...attachments];
  if (persistUserText) {
    bodies.push({
      id: userId,
      kind: "message",
      role: "user",
      content: caption,
      timestampMs: now,
    });
  }
  if (!shouldReply) return bodies;
  bodies.push({
    id: `${userId}-assistant`,
    kind: "message",
    role: "assistant",
    content: "Canned mock reply. No model was called.",
    timestampMs: now + 2,
  });
  return bodies;
}

export function createGrokBotHandlers(options: GrokBotHandlerOptions): Record<string, (...args: never[]) => unknown> {
  const { store } = options;
  const holdWatchStreams = options.holdWatchStreams === true;

  return {
    listGrokBotAgents(request: ListGrokBotAgentsRequest) {
      return new ListGrokBotAgentsResponse({
        agents: store.listAgents(request.role),
      });
    },

    createGrokBotAgent(request: CreateGrokBotAgentRequest) {
      const agent = store.createAgent(request);
      return new CreateGrokBotAgentResponse({
        agent,
        harness: agent.harness === "temporal" ? GrokBotAgentHarnessKind.TEMPORAL : GrokBotAgentHarnessKind.BOX,
      });
    },

    updateGrokBotAgent(request: UpdateGrokBotAgentRequest) {
      const updated = store.updateAgent(request);
      if (updated != null) return new UpdateGrokBotAgentResponse({ agent: updated });
      return new UpdateGrokBotAgentResponse({
        agent: store.createAgent(new CreateGrokBotAgentRequest({
          agentId: request.id,
          legacyAgentId: request.id,
          name: request.name,
          description: request.description,
          title: request.title,
          avatarShape: request.avatarShape,
          avatarColor: request.avatarColor,
          ...(request.avatarChange.case === "avatarDataUrl"
            ? { avatarDataUrl: request.avatarChange.value }
            : {}),
          harness: GrokBotAgentHarnessKind.BOX,
        })),
      });
    },

    deleteGrokBotAgent(request: DeleteGrokBotAgentRequest) {
      store.deleteAgent(request.id);
      return new DeleteGrokBotAgentResponse();
    },

    listGrokBotTranscriptEntries(request: ListGrokBotTranscriptEntriesRequest) {
      const page = store.listTranscript(request.agentId, {
        ...(request.limit > 0 ? { limit: request.limit } : {}),
        ...(request.beforeSeq != null ? { beforeSeq: BigInt(request.beforeSeq) } : {}),
      });
      return new ListGrokBotTranscriptEntriesResponse({
        entries: page.entries,
        generation: page.generation,
      });
    },

    commitGrokBotTranscriptEntries(request: CommitGrokBotTranscriptEntriesRequest) {
      const result = store.commit(request.agentId, request.entries, request.deletes);
      return new CommitGrokBotTranscriptEntriesResponse({
        committedCount: result.committedCount,
        deletedCount: result.deletedCount,
      });
    },

    async *watchGrokBotTranscripts(request: WatchGrokBotTranscriptsRequest, context: HandlerContext) {
      const streamId = randomUUID();
      yield new GrokBotTranscriptWatchFrame({
        frame: {
          case: "connected",
          value: new GrokBotTranscriptWatchConnected({
            streamId,
            serverTimeMs: protoInt64.parse(Date.now()),
            absoluteLifetimeMs: protoInt64.parse(3_600_000),
          }),
        },
      });
      const agentIds = request.cursors.length > 0
        ? request.cursors.map((cursor) => cursor.agentId)
        : [...store.transcripts.keys()];
      for (const agentId of agentIds) {
        const page = store.listTranscript(agentId);
        yield new GrokBotTranscriptWatchFrame({
          frame: {
            case: "rows",
            value: {
              agentId,
              generation: page.generation,
              entries: page.entries,
              deletes: [],
              replay: true,
            },
          },
        });
      }
      if (!holdWatchStreams) return;
      const pending: GrokBotTranscriptWatchFrame[] = [];
      let notify: (() => void) | undefined;
      const unsubscribe = store.subscribeWatch((frame) => {
        pending.push(frame);
        notify?.();
      });
      try {
        while (!context.signal.aborted) {
          if (pending.length === 0) {
            await Promise.race([
              waitForAbort(context.signal),
              new Promise<void>((resolve) => {
                notify = resolve;
              }),
            ]);
            notify = undefined;
          }
          const frame = pending.shift();
          if (frame != null) yield frame;
        }
      } finally {
        unsubscribe();
      }
    },

    sendGrokBotUserMessage(request: SendGrokBotUserMessageRequest) {
      const agentId = request.agentId.length > 0 ? request.agentId : HEXURIA_AGENT_ID;
      const bodies = cannedSendBodies(store, request);
      const added = store.appendBodies(agentId, bodies);
      const echo = added.find((entry) => entry.entryKind === "message") ?? added[0];
      const messageId = request.messageId.length > 0 ? request.messageId : echo?.entryId ?? `user-${randomUUID()}`;
      store.recordSend({
        agentId,
        messageId,
        status: GrokBotSendStatus.ACCEPTED,
        echoEntryId: echo?.entryId ?? messageId,
        acceptedAtMs: protoInt64.parse(Date.now()),
      });
      return new SendGrokBotUserMessageResponse({
        dispatched: true,
        mode: GrokBotTemporalHarnessMode.BOX,
        delivery: GrokBotUserMessageDelivery.ACCEPTED_BOX,
        workflowId: `mock-${messageId}`,
      });
    },

    getGrokBotSendStatus(request: GetGrokBotSendStatusRequest) {
      const stored = store.getSend(request.agentId, request.messageId);
      if (stored == null) {
        return new GetGrokBotSendStatusResponse({ status: GrokBotSendStatus.NOT_FOUND });
      }
      return new GetGrokBotSendStatusResponse({
        status: stored.status,
        echoEntryId: stored.echoEntryId,
        acceptedAtMs: stored.acceptedAtMs,
      });
    },

    listGrokBotUserComputers() {
      return new ListGrokBotUserComputersResponse({ computers: store.computers });
    },

    setGrokBotAgentClientState(request: SetGrokBotAgentClientStateRequest) {
      return new SetGrokBotAgentClientStateResponse({
        state: store.setClientState(request.agentId, {
          ...(request.markRead === undefined ? {} : { markRead: request.markRead }),
          ...(request.markUnread === undefined ? {} : { markUnread: request.markUnread }),
          ...(request.notificationsEnabled === undefined ? {} : { notificationsEnabled: request.notificationsEnabled }),
          ...(request.notifyOnUpdatesEnabled === undefined ? {} : { notifyOnUpdatesEnabled: request.notifyOnUpdatesEnabled }),
          ...(request.hiddenFromSidebar === undefined ? {} : { hiddenFromSidebar: request.hiddenFromSidebar }),
        }),
      });
    },

    readGrokBotAgentAttachmentChunk(request: ReadGrokBotAgentAttachmentChunkRequest) {
      const chunk = store.readAttachment(request.path, BigInt(request.offset), request.length);
      return new ReadGrokBotAgentAttachmentChunkResponse({
        data: chunk.data,
        totalSize: chunk.totalSize,
      });
    },
  };
}
