import { existsSync } from "node:fs";
import { join } from "node:path";
import { isSandAgentLimitError } from "../../../shared/agents/agents.js";
import { errorLogTag } from "../../../shared/errors.js";
import {
  cloneAgentDir,
  cloneAgentDisplayName,
} from "../../agents/agent-clone.js";
import { CANONICAL_AVATAR_FILENAME } from "../../agents/agent-avatar.js";
import { getAgentAutomationsDir } from "../../automations/automation-store.js";
import {
  SAND_DISK_SAVER_KICKSTART_PROMPT,
  SAND_DISK_SAVER_REAUDIT_PROMPT,
} from "../../../shared/agents/disk-saver.js";
import {
  INTRODUCTION_FAILED_TRAY_TITLE,
  SAND_ONBOARDING_KICKSTART_PROMPT,
  introductionFailedTrayKey,
} from "../../../shared/agents/onboarding.js";
import { sandErrorDetail } from "../../ports/telemetry.js";
import { SandAgentDb } from "../session/agent-db.js";
import { checkpointSandAgentDb } from "../../storage/store-db.js";
import { publishTranscriptMutation } from "../../transcript-mutation-events.js";
import { describeAgentRunError } from "./agent-run-error.js";
import { isUserMessageEntry } from "./send-message-shaping.js";
import { getTranscript } from "./transcript-store.js";
import { classifyAgentError } from "./turn-runtime.js";
import type { TranscriptManagerLike } from "./transcript-hub.js";

export class SandAgentLifecycleError extends Error {}
interface CreateOptions {
  purpose?: string;
  isKickstartRequested?: boolean;
  isIntroductionSuppressed?: boolean;
  configureAgentDir?(dir: string): void;
}

export class AgentLifecycle {
  constructor(readonly tm: TranscriptManagerLike) {}

  async createAgent(
    profile: unknown,
    origin = "user",
    options: CreateOptions = {},
  ): Promise<any> {
    const previous = this.tm.sessions.activeSession;
    const next = await this.mintAgentSession(profile, origin, options);
    const now = Date.now();
    await this.tm.sessions.markSessionLeftBehind(previous, now);
    await this.tm.sessionStore.markSessionViewed(next, now);
    this.tm.sessions.invalidateDeferredActivation();
    await this.tm.sessions.replaceSession(next);
    this.tm.sessions.clearActiveTranscript(next.id);
    this.tm.roster.emit({ type: "cleared" });
    await this.tm.roster.emitAgents();
    const stamp = this.tm.roster.reserveSnapshotStamp();
    const summary = await this.tm.sessionStore.summarizeOpenSession(next);
    if (summary == null)
      throw new SandAgentLifecycleError(
        "Failed to summarize newly created Sand agent.",
      );
    if (options.isKickstartRequested === true)
      void this.kickstartCreatedAgent(next.id);
    return {
      agent: this.tm.roster.finalizeSummaryForRpc(summary, stamp),
      transcript: getTranscript(),
    };
  }
  async kickstartCreatedAgent(agentId: string): Promise<void> {
    let ready = false;
    try {
      ready = await this.tm.execution.isRunReady();
    } catch {}
    await this.kickstartAgent(agentId, ready);
  }
  async createBackgroundAgent(
    profile: unknown,
    origin = "user",
    options: CreateOptions = {},
  ): Promise<any> {
    const session = await this.mintAgentSession(profile, origin, options);
    try {
      const transcript = session.db.getTranscriptEntries();
      await this.tm.roster.emitAgents();
      const stamp = this.tm.roster.reserveSnapshotStamp();
      const summary = await this.tm.sessionStore.summarizeOpenSession(session);
      if (summary == null)
        throw new SandAgentLifecycleError(
          "Failed to summarize newly created Sand agent.",
        );
      return {
        agent: this.tm.roster.finalizeSummaryForRpc(summary, stamp),
        transcript,
      };
    } finally {
      await session.agentStore.dispose();
      session.db.close();
    }
  }
  async mintAgentSession(
    profile: unknown,
    origin: string,
    options: CreateOptions,
  ): Promise<any> {
    const session = await this.tm.sessionStore.createSession(
      profile,
      origin,
      options.purpose,
    );
    options.configureAgentDir?.(this.tm.sessionStore.getAgentDir(session.id));
    if (options.isIntroductionSuppressed !== true)
      session.db.setIntroductionPending(true);
    return session;
  }

  async kickstartAgent(agentId: string, isRunReady: boolean): Promise<boolean> {
    let session: any;
    try {
      session =
        this.tm.sessions.activeSession?.id === agentId
          ? this.tm.sessions.activeSession
          : await this.tm.sessions.resolveBackgroundSession(agentId);
    } catch {
      return false;
    }
    if (
      this.tm.groupChat.isGroupSession(session) ||
      this.tm.groupChat.isRemoteRoomSession(session) ||
      !session.db.getIntroductionPending()
    )
      return false;
    if (session.db.getTranscriptEntries().some(isUserMessageEntry)) {
      session.db.setIntroductionPending(false);
      return false;
    }
    if (!isRunReady || !this.tm.execution.canExecute) return false;
    if (this.tm.runLifecycle.inFlightRunCounts.has(session)) return true;
    const runner = this.tm.runnerRegistry.getRunner(session);
    this.tm.runLifecycle.beginSessionRun(session);
    void this.tm.runLifecycle.enqueueExclusiveRun(
      session.id,
      async () => {
        this.tm.turnRuntime.activeRequestSources.set(session.id, "turn");
        try {
          const prompt =
            session.db.getAgentPurpose() === "disk-saver"
              ? SAND_DISK_SAVER_KICKSTART_PROMPT
              : SAND_ONBOARDING_KICKSTART_PROMPT;
          const result = await runner.run(prompt, { hidden: true });
          let delivered = result.sentMessageCount > 0;
          if (!result.aborted && result.sentMessageCount === 0)
            delivered =
              await this.tm.automationRuntime.ensureHiddenTurnReply(runner);
          if (result.quiescedForUpgrade) {
            this.tm.upgradeResume.markAgentResumePending(session, "turn");
            session.db.setIntroductionPending(false);
          } else if (!result.aborted && delivered)
            session.db.setIntroductionPending(false);
          await this.tm.roster.emitAgentUpdate(session.id);
        } catch (error) {
          this.tm.telemetry.reportAgentError({
            source: "onboarding_kickstart",
            conversationId: session.id,
            requestId: this.tm.runLifecycle.lastRequestIdBySession.get(
              session.id,
            ),
            error: classifyAgentError(error),
            detail: sandErrorDetail(error),
          });
          this.tm.trayErrors.pushError({
            agentId: session.id,
            title: INTRODUCTION_FAILED_TRAY_TITLE,
            ...describeAgentRunError(error),
            dedupeKey: introductionFailedTrayKey(session.id),
          });
        } finally {
          this.tm.runLifecycle.endSessionRun(session);
        }
      },
      { lane: "user", source: "kickstart" },
    );
    return true;
  }

  async requestDiskSaverAudit(
    agentId: string,
    isRunReady: boolean,
  ): Promise<boolean> {
    let session: any;
    try {
      session =
        this.tm.sessions.activeSession?.id === agentId
          ? this.tm.sessions.activeSession
          : await this.tm.sessions.resolveBackgroundSession(agentId);
    } catch {
      return false;
    }
    if (
      this.tm.groupChat.isGroupSession(session) ||
      this.tm.groupChat.isRemoteRoomSession(session) ||
      session.db.getAgentPurpose() !== "disk-saver"
    )
      return false;
    if (session.db.getIntroductionPending())
      return this.kickstartAgent(agentId, isRunReady);
    if (!isRunReady || !this.tm.execution.canExecute) return false;
    if (this.tm.runLifecycle.inFlightRunCounts.has(session)) return true;
    const runner = this.tm.runnerRegistry.getRunner(session);
    this.tm.runLifecycle.beginSessionRun(session);
    void this.tm.runLifecycle.enqueueExclusiveRun(
      session.id,
      async () => {
        this.tm.turnRuntime.activeRequestSources.set(session.id, "event");
        try {
          const result = await runner.run(SAND_DISK_SAVER_REAUDIT_PROMPT, {
            hidden: true,
          });
          if (result.quiescedForUpgrade)
            this.tm.upgradeResume.markAgentResumePending(session, "event");
          else if (!result.aborted && result.sentMessageCount === 0)
            await this.tm.automationRuntime.ensureHiddenTurnReply(runner);
          await this.tm.roster.emitAgentUpdate(session.id);
        } catch (error) {
          this.tm.telemetry.reportAgentError({
            source: "disk_saver_reaudit",
            conversationId: session.id,
            requestId: this.tm.runLifecycle.lastRequestIdBySession.get(
              session.id,
            ),
            error: classifyAgentError(error),
            detail: sandErrorDetail(error),
          });
        } finally {
          this.tm.runLifecycle.endSessionRun(session);
        }
      },
      { lane: "background", source: "event" },
    );
    return true;
  }

  async cloneAgent(sourceId: string): Promise<any> {
    const summary = (await this.tm.sessionStore.listAgents()).find(
      (agent: any) => agent.id === sourceId,
    );
    if (summary == null)
      throw new SandAgentLifecycleError("That agent no longer exists.");
    if (summary.isGroup)
      throw new SandAgentLifecycleError("Groups can't be duplicated yet.");
    const opened = await this.tm.sessionStore.mintAgent(
      async (agentId: string) => {
        cloneAgentDir(
          this.tm.sessionStore.getAgentDir(sourceId),
          this.tm.sessionStore.getAgentDir(agentId),
          agentId,
          cloneAgentDisplayName(summary.name),
          {
            getAutomationsDir: getAgentAutomationsDir,
            checkpointStore: (dbPath) => {
              checkpointSandAgentDb(dbPath);
            },
            rewriteIdentity: (targetDir, newAgentId, includesChatHistory) => {
              const db = new SandAgentDb(join(targetDir, "store.db"));
              try {
                db.set("agentId", newAgentId);
                db.setAgentOrigin("user");
                db.clearAgentPurpose();
                db.clearTransientState();
                if (!includesChatHistory) db.clearConversation();
                const avatarPath = join(targetDir, CANONICAL_AVATAR_FILENAME);
                const existing = db.getSandProfile();
                db.setSandProfile({
                  description: existing.description,
                  avatarPath: existsSync(avatarPath) ? avatarPath : null,
                });
              } finally {
                db.close();
              }
            },
          },
        );
        return this.openMintedSession(agentId);
      },
    );
    return this.commitOpenedSession(opened);
  }
  async commitOpenedSession(opened: {
    session: any;
    entries: any[];
    agent: any;
  }): Promise<any> {
    publishTranscriptMutation({
      kind: "agent-needs-reindex",
      agentId: opened.session.id,
    } as unknown as Parameters<typeof publishTranscriptMutation>[0]);
    const previous = this.tm.sessions.activeSession;
    const now = Date.now();
    await this.tm.sessions.markSessionLeftBehind(previous, now);
    await this.tm.sessionStore.markSessionViewed(opened.session, now);
    this.tm.sessions.invalidateDeferredActivation();
    await this.tm.sessions.replaceSession(opened.session);
    this.tm.sessions.setActiveTranscript(opened.session.id, opened.entries);
    this.tm.sessions.loaded = true;
    this.tm.roster.emit({
      type: "snapshot",
      activeAgentId: opened.session.id,
      entries: opened.entries,
    });
    await this.tm.roster.emitAgents();
    const stamp = this.tm.roster.reserveSnapshotStamp();
    const refreshed = await this.tm.sessionStore.summarizeOpenSession(
      opened.session,
    );
    return {
      agent: this.tm.roster.finalizeSummaryForRpc(
        refreshed ?? opened.agent,
        stamp,
      ),
      transcript: getTranscript(),
    };
  }
  async openMintedSession(newId: string): Promise<any> {
    let session: any;
    try {
      session = await this.tm.sessionStore.openSession(newId);
      const entries = await this.tm.sessionStore.getTranscriptEntries(session);
      const agent = await this.tm.sessionStore.summarizeOpenSession(session);
      if (agent == null)
        throw new SandAgentLifecycleError(
          "minted agent could not be summarized",
        );
      return { session, entries, agent };
    } catch (error) {
      await this.discardMintedSession(session, newId);
      throw error;
    }
  }
  async discardMintedSession(session: any, newId: string): Promise<void> {
    if (session != null) {
      try {
        await session.agentStore.dispose();
        session.db.close();
      } catch {}
    }
    await this.tm.sessionStore.deleteSession(newId).catch((error: unknown) => {
      console.error(
        `[sand] minted-session discard left ${newId} on disk: ${errorLogTag(error)}`,
      );
    });
  }

  async deleteAgent(agentId: string): Promise<any> {
    return this.tm.deleteAgents([agentId]);
  }
  async deleteAgents(agentIds: readonly string[]): Promise<any> {
    const ids = new Set(agentIds);
    if (ids.size === 0) return { transcript: getTranscript() };
    try {
      return await this.runDeleteAgents(ids);
    } catch (error) {
      for (const id of ids)
        if (this.tm.sessionStore.agentDirExists(id))
          this.tm.sessions.deletedAgentIds.delete(id);
      throw error;
    }
  }
  async runDeleteAgents(ids: ReadonlySet<string>): Promise<any> {
    const active = await this.tm.sessions.tryEnsureSession();
    const deletingActive = active != null && ids.has(active.id);
    for (const id of ids) await this.interruptAgentForDeletion(id);
    for (const id of ids) this.tm.trayErrors.clearForAgent(id);
    for (const id of ids) {
      if (id === active?.id) continue;
      this.tm.runnerRegistry.runners.delete(id);
      this.tm.sessions.liveSessions.delete(id);
      this.tm.sessions.pendingSessionOpens.delete(id);
      await this.tm.sessionStore.deleteSession(id);
      this.tm.onAgentForgotten?.(id);
      this.tm.pendingWakeStore?.clearAgent(id);
      this.tm.boxHandoff.boxHandoffs.delete(id);
      this.tm.boxHandoff.awaitingSink.clear(id);
      this.tm.roster.emitAsyncTasksForAgent(id);
    }
    if (!deletingActive || active == null) {
      await this.tm.roster.emitAgents();
      return { transcript: getTranscript() };
    }
    await active.agentStore.dispose();
    this.tm.runnerRegistry.runners.delete(active.id);
    this.tm.sessions.liveSessions.delete(active.id);
    this.tm.sessions.pendingSessionOpens.delete(active.id);
    this.tm.runLifecycle.closeSessionWhenIdle(active);
    await this.tm.sessionStore.deleteSession(active.id);
    this.tm.onAgentForgotten?.(active.id);
    this.tm.pendingWakeStore?.clearAgent(active.id);
    this.tm.boxHandoff.boxHandoffs.delete(active.id);
    this.tm.boxHandoff.awaitingSink.clear(active.id);
    this.tm.roster.emitAsyncTasksForAgent(active.id);
    const nextAgent = (await this.tm.sessionStore.listAgents(active.id)).find(
      (agent: any) => !ids.has(agent.id),
    );
    const successorIds = [
      ...(nextAgent == null ? [] : [nextAgent.id]),
      ...(await this.tm.sessionStore.listAgentRecordIds()).filter(
        (id: string) => !ids.has(id) && id !== nextAgent?.id,
      ),
    ];
    for (const successorId of successorIds) {
      let nextSession: any;
      try {
        nextSession =
          this.tm.sessions.liveSessions.get(successorId) ??
          (await this.tm.sessions.openSessionOnce(successorId));
      } catch (error) {
        console.error(
          `[sand] skipping unopenable agent ${successorId} after delete: ${errorLogTag(error)}`,
        );
        continue;
      }
      await this.tm.sessionStore.markSessionViewed(nextSession);
      this.tm.sessions.invalidateDeferredActivation();
      this.tm.sessions.setActiveSession(nextSession);
      this.tm.runLifecycle.watchActiveSession(nextSession);
      const entries =
        await this.tm.sessionStore.getTranscriptEntries(nextSession);
      this.tm.sessions.setActiveTranscript(nextSession.id, entries);
      this.tm.sessions.loaded = true;
      this.tm.roster.emit({
        type: "snapshot",
        activeAgentId: nextSession.id,
        entries,
      });
      await this.tm.roster.emitAgents();
      return { transcript: entries };
    }
    try {
      const next = await this.tm.sessionStore.createFallbackSession(
        (id: string) => this.tm.sessions.openSessionOnce(id),
      );
      await this.tm.sessionStore.markSessionViewed(next);
      this.tm.sessions.invalidateDeferredActivation();
      this.tm.sessions.setActiveSession(next);
      this.tm.runLifecycle.watchActiveSession(next);
      this.tm.sessions.clearActiveTranscript(next.id);
      this.tm.sessions.loaded = true;
      this.tm.roster.emit({ type: "cleared" });
      await this.tm.roster.emitAgents();
      return { transcript: getTranscript() };
    } catch (error) {
      if (!isSandAgentLimitError(error)) throw error;
      this.tm.sessions.activeSession = undefined;
      this.tm.unwatchActiveSession();
      this.tm.sessions.clearActiveTranscript(null);
      this.tm.sessions.loaded = false;
      this.tm.roster.emit({ type: "cleared" });
      await this.tm.roster.emitAgents();
      return { transcript: getTranscript() };
    }
  }

  async interruptAgentForDeletion(agentId: string): Promise<void> {
    this.tm.sessions.deletedAgentIds.add(agentId);
    this.tm.ackObligations.markAckObligationLost(agentId, "agent_deleted");
    this.tm.ackObligations.ackRunTokens.delete(agentId);
    for (const queue of [
      this.tm.backgroundWakes.pendingSubagentCompletions,
      this.tm.backgroundWakes.pendingShellCompletions,
      this.tm.backgroundWakes.pendingInbound,
      this.tm.backgroundWakes.pendingAgentInbound,
      this.tm.backgroundWakes.pendingChannelFailures,
    ])
      queue.delete(agentId);
    this.tm.groupChat.dmPreemptedGroupMemberIds.delete(agentId);
    this.tm.backgroundWakes.dmPreemptedWakeAgentIds.delete(agentId);
    this.tm.roster.forgetAgentSubagentWork(agentId);
    this.tm.roster.lastRunnerAsyncTasks.delete(agentId);
    const groupRunner =
      this.tm.runnerRegistry.activeGroupMemberRunners.get(agentId);
    const runner = this.tm.runnerRegistry.runners.get(agentId);
    if (runner != null || groupRunner != null) {
      const wasInFlight = this.tm.runLifecycle.runningAgentIds().has(agentId);
      const hadGroup = groupRunner?.interruptAll("agent deleted") ?? false;
      const hadActiveRun =
        (runner?.interruptAll("agent deleted") ?? false) || hadGroup;
      this.tm.telemetry.reportTurnInterrupt({
        conversationId: agentId,
        reason: "agent_deleted",
        hadActiveRun,
        wasInFlight,
      });
      runner?.cancelBackgroundShellRewatches();
      groupRunner?.cancelBackgroundShellRewatches();
    }
    await this.tm.runLifecycle.drainExclusiveRuns(agentId);
    await runner?.drainBackgroundSubagents();
    await groupRunner?.drainBackgroundSubagents();
  }

  async updateAgent(agentId: string, profile: any): Promise<unknown> {
    const trimmed = {
      ...(profile.avatarShape === undefined
        ? {}
        : { avatarShape: profile.avatarShape.trim() }),
      ...(profile.avatarColor === undefined
        ? {}
        : { avatarColor: profile.avatarColor.trim() }),
      name: profile.name.trim(),
      description: profile.description.trim(),
      ...(profile.title === undefined ? {} : { title: profile.title.trim() }),
    };
    const stamp = this.tm.roster.reserveSnapshotStamp();
    const active = this.tm.sessions.activeSession;
    const summary =
      active?.id === agentId
        ? (this.tm.sessionStore.writeAgentProfileFile(agentId, trimmed),
          await this.tm.sessionStore.summarizeOpenSession(active))
        : await this.tm.sessionStore.updateAgentProfile(agentId, trimmed);
    await this.tm.roster.emitAgentUpdate(agentId);
    this.tm.roster.emitProfileChanged(agentId);
    return summary == null
      ? null
      : this.tm.roster.finalizeSummaryForRpc(summary, stamp);
  }
  async setAgentUnread(
    agentId: string,
    isUnread: boolean,
    atMs?: number,
  ): Promise<void> {
    const active = this.tm.sessions.activeSession;
    if (active?.id === agentId) {
      if (isUnread) {
        await this.tm.sessionStore.seedSessionActivityFromDbMtime(active);
        active.db.markUnread(atMs);
      } else active.db.markRead();
    } else await this.tm.sessionStore.setSessionUnread(agentId, isUnread, atMs);
    await this.tm.roster.emitAgentUpdate(agentId);
  }
  async setAgentNotifyOnUpdates(
    agentId: string,
    enabled: boolean,
  ): Promise<void> {
    this.tm.sessionStore.setSessionNotifyOnUpdates(agentId, enabled);
    await this.tm.roster.emitAgentUpdate(agentId);
  }
  async setAgentHiddenFromSidebar(
    agentId: string,
    hidden: boolean,
  ): Promise<void> {
    this.tm.sessionStore.setSessionHiddenFromSidebar(agentId, hidden);
    await this.tm.roster.emitAgentUpdate(agentId);
  }
  async setAgentAvatarBytes(
    agentId: string,
    pngBytes: Uint8Array,
  ): Promise<unknown> {
    const active = this.tm.sessions.activeSession,
      stamp = this.tm.roster.reserveSnapshotStamp();
    const summary =
      active?.id === agentId
        ? await this.tm.sessionStore.setAgentAvatarBytes(
            active.db,
            active.dbPath,
            agentId,
            pngBytes,
            agentId,
          )
        : await this.tm.sessionStore.setAgentAvatarBytesById(agentId, pngBytes);
    await this.tm.roster.emitAgentUpdate(agentId);
    this.tm.roster.emitProfileChanged(agentId);
    return summary == null
      ? null
      : this.tm.roster.finalizeSummaryForRpc(summary, stamp);
  }
  getAgentAvatar(agentId: string): Promise<unknown> {
    return this.tm.sessionStore.getAgentAvatar(agentId);
  }
}
