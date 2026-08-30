import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import type { Context } from "../../packages/context/core.js";
import { WriteArgs } from "../../packages/proto/generated/agent/v1/write_exec_pb.js";
import {
  shellExecutorResource,
  type ShellExecResult,
  type ShellExecutor
} from "../../packages/agent-exec/shell.js";
import {
  writeExecutorResource,
  type WriteExecutor
} from "../../packages/agent-exec/write.js";
import { buildHostShellArgs } from "./box-shell-command.js";
export class SandBoxFileTransferError extends Error { override name = "SandBoxFileTransferError"; }
export class BoxShellTransientError extends Error { override name = "BoxShellTransientError"; }
export class BoxShellSignalKilledError extends BoxShellTransientError { override name = "BoxShellSignalKilledError"; }
export class BoxShellUnavailableError extends BoxShellTransientError { override name = "BoxShellUnavailableError"; }
export const TRANSFER_TOOL_CALL_ID = "sand-box-file-transfer";
export function isSignalKillFailure(exitCode: number, signal: string): boolean { return signal.length > 0 || exitCode < 0; }
export function shellSingleQuote(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }
type ShellResult = ShellExecResult;
export function describeShellFailure(result: ShellResult): string { switch (result.case) { case "failure": { const { exitCode, signal, stderr, aborted } = result.value; const head = exitCode < 0 || signal ? `killed by signal ${signal || "(unknown)"}${aborted ? " (aborted)" : ""}` : `exit ${exitCode}${aborted ? " (aborted)" : ""}`; return stderr ? `${head}: ${stderr}` : head; } case "spawnError": return `exec-daemon spawn error: ${result.value.error}`; case "permissionDenied": return `permission denied: ${result.value.error}`; case "rejected": return `exec-daemon rejected the command: ${result.value.reason}`; case "timeout": return `exec-daemon timed out after ${result.value.timeoutMs}ms`; default: return result.case ?? "unknown (no result from exec-daemon)"; } }
export function asTransientBoxShellError(result: ShellResult, context: string): BoxShellTransientError | undefined { switch (result.case) { case "failure": return isSignalKillFailure(result.value.exitCode, result.value.signal) ? new BoxShellSignalKilledError(`${context} signal-killed (${describeShellFailure(result)})`) : undefined; case "spawnError": case "timeout": case "rejected": return new BoxShellUnavailableError(`${context} (${describeShellFailure(result)})`); default: return undefined; } }
export interface FileTransferAccessor { get(resource: typeof shellExecutorResource): ShellExecutor; get(resource: typeof writeExecutorResource): WriteExecutor }
export async function runBoxShell(ctx: Context, accessor: FileTransferAccessor, script: string): Promise<void> { const command = `bash -lc ${shellSingleQuote(script)}`; const result = (await accessor.get(shellExecutorResource).execute(ctx, buildHostShellArgs({ command, name: "bash", workingDirectory: "/", toolCallId: TRANSFER_TOOL_CALL_ID }))).result; if (result.case === "success" && result.value.exitCode === 0) return; const transient = asTransientBoxShellError(result, "box shell command"); if (transient) throw transient; throw new SandBoxFileTransferError(`box shell command failed (${describeShellFailure(result)})`); }
export async function writeFileBytesViaExecDaemon(ctx: Context, accessor: FileTransferAccessor, boxPath: string, data: Uint8Array): Promise<void> { const result = (await accessor.get(writeExecutorResource).execute(ctx, new WriteArgs({ path: boxPath, fileBytes: Uint8Array.from(data), toolCallId: TRANSFER_TOOL_CALL_ID }))).result; if (result.case === "success") return; const reason = result.case === "error" ? result.value.error : result.case === "rejected" ? result.value.reason : result.case; throw new SandBoxFileTransferError(`upload to box ${boxPath} failed (${result.case}): ${reason}`); }
export async function uploadFileViaExecDaemon(ctx: Context, accessor: FileTransferAccessor, boxPath: string, data: Uint8Array): Promise<void> { await runBoxShell(ctx, accessor, `mkdir -p -- ${shellSingleQuote(posix.dirname(boxPath))}`); const part = `${boxPath}.sand-${randomBytes(8).toString("hex")}.part`; try { await writeFileBytesViaExecDaemon(ctx, accessor, part, data); } catch (error) { await runBoxShell(ctx, accessor, `rm -f -- ${shellSingleQuote(part)}`).catch(() => {}); throw error; } await runBoxShell(ctx, accessor, `mv -f -- ${shellSingleQuote(part)} ${shellSingleQuote(boxPath)}`); }
