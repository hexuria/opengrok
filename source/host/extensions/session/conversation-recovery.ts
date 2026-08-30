import { ConversationStateStructure } from "../../../packages/proto/generated/agent/v1/agent_pb.js";
import { toHex, fromHex } from "../../../packages/agent-kv/serde.js";

export const MAX_ROOT_BLOB_BYTES = 8 * 1024 * 1024;
export const REBUILT_ENTRY_ID_PREFIX = "recovered-";
export interface OutlineItem{kind:"user"|"send-message"|"tool-call";id:string;hidden?:boolean;text?:string;message?:unknown;name?:string;status?:string;summary?:string;timestampMs?:number}
export function rebuildTranscriptEntriesFromState(state:{turns:readonly{items:readonly OutlineItem[]}[]}):Array<Record<string,unknown>>{const entries:Array<Record<string,unknown>>=[];for(const turn of state.turns)for(const item of turn.items){if(item.kind==="user"&&!item.hidden)entries.push({kind:"message",id:`${REBUILT_ENTRY_ID_PREFIX}${item.id}`,role:"user",content:item.text??"",isStreaming:false,...(item.timestampMs==null?{}:{timestampMs:item.timestampMs})});else if(item.kind==="send-message")entries.push({kind:"send-message",id:`${REBUILT_ENTRY_ID_PREFIX}${item.id}`,message:item.message,...(item.timestampMs==null?{}:{timestampMs:item.timestampMs})});else if(item.kind==="tool-call")entries.push({kind:"tool-call",id:`${REBUILT_ENTRY_ID_PREFIX}${item.id}`,name:item.name,status:item.status,...(item.summary==null?{}:{summary:item.summary}),...(item.timestampMs==null?{}:{timestampMs:item.timestampMs})})}return entries}
export function selectHiddenArtifactEntryIds(entries:readonly Record<string,unknown>[],outline:readonly OutlineItem[]):string[]{const byId=new Map(outline.map(x=>[x.id,x]));return entries.flatMap(entry=>{if(entry.kind!=="message"||entry.role!=="user"||typeof entry.id!=="string"||!entry.id.startsWith("recovered-"))return[];const source=byId.get(entry.id.slice(10));return source?.kind==="user"&&source.hidden===true&&source.text===entry.content?[entry.id]:[]})}
export async function conversationStructureFullyResolves(ctx:unknown,structure:{turns:readonly Uint8Array[];todos:readonly Uint8Array[];summary?:Uint8Array},blobStore:{getBlob(ctx:unknown,id:Uint8Array):Promise<Uint8Array|null>}):Promise<boolean>{if(structure.turns.length===0)return false;for(const id of[...structure.turns,...structure.todos]){const blob=await blobStore.getBlob(ctx,id);if(blob==null||blob.byteLength>MAX_ROOT_BLOB_BYTES)return false}if(structure.summary?.length){const blob=await blobStore.getBlob(ctx,structure.summary);if(blob==null||blob.byteLength>MAX_ROOT_BLOB_BYTES)return false}return true}

interface RootScore { turns: number; rootPrompts: number; bytes: number }

export function scoreRootCandidate(data: Uint8Array, presentIds: ReadonlySet<string>): RootScore | null {
  if (data.length > MAX_ROOT_BLOB_BYTES) return null;
  let structure: ConversationStateStructure;
  try {
    structure = ConversationStateStructure.fromBinary(data);
  } catch {
    return null;
  }
  const turns = structure.turns;
  if (turns.length === 0) return null;
  for (const turnId of turns) {
    if (!presentIds.has(toHex(turnId))) return null;
  }
  return {
    turns: turns.length,
    rootPrompts: structure.rootPromptMessagesJson.length,
    bytes: data.length,
  };
}

export function isBetterRoot(candidate: RootScore, best: RootScore | null): boolean {
  if (best == null) return true;
  if (candidate.turns !== best.turns) return candidate.turns > best.turns;
  if (candidate.rootPrompts !== best.rootPrompts) return candidate.rootPrompts > best.rootPrompts;
  return candidate.bytes > best.bytes;
}

interface RootDatabase {
  prepare(sql: string): { iterate(): Iterable<unknown> };
}

export function findLatestRootBlobIdInDatabase(db: RootDatabase): Uint8Array | null {
  const presentIds = new Set<string>();
  const idStatement = db.prepare("SELECT id FROM blobs");
  for (const raw of idStatement.iterate()) {
    const row = raw as { id?: unknown };
    if (typeof row.id === "string") presentIds.add(row.id);
  }
  let bestId: string | null = null;
  let bestScore: RootScore | null = null;
  const blobStatement = db.prepare("SELECT id, data FROM blobs");
  for (const raw of blobStatement.iterate()) {
    const row = raw as { id?: unknown; data?: unknown };
    if (typeof row.id !== "string" || !(row.data instanceof Uint8Array)) continue;
    const score = scoreRootCandidate(row.data, presentIds);
    if (score != null && isBetterRoot(score, bestScore)) {
      bestScore = score;
      bestId = row.id;
    }
  }
  return bestId == null ? null : fromHex(bestId);
}
