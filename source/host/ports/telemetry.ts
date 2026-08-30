export function sandErrorDetail(error: unknown): { message: string; stack?: string } { return error instanceof Error ? { message: error.message, ...(error.stack !== undefined ? { stack: error.stack } : {}) } : { message: String(error) }; }
export const SAND_BOX_BOOT_STAGES = ["entrypoint_started", "daemon_listening", "desktop_up", "ready"] as const;
export const SAND_BOX_BOOT_ID_ENV = "SAND_BOX_BOOT_ID", SAND_BOX_BOOT_STARTED_AT_MS_ENV = "SAND_BOX_BOOT_STARTED_AT_MS", SAND_BOX_AUTH_ID_ENV = "SAND_BOX_AUTH_ID", SAND_BOX_TENANT_ID_ENV = "SAND_BOX_TENANT_ID", SAND_BOX_STORE_ID_ENV = "SAND_BOX_STORE_ID", SAND_BOX_CLUSTER_ENV = "SAND_BOX_CLUSTER";
export function resolveSandBoxIdentityTags(env: NodeJS.ProcessEnv = process.env) { return { auth_id: env[SAND_BOX_AUTH_ID_ENV]?.trim(), tenant_id: env[SAND_BOX_TENANT_ID_ENV]?.trim(), box_store_id: env[SAND_BOX_STORE_ID_ENV]?.trim(), box_boot_id: env[SAND_BOX_BOOT_ID_ENV]?.trim(), cluster: env[SAND_BOX_CLUSTER_ENV]?.trim() }; }
export const SAND_HOST_LIFECYCLE_PHASES = ["plugin_graph", "identity", "log_catchup", "transcript_read", "ready"] as const;
export const SAND_EXEC_DAEMON_RESTART_CAUSES = ["daemon_exited", "startup_listener_timeout", "listener_lost"] as const;
export const SAND_SUPERVISOR_RESTART_CAUSES = ["supervisor_exited", "startup_status_timeout", "status_stale", "gave_up"] as const;
export const SAND_COOKIE_PERSIST_PHASES = ["capture", "restore"] as const;
export const SAND_COOKIE_PERSIST_OUTCOMES = ["captured", "ok", "partial", "failed", "empty"] as const;
export const SAND_EGRESS_TUNNEL_OUTCOMES = ["ready", "restart", "startup_timeout", "listener_lost", "stale_port"] as const;
export const SAND_BOX_BOOT_FAILURE_STAGES = ["desktop"] as const, SAND_BOX_BOOT_FAILURE_REASONS = ["x_display_timeout"] as const;
export const SAND_PROCESS_CRASH_BINARIES = ["cursor", "cursor-nightly", "cursor-lab", "chrome", "node", "exec-daemon", "xvfb", "xfwm4", "picom", "x11vnc", "websockify", "plank", "thunar", "xfce4-terminal", "other"] as const;
export const SAND_PROCESS_CRASH_SIGNALS = ["sigill", "sigsegv", "sigabrt", "sigbus", "other"] as const;
export const SAND_HOST_BOOT_FETCH_OUTCOMES = ["current", "applied", "fallback", "restore_failed"] as const;
export const SAND_HOST_BOOT_FETCH_REASONS = ["current", "applied", "pointer_unreachable", "pointer_malformed", "target_vetoed", "download_failed", "swap_refused", "swap_failed_restored", "restore_failed", "budget_exceeded", "unexpected_error"] as const;
const noop = () => {};
const NOOP_TURN = { setModel: noop, setRequestId: noop, finalize: noop };

/** Exact no-op surface emitted in the shipped host bundle. */
export function createNoopSandTelemetry() {
  return {
    startTurn: () => NOOP_TURN,
    reportToolCallError: noop,
    reportToolCallStalled: noop,
    reportToolCallStarted: noop,
    reportAgentError: noop,
    reportBotBlock: noop,
    reportDaemonPing: noop,
    reportBoxBootStage: noop,
    reportExecDaemonRestart: noop,
    reportSupervisorRestart: noop,
    reportAutomationRun: noop,
    reportAutomationFireDropped: noop,
    reportAutomationLifecycle: noop,
    reportTurnInterrupt: noop,
    reportTurnAwait: noop,
    reportTurnRetry: noop,
    reportUserMessageReceived: noop,
    reportClosingSendNudge: noop,
    reportSubagentRevival: noop,
    reportShellRevival: noop,
    reportComputerUseUsage: noop,
    reportTtft: noop,
    reportSendDispatch: noop,
    reportQueueAccepted: noop,
    reportQueueDequeued: noop,
    reportQueueWatchdog: noop,
    reportAckObligation: noop,
    reportPendingWake: noop,
    reportTurnUsage: noop,
    reportTurnEmptyDelivery: noop,
    reportJournalOutcome: noop,
    reportAutoReviewExpireSweepFailed: noop
  };
}
