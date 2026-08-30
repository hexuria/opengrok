import { createKey, type Context } from "../context/core.js";

export type MetricType = "counter" | "gauge" | "histogram";
export interface MetricHandle { name: string; type: MetricType; description?: string; labelNames?: readonly string[] }
export type MetricLabels = Readonly<Record<string, string>>;
export interface MetricsBackend {
  record(context: Context, handle: MetricHandle, value: number, labels?: MetricLabels): void;
  increment(context: Context, handle: MetricHandle, value: number, labels?: MetricLabels): void;
  gauge(context: Context, handle: MetricHandle, value: number, labels?: MetricLabels): void;
  histogram(context: Context, handle: MetricHandle, value: number, labels?: MetricLabels): void;
}

const defaultMetricsBackend: MetricsBackend = { record() {}, increment() {}, gauge() {}, histogram() {} };
export const metricsKey = createKey(Symbol("metricsBackend"), defaultMetricsBackend);
export const getMetricsBackend = (context: Context): MetricsBackend => context.get(metricsKey);

function handle(name: string, type: MetricType, options?: { description?: string; labelNames?: readonly string[] }): MetricHandle {
  // The shipped runtime keeps both optional keys even when their values are undefined.
  // These assertions erase only the type-level undefined while preserving that object shape.
  return { name, type, description: options?.description as string, labelNames: options?.labelNames as readonly string[] };
}

export function createCounter(name: string, options?: { description?: string; labelNames?: readonly string[] }) {
  const metric = handle(name, "counter", options);
  return {
    increment: (context: Context, value = 1, labels?: MetricLabels): void => getMetricsBackend(context).increment(context, metric, value, labels),
    record: (context: Context, value: number, labels?: MetricLabels): void => getMetricsBackend(context).record(context, metric, value, labels),
  };
}

export function createGauge(name: string, options?: { description?: string; labelNames?: readonly string[] }) {
  const metric = handle(name, "gauge", options);
  return {
    gauge: (context: Context, value: number, labels?: MetricLabels): void => getMetricsBackend(context).gauge(context, metric, value, labels),
    record: (context: Context, value: number, labels?: MetricLabels): void => getMetricsBackend(context).record(context, metric, value, labels),
  };
}

export function createHistogram(name: string, options?: { description?: string; labelNames?: readonly string[] }) {
  const metric = handle(name, "histogram", options);
  return {
    histogram: (context: Context, value: number, labels?: MetricLabels): void => getMetricsBackend(context).histogram(context, metric, value, labels),
    record: (context: Context, value: number, labels?: MetricLabels): void => getMetricsBackend(context).record(context, metric, value, labels),
  };
}
