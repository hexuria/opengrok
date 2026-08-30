import { realClock, type Clock } from "../../internal/scheduling.js";

export function delay(ms: number, signal?: AbortSignal): Promise<void> { return delayWith(realClock, ms, signal); }
export function delayWith(clock: Clock, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) { resolve(); return; }
    const onAbort = (): void => { scheduled.dispose(); resolve(); };
    const scheduled = clock.schedule(Number.isFinite(ms) && ms > 0 ? ms : 0, () => {
      signal?.removeEventListener("abort", onAbort); resolve();
    });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
