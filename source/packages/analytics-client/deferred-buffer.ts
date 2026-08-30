export interface DeferredAnalyticsEvent { eventName: string; props?: Readonly<Record<string, unknown>> | undefined; timestamp?: number | undefined }
export class DeferredAnalyticsBuffer {
  private events: DeferredAnalyticsEvent[] = [];
  track(eventName: string, props?: Readonly<Record<string, unknown>>, timestamp?: number): void {
    this.events.push({ eventName, props, timestamp });
  }
  async flush(_timeoutMs: number): Promise<void> {}
  getEvents(): DeferredAnalyticsEvent[] { return this.events; }
  clear(): void { this.events = []; }
}
