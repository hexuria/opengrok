import { isRecreateWakeCarryDisabled } from "./pending-wake-rearm.js";
import {
  coercePendingWakeMarkers,
  type DurablePendingWakeMarker,
} from "./sand-pending-wake-store.js";
import { describeAgentRunError } from "./agent-run-error.js";
import { classifyAgentError } from "./turn-runtime.js";
import { sandErrorDetail } from "../../ports/telemetry.js";
import type { TranscriptManagerLike } from "./transcript-hub.js";

export function buildUpgradeResumePrompt(source: string): string {
  const tail =
    "You've been resumed with your full conversation intact. Continue exactly where you left off and finish what you were doing. If your previous step already completed an action, do NOT repeat it — just carry on from there. Remember: nothing reaches the user unless it's inside a SendMessage.";
  if (source === "automation") {
    return `[A background system update restarted your environment and interrupted a scheduled routine run mid-task. ${tail} This is still that routine's own run — nobody is waiting on it, so if its saved instruction says to stay quiet when there's nothing to report, ending with no SendMessage remains a valid outcome.]`;
  }
  if (source === "background-revival") {
    return `[A background system update restarted your environment and interrupted one of your background-work follow-ups mid-delivery. ${tail} This follow-up was your own background wake — nobody is waiting on a reply, so if the results above your interruption point carry nothing genuinely new for the user, ending with no SendMessage remains a valid outcome.]`;
  }
  return `[A background system update restarted your environment and interrupted you mid-task. ${tail}]`;
}

export interface UpgradeResumeMarker {
  agentId: string;
  markedAtMs: number;
  source?: string;
  automationId?: string;
  automationRunId?: string;
}

export class UpgradeRecreateResume {
  private quiescingForUpgrade = false;

  constructor(readonly tm: TranscriptManagerLike) {}

  async quiesceForUpgrade(): Promise<{
    quiescing: true;
    runningTurns: number;
  }> {
    this.quiescingForUpgrade = true;
    this.tm.traceFlusher();
    for (const session of this.tm.runLifecycle.inFlightRunCounts.keys()) {
      this.tm.runnerRegistry.runners
        .get(session.id)
        ?.requestQuiesceForUpgrade();
      this.tm.runnerRegistry.activeGroupMemberRunners
        .get(session.id)
        ?.requestQuiesceForUpgrade();
    }
    return {
      quiescing: true,
      runningTurns: this.tm.runLifecycle.runningAgentIds().size,
    };
  }

  isQuiescingForUpgrade(): boolean {
    return this.quiescingForUpgrade;
  }

  markAllRunningAgentsForUpgradeResume(): void {
    for (const session of this.tm.runLifecycle.inFlightRunCounts.keys()) {
      const source =
        this.tm.turnRuntime.activeRequestSources.get(session.id) ?? "turn";
      if (source === "background-revival") {
        this.markAgentResumePendingForQuiescedRevival(session);
      } else this.markAgentResumePending(session, source);
    }
  }

  markAgentResumePending(
    session: { id: string },
    source: string,
    options?: { automationId?: string; automationRunId?: string },
  ): void {
    this.tm.upgradeResumeStore?.markPending({
      agentId: session.id,
      markedAtMs: Date.now(),
      source,
      ...(options?.automationId == null
        ? {}
        : { automationId: options.automationId }),
      ...(options?.automationRunId == null
        ? {}
        : { automationRunId: options.automationRunId }),
    });
  }

  markAgentResumePendingForQuiescedRevival(session: { id: string }): void {
    const store = this.tm.upgradeResumeStore;
    if (store == null) return;
    if (
      store
        .listPending()
        .some((marker: UpgradeResumeMarker) => marker.agentId === session.id)
    ) {
      return;
    }
    this.markAgentResumePending(session, "background-revival");
  }

  async resumeInterruptedUpgradeTurns(): Promise<void> {
    if (this.tm.upgradeResumeStore == null || !this.tm.execution.canExecute)
      return;
    const pending: UpgradeResumeMarker[] =
      this.tm.upgradeResumeStore.listPending();
    if (pending.length === 0) return;
    this.tm.upgradeResumeStore.clearAll();
    for (const marker of pending) {
      if (!this.tm.sessions.isAgentGone(marker.agentId))
        void this.resumeUpgradeAgent(marker);
    }
  }

  async resumeUpgradeAgent(marker: UpgradeResumeMarker): Promise<void> {
    let session: any;
    try {
      session = await this.tm.sessions.resolveBackgroundSession(marker.agentId);
    } catch {
      return;
    }
    if (this.tm.groupChat.isGroupSession(session)) return;
    const runner = this.tm.runnerRegistry.getRunner(session);
    this.tm.runLifecycle.beginSessionRun(session);
    const resumedSource =
      marker.source === "notification"
        ? "background-revival"
        : (marker.source ?? "handoff-resume");
    const ackToken =
      resumedSource === "turn" || resumedSource === "handoff-resume"
        ? this.tm.ackObligations.mintAckRunToken(session.id)
        : undefined;
    await this.tm.runLifecycle.enqueueExclusiveRun(
      session.id,
      async () => {
        this.tm.turnRuntime.activeRequestSources.set(session.id, resumedSource);
        try {
          const automation =
            resumedSource === "automation" && marker.automationId != null
              ? session.automations.get(marker.automationId)
              : null;
          await runner.run(buildUpgradeResumePrompt(resumedSource), {
            hidden: true,
            ackToken,
            isSilenceAllowed:
              resumedSource === "automation" ||
              resumedSource === "background-revival",
            ...(automation == null
              ? {}
              : {
                  automationWake: { id: automation.id, name: automation.name },
                }),
            requestSource: resumedSource,
          });
          await this.tm.roster.emitAgentUpdate(session.id);
          this.tm.automationRuntime.emitAutomations(session);
        } catch (error) {
          this.tm.telemetry.reportAgentError({
            source: "resume",
            conversationId: session.id,
            requestId: this.tm.runLifecycle.lastRequestIdBySession.get(
              session.id,
            ),
            error: classifyAgentError(error),
            detail: sandErrorDetail(error),
          });
          this.tm.trayErrors.pushError({
            agentId: session.id,
            title: "Agent failed to resume after host update",
            ...describeAgentRunError(error),
          });
        } finally {
          this.tm.ackObligations.retireAckRunToken(session.id, ackToken);
          this.tm.runLifecycle.endSessionRun(session);
        }
      },
      {
        lane: "background",
        source: "upgrade-resume",
        ackToken,
      },
    );
  }

  async quiesceForRecreate(): Promise<{
    quiescing: boolean;
    runningTurns: number;
    resumeAgentIds: string[];
    resumePendingWakes: DurablePendingWakeMarker[];
  }> {
    const { quiescing } = await this.tm.quiesceForUpgrade();
    const outstanding =
      new Set([
        ...this.tm.liveRunningAgentIds(),
        ...this.tm.backgroundWakes.revivingSubagentAgentIds,
        ...this.tm.backgroundWakes.revivingShellAgentIds,
      ]).size + (this.tm.hasRunningBackgroundShellWork() ? 1 : 0);
    return {
      quiescing,
      runningTurns: outstanding,
      resumeAgentIds: this.listResumePendingAgentIds(),
      resumePendingWakes: this.listRecreateCarryPendingWakes(),
    };
  }

  listResumePendingAgentIds(): string[] {
    return (this.tm.upgradeResumeStore?.listPending() ?? []).map(
      (marker: UpgradeResumeMarker) => marker.agentId,
    );
  }

  listRecreateCarryPendingWakes(): DurablePendingWakeMarker[] {
    if (this.tm.pendingWakeStore == null || isRecreateWakeCarryDisabled())
      return [];
    return this.tm.pendingWakeStore
      .listPending()
      .filter(
        (marker: DurablePendingWakeMarker) =>
          marker.kind === "cloud-agent" || marker.kind === "shell",
      );
  }

  hasCarryablePendingWake(): boolean {
    return this.listRecreateCarryPendingWakes().length > 0;
  }

  hasMidDrainRevival(): boolean {
    return (
      this.tm.backgroundWakes.revivingSubagentAgentIds.size > 0 ||
      this.tm.backgroundWakes.revivingShellAgentIds.size > 0
    );
  }

  async resumeAfterRecreate(
    agentIds: readonly string[],
    carriedPendingWakes?: readonly unknown[],
  ): Promise<{ resumed: number }> {
    this.quiescingForUpgrade = false;
    for (const runner of this.tm.runnerRegistry.runners.values()) {
      runner.cancelQuiesceForUpgrade();
    }
    for (const runner of this.tm.runnerRegistry.activeGroupMemberRunners.values()) {
      runner.cancelQuiesceForUpgrade();
    }
    const local = (this.tm.upgradeResumeStore?.listPending() ?? []).map(
      (marker: UpgradeResumeMarker) => marker.agentId,
    );
    const ids = [...new Set([...agentIds, ...local])];
    let resumed = 0;
    for (const agentId of ids) {
      if (this.tm.sessions.isAgentGone(agentId)) continue;
      const marker = this.tm.upgradeResumeStore
        ?.listPending()
        .find(
          (candidate: UpgradeResumeMarker) => candidate.agentId === agentId,
        );
      this.tm.upgradeResumeStore?.clear(agentId);
      void this.resumeUpgradeAgent(
        marker ?? { agentId, markedAtMs: Date.now() },
      );
      resumed += 1;
    }
    this.restoreCarriedPendingWakes(carriedPendingWakes);
    return { resumed };
  }

  restoreCarriedPendingWakes(carriedPendingWakes?: readonly unknown[]): void {
    if (carriedPendingWakes == null || carriedPendingWakes.length === 0) return;
    if (!this.tm.execution.canExecute || isRecreateWakeCarryDisabled()) return;
    const now = Date.now();
    for (const marker of coercePendingWakeMarkers(carriedPendingWakes)) {
      if (marker.kind !== "cloud-agent" && marker.kind !== "shell") continue;
      const report = (outcome: string, reason?: string): void => {
        this.tm.telemetry.reportPendingWake({
          conversationId: marker.agentId,
          outcome,
          kind: marker.kind,
          workId: marker.workId,
          ageMs: now - marker.markedAtMs,
          ...(reason == null ? {} : { reason }),
          isQuietOrigin: marker.quietOrigin != null,
        });
      };
      if (
        this.tm.pendingWakeStore?.hasPending(
          marker.agentId,
          marker.kind,
          marker.workId,
        ) === true
      ) {
        report("rearm_skipped", "locally_owned");
        continue;
      }
      if (this.tm.sessions.isAgentGone(marker.agentId)) {
        report("rearm_skipped", "agent_gone");
        continue;
      }
      if (this.tm.groupChat.isGroupAgentId(marker.agentId)) {
        report("rearm_skipped", "group_session");
        continue;
      }
      const accepted: DurablePendingWakeMarker =
        marker.kind === "shell"
          ? { ...marker, interruptedByRecreate: true }
          : marker;
      if (this.tm.pendingWakeStore?.markPending(accepted) !== true)
        report("persist_failed");
      report("carried");
      if (accepted.kind === "cloud-agent") {
        void this.tm.pendingWakes.rearmPendingWake(accepted, now, {
          successReason: "recreate_carry",
        });
      } else this.deliverRecreateInterruptedShellNotice(accepted, report);
    }
  }

  deliverRecreateInterruptedShellNotice(
    marker: DurablePendingWakeMarker,
    report: (outcome: string, reason?: string) => void,
  ): void {
    report("dropped_with_notice");
    this.tm.backgroundWakes.handleBackgroundShellCompletion({
      agentId: marker.agentId,
      shellId: marker.workId,
      title: marker.title ?? `Background command ${marker.workId}`,
      status: "aborted",
      detail:
        "The computer update that rebuilt this agent's computer interrupted this background command; the command's process did not survive the update, so it will never report a completion. Check its terminal output file for what it got through, and re-run it if the work still matters.",
      ...(marker.quietOrigin == null
        ? {}
        : { quietOrigin: marker.quietOrigin }),
    });
  }
}
