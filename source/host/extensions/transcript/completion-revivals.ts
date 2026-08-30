import { sandErrorDetail } from "../../ports/telemetry.js";
import { describeAgentRunError } from "./agent-run-error.js";
import type { QuietWakeOrigin } from "./sand-pending-wake-store.js";
import { classifyAgentError } from "./turn-runtime.js";
import type { TranscriptManagerLike } from "./transcript-hub.js";
export function describeQuietOriginNote(origin: QuietWakeOrigin): string {
  const source =
    origin.automation != null
      ? `your routine "${origin.automation.name}" (folder ${origin.automation.id})`
      : "one of your own quiet self-initiated runs";
  return `(You started this during ${source} — nobody is waiting on it.)`;
}
export const QUIET_REVIVAL_INSTRUCTION = `Pick the work back up. Everything above came out of your own quiet standing order(s) — the user did not ask to hear about it, so the saved instruction's delivery rule governs. If the outcome is a genuine change, a new actionable result, or a real blocker the user must know about, tell them once with a single useful SendMessage. If it amounts to no change, nothing new, or still waiting, end the turn with no SendMessage at all — no "still waiting" or progress notes; if the standing order says to keep watching, just keep the watch going quietly. Keep your status current, and clear it once everything is done and you're idle.`;
export function isAllQuietOrigin(
  completions: readonly { quietOrigin?: QuietWakeOrigin }[],
): boolean {
  return completions.every((completion) => completion.quietOrigin != null);
}
export interface SubagentCompletion {
  parentAgentId: string;
  subagentAgentId: string;
  title: string;
  subagentType: string;
  status: string;
  result: string;
  quietOrigin?: QuietWakeOrigin;
}
export function buildSubagentRevivalPrompt(
  completions: readonly SubagentCompletion[],
): string {
  const blocks = completions.map(
      (completion) =>
        `${completion.status === "error" ? `Background task "${completion.title}" (${completion.subagentType}) failed:` : `Background task "${completion.title}" (${completion.subagentType}) finished:`}\n${completion.result}${completion.quietOrigin != null ? `\n${describeQuietOriginNote(completion.quietOrigin)}` : ""}`,
    ),
    intro =
      completions.length === 1
        ? "A background task you started has finished."
        : `${completions.length} background tasks you started have finished.`,
    instruction = `Pick the work back up: review the result(s), then either keep going or wrap up. If this result is genuinely new and relevant to the user, or the user asked to be told when this finished, tell them with a SendMessage. Lead with the concrete thing that finished, not a bare pronoun like "That" (they cannot see the background task). If it is stale, irrelevant, already handled, or a duplicate, and the user was not waiting on it, just stay silent and end the turn with no SendMessage rather than narrating it. Keep your status current, and clear it once everything is done and you're idle.`;
  return [
    `[A background task just completed] ${intro}`,
    "",
    blocks.join("\n\n"),
    "",
    isAllQuietOrigin(completions) ? QUIET_REVIVAL_INSTRUCTION : instruction,
  ].join("\n");
}
export interface ShellCompletion {
  agentId: string;
  shellId: string;
  title: string;
  status: string;
  detail?: string;
  outputPath?: string;
  quietOrigin?: QuietWakeOrigin;
}
export function describeShellOutcome(status: string): string {
  return status === "success"
    ? "finished"
    : status === "aborted"
      ? "was stopped"
      : "failed";
}
export function buildShellRevivalPrompt(
  completions: readonly ShellCompletion[],
): string {
  const blocks = completions.map((completion) => {
      const lines = [
        `Background command "${completion.title}" ${describeShellOutcome(completion.status)}.`,
      ];
      if (completion.detail) lines.push(completion.detail);
      if (completion.outputPath)
        lines.push(`Full output: ${completion.outputPath}`);
      if (completion.quietOrigin != null)
        lines.push(describeQuietOriginNote(completion.quietOrigin));
      return lines.join("\n");
    }),
    intro =
      completions.length === 1
        ? "A command you started in the background has finished."
        : `${completions.length} commands you started in the background have finished.`,
    instruction = `Pick the work back up: check the result (read the output file if you need the full logs), then either keep going or wrap up. If this result is genuinely new and relevant to the user, or the user asked to be told when this finished, tell them with a SendMessage. Lead with the concrete thing that finished, not a bare pronoun like "That" (they cannot see the background task). If it is stale, irrelevant, already handled, or a duplicate, and the user was not waiting on it, just stay silent and end the turn with no SendMessage rather than narrating it. Keep your status current, and clear it once everything is done and you're idle.`;
  return [
    `[A background command just completed] ${intro}`,
    "",
    blocks.join("\n\n"),
    "",
    isAllQuietOrigin(completions) ? QUIET_REVIVAL_INSTRUCTION : instruction,
  ].join("\n");
}
export class CompletionRevivals {
  readonly pendingSubagentCompletions = new Map<string, SubagentCompletion[]>();
  readonly revivingSubagentAgentIds = new Set<string>();
  readonly pendingShellCompletions = new Map<string, ShellCompletion[]>();
  readonly revivingShellAgentIds = new Set<string>();

  constructor(readonly tm: TranscriptManagerLike) {}

  handleBackgroundSubagentCompletion(completion: SubagentCompletion): void {
    if (this.tm.sessions.deletedAgentIds.has(completion.parentAgentId)) {
      this.tm.telemetry.reportSubagentRevival({
        parentAgentId: completion.parentAgentId,
        outcome: "dropped",
        completionCount: 1,
        subagentType: completion.subagentType,
        subagentAgentId: completion.subagentAgentId,
        reason: "agent_deleted",
      });
      return;
    }
    const queue =
      this.pendingSubagentCompletions.get(completion.parentAgentId) ?? [];
    if (
      queue.some((item) => item.subagentAgentId === completion.subagentAgentId)
    )
      return;
    queue.push(completion);
    this.pendingSubagentCompletions.set(completion.parentAgentId, queue);
    void this.reviveForSubagentCompletions(completion.parentAgentId);
  }

  async reviveForSubagentCompletions(agentId: string): Promise<void> {
    if (
      !this.tm.execution.canExecute ||
      this.revivingSubagentAgentIds.has(agentId)
    )
      return;
    this.revivingSubagentAgentIds.add(agentId);
    try {
      while ((this.pendingSubagentCompletions.get(agentId)?.length ?? 0) > 0) {
        const completions = this.pendingSubagentCompletions.get(agentId) ?? [];
        this.pendingSubagentCompletions.delete(agentId);
        for (const completion of completions)
          this.tm.pendingWakes.clearSettledPendingWake({
            agentId,
            kind:
              completion.subagentType === "cursor-agent"
                ? "cloud-agent"
                : "subagent",
            workId: completion.subagentAgentId,
          });
        const result = await this.runSubagentRevival(agentId, completions);
        this.tm.telemetry.reportSubagentRevival({
          parentAgentId: agentId,
          ...result,
          completionCount: completions.length,
          subagentType: completions[0]?.subagentType,
          isQuietOrigin: isAllQuietOrigin(completions),
        });
      }
    } finally {
      this.revivingSubagentAgentIds.delete(agentId);
    }
  }

  async runSubagentRevival(
    agentId: string,
    completions: readonly SubagentCompletion[],
  ): Promise<Record<string, unknown>> {
    if (completions.length === 0) return { outcome: "delivered" };
    if (!this.tm.execution.canExecute)
      return { outcome: "dropped", reason: "no_runner" };
    let session: any;
    try {
      session = await this.tm.sessions.resolveBackgroundSession(agentId);
    } catch {
      return { outcome: "dropped", reason: "session_unavailable" };
    }
    const runner = this.tm.runnerRegistry.getRunner(session);
    this.tm.runLifecycle.beginSessionRun(session);
    let result: Record<string, unknown> = { outcome: "delivered" };
    await this.tm.runLifecycle.enqueueExclusiveRun(
      session.id,
      async () => {
        this.tm.turnRuntime.activeRequestPrompts.delete(session.id);
        this.tm.turnRuntime.activeRequestSources.set(
          session.id,
          "background-revival",
        );
        try {
          const unanswered =
            this.tm.widgetResponses.collectUnansweredQuestionPrompts(session);
          const runResult = await runner.run(
            buildSubagentRevivalPrompt(completions),
            {
              hidden: true,
              isSilenceAllowed: true,
              autoReviewEpoch: "continue",
              ...unanswered,
            },
          );
          await this.tm.roster.emitAgentUpdate(session.id);
          if (runResult.aborted) result = { outcome: "superseded" };
          else if (runResult.quiescedForUpgrade === true) {
            this.tm.upgradeResume.markAgentResumePendingForQuiescedRevival(
              session,
            );
            result = { outcome: "dropped", reason: "quiesced" };
          } else
            result = {
              outcome: "delivered",
              sentMessageCount: runResult.sentMessageCount,
            };
        } catch (error) {
          this.reportRevivalError(
            session,
            "Background task follow-up failed",
            error,
          );
          result = { outcome: "dropped", reason: "error" };
        } finally {
          this.tm.runLifecycle.endSessionRun(session);
        }
      },
      { lane: "background", source: "subagent-revival" },
    );
    return result;
  }

  handleBackgroundShellCompletion(completion: ShellCompletion): void {
    if (
      !this.tm.pendingWakes.enqueuePendingWake(
        this.pendingShellCompletions,
        completion.agentId,
        [completion],
      )
    ) {
      this.tm.telemetry.reportShellRevival({
        conversationId: completion.agentId,
        outcome: "dropped",
        completionCount: 1,
        isQuietOrigin: completion.quietOrigin != null,
        reason: "agent_gone",
      });
      return;
    }
    void this.reviveForShellCompletions(completion.agentId);
  }
  async reviveForShellCompletions(agentId: string): Promise<void> {
    if (
      !this.tm.execution.canExecute ||
      this.revivingShellAgentIds.has(agentId)
    )
      return;
    this.revivingShellAgentIds.add(agentId);
    try {
      while ((this.pendingShellCompletions.get(agentId)?.length ?? 0) > 0) {
        const completions = this.pendingShellCompletions.get(agentId) ?? [];
        this.pendingShellCompletions.delete(agentId);
        for (const completion of completions)
          this.tm.pendingWakes.clearSettledPendingWake({
            agentId,
            kind: "shell",
            workId: completion.shellId,
          });
        await this.runShellRevival(agentId, completions);
      }
    } finally {
      this.revivingShellAgentIds.delete(agentId);
    }
  }
  async runShellRevival(
    agentId: string,
    completions: readonly ShellCompletion[],
  ): Promise<void> {
    if (completions.length === 0) return;
    const report = (outcome: string, extras: Record<string, unknown> = {}) =>
      this.tm.telemetry.reportShellRevival({
        conversationId: agentId,
        outcome,
        completionCount: completions.length,
        isQuietOrigin: isAllQuietOrigin(completions),
        ...extras,
      });
    if (!this.tm.execution.canExecute)
      return report("dropped", { reason: "no_runner" });
    let session: any;
    try {
      session = await this.tm.sessions.resolveBackgroundSession(agentId);
    } catch {
      report("dropped", { reason: "session_unavailable" });
      return;
    }
    const runner = this.tm.runnerRegistry.getRunner(session);
    this.tm.runLifecycle.beginSessionRun(session);
    await this.tm.runLifecycle.enqueueExclusiveRun(
      session.id,
      async () => {
        this.tm.turnRuntime.activeRequestPrompts.delete(session.id);
        this.tm.turnRuntime.activeRequestSources.set(
          session.id,
          "background-revival",
        );
        try {
          const runResult = await runner.run(
            buildShellRevivalPrompt(completions),
            {
              hidden: true,
              isSilenceAllowed: true,
              autoReviewEpoch: "continue",
              ...this.tm.widgetResponses.collectUnansweredQuestionPrompts(
                session,
              ),
            },
          );
          if (runResult.aborted) report("superseded");
          else if (runResult.quiescedForUpgrade === true) {
            this.tm.upgradeResume.markAgentResumePendingForQuiescedRevival(
              session,
            );
            report("dropped", { reason: "quiesced" });
          } else
            report("delivered", {
              sentMessageCount: runResult.sentMessageCount,
            });
          await this.tm.roster.emitAgentUpdate(session.id);
        } catch (error) {
          this.reportRevivalError(
            session,
            "Background command follow-up failed",
            error,
          );
          report("dropped", { reason: "error" });
        } finally {
          this.tm.runLifecycle.endSessionRun(session);
        }
      },
      { lane: "background", source: "shell-revival" },
    );
  }

  private reportRevivalError(
    session: any,
    title: string,
    error: unknown,
  ): void {
    this.tm.telemetry.reportAgentError({
      source: "background_followup",
      conversationId: session.id,
      requestId: this.tm.runLifecycle.lastRequestIdBySession.get(session.id),
      error: classifyAgentError(error),
      detail: sandErrorDetail(error),
    });
    this.tm.trayErrors.pushError({
      agentId: session.id,
      title,
      ...describeAgentRunError(error),
    });
  }
}
