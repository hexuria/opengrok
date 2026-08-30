import type { DeadlinePolicy } from "../../internal/scheduling.js";

export type QuitTelemetryDecision = "flush-started" | "flush-pending" | "proceed";
export function createQuitTelemetryFlush(deps: { readonly deadline: DeadlinePolicy; readonly failurePreserveDeadline: DeadlinePolicy; readonly onFailure: (error: unknown) => void; readonly preserveOnFailure: () => Promise<void>; readonly onSettled: () => void }) {
  let attempted = false;
  let inFlight = false;
  return {
    noteQuit(flushWork: (signal: AbortSignal) => Promise<void>): QuitTelemetryDecision {
      if (inFlight) return "flush-pending";
      if (attempted) return "proceed";
      attempted = true;
      inFlight = true;
      void deps.deadline.run(flushWork).catch((error) => deps.failurePreserveDeadline.run(async () => { deps.onFailure(error); await deps.preserveOnFailure(); }).catch((preserveError) => { deps.onFailure(preserveError); })).finally(() => { inFlight = false; deps.onSettled(); });
      return "flush-started";
    },
  };
}
