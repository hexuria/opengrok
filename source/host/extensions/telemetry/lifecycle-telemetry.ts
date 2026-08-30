import {
  sandErrorTags,
  type SandErrorValue,
} from "../../../shared/errors/registry.js";
import type { HostLifecycleReport } from "./host-lifecycle-progress.js";

export const HOST_STARTUP_EVENT = "sand.host.startup",
  HOST_LIFECYCLE_EVENT = "sand.host.lifecycle",
  DAEMON_PING_EVENT = "sand.box.daemon_ping",
  BOX_IMAGE_CHECK_EVENT = "sand.box.image_check",
  BOX_BOOT_STAGE_EVENT = "sand.box.boot_stage",
  BOX_BOOT_FAILURE_EVENT = "sand.box.boot_failure",
  EGRESS_TUNNEL_EVENT = "sand.box.egress_tunnel",
  HOST_BOOT_FETCH_EVENT = "sand.box.host_boot_fetch",
  EXEC_DAEMON_RESTART_EVENT = "sand.box.exec_daemon_restart",
  SUPERVISOR_RESTART_EVENT = "sand.box.supervisor_restart",
  COOKIE_PERSIST_EVENT = "sand.box.cookie_persist",
  BOX_PROCESS_CRASH_EVENT = "sand.box.process_crash";
type Fields = Record<
  string,
  string | number | boolean | undefined | { code?: string }
>;

export type BoxImageCheckReport =
  | {
      trigger: string;
      outcome: "skipped";
      durationMs: number;
      skipReason: string;
    }
  | {
      trigger: string;
      outcome: "answered" | "unanswered";
      durationMs: number;
    }
  | {
      trigger: string;
      outcome: "timeout" | "failed";
      durationMs: number;
      error: SandErrorValue;
    };

export function hostStartupTelemetry(
  metadata: Record<string, string>,
  hostBuiltAtMs: string,
) {
  return {
    level: "info",
    event: HOST_STARTUP_EVENT,
    metadata: { host_built_at_ms: hostBuiltAtMs, ...metadata },
  };
}
export function hostLifecycleTelemetry(r: HostLifecycleReport) {
  let level: "info" | "warn" | "error" = "info";
  if (r.outcome === "stuck") level = "warn";
  if (r.outcome === "failed") level = "error";
  return {
    level,
    event: HOST_LIFECYCLE_EVENT,
    metadata: {
      phase: r.phase,
      outcome: r.outcome,
      duration_ms: String(r.durationMs),
      plugin_count:
        r.outcome === "completed" && r.phase === "plugin_graph"
          ? String(r.pluginCount)
          : undefined,
      entry_count:
        r.outcome === "completed" && r.phase === "transcript_read"
          ? String(r.entryCount)
          : undefined,
      ...(r.outcome === "completed" ? {} : sandErrorTags(r.error)),
    },
  };
}
export function daemonPingTelemetry(r: Fields) {
  return {
    level: r.outcome === "ok" ? "warn" : "error",
    event: DAEMON_PING_EVENT,
    metadata: {
      outcome: r.outcome,
      attempts: String(r.attempts),
      duration_ms: String(r.durationMs),
      unready_duration_ms: String(r.unreadyDurationMs),
      readiness_state: r.readinessState,
      target: r.target,
      cause: r.outcome === "ok" ? undefined : r.causeSummary,
    },
  };
}
export function boxImageCheckTelemetry(r: BoxImageCheckReport) {
  let level: "info" | "warn" = "info",
    tags = {};
  if (r.outcome === "timeout" || r.outcome === "failed") {
    level = "warn";
    tags = sandErrorTags(r.error);
  }
  return {
    level,
    event: BOX_IMAGE_CHECK_EVENT,
    metadata: {
      trigger: r.trigger,
      outcome: r.outcome,
      duration_ms: String(r.durationMs),
      skip_reason: r.outcome === "skipped" ? r.skipReason : undefined,
      ...tags,
    },
  };
}
export function boxInfrastructureTelemetry(event: Fields) {
  switch (event.kind) {
    case "boot_stage":
      return {
        level: event.stage === "ready" ? "warn" : "info",
        event: BOX_BOOT_STAGE_EVENT,
        metadata: { stage: event.stage, duration_ms: String(event.durationMs) },
      };
    case "boot_failure":
      return {
        level: "error",
        event: BOX_BOOT_FAILURE_EVENT,
        metadata: {
          stage: event.stage,
          reason: event.reason,
          duration_ms: String(event.durationMs),
        },
      };
    case "egress_tunnel":
      return {
        level: event.outcome === "ready" ? "info" : "warn",
        event: EGRESS_TUNNEL_EVENT,
        metadata: {
          outcome: event.outcome,
          attempt: String(event.attempt),
          exit_status:
            event.exitStatus !== undefined
              ? String(event.exitStatus)
              : undefined,
          runtime_s:
            event.runtimeS !== undefined ? String(event.runtimeS) : undefined,
        },
      };
    case "host_boot_fetch": {
      let level: "info" | "warn" | "error" = "info";
      if (event.outcome === "fallback") level = "warn";
      if (event.outcome === "restore_failed") level = "error";
      return {
        level,
        event: HOST_BOOT_FETCH_EVENT,
        metadata: {
          outcome: event.outcome,
          reason: event.reason,
          duration_ms: String(event.durationMs),
          swap_ms:
            event.swapMs !== undefined ? String(event.swapMs) : undefined,
          from_version: event.fromVersion,
          to_version: event.toVersion,
        },
      };
    }
    case "exec_daemon_restart":
      return {
        level: "error",
        event: EXEC_DAEMON_RESTART_EVENT,
        metadata: {
          restart_attempt: String(event.restartAttempt),
          runtime_s: String(event.runtimeS),
          cause: event.cause,
          exit_status: String(event.exitStatus),
        },
      };
    case "supervisor_restart":
      return {
        level: "error",
        event: SUPERVISOR_RESTART_EVENT,
        metadata: {
          restart_attempt: String(event.restartAttempt),
          runtime_s: String(event.runtimeS),
          cause: event.cause,
          exit_status: String(event.exitStatus),
        },
      };
    case "cookie_persist":
      return {
        level: event.outcome === "failed" ? "error" : "warn",
        event: COOKIE_PERSIST_EVENT,
        metadata: {
          phase: event.phase,
          outcome: event.outcome,
          seed_cookies: String(event.seedCookies),
          injected:
            event.injected !== undefined ? String(event.injected) : undefined,
          missing_after:
            event.missingAfter !== undefined
              ? String(event.missingAfter)
              : undefined,
          attempts:
            event.attempts !== undefined ? String(event.attempts) : undefined,
        },
      };
    case "process_crash":
      return {
        level: "warn",
        event: BOX_PROCESS_CRASH_EVENT,
        metadata: {
          binary: event.binary,
          signal: event.signal,
          count: String(event.count),
        },
      };
    default:
      return event;
  }
}
