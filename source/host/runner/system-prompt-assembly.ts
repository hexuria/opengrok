import {
  agentProfileIdentitiesEqual,
  normalizeAgentProfileIdentity,
  renderAgentProfileUpdate,
  resolveAgentProfilePromptSnapshot,
  type AgentProfileIdentity,
  type AgentProfilePromptSnapshot,
} from "./sand-agent-profile-prompt.js";
import { SAND_EXTERNAL_SHELL_TOOL_NAME } from "../sand-activity.js";
import { toModelVisiblePath } from "../host-paths.js";
import {
  isMemoryFreezeEnabled,
  projectMemoryHasFacts,
  renderMemorySystemPrompt,
  renderProjectMemorySystemPrompt,
  renderUserMemorySystemPrompt,
  resolveFrozenMemoryPrompt,
  type FrozenMemorySnapshot,
  type MemoryRecall,
  type ProjectMemoryBlock,
  type ProvenancedMemory,
} from "./sand-memory.js";
import {
  SAND_CLOUD_AGENTS_DISABLED_PROMPT_SECTION,
  SAND_MCP_MULTI_ACCOUNT_PROMPT_SECTION,
  SAND_SYSTEM_PROMPT_CLOUD_AGENTS_DISABLED,
} from "./system-prompt.js";
import { renderAutomationsSystemPrompt, type AutomationRecord } from "../automations/automation.js";
import { renderTimeZoneSystemPrompt } from "../../shared/timezone.js";
import { renderUserIdentitySystemPrompt } from "../sand-user-identity.js";
import { renderWorkflowsSystemPrompt } from "../../shared/workflow-model.js";
import { renderChannelsSystemPrompt, type ChannelConnectionSummary } from "../../shared/channel-messaging.js";
import { renderAgentDirectorySystemPrompt, type AgentAddress, type AgentGroupAddress } from "../agents/agent-messaging.js";
import { spotlightPromptSection } from "../../shared/sand-spotlight.js";
import type { ConnectorManifest } from "../../shared/channels.js";

export function modelVisibleLocation(location: string | null | undefined): string | null {
  return location == null ? null : toModelVisiblePath(location);
}

export interface AgentProfileForPrompt extends AgentProfileIdentity {
  readonly filePath: string;
  readonly settingsFilePath: string;
}
export interface PromptSnapshotStore {
  getAgentProfilePromptSnapshot(): AgentProfilePromptSnapshot | undefined;
  setAgentProfilePromptSnapshot(snapshot: AgentProfilePromptSnapshot): void;
}
export interface MemorySnapshotStore {
  getMemoryPromptSnapshot(): FrozenMemorySnapshot | undefined;
  setMemoryPromptSnapshot(snapshot: FrozenMemorySnapshot): void;
}
export interface MemoryPromptStore {
  recall(limit: number): MemoryRecall;
  getLocation(): string | null;
}

export interface SystemPromptAssemblyDependencies {
  readonly basePrompt: string;
  readonly isSubagentRunner: boolean;
  readonly isSharedRoomRunner: boolean;
  readonly isSystemPromptOverridden: boolean;
  readonly agentProfileProvider: () => AgentProfileForPrompt | null;
  readonly agentStore: () => { getMetadata(key: string): string } | null;
  readonly compactionEpoch: () => number;
  readonly memoryStore: () => MemoryPromptStore | null;
  readonly memorySnapshots: () => MemorySnapshotStore | null;
  readonly userMemory: () => {
    recall(limits: { profileLimit: number; recentLimit: number }): { profile: readonly ProvenancedMemory[]; recent: readonly ProvenancedMemory[] };
    getLocation(): string | null; getOwnShardLocation(): string | null;
  } | null;
  readonly projectMemory: () => {
    recall(limits: { profileLimit: number; recentLimit: number }, cap: number): { injected: readonly ProjectMemoryBlock[]; alsoMemberOf: readonly { slug: string; name: string }[] };
    getLocation(): string | null;
  } | null;
  readonly isMemoryFreezeEnabled?: () => boolean;
  readonly isBoxScopedSubagent: () => boolean;
  readonly requestContext: { resolve(): { readonly timeZone: string; readonly userFullName?: string } };
  readonly automationStore: () => { getLocation(): string | null | undefined; list(): readonly AutomationRecord[]; listDefinitions?(): readonly AutomationRecord[] } | null;
  readonly workflowStore: () => { getLocation(): string | null | undefined } | null;
  readonly channelStore: () => { getLocation(): string | null | undefined; listConnections(): readonly ChannelConnectionSummary[] } | null;
  readonly connectorManifests: readonly ConnectorManifest[];
  readonly sendToAgentImpl?: unknown;
  readonly agentManagement?: unknown;
  readonly agentDirectory?: () => readonly AgentAddress[];
  readonly agentGroups?: () => readonly AgentGroupAddress[];
  readonly agentsRootDir?: () => string | null | undefined;
  readonly isSpotlightEnabled?: () => boolean;
  readonly isMultitaskEnabled?: () => boolean;
  readonly multitaskSection?: string;
  readonly mcpManagement: () => unknown;
  readonly isMcpMultiAccountEnabled?: () => boolean;
  readonly isCloudAgentsDisabledByTeam?: () => boolean;
  readonly mcpCustomInstructionsSection: () => string | null;
  readonly mcpDiscoveryStatusSection: () => string | null;
  readonly remoteBoxSection: () => string;
  readonly computerSection: () => string | null;
}

function profileSection(profile: AgentProfileForPrompt | null, sharedRoom: boolean): string | null {
  if (profile == null) return null;
  const title = profile.name.trim(), description = profile.description.trim();
  const lines: string[] = [];
  if (title.length > 0) {
    lines.push(`Title: ${title}`);
    if (!sharedRoom) lines.push(`Your agent name is "${title}". If the user asks for your name, answer with "${title}".`);
  }
  if (description.length > 0) lines.push(`Description: ${description}`);
  if (!sharedRoom && profile.filePath.length > 0) {
    lines.push(`Your profile is a JSON config file at ${toModelVisiblePath(profile.filePath)} with "name", "description", and "title" fields, which you can read with your shell tools. To rename yourself or rewrite your own description, use the update_state tool (target "profile", action "set"); it preserves every field you do not pass. Name and description edits are announced in a profile-update message for the current context and folded into this Agent profile section after the next conversation summary.`);
    lines.push(`Your profile picture is NOT part of that config \u2014 it is a conventional image file named "avatar.png" (or avatar.jpg/.jpeg/.webp/.gif/.svg) in the same directory, which you can read with your shell tools. To set it, put the image somewhere first (Shell under /workspace is fine \u2014 no CopyFromBox needed \u2014 or ${SAND_EXTERNAL_SHELL_TOOL_NAME} on the user's computer), then call update_state (target "avatar", action "set", path=...); to go back to the default picture, update_state target "avatar", action "clear". Never change your picture unless the user asks.`);
  }
  if (!sharedRoom && profile.settingsFilePath.length > 0) {
    lines.push(`Your per-agent settings live in a separate JSON config file at ${toModelVisiblePath(profile.settingsFilePath)}, readable the same way and changed with update_state (target "settings", action "set"). "hidden_from_sidebar" (true/false) removes your own row from the user's sidebar: you stay fully functional \u2014 you keep your conversation, keep receiving messages, keep running your routines, and still accrue unread \u2014 and the user can still reach you through the Hidden chats manager and Cmd-K; the default is visible. Pass only the fields you mean to change; the rest are preserved.`);
  }
  return lines.length === 0 ? null : ["Agent profile:", ...lines].join("\n");
}

export function createSystemPromptAssembly(deps: SystemPromptAssemblyDependencies) {
  let inMemoryProfilePromptSnapshot: AgentProfilePromptSnapshot | null = null;

  function resolveProfileForPrompt(): AgentProfileForPrompt | null {
    const profile = deps.agentProfileProvider();
    if (profile != null) return profile;
    const store = deps.agentStore();
    return store == null ? null : { name: store.getMetadata("name"), description: "", filePath: "", settingsFilePath: "" };
  }

  function prepareAgentProfilePromptSnapshot(store?: PromptSnapshotStore): AgentProfilePromptSnapshot | undefined {
    if (deps.isSubagentRunner || deps.agentProfileProvider() == null) return undefined;
    const profile = resolveProfileForPrompt();
    const section = profileSection(profile, false);
    if (profile == null || section == null) return undefined;
    const current = store?.getAgentProfilePromptSnapshot() ?? (store == null ? inMemoryProfilePromptSnapshot ?? undefined : undefined);
    const resolved = resolveAgentProfilePromptSnapshot({ ...(current == null ? {} : { snapshot: current }), profileSection: section, identity: normalizeAgentProfileIdentity(profile), compactionEpoch: deps.compactionEpoch() });
    inMemoryProfilePromptSnapshot = resolved;
    if (resolved !== current) store?.setAgentProfilePromptSnapshot(resolved);
    return resolved;
  }

  function persistAnnouncedAgentProfile(store: PromptSnapshotStore | undefined, turnSnapshot: AgentProfilePromptSnapshot, identity: AgentProfileIdentity): void {
    const current = store?.getAgentProfilePromptSnapshot() ?? inMemoryProfilePromptSnapshot;
    if (current == null || current.compactionEpoch !== turnSnapshot.compactionEpoch || current.profileSection !== turnSnapshot.profileSection || !agentProfileIdentitiesEqual(current.systemIdentity, turnSnapshot.systemIdentity) || agentProfileIdentitiesEqual(current.announcedIdentity, identity)) return;
    const next = { ...current, announcedIdentity: identity };
    inMemoryProfilePromptSnapshot = next; store?.setAgentProfilePromptSnapshot(next);
  }

  function getAgentProfileUpdateForTurn(snapshot?: AgentProfilePromptSnapshot): { text: string; identity: AgentProfileIdentity } | null {
    const profile = deps.agentProfileProvider();
    if (snapshot == null || profile == null) return null;
    const identity = normalizeAgentProfileIdentity(profile);
    return agentProfileIdentitiesEqual(identity, snapshot.announcedIdentity) ? null : { text: renderAgentProfileUpdate(identity), identity };
  }

  function getMemorySection(): string | null {
    const store = deps.memoryStore();
    if (store == null) return null;
    const renderLive = () => {
      const recall = store.recall(30);
      const parts: string[] = [];
      let hasFacts = recall.profile.length > 0 || recall.recent.length > 0;
      const userMemory = deps.userMemory();
      if (userMemory != null) {
        const userRecall = userMemory.recall({ profileLimit: 50, recentLimit: 15 });
        const rendered = renderUserMemorySystemPrompt(userRecall, { ...(modelVisibleLocation(userMemory.getLocation()) == null ? {} : { userMemoryDir: modelVisibleLocation(userMemory.getLocation())! }), ...(modelVisibleLocation(userMemory.getOwnShardLocation()) == null ? {} : { ownShardDir: modelVisibleLocation(userMemory.getOwnShardLocation())! }) });
        if (rendered.length > 0) parts.push(rendered);
        hasFacts ||= userRecall.profile.length > 0 || userRecall.recent.length > 0;
      }
      const projectMemory = deps.projectMemory();
      if (projectMemory != null) {
        const projectRecall = projectMemory.recall({ profileLimit: 25, recentLimit: 10 }, 3);
        const root = modelVisibleLocation(projectMemory.getLocation());
        const rendered = renderProjectMemorySystemPrompt(
          {
            ...projectRecall,
            injected: projectRecall.injected.map((block) =>
              block.ownShardDir == null ? block : { ...block, ownShardDir: toModelVisiblePath(block.ownShardDir) }),
          },
          root == null ? {} : { projectsRootDir: root },
        );
        if (rendered.length > 0) parts.push(rendered);
        hasFacts ||= projectMemoryHasFacts(projectRecall);
      }
      const agent = renderMemorySystemPrompt(recall, modelVisibleLocation(store.getLocation()) ?? undefined);
      if (agent.length > 0) parts.push(agent);
      return { render: parts.join("\n\n"), hasFacts };
    };
    const snapshots = deps.memorySnapshots();
    if (snapshots == null || (deps.isMemoryFreezeEnabled?.() ?? isMemoryFreezeEnabled()) === false) return renderLive().render || null;
    const frozen = snapshots.getMemoryPromptSnapshot();
    const resolved = resolveFrozenMemoryPrompt({ ...(frozen == null ? {} : { snapshot: frozen }), compactionEpoch: deps.compactionEpoch(), renderLive });
    if (resolved.snapshotToPersist != null) snapshots.setMemoryPromptSnapshot(resolved.snapshotToPersist);
    return resolved.render || null;
  }

  function getTimeZoneSection(): string | null {
    if (deps.isBoxScopedSubagent()) return null;
    const rendered = renderTimeZoneSystemPrompt(deps.requestContext.resolve().timeZone);
    return rendered.length > 0 ? rendered : null;
  }

  function getUserIdentitySection(): string | null {
    const rendered = renderUserIdentitySystemPrompt(deps.requestContext.resolve().userFullName);
    return rendered.length > 0 ? rendered : null;
  }

  function getAutomationsSection(): string | null {
    const store = deps.automationStore();
    if (store == null) return null;
    const rendered = renderAutomationsSystemPrompt(
      (store.listDefinitions?.() ?? store.list()).slice(0, 100),
      modelVisibleLocation(store.getLocation()),
      deps.requestContext.resolve().timeZone,
    );
    return rendered.length > 0 ? rendered : null;
  }

  function getWorkflowsSection(): string | null {
    const store = deps.workflowStore();
    if (store == null) return null;
    const rendered = renderWorkflowsSystemPrompt(modelVisibleLocation(store.getLocation()));
    return rendered.length > 0 ? rendered : null;
  }

  function getChannelsSection(): string | null {
    const store = deps.channelStore();
    if (store == null) return null;
    const enabledPlatforms = new Set(deps.connectorManifests.map((manifest) => manifest.platform));
    const connections = store.listConnections().filter((connection) => enabledPlatforms.has(connection.platform));
    const rendered = renderChannelsSystemPrompt(
      deps.connectorManifests,
      connections,
      modelVisibleLocation(store.getLocation()),
    );
    return rendered.length > 0 ? rendered : null;
  }

  function getAgentDirectorySection(): string | null {
    if (deps.isSubagentRunner) return null;
    if (deps.sendToAgentImpl == null && deps.agentManagement == null) return null;
    const rendered = renderAgentDirectorySystemPrompt(
      deps.agentDirectory?.() ?? [],
      deps.agentGroups?.() ?? [],
      modelVisibleLocation(deps.agentsRootDir?.()) ?? undefined,
    );
    return rendered.length > 0 ? rendered : null;
  }

  function getSystemPrompt(snapshot?: AgentProfilePromptSnapshot): string {
    const cloudDisabled = deps.isCloudAgentsDisabledByTeam?.() === true;
    const base = !deps.isSystemPromptOverridden && cloudDisabled ? SAND_SYSTEM_PROMPT_CLOUD_AGENTS_DISABLED : deps.basePrompt;
    const sections = [base];
    if (deps.isSpotlightEnabled?.() !== false) sections.push(spotlightPromptSection({ canSendMessage: !deps.isSubagentRunner }));
    const profile = deps.isSharedRoomRunner ? profileSection(resolveProfileForPrompt(), true) : snapshot?.profileSection ?? profileSection(resolveProfileForPrompt(), false);
    if (profile != null) sections.push(profile);
    if (deps.isSharedRoomRunner) return sections.join("\n\n");
    const add = (value: string | null | undefined): void => { if (value != null && value.length > 0) sections.push(value); };
    add(getUserIdentitySection());
    if (!deps.isSubagentRunner && !deps.isSystemPromptOverridden && deps.isMultitaskEnabled?.() === true) add(deps.multitaskSection);
    if (deps.isSystemPromptOverridden && !deps.isSubagentRunner && cloudDisabled) add(SAND_CLOUD_AGENTS_DISABLED_PROMPT_SECTION);
    if (!deps.isSubagentRunner && deps.mcpManagement() != null && deps.isMcpMultiAccountEnabled?.() === true) add(SAND_MCP_MULTI_ACCOUNT_PROMPT_SECTION);
    add(getTimeZoneSection());
    add(getMemorySection()); add(getAutomationsSection()); add(getWorkflowsSection()); add(getChannelsSection()); add(getAgentDirectorySection());
    add(deps.mcpCustomInstructionsSection()); add(deps.mcpDiscoveryStatusSection()); add(deps.remoteBoxSection()); add(deps.computerSection());
    return sections.join("\n\n");
  }

  return {
    getSystemPrompt, prepareAgentProfilePromptSnapshot, getAgentProfileUpdateForTurn, persistAnnouncedAgentProfile,
    resetProfileSnapshotFallback() { inMemoryProfilePromptSnapshot = null; },
  };
}
