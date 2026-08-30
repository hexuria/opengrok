import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import {
  realClock,
  type Clock,
  type DebouncePolicy,
} from "../../../internal/scheduling.js";
import { isSandSubagentId } from "../../../shared/agents/subagents.js";
import { transcriptReplicaKey } from "../../../shared/ordering.js";
import { SEND_MESSAGE_TOOL_CALL_OUTLINE_NAME } from "../../runner/conversation-outline.js";
import { mergeAsyncTasks } from "./async-task-union.js";
import { ProfileWatch } from "./profile-watch.js";
import { RosterEmit } from "./roster-emit.js";
import { RosterSearch } from "./roster-search.js";
import type { TranscriptManagerLike } from "./transcript-hub.js";

export const OUTLINE_STREAM_COALESCE_MS = 250;

interface OutlineUpdate {
  agentId: string;
  item: any;
}

export class RosterProjection {
  readonly emitter = new EventEmitter();
  readonly search: RosterSearch;
  readonly rosterSearch: RosterSearch;
  readonly profileWatch: ProfileWatch;
  readonly rosterEmit: RosterEmit;
  readonly lastKnownAgentNames: Map<string, string>;

  readonly subagentWorkSources = new Map<string, Set<any>>();
  readonly reportedSubagentParents = new Set<string>();
  readonly lastRunnerAsyncTasks = new Map<string, Map<any, any[]>>();

  outline: any[] = [];
  outlineAgentId: string | null = null;
  streamingAssistantOutlineId: string | undefined;
  streamingThinkingOutlineId: string | undefined;
  activeOutlineLoad: Promise<any[]> | null = null;
  activeOutlineGeneration = 0;

  private pendingStreamOutlineUpdate: OutlineUpdate | null = null;
  private streamOutlineFlush:
    (((...args: any[]) => void) & { dispose(): void }) | null = null;
  private streamOutlineClock: Clock = realClock;
  private lastStreamOutlineFlushAtMs = 0;

  constructor(readonly tm: TranscriptManagerLike) {
    this.rosterEmit = new RosterEmit(tm, this.emitter);
    this.profileWatch = new ProfileWatch(tm, this.emitter, this.rosterEmit);
    this.search = new RosterSearch(tm);
    this.rosterSearch = this.search;
    this.lastKnownAgentNames = this.profileWatch.lastKnownAgentNames;
  }

  get cachedAgentSummaries(): any[] {
    return this.rosterEmit.cachedAgentSummaries;
  }

  set cachedAgentSummaries(agents: any[]) {
    this.rosterEmit.cachedAgentSummaries = agents;
  }

  setOutlineStreamCoalescing(
    policy: DebouncePolicy,
    clock: Clock = realClock,
  ): void {
    this.streamOutlineFlush?.dispose();
    this.streamOutlineFlush = policy.wrap(() =>
      this.flushStreamOutlineUpdate(),
    );
    this.streamOutlineClock = clock;
    this.lastStreamOutlineFlushAtMs = clock.monotonicNow();
  }

  stopOutlineStreamCoalescing(): void {
    this.streamOutlineFlush?.dispose();
    this.streamOutlineFlush = null;
    this.pendingStreamOutlineUpdate = null;
  }

  flushStreamOutlineUpdate(): void {
    const pending = this.pendingStreamOutlineUpdate;
    if (pending == null) return;
    this.pendingStreamOutlineUpdate = null;
    this.lastStreamOutlineFlushAtMs = this.streamOutlineClock.monotonicNow();
    this.emitter.emit("outline", {
      type: "updated",
      agentId: pending.agentId,
      item: pending.item,
    });
  }

  async listAgents(): Promise<any[]> {
    const session = await this.tm.sessions.tryEnsureSession();
    const announcedId =
      this.tm.sessions.getAnnouncedActiveAgentId() ?? session?.id;
    const stamp = this.rosterEmit.reserveSnapshotStamp();
    const agents = this.rosterEmit.applySnapshotStamp(
      this.tm.runLifecycle.withRunStates(
        await this.tm.sessionStore.listAgents(announcedId),
      ),
      stamp,
    );
    await this.rosterEmit.enqueueEmit(async () => {
      if (!this.rosterEmit.rosterCacheSeeded) {
        this.rosterEmit.cachedAgentSummaries = agents;
        this.rosterEmit.rosterCacheSeeded = true;
      }
    });
    return agents;
  }

  async countAgentsOnDisk(): Promise<number> {
    return (await this.tm.sessionStore.listAgents()).length;
  }

  async isAgentCapReached(): Promise<boolean> {
    return this.tm.sessionStore.isAgentCapReached();
  }

  searchAgents(...args: Parameters<RosterSearch["searchAgents"]>) {
    return this.search.searchAgents(...args);
  }

  searchMedia(...args: Parameters<RosterSearch["searchMedia"]>) {
    return this.search.searchMedia(...args);
  }

  listAgentsSync(): any[] {
    return this.rosterEmit.cachedAgentSummaries;
  }

  subscribeAgents(listener: (value: any) => void): () => void {
    this.emitter.on("agents", listener);
    return () => this.emitter.off("agents", listener);
  }

  subscribeAgentUpserted(listener: (value: any) => void): () => void {
    this.emitter.on("agent-upserted", listener);
    return () => this.emitter.off("agent-upserted", listener);
  }

  emitProfileChanged(
    ...args: Parameters<ProfileWatch["emitProfileChanged"]>
  ): void {
    this.profileWatch.emitProfileChanged(...args);
  }

  subscribeProfileChanged(
    ...args: Parameters<ProfileWatch["subscribeProfileChanged"]>
  ) {
    return this.profileWatch.subscribeProfileChanged(...args);
  }

  watchSessionProfile(
    ...args: Parameters<ProfileWatch["watchSessionProfile"]>
  ): void {
    this.profileWatch.watchSessionProfile(...args);
  }

  stopWatchingProfile(): void {
    this.profileWatch.stopWatchingProfile();
  }

  getAgentDisplayProfile(
    ...args: Parameters<ProfileWatch["getAgentDisplayProfile"]>
  ) {
    return this.profileWatch.getAgentDisplayProfile(...args);
  }

  resolveAgentProfile(
    ...args: Parameters<ProfileWatch["resolveAgentProfile"]>
  ) {
    return this.profileWatch.resolveAgentProfile(...args);
  }

  emitAgents(): Promise<void> {
    return this.rosterEmit.emitAgents();
  }

  emitAgentUpdate(agentId: string): Promise<void> {
    return this.rosterEmit.emitAgentUpdate(agentId);
  }

  reserveSnapshotStamp() {
    return this.rosterEmit.reserveSnapshotStamp();
  }

  finalizeSummaryForRpc<T extends object>(
    summary: T,
    stamp: Parameters<RosterEmit["finalizeSummaryForRpc"]>[1],
  ) {
    return this.rosterEmit.finalizeSummaryForRpc(summary, stamp);
  }

  subscribe(listener: (value: any) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  subscribeOutline(listener: (value: any) => void): () => void {
    this.emitter.on("outline", listener);
    return () => this.emitter.off("outline", listener);
  }

  subscribeSubagents(listener: (value: any) => void): () => void {
    this.emitter.on("subagents", listener);
    return () => this.emitter.off("subagents", listener);
  }

  subscribeAsyncTasks(listener: (value: any) => void): () => void {
    this.emitter.on("async-tasks", listener);
    return () => this.emitter.off("async-tasks", listener);
  }

  subscribeClientSideToolV2(listener: (value: any) => void): () => void {
    this.emitter.on("client-side-tool-v2", listener);
    return () => this.emitter.off("client-side-tool-v2", listener);
  }

  emitClientSideToolV2(value: unknown): void {
    this.emitter.emit("client-side-tool-v2", value);
  }

  async getSubagents(parentAgentId: string): Promise<any[]> {
    return (
      this.tm.runnerRegistry.runners.get(parentAgentId)?.listSubagents() ?? []
    );
  }

  async getAsyncTasks(parentAgentId: string): Promise<any[]> {
    return this.mergedAsyncTasks(parentAgentId);
  }

  mergedAsyncTasks(parentAgentId: string): any[] {
    if (this.tm.sessions.deletedAgentIds.has(parentAgentId)) return [];
    const cachedRunner = this.tm.runnerRegistry.runners.get(parentAgentId);
    const liveUnion = [...(cachedRunner?.listAsyncTasks() ?? [])];
    const seen = new Set(
      liveUnion.map((task: any) => `${task.kind}\0${task.id}`),
    );
    for (const [runner, tasks] of this.lastRunnerAsyncTasks.get(
      parentAgentId,
    ) ?? []) {
      if (runner === cachedRunner) continue;
      for (const task of tasks) {
        const key = `${task.kind}\0${task.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        liveUnion.push(task);
      }
    }
    const markers =
      this.tm.pendingWakeStore
        ?.listPending()
        .filter((marker: any) => marker.agentId === parentAgentId) ?? [];
    return mergeAsyncTasks(liveUnion, markers);
  }

  async getConversationOutline(agentId: string): Promise<any[]> {
    if (isSandSubagentId(agentId)) {
      let items: any[] = [];
      for (const runner of this.tm.runnerRegistry.runners.values()) {
        if (!runner.hasSubagent(agentId)) continue;
        try {
          items = await runner.getSubagentOutline(agentId);
        } catch {
          items = [];
        }
        break;
      }
      this.emitOutline({ type: "snapshot", agentId, items });
      return items;
    }
    const session = await this.tm.sessions.ensureSession();
    if (session.id === agentId) {
      const generation = this.activeOutlineGeneration;
      const items = await this.loadActiveOutline(session);
      if (this.activeOutlineGeneration === generation) {
        this.emitOutline({ type: "snapshot", agentId, items });
      }
      return items;
    }
    let items: any[] = [];
    try {
      items = await this.tm.sessionStore.getAgentOutline(agentId);
    } catch {
      items = [];
    }
    this.emitOutline({ type: "snapshot", agentId, items });
    return items;
  }

  async loadActiveOutline(session: any): Promise<any[]> {
    if (this.outlineAgentId === session.id) {
      return this.activeOutlineLoad == null
        ? this.outline
        : this.activeOutlineLoad;
    }
    this.outline = [];
    this.outlineAgentId = session.id;
    this.streamingAssistantOutlineId = undefined;
    this.streamingThinkingOutlineId = undefined;
    const generation = this.activeOutlineGeneration;
    const promise = (async () => {
      const persisted = await this.tm.sessionStore
        .getSessionOutline(session)
        .catch(() => []);
      if (
        this.activeOutlineGeneration === generation &&
        this.tm.sessions.activeSession?.id === session.id &&
        this.outlineAgentId === session.id
      ) {
        this.outline = [...persisted, ...this.outline];
        return this.outline;
      }
      return persisted;
    })();
    this.activeOutlineLoad = promise;
    const items = await promise;
    if (this.activeOutlineLoad === promise) this.activeOutlineLoad = null;
    return items;
  }

  invalidateActiveOutline(): void {
    this.flushStreamOutlineUpdate();
    this.activeOutlineGeneration += 1;
    this.activeOutlineLoad = null;
    this.outline = [];
    this.outlineAgentId = null;
    this.streamingAssistantOutlineId = undefined;
    this.streamingThinkingOutlineId = undefined;
  }

  appendOutlineItem(item: any): void {
    this.outline = [...this.outline, item];
    if (this.outlineAgentId != null) {
      this.emitOutline({
        type: "appended",
        agentId: this.outlineAgentId,
        item,
      });
    }
  }

  updateOutlineItem(
    id: string,
    update: (item: any) => any,
    options?: { coalesce?: boolean },
  ): any | null {
    let updated: any | null = null;
    this.outline = this.outline.map((item) => {
      if (item.id !== id) return item;
      updated = update(item);
      return updated;
    });
    if (updated == null || this.outlineAgentId == null) return updated;
    if (options?.coalesce === true && this.streamOutlineFlush != null) {
      if (
        this.pendingStreamOutlineUpdate != null &&
        this.pendingStreamOutlineUpdate.item.id !== id
      )
        this.flushStreamOutlineUpdate();
      this.pendingStreamOutlineUpdate = {
        agentId: this.outlineAgentId,
        item: updated,
      };
      if (
        this.streamOutlineClock.monotonicNow() -
          this.lastStreamOutlineFlushAtMs >=
        OUTLINE_STREAM_COALESCE_MS
      )
        this.flushStreamOutlineUpdate();
      else this.streamOutlineFlush();
      return updated;
    }
    this.emitOutline({
      type: "updated",
      agentId: this.outlineAgentId,
      item: updated,
    });
    return updated;
  }

  applyAgentUpdateToOutline(update: any): void {
    if (this.outlineAgentId == null) return;
    if (update.type === "text-delta" || update.type === "thinking-delta") {
      if (update.text.length === 0) return;
      const isThinking = update.type === "thinking-delta";
      if (isThinking) this.streamingAssistantOutlineId = undefined;
      else this.streamingThinkingOutlineId = undefined;
      const id = isThinking
        ? this.streamingThinkingOutlineId
        : this.streamingAssistantOutlineId;
      if (id != null) {
        const updated = this.updateOutlineItem(
          id,
          (item) =>
            item.kind === (isThinking ? "thinking" : "assistant-text")
              ? { ...item, text: `${item.text}${update.text}` }
              : item,
          { coalesce: true },
        );
        if (updated != null) return;
      }
      const item = {
        kind: isThinking ? "thinking" : "assistant-text",
        id: randomUUID(),
        text: update.text,
      };
      if (isThinking) this.streamingThinkingOutlineId = item.id;
      else this.streamingAssistantOutlineId = item.id;
      this.appendOutlineItem(item);
      return;
    }
    if (update.type === "tool-call") {
      if (update.name === SEND_MESSAGE_TOOL_CALL_OUTLINE_NAME) return;
      this.streamingAssistantOutlineId = undefined;
      this.streamingThinkingOutlineId = undefined;
      const updated = this.updateOutlineItem(update.id, (item) =>
        item.kind === "tool-call"
          ? {
              ...item,
              name: update.name,
              status: update.status,
              ...(update.summary == null ? {} : { summary: update.summary }),
            }
          : item,
      );
      if (updated == null) {
        this.appendOutlineItem({
          kind: "tool-call",
          id: update.id,
          name: update.name,
          status: update.status,
          ...(update.summary == null ? {} : { summary: update.summary }),
        });
      }
      return;
    }
    if (update.type === "send-message") {
      this.streamingAssistantOutlineId = undefined;
      this.streamingThinkingOutlineId = undefined;
      this.appendOutlineItem({
        kind: "send-message",
        id: randomUUID(),
        message: update.message,
        timestampMs: update.timestampMs,
      });
      return;
    }
    if (update.type === "turn-ended") {
      this.streamingAssistantOutlineId = undefined;
      this.streamingThinkingOutlineId = undefined;
    }
  }

  emit(event: any, owningAgentId?: string): void {
    const owned = this.withOwningAgentId(event, owningAgentId);
    this.emitter.emit("event", this.withOrderedStamp(owned));
    if (event.type === "cleared" && typeof owned.agentId === "string") {
      const reset = this.tm.clientSideToolV2.reset(owned.agentId);
      if (reset != null) this.emitClientSideToolV2(reset);
    }
  }

  withOrderedStamp(event: any): any {
    const agentId =
      event.type === "snapshot" ? event.activeAgentId : event.agentId;
    if (agentId == null || agentId.length === 0) return event;
    const ordered = this.rosterEmit.replicaWriter.nextStamp(
      transcriptReplicaKey(agentId),
    );
    if (event.type !== "snapshot") return { ...event, ordered };
    return {
      ...event,
      ordered,
      coverage: {
        kind: "transcript-live-range",
        fromSequence: 1,
        throughSequence: ordered.sequence,
      },
    };
  }

  withOwningAgentId(event: any, owningAgentId?: string): any {
    if (event.type === "snapshot") return event;
    const agentId = owningAgentId ?? this.tm.sessions.inMemoryTranscriptAgentId;
    return agentId == null || agentId.length === 0
      ? event
      : { ...event, agentId };
  }

  emitOutline(event: any): void {
    this.flushStreamOutlineUpdate();
    this.emitter.emit("outline", event);
  }

  emitAsyncTasks(runner: any, event: any): void {
    if (this.tm.sessions.deletedAgentIds.has(event.parentAgentId)) return;
    const perRunner =
      this.lastRunnerAsyncTasks.get(event.parentAgentId) ?? new Map();
    if (event.tasks.length === 0) perRunner.delete(runner);
    else perRunner.set(runner, event.tasks);
    if (perRunner.size === 0)
      this.lastRunnerAsyncTasks.delete(event.parentAgentId);
    else this.lastRunnerAsyncTasks.set(event.parentAgentId, perRunner);
    this.emitter.emit("async-tasks", {
      parentAgentId: event.parentAgentId,
      tasks: this.mergedAsyncTasks(event.parentAgentId),
    });
  }

  emitAsyncTasksForAgent(agentId: string): void {
    this.emitter.emit("async-tasks", {
      parentAgentId: agentId,
      tasks: this.mergedAsyncTasks(agentId),
    });
  }

  emitSubagents(source: any, event: any): void {
    const parentAgentId = event.parentAgentId;
    const sources = this.subagentWorkSources.get(parentAgentId) ?? new Set();
    sources.add(source);
    this.subagentWorkSources.set(parentAgentId, sources);
    const hasRunning = this.liveSubagentParentIds().has(parentAgentId);
    const hadRunning = this.reportedSubagentParents.has(parentAgentId);
    if (hasRunning) this.reportedSubagentParents.add(parentAgentId);
    else this.reportedSubagentParents.delete(parentAgentId);
    try {
      this.emitter.emit("subagents", event);
    } catch (error) {
      this.tm.productAnalytics.trackEvent("sand.subagent.fanout_failed", {
        agent_id: parentAgentId,
        error_type: error instanceof Error ? error.name : "unknown",
      });
    }
    if (hasRunning !== hadRunning) void this.emitAgentUpdate(parentAgentId);
  }

  liveSubagentParentIds(): Set<string> {
    const parents = new Set<string>();
    for (const [agentId, sources] of this.subagentWorkSources) {
      for (const source of sources) {
        if (source.hasRunningSubagents()) parents.add(agentId);
        else sources.delete(source);
      }
      if (sources.size === 0) this.subagentWorkSources.delete(agentId);
    }
    return parents;
  }

  forgetAgentSubagentWork(agentId: string): void {
    this.subagentWorkSources.delete(agentId);
    this.reportedSubagentParents.delete(agentId);
  }
}
