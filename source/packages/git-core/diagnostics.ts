import { redactHttpUrlUserinfo } from "./redaction.js";
const GIT_DIAGNOSTICS_PREFIX = " [git: ", GIT_DIAGNOSTICS_RE = / \[git: ([^\]]*)\]/, GIT_STDERR_LOG_CAP = 2_048;
const capStderr = (stderr: string): string => stderr.length <= GIT_STDERR_LOG_CAP ? stderr : `${stderr.slice(0, GIT_STDERR_LOG_CAP)}… [truncated to ${GIT_STDERR_LOG_CAP} chars]`;
export function appendGitDiagnostics(message: string, error: unknown, options?: { includeStderr?: boolean }): string {
  if (typeof error !== "object" || error === null || GIT_DIAGNOSTICS_RE.test(message)) return message;
  const candidate = error as { gitErrorCode?: unknown; exitCode?: unknown; stderr?: unknown }, parts: string[] = [];
  if (typeof candidate.gitErrorCode === "string" && candidate.gitErrorCode.length > 0) parts.push(`gitErrorCode=${candidate.gitErrorCode}`);
  if (typeof candidate.exitCode === "number" && Number.isFinite(candidate.exitCode)) parts.push(`exitCode=${candidate.exitCode}`);
  if (parts.length === 0) return message;
  let annotated = `${message}${GIT_DIAGNOSTICS_PREFIX}${parts.join(" ")}]`;
  if (options?.includeStderr === true && typeof candidate.stderr === "string" && candidate.stderr.length > 0) annotated += `\n--- git stderr ---\n${capStderr(redactHttpUrlUserinfo(candidate.stderr))}`;
  return annotated;
}
