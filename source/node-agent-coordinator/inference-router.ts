import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { reanchorSandPath } from "../host/host-paths.js";
import { runRoutedProviderText } from "../host/extensions/inference/provider-session.js";
import type { SandInferenceProvider } from "../shared/inference-router.js";
import { imageMimeFromPath } from "../shared/media/image-mime.js";
import { readImageFileDimensions } from "../shared/media/image-dimensions.js";
import {
  collectUserAttachmentsForSend,
  persistableUserAttachmentEntry,
  USER_ATTACHMENT_KIND,
} from "../shared/media/user-attachment-comment.js";
import { SandSettingsStore } from "../shared/node/settings/sand-settings-store.js";
import { createSubscriptionCliAuthPort, isSubscriptionInferenceProvider, type SubscriptionCliAuthPort } from "../shared/node/subscription-cli-auth.js";
import { createRoutedAutomations, LOCAL_AUTOMATION_METHODS } from "./routed-automations.js";
import { createRoutedMessagesTools } from "./routed-messages-tools.js";
import { createRoutedMcpBridge } from "./routed-mcp-bridge.js";

type StoredMessageEntry = {
  readonly provider: Exclude<SandInferenceProvider, "cursor">;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly richText?: string;
  readonly id: string;
  readonly clientNonce?: string;
  readonly reactions?: readonly { readonly emoji: string; readonly by: string }[];
  readonly timestampMs: number;
  readonly batchId?: string;
};

type StoredAttachmentEntry = {
  readonly provider: Exclude<SandInferenceProvider, "cursor">;
  readonly kind: typeof USER_ATTACHMENT_KIND;
  readonly id: string;
  readonly file_path: string;
  readonly file_name?: string;
  readonly byteSize?: number;
  readonly width?: number;
  readonly height?: number;
  readonly timestampMs: number;
  readonly clientNonce?: string;
  readonly batchId?: string;
  readonly replyTo?: string;
};

type StoredEntry = StoredMessageEntry | StoredAttachmentEntry;
type Store = { readonly schemaVersion: 2; readonly agents: Readonly<Record<string, readonly StoredEntry[]>> };

function isStoredAttachmentEntry(entry: StoredEntry): entry is StoredAttachmentEntry {
  return "kind" in entry && entry.kind === USER_ATTACHMENT_KIND;
}

const ROUTED_IMAGE_PART_BYTE_CAP = 10 * 1024 * 1024;
const ROUTED_MAX_IMAGE_PARTS = 8;

type RoutedImagePart = { readonly type: "image"; readonly image: Uint8Array; readonly mimeType: string };
type RoutedMessage = { readonly role: "user" | "assistant"; readonly content: string | readonly unknown[] };

async function readRoutedImageAttachment(filePath: string): Promise<RoutedImagePart | null> {
  const mimeType = imageMimeFromPath(filePath);
  if (mimeType == null) return null;
  try {
    const bytes = await readFile(reanchorSandPath(filePath));
    if (bytes.byteLength === 0 || bytes.byteLength > ROUTED_IMAGE_PART_BYTE_CAP) return null;
    return { type: "image", image: new Uint8Array(bytes), mimeType };
  } catch { return null; }
}

const ROUTED_IMAGE_CHUNK_BYTES = 1024 * 1024;
const ROUTED_COMPOSING_REVEAL_MS = 400;
const ROUTED_STREAM_EMIT_INTERVAL_MS = 80;

/**
 * Committed attachments live in the box (e.g. /home/box/sand-data/... inside
 * the Local Docker VM), so a plain readFile misses them. Fall back to the same
 * gateway readAttachmentChunk legs the transcript thumbnails use.
 */
// Committed attachment files are content-hash named and never mutate, so
// their bytes cache safely across turns; without this every send re-fetched
// the full history's images (up to 8 x 10MB) through the gateway.
const routedImageCache = new Map<string, RoutedImagePart>();
let routedImageCacheBytes = 0;
const ROUTED_IMAGE_CACHE_BYTE_CAP = 64 * 1024 * 1024;

function rememberRoutedImage(filePath: string, part: RoutedImagePart): void {
  if (part.image.byteLength > ROUTED_IMAGE_CACHE_BYTE_CAP) return;
  const existing = routedImageCache.get(filePath);
  if (existing != null) { routedImageCacheBytes -= existing.image.byteLength; routedImageCache.delete(filePath); }
  while (routedImageCacheBytes + part.image.byteLength > ROUTED_IMAGE_CACHE_BYTE_CAP) {
    const oldest = routedImageCache.keys().next().value;
    if (oldest == null) break;
    routedImageCacheBytes -= routedImageCache.get(oldest)!.image.byteLength;
    routedImageCache.delete(oldest);
  }
  routedImageCache.set(filePath, part);
  routedImageCacheBytes += part.image.byteLength;
}

export function createRoutedImageReader(dispatchRemote: (method: string, args: unknown) => Promise<unknown>): (filePath: string) => Promise<RoutedImagePart | null> {
  return async (filePath) => {
    const cached = routedImageCache.get(filePath);
    if (cached != null) { rememberRoutedImage(filePath, cached); return cached; }
    const local = await readRoutedImageAttachment(filePath);
    if (local != null) { rememberRoutedImage(filePath, local); return local; }
    const mimeType = imageMimeFromPath(filePath);
    if (mimeType == null) return null;
    try {
      const probe = asRecord(await dispatchRemote("readAttachmentChunk", { path: filePath, offset: 0, length: 0 }));
      const totalSize = typeof probe?.totalSize === "number" && Number.isFinite(probe.totalSize) ? probe.totalSize : null;
      if (totalSize == null || totalSize <= 0 || totalSize > ROUTED_IMAGE_PART_BYTE_CAP) return null;
      const chunks: Buffer[] = [];
      let offset = 0;
      while (offset < totalSize) {
        const chunk = asRecord(await dispatchRemote("readAttachmentChunk", { path: filePath, offset, length: ROUTED_IMAGE_CHUNK_BYTES }));
        const bytes = typeof chunk?.bytesBase64 === "string" ? Buffer.from(chunk.bytesBase64, "base64") : null;
        if (bytes == null || bytes.length === 0) return null;
        chunks.push(bytes);
        offset += bytes.length;
      }
      const part: RoutedImagePart = { type: "image", image: new Uint8Array(Buffer.concat(chunks)), mimeType };
      rememberRoutedImage(filePath, part);
      return part;
    } catch { return null; }
  };
}

/**
 * OpenRouter goes through the AI SDK, which forwards multi-part user content as
 * OpenAI-style image_url parts; Codex and Claude Code stringify content, so
 * image parts are only built for OpenRouter. Attachment rows precede their user
 * message in the store, so pending images attach to the next user turn.
 */
export async function buildRoutedProviderMessages(entries: readonly StoredEntry[], options?: {
  readonly includeImageParts?: boolean;
  readonly readImage?: (filePath: string) => Promise<RoutedImagePart | null>;
  readonly maxImageParts?: number;
}): Promise<RoutedMessage[]> {
  const readImage = options?.readImage ?? readRoutedImageAttachment;
  const maxImageParts = options?.maxImageParts ?? ROUTED_MAX_IMAGE_PARTS;
  const messages: Array<{ role: "user" | "assistant"; content: string | unknown[] }> = [];
  let pendingImages: RoutedImagePart[] = [];
  const flushImagesOnly = () => {
    if (pendingImages.length === 0) return;
    messages.push({ role: "user", content: [...pendingImages] });
    pendingImages = [];
  };
  for (const entry of entries) {
    if (isStoredAttachmentEntry(entry)) {
      if (options?.includeImageParts !== true) continue;
      const part = await readImage(entry.file_path);
      if (part != null) pendingImages.push(part);
      continue;
    }
    if (entry.role === "user") {
      if (pendingImages.length > 0) {
        messages.push({ role: "user", content: [...pendingImages, ...(entry.content.length > 0 ? [{ type: "text", text: entry.content }] : [])] });
        pendingImages = [];
      } else {
        messages.push({ role: "user", content: entry.content });
      }
      continue;
    }
    flushImagesOnly();
    messages.push({ role: "assistant", content: entry.content });
  }
  flushImagesOnly();
  let imageCount = messages.reduce((total, message) => Array.isArray(message.content)
    ? total + message.content.filter((part) => (part as RoutedImagePart).type === "image").length
    : total, 0);
  for (const message of messages) {
    if (imageCount <= maxImageParts) break;
    if (!Array.isArray(message.content)) continue;
    const kept: unknown[] = [];
    for (const part of message.content) {
      if ((part as RoutedImagePart).type === "image" && imageCount > maxImageParts) { imageCount -= 1; continue; }
      kept.push(part);
    }
    const text = kept.length === 1 && (kept[0] as { type?: string; text?: string }).type === "text" ? (kept[0] as { text: string }).text : null;
    message.content = text ?? kept;
  }
  return messages.filter((message) => typeof message.content === "string" ? true : message.content.length > 0);
}

const EMPTY_STORE: Store = { schemaVersion: 2, agents: {} };

export type LocalRosterAgent = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly isHiddenFromSidebar: boolean;
  readonly isGroup: boolean;
  readonly origin: "user";
  readonly isRunning: boolean;
  readonly isComposingMessage: boolean;
  readonly lastEntry: null;
  readonly lastMessageId: null;
  readonly lastMessagePreview: null;
  readonly hasUnread: boolean;
  readonly unreadCount: number;
  readonly memberIds: readonly string[];
  readonly conversationPartnerIds: readonly string[];
  readonly avatarDataUrl: string | null;
  readonly avatarShape: null;
  readonly avatarColor: null;
  readonly path: string;
  readonly isActive: boolean;
  readonly notificationsEnabled: boolean;
  readonly notifyOnUpdatesEnabled: boolean;
  readonly awaitingUserResponse: null;
  readonly lastViewedAt: number;
  readonly lastActivityAt: number;
  readonly newestEntryId: null;
  readonly avatarVersion: number | null;
};

type RosterStore = { readonly schemaVersion: 1; readonly agents: readonly LocalRosterAgent[] };
const EMPTY_ROSTER: RosterStore = { schemaVersion: 1, agents: [] };
const LOCAL_ROSTER_METHODS = new Set([
  "listAgents",
  "countAgents",
  "searchAgents",
  "createAgent",
  "updateAgent",
  "deleteAgents",
  "duplicateAgent",
  "kickstartAgent",
  "setAgentAvatarBytes",
  "getAgentAvatar",
  "clearAgentImageMetadata",
]);
const LOCAL_TRANSCRIPT_METHODS = new Set(["getAgentTranscriptTail", "openAgentTail", "getAgentTranscriptWindow"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value != null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseInferenceRouterRoster(value: unknown): RosterStore {
  const root = asRecord(value);
  if (root?.schemaVersion !== 1 || !Array.isArray(root.agents)) return EMPTY_ROSTER;
  const agents: LocalRosterAgent[] = [];
  for (const raw of root.agents) {
    const row = asRecord(raw);
    if (row == null || typeof row.id !== "string" || row.id.length === 0) continue;
    agents.push({
      id: row.id,
      name: typeof row.name === "string" && row.name.trim().length > 0 ? row.name.trim() : "New Bot",
      description: typeof row.description === "string" ? row.description : "",
      title: typeof row.title === "string" ? row.title : "",
      createdAt: typeof row.createdAt === "number" && Number.isFinite(row.createdAt) ? row.createdAt : 0,
      updatedAt: typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
      isHiddenFromSidebar: row.isHiddenFromSidebar === true,
      isGroup: false,
      origin: "user",
      isRunning: row.isRunning === true,
      isComposingMessage: row.isComposingMessage === true,
      lastEntry: null,
      lastMessageId: null,
      lastMessagePreview: null,
      hasUnread: false,
      unreadCount: 0,
      memberIds: [],
      conversationPartnerIds: [],
      avatarDataUrl: typeof row.avatarDataUrl === "string" && row.avatarDataUrl.startsWith("data:image/") ? row.avatarDataUrl : null,
      avatarShape: null,
      avatarColor: null,
      path: typeof row.path === "string" && row.path.length > 0 ? row.path : `local:${row.id}`,
      isActive: false,
      notificationsEnabled: row.notificationsEnabled === true,
      notifyOnUpdatesEnabled: row.notifyOnUpdatesEnabled !== false,
      awaitingUserResponse: null,
      lastViewedAt: 0,
      lastActivityAt: 0,
      newestEntryId: null,
      avatarVersion: typeof row.avatarVersion === "number" && Number.isFinite(row.avatarVersion) ? row.avatarVersion : null,
    });
  }
  return { schemaVersion: 1, agents };
}

function emptyLocalAgent(id: string, name: string, nowMs: number, extras: { readonly description?: string; readonly title?: string } = {}): LocalRosterAgent {
  return {
    id,
    name,
    description: extras.description ?? "",
    title: extras.title ?? "",
    createdAt: nowMs,
    updatedAt: nowMs,
    isHiddenFromSidebar: false,
    isGroup: false,
    origin: "user",
    isRunning: false,
    isComposingMessage: false,
    lastEntry: null,
    lastMessageId: null,
    lastMessagePreview: null,
    hasUnread: false,
    unreadCount: 0,
    memberIds: [],
    conversationPartnerIds: [],
    avatarDataUrl: null,
    avatarShape: null,
    avatarColor: null,
    path: `local:${id}`,
    isActive: false,
    notificationsEnabled: false,
    notifyOnUpdatesEnabled: true,
    awaitingUserResponse: null,
    lastViewedAt: 0,
    lastActivityAt: 0,
    newestEntryId: null,
    avatarVersion: null,
  };
}

function stampLocalRosterAgents<T extends LocalRosterAgent>(agents: readonly T[], epoch: string, seq: number): Array<T & { snapshotEpoch: string; snapshotSeq: number }> {
  return agents.map((agent) => ({ ...agent, snapshotEpoch: epoch, snapshotSeq: seq, path: agent.path ?? `local:${agent.id}` }));
}

export function parseInferenceRouterTranscriptStore(value: unknown): Store {
  const root = asRecord(value);
  if (root?.schemaVersion !== 2 || asRecord(root.agents) == null) return EMPTY_STORE;
  const agents: Record<string, StoredEntry[]> = {};
  for (const [agentId, rawEntries] of Object.entries(root.agents as Record<string, unknown>)) {
    if (!Array.isArray(rawEntries)) continue;
    const entries: StoredEntry[] = [];
    for (const raw of rawEntries) {
      const row = asRecord(raw);
      if (row == null || !["codex", "claude-code", "openrouter"].includes(String(row.provider)) || typeof row.id !== "string" || typeof row.timestampMs !== "number" || (row.clientNonce !== undefined && typeof row.clientNonce !== "string")) continue;
      if (row.kind === USER_ATTACHMENT_KIND) {
        if (typeof row.file_path !== "string" || row.file_path.length === 0) continue;
        if (row.file_name !== undefined && typeof row.file_name !== "string") continue;
        if (row.byteSize !== undefined && (typeof row.byteSize !== "number" || !Number.isFinite(row.byteSize))) continue;
        if (row.width !== undefined && (typeof row.width !== "number" || !Number.isFinite(row.width))) continue;
        if (row.height !== undefined && (typeof row.height !== "number" || !Number.isFinite(row.height))) continue;
        if (row.batchId !== undefined && typeof row.batchId !== "string") continue;
        if (row.replyTo !== undefined && typeof row.replyTo !== "string") continue;
        entries.push(row as unknown as StoredAttachmentEntry);
        continue;
      }
      if (!["user", "assistant"].includes(String(row.role)) || typeof row.content !== "string" || (row.richText !== undefined && typeof row.richText !== "string")) continue;
      if (row.reactions !== undefined && (!Array.isArray(row.reactions) || row.reactions.some(reaction => asRecord(reaction) == null || typeof asRecord(reaction)!.emoji !== "string" || typeof asRecord(reaction)!.by !== "string"))) continue;
      entries.push(row as unknown as StoredMessageEntry);
    }
    agents[agentId] = entries.slice(-200);
  }
  return { schemaVersion: 2, agents };
}

export function projectInferenceRouterTranscriptEntry(entry: StoredEntry): Record<string, unknown> {
  if (isStoredAttachmentEntry(entry)) {
    return persistableUserAttachmentEntry(entry, entry.id);
  }
  return entry.role === "user"
    ? { kind: "message", id: entry.id, role: "user", content: entry.content, ...(entry.richText === undefined ? {} : { richText: entry.richText }), isStreaming: false, timestampMs: entry.timestampMs, ...(entry.clientNonce === undefined ? {} : { clientNonce: entry.clientNonce }), ...(entry.reactions === undefined ? {} : { reactions: entry.reactions }), ...(entry.batchId === undefined ? {} : { batchId: entry.batchId }) }
    : { kind: "send-message", id: entry.id, message: { type: "text", content: entry.content }, timestampMs: entry.timestampMs, ...(entry.reactions === undefined ? {} : { reactions: entry.reactions }) };
}

export function createCoordinatorInferenceRouter(options: {
  readonly dataDir: string;
  readonly postEvent: (family: string, payload: unknown) => void;
  readonly dispatchRemote: (method: string, args: unknown) => Promise<unknown>;
  readonly now?: () => number;
  readonly subscriptionAuth?: SubscriptionCliAuthPort;
}) {
  const settings = new SandSettingsStore(join(options.dataDir, "settings.json"));
  const subscriptionAuth = options.subscriptionAuth ?? createSubscriptionCliAuthPort({});
  const storePath = join(options.dataDir, "inference-router-transcript.json");
  const rosterPath = join(options.dataDir, "inference-router-roster.json");
  const now = options.now ?? Date.now;
  const queues = new Map<string, Promise<unknown>>();
  const rosterEpoch = randomUUID();
  let rosterSeq = 0;
  let fireRoutine: (agentId: string, prompt: string) => Promise<void> = async () => {};
  const automations = createRoutedAutomations({
    dataDir: options.dataDir,
    postEvent: options.postEvent,
    now,
    timeZone: () => settings.getUserTimeZone(),
    onFire: (agentId, prompt) => fireRoutine(agentId, prompt),
  });

  const load = async (): Promise<Store> => {
    try { return parseInferenceRouterTranscriptStore(JSON.parse(await readFile(storePath, "utf8"))); }
    catch { return EMPTY_STORE; }
  };
  const persist = async (store: Store): Promise<void> => {
    await mkdir(dirname(storePath), { recursive: true });
    const temporary = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, storePath);
  };
  const loadRoster = async (): Promise<RosterStore> => {
    try { return parseInferenceRouterRoster(JSON.parse(await readFile(rosterPath, "utf8"))); }
    catch { return EMPTY_ROSTER; }
  };
  const persistRoster = async (store: RosterStore): Promise<RosterStore> => {
    await mkdir(dirname(rosterPath), { recursive: true });
    const temporary = `${rosterPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, rosterPath);
    return store;
  };
  const publishRoster = async (activeAgentId: string | null, runningId?: string) => {
    const roster = await loadRoster();
    const seq = ++rosterSeq;
    const agents = stampLocalRosterAgents(roster.agents.map((agent) => runningId === agent.id
      ? { ...agent, isRunning: true, isComposingMessage: true, isRunningTurn: true, isRetrying: false, currentActivity: { kind: "thinking" } }
      : agent), rosterEpoch, seq);
    options.postEvent("agents", { activeAgentId: activeAgentId ?? agents[0]?.id ?? "", agents, coverage: { kind: "complete-roster" } });
    return agents;
  };
  // Lazy dimension backfill: rows stored before dimensions were persisted (or
  // any row that lost them) get measured once on first load — bytes come from
  // the cached reader, sizes are written back to the store, and an "updated"
  // emit refreshes the open transcript. Succeeding loads then reserve exact
  // boxes with no measurement at all. Metadata lives until agent deletion.
  const enqueueAgentMutation = <T,>(agentId: string, mutate: () => Promise<T>): Promise<T> => {
    const previous = queues.get(agentId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(mutate);
    const queued = next.finally(() => { if (queues.get(agentId) === queued) queues.delete(agentId); });
    queues.set(agentId, queued);
    return next;
  };
  const backfilledAgents = new Set<string>();
  const backfillAttachmentDimensions = async (agentId: string): Promise<void> => {
    if (agentId.length === 0 || backfilledAgents.has(agentId)) return;
    backfilledAgents.add(agentId);
    const store = await load();
    const rows = store.agents[agentId] ?? [];
    const missing = rows.filter((entry): entry is StoredAttachmentEntry =>
      isStoredAttachmentEntry(entry) && (entry.width == null || entry.height == null) && imageMimeFromPath(entry.file_path) != null);
    if (missing.length === 0) return;
    const readImage = createRoutedImageReader(options.dispatchRemote);
    const measured = new Map<string, { width: number; height: number }>();
    for (const entry of missing.slice(0, 24)) {
      const part = await readImage(entry.file_path).catch(() => null);
      const dims = part == null ? null : readImageFileDimensions(part.image);
      if (dims != null) measured.set(entry.id, dims);
    }
    if (measured.size === 0) return;
    // The read-modify-write must ride the same per-agent queue that
    // serializes sendPrompt appends, or a message sent during the backfill
    // window would be overwritten by this persist.
    await enqueueAgentMutation(agentId, async () => {
      const current = await load();
      const updated: StoredEntry[] = (current.agents[agentId] ?? []).map((entry) =>
        isStoredAttachmentEntry(entry) && measured.has(entry.id)
          ? { ...entry, ...measured.get(entry.id)! }
          : entry);
      await persist({ schemaVersion: 2, agents: { ...current.agents, [agentId]: updated } });
      for (const entry of updated) {
        if (isStoredAttachmentEntry(entry) && measured.has(entry.id)) {
          emitTranscript(agentId, "updated", persistableUserAttachmentEntry(entry, entry.id));
        }
      }
    });
  };

  const dispatchLocalRoster = async (method: string, args: unknown): Promise<unknown> => {
    const record = asRecord(args) ?? {};
    if (method === "listAgents") return await publishRoster(null);
    if (method === "countAgents") return (await loadRoster()).agents.length;
    if (method === "searchAgents") {
      const query = typeof record.query === "string" ? record.query.trim().toLowerCase() : "";
      const limit = typeof record.limit === "number" && Number.isInteger(record.limit) && record.limit > 0 ? record.limit : 50;
      const agents = (await loadRoster()).agents.filter((agent) => query.length === 0 || agent.name.toLowerCase().includes(query));
      return agents.slice(0, limit);
    }
    if (method === "kickstartAgent") return { isIntroductionInFlight: false };
    if (method === "createAgent") {
      const name = typeof record.name === "string" && record.name.trim().length > 0 ? record.name.trim() : "New Bot";
      const agent = emptyLocalAgent(randomUUID(), name, now(), {
        description: typeof record.description === "string" ? record.description : "",
        title: typeof record.title === "string" ? record.title : "",
      });
      const next = await persistRoster({ schemaVersion: 1, agents: [...(await loadRoster()).agents, agent] });
      await publishRoster(agent.id);
      return { agent: next.agents.find((row) => row.id === agent.id) ?? agent, transcript: { entries: [] } };
    }
    if (method === "clearAgentImageMetadata") {
      // Repair tool: bust saved image dimensions when bad metadata was
      // recorded; the next transcript load re-measures and re-persists.
      const id = typeof record.id === "string" ? record.id : "";
      const cleared = await enqueueAgentMutation(id, async () => {
        const current = await load();
        const rows = (current.agents[id] ?? []).map((entry) =>
          isStoredAttachmentEntry(entry) ? (({ width: _w, height: _h, ...rest }) => rest)(entry) as StoredEntry : entry);
        await persist({ schemaVersion: 2, agents: { ...current.agents, [id]: rows } });
        return rows.filter((entry) => isStoredAttachmentEntry(entry)).length;
      });
      backfilledAgents.delete(id);
      return { cleared };
    }
    if (method === "setAgentAvatarBytes") {
      const id = typeof record.id === "string" ? record.id : "";
      const pngBase64 = typeof record.pngBase64 === "string" && record.pngBase64.length > 0 && record.pngBase64.length <= 4_000_000 ? record.pngBase64 : null;
      const current = await loadRoster();
      const agents = current.agents.map((agent) => agent.id !== id ? agent : {
        ...agent,
        avatarDataUrl: pngBase64 == null ? null : `data:image/png;base64,${pngBase64}`,
        avatarVersion: now(),
        updatedAt: now(),
      });
      await persistRoster({ schemaVersion: 1, agents });
      const updated = agents.find((agent) => agent.id === id) ?? null;
      await publishRoster(id);
      return updated;
    }
    if (method === "getAgentAvatar") {
      const id = typeof record.id === "string" ? record.id : "";
      // The 0.18 renderer contract types this reply as a record, never null.
      return { dataUrl: (await loadRoster()).agents.find((agent) => agent.id === id)?.avatarDataUrl ?? null };
    }
    if (method === "updateAgent") {
      const id = typeof record.id === "string" ? record.id : "";
      const profile = asRecord(record.profile) ?? record;
      const current = await loadRoster();
      const agents = current.agents.map((agent) => {
        if (agent.id !== id) return agent;
        return {
          ...agent,
          name: typeof profile.name === "string" && profile.name.trim().length > 0 ? profile.name.trim() : agent.name,
          description: typeof profile.description === "string" ? profile.description : agent.description,
          title: typeof profile.title === "string" ? profile.title : agent.title,
          updatedAt: now(),
        };
      });
      await persistRoster({ schemaVersion: 1, agents });
      const updated = agents.find((agent) => agent.id === id) ?? null;
      await publishRoster(id);
      return updated;
    }
    if (method === "duplicateAgent") {
      const id = typeof record.id === "string" ? record.id : "";
      const current = await loadRoster();
      const source = current.agents.find((agent) => agent.id === id);
      if (source == null) return { agent: null };
      const copy = emptyLocalAgent(randomUUID(), `Copy of ${source.name}`, now(), { description: source.description, title: source.title });
      await persistRoster({ schemaVersion: 1, agents: [...current.agents, copy] });
      await publishRoster(copy.id);
      return { agent: copy, transcript: { entries: [] } };
    }
    if (method === "deleteAgents") {
      const ids = new Set(Array.isArray(record.ids) ? record.ids.filter((id): id is string => typeof id === "string") : []);
      const current = await loadRoster();
      await persistRoster({ schemaVersion: 1, agents: current.agents.filter((agent) => !ids.has(agent.id)) });
      const transcripts = await load();
      const remaining: Record<string, readonly StoredEntry[]> = {};
      for (const [agentId, entries] of Object.entries(transcripts.agents)) {
        if (!ids.has(agentId)) remaining[agentId] = entries;
      }
      await persist({ schemaVersion: 2, agents: remaining });
      // Agent deletion is the only point where per-agent metadata is evicted:
      // roster row (avatar), transcript rows (image dimensions), and routines
      // all go together so a deleted bot's schedule cannot fire again.
      await automations.deleteForAgents([...ids]).catch(() => { /* best effort */ });
      await publishRoster(null);
      return { deleted: [...ids] };
    }
    return null;
  };
  const append = async (agentId: string, entries: readonly StoredEntry[]): Promise<Store> => {
    const current = await load();
    const next: Store = { schemaVersion: 2, agents: { ...current.agents, [agentId]: [...(current.agents[agentId] ?? []), ...entries].slice(-200) } };
    await persist(next);
    return next;
  };
  const emitTranscript = (agentId: string, type: "appended" | "updated", entry: Record<string, unknown>) => options.postEvent("transcript", { type, entry, agentId });
  const emitTranscriptRemoval = (agentId: string, id: string) => options.postEvent("transcript", { type: "removed", id, agentId });

  // Messages runs in this process: the coordinator is a local child of the
  // desktop app, on the same Mac as the database. The routed tool loop has no
  // permission gate of its own, so the approval card is raised here.
  const messagesTools = createRoutedMessagesTools({
    emitTranscript,
    getPermission: () => settings.getLocalToolPermission(),
    setPermission: (permission) => { settings.setLocalToolPermission(permission); },
    // Delegated to the main process, which holds the app's Full Disk Access
    // grant; this coordinator runs in an Electron helper that does not.
    runMessagesOp: async (op) => await options.dispatchRemote("runMessagesOp", op) as unknown as { ok: boolean },
  });
  const beginActivity = async (agentId: string): Promise<() => void> => {
    try {
      const publishRunning = () => { void publishRoster(agentId, agentId); };
      publishRunning();
      const pulse = setInterval(publishRunning, 250);
      pulse.unref();
      return () => {
        clearInterval(pulse);
        void publishRoster(agentId);
      };
    } catch { return () => {}; }
  };
  const toggleLocalReaction = async (agentId: string, entryId: string, emoji: string): Promise<Record<string, unknown> | null> => {
    const trimmed = emoji.trim();
    if (agentId.length === 0 || entryId.length === 0 || trimmed.length === 0) return null;
    const current = await load();
    const entries = current.agents[agentId];
    if (entries == null) return null;
    const index = entries.findIndex(entry => entry.id === entryId);
    if (index < 0) return null;
    const before = entries[index]!;
    if (isStoredAttachmentEntry(before)) return null;
    const reactions = before.reactions ?? [];
    const exists = reactions.some(reaction => reaction.emoji === trimmed && reaction.by === "me");
    const nextReactions = exists ? reactions.filter(reaction => !(reaction.emoji === trimmed && reaction.by === "me")) : [...reactions, { emoji: trimmed, by: "me" }];
    const { reactions: _oldReactions, ...withoutReactions } = before;
    const updated: StoredEntry = nextReactions.length === 0 ? withoutReactions : { ...withoutReactions, reactions: nextReactions };
    const nextEntries = [...entries];
    nextEntries[index] = updated;
    await persist({ schemaVersion: 2, agents: { ...current.agents, [agentId]: nextEntries } });
    return projectInferenceRouterTranscriptEntry(updated);
  };
  const deleteLocalEntries = async (agentId: string, entryIds: readonly string[]): Promise<{ deleted: string[]; blocked: { id: string; reason: string }[] } | null> => {
    if (agentId.length === 0 || entryIds.length === 0) return null;
    const current = await load();
    const entries = current.agents[agentId];
    if (entries == null) return null;
    const removing = new Set<string>();
    const blocked: { id: string; reason: string }[] = [];
    for (const id of entryIds) {
      if (entries.some(entry => entry.id === id)) removing.add(id);
      else blocked.push({ id, reason: "not-found" });
    }
    if (removing.size === 0) return null;
    await persist({ schemaVersion: 2, agents: { ...current.agents, [agentId]: entries.filter(entry => !removing.has(entry.id)) } });
    return { deleted: [...removing], blocked };
  };
  const execute = async (provider: Exclude<SandInferenceProvider, "cursor">, args: Record<string, unknown>) => {
    const agentId = typeof args.agentId === "string" ? args.agentId : "";
    const rawPrompt = typeof args.prompt === "string" ? args.prompt : "";
    const clientNonce = typeof args.clientNonce === "string" ? args.clientNonce : randomUUID();
    const timestampMs = now();
    const attachmentPaths = Array.isArray(args.attachmentPaths) ? args.attachmentPaths.filter((path): path is string => typeof path === "string") : [];
    const attachmentNames = Array.isArray(args.attachmentNames) ? args.attachmentNames.filter((name): name is string => typeof name === "string") : [];
    const collected = collectUserAttachmentsForSend({
      prompt: rawPrompt,
      ...(typeof args.richText === "string" ? { richText: args.richText } : {}),
      attachmentPaths,
      attachmentNames,
      ...(args.attachments === undefined ? {} : { attachments: args.attachments }),
      clientNonce,
      ...(typeof args.replyToId === "string" ? { replyTo: args.replyToId } : {}),
      timestampMs,
    });
    const prompt = collected.text;
    const richText = collected.richText;
    if (agentId.length === 0 || (prompt.length === 0 && collected.attachments.length === 0)) throw new Error("Local inference routing requires an agentId and prompt");
    const [remote, beforeUser] = await Promise.all([
      options.dispatchRemote("getAgentTranscriptTail", { id: agentId }).catch(() => ({ entries: [] })),
      load(),
    ]);
    const remoteEntries = Array.isArray(asRecord(remote)?.entries) ? asRecord(remote)!.entries as unknown[] : [];
    const remoteTurn = remoteEntries.reduce<number>((highest, raw) => {
      const id = asRecord(raw)?.id;
      const match = typeof id === "string" ? /^t(\d+)(?:u|s\d+)$/.exec(id) : null;
      return match == null ? highest : Math.max(highest, Number(match[1]));
    }, -1);
    const localTurn = (beforeUser.agents[agentId] ?? []).reduce((highest, entry) => {
      const match = /^t(\d+)(?:u|s\d+)$/.exec(entry.id);
      return match == null ? highest : Math.max(highest, Number(match[1]));
    }, -1);
    const turn = Math.max(remoteTurn, localTurn) + 1;
    const readAttachmentImage = createRoutedImageReader(options.dispatchRemote);
    const storedAttachments: StoredAttachmentEntry[] = await Promise.all(collected.attachments.map(async (attachment) => {
      // The 0.18 transcript reserves exact image boxes from row width/height;
      // rows without them re-measure on load and destabilize scrolling, so
      // sniff dimensions from the image bytes when the sender did not supply
      // them (official sends persist width/height the same way).
      let width = attachment.width ?? null;
      let height = attachment.height ?? null;
      if ((width == null || height == null) && imageMimeFromPath(attachment.file_path) != null) {
        const part = await readAttachmentImage(attachment.file_path);
        const sniffed = part == null ? null : readImageFileDimensions(part.image);
        if (sniffed != null) { width = sniffed.width; height = sniffed.height; }
      }
      return {
        provider,
        kind: USER_ATTACHMENT_KIND,
        id: attachment.id,
        file_path: attachment.file_path,
        ...(attachment.file_name == null ? {} : { file_name: attachment.file_name }),
        ...(attachment.byteSize == null ? {} : { byteSize: attachment.byteSize }),
        ...(width == null ? {} : { width }),
        ...(height == null ? {} : { height }),
        timestampMs: attachment.timestampMs ?? timestampMs,
        clientNonce,
        ...(attachment.batchId == null ? {} : { batchId: attachment.batchId }),
        ...(attachment.replyTo == null ? {} : { replyTo: attachment.replyTo }),
      };
    }));
    const userEntry = prompt.length > 0
      ? { kind: "message", id: `t${turn}u`, role: "user" as const, content: prompt, ...(richText === undefined ? {} : { richText }), isStreaming: false, timestampMs, clientNonce, ...(collected.batchId == null ? {} : { batchId: collected.batchId }) }
      : null;
    const storedUser = userEntry == null ? null : { provider, role: "user" as const, content: prompt, ...(richText === undefined ? {} : { richText }), id: userEntry.id, clientNonce, timestampMs, ...(collected.batchId == null ? {} : { batchId: collected.batchId }) };
    const withUser = await append(agentId, [...storedAttachments, ...(storedUser == null ? [] : [storedUser])]);
    for (const attachment of storedAttachments) emitTranscript(agentId, "appended", persistableUserAttachmentEntry(attachment, attachment.id));
    if (userEntry != null) emitTranscript(agentId, "appended", userEntry);
    const endActivity = await beginActivity(agentId);
    // The shipped transcript intentionally suppresses its activity row as soon as
    // the first streamed assistant entry arrives. Direct providers can produce that
    // first delta in the same renderer reconciliation window as the roster update,
    // making the genuine composing state imperceptible. The shipped virtualized
    // transcript needs roughly 350 ms to materialize its trailing activity row,
    // so keep the composing state authoritative long enough for a clearly
    // perceptible rendered interval before normal token streaming begins.
    await new Promise<void>(resolve => setTimeout(resolve, ROUTED_COMPOSING_REVEAL_MS));
    const messages = await buildRoutedProviderMessages(withUser.agents[agentId] ?? [], {
      includeImageParts: provider === "openrouter" || provider === "codex",
      readImage: createRoutedImageReader(options.dispatchRemote),
    });
    let content: string;
    const assistantTimestampMs = now();
    const assistantId = `t${turn}s0`;
    let assistantStreamStarted = false;
    const emitAssistant = (nextContent: string, streaming: boolean) => {
      const entry = { kind: "send-message", id: assistantId, message: { type: "text", content: nextContent }, streaming, timestampMs: assistantTimestampMs };
      emitTranscript(agentId, assistantStreamStarted ? "updated" : "appended", entry);
      assistantStreamStarted = true;
    };
    const extraSystem = await automations.systemPrompt(agentId);
    // Every coordinator-native tool for this agent. These run in this process on
    // the user's Mac; only the plugin tools are dispatched out to the host.
    const nativeTools = [automations.extraTool(agentId), ...messagesTools.tools(agentId)];
    const nativeByName = new Map(nativeTools.map((tool) => [tool.name, tool]));
    const bridge = provider === "claude-code" ? await createRoutedMcpBridge({
      listTools: () => options.dispatchRemote("listRoutedMcpTools", {}).catch(() => []),
      callTool: tool => options.dispatchRemote("executeRoutedMcpTool", { ...tool, agentId }),
      extraTools: nativeTools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, execute: tool.execute })),
    }) : null;
    const directTools = bridge == null ? await options.dispatchRemote("listRoutedMcpTools", {}).catch(() => []) : undefined;
    const pluginTools = Array.isArray(directTools) ? directTools as Record<string, any>[] : [];
    const tools = [...nativeTools.map(({ execute: _execute, ...definition }) => definition), ...pluginTools];
    // Every raw delta previously posted a full transcript event, flooding the
    // renderer with hundreds of row updates per reply. Coalesce to one update
    // per window; the final non-streaming emit below always flushes.
    let lastStreamEmitMs = 0;
    let pendingStreamContent: string | null = null;
    let streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushStream = () => {
      streamFlushTimer = null;
      if (pendingStreamContent == null) return;
      lastStreamEmitMs = Date.now();
      const next = pendingStreamContent;
      pendingStreamContent = null;
      emitAssistant(next, true);
    };
    const onTextDelta = (_delta: string, accumulated: string) => {
      pendingStreamContent = accumulated;
      const elapsed = Date.now() - lastStreamEmitMs;
      if (elapsed >= ROUTED_STREAM_EMIT_INTERVAL_MS) { flushStream(); return; }
      streamFlushTimer ??= setTimeout(flushStream, ROUTED_STREAM_EMIT_INTERVAL_MS - elapsed);
    };
    try { content = await runRoutedProviderText(provider, messages, {
      extraSystem,
      onTextDelta,
      openRouterModel: settings.getOpenRouterModel() ?? null,
      ...(bridge == null ? {
        tools,
        executeTool: async (definition, toolArgs, toolCallId) => (nativeByName.get(definition.name) ?? nativeByName.get(definition.toolName)) != null
          ? await (nativeByName.get(definition.name) ?? nativeByName.get(definition.toolName))!.execute(toolArgs)
          : await options.dispatchRemote("executeRoutedMcpTool", {
            providerIdentifier: definition.providerIdentifier,
            name: definition.name,
            toolName: definition.toolName,
            args: toolArgs,
            toolCallId,
            agentId,
          }),
      } : { mcpServerUrl: bridge.url }),
    }); }
    finally { if (streamFlushTimer != null) clearTimeout(streamFlushTimer); pendingStreamContent = null; endActivity(); await bridge?.close(); }
    await append(agentId, [{ provider, role: "assistant", content, id: assistantId, timestampMs: assistantTimestampMs }]);
    emitAssistant(content, false);
    return { accepted: true, clientNonce, provider };
  };
  fireRoutine = async (agentId, prompt) => {
    const provider = settings.getInferenceProvider();
    if (provider === "cursor") return;
    await execute(provider, { agentId, prompt });
  };

  return {
    provider(): SandInferenceProvider { return settings.getInferenceProvider(); },
    async dispatch(method: string, args: unknown): Promise<{ handled: boolean; value?: unknown }> {
      const provider = settings.getInferenceProvider();
      if (method === "reactToMessage") {
        const record = asRecord(args) ?? {};
        const agentId = typeof record.agentId === "string" ? record.agentId : "";
        const entryId = typeof record.entryId === "string" ? record.entryId : "";
        const emoji = typeof record.emoji === "string" ? record.emoji : "";
        const updated = await toggleLocalReaction(agentId, entryId, emoji);
        if (updated != null) {
          emitTranscript(agentId, "updated", updated);
          return { handled: true, value: undefined };
        }
      }
      // Only answers cards this coordinator raised; a host-owned ask returns
      // handled:false and carries on to the gateway exactly as before.
      if (method === "resolveLocalToolPermission" && messagesTools.resolveAsk(args)) {
        return { handled: true, value: undefined };
      }
      if (provider !== "cursor" && LOCAL_ROSTER_METHODS.has(method)) {
        return { handled: true, value: await dispatchLocalRoster(method, args) };
      }
      if (provider !== "cursor" && LOCAL_AUTOMATION_METHODS.has(method)) {
        return { handled: true, value: await automations.dispatch(method, args) };
      }
      if (method === "deleteTranscriptEntries") {
        const record = asRecord(args) ?? {};
        const agentId = typeof record.agentId === "string" ? record.agentId : "";
        const entryIds = Array.isArray(record.entryIds) ? record.entryIds.filter((id): id is string => typeof id === "string") : [];
        const result = await deleteLocalEntries(agentId, entryIds);
        if (result != null) {
          for (const id of result.deleted) emitTranscriptRemoval(agentId, id);
          return { handled: true, value: result };
        }
      }
      if (provider !== "cursor" && LOCAL_TRANSCRIPT_METHODS.has(method)) {
        const record = asRecord(args) ?? {};
        const agentId = typeof record.id === "string" ? record.id : "";
        void backfillAttachmentDimensions(agentId).catch(() => { /* best effort */ });
        const local = await load();
        const entries = (local.agents[agentId] ?? []).map(projectInferenceRouterTranscriptEntry);
        const limit = typeof record.limit === "number" && Number.isInteger(record.limit) && record.limit > 0 ? record.limit : 500;
        return { handled: true, value: { entries: entries.slice(-limit), threadCounts: {} } };
      }
      if (method !== "sendPrompt" || provider === "cursor") return { handled: false };
      const record = asRecord(args) ?? {};
      const agentId = typeof record.agentId === "string" ? record.agentId : "";
      const previous = queues.get(agentId) ?? Promise.resolve();
      const next = previous.catch(() => undefined).then(async () => {
        if (isSubscriptionInferenceProvider(provider)) {
          const status = await subscriptionAuth.getStatus(provider);
          if (!status.authenticated) throw new Error(status.prompt);
        }
        return execute(provider, record);
      }).catch(async (error) => {
        const timestampMs = now();
        const content = `Router error: ${error instanceof Error ? error.message : String(error)}`;
        if (agentId.length > 0) {
          const id = `t${Date.now()}s0`;
          await append(agentId, [{ provider, role: "assistant", content, id, timestampMs }]);
          emitTranscript(agentId, "appended", { kind: "send-message", id, message: { type: "text", content }, timestampMs });
        }
      });
      const queued = next.finally(() => { if (queues.get(agentId) === queued) queues.delete(agentId); });
      queues.set(agentId, queued);
      void queued;
      return { handled: true, value: { accepted: true, clientNonce: record.clientNonce, provider } };
    },
  };
}
