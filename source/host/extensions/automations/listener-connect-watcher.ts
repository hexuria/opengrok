import type { PollingPolicy } from "../../../internal/scheduling.js";
import type { ListenerPlatform } from "../../automations/listener-integrations.js";

export const DEFAULT_WATCH_TIMEOUT_MS = 15 * 60 * 1_000;
interface PendingWatch { agentId: string; expiresAtMs: number; isArmed: boolean }
export interface ListenerConnectWatcherDependencies { polling: PollingPolicy; isPlatformConnected(platform: ListenerPlatform): Promise<boolean>; onConnected(agentId: string, platform: ListenerPlatform): void; watchTimeoutMs?: number; now?: () => number }
export class ListenerConnectWatcher {
  readonly pending = new Map<ListenerPlatform, PendingWatch>(); private timer: { dispose(): void } | null = null; private isTicking = false; private isSuspended = false; private isDisposed = false;
  constructor(readonly deps: ListenerConnectWatcherDependencies) {}
  watch(agentId: string, platform: ListenerPlatform): void { if (this.isDisposed) return; this.pending.set(platform, { agentId, expiresAtMs: (this.deps.now ?? Date.now)() + (this.deps.watchTimeoutMs ?? DEFAULT_WATCH_TIMEOUT_MS), isArmed: false }); if (!this.isSuspended) { this.ensureLoop(); void this.tick(); } }
  suspend(): void { if (this.isDisposed || this.isSuspended) return; this.isSuspended = true; this.timer?.dispose(); this.timer = null; }
  resume(): void { if (this.isDisposed || !this.isSuspended) return; this.isSuspended = false; if (this.pending.size) { this.ensureLoop(); void this.tick(); } }
  dispose(): void { this.isDisposed = true; this.isSuspended = true; this.pending.clear(); this.stopLoopIfIdle(); }
  private ensureLoop(): void { if (this.timer != null || this.isSuspended || this.isDisposed) return; this.timer = this.deps.polling.start(async () => { try { await this.tick(); } catch {} }); }
  private stopLoopIfIdle(): void { if (this.pending.size > 0 && !this.isSuspended && !this.isDisposed) return; this.timer?.dispose(); this.timer = null; }
  async tick(): Promise<void> { if (this.isTicking || this.isSuspended || this.isDisposed) return; this.isTicking = true; try { const now = (this.deps.now ?? Date.now)(); for (const [platform, watch] of [...this.pending]) { if (watch.expiresAtMs <= now) { this.pending.delete(platform); continue; } let connected: boolean; try { connected = await this.deps.isPlatformConnected(platform); } catch { continue; } if (this.isDisposed) return; if (this.pending.get(platform) !== watch) continue; if (!connected) { watch.isArmed = true; continue; } if (this.isSuspended) continue; this.pending.delete(platform); if (watch.isArmed && !this.isDisposed) this.deps.onConnected(watch.agentId, platform); } } finally { this.isTicking = false; this.stopLoopIfIdle(); } }
}
