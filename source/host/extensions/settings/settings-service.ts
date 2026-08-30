import { join } from "node:path";

import { getSandRootDir } from "../../host-paths.js";
import { isSandAgentModelSelection, type SandAgentModelSelection } from "../../../shared/agents/sand-agent-model.js";
import { normalizeSandLocalToolPermission, type SandLocalToolPermission } from "../../../shared/local-tool-permission.js";
import type { SandAutoReviewInstructions } from "../../../shared/sand-auto-review-instructions.js";
import type { SidebarSection } from "../../../shared/sidebar-sections.js";
import { SandSettingsStore } from "../../../shared/node/settings/sand-settings-store.js";
import { isSandInferenceProvider, type SandInferenceProvider } from "../../../shared/inference-router.js";

export function isValidIanaTimeZone(value: string): boolean { try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; } catch { return false; } }

export interface HostSettingsUpdate {
  notifications?: unknown; mcpCustomInstructions?: Record<string, string>; mcpCustomInstructionsByServerId?: Record<string, string>;
  mcpDisabledToolsByServerId?: Record<string, string[]>; mcpCustomInstructionsAccountScope?: string | null; mcpBoxServers?: string[];
  userTimeZone?: string; userTimeZoneOverride?: string; agentDefaultModel?: SandAgentModelSelection | null; computerUseModel?: SandAgentModelSelection | null;
  autoReviewInstructions?: SandAutoReviewInstructions; localToolPermission?: unknown; webauthnProxyEnabled?: boolean; pinnedAgentIds?: string[];
  sidebarSections?: SidebarSection[]; hasSeenOnboarding?: boolean; featureFlagOverrides?: Record<string, boolean>; inferenceProvider?: unknown;
}

export class SettingsService {
  readonly store: SandSettingsStore;
  private readonly featureFlagOverrideListeners = new Set<(overrides: Record<string, boolean>) => void>();
  private readonly userTimeZoneListeners = new Set<(zone: string | undefined) => void>();
  private readonly changeListeners = new Set<(event: { readonly fields: string[] }) => void>();
  constructor(private readonly settingsPath = join(getSandRootDir(), "settings.json")) { this.store = new SandSettingsStore(settingsPath); }
  getSettingsPath(): string { return this.settingsPath; }
  getHostSettings() {
    const userTimeZone = this.store.getDetectedUserTimeZone(); const userTimeZoneOverride = this.store.getUserTimeZoneOverride();
    const agentDefaultModel = this.store.getAgentDefaultModel(); const computerUseModel = this.store.getComputerUseModel();
    const scope = this.store.getMcpCustomInstructionsAccountScope(); const pinnedAgentIds = this.store.getPinnedAgentIds();
    const sidebarSections = this.store.getSidebarSections(); const hasSeenOnboarding = this.store.getHasSeenOnboarding();
    return { notifications: this.store.getNotificationConfig(), mcpCustomInstructions: this.store.getMcpCustomInstructions(), mcpCustomInstructionsByServerId: this.store.getMcpCustomInstructionsByServerId(), mcpDisabledToolsByServerId: this.store.getMcpDisabledToolsByServerId(), ...(scope === undefined ? {} : { mcpCustomInstructionsAccountScope: scope }), mcpBoxServers: this.store.getMcpBoxServers(), autoReviewInstructions: this.store.getAutoReviewInstructions(), localToolPermission: this.store.getLocalToolPermission(), webauthnProxyEnabled: this.store.getWebauthnProxyEnabled(), inferenceProvider: this.store.getInferenceProvider(), inferenceRouterUsage: this.store.getInferenceRouterUsage(), ...(userTimeZone === undefined ? {} : { userTimeZone }), ...(userTimeZoneOverride === undefined ? {} : { userTimeZoneOverride }), ...(agentDefaultModel === undefined ? {} : { agentDefaultModel }), ...(computerUseModel === undefined ? {} : { computerUseModel }), ...(pinnedAgentIds === undefined ? {} : { pinnedAgentIds }), sidebarSections: sidebarSections ?? [], ...(hasSeenOnboarding === undefined ? {} : { hasSeenOnboarding }) };
  }
  setHostSettings(update: HostSettingsUpdate) {
    const previousUserTimeZone = this.store.getUserTimeZone(); this.store.setNotificationConfig(update.notifications ?? {});
    if (update.mcpCustomInstructionsAccountScope === null) this.store.clearAccountScope(); else if (update.mcpCustomInstructionsAccountScope !== undefined) this.store.scopeToAccount(update.mcpCustomInstructionsAccountScope);
    if (update.mcpCustomInstructions !== undefined) this.store.setMcpCustomInstructions(update.mcpCustomInstructions);
    if (update.mcpCustomInstructionsByServerId !== undefined) this.store.setMcpCustomInstructionsByServerId(update.mcpCustomInstructionsByServerId);
    if (update.mcpDisabledToolsByServerId !== undefined) this.store.setMcpDisabledToolsByServerId(update.mcpDisabledToolsByServerId);
    if (update.mcpBoxServers !== undefined) this.store.setMcpBoxServers(update.mcpBoxServers);
    if (update.userTimeZone !== undefined && (update.userTimeZone === "" || isValidIanaTimeZone(update.userTimeZone))) this.store.setUserTimeZone(update.userTimeZone);
    if (update.userTimeZoneOverride !== undefined && (update.userTimeZoneOverride === "" || isValidIanaTimeZone(update.userTimeZoneOverride))) this.store.setUserTimeZoneOverride(update.userTimeZoneOverride);
    if (update.agentDefaultModel === null) this.store.setAgentDefaultModel(undefined); else if (isSandAgentModelSelection(update.agentDefaultModel)) this.store.setAgentDefaultModel(update.agentDefaultModel);
    if (update.autoReviewInstructions !== undefined) this.store.setAutoReviewInstructions(update.autoReviewInstructions);
    if (update.localToolPermission !== undefined) this.store.setLocalToolPermission(normalizeSandLocalToolPermission(update.localToolPermission));
    if (update.webauthnProxyEnabled !== undefined) this.store.setWebauthnProxyEnabled(update.webauthnProxyEnabled);
    if (update.pinnedAgentIds !== undefined) this.store.setPinnedAgentIds(update.pinnedAgentIds);
    if (update.sidebarSections !== undefined) this.store.setSidebarSections(update.sidebarSections);
    if (update.hasSeenOnboarding !== undefined) this.store.setHasSeenOnboarding(update.hasSeenOnboarding);
    if (isSandInferenceProvider(update.inferenceProvider)) this.store.setInferenceProvider(update.inferenceProvider);
    if (update.featureFlagOverrides !== undefined) for (const listener of [...this.featureFlagOverrideListeners]) listener(update.featureFlagOverrides);
    if (update.computerUseModel === null) this.store.setComputerUseModel(undefined); else if (isSandAgentModelSelection(update.computerUseModel)) this.store.setComputerUseModel(update.computerUseModel);
    const userTimeZone = this.store.getUserTimeZone(); if (userTimeZone !== previousUserTimeZone) for (const listener of [...this.userTimeZoneListeners]) listener(userTimeZone);
    const fields = Object.keys(update); if (fields.length > 0) for (const listener of [...this.changeListeners]) listener({ fields });
    return this.getHostSettings();
  }
  subscribeToChanges(listener: (event: { readonly fields: string[] }) => void): () => void { this.changeListeners.add(listener); return () => this.changeListeners.delete(listener); }
  getAgentDefaultModel(): SandAgentModelSelection | undefined { return this.store.getAgentDefaultModel(); }
  getComputerUseModel(): SandAgentModelSelection | undefined { return this.store.getComputerUseModel(); }
  getUserTimeZone(): string | undefined { return this.store.getUserTimeZone(); }
  getAutoReviewInstructions(): SandAutoReviewInstructions { return this.store.getAutoReviewInstructions(); }
  getLocalToolPermission(): SandLocalToolPermission { return this.store.getLocalToolPermission(); }
  setLocalToolPermission(value: SandLocalToolPermission): void { this.store.setLocalToolPermission(value); }
  getInferenceProvider(): SandInferenceProvider { return this.store.getInferenceProvider(); }
  getInferenceRouterUsage() { return this.store.getInferenceRouterUsage(); }
  recordInferenceUsage(provider: SandInferenceProvider, usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }): void { this.store.recordInferenceUsage(provider, usage); }
  getWebauthnProxyEnabled(): boolean { return this.store.getWebauthnProxyEnabled(); }
  subscribeToFeatureFlagOverrides(listener: (value: Record<string, boolean>) => void): () => void { this.featureFlagOverrideListeners.add(listener); return () => this.featureFlagOverrideListeners.delete(listener); }
  subscribeToUserTimeZone(listener: (value: string | undefined) => void): () => void { this.userTimeZoneListeners.add(listener); return () => this.userTimeZoneListeners.delete(listener); }
  scopeToAccount(value: string): void { this.store.scopeToAccount(value); }
  migrateMcpCustomInstructionToServerId(args: { serverId: string; displayName: string }): void { this.store.migrateMcpCustomInstructionToServerId(args); }
  getMcpCustomInstructions(): Record<string, string> { return this.store.getMcpCustomInstructions(); }
  getMcpCustomInstructionsByServerId(): Record<string, string> { return this.store.getMcpCustomInstructionsByServerId(); }
  getMcpDisabledToolsByServerId(): Record<string, string[]> { return this.store.getMcpDisabledToolsByServerId(); }
  setMcpDisabledToolsByServerId(value: Record<string, string[]>): void { this.store.setMcpDisabledToolsByServerId(value); }
  getRawMcpCustomInstruction(name: string): string | undefined { return this.store.getRawMcpCustomInstruction(name); }
  getRawMcpCustomInstructionByServerId(id: string): string | undefined { return this.store.getRawMcpCustomInstructionByServerId(id); }
  setMcpCustomInstructionByServerId(args: { serverId: string; displayName: string; value: string; mirrorLegacyName: boolean }): void { this.store.setMcpCustomInstructionByServerId(args); }
  deleteMcpCustomInstructionByServerId(args: { serverId: string; displayName: string; deleteLegacyName: boolean }): void { this.store.deleteMcpCustomInstructionByServerId(args); }
}
