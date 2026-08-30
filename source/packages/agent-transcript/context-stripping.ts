export const CONTEXT_TAGS_TO_STRIP = [
  "user_info", "project_layout", "rules", "always_applied_workspace_rules", "agent_requestable_workspace_rules", "user_rules", "agent_skills", "available_skills",
  "cloud_instructions", "cloud_task_instructions", "open_and_recently_viewed_files", "system_reminder", "system-reminder", "mcp_instructions", "mcp_file_system",
  "mcp_file_system_servers", "git_status", "agent_transcripts", "cursor_rules_context", "attached_files", "system_notification", "task_notification", "agent_notification",
] as const;

export function stripTags(text: string, tags: readonly string[]): string {
  let result = text;
  for (const tag of tags) result = result.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, "gi"), "");
  return result.replace(/\n{3,}/g, "\n\n").trim();
}
export const stripContextTags = (text: string): string => stripTags(text, CONTEXT_TAGS_TO_STRIP);
