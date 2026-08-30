import { dirname } from "node:path";
import {
  getSandProfilePath,
  readSandProfileFile,
  writeSandProfileFile,
} from "../../agents/agent-profile.js";
import {
  SAND_DEFAULT_AGENT_NAME,
  isSandDefaultAgentName,
} from "../../../shared/agents/agents.js";
import { entryRaisesUserActivitySignal } from "../../../shared/transcript.js";
import { SandSendNotPersistedError } from "./send-not-persisted-error.js";
import { getTranscript } from "./transcript-store.js";
import type {
  TranscriptEntry,
  TranscriptManagerLike,
} from "./transcript-hub.js";

export interface SendAcceptanceTraceContext {
  withName(name: string): unknown;
}

export interface SendAcceptanceTrace {
  readonly span: { setAttribute(key: string, value: unknown): void };
}

export type CompletedSpanRecorder = (
  context: unknown,
  options: {
    readonly startTime: Date;
    readonly attributes: Readonly<Record<string, unknown>>;
  },
  endTime: Date,
) => void;

let completedSpanRecorder: CompletedSpanRecorder | undefined;

/** Supplies the bundle-scope tracing helper without inventing an SDK dependency. */
export function setSendAcceptanceCompletedSpanRecorder(
  recorder: CompletedSpanRecorder | undefined,
): void {
  completedSpanRecorder = recorder;
}

export function appendAddressedEcho(
  tm: TranscriptManagerLike,
  session: any,
  isAddressedChatOnScreen: () => boolean,
  buildEntry: (entries: readonly TranscriptEntry[]) => TranscriptEntry,
  appendOptions: { onPersistOutcome(value: boolean): void },
): { entry: TranscriptEntry; isOnActiveTranscript: boolean } {
  if (isAddressedChatOnScreen()) {
    const entry = tm.appendEntry(buildEntry(getTranscript()), {
      persistBeforeEmit: true,
      deferEmit: true,
      onPersistOutcome: appendOptions.onPersistOutcome,
    });
    return { entry, isOnActiveTranscript: true };
  }
  const entry = buildEntry(session.db.getTranscriptEntries());
  const durable = session.db.appendTranscriptEntry(entry);
  appendOptions.onPersistOutcome(durable);
  if (!durable) throw new SandSendNotPersistedError();
  if (entryRaisesUserActivitySignal(entry))
    tm.sessionStore.markSessionActivity(session);
  return { entry, isOnActiveTranscript: false };
}

export function applySendRosterSideEffects(
  tm: TranscriptManagerLike,
  session: any,
  trimmedPrompt: string,
  readAddressedTranscript: () => readonly TranscriptEntry[],
): boolean {
  let needsRosterRefresh = false;
  const profilePath = getSandProfilePath(dirname(session.dbPath));
  const currentProfile = readSandProfileFile(profilePath);
  const effectiveName =
    currentProfile != null && currentProfile.name.trim().length > 0
      ? currentProfile.name
      : SAND_DEFAULT_AGENT_NAME;
  if (
    readAddressedTranscript().length === 0 &&
    isSandDefaultAgentName(effectiveName)
  ) {
    const trimmedSeed =
      trimmedPrompt.length > 0 ? trimmedPrompt : "New conversation";
    const seededName = trimmedSeed.replace(/\s+/g, " ").slice(0, 72);
    writeSandProfileFile(profilePath, {
      name: seededName,
      description: currentProfile?.description ?? "",
      title: currentProfile?.title ?? "",
      avatarShape: currentProfile?.avatarShape ?? "",
      avatarColor: currentProfile?.avatarColor ?? "",
    });
    tm.roster.lastKnownAgentNames.set(session.id, seededName);
    needsRosterRefresh = true;
  }
  tm.trayErrors.clearForAgent(session.id);
  if (session.db.getAwaitingUserResponse() != null) {
    session.db.setAwaitingUserResponse(null);
    needsRosterRefresh = true;
  }
  return needsRosterRefresh;
}

export function emitAcceptedSendEchoes(args: {
  tm: TranscriptManagerLike;
  session: { id: string };
  echoEntries: readonly {
    entry: TranscriptEntry;
    isOnActiveTranscript: boolean;
  }[];
  isAddressedChatOnScreen(): boolean;
  directAddressedAcceptance: boolean;
  clientNonce?: string;
  traceCtx?: SendAcceptanceTraceContext;
  sendTrace?: SendAcceptanceTrace;
  acceptedDurably: boolean;
  durableAppendStartEpochMs: number;
  durableAppendStartPerfMs: number;
  hostReceiptEpochMs: number;
  hostReceiptPerfMs: number;
}): void {
  const onScreen = args.isAddressedChatOnScreen();
  let hasOffscreenEntries = false;
  for (const echo of args.echoEntries) {
    if (echo.isOnActiveTranscript && onScreen)
      args.tm.roster.emit({ type: "appended", entry: echo.entry });
    else {
      hasOffscreenEntries = true;
      if (args.directAddressedAcceptance)
        args.tm.roster.emit(
          { type: "appended", entry: echo.entry },
          args.session.id,
        );
    }
  }
  if (hasOffscreenEntries) {
    void args.tm.roster.emitAgentUpdate(args.session.id);
  }
  if (args.traceCtx !== undefined && completedSpanRecorder !== undefined) {
    try {
      const nonceAttributes =
        args.clientNonce != null && args.clientNonce.length > 0
          ? { "sand.client_nonce": args.clientNonce }
          : {};
      const durableAppendMs = Math.max(
        0,
        Math.round(performance.now() - args.durableAppendStartPerfMs),
      );
      completedSpanRecorder(
        args.traceCtx.withName("durable-append"),
        {
          startTime: new Date(args.durableAppendStartEpochMs),
          attributes: {
            "sand.durable_append_ms": durableAppendMs,
            "sand.durable": args.acceptedDurably,
            "sand.conversation_id": args.session.id,
            ...nonceAttributes,
          },
        },
        new Date(args.durableAppendStartEpochMs + durableAppendMs),
      );
      const ackEmitHostMs = Math.max(
        0,
        Math.round(performance.now() - args.hostReceiptPerfMs),
      );
      completedSpanRecorder(
        args.traceCtx.withName("send-ack-emit"),
        {
          startTime: new Date(args.hostReceiptEpochMs),
          attributes: {
            "sand.ack_emit_host_ms": ackEmitHostMs,
            "sand.conversation_id": args.session.id,
            ...nonceAttributes,
          },
        },
        new Date(args.hostReceiptEpochMs + ackEmitHostMs),
      );
      args.sendTrace?.span.setAttribute("sand.ack_emit_host_ms", ackEmitHostMs);
    } catch {}
  }
  if (hasOffscreenEntries) {
    console.warn(
      `[sand] send raced a chat switch away from ${args.session.id}: entries persisted to the addressed store off screen`,
    );
  }
}
