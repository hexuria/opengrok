import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

import { entryRaisesUserActivitySignal } from "../../../shared/transcript.js";
import { clampAgentMessage } from "../../agents/agent-messaging.js";
import {
  formatRemoteAgentId,
  SAND_SHARED_ROOM_IMAGE_BYTES_MAX,
} from "../../../shared/agents/sharing.js";
import {
  GROUP_CONFIG_VERSION,
  readSandGroupConfig,
  writeSandGroupConfig,
  type SandGroupConfig,
} from "../../groups/group-store.js";
import {
  REMOTE_ROOM_CONFIG_VERSION,
  readSandRemoteRoomConfig,
  writeSandRemoteRoomConfig,
} from "../../groups/remote-room-store.js";
import { isPassContent } from "../../groups/group-chat.js";
import { nextEntryId } from "./transcript-entry-ids.js";
import { getTranscript, updateEntry } from "./transcript-store.js";
import type {
  TranscriptEntry,
  TranscriptManagerLike,
} from "./transcript-hub.js";

export function decodeAvatarDataUrl(dataUrl: string): Buffer | null {
  const marker = ";base64,";
  const index = dataUrl.indexOf(marker);
  if (!dataUrl.startsWith("data:image/") || index === -1) return null;
  try {
    const bytes = Buffer.from(dataUrl.slice(index + marker.length), "base64");
    return bytes.length > 0 ? bytes : null;
  } catch {
    return null;
  }
}

export function isRoomContentEntry(entry: TranscriptEntry): boolean {
  return entry.kind === "message" || entry.kind === "send-message";
}

type LiveSession = any;

export class SharedRooms {
  constructor(readonly tm: TranscriptManagerLike) {}

  async postToGroup(
    fromAgentId: string,
    groupId: string,
    text: string,
    priority = false,
  ): Promise<string> {
    const message = clampAgentMessage(text);
    if (message.length === 0) return "Message was empty; nothing was sent.";
    if (isPassContent(message)) {
      return 'Nothing was posted: "(pass)" means staying silent in a group chat.';
    }
    if (!this.tm.execution.canExecute)
      return "Messaging isn't available right now.";

    let roomSession: LiveSession;
    try {
      roomSession = await this.tm.sessions.resolveBackgroundSession(groupId);
    } catch {
      return `No group found with id ${groupId}.`;
    }
    const config = readSandGroupConfig(dirname(roomSession.dbPath));
    if (config == null) return `${groupId} is not a group chat.`;
    if (!config.memberIds.includes(fromAgentId)) {
      return "You can only post to a group you're a member of.";
    }

    const groupName = this.tm.groupChat.groupIdentityFor(roomSession).name;
    const member = (
      await this.tm.groupChat.resolveGroupMembers([fromAgentId])
    )[0] ?? {
      id: fromAgentId,
      name: "An agent",
      description: "",
    };
    this.tm.productAnalytics.trackEvent("sand.agent_message.sent", {
      from_agent_id: fromAgentId,
      to_agent_id: groupId,
      is_group_target: true,
      is_priority: priority,
    });
    this.tm.backgroundWakes.appendAgentOutboundEntry(
      fromAgentId,
      { id: groupId, name: groupName, kind: "group" },
      message,
      Date.now(),
    );
    this.tm.groupChat.postGroupMemberMessage(roomSession, member, message);
    const epoch = this.tm.sendPipeline.nextTurnEpoch(roomSession);
    this.tm.runLifecycle.beginSessionRun(roomSession);
    void this.tm.runLifecycle.enqueueExclusiveRun(
      roomSession.id,
      () => {
        this.tm.turnRuntime.activeRequestSources.set(roomSession.id, "agent");
        return this.tm.groupChat.runGroupTurn(
          roomSession,
          epoch,
          undefined,
          "agent",
        );
      },
      { lane: "agent", source: "agent" },
    );
    return `Posted to "${groupName}". Its members will see it and reply on their own turns.`;
  }

  sharedRoomConfigOf(session: LiveSession): SandGroupConfig | null {
    const config = readSandGroupConfig(dirname(session.dbPath));
    return config?.sharedRoomId == null ? null : config;
  }

  publishSharedRoomEntryIfNeeded(
    session: LiveSession,
    entry: TranscriptEntry,
  ): void {
    const delegate = this.tm.xuserDelegate;
    const config = this.sharedRoomConfigOf(session);
    if (delegate == null || config?.sharedRoomId == null) return;
    delegate.publishRoomEntry(config.sharedRoomId, entry);
  }

  async dispatchMirrorRoomSend(session: LiveSession, args: any): Promise<void> {
    const appendNotice = (text: string): void => {
      const notice: TranscriptEntry = {
        kind: "notice",
        id: `notice-xuser-${randomUUID()}`,
        text,
        timestampMs: Date.now(),
      };
      if (this.tm.sessions.activeSession?.id === session.id)
        this.tm.appendEntry(notice);
      else {
        session.db.appendTranscriptEntry(notice);
        void this.tm.roster.emitAgentUpdate(session.id);
      }
    };
    const remote = readSandRemoteRoomConfig(dirname(session.dbPath));
    const delegate = this.tm.xuserDelegate;
    if (remote == null || delegate == null || !delegate.isEnabled()) {
      appendNotice(
        "This shared chat isn't connected right now, so the message wasn't delivered.",
      );
      return;
    }
    if (remote.isRevoked === true) {
      appendNotice(
        "You no longer have access to this shared chat, so the message wasn't delivered.",
      );
      return;
    }
    if (args.hasNonImageAttachments) {
      appendNotice(
        "Only text and images can be sent to shared chats for now; other attachments were not delivered.",
      );
    }

    const images: Array<{ base64: string; mediaType: string }> = [];
    let totalImageBytes = 0;
    let omitted = false;
    for (const image of args.selectedImages.slice(0, 4)) {
      if (
        totalImageBytes + image.data.byteLength >
        SAND_SHARED_ROOM_IMAGE_BYTES_MAX
      ) {
        omitted = true;
        continue;
      }
      totalImageBytes += image.data.byteLength;
      images.push({
        base64: Buffer.from(image.data).toString("base64"),
        mediaType: image.mimeType ?? "image/png",
      });
    }
    if (args.selectedImages.length > 4 || omitted) {
      appendNotice(
        "Some images were too large for the shared chat and were not delivered.",
      );
    }
    try {
      const result = await delegate.sendMirrorPost({
        roomId: remote.roomId,
        text: args.text,
        images,
        ...(args.clientNonce ? { clientNonce: args.clientNonce } : {}),
      });
      if (result.timestampMs != null && args.clientNonce) {
        const entries =
          this.tm.sessions.activeSession?.id === session.id
            ? getTranscript()
            : session.db.getTranscriptEntries();
        const echo = [...entries]
          .reverse()
          .find(
            (entry: TranscriptEntry) =>
              entry.kind === "message" &&
              entry.clientNonce === args.clientNonce,
          );
        if (echo != null)
          this.restampSessionEntry(session, echo.id, result.timestampMs);
      }
    } catch (error) {
      console.warn(
        `[sand:sharing] mirror send failed room=${remote.roomId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      appendNotice(
        "The message couldn't be delivered to the shared chat. You may have lost access, or the connection failed.",
      );
    }
  }

  async listRoomAgentIds(roomId: string): Promise<string[]> {
    return (await this.listBoundRoomAgents(roomId)).map((agent) => agent.id);
  }

  async findRoomAgentId(roomId: string): Promise<string | null> {
    const bound = await this.listBoundRoomAgents(roomId);
    if (bound.length <= 1) return bound[0]?.id ?? null;
    return (await this.measureRoomAgents(bound)).canonical.agentId;
  }

  async listBoundRoomAgents(roomId: string): Promise<any[]> {
    const agents = await this.tm.sessionStore.listAgents();
    return agents
      .filter((agent: any) => {
        const dir = this.tm.sessionStore.getAgentDir(agent.id);
        return (
          readSandGroupConfig(dir)?.sharedRoomId === roomId ||
          readSandRemoteRoomConfig(dir)?.roomId === roomId
        );
      })
      .sort(
        (left: any, right: any) =>
          left.createdAt - right.createdAt || left.id.localeCompare(right.id),
      );
  }

  async readAgentEntries(agentId: string): Promise<TranscriptEntry[] | null> {
    if (this.tm.sessions.activeSession?.id === agentId) return getTranscript();
    try {
      return (
        await this.tm.sessions.resolveBackgroundSession(agentId)
      ).db.getTranscriptEntries();
    } catch {
      return null;
    }
  }

  async measureRoomAgents(bound: readonly any[]): Promise<{
    canonical: { agentId: string; entryCount: number; isRemovable: boolean };
    measured: Array<{
      agentId: string;
      entryCount: number;
      isRemovable: boolean;
    }>;
  }> {
    const measured = [];
    for (const agent of bound) {
      const entries = await this.readAgentEntries(agent.id);
      measured.push({
        agentId: agent.id,
        entryCount: entries?.length ?? 0,
        isRemovable: entries != null && !entries.some(isRoomContentEntry),
      });
    }
    const canonical = measured.reduce((best, candidate) =>
      candidate.entryCount > best.entryCount ? candidate : best,
    );
    return { canonical, measured };
  }

  async resolveCanonicalRoomAgent(roomId: string): Promise<string | null> {
    const bound = await this.listBoundRoomAgents(roomId);
    if (bound.length <= 1) return bound[0]?.id ?? null;
    const { canonical, measured } = await this.measureRoomAgents(bound);
    const removableIds: string[] = [];
    for (const extra of measured) {
      if (extra.agentId === canonical.agentId) continue;
      if (!extra.isRemovable) {
        console.warn(
          `[sand:sharing] keeping duplicate room agent with content room=${roomId} agent=${extra.agentId} entries=${extra.entryCount} canonical=${canonical.agentId}`,
        );
      } else removableIds.push(extra.agentId);
    }
    if (removableIds.length > 0) {
      console.warn(
        `[sand:sharing] removing ${removableIds.length} empty duplicate room agent(s) room=${roomId} canonical=${canonical.agentId}`,
      );
      await this.tm.deleteAgents(removableIds);
    }
    return canonical.agentId;
  }

  async getSharedRoomIdForAgent(agentId: string): Promise<string | null> {
    const dir = this.tm.sessionStore.getAgentDir(agentId);
    return (
      readSandGroupConfig(dir)?.sharedRoomId ??
      readSandRemoteRoomConfig(dir)?.roomId ??
      null
    );
  }

  async ensureHostedSharedRoom(args: any): Promise<string | null> {
    const existingId = await this.resolveCanonicalRoomAgent(args.roomId);
    const agents = await this.tm.sessionStore.listAgents();
    const existingIds = new Set<string>(agents.map((agent: any) => agent.id));
    const oldMembers =
      existingId == null
        ? []
        : (readSandGroupConfig(this.tm.sessionStore.getAgentDir(existingId))
            ?.remoteMembers ?? []);
    const storedAvatars = new Map(
      oldMembers.flatMap((member) =>
        member.avatarDataUrl == null
          ? []
          : [
              [
                `${member.ownerAuthId}\0${member.agentId}`,
                member.avatarDataUrl,
              ] as const,
            ],
      ),
    );
    const remoteMembers = args.remoteMembers.map((member: any) => {
      const avatarDataUrl =
        member.avatarDataUrl ??
        storedAvatars.get(`${member.ownerAuthId}\0${member.agentId}`);
      return { ...member, ...(avatarDataUrl == null ? {} : { avatarDataUrl }) };
    });
    const binding: SandGroupConfig = {
      version: GROUP_CONFIG_VERSION,
      memberIds: args.localMemberIds.filter(
        (id: string) =>
          existingIds.has(id) && !this.tm.groupChat.isGroupAgentId(id),
      ),
      remoteMembers,
      sharedRoomId: args.roomId,
    };
    if (existingId != null) {
      writeSandGroupConfig(
        this.tm.sessionStore.getAgentDir(existingId),
        binding,
      );
      await this.tm.roster.emitAgents();
      return existingId;
    }
    if (!args.isCreationAllowed) return null;
    const created = await this.tm.createBackgroundAgent(
      { name: args.name, description: "" },
      "user",
      {
        isIntroductionSuppressed: true,
        configureAgentDir: (dir: string) => writeSandGroupConfig(dir, binding),
      },
    );
    return created.agent.id;
  }

  async ensureMirrorRoom(room: any, selfAuthId: string): Promise<string> {
    const writeBinding = (dir: string): void => {
      const previous = readSandRemoteRoomConfig(dir);
      const stored = new Map(
        (previous?.members ?? []).flatMap((member) =>
          member.avatarUrl == null
            ? []
            : [
                [
                  `${member.authId}\0${member.agentId}`,
                  member.avatarUrl,
                ] as const,
              ],
        ),
      );
      const hostAvatarUrl =
        room.members.find(
          (member: any) =>
            member.kind === "human" && member.authId === room.hostAuthId,
        )?.avatarUrl ?? previous?.hostAvatarUrl;
      writeSandRemoteRoomConfig(dir, {
        version: REMOTE_ROOM_CONFIG_VERSION,
        roomId: room.roomId,
        hostAuthId: room.hostAuthId,
        hostName: room.hostName,
        ...(hostAvatarUrl == null ? {} : { hostAvatarUrl }),
        members: room.members
          .filter((member: any) => member.authId !== selfAuthId)
          .map(({ avatarDataUrl, ...member }: any) => {
            const avatarUrl =
              member.avatarUrl ??
              avatarDataUrl ??
              stored.get(`${member.authId}\0${member.agentId}`);
            return { ...member, ...(avatarUrl == null ? {} : { avatarUrl }) };
          }),
      });
    };
    const existingId = await this.resolveCanonicalRoomAgent(room.roomId);
    if (existingId != null) {
      writeBinding(this.tm.sessionStore.getAgentDir(existingId));
      await this.applyMirrorRoomPicture(existingId, room.avatarDataUrl);
      await this.tm.roster.emitAgentUpdate(existingId);
      return existingId;
    }
    const created = await this.tm.createBackgroundAgent(
      { name: room.name, description: "" },
      "user",
      { isIntroductionSuppressed: true, configureAgentDir: writeBinding },
    );
    await this.applyMirrorRoomPicture(created.agent.id, room.avatarDataUrl);
    return created.agent.id;
  }

  async applyMirrorRoomPicture(
    agentId: string,
    roomAvatarDataUrl?: string,
  ): Promise<void> {
    if (roomAvatarDataUrl == null) return;
    try {
      const current = await this.tm.sessionStore.getAgentAvatar(agentId);
      if (current.dataUrl === roomAvatarDataUrl) return;
      const bytes = decodeAvatarDataUrl(roomAvatarDataUrl);
      if (bytes == null) return;
      const active = this.tm.sessions.activeSession;
      if (active?.id === agentId) {
        await this.tm.sessionStore.setAgentAvatarBytes(
          active.db,
          active.dbPath,
          agentId,
          bytes,
          agentId,
        );
      } else await this.tm.sessionStore.setAgentAvatarBytesById(agentId, bytes);
      await this.tm.roster.emitAgentUpdate(agentId);
    } catch {
      // Invalid or transiently unavailable avatars leave the local picture alone.
    }
  }

  async markMirrorRoomRevoked(roomId: string): Promise<void> {
    const agentId = await this.tm.findRoomAgentId(roomId);
    if (agentId == null) return;
    const dir = this.tm.sessionStore.getAgentDir(agentId);
    const config = readSandRemoteRoomConfig(dir);
    if (config == null || config.isRevoked === true) return;
    writeSandRemoteRoomConfig(dir, { ...config, isRevoked: true });
    await this.tm.roster.emitAgentUpdate(agentId);
  }

  async appendSharedRoomActivityNotice(args: {
    roomId: string;
    text: string;
  }): Promise<void> {
    const agentId = await this.tm.findRoomAgentId(args.roomId);
    if (agentId == null) return;
    let session: LiveSession;
    try {
      session = await this.tm.sessions.resolveBackgroundSession(agentId);
    } catch {
      return;
    }
    const notice: TranscriptEntry = {
      kind: "notice",
      id: `notice-xuser-turn-${randomUUID()}`,
      text: args.text,
      timestampMs: Date.now(),
    };
    if (this.tm.sessions.activeSession?.id === session.id)
      this.tm.appendEntry(notice);
    else {
      session.db.appendTranscriptEntry(notice);
      this.tm.sessionStore.markSessionActivity(session);
      void this.tm.roster.emitAgentUpdate(session.id);
    }
  }

  async appendMirrorRoomEntry(args: any): Promise<boolean> {
    const agentId = await this.tm.findRoomAgentId(args.roomId);
    if (agentId == null) return false;
    let session: LiveSession;
    try {
      session = await this.tm.sessions.resolveBackgroundSession(agentId);
    } catch {
      return false;
    }
    if (!this.tm.groupChat.isRemoteRoomSession(session)) return false;
    const isActive = this.tm.sessions.activeSession?.id === session.id;
    const entries = isActive
      ? getTranscript()
      : session.db.getTranscriptEntries();
    const localId = `xu-${args.entry.entryId}`;
    if (entries.some((entry: TranscriptEntry) => entry.id === localId))
      return true;
    if (
      args.entry.clientNonce &&
      entries.some(
        (entry: TranscriptEntry) =>
          entry.kind === "message" &&
          entry.clientNonce === args.entry.clientNonce,
      )
    )
      return true;

    const images = await this.tm.sendPipeline.materializeInlineImages(
      session,
      args.entry.images,
    );
    const entry: TranscriptEntry =
      args.entry.kind === "human-message"
        ? {
            kind: "message",
            id: localId,
            role: "user",
            content: args.entry.text,
            isStreaming: false,
            timestampMs: args.entry.timestampMs,
            ...(args.entry.clientNonce
              ? { clientNonce: args.entry.clientNonce }
              : {}),
            ...(args.entry.authorAuthId === args.selfAuthId
              ? {}
              : {
                  fromUser: {
                    name: args.entry.authorName,
                    ...(args.entry.authorAuthId
                      ? { authId: args.entry.authorAuthId }
                      : {}),
                    ...(args.entry.authorAvatarUrl
                      ? { avatarUrl: args.entry.authorAvatarUrl }
                      : {}),
                  },
                }),
            ...(images.length > 0 ? { images } : {}),
          }
        : {
            kind: "send-message",
            id: localId,
            message: {
              type: "text",
              content: args.entry.text,
              ...(images.length > 0 ? { images } : {}),
            },
            timestampMs: args.entry.timestampMs,
            author: {
              id: formatRemoteAgentId({
                ownerAuthId: args.entry.agentOwnerAuthId ?? "",
                agentId: args.entry.agentId ?? "",
              }),
              name: args.entry.authorName,
            },
          };
    if (isActive) this.tm.appendEntry(entry);
    else {
      session.db.appendTranscriptEntry(entry);
      if (entryRaisesUserActivitySignal(entry))
        this.tm.sessionStore.markSessionActivity(session);
      void this.tm.roster.emitAgentUpdate(session.id);
    }
    return true;
  }

  restampSessionEntry(
    session: LiveSession,
    entryId: string,
    timestampMs: number,
  ): void {
    const stamp = (entry: TranscriptEntry): TranscriptEntry =>
      entry.kind === "message" || entry.kind === "send-message"
        ? { ...entry, timestampMs }
        : entry;
    if (this.tm.sessions.activeSession?.id === session.id) {
      const updated = updateEntry(entryId, stamp);
      if (updated != null)
        this.tm.roster.emit({ type: "updated", entry: updated });
    }
    session.db.updateTranscriptEntry(entryId, stamp);
  }

  async restampRoomEntry(args: {
    roomId: string;
    entryId: string;
    timestampMs: number;
  }): Promise<void> {
    const agentId = await this.tm.findRoomAgentId(args.roomId);
    if (agentId == null) return;
    try {
      const session = await this.tm.sessions.resolveBackgroundSession(agentId);
      this.restampSessionEntry(session, args.entryId, args.timestampMs);
    } catch {
      return;
    }
  }

  async postSharedRoomGuestMessage(args: any): Promise<void> {
    const agentId = await this.tm.findRoomAgentId(args.roomId);
    if (agentId == null) return;
    let session: LiveSession;
    try {
      session = await this.tm.sessions.resolveBackgroundSession(agentId);
    } catch {
      return;
    }
    if (this.sharedRoomConfigOf(session) == null) return;
    const text = clampAgentMessage(args.text);
    if (text.length === 0 && args.images.length === 0) return;
    const active = this.tm.sessions.activeSession?.id === session.id;
    const entries = active
      ? getTranscript()
      : session.db.getTranscriptEntries();
    if (
      args.clientNonce &&
      entries.some(
        (entry: TranscriptEntry) =>
          entry.kind === "message" && entry.clientNonce === args.clientNonce,
      )
    )
      return;
    const images = await this.tm.sendPipeline.materializeInlineImages(
      session,
      args.images,
    );
    const entry: TranscriptEntry = {
      kind: "message",
      id: nextEntryId(entries, "user-message", session.db.getRetiredEntryIds()),
      role: "user",
      content: text,
      isStreaming: false,
      timestampMs: args.timestampMs ?? Date.now(),
      fromUser: {
        name: args.authorName,
        authId: args.authorAuthId,
        ...(args.authorAvatarUrl ? { avatarUrl: args.authorAvatarUrl } : {}),
      },
      ...(args.clientNonce ? { clientNonce: args.clientNonce } : {}),
      ...(images.length > 0 ? { images } : {}),
    };
    if (active) this.tm.appendEntry(entry);
    else {
      session.db.appendTranscriptEntry(entry);
      this.tm.sessionStore.markSessionActivity(session);
      void this.tm.roster.emitAgentUpdate(session.id);
    }
    this.publishSharedRoomEntryIfNeeded(session, entry);
    const epoch = this.tm.sendPipeline.nextTurnEpoch(session);
    this.tm.runLifecycle.beginSessionRun(session);
    void this.tm.runLifecycle.enqueueExclusiveRun(
      session.id,
      () => {
        this.tm.turnRuntime.activeRequestSources.set(session.id, "agent");
        return this.tm.groupChat.runGroupTurn(
          session,
          epoch,
          undefined,
          "agent",
        );
      },
      { lane: "agent", source: "agent" },
    );
  }

  async runRemoteRequestedMemberTurn(args: any): Promise<string[]> {
    if (!this.tm.execution.canExecuteGroupMember) return [];
    if (this.tm.groupChat.isGroupAgentId(args.agentId)) return [];
    if (this.tm.groupChat.isRemoteRoomAgentId(args.agentId)) return [];
    let session: LiveSession;
    try {
      session = await this.tm.groupChat.pinMemberSessionForGroupTurn(
        args.agentId,
      );
    } catch {
      return [];
    }
    const sent: string[] = [];
    const transport = {
      onUpdate: (update: any) => {
        if (
          update.type === "send-message" &&
          update.message?.type === "text" &&
          !isPassContent(update.message.content)
        )
          sent.push(update.message.content);
      },
      lastReactionApplied: () => false,
    };
    await this.tm.runLifecycle.enqueueExclusiveRun(
      session.id,
      async () => {
        this.tm.turnRuntime.activeRequestSources.set(session.id, "agent");
        try {
          const runner = this.tm.execution.createGroupMemberRunner(
            session,
            this.tm.runnerRegistry.runnerHooksFor(session, transport),
            { systemPrompt: args.systemPrompt, isSharedRoomTurn: true },
          );
          this.tm.runnerRegistry.wireRunnerLifecycle(
            runner,
            session,
            session.id,
          );
          await runner.run(args.prompt, {});
        } catch {
          return;
        } finally {
          this.tm.runLifecycle.endSessionRun(session);
        }
      },
      { lane: "background", source: "group-member" },
    );
    return sent;
  }
}
