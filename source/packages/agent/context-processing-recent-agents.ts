import type { RecentAgent } from "../proto/generated/agent/v1/selected_context_pb.js";

export interface RecentAgentsTextContent {
  readonly type: "text";
  readonly text: string;
}

export interface RenderRecentAgentsContextArgs {
  readonly recentAgents: readonly RecentAgent[];
  readonly isComposerMatterhorn: boolean;
  readonly isRawTrainingSlug: boolean;
}

// Extracted from ../packages/agent/dist/context-processing.js as an
// uncomposed recent-agent context leaf. The parent processSelectedContext
// function remains absent.
export function renderRecentAgentsContext({
  recentAgents,
  isComposerMatterhorn,
  isRawTrainingSlug,
}: RenderRecentAgentsContextArgs): RecentAgentsTextContent | undefined {
  const agents = isComposerMatterhorn && isRawTrainingSlug ? [] : recentAgents;
  if (agents.length === 0) {
    return undefined;
  }
  const recentAgentsText = agents.map((recentAgent) => {
    const trimmedOverview = recentAgent.overview?.trim();
    const overviewLine = trimmedOverview ? `
  overview: ${trimmedOverview}` : "";
    return `- ${recentAgent.name}${overviewLine}
  transcript_path: ${recentAgent.path}`;
  }).join("\n");
  return {
    type: "text",
    text: `<recent_agents_context>
The user has other recent agent conversations available as transcript files.
If they seem relevant to the user's current query, you may read them for additional context.
Do not read full transcript files in one go; search and read in targeted chunks.
${recentAgentsText}
</recent_agents_context>`,
  };
}
