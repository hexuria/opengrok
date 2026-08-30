import path from "node:path";
export function getRequestPathModule(requestContext: { env?: { osVersion?: string } }): typeof path.posix | typeof path.win32 {
  return requestContext.env?.osVersion?.toLowerCase().includes("win32") === true ? path.win32 : path.posix;
}
