export const RECENT_WAKE_WINDOW_MS = 60_000;
export interface DesktopConnectivity { isOnline(): boolean; recentWake(): boolean }
export function createDesktopConnectivity(deps: { readonly isOnline: () => boolean; readonly onResume: (listener: () => void) => void; readonly monotonicNow: () => number }): DesktopConnectivity {
  let lastResumeAtMs: number | undefined;
  deps.onResume(() => { lastResumeAtMs = deps.monotonicNow(); });
  return { isOnline: () => deps.isOnline(), recentWake: () => lastResumeAtMs !== undefined && deps.monotonicNow() - lastResumeAtMs < RECENT_WAKE_WINDOW_MS };
}
export function createElectronDesktopConnectivity(deps: { readonly net: { isOnline(): boolean }; readonly powerMonitor: { on(event: "resume", listener: () => void): void }; readonly monotonicNow?: () => number }): DesktopConnectivity {
  return createDesktopConnectivity({ isOnline: () => deps.net.isOnline(), onResume: (listener) => deps.powerMonitor.on("resume", listener), monotonicNow: deps.monotonicNow ?? (() => performance.now()) });
}
export function connectivityStamps(connectivity: DesktopConnectivity): { client_online: string; recent_wake: string } { return { client_online: String(connectivity.isOnline()), recent_wake: String(connectivity.recentWake()) }; }
