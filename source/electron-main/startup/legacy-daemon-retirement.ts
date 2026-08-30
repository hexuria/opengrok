import type { DataRootSettlement } from "./startup-data-root-migration.js";

function attempt<T>(work: () => T): { ok: true; value: T } | { ok: false } { try { return { ok: true, value: work() }; } catch { return { ok: false }; } }
export async function retireIdleLegacyDaemon(options: { readonly settlement?: DataRootSettlement | null; readonly hasPendingActivation: () => boolean; readonly readDiscovery: () => Promise<{ readonly pid: number; readonly entryRealpath?: string; readonly generationToken?: string; readonly inflightCount?: number } | null>; readonly isDaemonProcess: (pid: number, discovery: { readonly entryRealpath?: string; readonly generationToken?: string }) => boolean; readonly terminate: (pid: number) => Promise<void>; readonly isProcessAlive: (pid: number) => boolean; readonly relaunch: () => void; readonly exit: () => void }): Promise<"continue-bootstrap" | "stop-bootstrap"> {
  const settlement = options.settlement;
  if (settlement == null || settlement.route !== "legacy" || settlement.reason !== "idle-legacy-writer" || options.hasPendingActivation()) return "continue-bootstrap";
  const pid = settlement.pid;
  if (pid == null) return "continue-bootstrap";
  const discovery = await options.readDiscovery().then((value) => ({ ok: true as const, value }), () => ({ ok: false as const }));
  if (!discovery.ok || discovery.value == null || discovery.value.pid !== pid || (discovery.value.inflightCount ?? 0) > 0 || options.hasPendingActivation()) return "continue-bootstrap";
  const identified = attempt(() => options.isDaemonProcess(pid, discovery.value!));
  if (!identified.ok || !identified.value) return "continue-bootstrap";
  const terminated = await options.terminate(pid).then(() => true, () => false);
  if (!terminated || options.hasPendingActivation()) return "continue-bootstrap";
  const stillAlive = attempt(() => options.isProcessAlive(pid));
  if (!stillAlive.ok || stillAlive.value) return "continue-bootstrap";
  if (!attempt(options.relaunch).ok) return "continue-bootstrap";
  options.exit();
  return "stop-bootstrap";
}
