export interface McpInstalledServer{readonly id:string;readonly serverIdentifier:string;readonly [key:string]:unknown}
export function resolveMcpServerRowsByIdentifierOrLegacyId<T extends McpInstalledServer>(rows:readonly T[],token:string):T[]{const t=token.trim();if(!t)return[];const exact=rows.filter(r=>r.serverIdentifier===t);return exact.length?exact:rows.filter(r=>r.id===t)}
export const resolveMcpServerRowByIdentifierOrLegacyId=<T extends McpInstalledServer>(r:readonly T[],t:string):T|null=>resolveMcpServerRowsByIdentifierOrLegacyId(r,t)[0]??null;
export async function readMcpInstalledListing<T>(load:()=>Promise<readonly T[]>):Promise<{kind:"read";servers:readonly T[]}|{kind:"unreadable"}>{try{return{kind:"read",servers:await load()}}catch{return{kind:"unreadable"}}}

