export const META_PARENT_COMPLETION_TAG = "agent_notification";
export const META_PARENT_COMPLETION_OPEN_TAG = `<${META_PARENT_COMPLETION_TAG}>`;
export const META_PARENT_COMPLETION_CLOSE_TAG = `</${META_PARENT_COMPLETION_TAG}>`;
export const META_PARENT_COMPLETION_SYSTEM_REMINDER = `<system_reminder>
Do not reiterate or repeat the contents of this agent notification to the user unless asked to do so.

Follow your instructions for Handling subagent notifications.
</system_reminder>`;
