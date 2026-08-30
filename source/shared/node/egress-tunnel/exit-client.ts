import { lookup } from "node:dns/promises";
import { createConnection, isIP, type Socket } from "node:net";

import { createRetryPolicy, realClock, type RetryPolicy } from "../../../internal/scheduling.js";
import type { EgressTunnelConfig } from "./box-connection.js";
import type { EgressTunnelStatus } from "./egress-tunnel-controller.js";

export const KIND_OPEN = 1; export const KIND_DATA = 2; export const KIND_CLOSE = 3;
export const SOCKET_HIGH_WATER_MARK = 1 << 20;
export const RECONNECT_INITIAL_DELAY_MS = 2_000; export const RECONNECT_MAX_DELAY_MS = 30_000;

export function isSharedCgnat(octets: readonly number[]): boolean { return octets[0] === 100 && (((octets[1] ?? 0) & 192) === 64); }
export function isReservedV4(octets: readonly number[]): boolean { return octets[0] === 192 && octets[1] === 0 && octets[2] === 0 || octets[0] === 198 && (((octets[1] ?? 0) & 254) === 18) || (octets[0] ?? 0) >= 240; }
export function expandV6(ip: string): number[] | null {
  let value = ip.split("%")[0]?.toLowerCase() ?? ""; let tail: number[] = [];
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (dotted?.[1] != null && dotted[2] != null) {
    const bytes = dotted[2].split(".").map((part) => Number.parseInt(part, 10)); if (bytes.some((byte) => Number.isNaN(byte) || byte < 0 || byte > 255)) return null;
    tail = [((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0), ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)]; value = dotted[1];
  }
  const halves = value.split("::"); if (halves.length > 2) return null;
  const groups = (part: string): number[] => part.split(":").filter(Boolean).map((hex) => Number.parseInt(hex, 16));
  const head = groups(halves[0] ?? ""); const back = halves.length === 2 ? groups(halves[1] ?? "") : [];
  if (head.some(Number.isNaN) || back.some(Number.isNaN)) return null;
  if (halves.length === 2) { const pad = 8 - head.length - back.length - tail.length; return pad < 0 ? null : [...head, ...Array<number>(pad).fill(0), ...back, ...tail]; }
  const all = [...head, ...tail]; return all.length === 8 ? all : null;
}
export function embeddedV4(segments: readonly number[]): number[] | null {
  const tail = (): number[] => [(segments[6] ?? 0) >> 8, (segments[6] ?? 0) & 255, (segments[7] ?? 0) >> 8, (segments[7] ?? 0) & 255];
  if (segments.slice(0, 5).every((x) => x === 0) && segments[5] === 65_535) return tail();
  if (segments[0] === 100 && segments[1] === 65_435 && segments.slice(2, 6).every((x) => x === 0)) return tail();
  if (segments.slice(0, 6).every((x) => x === 0) && !(segments[6] === 0 && (segments[7] ?? 0) <= 1)) return tail();
  return null;
}
export function isBlockedV4(octets: readonly number[]): boolean {
  const [a, b] = octets; const privateIp = a === 10 || a === 172 && (b ?? 0) >= 16 && (b ?? 0) <= 31 || a === 192 && b === 168;
  return privateIp || a === 127 || a === 169 && b === 254 || octets.every((o) => o === 255)
    || a === 192 && b === 0 && octets[2] === 2 || a === 198 && b === 51 && octets[2] === 100 || a === 203 && b === 0 && octets[2] === 113
    || octets.every((o) => o === 0) || (a ?? 0) >= 224 && (a ?? 0) <= 239 || isSharedCgnat(octets) || isReservedV4(octets);
}
export function isBlockedV6(ip: string): boolean {
  const segments = expandV6(ip); if (segments == null) return true; const embedded = embeddedV4(segments); if (embedded != null) return isBlockedV4(embedded);
  const head = segments[0] ?? 0;
  return segments.slice(0, 7).every((x) => x === 0) && segments[7] === 1 || segments.every((x) => x === 0) || (head & 65_280) === 65_280 || (head & 65_024) === 64_512 || (head & 65_472) === 65_152;
}
export function isBlockedIp(ip: string): boolean { const kind = isIP(ip); return kind === 4 ? isBlockedV4(ip.split(".").map(Number)) : kind === 6 ? isBlockedV6(ip) : true; }

export type EgressFrame = { kind: typeof KIND_OPEN; streamId: number; host: string; port: number } | { kind: typeof KIND_DATA; streamId: number; payload: Buffer } | { kind: typeof KIND_CLOSE; streamId: number };
export function decodeFrame(bytes: Buffer): EgressFrame | null {
  if (bytes.length < 5) return null; const kind = bytes[0]; const streamId = bytes.readUInt32BE(1);
  if (kind === KIND_OPEN) return bytes.length < 7 ? null : { kind, streamId, port: bytes.readUInt16BE(5), host: bytes.toString("utf8", 7) };
  if (kind === KIND_DATA) return { kind, streamId, payload: bytes.subarray(5) };
  return kind === KIND_CLOSE ? { kind, streamId } : null;
}
export function encodeData(streamId: number, payload: Buffer): Buffer { const out = Buffer.allocUnsafe(5 + payload.length); out[0] = KIND_DATA; out.writeUInt32BE(streamId >>> 0, 1); payload.copy(out, 5); return out; }
export function encodeClose(streamId: number): Buffer { const out = Buffer.allocUnsafe(5); out[0] = KIND_CLOSE; out.writeUInt32BE(streamId >>> 0, 1); return out; }
export async function resolveChecked(host: string, allowPrivate: boolean, lookupFn: typeof lookup = lookup): Promise<string | null> {
  if (isIP(host) !== 0) return allowPrivate || !isBlockedIp(host) ? host : null;
  let addresses: { address: string; family: number }[]; try { addresses = await lookupFn(host, { all: true }) as { address: string; family: number }[]; } catch { return null; }
  for (const { address } of addresses) if (allowPrivate || !isBlockedIp(address)) return address; return null;
}

export interface ExitWebSocket {
  readonly readyState: number; binaryType: string; readonly bufferedAmount: number;
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: unknown, isBinary: boolean) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: () => void): void;
  send(data: Buffer, callback?: () => void): void; close(): void; terminate(): void; removeAllListeners(): void;
}
interface StreamEntry { socket: Socket | null; pending: Buffer[]; closedByPeer: boolean }
export class EgressTunnelExitClient {
  private ws: ExitWebSocket | null = null; private readonly streams = new Map<number, StreamEntry>(); private reconnectAttempt = 0; private reconnectAbort: AbortController | null = null;
  private stopped = true; private state = "off"; private relayedStreams = 0; private lastError: string | undefined;
  private readonly reconnectPolicy: RetryPolicy;
  constructor(private readonly options: { readonly config: EgressTunnelConfig; onStatus(status: EgressTunnelStatus): void; log?(message: string): void; createWebSocket(url: string, options: { headers: Record<string, string> }): ExitWebSocket; readonly openReadyState?: number; readonly lookup?: typeof lookup; readonly createConnection?: typeof createConnection; readonly reconnectPolicy?: RetryPolicy }) {
    this.reconnectPolicy = options.reconnectPolicy ?? createRetryPolicy(realClock, { name: "sand-egress-tunnel-reconnect", maxAttempts: 1_000_000, initialDelayMs: RECONNECT_INITIAL_DELAY_MS, maxDelayMs: RECONNECT_MAX_DELAY_MS });
  }
  start(): void { if (!this.stopped) return; this.stopped = false; this.connect(); }
  stop(): void {
    this.stopped = true; this.reconnectAbort?.abort(); this.reconnectAbort = null; const ws = this.ws; this.ws = null;
    if (ws != null) { ws.removeAllListeners(); try { ws.close(); } catch { ws.terminate(); } }
    for (const entry of this.streams.values()) entry.socket?.destroy(); this.streams.clear(); this.setState("off");
  }
  getStatus(): EgressTunnelStatus { return { state: this.state, relayedStreams: this.relayedStreams, activeStreams: this.streams.size, lastError: this.lastError }; }
  private setState(state: string): void { this.state = state; this.options.onStatus(this.getStatus()); }
  private emitStatus(): void { this.options.onStatus(this.getStatus()); }
  private connect(): void {
    if (this.stopped) return; this.setState("connecting"); const ws = this.options.createWebSocket(this.options.config.url, { headers: { ...this.options.config.headers, authorization: `Bearer ${this.options.config.bearer}` } }); this.ws = ws; ws.binaryType = "nodebuffer";
    ws.on("open", () => { this.lastError = undefined; this.reconnectAttempt = 0; this.options.log?.(`egress-tunnel: attached to ${this.options.config.url}`); this.setState("connected"); });
    ws.on("message", (data, isBinary) => { if (isBinary) this.handleFrame(toBuffer(data)); });
    ws.on("error", (error) => { this.lastError = error.message; this.options.log?.(`egress-tunnel: socket error: ${error.message}`); });
    ws.on("close", () => { if (this.ws === ws) this.ws = null; for (const entry of this.streams.values()) entry.socket?.destroy(); this.streams.clear(); this.scheduleReconnect(); });
  }
  private scheduleReconnect(): void {
    if (this.stopped) { this.setState("off"); return; } this.setState("connecting"); this.options.log?.("egress-tunnel: detached; scheduling reconnect");
    const abort = new AbortController(); this.reconnectAbort = abort; const delay = this.reconnectPolicy.schedule(++this.reconnectAttempt, abort.signal);
    void delay.elapsed.then(() => { if (this.stopped || this.reconnectAbort !== abort) return; this.reconnectAbort = null; this.connect(); }, () => {});
  }
  private send(frame: Buffer): void { if (this.ws?.readyState === (this.options.openReadyState ?? 1)) this.ws.send(frame); }
  handleFrame(bytes: Buffer): void {
    const frame = decodeFrame(bytes); if (frame == null) return;
    if (frame.kind === KIND_OPEN) { void this.openStream(frame.streamId, frame.host, frame.port); return; }
    if (frame.kind === KIND_DATA) { const entry = this.streams.get(frame.streamId); if (entry?.socket != null) entry.socket.write(frame.payload); else entry?.pending.push(frame.payload); return; }
    const entry = this.streams.get(frame.streamId); if (entry == null) return; if (entry.socket != null) { this.streams.delete(frame.streamId); entry.socket.end(); } else entry.closedByPeer = true;
  }
  private async openStream(streamId: number, host: string, port: number): Promise<void> {
    if (this.streams.has(streamId)) { this.send(encodeClose(streamId)); return; }
    const entry: StreamEntry = { socket: null, pending: [], closedByPeer: false }; this.streams.set(streamId, entry);
    const address = await resolveChecked(host, this.options.config.allowPrivateTargets === true, this.options.lookup ?? lookup);
    if (address == null || this.stopped || this.streams.get(streamId) !== entry || this.ws?.readyState !== (this.options.openReadyState ?? 1)) { if (address == null) this.options.log?.(`egress-tunnel: refused stream ${streamId} (unresolvable or blocked)`); this.streams.delete(streamId); this.send(encodeClose(streamId)); return; }
    const socket = (this.options.createConnection ?? createConnection)({ host: address, port }); entry.socket = socket; this.relayedStreams += 1; this.options.log?.(`egress-tunnel: relaying stream ${streamId}`); this.emitStatus();
    socket.on("data", (chunk: Buffer) => { const ws = this.ws; if (ws?.readyState !== (this.options.openReadyState ?? 1)) return; ws.send(encodeData(streamId, chunk), () => { if (socket.isPaused() && (this.ws?.bufferedAmount ?? 0) <= SOCKET_HIGH_WATER_MARK) socket.resume(); }); if (ws.bufferedAmount > SOCKET_HIGH_WATER_MARK) socket.pause(); });
    socket.on("error", () => this.teardownStream(streamId, socket)); socket.on("close", () => this.teardownStream(streamId, socket));
    for (const chunk of entry.pending) socket.write(chunk); entry.pending = []; if (entry.closedByPeer) socket.end();
  }
  private teardownStream(streamId: number, socket: Socket): void { const entry = this.streams.get(streamId); if (entry?.socket !== socket) return; this.streams.delete(streamId); socket.destroy(); this.send(encodeClose(streamId)); this.emitStatus(); }
}
export function toBuffer(data: unknown): Buffer { if (Buffer.isBuffer(data)) return data; if (Array.isArray(data)) return Buffer.concat(data as Uint8Array[]); return Buffer.from(data as ArrayBuffer); }
