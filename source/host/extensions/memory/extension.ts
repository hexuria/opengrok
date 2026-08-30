import type { DebouncePolicy } from "../../../internal/scheduling.js";
import { AgentProjectMembership } from "./project-membership.js";
import { createSandAgentState, type AgentStateDeps } from "./agent-state.js";
import { MemoryService } from "./memory-service.js";
export interface MemoryExtensionContext {
  sandRoot:string;agentsRootDir:string;debounce:DebouncePolicy;
  deps:{experiments:{pinGateOnAuthenticatedBootstrap(name:string,listener:(enabled:boolean)=>void):void};inference:{port:{createSession(onRequestId:(requestId:string)=>void,options:{modelId:string;isSummarizationSession:boolean;skipLabeling:boolean}):{getExecutor():import("../../../packages/chat-inference/base.js").PromptExecutor<Record<string,any>>}}};telemetry:{logs:{reportMemorySynthesis(event:unknown):void}}};
  createSynthesis(service:MemoryService):{start():void;dispose():void;recordTurn?(agentId:string,exchange:unknown):void};
  onStop(fn:()=>void):void;
}
export const memoryExtension={id:"memory",dependencies:["experiments","inference","telemetry"]as const,start(context:MemoryExtensionContext){const service=new MemoryService({sandRoot:context.sandRoot,agentsRootDir:context.agentsRootDir,debounce:context.debounce});context.deps.experiments.pinGateOnAuthenticatedBootstrap("sand_memory_dreaming",(enabled)=>{if(!enabled){context.deps.telemetry.logs.reportMemorySynthesis({outcome:"skipped_gate"});return}service.enableMemorySynthesis(context.createSynthesis(service))});context.onStop(()=>service.dispose());return Object.assign(service,{createAgentState:(options:Omit<AgentStateDeps,"sandRoot"|"membership">&{agentDir:string})=>createSandAgentState({...options,sandRoot:context.sandRoot,membership:new AgentProjectMembership(options.agentDir)})})}};
