import { findSystemErrno } from "../../shared/system-errno.js";

export type LocalExecLifecycleLevel = "info" | "warn" | "error";
export type LocalExecLifecycleSink = (level: LocalExecLifecycleLevel, fields: Record<string, string | undefined>) => void;
let sink: LocalExecLifecycleSink | undefined;
export function installLocalExecLifecycleReporter(next?: LocalExecLifecycleSink): () => void { sink = next; return () => { if (sink === next) sink = undefined; }; }
export function classifyExitCode(exitCode?: number): "unknown" | "zero" | "nonzero" { return exitCode === undefined ? "unknown" : exitCode === 0 ? "zero" : "nonzero"; }
export function reportLocalExecSpawned(pid?: number): void { sink?.("info", { phase: "spawned", daemon_pid: pid === undefined ? undefined : String(pid) }); }
export function reportLocalExecSpawnFailed(error: unknown): void { sink?.("error", { phase: "spawn_failed", "sand.failure_code": "desktop_local_exec_spawn_failed", errno: findSystemErrno(error) }); }
export function reportLocalExecTerminationFailed(pid: number, error: unknown): void { sink?.("error", { phase: "termination_failed", "sand.failure_code": "desktop_local_exec_termination_failed", daemon_pid: String(pid), errno: findSystemErrno(error) }); }
export const EXIT_SIGNALS = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP", "SIGQUIT", "SIGABRT", "SIGSEGV", "SIGBUS", "SIGILL", "SIGFPE", "SIGPIPE", "SIGTRAP"]);
export function boundedSignal(signal: string | null): string | undefined { return signal === null ? undefined : EXIT_SIGNALS.has(signal) ? signal : "SIG_OTHER"; }
export function reportLocalExecExited(exit: { readonly pid?: number; readonly exitCode: number | null; readonly signal: string | null; readonly uptimeMs: number }): void { sink?.("warn", { phase: "exited", daemon_pid: exit.pid === undefined ? undefined : String(exit.pid), exit_code: exit.exitCode === null ? undefined : String(exit.exitCode), exit_code_class: exit.signal !== null ? "signal" : classifyExitCode(exit.exitCode ?? undefined), signal: boundedSignal(exit.signal), uptime_ms: String(Math.round(exit.uptimeMs)) }); }
