type Level = "info" | "warn";
export function createBoxVisibilitySink(getUploader: () => { reportBoxSetupVisible(level: Level, metadata: Record<string, string | undefined>): void; reportBoxRecreateVisible(level: Level, metadata: Record<string, string | undefined>): void; reportBoxRebuildStage(level: Level, metadata: Record<string, string | undefined>): void } | null | undefined) {
  return {
    emit(event: "setup" | "recreate", payload: any): void { const level = event === "setup" || payload.outcome !== "ready" ? "warn" : "info"; const metadata = { trigger: payload.trigger, outcome: payload.outcome, duration_ms: String(payload.durationMs), operation_id: payload.operationId, kind: payload.kind, surface: payload.surface }; if (event === "setup") getUploader()?.reportBoxSetupVisible(level, metadata); else getUploader()?.reportBoxRecreateVisible(level, metadata); },
    emitRecreateHeartbeat(payload: any): void { getUploader()?.reportBoxRecreateVisible(payload.isStalled ? "warn" : "info", { phase: "heartbeat", trigger: payload.trigger, elapsed_ms: String(payload.elapsedMs), stage: payload.stage, migration_phase: payload.migrationPhase, operation_id: payload.operationId }); },
    emitRebuildStage(payload: any): void { getUploader()?.reportBoxRebuildStage("info", { kind: payload.kind, from_stage: payload.fromStage, to_stage: payload.toStage, migration_phase: payload.migrationPhase, stage_elapsed_ms: String(payload.stageElapsedMs), operation_id: payload.operationId }); },
  };
}
