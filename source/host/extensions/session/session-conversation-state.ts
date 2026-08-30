import {
  bootstrapTranscriptRead,
  overlayTranscriptEntries,
  overlayTranscriptWindow,
} from "../../transcript-server/transcript-server-bridge.js";
import { SandAgentDb, type TranscriptEntry } from "./agent-db.js";
import { cacheBlobReads } from "./session-recovery.js";
import { conversationStructureFullyResolves } from "./conversation-recovery.js";
import { getAgentDbPath } from "./session-paths.js";
interface BlobStore<T=Uint8Array>{getBlob(ctx:unknown,id:Uint8Array):Promise<T|null>;setBlob(ctx:unknown,id:Uint8Array,data:T):Promise<void>;flush(ctx:unknown):Promise<void>}
interface Structure{turns:readonly Uint8Array[];todos:readonly Uint8Array[];summary?:Uint8Array}
interface ConversationSession{db:{getTranscriptEntries():TranscriptEntry[];close():void};agentStore:{getFullConversation(ctx:unknown):Promise<unknown>;dispose():Promise<void>}}
interface ConversationStateHost{rootDir:string;ctx:unknown;openSession(id:string):Promise<ConversationSession>;deriveOutline(state:unknown):unknown;deriveState(structure:Structure,store:BlobStore):Promise<{turns:readonly unknown[]}>}
export class SandSessionConversationState{
  constructor(readonly host:ConversationStateHost){}
  async resolveConversationState(structure:Structure,blobStore:BlobStore):Promise<{turns:readonly unknown[]}|null>{const cached=cacheBlobReads(blobStore);if(!await conversationStructureFullyResolves(this.host.ctx,structure,cached))return null;const state=await this.host.deriveState(structure,cached);return state.turns.length===0||state.turns.length<structure.turns.length?null:state}
  async getTranscriptEntries(session:Pick<ConversationSession,"db">):Promise<TranscriptEntry[]>{return session.db.getTranscriptEntries()}
  async getSessionOutline(session:Pick<ConversationSession,"agentStore">):Promise<unknown>{return this.host.deriveOutline(await session.agentStore.getFullConversation(this.host.ctx))}
  async getAgentOutline(id:string):Promise<unknown>{const session=await this.host.openSession(id);try{return await this.getSessionOutline(session)}finally{await session.agentStore.dispose();session.db.close()}}
  private readDb<T>(agentId:string,read:(db:SandAgentDb)=>T,fallback:T):T{let db:SandAgentDb|undefined;try{db=new SandAgentDb(getAgentDbPath(this.host.rootDir,agentId),{recoverOnCorruption:false});return read(db)}catch{return fallback}finally{db?.close()}}
  readAgentTranscriptEntries(agentId:string){return overlayTranscriptEntries(agentId,this.readDb(agentId,(db)=>db.getTranscriptEntries(),[])) as TranscriptEntry[]}
  readAgentTranscriptPage(agentId:string,query:{beforeSeq?:number;sinceMs?:number;untilMs:number;limit:number}){return overlayTranscriptWindow(agentId,this.readDb(agentId,(db)=>db.getTranscriptPage(query),{entries:[]}))}
  readAgentTranscriptWindow(agentId:string,query:{beforeSeq?:number;limit:number}){return overlayTranscriptWindow(agentId,this.readDb(agentId,(db)=>db.getTranscriptWindow(query),{entries:[],threadCounts:{}}))}
  readAgentTranscriptTail(agentId:string,query:{beforeSeq?:number;limit:number}){return overlayTranscriptWindow(agentId,this.readDb(agentId,(db)=>db.getTranscriptTail(query),{entries:[]}))}
  readAgentThread(agentId:string,rootId:string){return overlayTranscriptWindow(agentId,this.readDb(agentId,(db)=>db.getThread(rootId),{entries:[]}))}
  async getAgentTranscriptEntries(id:string):Promise<TranscriptEntry[]>{const session=await this.host.openSession(id);try{return await bootstrapTranscriptRead(id,await this.getTranscriptEntries(session)) as TranscriptEntry[]}finally{await session.agentStore.dispose();session.db.close()}}
}
