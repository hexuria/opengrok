export const SAND_NOTIFICATION_SOUNDS_GATE = "sand_notification_sounds";
export const SAND_NOTIFICATION_SOUND_IDS = ["ping-1-open-blip", "ping-2-tick", "ping-3-double-tick", "ping-4-chime-a", "ping-5-chime-b"] as const;
export type SandNotificationSoundId = (typeof SAND_NOTIFICATION_SOUND_IDS)[number];
export interface SandNotificationPreferences { readonly playSound: boolean; readonly sound: SandNotificationSoundId; }
/** `playSound` stays on by default, as upstream. It is inert while the gate is closed. */
export const DEFAULT_NOTIFICATION_PREFERENCES: SandNotificationPreferences = { playSound: true, sound: "ping-1-open-blip" };
export function isSandNotificationSoundId(value: unknown): value is SandNotificationSoundId { return typeof value === "string" && (SAND_NOTIFICATION_SOUND_IDS as readonly string[]).includes(value); }
export function isSandNotificationPreferences(value: unknown): value is SandNotificationPreferences { if (typeof value !== "object" || value == null || Array.isArray(value)) return false; const record = value as { playSound?: unknown; sound?: unknown }; return typeof record.playSound === "boolean" && isSandNotificationSoundId(record.sound); }
/** Repairs each field independently so one bad key does not discard the other. */
export function normalizeNotificationPreferences(value: unknown): SandNotificationPreferences {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return DEFAULT_NOTIFICATION_PREFERENCES;
  const record = value as { playSound?: unknown; sound?: unknown };
  return {
    playSound: typeof record.playSound === "boolean" ? record.playSound : DEFAULT_NOTIFICATION_PREFERENCES.playSound,
    sound: isSandNotificationSoundId(record.sound) ? record.sound : DEFAULT_NOTIFICATION_PREFERENCES.sound,
  };
}
