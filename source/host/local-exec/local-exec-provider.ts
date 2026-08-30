import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

import type { JsonValue } from "@bufbuild/protobuf";

import { createDeadlinePolicy, createIdleWatchdogPolicy, createPollingPolicy, createRetryPolicy, realClock } from "../../internal/scheduling.js";
import { errorLogTag, errorMessage } from "../../shared/errors.js";
import { GATEWAY_AUTH_SCHEME } from "../../shared/gateway-wire.js";
import {
  DEFAULT_MAX_LOCAL_EXEC_FILE_BYTES, GATEWAY_LOCAL_EXEC_REQUESTS_PATH, GATEWAY_LOCAL_EXEC_RESPONSES_PATH,
  SAND_LOCAL_EXEC_CONTROL_POST_TIMEOUT_MS, SAND_LOCAL_EXEC_DATA_POST_TIMEOUT_MS, SAND_LOCAL_EXEC_HEARTBEAT_INTERVAL_MS,
  localExecFileTooLargeMessage, localExecUploadFrameTooLargeMessage, maxLocalExecUploadFrameBytes
} from "../../shared/local-exec-gateway.js";
import { describeLocalExec, type LocalExecMessage, type SandLocalToolRequest } from "../../shared/local-tool-permission-machinery.js";
import { describeMessagesOp, isMessagesOp } from "../../shared/messages-request.js";
import { writeFileAtomic } from "../../shared/node/atomic-write.js";
import { containPath, regularFileSizeBytes, resolveLocalExecRoot } from "./local-exec-machine.js";
import { runMessagesOp } from "./messages-op.js";
import type { LocalExecConnection } from "./local-exec-daemon-protocol.js";

export class SandLocalExecStreamError extends Error {}
export const SSE_RECONNECT_MIN_MS = 1_000;
export const SSE_RECONNECT_MAX_MS = 10_000;
export const SSE_STALL_TIMEOUT_MS = 35_000;
export const STALE_CONNECTION_FAILURE_THRESHOLD = 3;
export const RESPONSE_POST_RETRIES = 3;
export const RESPONSE_POST_RETRY_DELAY_MS = 200;
export const DEFAULT_SAND_COMPUTER_ID = "this-computer";

export interface LocalExecDecodedMessage { id: number; readonly message?: { readonly case?: string; readonly value?: Record<string, unknown> }; }
export interface LocalExecExecutorOutput { readonly kind: "client" | "control"; readonly message: JsonValue; }
export interface LocalExecExecutor {
  decodeServerMessage(json: JsonValue): LocalExecDecodedMessage;
  execute(message: LocalExecDecodedMessage, signal: AbortSignal): AsyncIterable<LocalExecExecutorOutput>;
  cancel(execId: number): void;
  throwControl(error: string): JsonValue;
}

function normalizeDescribableMessage(
  decoded: LocalExecDecodedMessage
): { readonly message: LocalExecMessage } | undefined {
  const message = decoded.message;
  if (
    typeof message?.case !== "string" ||
    message.value == null ||
    typeof message.value !== "object" ||
    Array.isArray(message.value)
  ) return undefined;
  return { message: { case: message.case, value: message.value } };
}

export type LocalExecRequestFrame =
  | { readonly kind: "welcome"; readonly providerId: string }
  | { readonly kind: "retire-approval"; readonly approvalId: string }
  | { readonly kind: "exec"; readonly requestId: string; readonly approvalId?: string; readonly serverMessage: JsonValue }
  | { readonly kind: "upload"; readonly requestId: string; readonly approvalId?: string; readonly path: string; readonly bytesBase64: string }
  | { readonly kind: "download"; readonly requestId: string; readonly approvalId?: string; readonly path: string }
  | { readonly kind: "messages-op"; readonly requestId: string; readonly approvalId?: string; readonly op: JsonValue }
  | { readonly kind: "cancel"; readonly requestId: string };

export type LocalExecResponseFrame =
  | { readonly kind: "hello"; readonly localRoot: string; readonly terminalsFolder: string; readonly computerId: string; readonly label: string; readonly supervised?: boolean; readonly variant?: string }
  | { readonly kind: "ping"; readonly supervised?: boolean }
  | { readonly kind: "client" | "control"; readonly requestId: string; readonly message: JsonValue }
  | { readonly kind: "file"; readonly requestId: string; readonly bytesBase64?: string }
  | { readonly kind: "file-error"; readonly requestId: string; readonly error: string }
  | { readonly kind: "messages-result"; readonly requestId: string; readonly result: JsonValue }
  | { readonly kind: "messages-error"; readonly requestId: string; readonly error: string };

export interface SandLocalExecProviderOptions {
  readonly resolveConnection: () => Promise<LocalExecConnection>;
  readonly executor: LocalExecExecutor;
  readonly root?: string; readonly computerId?: string; readonly computerLabel?: string; readonly maxFileBytes?: number; readonly variant?: string;
  readonly fetch?: typeof fetch;
  readonly onConnectionStale?: () => Promise<void> | void;
  readonly isSupervised?: () => Promise<boolean | undefined> | boolean | undefined;
  readonly onApprovalRetired?: (approvalId: string) => Promise<void> | void;
  readonly isLocalUseBlocked?: (request: { readonly approvalId?: string; readonly describes?: SandLocalToolRequest; readonly terminalsFolder: string }) => Promise<string | undefined> | string | undefined;
  readonly onInflightChange?: (count: number) => void;
}

export function withLocalExecAuth(headers: Record<string, string>, connection: LocalExecConnection): Record<string, string> {
  const merged = { ...headers, ...connection.headers };
  if (connection.token != null && connection.token.length > 0) merged.authorization = `${GATEWAY_AUTH_SCHEME} ${connection.token}`;
  return merged;
}
export function isSameLocalExecConnection(a: LocalExecConnection, b: LocalExecConnection): boolean { return a.baseUrl === b.baseUrl && a.token === b.token && JSON.stringify(a.headers ?? {}) === JSON.stringify(b.headers ?? {}); }

export class SandLocalExecProvider {
  readonly root: string; readonly terminalsFolder: string; readonly computerId: string; readonly computerLabel: string; readonly maxFileBytes: number; readonly maxUploadFrameBytes: number;
  private readonly fetcher: typeof fetch; private closed = false; private abortController?: AbortController; private nextExecId = 1; private readonly inflight = new Map<string, { execId: number; controller: AbortController }>();
  private readonly outbox: LocalExecResponseFrame[] = []; private flushing = false; private providerId: string | undefined;
  private readonly dataPostDeadline = createDeadlinePolicy(realClock, { name: "local-exec-data-post", timeoutMs: SAND_LOCAL_EXEC_DATA_POST_TIMEOUT_MS });
  private readonly controlPostDeadline = createDeadlinePolicy(realClock, { name: "local-exec-control-post", timeoutMs: SAND_LOCAL_EXEC_CONTROL_POST_TIMEOUT_MS });
  private readonly postRetry = createRetryPolicy(realClock, { name: "local-exec-response-post", maxAttempts: RESPONSE_POST_RETRIES, initialDelayMs: RESPONSE_POST_RETRY_DELAY_MS, maxDelayMs: RESPONSE_POST_RETRY_DELAY_MS });
  private readonly reconnectBackoff = createRetryPolicy(realClock, { name: "local-exec-sse-reconnect", maxAttempts: Number.MAX_SAFE_INTEGER, initialDelayMs: SSE_RECONNECT_MIN_MS, maxDelayMs: SSE_RECONNECT_MAX_MS });
  private readonly stallWatchdog = createIdleWatchdogPolicy(realClock, { name: "local-exec-sse-stall", idleMs: SSE_STALL_TIMEOUT_MS });
  private readonly heartbeat = createPollingPolicy(realClock, { name: "local-exec-heartbeat", intervalMs: SAND_LOCAL_EXEC_HEARTBEAT_INTERVAL_MS });

  constructor(private readonly options: SandLocalExecProviderOptions) {
    this.root = options.root ?? resolveLocalExecRoot(); this.terminalsFolder = join(this.root, "terminals");
    const host = hostname().trim(); this.computerId = options.computerId?.trim() || host || DEFAULT_SAND_COMPUTER_ID; this.computerLabel = options.computerLabel?.trim() || host || "this computer";
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_LOCAL_EXEC_FILE_BYTES; this.maxUploadFrameBytes = maxLocalExecUploadFrameBytes(this.maxFileBytes); this.fetcher = options.fetch ?? fetch;
  }
  start(): void { void this.runLoop(); }
  close(): void { this.closed = true; this.abortController?.abort(); for (const entry of this.inflight.values()) entry.controller.abort(); }
  private enqueue(frame: LocalExecResponseFrame): void { this.outbox.push(frame); void this.flush(); }
  private async postBatch(frames: readonly LocalExecResponseFrame[], deadline = this.dataPostDeadline): Promise<boolean> {
    try { return await this.postRetry.runWithRetry(async () => { const connection = await this.options.resolveConnection(); const response = await deadline.run((signal) => this.fetcher(`${connection.baseUrl}${GATEWAY_LOCAL_EXEC_RESPONSES_PATH}`, { method: "POST", headers: withLocalExecAuth({ "content-type": "application/json" }, connection), body: JSON.stringify({ providerId: this.providerId, frames }), signal })); if (!response.ok) { const failure = new Error("response POST failed") as Error & { code?: string }; failure.code = `http_${response.status}`; throw failure; } return true; }); }
    catch (error) { console.error(`[local-exec-provider] dropping ${frames.length}-frame response batch after ${RESPONSE_POST_RETRIES} failed POSTs: ${errorLogTag(error)}`); return false; }
  }
  private async flush(): Promise<void> { if (this.flushing) return; this.flushing = true; try { while (this.outbox.length > 0 && !this.closed) { const frames = this.outbox.slice(); const posted = await this.postBatch(frames); this.outbox.splice(0, frames.length); if (!posted) break; } } finally { this.flushing = false; } }
  private async runLoop(): Promise<void> { let reconnectAttempt = 1; let failures = 0; while (!this.closed) { try { await this.streamRequests(() => { reconnectAttempt = 1; failures = 0; }); } catch { failures += 1; } if (this.closed) break; if (failures >= STALE_CONNECTION_FAILURE_THRESHOLD && this.options.onConnectionStale != null) { failures = 0; try { await this.options.onConnectionStale(); } catch (error) { console.error(`[local-exec-provider] stale-connection re-resolve failed: ${errorLogTag(error)}`); } } const delay = this.reconnectBackoff.schedule(reconnectAttempt); try { await delay.elapsed; } finally { delay.dispose(); } reconnectAttempt += 1; } }
  private async dialedConnectionState(dialed: LocalExecConnection): Promise<"same" | "moved" | "unreadable"> { try { return isSameLocalExecConnection(await this.options.resolveConnection(), dialed) ? "same" : "moved"; } catch { return "unreadable"; } }
  private async currentSupervised(): Promise<boolean | undefined> { return await this.options.isSupervised?.(); }
  async streamRequests(resetBackoff: () => void = () => {}): Promise<void> {
    const connection = await this.options.resolveConnection(); const controller = new AbortController(); this.abortController = controller;
    const response = await this.fetcher(`${connection.baseUrl}${GATEWAY_LOCAL_EXEC_REQUESTS_PATH}`, { headers: withLocalExecAuth({ accept: "text/event-stream" }, connection), signal: controller.signal });
    if (!response.ok || response.body == null) throw new SandLocalExecStreamError(`local-exec requests stream failed: ${response.status}`);
    resetBackoff(); void this.currentSupervised().then((supervised) => this.postBatch([{ kind: "hello", localRoot: this.root, terminalsFolder: this.terminalsFolder, computerId: this.computerId, label: this.computerLabel, ...(supervised === undefined ? {} : { supervised }), ...(this.options.variant === undefined ? {} : { variant: this.options.variant }) }], this.controlPostDeadline));
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ""; const stall = this.stallWatchdog.arm(() => controller.abort());
    const heartbeat = this.heartbeat.start(async () => { const supervised = await this.currentSupervised(); void this.postBatch([{ kind: "ping", ...(supervised === undefined ? {} : { supervised }) }], this.controlPostDeadline); if (await this.dialedConnectionState(connection) === "moved") controller.abort(); });
    try { let dropping = false; for (;;) { const { done, value } = await reader.read(); if (done) break; stall.kick(); buffer += decoder.decode(value, { stream: true }); if (dropping) { const boundary = buffer.indexOf("\n\n"); if (boundary < 0) { buffer = buffer.slice(-1); continue; } buffer = buffer.slice(boundary + 2); dropping = false; } let separator = buffer.indexOf("\n\n"); while (separator >= 0) { if (separator > this.maxUploadFrameBytes) this.rejectOversizedFrame(buffer); else this.dispatchEventBlock(buffer.slice(0, separator)); buffer = buffer.slice(separator + 2); separator = buffer.indexOf("\n\n"); } if (buffer.length > this.maxUploadFrameBytes) { this.rejectOversizedFrame(buffer); buffer = buffer.slice(-1); dropping = true; } } }
    finally { stall.dispose(); heartbeat.dispose(); this.providerId = undefined; }
  }
  private rejectOversizedFrame(prefix: string): void { const match = /"requestId"\s*:\s*"([^"\\]+)"/.exec(prefix.slice(0, 4096)); if (match?.[1] != null) this.enqueue({ kind: "file-error", requestId: match[1], error: localExecUploadFrameTooLargeMessage(this.maxFileBytes) }); }
  private dispatchEventBlock(block: string): void { const lines = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()); if (lines.length === 0) return; try { void this.handleRequest(JSON.parse(lines.join("\n")) as LocalExecRequestFrame); } catch (error) { console.error(`[local-exec-provider] dropping unparseable request frame: ${errorLogTag(error)}`); } }
  async handleRequest(frame: LocalExecRequestFrame): Promise<void> {
    if (frame.kind === "retire-approval") { await this.options.onApprovalRetired?.(frame.approvalId); return; }
    if (frame.kind === "exec" || frame.kind === "upload" || frame.kind === "download" || frame.kind === "messages-op") { const described = this.describeFrame(frame); const blocked = await this.options.isLocalUseBlocked?.({ ...(frame.approvalId === undefined ? {} : { approvalId: frame.approvalId }), ...(described === undefined ? {} : { describes: described }), terminalsFolder: this.terminalsFolder }); if (blocked !== undefined) { this.refuse(frame.requestId, frame.kind, blocked); return; } }
    switch (frame.kind) { case "welcome": this.providerId = frame.providerId; return; case "exec": return this.handleExec(frame.requestId, frame.serverMessage); case "upload": return this.handleUpload(frame.requestId, frame.path, frame.bytesBase64); case "download": return this.handleDownload(frame.requestId, frame.path); case "messages-op": return this.handleMessagesOp(frame.requestId, frame.op); case "cancel": return this.handleCancel(frame.requestId); }
  }
  private describeFrame(frame: Extract<LocalExecRequestFrame, { kind: "exec" | "upload" | "download" | "messages-op" }>): SandLocalToolRequest | undefined { if (frame.kind === "upload") return { action: "write-file", target: frame.path }; if (frame.kind === "download") return { action: "read-file", target: frame.path, attachToResourcePath: frame.path }; if (frame.kind === "messages-op") return describeMessagesOp(frame.op); try { const decoded = this.options.executor.decodeServerMessage(frame.serverMessage); const normalized = normalizeDescribableMessage(decoded); return normalized === undefined ? undefined : describeLocalExec(normalized, this.terminalsFolder); } catch { return undefined; } }
  private refuse(requestId: string, kind: "exec" | "upload" | "download" | "messages-op", reason: string): void { if (kind === "exec") this.enqueue({ kind: "control", requestId, message: this.options.executor.throwControl(reason) }); else if (kind === "messages-op") this.enqueue({ kind: "messages-error", requestId, error: reason }); else this.enqueue({ kind: "file-error", requestId, error: reason }); }
  private async handleMessagesOp(requestId: string, op: JsonValue): Promise<void> { try { if (!isMessagesOp(op)) { this.enqueue({ kind: "messages-error", requestId, error: "Malformed Messages request." }); return; } const result = await runMessagesOp(op); if (result.ok) this.enqueue({ kind: "messages-result", requestId, result: result as unknown as JsonValue }); else this.enqueue({ kind: "messages-error", requestId, error: result.error }); } catch (error) { this.enqueue({ kind: "messages-error", requestId, error: errorMessage(error) }); } }
  private async handleExec(requestId: string, json: JsonValue): Promise<void> { let message: LocalExecDecodedMessage; try { message = this.options.executor.decodeServerMessage(json); } catch (error) { this.enqueue({ kind: "control", requestId, message: this.options.executor.throwControl(errorMessage(error)) }); return; } const execId = this.nextExecId++; message.id = execId; const controller = new AbortController(); this.inflight.set(requestId, { execId, controller }); this.options.onInflightChange?.(this.inflight.size); try { for await (const output of this.options.executor.execute(message, controller.signal)) this.enqueue({ kind: output.kind, requestId, message: output.message }); } finally { this.inflight.delete(requestId); this.options.onInflightChange?.(this.inflight.size); } }
  private handleCancel(requestId: string): void { const entry = this.inflight.get(requestId); if (entry == null) return; this.options.executor.cancel(entry.execId); entry.controller.abort(); }
  private async handleUpload(requestId: string, path: string, bytesBase64: string): Promise<void> { try { const approximate = Math.floor(bytesBase64.length * 3 / 4); if (approximate > this.maxFileBytes) { this.enqueue({ kind: "file-error", requestId, error: localExecFileTooLargeMessage(approximate, this.maxFileBytes) }); return; } const target = await containPath({ root: this.root, path }); await writeFileAtomic(target, Buffer.from(bytesBase64, "base64")); this.enqueue({ kind: "file", requestId }); } catch (error) { this.enqueue({ kind: "file-error", requestId, error: errorMessage(error) }); } }
  private async handleDownload(requestId: string, path: string): Promise<void> { try { const target = await containPath({ root: this.root, path }); const size = await regularFileSizeBytes(target); if (size !== undefined && size > this.maxFileBytes) { this.enqueue({ kind: "file-error", requestId, error: localExecFileTooLargeMessage(size, this.maxFileBytes) }); return; } const data = await readFile(target); this.enqueue({ kind: "file", requestId, bytesBase64: data.toString("base64") }); } catch (error) { this.enqueue({ kind: "file-error", requestId, error: errorMessage(error) }); } }
}
