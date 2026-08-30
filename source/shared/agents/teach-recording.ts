export const SAND_TEACH_MAX_DURATION_MS = 10 * 60 * 1_000;

export const IDLE_TEACH_RECORDING_STATUS = {
  state: "idle",
  agentId: null,
  startedAtMs: null,
  maxDurationMs: SAND_TEACH_MAX_DURATION_MS,
} as const;
