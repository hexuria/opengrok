import { errorLogTag } from "../../errors.js";
import { reportExperimentsDiagnostic } from "./experiments-diagnostics.js";
export class MutableGateProperty {
  private readonly listeners = new Set<(value: boolean) => void>();
  constructor(private value: boolean) {}
  get(): boolean { return this.value; }
  subscribe(listener: (value: boolean) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  set(value: boolean): void { if (this.value === value) return; this.value = value; for (const listener of this.listeners) { try { listener(value); } catch (error) { reportExperimentsDiagnostic({ kind: "gate_listener_failed", errorClass: errorLogTag(error) }); } } }
  clearListeners(): void { this.listeners.clear(); }
}
