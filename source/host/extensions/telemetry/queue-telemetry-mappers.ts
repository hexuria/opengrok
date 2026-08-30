type Fields = Record<string, string | number | boolean | null | undefined>;
export const SEND_DISPATCH_EVENT = "sand.send_dispatch",
  QUEUE_ACCEPTED_EVENT = "sand.queue.accepted",
  QUEUE_DEQUEUED_EVENT = "sand.queue.dequeued",
  QUEUE_WATCHDOG_EVENT = "sand.queue.watchdog",
  ACK_OBLIGATION_EVENT = "sand.ack.obligation",
  PENDING_WAKE_EVENT = "sand.pending_wake";
export function sendDispatchTelemetry(r: Fields) {
  return {
    level: "info",
    event: SEND_DISPATCH_EVENT,
    metadata: {
      conversation_id: r.conversationId,
      send_dispatch_ms:
        r.dispatchMs !== undefined
          ? String(Math.round(r.dispatchMs as number))
          : undefined,
      send_dispatch_host_ms: String(Math.round(r.hostDispatchMs as number)),
      skew: String(r.skew),
      skew_reason: r.skewReason,
      skew_bucket: r.skewBucket,
      is_fork: String(r.isFork),
      model_id: r.modelId,
      trace_id: r.traceId,
      span_id: r.spanId,
    },
  };
}
export function queueAcceptedTelemetry(r: Fields) {
  return {
    level: "info",
    event: QUEUE_ACCEPTED_EVENT,
    metadata: {
      conversation_id: r.conversationId,
      lane: r.lane,
      source: r.source,
      position: String(r.position),
      depth_user: String(r.depthUser),
      depth_agent: String(r.depthAgent),
      depth_background: String(r.depthBackground),
      has_active: String(r.hasActive),
    },
  };
}
export function queueDequeuedTelemetry(r: Fields) {
  return {
    level: "info",
    event: QUEUE_DEQUEUED_EVENT,
    metadata: {
      conversation_id: r.conversationId,
      lane: r.lane,
      source: r.source,
      queue_wait_ms: String(Math.round(r.queueWaitMs as number)),
      accepted_to_run_ms:
        r.acceptedToRunMs !== undefined
          ? String(Math.round(r.acceptedToRunMs as number))
          : undefined,
      jumped_background: String(r.jumpedBackground),
      depth_user: String(r.depthUser),
      depth_agent: String(r.depthAgent),
      depth_background: String(r.depthBackground),
    },
  };
}
export function queueWatchdogTelemetry(r: Fields) {
  return {
    level: r.stage === "late_settle" ? "info" : "warn",
    event: QUEUE_WATCHDOG_EVENT,
    metadata: {
      conversation_id: r.conversationId,
      stage: r.stage,
      active_lane: r.activeLane,
      active_source: r.activeSource,
      active_runtime_ms: String(Math.round(r.activeRuntimeMs as number)),
      waiting_user_age_ms:
        r.waitingUserAgeMs !== undefined
          ? String(Math.round(r.waitingUserAgeMs as number))
          : undefined,
      interrupted:
        r.interrupted !== undefined ? String(r.interrupted) : undefined,
    },
  };
}
export function ackObligationTelemetry(r: Fields) {
  return {
    level: r.outcome === "lost" ? "warn" : "info",
    event: ACK_OBLIGATION_EVENT,
    metadata: {
      conversation_id: r.conversationId,
      outcome: r.outcome,
      age_ms:
        r.ageMs !== undefined
          ? String(Math.round(r.ageMs as number))
          : undefined,
      coalesced_count:
        r.coalescedCount !== undefined ? String(r.coalescedCount) : undefined,
      redrive_attempts:
        r.redriveAttempts !== undefined ? String(r.redriveAttempts) : undefined,
      time_to_first_visible_ack_ms:
        r.timeToFirstVisibleAckMs !== undefined
          ? String(Math.round(r.timeToFirstVisibleAckMs as number))
          : undefined,
      interrupt_to_replacement_ack_ms:
        r.interruptToReplacementAckMs !== undefined
          ? String(Math.round(r.interruptToReplacementAckMs as number))
          : undefined,
      reason: r.reason,
    },
  };
}
export function pendingWakeTelemetry(r: Fields) {
  return {
    level:
      r.outcome === "persist_failed" ||
      r.outcome === "rearm_failed" ||
      r.outcome === "pruned"
        ? "warn"
        : "info",
    event: PENDING_WAKE_EVENT,
    metadata: {
      conversation_id: r.conversationId,
      outcome: r.outcome,
      kind: r.kind,
      work_id: r.workId,
      age_ms:
        r.ageMs !== undefined
          ? String(Math.round(r.ageMs as number))
          : undefined,
      reason: r.reason,
      quiet_origin:
        r.isQuietOrigin != null ? String(r.isQuietOrigin) : undefined,
    },
  };
}
