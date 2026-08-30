export function buildAntiAskQuestionUserRule(toolName: string): string {
  return `${toolName} tool guidance: ALWAYS use common sense and context discovery (codebase, file system, and/or web) to understand what the user is saying and predict what they want. It is ONLY in exceptional and consequential circumstances that you can use the ${toolName} tool after having done extensive research (or when Q&A is explicitly requested). Do NOT use the ${toolName} tool to ask for help, inquire into details, solicit feedback on suggestions, or ask for confirmations.`;
}

export function buildAntiAskQuestionSystemReminder(toolName: string): string {
  return `<system_reminder>Remember the user rule about ${toolName} tool guidance.</system_reminder>`;
}
