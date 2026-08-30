import { createHostEvents } from "../internal/host-extensions.js";
import { errorLogTag } from "../shared/errors.js";
export class SandHostEventBus<Event = unknown> {
  private readonly listeners = new Set<(event: Event) => void>();
  private readonly capabilityEvents = createHostEvents({ onHandlerFailure: (topic, error) => this.reportFailure({ kind: "subscriber_failed", topic, errorClass: errorLogTag(error) }) });
  constructor(private readonly reportFailure: (failure: Readonly<Record<string, unknown>>) => void = () => {}) {}
  emit(event: Event): void;
  emit(topic: string, payload: unknown, options?: { failureMode?: "reject" }): Promise<void>;
  emit(eventOrTopic: Event | string, payload?: unknown, options?: { failureMode?: "reject" }): void | Promise<void> { if (arguments.length !== 1) return this.capabilityEvents.emit(eventOrTopic as string, payload, options); for (const listener of this.listeners) { try { listener(eventOrTopic as Event); } catch (error) { this.reportFailure({ kind: "listener_failed", errorClass: errorLogTag(error) }); } } }
  on(topic: string, handler: (payload: unknown) => unknown): () => void { return this.capabilityEvents.on(topic, handler); }
  subscribe(listener: (event: Event) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}
