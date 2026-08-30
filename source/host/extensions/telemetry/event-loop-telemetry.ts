import { monitorEventLoopDelay, performance } from "node:perf_hooks";

export const EVENT_LOOP_RESOLUTION_MS = 20,
  WINDOW_MS = 60_000,
  PRESSURE_P95_MS = 50,
  HEARTBEAT_EVERY_N_WINDOWS = 5;
export interface WindowEmitArgs {
  windowIndex: number;
  p95Ms: number;
  pressureP95Ms?: number;
  heartbeatEveryNWindows?: number;
}
export function resolveWindowEmit(
  args: WindowEmitArgs,
): "pressure" | "heartbeat" | undefined {
  const threshold = args.pressureP95Ms ?? PRESSURE_P95_MS;
  const heartbeat = args.heartbeatEveryNWindows ?? HEARTBEAT_EVERY_N_WINDOWS;
  if (args.p95Ms >= threshold) return "pressure";
  if (args.windowIndex % heartbeat === 0) return "heartbeat";
  return undefined;
}
export interface EventLoopWindowReport {
  trigger: "pressure" | "heartbeat";
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  utilization: number;
  windowMs: number;
}
export function eventLoopWindowTelemetry(r: EventLoopWindowReport) {
  return {
    level: r.trigger === "pressure" ? "warn" : "info",
    event: "sand.host.event_loop",
    metadata: {
      trigger: r.trigger,
      p50_ms: String(Math.round(r.p50Ms)),
      p95_ms: String(Math.round(r.p95Ms)),
      max_ms: String(Math.round(r.maxMs)),
      utilization: r.utilization.toFixed(3),
      window_ms: String(r.windowMs),
    },
  };
}
export function createEventLoopTelemetry(options: {
  windowMs?: number;
  now?: () => number;
  report: (
    report: Omit<EventLoopWindowReport, "trigger">,
    trigger: EventLoopWindowReport["trigger"],
  ) => void;
}) {
  const windowMs = options.windowMs ?? WINDOW_MS,
    now = options.now ?? Date.now;
  const monitor = monitorEventLoopDelay({
    resolution: EVENT_LOOP_RESOLUTION_MS,
  });
  monitor.enable();
  let lastUtilization = performance.eventLoopUtilization(),
    windowStartedAtMs = now(),
    windowIndex = 0,
    disposed = false;
  return {
    onTick: () => {
      if (disposed) return;
      const nowMs = now(),
        elapsedMs = nowMs - windowStartedAtMs;
      if (elapsedMs < windowMs) return;
      windowIndex += 1;
      windowStartedAtMs = nowMs;
      const toMs = (ns: number) =>
        Math.max(0, ns / 1e6 - EVENT_LOOP_RESOLUTION_MS);
      const p50Ms = toMs(monitor.percentile(50)),
        p95Ms = toMs(monitor.percentile(95)),
        maxMs = toMs(monitor.max);
      monitor.reset();
      const current = performance.eventLoopUtilization(),
        active = current.active - lastUtilization.active,
        idle = current.idle - lastUtilization.idle;
      lastUtilization = current;
      const total = active + idle,
        utilization = total > 0 && Number.isFinite(total) ? active / total : 0;
      const trigger = resolveWindowEmit({ windowIndex, p95Ms });
      if (trigger !== undefined)
        options.report(
          { p50Ms, p95Ms, maxMs, utilization, windowMs: elapsedMs },
          trigger,
        );
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      monitor.disable();
    },
  };
}
