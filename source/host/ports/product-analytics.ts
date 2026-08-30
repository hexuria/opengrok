export interface SandProductAnalytics { trackEvent(name: string, properties?: Readonly<Record<string, unknown>>): void }
export function createNoopSandProductAnalytics(): SandProductAnalytics { return { trackEvent: () => {} }; }
