import { hostname, platform } from "node:os";
import { ExportResultCode } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  type SpanExporter as OTelSpanExporter,
} from "@opentelemetry/sdk-trace-node";
import { errorLogTag } from "../../../shared/errors.js";
import { SAND_CLIENT_TYPE } from "../../../shared/node/sand-client-metadata.js";
import { createSendTraceSampler } from "./send-trace-sampler.js";
export { ExportResultCode };
export type SpanExporter = OTelSpanExporter;
export type SpanExporterFactory = (options: {
  url: string;
  headers: Record<string, string>;
  httpAgentOptions?: { rejectUnauthorized: boolean };
}) => SpanExporter;
export class TokenRefreshingSpanExporter implements SpanExporter {
  private delegate: SpanExporter | undefined;
  private delegateToken: string | undefined;
  constructor(
    readonly url: string,
    readonly getToken: () => string | null,
    readonly baseHeaders: Record<string, string>,
    readonly insecure = false,
    private readonly createExporter: SpanExporterFactory = ({
      url,
      headers,
      httpAgentOptions,
    }) => new OTLPTraceExporter({
      url,
      headers,
      ...(httpAgentOptions === undefined ? {} : { httpAgentOptions }),
    }),
  ) {}
  resolveDelegate(): SpanExporter | undefined {
    let token: string | null;
    try {
      token = this.getToken();
    } catch {
      token = null;
    }
    if (token == null || token.length === 0) return this.delegate;
    if (this.delegate === undefined || token !== this.delegateToken) {
      const previous = this.delegate;
      this.delegate = this.createExporter({
        url: this.url,
        headers: { ...this.baseHeaders, authorization: `Bearer ${token}` },
        ...(this.insecure
          ? { httpAgentOptions: { rejectUnauthorized: false } }
          : {}),
      });
      this.delegateToken = token;
      if (previous !== undefined)
        void previous
          .shutdown()
          .catch((error) =>
            console.warn(
              `[sand-tracing] replaced exporter shutdown failed (${errorLogTag(error)})`,
            ),
          );
    }
    return this.delegate;
  }
  export(
    spans: Parameters<SpanExporter["export"]>[0],
    resultCallback: Parameters<SpanExporter["export"]>[1],
  ): void {
    let delegate: SpanExporter | undefined;
    try {
      delegate = this.resolveDelegate();
    } catch {
      delegate = undefined;
    }
    if (delegate === undefined) {
      resultCallback({ code: ExportResultCode.FAILED });
      return;
    }
    try {
      delegate.export(spans, resultCallback);
    } catch {
      resultCallback({ code: ExportResultCode.FAILED });
    }
  }
  async shutdown(): Promise<void> {
    try {
      await this.delegate?.shutdown();
    } catch {}
  }
  async forceFlush(): Promise<void> {
    try {
      await this.delegate?.forceFlush?.();
    } catch {}
  }
}
export interface HostTracing {
  flush(): void;
  dispose(): Promise<void>;
}
export const NOOP_HOST_TRACING: HostTracing = {
  flush: () => {},
  dispose: async () => {},
};
let initialized = false,
  hostTracing: HostTracing | undefined;
export function resetHostTracingForTests(): void {
  initialized = false;
  hostTracing = undefined;
}
export function initSandHostTracing(options: {
  backendUrl: string;
  getToken(): string | null;
  serviceVersion?: string;
  insecure?: boolean;
  createExporter?: SpanExporterFactory;
  createProvider?: (config: {
    exporter: SpanExporter;
    resource: Record<string, string>;
    sampler: ReturnType<typeof createSendTraceSampler>;
  }) => {
    register(): void;
    forceFlush(): Promise<void>;
    shutdown(): Promise<void>;
  };
}): HostTracing {
  if (initialized) return hostTracing ?? NOOP_HOST_TRACING;
  try {
    const exporter = new TokenRefreshingSpanExporter(
      `${options.backendUrl.replace(/\/+$/, "")}/v1/traces`,
      options.getToken,
      {
        "x-ghost-mode": "false",
        "x-cursor-client-type": SAND_CLIENT_TYPE,
        "x-cursor-client-version": "sand-host",
      },
      options.insecure ?? false,
      options.createExporter,
    );
    const resource = {
      "service.name": "sand-host",
      "service.version": options.serviceVersion ?? "unknown",
      "host.name": hostname(),
      "os.type": platform(),
      "process.runtime.name": "node",
      "process.runtime.version": process.version,
      "deployment.environment": "box",
    };
    const sampler = createSendTraceSampler();
    const provider = options.createProvider?.({ exporter, resource, sampler }) ?? (() => {
      const nodeProvider = new NodeTracerProvider({
        resource: resourceFromAttributes(resource),
        sampler,
        spanProcessors: [new BatchSpanProcessor(exporter)],
      });
      return {
        register: () => nodeProvider.register(),
        forceFlush: () => nodeProvider.forceFlush(),
        shutdown: () => nodeProvider.shutdown(),
      };
    })();
    if (provider === undefined) return NOOP_HOST_TRACING;
    provider.register();
    let disposed = false;
    const shutdown = () => {
      void tracing.dispose();
    };
    const tracing: HostTracing = {
      flush: () => {
        try {
          void provider
            .forceFlush()
            .catch((error) =>
              console.warn(
                `[sand-tracing] span flush failed (${errorLogTag(error)})`,
              ),
            );
        } catch {}
      },
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        process.off("SIGTERM", shutdown);
        process.off("SIGINT", shutdown);
        process.off("beforeExit", shutdown);
        try {
          await provider.shutdown();
        } catch {}
      },
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    process.once("beforeExit", shutdown);
    hostTracing = tracing;
    initialized = true;
    return tracing;
  } catch {
    return NOOP_HOST_TRACING;
  }
}
