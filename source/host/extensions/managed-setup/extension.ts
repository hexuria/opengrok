import type { SandManagedSkillsService } from "./managed-skills-service.js";

export interface RenewalEvent { outcome: string; isFirstCredential?: boolean }
export interface ManagedAuthPort { getAccessToken(args?: unknown): Promise<string>; getMachineId(): string; peekAccessToken(): string | null; subscribeToRenewal?(listener: (event: RenewalEvent) => void): () => void; onDidChange?(listener: () => void): () => void; getLastRenewalEvent?(): RenewalEvent | null }
export function bestEffortAccessToken(auth: Pick<ManagedAuthPort, "getAccessToken">, args?: unknown): () => Promise<string | null> { return async () => { try { const token = await auth.getAccessToken(args); return token.length > 0 ? token : null; } catch { return null; } }; }
export function startManagedSkillsWhenAuthenticated(options: { auth: ManagedAuthPort; service?: SandManagedSkillsService; startManagedSkills?: () => void; refreshManagedSkills?: () => void }): () => void {
  let started = false, disposed = false;
  const start = (): void => { if (started || disposed) return; started = true; (options.startManagedSkills ?? (() => options.service?.start()))(); };
  const handleRenewal = (event: RenewalEvent): void => { if (disposed || event.outcome !== "renewed") return; if (!started) { if (options.auth.peekAccessToken() !== null) start(); return; } if (event.isFirstCredential) (options.refreshManagedSkills ?? (() => options.service?.handleAuthChange()))(); };
  const unsubscribe = options.auth.subscribeToRenewal?.(handleRenewal) ?? options.auth.onDidChange?.(() => handleRenewal({ outcome: "renewed", isFirstCredential: true })) ?? (() => {});
  if (options.auth.peekAccessToken() !== null) start();
  return () => { if (disposed) return; disposed = true; unsubscribe(); };
}
export interface ManagedSetupContext {
  deps: { auth: ManagedAuthPort; telemetry?: { logs: { reportHostExtensionDiagnostic(event: unknown): void } } };
  createManagedSkills(args: { getAccessToken: () => Promise<string | null>; report(event: unknown): void }): SandManagedSkillsService;
  createTeamRules(args: { auth: ManagedAuthPort; report(event: unknown): void }): { start(): void; refresh(): void; resolveRules(): Promise<readonly unknown[] | undefined> };
  fetchSkillCatalog(getAccessToken: () => Promise<string | null>): Promise<unknown[]>;
  onStop(dispose: () => void): void;
}
export const managedSetupExtension = { id: "managed-setup", dependencies: ["auth", "telemetry"] as const, start(context: ManagedSetupContext) { const auth = context.deps.auth, report = (event: unknown) => context.deps.telemetry?.logs.reportHostExtensionDiagnostic(event), token = bestEffortAccessToken(auth), managed = context.createManagedSkills({ getAccessToken: token, report }), stopManaged = startManagedSkillsWhenAuthenticated({ auth, service: managed }), teamRules = context.createTeamRules({ auth, report }); const onRenewal = (event: RenewalEvent) => { if (event.outcome === "renewed" && event.isFirstCredential) teamRules.refresh(); }, unsubscribe = auth.subscribeToRenewal?.(onRenewal) ?? (() => {}), dispose = () => { unsubscribe(); stopManaged(); managed.dispose(); }; context.onStop(dispose); const last = auth.getLastRenewalEvent?.(); if (last != null) onRenewal(last); teamRules.start(); return { dispose, skillsCatalog: () => context.fetchSkillCatalog(token), ensureManagedSkill: (id: string) => managed.ensureSkill(id), resolveTeamRules: () => teamRules.resolveRules() }; } };
