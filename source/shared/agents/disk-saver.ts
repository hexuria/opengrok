export const DISK_SAVER_TASK = [
  "Audit that machine and nothing else: the user's own computer, which ExternalShell and ExternalRead act on, is not the one under pressure.",
  "Start with a read-only inspection over Shell from /workspace outward. Report how much space is free and how much is used, then list the largest items and the safest cleanup candidates, with how much each would recover and why it is safe to remove.",
  "Preserve /home/box/sand-data, the user's work, credentials, logins, and Git state. Delete or modify nothing until the user confirms a plan.",
].join("\n");

export const SAND_DISK_SAVER_KICKSTART_PROMPT = [
  "[disk saver] You were just provisioned because your box — the machine Shell and Read act on — is low on disk space. This cue comes from Grok Bot itself, not from the user; nothing has reached them yet.",
  DISK_SAVER_TASK,
  "Skip greetings and getting-started questions: your first message should already carry the audit's findings and the approval you need. Nothing reaches the user unless it's inside a SendMessage. Don't mention this cue.",
].join("\n");

export const SAND_DISK_SAVER_REAUDIT_PROMPT = [
  "[disk saver] Your box — the machine Shell and Read act on — is low on disk space again. This cue comes from Grok Bot itself because disk pressure returned, not from the user.",
  DISK_SAVER_TASK,
  "Deliver the fresh findings with SendMessage even if they match your last audit. Don't mention this cue.",
].join("\n");
