import { dirname } from "node:path";
import { FileAutomationStore, getAgentAutomationsDir } from "../../automations/automation-store.js";
import { getGlobalWorkflowsDir } from "../../workflows/workflow-library.js";
import { FileWorkflowStore } from "../../workflows/workflow-store.js";
import { FileChannelStore, getAgentChannelsDir } from "./channel-store.js";

export interface UnavailableMemoryStore { recall(): { profile: never[]; recent: never[] }; listMemories(): never[]; addMemory(): null; removeMemoryByContent(): false; getLocation(): null; setOnChange(): void; removeMemory(): false; clearMemories(): void }
export function createUnavailableMemoryStore(): UnavailableMemoryStore { return { recall: () => ({ profile: [], recent: [] }), listMemories: () => [], addMemory: () => null, removeMemoryByContent: () => false, getLocation: () => null, setOnChange: () => {}, removeMemory: () => false, clearMemories: () => {} }; }
export const NO_SESSION_MEMORY = { createAgentStore: () => createUnavailableMemoryStore(), agentHasContent: () => false };
export function automationStoreForDbPath(dbPath: string, resolveUserTimeZone: () => string | undefined = () => undefined): FileAutomationStore { return new FileAutomationStore(getAgentAutomationsDir(dirname(dbPath)), resolveUserTimeZone); }
export function workflowStoreForDbPath(dbPath: string, resolveUserTimeZone: () => string | undefined = () => undefined): FileWorkflowStore { const agentDir = dirname(dbPath), sandRoot = dirname(dirname(agentDir)); return new FileWorkflowStore(agentDir, getGlobalWorkflowsDir(sandRoot), resolveUserTimeZone); }
export function channelStoreForDbPath(dbPath: string): FileChannelStore { return new FileChannelStore(getAgentChannelsDir(dirname(dbPath))); }
