import { stat } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";

import type { Context } from "../context/core.js";
import { LsDirectoryTreeNode_File as LsDirectoryTreeFile, LsDirectoryTreeNode, LsError, LsResult, LsSuccess, LsTimeout } from "../proto/generated/agent/v1/ls_exec_pb.js";

const DEFAULT_CHARACTER_BUDGET = 2500;
const DEFAULT_TIMEOUT_MS = 5000;
const INT32_MAX = 2 ** 31 - 1;
function clampInt32(value: number): number { if(Number.isNaN(value))return 0;return Math.max(-(2**31),Math.min(INT32_MAX,value)); }
export interface LsIgnoreService { listCursorIgnoreFilesByRoot(root:string):Promise<readonly string[]>;getRepoBlockExcludeGlobs(root:string):Promise<readonly string[]>;isRepoBlocked(path:string):Promise<boolean>|boolean }
export interface LsTraversalRuntime { walk(ctx:Context,args:{root:string;excludeGlobs:readonly string[];cursorIgnoreFiles:readonly string[];sandboxPolicy?:unknown;source:"ls"}):{lines:AsyncIterable<string>;didTimeout:Promise<boolean>};resolveForIgnore(path:string):Promise<string|null> }
export class MissingLsTraversalBindingError extends Error { constructor(){super("");this.name="MissingLsTraversalBindingError";} }
export class LocalLsExecutor {
  constructor(private readonly _permissionsService:unknown,private readonly ignoreService:LsIgnoreService,private readonly workspacePath:string,private readonly traversal?:LsTraversalRuntime){}
  async execute(parentCtx:Context,args:{readonly path:string;readonly ignore?:readonly string[];readonly timeoutMs?:number;readonly sandboxPolicy?:unknown}):Promise<LsResult>{
    const path=resolve(this.workspacePath,args.path);
    try{let stats;try{stats=await stat(path);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return new LsResult({result:{case:"error",value:new LsError({path,error:`Path does not exist: ${path}`})}});return new LsResult({result:{case:"error",value:new LsError({path,error:error instanceof Error?error.message:"Unknown error occurred"})}});}
      if(!stats.isDirectory())return new LsResult({result:{case:"error",value:new LsError({path,error:`Path is not a directory: ${path}`})}});
      if(this.traversal===undefined)throw new MissingLsTraversalBindingError();
      const ctx=parentCtx.withTimeout(args.timeoutMs??DEFAULT_TIMEOUT_MS);const {tree,didTimeout}=await this.buildTree(ctx,path,args.ignore??[],args.sandboxPolicy,DEFAULT_CHARACTER_BUDGET);return didTimeout?new LsResult({result:{case:"timeout",value:new LsTimeout({directoryTreeRoot:tree})}}):new LsResult({result:{case:"success",value:new LsSuccess({directoryTreeRoot:tree})}});
    }catch(error){if(error instanceof MissingLsTraversalBindingError)throw error;return new LsResult({result:{case:"error",value:new LsError({path,error:error instanceof Error?error.message:"Unknown error occurred"})}});}
  }
  private async buildTree(ctx:Context,root:string,ignoreGlobs:readonly string[],sandboxPolicy:unknown,budget:number):Promise<{tree:LsDirectoryTreeNode;didTimeout:boolean}>{
    if(this.traversal===undefined)throw new MissingLsTraversalBindingError();const normalized=resolve(root);const tree=new LsDirectoryTreeNode({absPath:normalized,childrenDirs:[],childrenFiles:[],childrenWereProcessed:true,fullSubtreeExtensionCounts:{}});const dirs=new Map<string,LsDirectoryTreeNode>([[normalized,tree]]);const state={charactersUsed:normalized.length,budgetExceeded:false};const [cursorIgnoreFiles,repoGlobs]=await Promise.all([this.ignoreService.listCursorIgnoreFilesByRoot(root),this.ignoreService.getRepoBlockExcludeGlobs(root)]);const walked=this.traversal.walk(ctx,{root,excludeGlobs:[...ignoreGlobs,...repoGlobs],cursorIgnoreFiles,...(sandboxPolicy===undefined?{}:{sandboxPolicy}),source:"ls"});
    for await(const line of walked.lines){if(!line)continue;const filePath=resolve(root,line),resolved=await this.traversal.resolveForIgnore(filePath);if(resolved===null||await this.ignoreService.isRepoBlocked(resolved))continue;this.addPath(filePath,normalized,dirs,state,budget);}this.sort(tree);return{tree,didTimeout:await walked.didTimeout};
  }
  private addPath(filePath:string,root:string,dirs:Map<string,LsDirectoryTreeNode>,state:{charactersUsed:number;budgetExceeded:boolean},budget:number):void{const name=basename(filePath),dir=dirname(filePath);this.ensureDir(dir,root,dirs,state.budgetExceeded);const parent=dirs.get(dir);if(!parent)return;if(!state.budgetExceeded&&state.charactersUsed+name.length<=budget){parent.childrenFiles.push(new LsDirectoryTreeFile({name}));state.charactersUsed+=name.length;return;}if(!state.budgetExceeded){state.budgetExceeded=true;let current=dir;while(current.startsWith(root)){const node=dirs.get(current);if(node)node.childrenWereProcessed=false;const next=dirname(current);if(next===current)break;current=next;}}
    const extension=extname(filePath);let current=dir;while(current.startsWith(root)){const node=dirs.get(current);if(node){node.fullSubtreeExtensionCounts[extension]=clampInt32((node.fullSubtreeExtensionCounts[extension]??0)+1);node.numFiles=clampInt32((node.numFiles??0)+1);}const next=dirname(current);if(next===current)break;current=next;}}
  private ensureDir(path:string,root:string,dirs:Map<string,LsDirectoryTreeNode>,exceeded:boolean):void{if(dirs.has(path)||path===root)return;const parent=dirname(path);if(parent!==path&&parent.startsWith(root))this.ensureDir(parent,root,dirs,exceeded);const node=new LsDirectoryTreeNode({absPath:path,childrenDirs:[],childrenFiles:[],childrenWereProcessed:!exceeded,fullSubtreeExtensionCounts:{}});dirs.set(path,node);dirs.get(parent)?.childrenDirs.push(node);}
  private sort(node:LsDirectoryTreeNode):void{node.childrenDirs.sort((a,b)=>basename(a.absPath).localeCompare(basename(b.absPath)));node.childrenFiles.sort((a,b)=>a.name.localeCompare(b.name));for(const child of node.childrenDirs)this.sort(child);}
}
