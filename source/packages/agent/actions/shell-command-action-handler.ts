import { randomUUID } from "node:crypto";
import { AgentMode } from "../../proto/generated/agent/v1/agent_pb.js";
import { createLogger } from "../../context/index.js";
import { DataClassification, PrivacyCapability } from "../../redaction/classification.js";
import { toRedactedCoreMessages } from "../../redaction/core-message.js";
import { createRedactedString } from "../../redaction/factory.js";
import { PrivacyMode } from "../../redaction/privacy-mode.js";
import {
  createRedactedShellArgs,
  createRedactedShellCommandParsingResult,
  createRedactedShellStreamExit,
  createRedactedShellStreamStderr,
  createRedactedShellStreamStart,
  createRedactedShellStreamStdout,
  fromRedactedShellArgs,
  toRedactedShellStream,
} from "../../redacted-protos/generated/agent/v1/shell_exec_redacted.js";
import { createRedactedShellOutput } from "../../redacted-protos/generated/agent/v1/agent_redacted.js";
import { RedactedUpdates } from "../../agent-core/redacted-interaction-updates.js";
import { shellStreamExecutorResource } from "../../agent-exec/shell-stream.js";
import { getBrowserToolNames } from "../common.js";
import { getAllRules } from "./common.js";
import { buildRequestContextOptions, buildUserInfoAgentNotesProps } from "./meta-agent-notes.js";
import { isProjectWorkspaceConversation } from "../configs/project-workspace-mcp-tools.js";
import { getRequestContext } from "../utils/request-context.js";
import { getComposer2CloudTestingSectionsPlacement } from "../prompts/composer2-cloud-testing-sections.js";
import { extractToolInfo } from "../prompts/system.js";
import { UserInfo } from "../prompts/user-info-component.js";
import { withToolSetMcpSnapshot } from "../utils/mcp-meta-tool.js";
import { getMcpMetaToolOptionsWithCustomUserTools } from "../utils/mcp-custom-user-tools.js";
import { FileOperationLockManager } from "../tools/core/file-operation-lock-manager.js";
import { formatShellResult, formatShellResultDsv3 } from "../tools/core/shell/formatters.js";

type Any = any;

const logger = createLogger("@anysphere/agent/actions/shell-command-action-handler");

export class ShellCommandActionHandler {
  constructor(
    readonly config: Any,
    readonly resourceAccessor: Any,
    readonly interactionListener: Any,
    readonly summarizationHandler: Any,
    readonly conversationActionReceiver: Any,
  ) {}

  async handle(
    ctx: Any,
    action: Any,
    rootPromptExecutor: Any,
    stateHandler: Any,
    mcpTools: Any,
    _onStateUpdate: Any,
  ): Promise<Any> {
    const shellCommand = action.shellCommand;
    if (!shellCommand) throw new Error("Shell command is required");
    const command = shellCommand.command;
    const turn = await stateHandler.createShellTurn(ctx, shellCommand);
    let stdout = createRedactedString("", DataClassification.CODE, "stdout", action._privacyMode);
    let stderr = createRedactedString("", DataClassification.CODE, "stderr", action._privacyMode);
    let combinedOutput = createRedactedString("", DataClassification.CODE, "combinedOutput", action._privacyMode);
    let exitCode = 0;
    const shellExec = this.resourceAccessor.get(shellStreamExecutorResource);
    const args = createRedactedShellArgs(action._privacyMode, {
      command,
      parsingResult: createRedactedShellCommandParsingResult(action._privacyMode, {}),
      // User explicitly typed this command in shell mode, so skip permission prompts.
      // No classifier call is needed because skipApproval bypasses the permission check.
      skipApproval: true,
    });
    const result = shellExec.execute(ctx, fromRedactedShellArgs(args, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined), { execId: action.execId });
    const skipInteractionUpdates = !!action.execId;
    try {
      for await (const unredStream of result) {
        const stream: Any = toRedactedShellStream(unredStream, action._privacyMode);
        switch (stream.event.case) {
          case "start":
            if (!skipInteractionUpdates) {
              await this.interactionListener.sendUpdate(ctx, RedactedUpdates.shellOutputDelta(stream._privacyMode, {
                case: "start",
                value: createRedactedShellStreamStart(stream._privacyMode, { sandboxPolicy: stream.event.value.sandboxPolicy }),
              }));
            }
            break;
          case "stdout": {
            const data = stream.event.value.data.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
            stdout = stdout.safeTransform(value => value + data);
            combinedOutput = combinedOutput.safeTransform(value => value + data);
            if (!skipInteractionUpdates) {
              await this.interactionListener.sendUpdate(ctx, RedactedUpdates.shellOutputDelta(stream._privacyMode, {
                case: "stdout",
                value: createRedactedShellStreamStdout(stream._privacyMode, { data: stream.event.value.data }),
              }));
            }
            break;
          }
          case "stderr": {
            const data = stream.event.value.data.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
            stderr = stderr.safeTransform(value => value + data);
            combinedOutput = combinedOutput.safeTransform(value => value + data);
            if (!skipInteractionUpdates) {
              await this.interactionListener.sendUpdate(ctx, RedactedUpdates.shellOutputDelta(stream._privacyMode, {
                case: "stderr",
                value: createRedactedShellStreamStderr(stream._privacyMode, { data: stream.event.value.data }),
              }));
            }
            break;
          }
          case "exit":
            exitCode = stream.event.value.code | 0;
            if (!skipInteractionUpdates) {
              await this.interactionListener.sendUpdate(ctx, RedactedUpdates.shellOutputDelta(stream._privacyMode, {
                case: "exit",
                value: createRedactedShellStreamExit(stream._privacyMode, { code: stream.event.value.code, aborted: stream.event.value.aborted }),
              }));
            }
            break;
        }
      }
    } catch (error) {
      logger.error(ctx, "Shell command action handler error", error);
    }
    turn.recordShellOutput(createRedactedShellOutput(action._privacyMode, { stdout, stderr, exitCode }));
    const toolCallId = randomUUID();
    const commandText = command.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
    let text = `Run the following command: ${commandText}`;
    if (stateHandler.isDsv3()) text = `<user_query>\n${text}\n</user_query>`;
    const userMessage = { role: "user", content: [{ type: "text", text }] };
    const toolName = stateHandler.isDsv3() ? "run_terminal_cmd" : "Shell";
    const assistantMessage = { role: "assistant", content: [{ type: "tool-call", toolCallId, toolName, args: { command: commandText } }] };
    const toolCallResult = {
      role: "tool",
      id: toolCallId,
      content: [{
        type: "tool-result",
        toolCallId,
        toolName,
        result: stateHandler.isDsv3()
          ? formatShellResultDsv3({ combinedOutput: combinedOutput.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), exitCode, command: commandText }, commandText)
          : formatShellResult({ combinedOutput: combinedOutput.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), exitCode }),
      }],
    };
    if (rootPromptExecutor.getMessages().length === 0) {
      const requestContext = await getRequestContext(ctx, undefined, this.resourceAccessor, buildRequestContextOptions(this.config));
      const rules = getAllRules(requestContext, this.config.nonFileRules, this.config.featureFlags);
      const modeForPrompt = stateHandler.mode ?? AgentMode.AGENT;
      const toolSetHandle = this.config.toolsGenerator({
        resourceAccessor: this.resourceAccessor,
        stateHandler,
        agentSessionId: this.config.agentSessionId,
        mcpTools,
        repositoryInfos: requestContext.repositoryInfo,
        blobStore: stateHandler.getBlobStore(),
        mode: modeForPrompt,
        loggingContext: ctx,
        requestContext,
        fileOperationLockManager: new FileOperationLockManager(),
        smartModeClassifierMode: this.config.smartModeClassifierMode,
        smartModeClassifierShadowMode: this.config.smartModeClassifierShadowMode,
        autoRejectFirstAskQuestion: this.config.autoRejectFirstAskQuestion,
      });
      rootPromptExecutor.appendMessages(toRedactedCoreMessages([{
        role: "system",
        content: this.config.systemPromptGenerator({
          requestContext,
          cursorRules: rules,
          env: requestContext.env,
          browserTools: getBrowserToolNames(mcpTools),
          cloudRule: requestContext.cloudRule ?? undefined,
          mode: modeForPrompt,
        }, toolSetHandle),
      }], stateHandler.getPrivacyMode()));
      if (!this.config.userInfoDisplayOptions?.disable) {
        const isRootProject = await isProjectWorkspaceConversation(ctx, stateHandler);
        const placement = getComposer2CloudTestingSectionsPlacement({
          modelInfo: this.config.modelInfo,
          enableComposer2IntelligentTestingPromptSection: this.config.enableComposer2IntelligentTestingPromptSection,
          backgroundAgentSource: this.config.backgroundAgentSource,
          agentType: this.config.agentType,
          enableCloudTesting: this.config.enableCloudTesting,
          featureFlags: this.config.featureFlags,
          namedAgentSessionKind: this.config.namedAgentSessionKind,
          isCloudMetaAgentParent: this.config.isCloudMetaAgentParent,
        });
        const userInfoMcpMetaToolOptions = withToolSetMcpSnapshot(getMcpMetaToolOptionsWithCustomUserTools(requestContext.mcpMetaToolOptions, mcpTools), toolSetHandle);
        rootPromptExecutor.appendMessages(toRedactedCoreMessages([{
          role: "user",
          content: UserInfo({
            cursorRules: rules,
            agentSkills: requestContext.agentSkills,
            env: requestContext.env,
            gitRepos: requestContext.gitRepos,
            gitRepoInfoComplete: requestContext.gitRepoInfoComplete,
            cloudRule: requestContext.cloudRule ?? undefined,
            mode: modeForPrompt,
            isRootProject,
            dsv3: stateHandler.isDsv3(),
            displayOptions: this.config.userInfoDisplayOptions,
            mcpInfoComplete: requestContext.mcpInfoComplete,
            mcpInstructions: requestContext.mcpInstructions,
            mcpFileSystemOptions: requestContext.mcpFileSystemOptions,
            mcpMetaToolOptions: userInfoMcpMetaToolOptions,
            userIntentSummary: requestContext.userIntentSummary,
            featureFlags: this.config.featureFlags,
            enableFilterEditToolsInAskMode: this.config.enableFilterEditToolsInAskMode,
            skipMcpInstructions: (requestContext.mcpFileSystemOptions?.enabled ?? false) || (userInfoMcpMetaToolOptions?.enabled ?? false),
            hooksAdditionalContext: requestContext.hooksAdditionalContext,
            automationInstructions: this.config.automationInstructions,
            ...(this.config.enableTerminalFiles !== false && { terminalsFolder: requestContext.env?.terminalsFolder }),
            ...buildUserInfoAgentNotesProps(this.config, modeForPrompt, requestContext.env),
            designatedBranches: this.config.designatedBranches,
            branchPrefix: this.config.branchPrefix,
            branchSuffix: this.config.branchSuffix,
            preferCurrentBranchInMultiPrMode: this.config.preferCurrentBranchInMultiPrMode,
            toolInfo: extractToolInfo(toolSetHandle) as Any,
            browserTools: getBrowserToolNames(mcpTools),
            agentType: this.config.agentType,
            backgroundAgentSource: this.config.backgroundAgentSource,
            isSlackV1_5: this.config.isSlackV1_5,
            namedAgentSessionKind: this.config.namedAgentSessionKind,
            enableCloudTesting: this.config.enableCloudTesting,
            useLocalAgentPrompting: this.config.useLocalAgentPrompting,
            isRepoless: this.config.isRepoless,
            modelInfo: this.config.modelInfo,
            agentTokenLimit: this.config.agentTokenLimit,
            enableComposer2IntelligentTestingPromptSection: this.config.enableComposer2IntelligentTestingPromptSection,
          }),
          ...(placement !== undefined && { providerOptions: { cursor: { composer2CloudTestingSectionsPlacement: placement } } }),
        }], stateHandler.getPrivacyMode()));
      }
    }
    rootPromptExecutor.appendMessages(toRedactedCoreMessages([userMessage, assistantMessage, toolCallResult], stateHandler.getPrivacyMode()));
    return stateHandler.computeNewStructure(ctx);
  }
}
