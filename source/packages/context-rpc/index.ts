import type { ServiceType } from "@bufbuild/protobuf";
import {
  createClient,
  createContextKey,
  createContextValues,
  type CallOptions,
  type Client,
  type Transport,
} from "@connectrpc/connect";
import { SpanKind, SpanStatusCode, type Span } from "@opentelemetry/api";
import type { Context } from "../context/core.js";
import { getSpan, withSpan } from "../context/otel.js";

export type ContextPropagatingClient<Service extends ServiceType> = {
  [Method in keyof Client<Service>]: Client<Service>[Method] extends (
    ...args: infer Args
  ) => infer Result
    ? (ctx: Context, ...args: Args) => Result
    : Client<Service>[Method];
};

export interface ContextPropagationOptions {
  readonly injectTraceHeaders?: boolean;
  readonly extractHeaders?: (ctx: Context) => HeadersInit | undefined;
  readonly enableAbortSignal?: boolean;
}

const callerContextKey = createContextKey<Context | undefined>(undefined, {
  description: "anysphere.callerContext",
});

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value !== null && typeof value === "object" && Symbol.asyncIterator in value;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value !== null
    && typeof value === "object"
    && "then" in value
    && typeof value.then === "function";
}

function wrapAsyncIterableWithSpan<T>(
  iterable: AsyncIterable<T>,
  span: Span | undefined,
  cleanupSignalListener?: () => void,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = iterable[Symbol.asyncIterator]();
      let finished = false;
      const finish = (error?: unknown): void => {
        if (finished) return;
        finished = true;
        if (error) {
          span?.recordException(error instanceof Error ? error : new Error(String(error)));
          span?.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : "Stream failed",
          });
        } else {
          span?.setStatus({ code: SpanStatusCode.OK });
        }
        span?.end();
        cleanupSignalListener?.();
      };
      return {
        async next() {
          try {
            const result = await iterator.next();
            if (result.done) finish();
            return result;
          } catch (error) {
            finish(error);
            throw error;
          }
        },
        async return(value?: T) {
          finish();
          if (iterator.return) return await iterator.return(value);
          return { done: true, value: undefined };
        },
        async throw(error?: unknown) {
          finish(error);
          if (iterator.throw) return await iterator.throw(error);
          throw error;
        },
      };
    },
  };
}

function extractTraceHeaders(ctx: Context): Headers {
  const headers = new Headers();
  try {
    const spanContext = getSpan(ctx)?.spanContext?.();
    if (spanContext?.traceId && spanContext.spanId) {
      const traceFlags = spanContext.traceFlags ?? 0;
      const headerValue = `00-${spanContext.traceId}-${spanContext.spanId}-${traceFlags.toString(16).padStart(2, "0")}`;
      headers.set("traceparent", headerValue);
      headers.set("backend-traceparent", headerValue);
      if (spanContext.traceState) {
        const traceState = spanContext.traceState as typeof spanContext.traceState & {
          serialize?: () => string;
        };
        headers.set(
          "tracestate",
          typeof traceState.serialize === "function"
            ? traceState.serialize()
            : String(traceState),
        );
      }
    }
  } catch {}
  return headers;
}

function mergeHeaders(...sources: (HeadersInit | undefined)[]): Headers {
  const merged = new Headers();
  for (const source of sources) {
    if (!source) continue;
    if (source instanceof Headers) {
      source.forEach((value, key) => merged.set(key, value));
    } else {
      for (const [key, value] of Object.entries(source)) {
        merged.set(key, value as string);
      }
    }
  }
  return merged;
}

function mergeContextSignal(
  ctxSignal: AbortSignal,
  providedSignal?: AbortSignal,
): { signal: AbortSignal; cleanup?: () => void } {
  if (providedSignal === undefined || providedSignal === ctxSignal) {
    return { signal: ctxSignal };
  }
  const controller = new AbortController();
  const abortFromContext = () => controller.abort(ctxSignal.reason);
  const abortFromProvided = () => controller.abort(providedSignal.reason);
  ctxSignal.addEventListener("abort", abortFromContext, { once: true });
  providedSignal.addEventListener("abort", abortFromProvided, { once: true });
  if (ctxSignal.aborted) abortFromContext();
  else if (providedSignal.aborted) abortFromProvided();
  return {
    signal: controller.signal,
    cleanup() {
      ctxSignal.removeEventListener("abort", abortFromContext);
      providedSignal.removeEventListener("abort", abortFromProvided);
    },
  };
}

function addContextPropagation<Service extends ServiceType>(
  client: Client<Service>,
  options: ContextPropagationOptions,
): ContextPropagatingClient<Service> {
  const { injectTraceHeaders = true, extractHeaders } = options;
  return new Proxy(client, {
    get(target, property) {
      const original: unknown = Reflect.get(target, property);
      if (typeof original !== "function") return original;
      return (ctx: Context, input: unknown, callOptions: CallOptions = {}) => {
        const spanCtx = withSpan(ctx.withName(`rpc.${String(property)}`), {
          kind: SpanKind.CLIENT,
          attributes: {
            "rpc.method": String(property),
            "rpc.system": "connect",
          },
        });
        const span = getSpan(spanCtx);
        let cleanupSignalListener: (() => void) | undefined;
        try {
          let contextHeaders: Headers | undefined;
          if (injectTraceHeaders) contextHeaders = extractTraceHeaders(spanCtx);
          if (extractHeaders) {
            const extra = extractHeaders(spanCtx);
            if (extra) contextHeaders = mergeHeaders(contextHeaders, extra);
          }
          const finalHeaders = mergeHeaders(callOptions.headers, contextHeaders);
          const { signal, cleanup } = options.enableAbortSignal === true
            ? mergeContextSignal(spanCtx.signal, callOptions.signal)
            : { signal: callOptions.signal, cleanup: undefined };
          cleanupSignalListener = cleanup;
          const contextValues = (callOptions.contextValues ?? createContextValues())
            .set(callerContextKey, spanCtx);
          const enhancedOptions: CallOptions = {
            ...callOptions,
            headers: finalHeaders,
            signal: signal!,
            contextValues,
          };
          const result: unknown = (original as (
            input: unknown,
            options: CallOptions,
          ) => unknown).call(target, input, enhancedOptions);
          if (isAsyncIterable(result)) {
            return wrapAsyncIterableWithSpan(result, span, cleanupSignalListener);
          }
          if (isPromiseLike(result)) {
            return (result as Promise<unknown>).then((response) => {
              if (isAsyncIterable(response)) {
                return wrapAsyncIterableWithSpan(response, span, cleanupSignalListener);
              }
              span?.setStatus({ code: SpanStatusCode.OK });
              span?.end();
              cleanupSignalListener?.();
              return response;
            }).catch((error: unknown) => {
              span?.recordException(error instanceof Error ? error : new Error(String(error)));
              span?.setStatus({
                code: SpanStatusCode.ERROR,
                message: error instanceof Error ? error.message : "RPC call failed",
              });
              span?.end();
              cleanupSignalListener?.();
              throw error;
            });
          }
          span?.setStatus({ code: SpanStatusCode.OK });
          span?.end();
          cleanupSignalListener?.();
          return result;
        } catch (error) {
          span?.recordException(error instanceof Error ? error : new Error(String(error)));
          span?.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : "RPC call failed",
          });
          span?.end();
          cleanupSignalListener?.();
          throw error;
        }
      };
    },
  }) as ContextPropagatingClient<Service>;
}

export function createContextPropagatingClient<Service extends ServiceType>(
  service: Service,
  transport: Transport,
  options: ContextPropagationOptions = {},
): ContextPropagatingClient<Service> {
  return addContextPropagation(createClient(service, transport), options);
}
