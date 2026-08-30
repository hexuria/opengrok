import type { IdleWatchdogPolicy, RetryPolicy } from "../../../internal/scheduling.js";
import { getSandBackendClientHeaders } from "../../../shared/node/sand-client-metadata.js";

export const SAND_NOTIFY_TOPIC_FLAGS = { "automation-fires": true, "listener-events": true, "xuser-events": true } as const;
export type SandNotifyTopic = keyof typeof SAND_NOTIFY_TOPIC_FLAGS;
export const SAND_NOTIFY_TOPICS = Object.keys(SAND_NOTIFY_TOPIC_FLAGS) as SandNotifyTopic[];
export const HEALTHY_CONNECTION_MIN_LIFETIME_MS = 30_000;

export function isSandNotifyTopic(value: unknown): value is SandNotifyTopic {
  return typeof value === "string" && SAND_NOTIFY_TOPICS.includes(value as SandNotifyTopic);
}

export class SandNotifyStreamError extends Error {
  constructor(readonly status: number) { super(`sand notify stream failed: ${status}`); this.name = "SandNotifyStreamError"; }
}

export type SandNotifyFrame = { readonly kind: "connected" } | { readonly kind: "notify"; readonly topic: SandNotifyTopic } | { readonly kind: "ignored" };

export function parseNotifyFrame(frame: string): SandNotifyFrame {
  let dataRaw: string | null = null;
  for (const line of frame.split("\n")) if (line.startsWith("data: ")) dataRaw = line.slice("data: ".length);
  if (dataRaw == null) return { kind: "ignored" };
  let payload: unknown;
  try { payload = JSON.parse(dataRaw) as unknown; } catch { return { kind: "ignored" }; }
  if (typeof payload !== "object" || payload == null || Array.isArray(payload)) return { kind: "ignored" };
  const record = payload as Record<string, unknown>;
  if (record.kind === "connected") return { kind: "connected" };
  if (record.kind === "notify" && isSandNotifyTopic(record.topic)) return { kind: "notify", topic: record.topic };
  return { kind: "ignored" };
}

export class SandNotifyBusClient {
  private readonly fetchImpl: typeof fetch;
  private stopController: AbortController | null = null;
  private streamController: AbortController | null = null;
  private connectedAtMs: number | null = null;

  constructor(private readonly deps: {
    readonly getBackendUrl: () => string;
    readonly getAccessToken: (options: { readonly backendUrl: string }) => Promise<string>;
    readonly onConnected: () => void;
    readonly onNotify: (topic: SandNotifyTopic) => void;
    readonly onStreamError: (error: unknown) => void;
    readonly reconnectBackoff: RetryPolicy;
    readonly stallWatchdog: IdleWatchdogPolicy;
    readonly fetchImpl?: typeof fetch;
    readonly now?: () => number;
  }) { this.fetchImpl = deps.fetchImpl ?? fetch; }

  isConnected(): boolean { return this.connectedAtMs != null; }
  start(): void {
    if (this.stopController != null) return;
    this.stopController = new AbortController();
    void this.runLoop(this.stopController.signal);
  }
  stop(): void {
    this.stopController?.abort();
    this.stopController = null;
    this.streamController?.abort();
    this.streamController = null;
    this.connectedAtMs = null;
  }

  private async runLoop(stopSignal: AbortSignal): Promise<void> {
    let attempt = 0;
    while (!stopSignal.aborted) {
      try { await this.streamOnce(stopSignal); }
      catch (error) { if (!stopSignal.aborted) this.deps.onStreamError(error); }
      if (stopSignal.aborted) return;
      const now = this.deps.now ?? Date.now;
      const wasHealthy = this.connectedAtMs != null && now() - this.connectedAtMs >= HEALTHY_CONNECTION_MIN_LIFETIME_MS;
      this.connectedAtMs = null;
      attempt = wasHealthy ? 0 : attempt + 1;
      if (attempt > 0) {
        const delay = this.deps.reconnectBackoff.schedule(attempt, stopSignal);
        try { await delay.elapsed; }
        catch (error) { if (!stopSignal.aborted) this.deps.onStreamError(error); return; }
        finally { delay.dispose(); }
      }
    }
  }

  async streamOnce(stopSignal: AbortSignal): Promise<void> {
    const backendUrl = this.deps.getBackendUrl();
    const accessToken = await this.deps.getAccessToken({ backendUrl });
    if (stopSignal.aborted) return;
    const controller = new AbortController();
    this.streamController = controller;
    const handleFrame = (frame: string) => {
      if (stopSignal.aborted) return;
      const parsed = parseNotifyFrame(frame);
      if (parsed.kind === "connected") { this.connectedAtMs = (this.deps.now ?? Date.now)(); this.deps.onConnected(); }
      else if (parsed.kind === "notify") this.deps.onNotify(parsed.topic);
    };
    const watchdog = this.deps.stallWatchdog.arm(() => controller.abort());
    try {
      const response = await this.fetchImpl(new URL("/sand/notify", backendUrl).toString(), {
        headers: { authorization: `Bearer ${accessToken}`, accept: "text/event-stream", ...getSandBackendClientHeaders() },
        signal: controller.signal
      });
      if (!response.ok || response.body == null) throw new SandNotifyStreamError(response.status);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        watchdog.kick();
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
          handleFrame(frame);
        }
      }
    } finally {
      watchdog.dispose();
      if (this.streamController === controller) this.streamController = null;
    }
  }
}
