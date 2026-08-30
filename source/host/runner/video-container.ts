export const ASCII_MARKERS=[{offset:4,text:"ftyp"},{offset:0,text:"OggS"},{offset:0,text:"FLV"},{offset:8,text:"AVI "}]as const;
export const BYTE_MARKERS:readonly(readonly number[])[]=[[26,69,223,163],[48,38,178,117],[0,0,1,186],[0,0,1,179]];
export function hasAsciiAt(bytes:Uint8Array,offset:number,value:string):boolean{if(bytes.byteLength<offset+value.length)return false;for(let i=0;i<value.length;i+=1)if(bytes[offset+i]!==value.charCodeAt(i))return false;return true}
export function bytesLookLikeVideoContainer(bytes:Uint8Array):boolean{return ASCII_MARKERS.some(m=>hasAsciiAt(bytes,m.offset,m.text))||BYTE_MARKERS.some(m=>bytes.byteLength>=m.length&&m.every((b,i)=>bytes[i]===b))}

