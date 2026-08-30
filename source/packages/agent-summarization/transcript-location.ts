import { join } from "node:path";
import { getTranscriptRelativePath } from "../agent-transcript/paths.js";
import { TRANSCRIPTS_SUBDIR } from "../utils/workspace-paths.js";

export function formatTranscriptLocation(
  agentTranscriptsFolder: string,
  options?: { readonly conversationId?: string | undefined; readonly useXml?: boolean | undefined } | null,
): string {
  const conversationId = options?.conversationId;
  const useXml = options?.useXml === true;
  const markdownSection = formatTranscriptLocationMarkdownSection(agentTranscriptsFolder, conversationId);
  if (!useXml) return markdownSection;
  const xmlContent = markdownSection
    .replace("\n\n### Transcript location:\n", "")
    .replace(/^ {2}/gm, "")
    .trimEnd();
  return `\n\n<transcript_location>\n${xmlContent}\n</transcript_location>`;
}

function formatTranscriptLocationMarkdownSection(agentTranscriptsFolder: string, conversationId?: string): string {
  if (conversationId) {
    const transcriptRelativePath = getTranscriptRelativePath({
      conversationId,
      ext: "jsonl",
      kind: "primary",
    });
    const transcriptPath = join(agentTranscriptsFolder, stripTranscriptsDirPrefix(transcriptRelativePath));
    return `\n\n### Transcript location:
  This is the full JSONL transcript of your past conversation with the user (pre- and post-summary): ${transcriptPath}

  If anything about the task or current state is unclear (missing context, ambiguous requirements, uncertain decisions, exact wording, IDs/paths, errors/logs), you should consult this transcript.

  How to use it:
  - Search first for relevant keywords (task name, filenames, IDs, errors, tool names).
  - Then read a small window around the matching lines to reconstruct intent and state.
  - Avoid reading linearly end-to-end; the file can be very large and some single lines can be huge.
  - Files contain one structured json event per line including user/assistant messages. Currently tool calls and results are excluded.
  `;
  }
  return `\n\n### Transcript location:
  - This folder contains full transcripts of past conversations with the user (pre- and post-summary): ${agentTranscriptsFolder}
  - Each conversation is stored as a <convoId>/<convoId>.jsonl.`;
}

function stripTranscriptsDirPrefix(relativePath: string): string {
  const prefix = `${TRANSCRIPTS_SUBDIR}/`;
  return relativePath.startsWith(prefix) ? relativePath.slice(prefix.length) : relativePath;
}
