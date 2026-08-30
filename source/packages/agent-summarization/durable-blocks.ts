import { PrivacyCapability } from "../redaction/classification.js";
import { formatTranscriptLocation } from "./transcript-location.js";

export type DurableBlockSummarizer =
  | "external"
  | "self-summary"
  | "openai-compaction"
  | "anthropic-compaction"
  | "xai-compaction";

type DurableBlockId =
  | "mode-prompt"
  | "project-root"
  | "plan"
  | "transcript"
  | "automation-trigger"
  | "todos"
  | "skills";

const SUMMARIZERS: Record<DurableBlockSummarizer, { leading: DurableBlockId[]; trailing: DurableBlockId[] }> = {
  external: {
    leading: [],
    trailing: ["plan", "transcript", "mode-prompt", "project-root", "automation-trigger", "todos", "skills"],
  },
  "self-summary": {
    leading: ["mode-prompt", "project-root"],
    trailing: ["transcript", "todos", "automation-trigger", "skills"],
  },
  "openai-compaction": {
    leading: ["mode-prompt", "project-root"],
    trailing: ["todos", "automation-trigger", "skills", "transcript"],
  },
  "anthropic-compaction": {
    leading: ["mode-prompt", "project-root"],
    trailing: ["transcript", "todos", "automation-trigger", "skills"],
  },
  "xai-compaction": {
    leading: [],
    trailing: ["plan", "mode-prompt", "project-root", "todos", "automation-trigger", "skills", "transcript"],
  },
};

const BLOCK_SEPARATOR = "\n\n";

export interface DurablePlan {
  readonly content: { unwrap(purpose: PrivacyCapability): string };
  readonly name?: string | undefined;
  readonly composerId?: string | undefined;
}

export interface DurableBlockEnrichments {
  readonly modePrompt?: string | undefined;
  readonly projectRootPrompt?: string | undefined;
  readonly currentPlan?: DurablePlan | null | undefined;
  readonly agentTranscriptsFolder?: string | undefined;
  readonly conversationId?: string | undefined;
  readonly automationTriggerContext?: string | undefined;
  readonly todoContent?: string | undefined;
  readonly skillBlocks: readonly string[];
}

export interface DurableBlockRenderContext {
  readonly includeTranscript?: boolean | undefined;
}

function todoUpdateTag(todoContent: string): string {
  return `<todo_update>\n${todoContent}\n</todo_update>`;
}

function unwrapPlanContent(plan: DurablePlan): string | undefined {
  const rawContent = plan.content.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
  return rawContent && rawContent.trim().length > 0 ? rawContent : undefined;
}

function planFilePath(plan: DurablePlan): string {
  const planName = plan.name || "plan";
  const planFilename = planName.endsWith(".plan.md") ? planName : `${planName}.plan.md`;
  return plan.composerId
    ? `cursor-plan://${plan.composerId}/${planFilename}`
    : `cursor-plan:///${planFilename}`;
}

function renderTranscript(agentTranscriptsFolder: string, conversationId: string | undefined, useXml: boolean): string {
  const section = formatTranscriptLocation(agentTranscriptsFolder, { conversationId, useXml });
  return section.startsWith(BLOCK_SEPARATOR) ? section.slice(BLOCK_SEPARATOR.length) : section;
}

type Renderer = (enrichments: DurableBlockEnrichments, context: DurableBlockRenderContext) => string | undefined;
interface BlockRenderer { readonly render: Renderer; readonly overrides?: Partial<Record<DurableBlockSummarizer, Renderer>> }

const BLOCK_RENDERERS: Record<DurableBlockId, BlockRenderer> = {
  "mode-prompt": { render: enrichments => enrichments.modePrompt },
  "project-root": { render: enrichments => enrichments.projectRootPrompt },
  plan: {
    render: enrichments => {
      if (!enrichments.currentPlan) return undefined;
      const content = unwrapPlanContent(enrichments.currentPlan);
      if (content === undefined) return undefined;
      const instruction = "The below plan was previously created in this session. If you are still in plan mode, continue to iterate on the plan with the user given the rest of your context on the current conversation. Otherwise, if there are remaining relevant todos, you should continue to implement them according to the plan.";
      return `10. Current plan mode progress:\n   ${instruction}\n\n<file_contents path="${planFilePath(enrichments.currentPlan)}" isFullFile="true">\n${content}\n</file_contents>`;
    },
    overrides: {
      "xai-compaction": enrichments => {
        if (!enrichments.currentPlan) return undefined;
        const content = unwrapPlanContent(enrichments.currentPlan);
        return content === undefined ? undefined : `<current_plan>\n${content}\n</current_plan>`;
      },
    },
  },
  transcript: {
    render: (enrichments, context) => context.includeTranscript !== false && enrichments.agentTranscriptsFolder
      ? renderTranscript(enrichments.agentTranscriptsFolder, enrichments.conversationId, true)
      : undefined,
    overrides: {
      external: (enrichments, context) => context.includeTranscript !== false && enrichments.agentTranscriptsFolder
        ? renderTranscript(enrichments.agentTranscriptsFolder, enrichments.conversationId, false)
        : undefined,
    },
  },
  "automation-trigger": {
    render: enrichments => enrichments.automationTriggerContext
      ? `NOTE: This is an automation run. The original trigger info that started this session:\n${enrichments.automationTriggerContext}`
      : undefined,
    overrides: {
      external: enrichments => enrichments.automationTriggerContext
        ? `12. Automation trigger info (this is the original trigger that started this agent):\n\n${enrichments.automationTriggerContext}`
        : undefined,
      "xai-compaction": enrichments => enrichments.automationTriggerContext,
    },
  },
  todos: {
    render: enrichments => enrichments.todoContent
      ? `NOTE: There was an active todo list in the conversation. Here is the latest update before summarization:\n${todoUpdateTag(enrichments.todoContent)}`
      : undefined,
    overrides: {
      "xai-compaction": enrichments => enrichments.todoContent ? todoUpdateTag(enrichments.todoContent) : undefined,
    },
  },
  skills: {
    render: enrichments => enrichments.skillBlocks.length > 0
      ? enrichments.skillBlocks.join(BLOCK_SEPARATOR)
      : undefined,
  },
};

function placedBlockIds(summarizer: DurableBlockSummarizer): DurableBlockId[] {
  const { leading, trailing } = SUMMARIZERS[summarizer];
  return [...new Set([...leading, ...trailing])];
}

export function renderDurableBlocks(
  summarizer: DurableBlockSummarizer,
  enrichments: DurableBlockEnrichments,
  context: DurableBlockRenderContext = {},
): Map<DurableBlockId, string> {
  const blocks = new Map<DurableBlockId, string>();
  for (const id of placedBlockIds(summarizer)) {
    const spec = BLOCK_RENDERERS[id];
    const render = spec.overrides?.[summarizer] ?? spec.render;
    const promptText = render(enrichments, context);
    if (promptText !== undefined && promptText.length > 0) blocks.set(id, promptText);
  }
  return blocks;
}

function selectBlockPrompts(blocks: ReadonlyMap<DurableBlockId, string>, ids: readonly DurableBlockId[]): string[] {
  const seen = new Set<DurableBlockId>();
  const promptTexts: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const promptText = blocks.get(id);
    if (promptText !== undefined) promptTexts.push(promptText);
  }
  return promptTexts;
}

export function appendDurableBlocks(summarizer: DurableBlockSummarizer, blocks: ReadonlyMap<DurableBlockId, string>): string {
  return selectBlockPrompts(blocks, SUMMARIZERS[summarizer].trailing)
    .map(promptText => `${BLOCK_SEPARATOR}${promptText}`)
    .join("");
}

export function prependDurableBlocks(summarizer: DurableBlockSummarizer, blocks: ReadonlyMap<DurableBlockId, string>): string {
  return selectBlockPrompts(blocks, SUMMARIZERS[summarizer].leading)
    .map(promptText => `${promptText}${BLOCK_SEPARATOR}`)
    .join("");
}
