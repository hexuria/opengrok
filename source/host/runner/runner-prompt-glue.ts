import type { Context } from "../../packages/context/core.js";
import type { TransferBox } from "../box/box-transfer.js";
import { boxIsPreparing, type CapableBox } from "../box/box-capabilities.js";
import type { AutomationStatusReminderRequestContext, AutomationStatusReminderStore } from "../automations/automation-status-reminder.js";
import type { AgentProfileIdentity } from "./sand-agent-profile-prompt.js";
import { createSandMcpTextSpiller, isLargeOutputSpillEnabled } from "./large-output-spill.js";
import type { FileTransferController, UserComputerHandle } from "./tools/sand-file-transfer-tools.js";
import {
  createPromptCollectorGlue,
  type PromptCollectorHost,
} from "./prompt-collector-glue.js";
import type { ShellTerminalWatchHost } from "./shell-terminal-watch.js";

/** The concrete owner join used by SandAgentRunner's immutable prompt-glue construction. */
export interface RunnerPromptGlueOwner {
  readonly ctx: Context;
  readonly box: TransferBox;
  readonly remoteBox: TransferBox & CapableBox;
  readonly userComputers: {
    resolve(computerId?: string): UserComputerHandle | undefined;
    list(): readonly UserComputerHandle[];
  };
  readonly remoteBoxHasDesktop: boolean;
  readonly isSubagentRunner: boolean;
  readonly isComputerUseSubagent: boolean;
  readonly isBrowserUseSubagent: boolean;
  readonly requestContext: AutomationStatusReminderRequestContext;
  readonly mcp?: { getCustomInstructions(ctx: Context): Promise<ReadonlyMap<string, string>> };
  readonly automationStore?: AutomationStatusReminderStore | null;
  readonly agentProfileProvider?: () => AgentProfileIdentity;
  readonly readVideoAttachmentBytes?: (path: string) => Promise<Uint8Array | null>;
  readonly isBrowserUseSubagentEnabled?: () => boolean;
  readonly isSpotlightEnabled?: () => boolean;
  readonly uploadAttachmentsIntoBox?: (paths: readonly string[]) => Promise<ReadonlyMap<string, string>>;
  readonly getRemoteBoxAvailable?: () => boolean;
  getConversationId(): string;
  resolveBoxId(): string;
  resolveBoxBrowser?(): { readonly display: string; readonly cdpUrl: string } | null;
  readonly mcpConnectedServerNamesForTurn: () => readonly string[];
  readonly mcpCustomInstructionsForTurn: () => ReadonlyMap<string, string>;
  readonly isMcpDiscoveryUnavailableForTurn: () => boolean;
  readonly shellWatchHost: () => ShellTerminalWatchHost<Context>;
}

/**
 * Builds prompt glue from live runner-owned getters. Values are deliberately
 * read through the owner at call time, matching the artifact's constructor
 * and avoiding per-run snapshots of auth, profile, MCP, or automation state.
 */
export function createRunnerPromptGlue(owner: RunnerPromptGlueOwner) {
  const host: PromptCollectorHost<Context> = {
    get ctx() { return owner.ctx; },
    get box() { return owner.box; },
    get remoteBox() { return owner.remoteBox; },
    get remoteBoxHasDesktop() { return owner.remoteBoxHasDesktop; },
    get isSubagentRunner() { return owner.isSubagentRunner; },
    get isComputerUseSubagent() { return owner.isComputerUseSubagent; },
    get isBrowserUseSubagent() { return owner.isBrowserUseSubagent; },
    get requestContext() { return owner.requestContext; },
    get automationStore() { return owner.automationStore; },
    get agentProfileProvider() { return owner.agentProfileProvider; },
    get readVideoAttachmentBytes() { return owner.readVideoAttachmentBytes; },
    get isBrowserUseSubagentEnabled() { return owner.isBrowserUseSubagentEnabled; },
    get isSpotlightEnabled() { return owner.isSpotlightEnabled; },
    get uploadAttachmentsIntoBox() { return owner.uploadAttachmentsIntoBox; },
    get getRemoteBoxAvailable() { return owner.getRemoteBoxAvailable; },
    get mcp() { return owner.mcp; },
    get resolveBoxId() { return owner.resolveBoxId; },
    get shellWatchHost() { return owner.shellWatchHost; },
    getConversationId: () => owner.getConversationId(),
    resolveBoxBrowser: () => owner.resolveBoxBrowser?.() ?? null,
    mcpConnectedServerNamesForTurn: () => owner.mcpConnectedServerNamesForTurn(),
    mcpCustomInstructionsForTurn: () => owner.mcpCustomInstructionsForTurn(),
    isMcpDiscoveryUnavailableForTurn: () => owner.isMcpDiscoveryUnavailableForTurn(),
  };
  const glue = createPromptCollectorGlue<Context>(host);
  return {
    ...glue,
    createFileTransferController: (): FileTransferController => ({
      agentBox: owner.remoteBox,
      userComputers: owner.userComputers,
      getBoxId: () => owner.resolveBoxId(),
      getComputerAgentId: () => owner.getConversationId(),
      isBoxPreparing: () => boxIsPreparing(owner.remoteBox, owner.resolveBoxId()),
    }),
    createMcpTextSpiller: () => {
      if (!isLargeOutputSpillEnabled()) return undefined;
      const agentId = owner.getConversationId();
      return createSandMcpTextSpiller({
        uploadTextFile: (ctx, relativePath, data) =>
          owner.box.uploadFile(ctx, agentId, relativePath, data),
      });
    },
  };
}
