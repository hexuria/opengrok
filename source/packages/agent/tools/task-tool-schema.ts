import { z } from "zod";

import { GENERAL_PURPOSE_SUBAGENT_TYPE, getSubagentTypeName, normalizeSubagentTypeName } from "./core/subagent/subagent-config.js";
import { buildAvailableModelsDescription, type SubagentModels } from "./core/subagent/models.js";

const EXPLORE_SUBAGENT_TYPE = "explore";
const TASK_RESUME_SELF_SENTINEL = "self";

export type TaskResumeMode = "DEFAULT" | "LAST_AGENT" | "LAST_AGENT_SAME_TYPE";

export interface TaskSchemaSubagentConfig {
  readonly subagent_type: Parameters<typeof getSubagentTypeName>[0];
  readonly description?: string | undefined;
  readonly resumeModeOverride?: TaskResumeMode | undefined;
}

export interface TaskPlacementSchemaOptions {
  readonly includeEnvironmentBuildId: boolean;
  readonly includeSelfHostedTargets: boolean;
}

export interface TaskParametersSchemaOptions {
  readonly allowCustomModelId?: boolean;
  readonly subagentModels?: SubagentModels;
  readonly subagentModelsInUserInfo?: boolean;
  readonly subagentInheritGuidance?: boolean;
  readonly useClientSideSubagent?: boolean;
  readonly includeRunInBackgroundInTaskSchema?: boolean;
  readonly defaultSubagentsRunInBackground?: boolean;
  readonly enableSubagentInterrupt?: boolean;
  readonly environmentParamForSubagent?: boolean;
  readonly requestedEnvironmentBuildParamForSubagent?: boolean;
  readonly cloudSubagentTargeting?: boolean;
  readonly allowResumeSelfFork?: boolean;
  readonly enableMultitaskMode?: boolean;
  readonly taskToolNotificationHintsEnabled?: boolean;
  readonly hideAsyncSubagentTaskNotifications?: boolean;
  readonly enableAgentChatLinks?: boolean;
}

export interface TaskParametersSchemaResult {
  readonly schemaTowardsModel: z.ZodTypeAny;
  readonly schemaForParsing: z.ZodTypeAny;
}

const blankToUndefined = (value: unknown): unknown => typeof value === "string" && value.trim() === "" ? undefined : value;

const sameMachineSchema = z.object({ type: z.literal("same_machine") }).strict().describe("Run on this machine, sharing its checkout and branch. The default.");

const selfHostedWorkerSchema = z.object({
  type: z.literal("self_hosted_worker"),
  worker_id: z.string().min(1).describe("Worker to run on, from cursor-cloud-list-self-hosted-workers. Only your own machines can be targeted this way; use self_hosted_pool for a team pool worker. Check that tool's sharedAssignmentAllowed first: a shared worker runs this subagent alongside others, otherwise the subagent waits for the worker to free up."),
}).strict().describe("Run on one specific self-hosted worker of your own. The subagent uses that machine's existing checkout and branch, so it cannot be given a base branch.");

const selfHostedPoolSchema = z.object({
  type: z.literal("self_hosted_pool"),
  pool: z.string().optional().describe("Pool to draw a worker from. Defaults to the team's default pool."),
  labels: z.record(z.string()).optional().describe("Key/value labels a candidate worker must all match."),
}).strict().describe("Run on any free worker in a self-hosted pool. Pool workers are claimed exclusively, so the subagent queues until one is free.");

export function buildTargetMachineField(options: TaskPlacementSchemaOptions): z.ZodTypeAny {
  const newCloudVmSchema = z.object({
    type: z.literal("new_cloud_vm"),
    base_branch: z.preprocess(blankToUndefined, z.string().optional().describe("Branch the subagent's own generated branch starts from. Defaults to the current branch. Uses the remote version, so uncommitted or unpushed work is not visible.")),
    ...(options.includeEnvironmentBuildId ? {
      environment_build_id: z.preprocess(blankToUndefined, z.string().optional().describe("Exact environment build id (e.g. bld-YYYYMMDD-<uuid>) for the subagent's VM to boot from, instead of the environment's latest successful build. Must belong to the same team and environment; an invalid or inaccessible build fails the subagent.")),
    } : {}),
  }).strict().describe("Run on a dedicated cloud VM with its own clone and generated branch. After the subagent finishes, follow user instructions on whether to merge that branch, check it out, or neither.");
  const description = "Optional placement: where the subagent runs. Omit to run on this machine, which is almost always right. ONLY set this if the user explicitly asks for a cloud subagent or a specific machine.";
  if (options.includeSelfHostedTargets) {
    return z.discriminatedUnion("type", [sameMachineSchema, newCloudVmSchema, selfHostedWorkerSchema, selfHostedPoolSchema]).optional().describe(description);
  }
  return z.discriminatedUnion("type", [sameMachineSchema, newCloudVmSchema]).optional().describe(description);
}

function stringChoice(values: string[], description: string): z.ZodType<string> {
  return z.string().refine(value => values.includes(value), {
    message: `Invalid value. Expected one of: ${values.join(", ")}`,
  }).describe(description);
}

export function buildTaskParametersSchema(configs: readonly TaskSchemaSubagentConfig[], options: TaskParametersSchemaOptions): TaskParametersSchemaResult {
  const inheritGuidance = options.subagentInheritGuidance ?? options.subagentModelsInUserInfo === true;
  const baseModelDescription = inheritGuidance
    ? "Optional model slug for this agent. If provided, it must resolve to one of the available model slugs. If omitted, the subagent uses the same model as the parent agent. Do not pass if resume field is set (prior model will be used). Use \"inherit\" unless the user explicitly requested another listed model."
    : "Optional model slug for this agent. If provided, it must resolve to one of the available model slugs. If omitted, the subagent uses the same model as the parent agent. Do not pass if resume field is set (prior model will be used). Only choose an explicit model when the user directly requests it.";
  const configNames = configs.map(config => getSubagentTypeName(config.subagent_type));
  const normalizedToCanonical = new Map<string, string>();
  for (const canonicalName of configNames) normalizedToCanonical.set(normalizeSubagentTypeName(canonicalName), canonicalName);
  const defaultSubagentTypeName = configNames.includes(GENERAL_PURPOSE_SUBAGENT_TYPE) ? GENERAL_PURPOSE_SUBAGENT_TYPE : configNames[0] ?? GENERAL_PURPOSE_SUBAGENT_TYPE;
  const preprocessSubagentType = (value: unknown): unknown => {
    if (value === undefined) return defaultSubagentTypeName;
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (trimmed.length === 0) return defaultSubagentTypeName;
    return normalizedToCanonical.get(normalizeSubagentTypeName(trimmed)) ?? trimmed;
  };
  const typeDescription = options.subagentModelsInUserInfo === true
    ? "Subagent type to use for this task. Available types are listed in the initial user-info message."
    : `Subagent type to use for this task. Must be one of: ${configNames.join(", ")}.`;
  const parsingSubagentTypeField = z.preprocess(preprocessSubagentType, stringChoice(configNames.length > 0 ? configNames : [GENERAL_PURPOSE_SUBAGENT_TYPE], typeDescription));
  const modelFacingSubagentTypeField = options.subagentModelsInUserInfo === true
    ? z.preprocess(preprocessSubagentType, z.string().describe(typeDescription))
    : parsingSubagentTypeField;
  const promptField = z.string().refine(value => value.trim().length > 0, { message: "prompt is required" }).describe("The task for the agent to perform");
  const modelField = z.preprocess(value => value === null ? undefined : value, z.string().optional()).describe(baseModelDescription);
  const baseResumeDescription = options.useClientSideSubagent
    ? `Optional agent ID to resume from. If provided, sends a follow-up message to the agent after it has completed. Requests to a currently running asynchronous agent ${options.enableSubagentInterrupt ? "fail unless `interrupt` is true; set `interrupt` to true only when you intend to interrupt the current run." : "fail; wait for completion before resuming."}`
    : "Optional agent ID to resume from. If provided, the agent will continue from the previous execution transcript.";
  const resumeFieldDescription = options.allowResumeSelfFork ? `${baseResumeDescription} Use \"${TASK_RESUME_SELF_SENTINEL}\" to start a new agent with your own entire conversation history as a starting point (aka 'self-fork').` : baseResumeDescription;
  const resumeField = z.string().optional().describe(resumeFieldDescription);
  const interruptField = z.boolean().optional().describe("If true and `resume` targets a running async agent, interrupt the current run and send this prompt immediately. Only use when the user explicitly asks to interrupt or change what the running agent is doing.");
  const fileAttachmentsField = z.array(z.string()).optional().describe("Optional array of file paths to images or videos to pass to video-review subagents. Files are read and attached to the subagent's context. Use to forward relevant media (e.g. images sent by user) to subagents.");
  const environmentField = z.enum(["local", "cloud"]).optional().describe('Optional execution environment for the subagent. Use "local" (default) for normal local subagents, or "cloud" to run the subagent as a cloud agent (i.e. in its own separate worktree). ONLY set to cloud if the user explicitly requests cloud. DO NOT set to cloud if user does not request cloud. Cloud subagents will work on their own git branch on their own VM. After subagent completion, follow user instructions on whether to merge that branch, check it out, or neither.');
  const cloudBaseBranchField = z.preprocess(blankToUndefined, z.string().optional().describe("Base branch for the cloud subagent's branch to start from. Default is current branch. Uses remote version of branch; uncommitted or un-pushed branches will fail. Only specify this parameter if environment equals cloud."));
  const cloudRequestedEnvironmentBuildIdField = z.preprocess(blankToUndefined, z.string().optional().describe("Exact environment build id (e.g. bld-YYYYMMDD-<uuid>) for the cloud subagent's VM to boot from, instead of the environment's latest successful build. Use to test a specific environment build in an isolated cloud subagent. Only specify this parameter if environment equals cloud. The build must belong to the same team and environment; an invalid or inaccessible build fails the subagent."));
  const machineField = buildTargetMachineField({
    includeEnvironmentBuildId: options.requestedEnvironmentBuildParamForSubagent === true,
    includeSelfHostedTargets: options.cloudSubagentTargeting === true,
  });

  const buildSchema = (descriptionField: z.ZodTypeAny, subagentTypeField: z.ZodTypeAny, forParsing: boolean): z.ZodTypeAny => {
    const baseObjectSchema = z.object({ description: descriptionField, prompt: promptField, model: modelField, resume: resumeField, subagent_type: subagentTypeField, file_attachments: fileAttachmentsField });
    const legacyPlacementFields = {
      environment: environmentField,
      cloud_base_branch: cloudBaseBranchField,
      ...(options.requestedEnvironmentBuildParamForSubagent ? { cloud_requested_environment_build_id: cloudRequestedEnvironmentBuildIdField } : {}),
    };
    const schemaWithEnvironment = !options.environmentParamForSubagent
      ? baseObjectSchema
      : options.cloudSubagentTargeting === true
        ? baseObjectSchema.extend({ machine: machineField, ...(forParsing ? legacyPlacementFields : {}) })
        : baseObjectSchema.extend({ ...legacyPlacementFields, ...(forParsing ? { machine: machineField } : {}) });
    const schemaWithInterrupt = options.useClientSideSubagent && options.enableSubagentInterrupt ? schemaWithEnvironment.extend({ interrupt: interruptField }) : schemaWithEnvironment;
    const objectSchema = options.includeRunInBackgroundInTaskSchema === true
      ? schemaWithInterrupt.extend({
        run_in_background: z.preprocess(value => value === "true" ? true : value === "false" ? false : value, z.boolean()).optional().describe("Run the agent in the background (returns output_file path to check later)." + (options.defaultSubagentsRunInBackground === true ? " Defaults true." : "") + " If this is false, you will be blocked until the agent completes." + (options.enableMultitaskMode ? " If the user is currently in Multitask Mode, always set this parameter to True." : "") + (options.taskToolNotificationHintsEnabled ? " When true, the background subagent will send a notification when it completes." : "")),
      })
      : schemaWithInterrupt;
    return objectSchema.superRefine((args, ctx) => {
      if ("environment" in args && args.environment === "cloud") return;
      if ("cloud_base_branch" in args && args.cloud_base_branch !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cloud_base_branch"], message: "cloud_base_branch may only be specified when environment equals cloud" });
      if ("cloud_requested_environment_build_id" in args && args.cloud_requested_environment_build_id !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cloud_requested_environment_build_id"], message: "cloud_requested_environment_build_id may only be specified when environment equals cloud" });
    });
  };
  const descriptionFieldDescription = "A short, user-friendly title for the subagent. This appears in the UI as the subagent's name. Make it concrete and distinct, consider recent titles to avoid reuse. For resumed subagents which you are prompting to work on a separate task, give an updated description based on the latest work the subagent is performing. (Do not rename if the subagent is continuing work on the same high-level task.)";
  return {
    schemaTowardsModel: buildSchema(z.string().describe(descriptionFieldDescription), modelFacingSubagentTypeField, false),
    schemaForParsing: buildSchema(z.string().default("").describe(descriptionFieldDescription), parsingSubagentTypeField, true),
  };
}

export interface TaskDescriptionPartsOptions {
  readonly configs: readonly TaskSchemaSubagentConfig[];
  readonly defaultResumeMode: TaskResumeMode;
  readonly includeExploreSubagent?: boolean;
  readonly useClientSideSubagent?: boolean;
  readonly enableSubagentInterrupt?: boolean;
  readonly taskToolNotificationHintsEnabled?: boolean;
  readonly hideAsyncSubagentTaskNotifications?: boolean;
  readonly allowResumeSelfFork?: boolean;
  readonly enableAgentChatLinks?: boolean;
  readonly subagentModels: SubagentModels;
  readonly subagentModelsInUserInfo?: boolean;
  readonly subagentInheritGuidance?: boolean;
  readonly catalogsInUserInfo?: boolean;
  readonly toolLabel: string;
  readonly readToolName?: string;
  readonly globToolName?: string;
  readonly subagentExperimentGroup?: string;
}

export interface TaskDescriptionParts {
  readonly baseDescription: string;
  readonly subagentTypeDescriptionsText: string;
  readonly modelsDescription: string;
  readonly fullDescription: string;
}

interface TaskDescriptionBaseOptions {
  readonly includeExploreSubagent?: boolean | undefined;
  readonly subagentModelsInUserInfo?: boolean | undefined;
  readonly useClientSideSubagent?: boolean | undefined;
  readonly enableSubagentInterrupt?: boolean | undefined;
  readonly taskToolNotificationHintsEnabled?: boolean | undefined;
  readonly hideAsyncSubagentTaskNotifications?: boolean | undefined;
  readonly allowResumeSelfFork?: boolean | undefined;
  readonly enableAgentChatLinks?: boolean | undefined;
  readonly toolLabel: string;
  readonly readToolName?: string | undefined;
  readonly globToolName?: string | undefined;
  readonly subagentExperimentGroup?: string | undefined;
}

export function buildTaskToolDescriptionBase(args: TaskDescriptionBaseOptions): string {
  const includeExploreProactiveRecommendation = !args.subagentModelsInUserInfo && args.subagentExperimentGroup !== "no-subagent-unless-asked";
  const doNotUseExamples = [
    ...(args.readToolName ? [`  - If you want to read a specific file path, use the ${args.readToolName}${args.globToolName ? ` or ${args.globToolName}` : ""} tool instead of the ${args.toolLabel} tool, to find the match more quickly`, `  - If you are searching for code within a specific file or set of 2-3 files, use the ${args.readToolName} tool instead of the ${args.toolLabel} tool, to find the match more quickly`] : []),
    ...(args.globToolName ? [`  - If you are searching for a specific class definition like "class Foo", use the ${args.globToolName} tool instead of the ${args.toolLabel} tool, to find the match more quickly`] : []),
  ].join("\n");
  const exploreRecommendation = args.includeExploreSubagent ? `
${includeExploreProactiveRecommendation ? `
VERY IMPORTANT: When broadly exploring the codebase to gather context for a large task, it is recommended that you use the ${args.toolLabel} tool with subagent_type="${EXPLORE_SUBAGENT_TYPE}" instead of running search commands directly.
` : ""}
If the query is a narrow or specific question, you should NOT use the ${args.toolLabel} and instead address the query directly using the other tools available to you.

Examples:
- user: "Where is the ClientError class defined?" assistant: [Uses Grep directly - this is a needle query for a specific class]
- user: "Run this query using my database API" assistant: [Calls the MCP directly - this is not a broad exploration task]
- user: "What is the codebase structure?" assistant: [Uses the ${args.toolLabel} tool with subagent_type="${EXPLORE_SUBAGENT_TYPE}"]

If it is possible to explore different areas of the codebase in parallel, you should launch multiple agents concurrently.` : "";
  const resultVisibilityNote = args.taskToolNotificationHintsEnabled
    ? args.hideAsyncSubagentTaskNotifications ? "- When the agent is done, it will return a single message back to you. Specify exactly what information the agent should return back to you." : "- When the agent is done, it will return a single message back to you. Specify exactly what information the agent should return back to you. Background subagent completion messages already include a user-visible summary portion; do not summarize or restate a single background subagent's result by default. Respond only when the user asks, multiple background subagents need synthesis, or the background subagent reports a blocker requiring parent action outside of the user-visible high level summary." : "- When the agent is done, it will return a single message back to you. Specify exactly what information the agent should return back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.";
  const resumeBehavior = args.useClientSideSubagent ? args.enableSubagentInterrupt ? "This sends a follow-up message after the agent has completed, preserving existing context. If the agent is still running, the request fails unless `interrupt` is true. Set `interrupt` to true only when the user explicitly wants to interrupt the running agent." : "This sends a follow-up message after the agent has completed, preserving existing context. If the agent is still running, the request fails; wait for completion before resuming." : "When resumed, the agent continues with its full previous context preserved.";
  return `Launch a new agent to handle complex, multi-step tasks autonomously.

The ${args.toolLabel} tool launches specialized subagents (subprocesses) that autonomously handle complex tasks. Each subagent_type has specific capabilities and tools available to it.

When using the ${args.toolLabel} tool, you must specify a subagent_type parameter to select which agent type to use.${exploreRecommendation}

When NOT to use the ${args.toolLabel} tool:
- Simple, single or few-step tasks that can be performed by a single agent (using parallel or sequential tools) -- just call the tools directly instead.
${doNotUseExamples.length > 0 ? `- For example:
${doNotUseExamples}` : ""}

Usage notes:
- Always include a short description (3-5 words) summarizing what the agent will do
- Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses.
${resultVisibilityNote}
- Agents can be resumed using the \`resume\` parameter by passing the agent ID from a previous invocation. ${resumeBehavior}${args.allowResumeSelfFork ? ` You can also set \`resume\` to "${TASK_RESUME_SELF_SENTINEL}" to fork the current parent agent into a new child subagent.` : ""} When NOT resuming, each invocation starts fresh and you should provide a detailed task description with all necessary context for the agent to perform its task autonomously.
${args.enableAgentChatLinks ? "- In user-facing responses, you may link to agents and subagents with the `[Name](id)` format.\n" : ""}- When using the ${args.toolLabel} tool, the subagent invocation does not have access to the user's message or prior assistant steps. Therefore, you should provide a highly detailed task description with all necessary context for the subagent to perform its task autonomously.
- The subagent's outputs should generally be trusted
- Clearly tell the subagent which tasks you want it to perform, since it is not aware of the user's intent or your prior assistant steps (tool calls, messages, or context).
- If the subagent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it. Use your judgement.`;
}

function formatSubagentConfigForDescription(config: TaskSchemaSubagentConfig, defaultResumeMode: TaskResumeMode): string {
  const name = getSubagentTypeName(config.subagent_type);
  const effectiveResumeMode = config.resumeModeOverride ?? defaultResumeMode;
  let description = config.description ?? "";
  if (effectiveResumeMode !== "DEFAULT") {
    const resumeNote = effectiveResumeMode === "LAST_AGENT_SAME_TYPE" ? " (Auto-resumes most recent agent of this type; `resume` arg is ignored)" : " (Auto-resumes most recent agent; `resume` arg is ignored)";
    description = description ? `${description}${resumeNote}` : resumeNote;
  }
  return description ? `- ${name}: ${description}` : `- ${name}`;
}

export function buildTaskToolDescriptionParts(options: TaskDescriptionPartsOptions): TaskDescriptionParts {
  const catalogsInUserInfo = options.catalogsInUserInfo ?? options.subagentModelsInUserInfo;
  const subagentInheritGuidance = options.subagentInheritGuidance ?? options.subagentModelsInUserInfo;
  const baseDescription = buildTaskToolDescriptionBase({
    includeExploreSubagent: options.includeExploreSubagent && options.configs.some(config => getSubagentTypeName(config.subagent_type) === EXPLORE_SUBAGENT_TYPE),
    subagentModelsInUserInfo: options.subagentModelsInUserInfo,
    useClientSideSubagent: options.useClientSideSubagent,
    enableSubagentInterrupt: options.enableSubagentInterrupt,
    taskToolNotificationHintsEnabled: options.taskToolNotificationHintsEnabled,
    hideAsyncSubagentTaskNotifications: options.hideAsyncSubagentTaskNotifications,
    allowResumeSelfFork: options.allowResumeSelfFork,
    enableAgentChatLinks: options.enableAgentChatLinks,
    toolLabel: options.toolLabel,
    readToolName: options.readToolName,
    globToolName: options.globToolName,
    subagentExperimentGroup: options.subagentExperimentGroup,
  });
  const sections = [baseDescription];
  let subagentTypeDescriptionsText = "";
  if (options.configs.length > 0) {
    subagentTypeDescriptionsText = `Available subagent_types and a quick description of what they do:\n${options.configs.map(config => formatSubagentConfigForDescription(config, options.defaultResumeMode)).join("\n")}`;
    sections.push(catalogsInUserInfo ? "Available subagent_types and descriptions are listed in <available_subagent_types> in the initial user-info message at the start of this conversation." : subagentTypeDescriptionsText);
  }
  const modelsDescription = buildAvailableModelsDescription(options.subagentModels, subagentInheritGuidance);
  sections.push(catalogsInUserInfo ? "Available model slugs for subagents are listed in <available_subagent_models> in the initial user-info message at the start of this conversation." : modelsDescription);
  return { baseDescription, subagentTypeDescriptionsText, modelsDescription, fullDescription: sections.join("\n\n") };
}
