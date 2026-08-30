const BARE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-57][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AGENT_STORE_ID_PATTERN = /^store-[0-9a-f]{8}-[0-9a-f]{4}-[1-57][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AGENT_STORE_SHARE_ID_PATTERN = /^store-[A-Za-z0-9_-]{24}$/;
const CLOUD_AGENT_STORE_ID_PATTERN = /^bc-(?:[0-9a-z][0-9a-z-]*-)?[0-9a-f]{8}-[0-9a-f]{4}-[1-57][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AGENT_STORE_USER_SOURCE_ID_PATTERN = /^(?:t([1-9][0-9]*)-)?u([1-9][0-9]*)$/;
const AGENT_STORE_TEAM_SOURCE_ID_PATTERN = /^t([1-9][0-9]*)$/;

export const AGENT_STORE_USER_MOUNT_NAME = "user";
export const AGENT_STORE_TEAM_MOUNT_NAME = "team";
export const AGENT_STORE_AUTOMATION_MOUNT_NAME = "automation";
export const AGENT_STORE_RESERVED_CURSOR_PATH_PREFIX = ".cursor";
export const NAMED_AGENT_HOME_STORE_MOUNT_NAME = "home";
export const CURSOR_AGENT_STORE_FILES_DIR_ENV = "CURSOR_AGENT_STORE_FILES_DIR";

function parsePositiveSafeInteger(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function parseUserAgentStoreSourceId(sourceId: string): { userId: number; teamId?: number } | undefined {
  const match = AGENT_STORE_USER_SOURCE_ID_PATTERN.exec(sourceId);
  if (match?.[2] === undefined) return undefined;
  const userId = parsePositiveSafeInteger(match[2]);
  const teamId = match[1] === undefined ? undefined : parsePositiveSafeInteger(match[1]);
  if (userId === undefined || (match[1] !== undefined && teamId === undefined)) return undefined;
  return teamId === undefined ? { userId } : { userId, teamId };
}

export function parseTeamAgentStoreSourceId(sourceId: string): { teamId: number } | undefined {
  const raw = AGENT_STORE_TEAM_SOURCE_ID_PATTERN.exec(sourceId)?.[1];
  if (raw === undefined) return undefined;
  const teamId = parsePositiveSafeInteger(raw);
  return teamId === undefined ? undefined : { teamId };
}

export const isValidBareUuid = (agentId: string): boolean => BARE_UUID_PATTERN.test(agentId);
export const isCloudAgentStoreId = (agentId: string): boolean => CLOUD_AGENT_STORE_ID_PATTERN.test(agentId);
export const isAgentStoreId = (storeId: string): boolean => AGENT_STORE_ID_PATTERN.test(storeId);
export const isAgentStoreSourceId = (sourceId: string): boolean => isCloudAgentStoreId(sourceId) || isValidBareUuid(sourceId);
export const isAgentStoreShareMountKey = (mountKey: string): boolean => AGENT_STORE_SHARE_ID_PATTERN.test(mountKey);
