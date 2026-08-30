import { basename } from "node:path";
import { pathToFileURL } from "node:url";

import {
  RUNNER_UNATTACHED_MESSAGE,
  type TranscriptEntry,
  type TranscriptManagerLike,
} from "./transcript-hub.js";
import { HOST_ACCOUNT_SLOT } from "../../../shared/send-acceptance.js";
import { filePathFromFileUrl } from "../../../shared/node/paths.js";
import { loadSelectedImageInputs } from "../../selected-image-inputs.js";
import { beginSendTrace, traceSendPhase } from "../../send-trace-host.js";
import { BoxRequestEntries } from "./box-request-entries.js";
import {
  materializeDataUrlAttachment,
  materializeInlineImages,
  type InlineImage,
} from "./inline-image-materialization.js";
import {
  collectUserAttachmentsForSend,
  isDataUrl,
} from "../../../shared/media/user-attachment-comment.js";
import {
  buildSelectedVideos,
  createSendMessageEntry,
  createUserAttachmentEntry,
  createUserMessage,
  splitAttachmentPathsByChannel,
  statAttachedFileSizes,
  type SendMessage,
} from "./send-message-shaping.js";
import {
  resolveSendReplyThreading,
  applyAutoReplyThread,
  validateAiReplyTarget,
} from "./send-thread-stamping.js";
import { nextEntryId } from "./transcript-entry-ids.js";
import { getTranscript, removeEntry } from "./transcript-store.js";
import { sendInputDigest } from "./prompt-acceptance-ledger.js";
import {
  dispatchUserTurn,
  type RecoverySend,
  type SendAckGuard,
} from "./send-turn-dispatch.js";
import type { LiveTranscriptSession } from "./session-runtime.js";
import {
  appendAddressedEcho,
  applySendRosterSideEffects,
  emitAcceptedSendEchoes,
  type SendAcceptanceTraceContext,
} from "./send-acceptance.js";
import { dispatchMirrorOrGroupSend } from "./send-group-fanout.js";

export interface SendPromptOptions {
  readonly agentId?: string;
  readonly clientNonce?: string;
  readonly traceparent?: string;
  readonly richText?: string;
  readonly replyToId?: string;
  readonly isFork?: boolean;
  readonly attachmentPaths?: readonly string[];
  readonly attachmentNames?: readonly string[];
  readonly attachments?: unknown;
  readonly appendUserMessage?: boolean;
  readonly awaitTurn?: boolean;
  readonly directAddressedAcceptance?: boolean;
  readonly composedAtMs?: number;
  readonly enterEpochMs?: number;
}

export interface EchoEntry {
  readonly entry: TranscriptEntry;
  readonly isOnActiveTranscript: boolean;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export class SendPipeline {
  readonly sendAttachmentBatchIds = new Map<string, string>();
  readonly turnEpochs = new Map<string, number>();
  readonly latestRecoverySends = new Map<string, RecoverySend>();
  readonly recoveryBreakEpochs = new Map<string, number>();
  readonly inFlightSends = new Map<string, Promise<void>>();
  readonly boxRequests: BoxRequestEntries;

  constructor(readonly tm: TranscriptManagerLike) {
    this.boxRequests = new BoxRequestEntries(tm);
  }

  promptAcceptanceStatus(args: {
    accountSlot: string;
    clientNonce: string;
  }): unknown {
    return this.tm.acceptanceLedger.lookup(args);
  }

  materializeInlineImages(
    session: { dbPath: string },
    images: readonly InlineImage[],
  ) {
    return materializeInlineImages(session, images);
  }

  async sendPrompt(prompt: string, options: SendPromptOptions): Promise<void> {
    const nonce = options.clientNonce?.length ? options.clientNonce : undefined;
    if (nonce == null) return this.sendPromptOnce(prompt, options);
    const inFlight = this.inFlightSends.get(nonce);
    if (inFlight != null) {
      console.log(
        "[sand] duplicate send (nonce still in flight) — coalescing onto the running attempt",
      );
      return inFlight;
    }
    const digest = sendInputDigest({
      ...(options.agentId == null ? {} : { agentId: options.agentId }),
      prompt,
      ...(options.richText == null ? {} : { richText: options.richText }),
      ...(options.replyToId == null ? {} : { replyToId: options.replyToId }),
      ...(options.isFork == null ? {} : { isFork: options.isFork }),
      ...(options.attachmentPaths == null
        ? {}
        : { attachmentPaths: options.attachmentPaths }),
      ...(options.attachmentNames == null
        ? {}
        : { attachmentNames: options.attachmentNames }),
    });
    const admission = this.tm.acceptanceLedger.admitSend({
      accountSlot: HOST_ACCOUNT_SLOT,
      clientNonce: nonce,
      inputDigest: digest,
    });
    if (admission.kind === "duplicate") {
      console.log(
        "[sand] duplicate send (nonce already accepted) — idempotent no-op",
      );
      return;
    }
    const pending = this.sendPromptOnce(prompt, options, { digest });
    this.inFlightSends.set(nonce, pending);
    try {
      await pending;
    } catch (error) {
      this.tm.acceptanceLedger.clearUnlessAccepted({
        accountSlot: HOST_ACCOUNT_SLOT,
        clientNonce: nonce,
      });
      throw error;
    } finally {
      this.inFlightSends.delete(nonce);
    }
  }

  async sendPromptOnce(
    prompt: string,
    options: SendPromptOptions,
    acceptance?: { digest: string },
  ): Promise<void> {
    const collected = collectUserAttachmentsForSend({
      prompt,
      ...(options.richText == null ? {} : { richText: options.richText }),
      ...(options.attachmentPaths == null
        ? {}
        : { attachmentPaths: options.attachmentPaths }),
      ...(options.attachmentNames == null
        ? {}
        : { attachmentNames: options.attachmentNames }),
      ...(options.attachments == null ? {} : { attachments: options.attachments }),
      ...(options.clientNonce == null ? {} : { clientNonce: options.clientNonce }),
      ...(options.replyToId == null ? {} : { replyTo: options.replyToId }),
      timestampMs: Date.now(),
    });
    const trimmedPrompt = collected.text.trim();
    const attachmentPaths = collected.attachments.map(
      (attachment) => attachment.file_path,
    );
    if (trimmedPrompt.length === 0 && collected.attachments.length === 0) return;
    invariant(this.tm.execution.canExecute, RUNNER_UNATTACHED_MESSAGE);
    const awaitTurn = options.awaitTurn ?? true;
    const sendTrace = beginSendTrace(options.traceparent);
    const hostReceiptEpochMs = Date.now();
    const hostReceiptPerfMs = performance.now();
    let pinnedSession: LiveTranscriptSession | undefined;
    let ackGuard: (SendAckGuard & { [Symbol.dispose]?(): void }) | undefined;
    try {
      if (options.directAddressedAcceptance !== true)
        await this.tm.sessions.ensureActionTarget(options.agentId);
      const ensuredSession =
        options.agentId == null
          ? await traceSendPhase(
              sendTrace,
              "ensureSession",
              async () =>
                this.tm.sessions.ensureSession() as Promise<LiveTranscriptSession>,
            )
          : undefined;
      const targetAgentId = options.agentId ?? ensuredSession?.id;
      invariant(targetAgentId != null, "A send target could not be resolved.");
      const wasInFlight = this.tm.runLifecycle
        .runningAgentIds()
        .has(targetAgentId);
      const session = (await this.tm.groupChat.pinMemberSessionForGroupTurn(
        targetAgentId,
      )) as LiveTranscriptSession;
      pinnedSession = session;
      const isOnScreen = () =>
        this.tm.sessions.activeSession?.id === session.id &&
        this.tm.sessions.inMemoryTranscriptAgentId === session.id;
      const readTranscript = () =>
        isOnScreen()
          ? getTranscript()
          : (session.db.getTranscriptEntries() as TranscriptEntry[]);
      const appendEcho = (
        build: (entries: readonly TranscriptEntry[]) => TranscriptEntry,
        appendOptions: { onPersistOutcome(isDurable: boolean): void },
      ) =>
        appendAddressedEcho(this.tm, session, isOnScreen, build, appendOptions);
      try {
        sendTrace?.span.setAttribute("sand.conversation_id", session.id);
        sendTrace?.span.setAttribute(
          "sand.attachment_count",
          attachmentPaths.length,
        );
        sendTrace?.span.setAttribute(
          "sand.span_scope",
          awaitTurn
            ? "host-receipt-to-turn-end"
            : "host-receipt-to-durable-acceptance",
        );
        if (options.clientNonce != null && options.clientNonce.length > 0) {
          sendTrace?.span.setAttribute(
            "sand.client_nonce",
            options.clientNonce,
          );
        }
        if (options.isFork === true) {
          sendTrace?.span.setAttribute("sand.is_fork", true);
        }
      } catch {}
      if (!this.tm.groupChat.isGroupSession(session))
        this.tm.telemetry.reportUserMessageReceived({
          conversationId: session.id,
          wasInFlight,
        });
      session.db.setIntroductionPending(false);
      const needsRosterRefresh = applySendRosterSideEffects(
        this.tm,
        session,
        trimmedPrompt,
        readTranscript,
      );
      const threading = resolveSendReplyThreading(
        { turnRuntime: this.tm.turnRuntime },
        options.replyToId,
        options.isFork === true,
        readTranscript,
      );
      const durableAppendStartEpochMs = Date.now();
      const durableAppendStartPerfMs = performance.now();
      let acceptedDurably = true;
      const observePersistOutcome = (isDurable: boolean) => {
        if (!isDurable) acceptedDurably = false;
      };
      const echoes: EchoEntry[] = [];
      let userMessageId: string | undefined;
      const persistedAttachments = collected.attachments.map((attachment) => {
        if (!isDataUrl(attachment.file_path)) return attachment;
        const materialized = materializeDataUrlAttachment(
          session,
          attachment.file_path,
          attachment.file_name,
        );
        if (materialized == null) return attachment;
        return {
          ...attachment,
          file_path: materialized.path,
          file_name: attachment.file_name ?? materialized.fileName,
          byteSize: attachment.byteSize ?? materialized.byteSize,
        };
      });
      const filesystemAttachmentPaths = persistedAttachments
        .map((attachment) => attachment.file_path)
        .filter((path) => !isDataUrl(path) && !/^https?:\/\//i.test(path));
      const sizes = await statAttachedFileSizes(filesystemAttachmentPaths);
      try {
        for (const [index, attachment] of persistedAttachments.entries()) {
          const path = attachment.file_path;
          const name = attachment.file_name;
          const byteSize = attachment.byteSize ?? sizes.get(path);
          const built = await createUserAttachmentEntry(
            this.tm.attachments,
            attachment.id.length > 0
              ? attachment.id
              : "pending-user-attachment-id",
            path,
            {
              ...(threading.replyToId == null
                ? {}
                : { replyTo: threading.replyToId }),
              ...(attachment.batchId == null ? {} : { batchId: attachment.batchId }),
              ...(typeof name !== "string" ? {} : { fileName: name }),
              ...(threading.isFork ? { branched: true } : {}),
              ...(options.clientNonce == null
                ? {}
                : { clientNonce: options.clientNonce }),
              ...(byteSize == null ? {} : { byteSize }),
              timestampMs: attachment.timestampMs ?? durableAppendStartEpochMs,
            },
          );
          echoes.push(
            appendEcho(
              (entries) => ({
                ...built,
                id:
                  attachment.id.length > 0
                    ? attachment.id
                    : nextEntryId(entries, "user-attachment", session.db.getRetiredEntryIds()),
              }),
              { onPersistOutcome: observePersistOutcome },
            ),
          );
        }
        if ((options.appendUserMessage ?? true) && trimmedPrompt.length > 0) {
          const echo = appendEcho(
            (entries) =>
              createUserMessage(
                nextEntryId(
                  entries,
                  "user-message",
                  session.db.getRetiredEntryIds(),
                ),
                trimmedPrompt,
                {
                  ...(collected.richText == null
                    ? {}
                    : { richText: collected.richText }),
                  ...(threading.replyToId == null
                    ? {}
                    : { replyTo: threading.replyToId }),
                  ...(options.clientNonce == null
                    ? {}
                    : { clientNonce: options.clientNonce }),
                  ...(collected.batchId == null ? {} : { batchId: collected.batchId }),
                  ...(threading.isFork ? { branched: true } : {}),
                  ...(options.composedAtMs == null
                    ? {}
                    : { composedAtMs: options.composedAtMs }),
                },
              ),
            { onPersistOutcome: observePersistOutcome },
          );
          userMessageId = echo.entry.id;
          echoes.push(echo);
        }
      } catch (error) {
        for (const { entry } of echoes) {
          session.db.deleteTranscriptEntry(entry.id);
          if (this.tm.sessions.inMemoryTranscriptAgentId === session.id)
            removeEntry(entry.id);
        }
        throw error;
      }
      if (!acceptedDurably) {
        console.warn(
          "[sand] send accepted NON-durably (persist dropped on a locked db); the echo still shipped so the send proceeds, but a host crash before the next successful write would lose the entry",
        );
      }
      if (options.clientNonce != null && acceptance != null)
        this.tm.acceptanceLedger.recordPending({
          accountSlot: HOST_ACCOUNT_SLOT,
          clientNonce: options.clientNonce,
          inputDigest: acceptance.digest,
          agentId: session.id,
          echoEntryId: userMessageId ?? echoes[0]?.entry.id ?? null,
        });
      const acceptedAtMs = Date.now();
      const owesAck =
        !this.tm.groupChat.isRemoteRoomSession(session) &&
        !this.tm.groupChat.isGroupSession(session);
      if (owesAck)
        this.tm.ackObligations.recordAckObligationSend(session, acceptedAtMs);
      const armedAckGuard = this.tm.ackObligations.armSendGuard(
        session,
        acceptedAtMs,
        owesAck,
      ) as SendAckGuard & { [Symbol.dispose]?(): void };
      ackGuard = armedAckGuard;
      const traceContext = sendTrace?.context;
      const acceptanceTraceContext =
        traceContext != null &&
        typeof traceContext === "object" &&
        "withName" in traceContext &&
        typeof traceContext.withName === "function"
          ? (traceContext as SendAcceptanceTraceContext)
          : undefined;
      emitAcceptedSendEchoes({
        tm: this.tm,
        session,
        echoEntries: echoes,
        isAddressedChatOnScreen: isOnScreen,
        directAddressedAcceptance: options.directAddressedAcceptance === true,
        ...(options.clientNonce == null
          ? {}
          : { clientNonce: options.clientNonce }),
        ...(acceptanceTraceContext == null
          ? {}
          : { traceCtx: acceptanceTraceContext }),
        ...(sendTrace == null ? {} : { sendTrace }),
        acceptedDurably,
        durableAppendStartEpochMs,
        durableAppendStartPerfMs,
        hostReceiptEpochMs,
        hostReceiptPerfMs,
      });
      if (needsRosterRefresh) await this.tm.roster.emitAgentUpdate(session.id);
      if (this.tm.roster.outlineAgentId === session.id) {
        this.tm.roster.streamingAssistantOutlineId = undefined;
        this.tm.roster.streamingThinkingOutlineId = undefined;
        if (trimmedPrompt.length > 0) {
          this.tm.roster.appendOutlineItem({
            kind: "user",
            id: crypto.randomUUID(),
            text: trimmedPrompt,
            timestampMs: Date.now(),
          });
        }
      }
      const {
        imageAttachmentPaths,
        videoAttachmentPaths,
        fileAttachmentPaths,
      } = splitAttachmentPathsByChannel(filesystemAttachmentPaths);
      const selectedImages =
        await loadSelectedImageInputs(imageAttachmentPaths);
      const selectedVideos = buildSelectedVideos(videoAttachmentPaths);
      if (
        this.tm.groupChat.isRemoteRoomSession(session) ||
        this.tm.groupChat.isGroupSession(session)
      ) {
        await dispatchMirrorOrGroupSend(this.tm, {
          session,
          trimmedPrompt,
          selectedImages,
          videoAttachmentPaths,
          fileAttachmentPaths,
          clientNonce: options.clientNonce,
          userMessageId,
          awaitTurn,
          acceptedAtMs,
          traceCtx: sendTrace?.context,
          readAddressedTranscript: readTranscript,
          nextTurnEpoch: (target: LiveTranscriptSession) =>
            this.nextTurnEpoch(target),
          markSendAccepted: (nonce?: string) => this.markSendAccepted(nonce),
        });
        return;
      }
      await dispatchUserTurn({
        tm: this.tm,
        session,
        trimmedPrompt,
        ...(options.richText == null ? {} : { richText: options.richText }),
        ...(options.composedAtMs == null
          ? {}
          : { composedAtMs: options.composedAtMs }),
        ...(options.enterEpochMs == null
          ? {}
          : { enterEpochMs: options.enterEpochMs }),
        ...(options.clientNonce == null
          ? {}
          : { clientNonce: options.clientNonce }),
        awaitTurn,
        isFork: threading.isFork,
        ...(userMessageId == null ? {} : { userMessageId }),
        ...(threading.replyContext == null
          ? {}
          : { replyContext: threading.replyContext }),
        selectedImages,
        selectedVideos,
        fileAttachmentPaths,
        attachedFileSizes: sizes,
        ...(sendTrace?.context == null ? {} : { traceCtx: sendTrace.context }),
        acceptedAtMs,
        wasInFlight,
        readAddressedTranscript: readTranscript,
        latestRecoverySends: this.latestRecoverySends,
        recoveryBreakEpochs: this.recoveryBreakEpochs,
        nextTurnEpoch: (target) => this.nextTurnEpoch(target),
        markSendAccepted: (nonce) => this.markSendAccepted(nonce),
        ackGuard: armedAckGuard,
      });
    } finally {
      try {
        ackGuard?.[Symbol.dispose]?.();
      } catch {}
      if (pinnedSession != null)
        this.tm.runLifecycle.endSessionRun(pinnedSession);
      try {
        sendTrace?.span.end();
      } catch {}
    }
  }

  markSendAccepted(clientNonce?: string): void {
    if (clientNonce)
      this.tm.acceptanceLedger.markAccepted({
        accountSlot: HOST_ACCOUNT_SLOT,
        clientNonce,
      });
  }

  nextTurnEpoch(session: { id: string }): number {
    const next = (this.turnEpochs.get(session.id) ?? 0) + 1;
    this.turnEpochs.set(session.id, next);
    return next;
  }

  currentTurnEpoch(session: { id: string }): number {
    return this.turnEpochs.get(session.id) ?? 0;
  }

  claimSendAttachmentBatchId(sessionId: string): string {
    const existing = this.sendAttachmentBatchIds.get(sessionId);
    if (existing != null) return existing;
    const minted = crypto.randomUUID();
    this.sendAttachmentBatchIds.set(sessionId, minted);
    return minted;
  }

  appendSendMessageEntry(entry: TranscriptEntry): void {
    this.boxRequests.trackBoxRequestEntry(entry);
    this.tm.appendEntry(entry);
  }

  resolveBoxRequestEntry(
    agentId: string,
    requestId: string,
    resolution: string,
  ): Promise<void> {
    return this.boxRequests.resolveBoxRequestEntry(
      agentId,
      requestId,
      resolution,
    );
  }

  validateAiReplyTarget(
    message: SendMessage,
    inFlightId: string,
    entries: readonly TranscriptEntry[],
  ): SendMessage {
    return validateAiReplyTarget(message, inFlightId, entries);
  }

  applyAutoReplyThread(
    message: SendMessage,
    session: LiveTranscriptSession | null,
    entries: readonly TranscriptEntry[],
  ): SendMessage {
    return applyAutoReplyThread(
      { turnRuntime: this.tm.turnRuntime },
      message,
      session,
      entries,
    );
  }

  async resolveDevSendMessage(message: SendMessage): Promise<SendMessage> {
    if (message.type !== "attachment" || typeof message.url !== "string")
      return message;
    const filePath = filePathFromFileUrl(message.url);
    const session = this.tm.sessions.activeSession as
      LiveTranscriptSession | undefined;
    if (filePath == null || session == null) return message;
    try {
      const ingested =
        await this.tm.createAttachmentIngestor(session)(filePath);
      const fileName = basename(filePath);
      const resolvedFileName =
        fileName.length > 0 ? fileName : message.file_name;
      return {
        type: "attachment",
        url: pathToFileURL(ingested).href,
        ...(message.reply_to == null ? {} : { reply_to: message.reply_to }),
        ...(resolvedFileName == null ? {} : { file_name: resolvedFileName }),
        ...(message.alt == null ? {} : { alt: message.alt }),
        ...(message.channel == null ? {} : { channel: message.channel }),
        ...(message.width == null ? {} : { width: message.width }),
        ...(message.height == null ? {} : { height: message.height }),
      };
    } catch {
      return message;
    }
  }

  async devAppendSendMessage(message: SendMessage): Promise<void> {
    const resolved = await this.resolveDevSendMessage(message);
    this.appendSendMessageEntry(
      createSendMessageEntry(
        nextEntryId(
          getTranscript(),
          "send-message",
          this.tm.sessions.activeSession?.db.getRetiredEntryIds(),
        ),
        resolved,
        Date.now(),
      ),
    );
  }

  async appendConnectorCard(args: {
    agentId?: string;
    connector: string;
    variant: string;
    reason?: string;
  }): Promise<void> {
    await this.tm.sessions.ensureActionTarget(args.agentId);
    const message: SendMessage = {
      type: "connector",
      connector: args.connector,
      variant: args.variant,
      ...(args.reason ? { reason: args.reason } : {}),
    };
    this.appendSendMessageEntry(
      createSendMessageEntry(
        nextEntryId(
          getTranscript(),
          "send-message",
          this.tm.sessions.activeSession?.db.getRetiredEntryIds(),
        ),
        message,
        Date.now(),
      ),
    );
  }
}
