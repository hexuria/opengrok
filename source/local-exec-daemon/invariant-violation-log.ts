export const DAEMON_INVARIANT_VIOLATION_EVENT = "sand.local_exec_daemon.invariant_violation";

export function writeInvariantViolationLog(
  report: { readonly name: string },
  write: (line: string) => void = (line) => { void process.stdout.write(line); }
): void {
  write(`${JSON.stringify({ event: DAEMON_INVARIANT_VIOLATION_EVENT, name: report.name })}\n`);
}

