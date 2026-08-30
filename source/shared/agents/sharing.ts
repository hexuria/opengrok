export const REMOTE_AGENT_ID_PREFIX = "sand-remote:";

export interface RemoteAgentReference {
  readonly ownerAuthId: string;
  readonly agentId: string;
}

export function formatRemoteAgentId(ref: RemoteAgentReference): string {
  return `${REMOTE_AGENT_ID_PREFIX}${encodeURIComponent(ref.ownerAuthId)}/${encodeURIComponent(ref.agentId)}`;
}

export function isRemoteAgentId(id: string): boolean {
  return id.startsWith(REMOTE_AGENT_ID_PREFIX);
}

export function parseRemoteAgentId(id: string): RemoteAgentReference | null {
  if (!id.startsWith(REMOTE_AGENT_ID_PREFIX)) return null;
  const body = id.slice(REMOTE_AGENT_ID_PREFIX.length);
  const separator = body.indexOf("/");
  if (separator <= 0 || separator === body.length - 1) return null;
  try {
    const ownerAuthId = decodeURIComponent(body.slice(0, separator));
    const agentId = decodeURIComponent(body.slice(separator + 1));
    if (ownerAuthId.length === 0 || agentId.length === 0) return null;
    return { ownerAuthId, agentId };
  } catch {
    return null;
  }
}

export const SAND_SHARED_ROOM_IMAGE_BYTES_MAX = 1_100_000;
export const SAND_SHARE_AVATAR_DATA_URL_MAX_LENGTH = 200_000;
const SHARE_AVATAR_DATA_URL_PATTERN =
  /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

export function isPublishableShareAvatarDataUrl(value: string): boolean {
  return (
    value.length <= SAND_SHARE_AVATAR_DATA_URL_MAX_LENGTH &&
    SHARE_AVATAR_DATA_URL_PATTERN.test(value)
  );
}

export const EMPTY_SAND_SHARING_STATE = {
  isEnabled: false,
  selfAuthId: null,
  pendingJoinRequests: [],
  rooms: [],
  typingUsers: [],
} as const;
