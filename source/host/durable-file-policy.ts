export const SAND_UPGRADE_RESUME_FILE_NAME = "host-upgrade-resume.json";
export const SAND_ACK_OBLIGATIONS_FILE_NAME = "ack-obligations.json";
export const SAND_PENDING_WAKE_FILE_NAME = "host-pending-wakes.json";
export const SAND_XUSER_TURN_DEDUPE_FILE_NAME = "host-xuser-turn-nonces.json";
export const SAND_DISK_PRESSURE_REMINDERS_FILE_NAME = "host-disk-pressure-reminders.json";
export const BOX_STORE_SAND_DATA_EXCLUDED_FILE_NAMES = [SAND_UPGRADE_RESUME_FILE_NAME, SAND_ACK_OBLIGATIONS_FILE_NAME, SAND_PENDING_WAKE_FILE_NAME, SAND_XUSER_TURN_DEDUPE_FILE_NAME, SAND_DISK_PRESSURE_REMINDERS_FILE_NAME] as const;
