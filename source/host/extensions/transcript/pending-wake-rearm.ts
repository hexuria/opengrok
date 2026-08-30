import type { TranscriptManagerLike } from "./transcript-hub.js";

export function isRecreateWakeCarryDisabled(): boolean {
  return process.env.SAND_DISABLE_RECREATE_WAKE_CARRY === "1";
}
export const PENDING_WAKE_STALE_MAX_AGE_MS = 48 * 60 * 60 * 1_000;
type WakeKind = "cloud-agent" | "shell" | "subagent";
interface PendingWakeMarker {
  agentId: string;
  kind: WakeKind;
  workId: string;
  markedAtMs: number;
  quietOrigin?: unknown;
  title?: string;
  subagentType?: string;
  interruptedByRecreate?: boolean;
}

export class PendingWakeRearm {
  constructor(readonly tm: TranscriptManagerLike) {}

  persistPendingWake(event: {
    parentAgentId: string;
    kind: WakeKind;
    workId: string;
    quietOrigin?: unknown;
    title: string;
    subagentType?: string;
  }): boolean {
    const store = this.tm.pendingWakeStore;
    if (
      store == null ||
      this.tm.sessions.deletedAgentIds.has(event.parentAgentId)
    )
      return false;
    const written = store.markPending({
      agentId: event.parentAgentId,
      kind: event.kind,
      workId: event.workId,
      markedAtMs: Date.now(),
      ...(event.quietOrigin == null ? {} : { quietOrigin: event.quietOrigin }),
      title: event.title,
      ...(event.subagentType == null
        ? {}
        : { subagentType: event.subagentType }),
    });
    this.tm.telemetry.reportPendingWake({
      conversationId: event.parentAgentId,
      outcome: written ? "persisted" : "persist_failed",
      kind: event.kind,
      workId: event.workId,
      isQuietOrigin: event.quietOrigin != null,
    });
    return written;
  }
  clearSettledPendingWake(settled: {
    agentId: string;
    kind: WakeKind;
    workId: string;
  }): void {
    const store = this.tm.pendingWakeStore;
    if (
      store == null ||
      !store.clearOne(settled.agentId, settled.kind, settled.workId)
    )
      return;
    this.tm.telemetry.reportPendingWake({
      conversationId: settled.agentId,
      outcome: "settled",
      kind: settled.kind,
      workId: settled.workId,
    });
    this.tm.roster.emitAsyncTasksForAgent(settled.agentId);
  }
  disarmPendingWake(event: {
    parentAgentId: string;
    kind: WakeKind;
    workId: string;
  }): void {
    const store = this.tm.pendingWakeStore;
    if (
      store == null ||
      !store.clearOne(event.parentAgentId, event.kind, event.workId)
    )
      return;
    this.tm.telemetry.reportPendingWake({
      conversationId: event.parentAgentId,
      outcome: "settled",
      kind: event.kind,
      workId: event.workId,
      reason: "aborted",
    });
    this.tm.roster.emitAsyncTasksForAgent(event.parentAgentId);
  }
  async rearmPendingWakes(): Promise<void> {
    const store = this.tm.pendingWakeStore;
    if (store == null || !this.tm.execution.canExecute) return;
    const now = Date.now();
    for (const marker of store.pruneStale(
      PENDING_WAKE_STALE_MAX_AGE_MS,
      now,
    ) as PendingWakeMarker[])
      this.tm.telemetry.reportPendingWake({
        conversationId: marker.agentId,
        outcome: "pruned",
        kind: marker.kind,
        workId: marker.workId,
        ageMs: now - marker.markedAtMs,
        reason: "stale",
        isQuietOrigin: marker.quietOrigin != null,
      });
    for (const marker of store.listPending() as PendingWakeMarker[]) {
      if (this.tm.sessions.isAgentGone(marker.agentId)) {
        this.tm.telemetry.reportPendingWake({
          conversationId: marker.agentId,
          outcome: "rearm_skipped",
          kind: marker.kind,
          workId: marker.workId,
          ageMs: now - marker.markedAtMs,
          reason: "agent_gone",
          isQuietOrigin: marker.quietOrigin != null,
        });
        continue;
      }
      if (!(marker.kind === "shell" && marker.interruptedByRecreate === true))
        store.clearOne(marker.agentId, marker.kind, marker.workId);
      void this.rearmPendingWake(marker, now);
    }
  }
  async rearmPendingWake(
    marker: PendingWakeMarker,
    nowMs: number,
    options?: { successReason?: string },
  ): Promise<void> {
    const report = (outcome: string, reason?: string) => {
      if (outcome === "rearm_failed")
        this.tm.pendingWakeStore?.markPending(marker);
      const effectiveReason =
        reason ?? (outcome === "rearmed" ? options?.successReason : undefined);
      this.tm.telemetry.reportPendingWake({
        conversationId: marker.agentId,
        outcome,
        kind: marker.kind,
        workId: marker.workId,
        ageMs: nowMs - marker.markedAtMs,
        ...(effectiveReason == null ? {} : { reason: effectiveReason }),
        isQuietOrigin: marker.quietOrigin != null,
      });
    };
    let session: any;
    try {
      session = await this.tm.sessions.resolveBackgroundSession(marker.agentId);
    } catch {
      report("rearm_failed", "session_unavailable");
      return;
    }
    if (this.tm.groupChat.isGroupSession(session)) {
      if (marker.kind === "shell" && marker.interruptedByRecreate === true)
        this.tm.pendingWakeStore?.clearOne(
          marker.agentId,
          marker.kind,
          marker.workId,
        );
      report("rearm_skipped", "group_session");
      return;
    }
    try {
      if (marker.kind === "cloud-agent")
        this.rearmCloudAgentWake(session, marker, report);
      else if (marker.kind === "shell" && marker.interruptedByRecreate === true)
        this.tm.upgradeResume.deliverRecreateInterruptedShellNotice(
          marker,
          report,
        );
      else if (marker.kind === "shell")
        this.rearmShellWake(session, marker, report);
      else if (marker.kind === "subagent")
        this.reviveParentForLostSubagentWake(marker, report);
      else report("rearm_skipped", "unsupported_kind");
    } catch {
      report("rearm_failed", "error");
    }
  }
  rearmCloudAgentWake(
    session: any,
    marker: PendingWakeMarker,
    report: (outcome: string, reason?: string) => void,
  ): void {
    const runner = this.tm.runnerRegistry.getRunner(session);
    if (runner.getPendingCloudAgentWatchBcIds().includes(marker.workId)) {
      this.persistPendingWake({
        parentAgentId: marker.agentId,
        kind: "cloud-agent",
        workId: marker.workId,
        title: marker.title ?? `Cloud agent ${marker.workId}`,
        ...(marker.quietOrigin == null
          ? {}
          : { quietOrigin: marker.quietOrigin }),
      });
      report("rearmed");
      return;
    }
    runner.watchCloudAgent(marker.workId, {
      afterFollowup: false,
      ...(marker.quietOrigin == null
        ? {}
        : { quietOrigin: marker.quietOrigin }),
    });
    report(
      runner.getPendingCloudAgentWatchBcIds().includes(marker.workId)
        ? "rearmed"
        : "rearm_failed",
      runner.getPendingCloudAgentWatchBcIds().includes(marker.workId)
        ? undefined
        : "watch_not_armed",
    );
  }
  rearmShellWake(
    session: any,
    marker: PendingWakeMarker,
    report: (outcome: string, reason?: string) => void,
  ): void {
    this.tm.runnerRegistry
      .getRunner(session)
      .watchBackgroundShell(marker.workId, {
        ...(marker.title == null ? {} : { title: marker.title }),
        ...(marker.quietOrigin == null
          ? {}
          : { quietOrigin: marker.quietOrigin }),
      });
    report("rearmed");
  }
  reviveParentForLostSubagentWake(
    marker: PendingWakeMarker,
    report: (outcome: string, reason?: string) => void,
  ): void {
    this.persistPendingWake({
      parentAgentId: marker.agentId,
      kind: "subagent",
      workId: marker.workId,
      title: marker.title ?? "Background task",
      ...(marker.subagentType == null
        ? {}
        : { subagentType: marker.subagentType }),
      ...(marker.quietOrigin == null
        ? {}
        : { quietOrigin: marker.quietOrigin }),
    });
    report("rearmed", "interrupted_completion");
    this.tm.backgroundWakes.handleBackgroundSubagentCompletion({
      parentAgentId: marker.agentId,
      subagentAgentId: marker.workId,
      subagentType: marker.subagentType ?? "task",
      toolCallId: "",
      title: marker.title ?? "Background task",
      status: "error",
      result:
        "A host restart interrupted this background task before its result could be delivered; its in-process run did not survive, so its final state is unknown. Check its transcript (Await with this task id) if you need what it got through, and dispatch a fresh background task if the work still matters.",
      ...(marker.quietOrigin == null
        ? {}
        : { quietOrigin: marker.quietOrigin }),
    });
  }
  enqueuePendingWake<T>(
    queue: Map<string, T[]>,
    agentId: string,
    items: T[],
  ): boolean {
    if (this.tm.sessions.isAgentGone(agentId)) return false;
    const queued = queue.get(agentId) ?? [];
    queued.push(...items);
    queue.set(agentId, queued);
    return true;
  }
}
