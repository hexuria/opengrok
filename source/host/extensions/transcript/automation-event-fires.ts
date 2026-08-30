import {
  MAX_EVENTS_IN_AUTOMATION_WAKE,
  type AutomationRecord,
} from "../../automations/automation.js";
import { errorMessage } from "../../../shared/errors.js";
import type { TranscriptManagerLike } from "./transcript-hub.js";

export const EVENT_FIRE_DEBOUNCE_MS = 750;
export const MAX_QUEUED_EVENT_FIRES_PER_AUTOMATION = 500;
export const MAX_REPORTED_DROPPED_FIRES = 256;

type FireOutcome = "ok" | "error" | "interrupted" | undefined;
interface FireItem {
  event: Record<string, unknown>;
  runUuid?: string;
  resolve(outcome: FireOutcome): void;
}
interface FireBatch {
  agentId: string;
  automation: AutomationRecord;
  items: FireItem[];
  debounce: AbortController | null;
  /** Compatibility handle used by manager teardown while debounce is armed. */
  timer: ReturnType<typeof setTimeout> | null;
  flushing: boolean;
  flushImmediately: boolean;
}
export interface DroppedFire {
  agentId: string;
  trigger: "schedule" | "manual" | "event";
  reason: string;
  scheduledForMs?: number;
  runUuid?: string;
}

export class AutomationEventFires {
  readonly pendingEventFireBatches = new Map<string, FireBatch>();
  readonly reportedDroppedFireUuids = new Set<string>();

  constructor(readonly tm: TranscriptManagerLike) {}

  enqueueEventAutomationFire(args: {
    agentId: string;
    automation: AutomationRecord;
    event: Record<string, unknown>;
    runUuid?: string;
  }): Promise<FireOutcome> {
    if (!this.tm.execution.canExecute || this.tm.disposed)
      return Promise.resolve(undefined);
    const runKey = `${args.agentId}:${args.automation.id}`;
    return new Promise((resolve) => {
      let batch = this.pendingEventFireBatches.get(runKey);
      if (batch == null) {
        batch = {
          agentId: args.agentId,
          automation: args.automation,
          items: [],
          debounce: null,
          timer: null,
          flushing: false,
          flushImmediately: false,
        };
        this.pendingEventFireBatches.set(runKey, batch);
      }
      batch.automation = args.automation;
      batch.items.push({
        event: args.event,
        ...(args.runUuid === undefined ? {} : { runUuid: args.runUuid }),
        resolve,
      });
      this.shedOverflowingEventFires(runKey);
      this.scheduleEventBatchFlush(runKey);
    });
  }

  shedOverflowingEventFires(runKey: string): void {
    const batch = this.pendingEventFireBatches.get(runKey);
    if (batch == null) return;
    const excess = batch.items.length - MAX_QUEUED_EVENT_FIRES_PER_AUTOMATION;
    if (excess <= 0) return;
    for (const item of batch.items.splice(0, excess)) {
      this.reportFireDropped({
        agentId: batch.agentId,
        trigger: "event",
        reason: "event_batch_overflow",
        ...(item.runUuid === undefined ? {} : { runUuid: item.runUuid }),
      });
      item.resolve("error");
    }
  }

  scheduleEventBatchFlush(runKey: string): void {
    const batch = this.pendingEventFireBatches.get(runKey);
    if (
      batch == null ||
      batch.items.length === 0 ||
      batch.flushing ||
      batch.debounce != null
    )
      return;
    const debounce = new AbortController();
    batch.debounce = debounce;
    const waitMs = batch.flushImmediately ? 0 : EVENT_FIRE_DEBOUNCE_MS;
    batch.flushImmediately = false;
    batch.timer = setTimeout(() => {
      batch.timer = null;
      batch.debounce = null;
      if (!debounce.signal.aborted) void this.flushEventBatch(runKey);
    }, waitMs);
  }

  async flushEventBatch(runKey: string): Promise<void> {
    const batch = this.pendingEventFireBatches.get(runKey);
    if (
      batch == null ||
      batch.items.length === 0 ||
      batch.flushing ||
      this.tm.disposed
    )
      return;
    batch.flushing = true;
    const items = batch.items.splice(0, MAX_EVENTS_IN_AUTOMATION_WAKE);
    const fireUuids = items.flatMap((item) =>
      item.runUuid === undefined ? [] : [item.runUuid],
    );
    let outcome: FireOutcome;
    try {
      outcome = (await this.tm.automationRuntime.fireAutomation({
        agentId: batch.agentId,
        automation: batch.automation,
        trigger: "event",
        events: items.map((item) => item.event),
        ...(fireUuids[0] === undefined ? {} : { runUuid: fireUuids[0] }),
        coalescedRunUuids: fireUuids.slice(1),
      })) as FireOutcome;
    } catch (error) {
      console.error(
        `[sand:automation] event wake dispatch failed for "${batch.automation.name}" (${batch.automation.id}): ${errorMessage(error)}`,
      );
    } finally {
      for (const item of items) item.resolve(outcome);
      batch.flushing = false;
      if (batch.items.length > 0) {
        batch.flushImmediately = true;
        this.scheduleEventBatchFlush(runKey);
      } else {
        this.pendingEventFireBatches.delete(runKey);
      }
    }
  }

  reportFireDropped(args: DroppedFire): void {
    if (args.runUuid !== undefined) {
      if (this.reportedDroppedFireUuids.has(args.runUuid)) return;
      this.reportedDroppedFireUuids.add(args.runUuid);
      while (this.reportedDroppedFireUuids.size > MAX_REPORTED_DROPPED_FIRES) {
        const oldest = this.reportedDroppedFireUuids.values().next().value as
          string | undefined;
        if (oldest === undefined) break;
        this.reportedDroppedFireUuids.delete(oldest);
      }
    }
    this.tm.telemetry.reportAutomationFireDropped({
      conversationId: args.agentId,
      trigger: args.trigger,
      reason: args.reason,
      ...(args.scheduledForMs == null
        ? {}
        : {
            scheduledForMs: args.scheduledForMs,
            latenessMs: Math.max(0, Date.now() - args.scheduledForMs),
          }),
    });
  }
}
