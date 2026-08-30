import { jsx, type PromptNode } from "../../prompt-jsx/jsx-runtime.js";

function formatMetaAgentNotesDirectoryInstruction(notesDirectory: string): string {
  return `Write notes which may be useful for other agents working on the same problem to the ${notesDirectory}. If relevant note files already exist, read them and consider extending them.

Use informatively named files to make the notes easily navigable. Group notes about similar concepts underneath the same directories. Focus on information related to the design or functionality of the system which is likely to be helpful to other agents in the future.

If you write to note file(s), reference the key note(s) in your responses to the user.`;
}

export function UserIntentSection(props: { readonly content: PromptNode }): PromptNode {
  return jsx("section", {
    title: "user_profile",
    description: "Summary of the user's work style and preferences. DO NOT mention this information in your responses, but use it to guide your responses and behavior when interacting with the user, and suggest next steps to the user if there is a matching workflow in the profile.",
    children: props.content,
  });
}

export function HooksAdditionalContextSection(props: { readonly content: PromptNode }): PromptNode {
  return jsx("section", {
    title: "hooks_context",
    description: "Additional context provided by session hooks. This may include project-specific information, configuration, or instructions from the user's hooks setup.",
    children: props.content,
  });
}

export function AutomationInstructionsSection(props: { readonly content: PromptNode }): PromptNode {
  return jsx("section", {
    title: "automation_instructions",
    children: props.content,
  });
}

export function MetaAgentProjectNotesDirectorySection(props: { readonly notesDirectory: string }): PromptNode {
  return jsx("section", {
    title: "project_notes_directory",
    children: formatMetaAgentNotesDirectoryInstruction(props.notesDirectory),
  });
}

export function AvailableSubagentModelsSection(props: { readonly description: PromptNode }): PromptNode {
  return jsx("section", {
    title: "available_subagent_models",
    children: jsx("p", { children: props.description }),
  });
}

export function AvailableSubagentTypesSection(props: { readonly description: PromptNode }): PromptNode {
  return jsx("section", {
    title: "available_subagent_types",
    children: jsx("p", { children: props.description }),
  });
}
