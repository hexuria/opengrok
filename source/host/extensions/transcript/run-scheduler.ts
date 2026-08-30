import { realClock, type Clock, type Disposable } from "./transcript-hub.js";

export type RunLane = "user" | "agent" | "background";
export interface RunTask {
  lane: RunLane;
  source: string;
  enqueuedAtMs: number;
  acceptedAtMs?: number;
  ackToken?: string;
  task(): Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
  promise: Promise<void>;
}
interface ActiveRun {
  item: RunTask;
  startedAtMs: number;
  generation: number;
  settled: Promise<void>;
  markSettled(): void;
  phase: "running" | "interrupted";
}
interface RunQueue {
  pendingUser: RunTask[];
  pendingAgent: RunTask[];
  pendingBackground: RunTask[];
  active: ActiveRun | null;
  generationCounter: number;
  zombies: Set<Promise<void>>;
  watchdogTimer?: Disposable;
  graceTimer?: Disposable;
}
export interface SchedulerOptions {
  watchdogMs: number;
  watchdogGraceMs: number;
  interruptWedgedRun(agentId: string): boolean;
  telemetry: {
    onAccepted(event: Record<string, any>): void;
    onDequeued(event: Record<string, any>): void;
    onWatchdog(event: Record<string, any>): void;
  };
  onRunStart?(agentId: string): void;
}

export function takeNextUserTask<T extends { source: string }>(
  pending: T[],
): T | undefined {
  if (pending.length === 0) return undefined;
  const preferred = pending.findIndex((item) => item.source !== "group-member");
  return pending.splice(preferred === -1 ? 0 : preferred, 1)[0];
}

export class SandRunScheduler {
  readonly queues = new Map<string, RunQueue>();
  private disposed = false;

  constructor(
    readonly options: SchedulerOptions,
    readonly clock: Clock = realClock,
  ) {}

  enqueue(
    agentId: string,
    task: () => Promise<void>,
    options: {
      lane: RunLane;
      source: string;
      acceptedAtMs?: number;
      ackToken?: string;
    },
  ): Promise<void> {
    const queue = this.queueFor(agentId);
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const item: RunTask = {
      lane: options.lane,
      source: options.source,
      enqueuedAtMs: this.clock.now(),
      ...(options.acceptedAtMs == null
        ? {}
        : { acceptedAtMs: options.acceptedAtMs }),
      ...(options.ackToken == null ? {} : { ackToken: options.ackToken }),
      task,
      resolve,
      reject,
      promise,
    };
    if (item.lane === "user") queue.pendingUser.push(item);
    else if (item.lane === "agent") queue.pendingAgent.push(item);
    else queue.pendingBackground.push(item);
    let pendingAhead =
      queue.pendingUser.length +
      queue.pendingAgent.length +
      queue.pendingBackground.length -
      1;
    if (item.lane === "user") pendingAhead = queue.pendingUser.length - 1;
    else if (item.lane === "agent")
      pendingAhead = queue.pendingUser.length + queue.pendingAgent.length - 1;
    this.options.telemetry.onAccepted({
      agentId,
      lane: item.lane,
      source: item.source,
      position: (queue.active == null ? 0 : 1) + pendingAhead,
      depthUser: queue.pendingUser.length,
      depthAgent: queue.pendingAgent.length,
      depthBackground: queue.pendingBackground.length,
      hasActive: queue.active != null,
    });
    this.armWatchdog(agentId, queue);
    void Promise.resolve().then(() => this.pump(agentId));
    return promise;
  }

  async drain(agentId: string): Promise<void> {
    const queue = this.queues.get(agentId);
    if (queue == null) return;
    const snapshot = [
      ...(queue.active == null ? [] : [queue.active.settled]),
      ...queue.zombies,
      ...queue.pendingUser.map((item) => item.promise),
      ...queue.pendingAgent.map((item) => item.promise),
      ...queue.pendingBackground.map((item) => item.promise),
    ];
    await Promise.allSettled(snapshot);
  }

  getDiagnostics(): Array<Record<string, unknown>> {
    const now = this.clock.now();
    const diagnostics: Array<Record<string, unknown>> = [];
    for (const [agentId, queue] of this.queues) {
      const depthUser = queue.pendingUser.length;
      const depthAgent = queue.pendingAgent.length;
      const depthBackground = queue.pendingBackground.length;
      if (
        depthUser === 0 &&
        depthAgent === 0 &&
        depthBackground === 0 &&
        queue.active == null
      )
        continue;
      diagnostics.push({
        agentId,
        depthUser,
        depthAgent,
        depthBackground,
        depthTotal:
          depthUser +
          depthAgent +
          depthBackground +
          (queue.active == null ? 0 : 1),
        ...(queue.pendingUser[0] == null
          ? {}
          : {
              oldestPendingUserAgeMs: now - queue.pendingUser[0].enqueuedAtMs,
            }),
        ...(queue.active == null
          ? {}
          : {
              active: {
                lane: queue.active.item.lane,
                source: queue.active.item.source,
                runtimeMs: now - queue.active.startedAtMs,
                phase: queue.active.phase,
              },
            }),
      });
    }
    return diagnostics;
  }

  getActiveLane(agentId: string): RunLane | undefined {
    return this.queues.get(agentId)?.active?.item.lane;
  }

  dispose(): void {
    this.disposed = true;
    for (const queue of this.queues.values()) this.disarmWatchdog(queue);
  }

  private queueFor(agentId: string): RunQueue {
    const existing = this.queues.get(agentId);
    if (existing != null) return existing;
    const created: RunQueue = {
      pendingUser: [],
      pendingAgent: [],
      pendingBackground: [],
      active: null,
      generationCounter: 0,
      zombies: new Set(),
    };
    this.queues.set(agentId, created);
    return created;
  }

  private pump(agentId: string): void {
    if (this.disposed) return;
    const queue = this.queues.get(agentId);
    if (queue == null || queue.active != null) return;
    const next =
      queue.pendingUser.length > 0
        ? takeNextUserTask(queue.pendingUser)
        : (queue.pendingAgent.shift() ?? queue.pendingBackground.shift());
    if (next == null) {
      this.disarmWatchdog(queue);
      return;
    }
    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    const active: ActiveRun = {
      item: next,
      startedAtMs: this.clock.now(),
      generation: ++queue.generationCounter,
      settled,
      markSettled,
      phase: "running",
    };
    queue.active = active;
    this.options.telemetry.onDequeued({
      agentId,
      lane: next.lane,
      source: next.source,
      queueWaitMs: active.startedAtMs - next.enqueuedAtMs,
      ...(next.acceptedAtMs == null
        ? {}
        : { acceptedToRunMs: active.startedAtMs - next.acceptedAtMs }),
      jumpedBackground:
        next.lane === "background" ? 0 : queue.pendingBackground.length,
      depthUser: queue.pendingUser.length,
      depthAgent: queue.pendingAgent.length,
      depthBackground: queue.pendingBackground.length,
    });
    this.disarmWatchdog(queue);
    this.armWatchdog(agentId, queue);
    this.options.onRunStart?.(agentId);
    let running: Promise<void>;
    try {
      running = next.task();
    } catch (error) {
      running = Promise.reject(error);
    }
    void running.then(
      () => {
        this.onTaskSettled(agentId, queue, active);
        markSettled();
      },
      (error) => {
        this.onTaskSettled(agentId, queue, active, { error });
        markSettled();
      },
    );
  }

  private onTaskSettled(
    agentId: string,
    queue: RunQueue,
    active: ActiveRun,
    failure?: { error: unknown },
  ): void {
    if (failure == null) active.item.resolve();
    else active.item.reject(failure.error);
    if (queue.active?.generation !== active.generation) {
      this.options.telemetry.onWatchdog({
        agentId,
        stage: "late_settle",
        activeLane: active.item.lane,
        activeSource: active.item.source,
        activeRuntimeMs: this.clock.now() - active.startedAtMs,
      });
      return;
    }
    queue.active = null;
    this.disarmWatchdog(queue);
    this.pump(agentId);
  }

  private waitedBehindActiveMs(queue: RunQueue): number | null {
    const head = queue.pendingUser[0];
    const active = queue.active;
    return head == null || active == null
      ? null
      : this.clock.now() - Math.max(head.enqueuedAtMs, active.startedAtMs);
  }
  private armWatchdog(agentId: string, queue: RunQueue): void {
    if (
      this.disposed ||
      queue.watchdogTimer != null ||
      queue.graceTimer != null
    )
      return;
    const waited = this.waitedBehindActiveMs(queue);
    if (waited == null) return;
    queue.watchdogTimer = this.clock.schedule(
      Math.max(0, this.options.watchdogMs - waited),
      () => {
        delete queue.watchdogTimer;
        this.onWatchdogFired(agentId, queue);
      },
    );
  }
  private disarmWatchdog(queue: RunQueue): void {
    queue.watchdogTimer?.dispose();
    queue.graceTimer?.dispose();
    delete queue.watchdogTimer;
    delete queue.graceTimer;
  }
  private onWatchdogFired(agentId: string, queue: RunQueue): void {
    if (this.disposed) return;
    const active = queue.active;
    const head = queue.pendingUser[0];
    const waited = this.waitedBehindActiveMs(queue);
    if (active == null || head == null || waited == null) return;
    if (waited < this.options.watchdogMs) {
      this.armWatchdog(agentId, queue);
      return;
    }
    let interrupted = false;
    try {
      interrupted = this.options.interruptWedgedRun(agentId);
    } catch {}
    active.phase = "interrupted";
    this.options.telemetry.onWatchdog({
      agentId,
      stage: "trip",
      activeLane: active.item.lane,
      activeSource: active.item.source,
      activeRuntimeMs: this.clock.now() - active.startedAtMs,
      waitingUserAgeMs: this.clock.now() - head.enqueuedAtMs,
      interrupted,
    });
    queue.graceTimer = this.clock.schedule(this.options.watchdogGraceMs, () => {
      delete queue.graceTimer;
      this.escapeWedgedRun(agentId, queue, active);
    });
  }
  private escapeWedgedRun(
    agentId: string,
    queue: RunQueue,
    active: ActiveRun,
  ): void {
    if (this.disposed || queue.active?.generation !== active.generation) return;
    const waitingHead = queue.pendingUser[0];
    this.options.telemetry.onWatchdog({
      agentId,
      stage: "escape",
      activeLane: active.item.lane,
      activeSource: active.item.source,
      activeRuntimeMs: this.clock.now() - active.startedAtMs,
      ...(waitingHead == null
        ? {}
        : { waitingUserAgeMs: this.clock.now() - waitingHead.enqueuedAtMs }),
      ...(active.item.ackToken == null
        ? {}
        : { ackToken: active.item.ackToken }),
    });
    active.item.resolve();
    queue.zombies.add(active.settled);
    void active.settled.then(() => queue.zombies.delete(active.settled));
    queue.active = null;
    this.pump(agentId);
  }
}
