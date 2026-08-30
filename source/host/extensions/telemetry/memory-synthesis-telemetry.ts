import {
  sandErrorTags,
  type SandErrorValue,
} from "../../../shared/errors/registry.js";

export const MEMORY_SYNTHESIS_EVENT = "sand.memory.synthesis";
export type MemorySynthesisReport =
  | { outcome: "skipped_gate" }
  | {
      outcome: "shed";
      cause: SandErrorValue;
      itemCount: number;
    }
  | {
      outcome: "failed";
      cause: SandErrorValue;
      durationMs: number;
      itemCount: number;
    }
  | {
      outcome: "ok";
      durationMs: number;
      itemCount: number;
    };

export function memorySynthesisTelemetry(r: MemorySynthesisReport) {
  if (r.outcome === "skipped_gate")
    return {
      level: "info",
      event: MEMORY_SYNTHESIS_EVENT,
      metadata: { outcome: r.outcome },
    };
  if (r.outcome === "shed")
    return {
      level: "warn",
      event: MEMORY_SYNTHESIS_EVENT,
      metadata: {
        outcome: r.outcome,
        ...sandErrorTags(r.cause),
        item_count: String(r.itemCount),
      },
    };
  return {
    level: r.outcome === "failed" ? "warn" : "info",
    event: MEMORY_SYNTHESIS_EVENT,
    metadata: {
      outcome: r.outcome,
      ...(r.outcome === "failed" ? sandErrorTags(r.cause) : {}),
      duration_ms: String(Math.round(r.durationMs)),
      item_count: String(r.itemCount),
    },
  };
}
