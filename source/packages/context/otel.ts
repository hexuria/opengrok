import {
  SpanKind,
  context,
  trace,
  type AttributeValue,
  type Span,
  type SpanContext,
  type SpanOptions,
  type TimeInput,
  type Tracer,
} from "@opentelemetry/api";
import { createContext, createKey, type Context } from "./core.js";

interface SerializableSpanContext {
  traceId: string;
  spanId: string;
  traceFlags: number;
  traceState?: string;
}

const SPAN_KEY = createKey<Span | undefined>(Symbol("otel.span"), undefined);
const ROOT_SPAN_KEY = createKey<Span | undefined>(Symbol("otel.root_span"), undefined);
const ROOT_SPAN_START_MS_KEY = createKey<number | undefined>(Symbol("otel.root_start_ms"), undefined);
const SUPPRESS_CHILD_SPANS_KEY = createKey(Symbol("otel.suppress_child_spans"), false);
export const INHERITABLE_SPAN_ATTRIBUTES_KEY = createKey<Record<string, AttributeValue>>(
  Symbol("otel.inheritable_span_attributes"),
  {},
);

export function getTracer(name = "context-tracer"): Tracer {
  return trace.getTracer(name);
}

export function withSpan(ctx: Context, options?: SpanOptions): Context {
  const tracer = getTracer();
  const parentSpan = ctx.get(SPAN_KEY);
  if (ctx.get(SUPPRESS_CHILD_SPANS_KEY) && parentSpan) return ctx;

  const spanName = ctx.name || "anonymous-context";
  const span = parentSpan
    ? tracer.startSpan(spanName, options, trace.setSpan(context.active(), parentSpan))
    : tracer.startSpan(spanName, options);

  const inherited = ctx.get(INHERITABLE_SPAN_ATTRIBUTES_KEY);
  for (const key in inherited) span.setAttribute(key, inherited[key]!);

  const startMs = Date.now();
  let ctxWith = ctx.with(SPAN_KEY, span);
  if (!parentSpan) ctxWith = ctxWith.with(ROOT_SPAN_KEY, span).with(ROOT_SPAN_START_MS_KEY, startMs);
  return ctxWith;
}

export function getSpan(ctx: Context): Span | undefined {
  return ctx.get(SPAN_KEY);
}

export function withSuppressedChildSpans(ctx: Context): Context {
  return ctx.with(SUPPRESS_CHILD_SPANS_KEY, true);
}

export function withInheritableAttribute(ctx: Context, key: string, value: AttributeValue): Context {
  const existing = ctx.get(INHERITABLE_SPAN_ATTRIBUTES_KEY);
  const span = getSpan(ctx);
  if (span) span.setAttribute(key, value);
  return ctx.with(INHERITABLE_SPAN_ATTRIBUTES_KEY, { ...existing, [key]: value });
}

export function getSpanContextData(ctx: Context): SerializableSpanContext | undefined {
  try {
    const span = getSpan(ctx);
    if (!span) return undefined;
    const spanContext = span.spanContext();
    return {
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
      traceFlags: ctx.get(SUPPRESS_CHILD_SPANS_KEY) ? 0 : spanContext.traceFlags,
      traceState: spanContext.traceState?.toString()!,
    };
  } catch {
    return undefined;
  }
}

type RemoteSpanContext = Pick<SpanContext, "traceId" | "spanId" | "traceFlags">;

export function createContextFromSpanContext(
  spanContext: RemoteSpanContext,
  name?: string,
  existingContext?: Context,
): Context {
  const tracer = getTracer();
  const remoteSpanContext: SpanContext = { ...spanContext, isRemote: true };
  const otelContext = trace.setSpanContext(context.active(), remoteSpanContext);
  const span = tracer.startSpan(name || "child.span", { kind: SpanKind.INTERNAL }, otelContext);
  const parentContext = existingContext ?? createContext();
  const ctx = name ? parentContext.withName(name) : parentContext;
  return ctx.with(SPAN_KEY, span);
}

export function createContextFromRemoteSpanContext(
  spanContext: RemoteSpanContext,
  name?: string,
  existingContext?: Context,
): Context {
  const span = trace.wrapSpanContext({ ...spanContext, isRemote: true });
  const parentContext = existingContext ?? createContext();
  const ctx = name ? parentContext.withName(name) : parentContext;
  return ctx.with(SPAN_KEY, span);
}

export class DisposableSpan implements Disposable {
  constructor(
    readonly ctx: Context,
    readonly span: Span,
    private readonly shouldEnd = true,
  ) {}

  [Symbol.dispose](): void {
    if (this.shouldEnd) this.span.end();
  }
}

export function createSpan(ctx: Context, options?: SpanOptions): DisposableSpan {
  const parentSpan = getSpan(ctx);
  const isSuppressed = ctx.get(SUPPRESS_CHILD_SPANS_KEY) && parentSpan;
  const ctxWithSpan = withSpan(ctx, options);
  return new DisposableSpan(ctxWithSpan, getSpan(ctxWithSpan)!, !isSuppressed);
}

export function recordCompletedSpanIfParented(
  ctx: Context,
  options?: SpanOptions,
  endTime?: TimeInput,
): Span | undefined {
  if (!getSpan(ctx) || ctx.get(SUPPRESS_CHILD_SPANS_KEY)) return undefined;
  const ctxWithSpan = withSpan(ctx, options);
  const span = getSpan(ctxWithSpan)!;
  span.end(endTime);
  return span;
}

export function reportEvent(ctx: Context, name: string): void {
  try {
    const tracer = getTracer();
    const parentSpan = getSpan(ctx);
    if (!parentSpan) return;
    const parentContext = trace.setSpan(context.active(), parentSpan);
    const eventSpan = tracer.startSpan(name, undefined, parentContext);
    const inherited = ctx.get(INHERITABLE_SPAN_ATTRIBUTES_KEY);
    for (const key in inherited) eventSpan.setAttribute(key, inherited[key]!);
    const now = Date.now();
    const rootStart = ctx.get(ROOT_SPAN_START_MS_KEY);
    const delta = typeof rootStart === "number" ? now - rootStart : 0;
    const attributeKey = `event.${name}`;
    const rootSpan = ctx.get(ROOT_SPAN_KEY) ?? parentSpan;
    rootSpan.setAttribute(attributeKey, delta);
    eventSpan.setAttribute(attributeKey, delta);
    eventSpan.end();
  } catch {}
}
