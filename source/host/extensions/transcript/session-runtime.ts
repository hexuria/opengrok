import { dirname } from "node:path";

import {
  bootstrapTranscriptRead,
  readTranscriptServerTail,
} from "../../transcript-server/transcript-server-bridge.js";
import { isSandAgentLimitError } from "../../../shared/agents/agents.js";
import { errorLogTag } from "../../../shared/errors.js";
import type {
  TranscriptEntry,
  TranscriptManagerLike,
} from "./transcript-hub.js";
import {
  appendEntry as appendTranscriptEntry,
  clearTranscript,
  getTranscript,
  setTranscript,
} from "./transcript-store.js";

export class AgentGoneError extends Error {
  constructor(agentId: string) {
    super(`Agent ${agentId} no longer exists`);
    this.name = "AgentGoneError";
  }
}

export interface TranscriptWindow {
  readonly entries: TranscriptEntry[];
  readonly [key: string]: unknown;
}

export interface LiveTranscriptSession {
  readonly id: string;
  readonly dbPath: string;
  readonly db: Record<string, any>;
  readonly agentStore?: { dispose(): void | Promise<void> };
  readonly automations?: { listDefinitions(): readonly unknown[] };
  readonly [key: string]: unknown;
}

export interface AppendEntryOptions {
  readonly persistBeforeEmit?: boolean;
  readonly deferEmit?: boolean;
  readonly onPersistOutcome?: (isDurable: boolean) => void;
}

function raisesUserActivity(entry: TranscriptEntry): boolean {
  return entry.fromAgent == null;
}

export class SessionRuntime {
  activeSession: LiveTranscriptSession | undefined;
  loaded = false;
  isWindowFocused = false;
  windowFocusedAtMs: number | null = null;
  inMemoryTranscriptAgentId: string | null = null;
  readonly liveSessions = new Map<string, LiveTranscriptSession>();
  readonly pendingSessionOpens = new Map<
    string,
    Promise<LiveTranscriptSession>
  >();
  readonly deletedAgentIds = new Set<string>();
  windowedActivationTail: Promise<void> = Promise.resolve();
  windowedActivationAbort: AbortController | null = null;
  pendingActivationAgentId: string | null = null;
  private ensureSessionInFlight: Promise<LiveTranscriptSession> | undefined;

  constructor(readonly tm: TranscriptManagerLike) {}

  async settledOpen(
    pending: Promise<LiveTranscriptSession> | undefined,
  ): Promise<LiveTranscriptSession | undefined> {
    if (pending == null) return undefined;
    const [settled] = await Promise.allSettled([pending]);
    return settled?.status === "fulfilled" ? settled.value : undefined;
  }

  invalidateDeferredActivation(): void {
    this.windowedActivationAbort?.abort();
    this.windowedActivationAbort = null;
    this.pendingActivationAgentId = null;
  }

  clearPendingActivationClaim(owner: AbortController): void {
    if (this.windowedActivationAbort === owner)
      this.pendingActivationAgentId = null;
  }

  getActiveAgentDir(): string | undefined {
    return this.activeSession == null
      ? undefined
      : dirname(this.activeSession.dbPath);
  }

  async ensureLoaded(): Promise<TranscriptEntry[]> {
    const session = await this.ensureSession();
    if (!this.loaded) {
      const local = (await this.tm.sessionStore.getTranscriptEntries(
        session,
      )) as TranscriptEntry[];
      const entries = (await bootstrapTranscriptRead(session.id, local)) as TranscriptEntry[];
      this.setActiveTranscript(session.id, entries);
      this.loaded = true;
      this.tm.roster.emit({
        type: "snapshot",
        activeAgentId: session.id,
        entries,
      });
      return entries;
    }
    return getTranscript(this.inMemoryTranscriptAgentId);
  }

  getEntries(): TranscriptEntry[] {
    return getTranscript(this.inMemoryTranscriptAgentId);
  }

  appendEntry(
    entry: TranscriptEntry,
    options?: AppendEntryOptions,
  ): TranscriptEntry {
    appendTranscriptEntry(entry);
    if (options?.persistBeforeEmit === true) {
      const isDurable =
        this.activeSession?.db.appendTranscriptEntry(entry) ?? false;
      try {
        options.onPersistOutcome?.(Boolean(isDurable));
      } catch {}
      if (options.deferEmit !== true)
        this.tm.roster.emit({ type: "appended", entry });
    } else {
      this.tm.roster.emit({ type: "appended", entry });
      this.activeSession?.db.appendTranscriptEntry(entry);
    }
    if (
      ["send-message", "message", "user-attachment"].includes(entry.kind) &&
      raisesUserActivity(entry) &&
      this.activeSession != null
    ) {
      this.markActiveSessionArrival(this.activeSession);
    }
    return entry;
  }

  markActiveSessionArrival(session: LiveTranscriptSession): void {
    const now = Date.now();
    this.tm.sessionStore.markSessionActivity(session, now);
    if (this.isWindowFocused) {
      this.tm.sessionStore.markSessionViewedNow(session, now, {
        preserveManualUnread: true,
      });
    } else {
      void this.tm.roster.emitAgentUpdate(session.id);
    }
  }

  async setWindowFocused(isFocused: boolean): Promise<void> {
    const wasFocused = this.isWindowFocused;
    this.isWindowFocused = isFocused;
    this.windowFocusedAtMs = isFocused ? Date.now() : null;
    if (!isFocused || wasFocused || this.activeSession == null) return;
    const active = this.activeSession;
    const unread = active.db.getUnreadState() as {
      isManuallyUnread: boolean;
      lastActivityAt: number;
      lastViewedAt: number;
    };
    if (unread.isManuallyUnread || unread.lastActivityAt <= unread.lastViewedAt)
      return;
    await this.tm.sessionStore.markSessionViewed(active, Date.now(), {
      preserveManualUnread: true,
    });
    void this.tm.roster.emitAgentUpdate(active.id);
  }

  setActiveTranscript(
    agentId: string,
    entries: readonly TranscriptEntry[],
  ): void {
    setTranscript(entries);
    this.inMemoryTranscriptAgentId = agentId;
  }

  clearActiveTranscript(agentId: string | null): void {
    clearTranscript();
    this.inMemoryTranscriptAgentId = agentId;
  }

  getActiveAgentId(): string | null {
    return this.activeSession?.id ?? null;
  }
  getAnnouncedActiveAgentId(): string | null {
    return this.pendingActivationAgentId ?? this.getActiveAgentId();
  }
  getWindowFocusedAtMs(): number | null {
    return this.windowFocusedAtMs;
  }

  noteDesktopContact(): void {
    if (this.isWindowFocused) this.windowFocusedAtMs = Date.now();
  }

  async switchAgent(agentId: string): Promise<TranscriptEntry[]> {
    const current = this.activeSession;
    if (current?.id === agentId) {
      this.invalidateDeferredActivation();
      return getTranscript(this.inMemoryTranscriptAgentId);
    }
    this.invalidateDeferredActivation();
    const activated = await this.activateSession(agentId, current);
    if (activated == null) return getTranscript(this.inMemoryTranscriptAgentId);
    this.tm.roster.emit({
      type: "snapshot",
      activeAgentId: activated.session.id,
      entries: activated.entries,
    });
    await this.announceActivation(activated.session, current);
    return activated.entries;
  }

  async activateSession(
    agentId: string,
    current?: LiveTranscriptSession,
    isSuperseded?: () => boolean,
  ): Promise<
    { session: LiveTranscriptSession; entries: TranscriptEntry[] } | undefined
  > {
    const nextSession =
      this.liveSessions.get(agentId) ?? (await this.openSessionOnce(agentId));
    if (isSuperseded?.() === true) return undefined;
    const now = Date.now();
    await this.markSessionLeftBehind(current, now);
    await this.tm.sessionStore.markSessionViewed(nextSession, now);
    const local = nextSession.db.getTranscriptEntries() as TranscriptEntry[];
    const entries = (await bootstrapTranscriptRead(nextSession.id, local)) as TranscriptEntry[];
    if (isSuperseded?.() === true) return undefined;
    this.setActiveTranscript(nextSession.id, entries);
    this.loaded = true;
    await this.replaceSession(nextSession);
    return { session: nextSession, entries };
  }

  async markSessionLeftBehind(
    current: LiveTranscriptSession | undefined,
    now: number,
  ): Promise<void> {
    if (current == null || !this.isWindowFocused) return;
    await this.tm.sessionStore.markSessionViewed(current, now, {
      preserveManualUnread: true,
    });
  }

  async announceActivation(
    session: LiveTranscriptSession,
    current?: LiveTranscriptSession,
  ): Promise<void> {
    await this.tm.roster.emitAgentUpdate(session.id);
    if (current != null && current.id !== session.id)
      await this.tm.roster.emitAgentUpdate(current.id);
  }

  async openAgentWindowed(
    agentId: string,
    limit: number,
  ): Promise<TranscriptWindow> {
    return this.openAgentBounded(
      agentId,
      (db) => db.getTranscriptWindow({ limit }) as TranscriptWindow,
      () => this.getAgentTranscriptWindow(agentId, { limit }),
    );
  }

  async openAgentTail(
    agentId: string,
    limit: number,
  ): Promise<TranscriptWindow> {
    const local = await this.openAgentBounded(
      agentId,
      (db) => db.getTranscriptTail({ limit }) as TranscriptWindow,
      () => this.getAgentTranscriptTail(agentId, { limit }),
    );
    return readTranscriptServerTail(agentId, local, { limit });
  }

  async openAgentBounded(
    agentId: string,
    readLive: (db: Record<string, any>) => TranscriptWindow,
    readCold: () => TranscriptWindow,
  ): Promise<TranscriptWindow> {
    const live = this.liveSessions.get(agentId);
    if (this.activeSession?.id === agentId && live != null) {
      this.invalidateDeferredActivation();
      return readLive(live.db);
    }
    if (live != null) {
      this.invalidateDeferredActivation();
      const current = this.activeSession;
      const activated = await this.activateSession(agentId, current);
      if (activated == null) return readLive(live.db);
      await this.announceActivation(activated.session, current);
      return readLive(activated.session.db);
    }
    const reply = readCold();
    this.tm.sessionStore.markAgentViewed(agentId);
    void this.tm.roster.emitAgentUpdate(agentId);
    this.scheduleWindowedActivation(agentId, reply.entries.at(-1)?.id);
    return reply;
  }

  scheduleWindowedActivation(agentId: string, shippedThroughId?: string): void {
    this.invalidateDeferredActivation();
    const abort = new AbortController();
    this.windowedActivationAbort = abort;
    this.pendingActivationAgentId = agentId;
    const isSuperseded = () =>
      abort.signal.aborted || this.tm.disposed === true;
    this.windowedActivationTail = this.windowedActivationTail
      .then(async () => {
        await this.tm.taskBoundary.settled();
        if (isSuperseded()) return this.clearPendingActivationClaim(abort);
        const current = this.activeSession;
        const activated = await this.activateSession(
          agentId,
          current,
          isSuperseded,
        );
        this.clearPendingActivationClaim(abort);
        if (activated == null) return;
        this.emitWindowedCatchUp(shippedThroughId, activated.entries);
        await this.announceActivation(activated.session, current);
      })
      .catch((error: unknown) => {
        this.clearPendingActivationClaim(abort);
        console.error(
          `[sand] windowed background activation failed for ${agentId}:`,
          error,
        );
      });
  }

  emitWindowedCatchUp(
    shippedThroughId: string | undefined,
    entries: readonly TranscriptEntry[],
  ): void {
    const from =
      shippedThroughId == null
        ? 0
        : entries.findIndex((entry) => entry.id === shippedThroughId) + 1;
    if (shippedThroughId != null && from === 0) return;
    for (let index = from; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry != null) this.tm.roster.emit({ type: "appended", entry });
    }
  }

  getAgentTranscriptWindow(agentId: string, query: unknown): TranscriptWindow {
    return (
      this.liveSessions.get(agentId)?.db.getTranscriptWindow(query) ??
      this.tm.sessionStore.readAgentTranscriptWindow(agentId, query)
    );
  }

  getAgentTranscriptTail(agentId: string, query: unknown): TranscriptWindow {
    return (
      this.liveSessions.get(agentId)?.db.getTranscriptTail(query) ??
      this.tm.sessionStore.readAgentTranscriptTail(agentId, query)
    );
  }

  getAgentThread(agentId: string, rootId: string): unknown {
    return (
      this.liveSessions.get(agentId)?.db.getThread(rootId) ??
      this.tm.sessionStore.readAgentThread(agentId, rootId)
    );
  }

  async ensureActionTarget(agentId?: string): Promise<void> {
    if (agentId == null || this.activeSession?.id === agentId) return;
    await this.tm.switchAgent(agentId);
  }

  async getAgentTranscript(agentId: string): Promise<TranscriptEntry[]> {
    if (
      this.activeSession?.id === agentId &&
      this.inMemoryTranscriptAgentId === agentId
    )
      return getTranscript(agentId);
    return this.tm.sessionStore.getAgentTranscriptEntries(agentId);
  }

  getAgentTranscriptPage(agentId: string, query: unknown): unknown {
    return (
      this.liveSessions.get(agentId)?.db.getTranscriptPage(query) ??
      this.tm.sessionStore.readAgentTranscriptPage(agentId, query)
    );
  }

  async resolveBackgroundSession(
    agentId: string,
  ): Promise<LiveTranscriptSession> {
    if (this.isAgentGone(agentId)) throw new AgentGoneError(agentId);
    return (
      this.liveSessions.get(agentId) ?? (await this.openSessionOnce(agentId))
    );
  }

  openSessionOnce(agentId: string): Promise<LiveTranscriptSession> {
    const pending = this.pendingSessionOpens.get(agentId);
    if (pending != null) return pending;
    const opened = this.tm.sessionStore.openSession(
      agentId,
    ) as Promise<LiveTranscriptSession>;
    this.pendingSessionOpens.set(agentId, opened);
    void opened.catch(() => {
      if (this.pendingSessionOpens.get(agentId) === opened)
        this.pendingSessionOpens.delete(agentId);
    });
    return opened;
  }

  async tryEnsureSession(): Promise<LiveTranscriptSession | null> {
    try {
      return await this.ensureSession();
    } catch (error) {
      if (isSandAgentLimitError(error)) return null;
      throw error;
    }
  }

  async ensureSession(): Promise<LiveTranscriptSession> {
    if (this.activeSession != null) return this.activeSession;
    if (this.ensureSessionInFlight != null) return this.ensureSessionInFlight;
    const run = this.openOrAdoptSession();
    this.ensureSessionInFlight = run.finally(() => {
      if (this.ensureSessionInFlight === run) this.ensureSessionInFlight = undefined;
    });
    return this.ensureSessionInFlight;
  }

  private async openOrAdoptSession(): Promise<LiveTranscriptSession> {
    if (this.activeSession != null) return this.activeSession;
    const agents = (await this.tm.sessionStore.listAgents()) as Array<{
      id: string;
    }>;
    const recordIds =
      (await this.tm.sessionStore.listAgentRecordIds()) as string[];
    const persistedId = this.tm.sessionStore.readActiveAgentId() as
      string | null;
    const restorable =
      persistedId != null &&
      (agents.some((agent) => agent.id === persistedId) ||
        recordIds.includes(persistedId));
    const orderedIds = [
      ...new Set([
        ...(restorable && persistedId != null ? [persistedId] : []),
        ...agents.map((agent) => agent.id),
        ...recordIds,
      ]),
    ];
    let session: LiveTranscriptSession | null = null;
    for (const id of orderedIds) {
      try {
        session = await this.openSessionOnce(id);
        break;
      } catch (error) {
        console.error(
          `[sand] skipping unopenable agent ${id} on boot: ${errorLogTag(error)}`,
        );
      }
    }
    const resolvedSession =
      session ??
      ((await this.tm.sessionStore.createFallbackSession((id: string) =>
        this.openSessionOnce(id),
      )) as LiveTranscriptSession);
    this.setActiveSession(resolvedSession);
    await this.tm.sessionStore.markSessionViewed(resolvedSession);
    this.tm.runLifecycle.watchActiveSession(resolvedSession);
    return resolvedSession;
  }

  setActiveSession(session: LiveTranscriptSession): void {
    const previous = this.activeSession;
    if (previous != null && previous.id !== session.id) {
      void this.tm.automationRuntime.enqueueAutomationLifecycleMutation({
        agentId: previous.id,
        mutation: () => {
          if (
            this.deletedAgentIds.has(previous.id) ||
            !this.tm.sessionStore.agentExists(previous.id)
          ) {
            this.tm.automationRuntime.lastKnownAutomations.delete(previous.id);
            return;
          }
          const current = previous.automations?.listDefinitions() ?? [];
          this.tm.automationRuntime.recordInactiveAutomationChanges({
            agentId: previous.id,
            before: current,
            after: current,
            source: "agent",
          });
        },
      });
    }
    if (previous?.id !== session.id) this.tm.roster.invalidateActiveOutline();
    this.activeSession = session;
    this.liveSessions.set(session.id, session);
    this.tm.sessionStore.writeActiveAgentId(session.id);
  }

  isAgentGone(agentId: string): boolean {
    return (
      this.deletedAgentIds.has(agentId) ||
      !this.tm.sessionStore.agentExists(agentId)
    );
  }

  async replaceSession(session: LiveTranscriptSession): Promise<void> {
    const previous = this.activeSession;
    this.setActiveSession(session);
    this.tm.runLifecycle.watchActiveSession(session);
    await this.tm.runLifecycle.retireSession(previous);
  }
}
