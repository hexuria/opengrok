import { dirname } from "node:path";
import {
  buildAutomationWakePrompt,
  buildGroupAutomationSeed,
  describeTriggerEventBatch,
  type AutomationRecord,
  type AutomationRunTrigger,
} from "../../automations/automation.js";
import { stableAutomationId } from "../../automations/automation-id.js";
import { routineNoticesToRaise } from "../../automations/routine-notices.js";
import { readSandGroupConfig } from "../../groups/group-store.js";
import { isTransientStreamError } from "../../runner/transient-stream-error.js";
import { sandErrorDetail } from "../../ports/telemetry.js";
import { errorMessage } from "../../../shared/errors.js";
import { formatRemoteAgentId } from "../../../shared/agents/sharing.js";
import { describeAgentRunError } from "./agent-run-error.js";
import { GroupChatOrchestrator } from "./group-chat-orchestrator.js";
import {
  isBackgroundAutomationTrigger,
  normalizeAutomationErrorKind,
  shouldNotifyAutomationFailure,
} from "./sand-automation-failure.js";
import { createUserMessage } from "./send-message-shaping.js";
import { nextEntryId } from "./transcript-entry-ids.js";
import { getTranscript } from "./transcript-store.js";
import { classifyAgentError } from "./turn-runtime.js";
import type { TranscriptManagerLike } from "./transcript-hub.js";

export type FireAutomationOutcome = "ok" | "error" | "interrupted" | undefined;
export interface FireAutomationArgs {
  agentId: string;
  automation: AutomationRecord;
  trigger: AutomationRunTrigger;
  events?: Record<string, unknown>[];
  runUuid?: string;
  coalescedRunUuids?: string[];
  scheduledForMs?: number;
}

function readIntEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

function resolveAutomationStreamRetryPolicy(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    maxAttempts: readIntEnv("SAND_AUTOMATION_STREAM_RETRY_ATTEMPTS", 4, 1),
    baseDelayMs: readIntEnv("SAND_AUTOMATION_STREAM_RETRY_BASE_MS", 1_000, 0),
    maxDelayMs: readIntEnv("SAND_AUTOMATION_STREAM_RETRY_MAX_MS", 15_000, 0),
    ...overrides,
  };
}

export class AutomationRunPath {
  readonly inFlightAutomationKeys = new Set<string>();
  readonly automationFailureOccurrences = new Map<string, number>();

  constructor(
    readonly tm: TranscriptManagerLike,
    readonly spendGuard: any,
    readonly eventFires: any,
  ) {}

  async runGroupAutomation(
    session: any,
    automation: AutomationRecord,
    events?: readonly Record<string, unknown>[],
  ): Promise<void> {
    const config = readSandGroupConfig(dirname(session.dbPath));
    if (config == null) return;
    const isActive = this.tm.sessions.activeSession?.id === session.id;
    const entries = isActive
      ? getTranscript()
      : session.db.getTranscriptEntries();
    const seed = createUserMessage(
      nextEntryId(entries, "user-message", session.db.getRetiredEntryIds()),
      buildGroupAutomationSeed(automation, events),
      {},
    );
    if (isActive) this.tm.appendEntry(seed);
    else {
      session.db.appendTranscriptEntry(seed);
      this.tm.sessionStore.markSessionActivity(session);
      void this.tm.roster.emitAgentUpdate(session.id);
    }
    this.tm.sharedRooms.publishSharedRoomEntryIfNeeded(session, seed);
    const orchestrator = new GroupChatOrchestrator(
      this.tm.groupChat.groupOrchestratorDeps(
        session,
        this.tm.sendPipeline.currentTurnEpoch(session),
        undefined,
        "background",
        "automation",
      ),
    );
    await orchestrator.run({
      group: this.tm.groupChat.groupIdentityFor(session),
      memberIds: [
        ...config.memberIds,
        ...(config.remoteMembers ?? []).map(formatRemoteAgentId),
      ],
    });
  }

  async fireAutomation(
    args: FireAutomationArgs,
  ): Promise<FireAutomationOutcome> {
    if (!this.tm.execution.canExecute) return undefined;
    const runKey = `${args.agentId}:${args.automation.id}`;
    const eventBatch = args.events ?? [];
    const isEventFire = eventBatch.length > 0;
    if (!isEventFire) {
      if (this.inFlightAutomationKeys.has(runKey)) {
        this.eventFires.reportFireDropped({
          agentId: args.agentId,
          trigger: args.trigger,
          reason: "duplicate_in_flight",
          ...(args.scheduledForMs === undefined
            ? {}
            : { scheduledForMs: args.scheduledForMs }),
          ...(args.runUuid === undefined ? {} : { runUuid: args.runUuid }),
        });
        return undefined;
      }
      this.inFlightAutomationKeys.add(runKey);
    }
    let runOutcome: FireAutomationOutcome;
    try {
      let session: any;
      try {
        session = await this.tm.sessions.resolveBackgroundSession(args.agentId);
      } catch {
        return undefined;
      }
      const isGroup = this.tm.groupChat.isGroupSession(session);
      const runner = isGroup ? null : this.tm.runnerRegistry.getRunner(session);
      let spendGuardReminder: string | undefined;
      if (!isGroup && isBackgroundAutomationTrigger(args.trigger)) {
        const guard = await this.spendGuard.apply(session, args.automation);
        if (guard.paused) {
          this.eventFires.reportFireDropped({
            agentId: args.agentId,
            trigger: args.trigger,
            reason: "user_away_paused",
            ...(args.scheduledForMs === undefined
              ? {}
              : { scheduledForMs: args.scheduledForMs }),
            ...(args.runUuid === undefined ? {} : { runUuid: args.runUuid }),
          });
          return undefined;
        }
        spendGuardReminder = guard.reminder;
      }
      await this.tm.automationRuntime.enqueueAutomationLifecycleMutation({
        agentId: session.id,
        mutation: () => {
          if (this.tm.sessions.activeSession?.id === session.id)
            this.tm.automationRuntime.recordAutomationChangeEvents(
              session,
              "agent",
            );
          else {
            const current = session.automations.listDefinitions();
            this.tm.automationRuntime.recordInactiveAutomationChanges({
              agentId: session.id,
              before: current,
              after: current,
              source: "agent",
            });
          }
        },
      });
      this.recordAutomationRun(session, args.automation.id);
      const automationsBeforeRun = session.automations.listDefinitions();
      this.tm.runLifecycle.beginSessionRun(session);
      await this.tm.runLifecycle.enqueueExclusiveRun(
        session.id,
        async () => {
          runOutcome = "error";
          this.tm.turnRuntime.activeRequestSources.set(
            session.id,
            "automation",
          );
          const runId = this.beginAutomationRun({
            session,
            automationId: args.automation.id,
            trigger: args.trigger,
            ...(isEventFire
              ? { eventSummary: describeTriggerEventBatch(eventBatch) }
              : {}),
            ...(args.runUuid === undefined ? {} : { runUuid: args.runUuid }),
            ...(args.coalescedRunUuids?.length
              ? { coalescedRunUuids: args.coalescedRunUuids }
              : {}),
          });
          const firedAt = Date.now();
          let telemetryOutcome: Exclude<FireAutomationOutcome, undefined> =
            "error";
          let sentMessageCount: number | undefined;
          try {
            if (isGroup) {
              await this.runGroupAutomation(
                session,
                args.automation,
                isEventFire ? eventBatch : undefined,
              );
              this.finishAutomationRun(
                session,
                args.automation.id,
                runId,
                "ok",
              );
              telemetryOutcome = "ok";
            } else if (runner != null) {
              const currentAutomation =
                session.automations.get(args.automation.id) ?? args.automation;
              for (const notice of routineNoticesToRaise(currentAutomation))
                session.automations.markNoticeRaised(
                  args.automation.id,
                  notice.id,
                );
              const result = await runner.run(
                `${buildAutomationWakePrompt(currentAutomation, { timeZone: this.tm.sessionStore.getUserTimeZone(), ...(isEventFire ? { events: eventBatch } : {}), ...(args.trigger === "manual" ? { trigger: "manual" as const } : {}) })}${spendGuardReminder == null ? "" : `\n\n${spendGuardReminder}`}`,
                {
                  hidden: true,
                  isSilenceAllowed: true,
                  automationWake: {
                    id: args.automation.id,
                    name: args.automation.name,
                    ...(isEventFire
                      ? { containsUntrustedEventText: true }
                      : {}),
                  },
                  requestSource: "automation",
                  transientStreamRetry: resolveAutomationStreamRetryPolicy({
                    onRetry: (info: any) =>
                      console.info(
                        `[sand:automation] transient stream reset on "${args.automation.name}" (${args.automation.id}); retrying (attempt ${info.attempt}) after ${info.delayMs}ms: ${errorMessage(info.error)}`,
                      ),
                  }),
                },
              );
              sentMessageCount = result.sentMessageCount;
              if (result.quiescedForUpgrade) {
                this.finishAutomationRun(
                  session,
                  args.automation.id,
                  runId,
                  "error",
                  "Interrupted by a host update; resuming after restart.",
                );
                this.tm.upgradeResume.markAgentResumePending(
                  session,
                  "automation",
                  {
                    automationId: args.automation.id,
                    ...(runId == null ? {} : { automationRunId: runId }),
                  },
                );
                telemetryOutcome = "interrupted";
              } else {
                this.finishAutomationRun(
                  session,
                  args.automation.id,
                  runId,
                  result.aborted ? "error" : "ok",
                  result.aborted
                    ? "Interrupted before it finished."
                    : undefined,
                );
                telemetryOutcome = result.aborted ? "interrupted" : "ok";
              }
            }
            await this.tm.roster.emitAgentUpdate(session.id);
            this.tm.automationRuntime.emitAutomations(session);
          } catch (error) {
            this.tm.telemetry.reportAgentError({
              source: "automation",
              conversationId: session.id,
              requestId: this.tm.runLifecycle.lastRequestIdBySession.get(
                session.id,
              ),
              error: classifyAgentError(error),
              detail: sandErrorDetail(error),
            });
            const description = describeAgentRunError(error) as Record<
              string,
              any
            >;
            const detail =
              isTransientStreamError(error) &&
              description.errorKind == null &&
              description.rawDetail == null
                ? `Lost the connection repeatedly and gave up after retrying: ${description.detail}`
                : String(description.detail);
            this.finishAutomationRun(
              session,
              args.automation.id,
              runId,
              "error",
              detail,
            );
            this.tm.automationRuntime.emitAutomations(session);
            this.notifyAutomationFailure(
              session,
              args.automation,
              detail,
              args.trigger,
              description,
            );
            telemetryOutcome = "error";
          } finally {
            if (telemetryOutcome === "ok")
              this.clearAutomationFailureState(session.id, args.automation.id);
            this.tm.runLifecycle.endSessionRun(session);
            this.tm.telemetry.reportAutomationRun({
              conversationId: session.id,
              automationId: stableAutomationId({
                agentId: session.id,
                localId: args.automation.id,
              }),
              trigger: args.trigger,
              outcome: telemetryOutcome,
              isGroup,
              durationMs: Date.now() - firedAt,
              ...(args.scheduledForMs === undefined
                ? {}
                : {
                    scheduledForMs: args.scheduledForMs,
                    latenessMs: Math.max(0, firedAt - args.scheduledForMs),
                  }),
              ...(sentMessageCount === undefined ? {} : { sentMessageCount }),
              ...(isEventFire ? { eventBatchSize: eventBatch.length } : {}),
            });
            await this.tm.automationRuntime.enqueueAutomationLifecycleMutation({
              agentId: session.id,
              mutation: () => {
                if (this.tm.sessions.activeSession?.id === session.id)
                  this.tm.automationRuntime.recordAutomationChangeEvents(
                    session,
                    "agent",
                  );
                else
                  this.tm.automationRuntime.recordInactiveAutomationChanges({
                    agentId: session.id,
                    before: automationsBeforeRun,
                    after: session.automations.listDefinitions(),
                    source: "agent",
                  });
              },
            });
            runOutcome = telemetryOutcome;
          }
        },
        { lane: "background", source: "automation" },
      );
    } finally {
      if (!isEventFire) this.inFlightAutomationKeys.delete(runKey);
    }
    return runOutcome;
  }

  notifyAutomationFailure(
    session: any,
    automation: AutomationRecord,
    detail: string,
    trigger: AutomationRunTrigger,
    description: Record<string, any>,
  ): void {
    if (isBackgroundAutomationTrigger(trigger)) return;
    const errorKind = normalizeAutomationErrorKind(detail);
    const key = `${session.id}:${automation.id}:${errorKind}`;
    const occurrence = (this.automationFailureOccurrences.get(key) ?? 0) + 1;
    this.automationFailureOccurrences.set(key, occurrence);
    if (!shouldNotifyAutomationFailure(occurrence)) return;
    this.tm.trayErrors.pushError({
      agentId: session.id,
      title: `Automation "${automation.name}" failed`,
      detail,
      ...(description.errorKind == null
        ? {}
        : { errorKind: description.errorKind }),
      ...(description.rawDetail == null
        ? {}
        : { rawDetail: description.rawDetail }),
      ...(description.actions == null ? {} : { actions: description.actions }),
      dedupeKey: `automation-failure:${session.id}:${automation.id}:${errorKind}`,
      count: occurrence,
    });
  }
  clearAutomationFailureState(agentId: string, automationId: string): void {
    for (const key of this.automationFailureOccurrences.keys())
      if (key.startsWith(`${agentId}:${automationId}:`))
        this.automationFailureOccurrences.delete(key);
  }
  recordAutomationRun(session: any, automationId: string): void {
    try {
      session.automations.recordRunDefinition(automationId);
    } catch {}
  }
  beginAutomationRun(args: {
    session: any;
    automationId: string;
    trigger: AutomationRunTrigger;
    eventSummary?: string;
    runUuid?: string;
    coalescedRunUuids?: string[];
  }): string | null {
    try {
      return (
        args.session.automations.beginRun({
          id: args.automationId,
          trigger: args.trigger,
          ...(args.eventSummary === undefined
            ? {}
            : { event: args.eventSummary }),
          ...(args.runUuid === undefined ? {} : { runId: args.runUuid }),
          ...(args.coalescedRunUuids === undefined
            ? {}
            : { coalescedRunIds: args.coalescedRunUuids }),
        })?.id ?? null
      );
    } catch {
      return null;
    }
  }
  finishAutomationRun(
    session: any,
    automationId: string,
    runId: string | null,
    status: "ok" | "error",
    detail?: string,
  ): void {
    if (runId == null) return;
    try {
      session.automations.finishRunDefinition({
        id: automationId,
        runId,
        status,
        ...(detail === undefined ? {} : { detail }),
      });
    } catch {}
  }
}
