import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { ExportResultCode } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  BatchSpanProcessor,
  NodeTracerProvider,
  ParentBasedSampler,
  RandomIdGenerator,
  type Sampler,
  type SpanExporter as OTelSpanExporter,
} from "@opentelemetry/sdk-trace-node";
import { parseTraceparent } from "../../shared/observability/send-trace.js";
import { SAND_CLIENT_TYPE } from "../../shared/node/sand-client-metadata.js";

export const EXPORT_RESULT_SUCCESS = ExportResultCode.SUCCESS;
export const EXPORT_RESULT_FAILED = ExportResultCode.FAILED;
export type ExportResult = { readonly code: number };
export type SpanExporter = OTelSpanExporter;
export interface SpanLike { setStatus(status: { readonly code: SpanStatusCode; readonly message?: string }): void; end(endTime: Date): void }
export interface TracerLike { startSpan(name: string, options: { readonly kind: SpanKind; readonly startTime: Date; readonly attributes?: Readonly<Record<string, string | number | boolean>> }, parent?: unknown): SpanLike }
export interface IdGenerator { generateTraceId(): string; generateSpanId(): string }
export interface DesktopSendTracingOptions {
  readonly backendUrl: string;
  readonly appVersion?: string;
  readonly getAccessToken: (request: { readonly backendUrl: string }) => Promise<string>;
  readonly makeExporter?: (options: { readonly url: string; readonly headers: Readonly<Record<string, string>> }) => SpanExporter;
  readonly createTracer?: (options: { readonly instrumentationName: string; readonly rootSampler: unknown; readonly idGenerator: IdGenerator; readonly resource: Readonly<Record<string, string>>; readonly exporter: SpanExporter }) => { readonly tracer: TracerLike; readonly shutdown: () => Promise<void> };
  readonly onEdgeFailure?: (area: "send-trace", leg: "delegate-shutdown" | "shutdown" | "force-flush" | "gateway-span" | "send-span", error: unknown) => void;
}

export class AsyncTokenSpanExporter implements SpanExporter {
  private delegate: SpanExporter | undefined;
  private delegateToken: string | undefined;
  constructor(private readonly url: string, private readonly getToken: () => Promise<string>, private readonly makeExporter: DesktopSendTracingOptions["makeExporter"], private readonly onFailure?: DesktopSendTracingOptions["onEdgeFailure"]) {}
  export(spans: Parameters<SpanExporter["export"]>[0], callback: (result: ExportResult) => void): void { void (async () => { let token: string; try { token = await this.getToken(); } catch { token = ""; } if (token.length === 0) { callback({ code: EXPORT_RESULT_FAILED }); return; } try { if (this.delegate === undefined || token !== this.delegateToken) { const previous = this.delegate; const headers = { "x-ghost-mode": "false", "x-cursor-client-type": SAND_CLIENT_TYPE, "x-cursor-client-version": "sand-desktop", authorization: `Bearer ${token}` }; this.delegate = this.makeExporter?.({ url: this.url, headers }) ?? new OTLPTraceExporter({ url: this.url, headers }); this.delegateToken = token; if (previous !== undefined) void previous.shutdown().catch((error: unknown) => this.onFailure?.("send-trace", "delegate-shutdown", error)); } this.delegate.export(spans, callback); } catch { callback({ code: EXPORT_RESULT_FAILED }); } })(); }
  async shutdown(): Promise<void> { try { await this.delegate?.shutdown(); } catch (error) { this.onFailure?.("send-trace", "shutdown", error); } }
  async forceFlush(): Promise<void> { try { await this.delegate?.forceFlush?.(); } catch (error) { this.onFailure?.("send-trace", "force-flush", error); } }
}

const randomIdGenerator: IdGenerator = new RandomIdGenerator();
let presetNextSpanId: string | undefined;
const presetCapableIdGenerator: IdGenerator = { generateTraceId: () => randomIdGenerator.generateTraceId(), generateSpanId: () => { if (presetNextSpanId !== undefined) { const id = presetNextSpanId; presetNextSpanId = undefined; return id; } return randomIdGenerator.generateSpanId(); } };
let configuredOptions: DesktopSendTracingOptions | undefined;
let sendState: { tracer: TracerLike; shutdown: () => Promise<void> } | undefined;
let rpcState: { tracer: TracerLike; shutdown: () => Promise<void> } | undefined;
let shutdownHookRegistered = false;

export function resetDesktopSendTracingForTests(): void { process.removeListener("beforeExit", shutdownProviders); configuredOptions = undefined; sendState = undefined; rpcState = undefined; presetNextSpanId = undefined; shutdownHookRegistered = false; }
function shutdownProviders(): void { void Promise.allSettled([sendState?.shutdown(), rpcState?.shutdown()]); }
export function configureDesktopSendTracing(options: DesktopSendTracingOptions): void { configuredOptions = options; }

function createTracer(options: DesktopSendTracingOptions, rootSampler: unknown, instrumentationName: string, idGenerator: IdGenerator) {
  try {
    const url = `${options.backendUrl.replace(/\/+$/, "")}/v1/traces`;
    const exporter = new AsyncTokenSpanExporter(url, () => options.getAccessToken({ backendUrl: options.backendUrl }), options.makeExporter, options.onEdgeFailure);
    const resource = { "service.name": "sand-desktop", "service.version": options.appVersion ?? "unknown", "os.type": process.platform, "process.runtime.name": "node", "process.runtime.version": process.version, "deployment.environment": "desktop" };
    const state = options.createTracer?.({ instrumentationName, rootSampler, idGenerator, exporter, resource }) ?? (() => {
      const sampler: Sampler = rootSampler === "always-on" ? new AlwaysOnSampler() : rootSampler === "always-off" ? new AlwaysOffSampler() : rootSampler as Sampler;
      const provider = new NodeTracerProvider({ resource: resourceFromAttributes(resource), sampler: new ParentBasedSampler({ root: sampler }), idGenerator, spanProcessors: [new BatchSpanProcessor(exporter)] });
      return { tracer: provider.getTracer(instrumentationName) as unknown as TracerLike, shutdown: () => provider.shutdown() };
    })();
    if (!shutdownHookRegistered) { shutdownHookRegistered = true; process.once("beforeExit", shutdownProviders); }
    return state;
  } catch { return undefined; }
}
export function getDesktopRpcTracer(rootSampler: unknown): TracerLike | undefined { if (configuredOptions === undefined) return undefined; rpcState ??= createTracer(configuredOptions, rootSampler, "sand-desktop-rpc", randomIdGenerator); return rpcState?.tracer; }
function ensureSendTracer(options: DesktopSendTracingOptions): TracerLike | undefined { sendState ??= createTracer(options, "always-off", "sand-desktop-send", presetCapableIdGenerator); return sendState?.tracer; }
function parentFrom(traceparent: unknown) { const parsed = parseTraceparent(traceparent); return parsed === undefined ? undefined : trace.setSpanContext(context.active(), { ...parsed, isRemote: true }); }

export interface SendStageSpan { readonly name: string; readonly traceparent: string; readonly clientNonce?: string; readonly startEpochMs: number; readonly durationMs: number; readonly attributes: Readonly<Record<string, string | number | boolean>>; readonly isError?: boolean }
export function recordSendStageSpan(stage: SendStageSpan): void { try { const parent = parentFrom(stage.traceparent); if (parent === undefined || configuredOptions === undefined) return; const tracer = ensureSendTracer(configuredOptions); if (tracer === undefined) return; const duration = Math.max(0, Math.round(stage.durationMs)); const span = tracer.startSpan(stage.name, { kind: SpanKind.INTERNAL, startTime: new Date(stage.startEpochMs), attributes: { ...(stage.clientNonce !== undefined && stage.clientNonce.length > 0 ? { "sand.client_nonce": stage.clientNonce } : {}), ...stage.attributes } }, parent); if (stage.isError === true) span.setStatus({ code: SpanStatusCode.ERROR }); span.end(new Date(stage.startEpochMs + duration)); } catch (error) { configuredOptions?.onEdgeFailure?.("send-trace", "gateway-span", error); } }

const CLIENT_SPAN_ID = /^[0-9a-f]{16}$/;
const ZERO_CLIENT_SPAN_ID = "0".repeat(16);
export interface GatewayCommandSpanReport { readonly rootTraceparent: string; readonly spanId: string; readonly method: string; readonly startEpochMs: number; readonly durationMs: number; readonly isError: boolean }
export function recordGatewayCommandSpan(report: GatewayCommandSpanReport): void { const parent = parentFrom(report.rootTraceparent); if (parent === undefined || !CLIENT_SPAN_ID.test(report.spanId) || report.spanId === ZERO_CLIENT_SPAN_ID || configuredOptions === undefined) return; const tracer = ensureSendTracer(configuredOptions); if (tracer === undefined) return; presetNextSpanId = report.spanId; try { const span = tracer.startSpan(`sand.gateway_post.${report.method}`, { kind: SpanKind.CLIENT, startTime: new Date(report.startEpochMs) }, parent); if (report.isError) span.setStatus({ code: SpanStatusCode.ERROR }); span.end(new Date(report.startEpochMs + Math.max(0, Math.round(report.durationMs)))); } finally { presetNextSpanId = undefined; } }

export interface SendAckSpanReport { readonly traceparent: string; readonly enterEpochMs: number; readonly ackMs: number; readonly outcome: string; readonly isFork: boolean; readonly attachmentCount: number; readonly clientNonce?: string; readonly conversationId?: string; readonly commitOffsetMs?: number; readonly commitMs?: number }
export function recordSendAckSpan(report: SendAckSpanReport, options?: DesktopSendTracingOptions): void { const resolved = options ?? configuredOptions; try { const parent = parentFrom(report.traceparent); if (parent === undefined || resolved === undefined) return; const tracer = ensureSendTracer(resolved); if (tracer === undefined) return; const span = tracer.startSpan("sand.send.ack", { kind: SpanKind.INTERNAL, startTime: new Date(report.enterEpochMs), attributes: { "sand.ack_ms": Math.round(report.ackMs), "sand.ack_outcome": report.outcome, "sand.is_fork": report.isFork, "sand.attachment_count": report.attachmentCount, ...(report.clientNonce !== undefined && report.clientNonce.length > 0 ? { "sand.client_nonce": report.clientNonce } : {}), ...(report.conversationId === undefined ? {} : { "sand.conversation_id": report.conversationId }) } }, parent); if (report.outcome === "failed" || report.outcome === "timeout") span.setStatus({ code: SpanStatusCode.ERROR, message: report.outcome }); span.end(new Date(report.enterEpochMs + Math.round(report.ackMs))); if (report.commitOffsetMs !== undefined && report.commitMs !== undefined) recordSendStageSpan({ name: "commit-attachments", traceparent: report.traceparent, ...(report.clientNonce === undefined ? {} : { clientNonce: report.clientNonce }), startEpochMs: report.enterEpochMs + Math.round(report.commitOffsetMs), durationMs: report.commitMs, attributes: { "sand.attachment_count": report.attachmentCount } }); } catch (error) { resolved?.onEdgeFailure?.("send-trace", "send-span", error); } }
