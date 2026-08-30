import { EventEmitter } from "node:events";

export const MAX_TRAYS = 20;
export interface ErrorTray {
  readonly kind: "error";
  readonly id: string;
  readonly agentId?: string | undefined;
  readonly title: string;
  readonly detail: string;
  readonly requestId?: string | undefined;
  readonly createdAt: number;
  readonly errorKind?: string | undefined;
  readonly rawDetail?: string | undefined;
  readonly actions?: readonly unknown[] | undefined;
  readonly dedupeKey?: string;
  readonly count?: number;
}
export type TrayEvent = { type: "pushed"; tray: ErrorTray } | { type: "cleared" } | { type: "dismissed"; id: string };

export class TrayManager {
  private readonly emitter = new EventEmitter();
  private trays: ErrorTray[] = [];
  constructor(private readonly createId: () => string = () => crypto.randomUUID(), private readonly now: () => number = () => Date.now()) {}
  getTrays(): readonly ErrorTray[] { return this.trays; }
  pushError(options: Omit<ErrorTray, "kind" | "id" | "createdAt" | "count"> & { count?: number }): ErrorTray {
    const now = this.now();
    if (options.dedupeKey != null) {
      const index = this.trays.findIndex((tray) => tray.dedupeKey === options.dedupeKey);
      const existing = index === -1 ? null : this.trays[index];
      if (existing != null) {
        const updated: ErrorTray = {
          ...existing, title: options.title, detail: options.detail, requestId: options.requestId,
          count: options.count ?? (existing.count ?? 1) + 1, createdAt: now,
          errorKind: options.errorKind, rawDetail: options.rawDetail,
          actions: options.actions != null && options.actions.length > 0 ? options.actions : undefined
        };
        const next = [...this.trays]; next[index] = updated; this.trays = next;
        this.emit({ type: "pushed", tray: updated }); return updated;
      }
    }
    const tray: ErrorTray = {
      kind: "error", id: this.createId(), agentId: options.agentId, title: options.title, detail: options.detail,
      requestId: options.requestId, createdAt: now,
      ...(options.errorKind != null ? { errorKind: options.errorKind } : {}),
      ...(options.rawDetail != null ? { rawDetail: options.rawDetail } : {}),
      ...(options.actions != null && options.actions.length > 0 ? { actions: options.actions } : {}),
      ...(options.dedupeKey != null ? { dedupeKey: options.dedupeKey, count: options.count ?? 1 } : {})
    };
    this.trays = [...this.trays, tray]; this.emit({ type: "pushed", tray }); this.enforceCap(); return tray;
  }
  clearAll(): void { if (this.trays.length === 0) return; this.trays = []; this.emit({ type: "cleared" }); }
  dismiss(id: string): boolean {
    const next = this.trays.filter((tray) => tray.id !== id);
    if (next.length === this.trays.length) return false;
    this.trays = next; this.emit({ type: "dismissed", id }); return true;
  }
  clearForAgent(agentId: string): void {
    const removed = this.trays.filter((tray) => tray.agentId === agentId);
    if (removed.length === 0) return;
    this.trays = this.trays.filter((tray) => tray.agentId !== agentId);
    for (const tray of removed) this.emit({ type: "dismissed", id: tray.id });
  }
  subscribe(listener: (event: TrayEvent) => void): () => void { this.emitter.on("event", listener); return () => this.emitter.off("event", listener); }
  private enforceCap(): void {
    if (this.trays.length <= MAX_TRAYS) return;
    const dropped = this.trays.slice(0, this.trays.length - MAX_TRAYS);
    this.trays = this.trays.slice(this.trays.length - MAX_TRAYS);
    for (const tray of dropped) this.emit({ type: "dismissed", id: tray.id });
  }
  private emit(event: TrayEvent): void { this.emitter.emit("event", event); }
}
