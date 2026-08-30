export const BOX_VNC_RPC_CONTRACT_NAME = "box-vnc";
export const BOX_VNC_METHOD_TABLE = {
  readClipboard: { args: "none" },
  writeClipboard: { args: "object" },
  reportUserPresence: { args: "object" },
} as const;

export type BoxVncMethod = keyof typeof BOX_VNC_METHOD_TABLE;

export function isBoxVncMethod(value: string): value is BoxVncMethod {
  return Object.hasOwn(BOX_VNC_METHOD_TABLE, value);
}
