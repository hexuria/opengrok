import{clampBlock,clampLine}from"../../../shared/sand-text.js";export const SECRET_REQUEST_MAX_LABEL_LENGTH=120,SECRET_REQUEST_MAX_DESCRIPTION_LENGTH=400;
export const clampSecretLabel=(v:string):string=>clampLine(v,120);export const clampSecretDescription=(v:string):string=>clampBlock(v,400);
export const summarizeSecretRequest=(r:{label:string}):string=>`Requested a secret from the user securely: ${r.label}`;
export function buildSecretProvidedAck(r:{label:string;target:{kind:string}}):string{return[`[The user securely provided the requested secret: "${r.label}". It was written straight to its destination (${r.target.kind}); you never see the value and it is not in this conversation.]`,"Confirm to the user that it is set, then continue. For a connector credential, the connection links within a few seconds, so you can check and report its status."].join("\n")}

