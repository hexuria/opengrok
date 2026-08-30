const SYSTEM_REMINDER_TAG_PATTERN = /<(\/?)system_reminder>/gi;
export const sanitizeSystemReminderContent = (content: string): string => content.replace(SYSTEM_REMINDER_TAG_PATTERN, (_match, slash: string) => `<${slash}system_reminder_>`);
