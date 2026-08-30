import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import { parseJwtPayload } from "../../../shared/node/cursor-token.js";

export const UA_OWNER_STAMP_PATH = "/tmp/sand-ua-user";
export const UA_OWNER_STAMP_LENGTH = 16;

export function uaOwnerStampForAccessToken(accessToken: string): string | null {
  const sub = parseJwtPayload(accessToken)?.sub;
  return sub == null || sub.length === 0 ? null : createHash("sha256").update(sub, "utf8").digest("hex").slice(0, UA_OWNER_STAMP_LENGTH);
}

export function createUaOwnerStampWriter(options: { readonly path?: string; readonly log: (message: string) => void }) {
  const path = options.path ?? UA_OWNER_STAMP_PATH;
  let lastWritten: string | null = null;
  return async (accessToken: string | null): Promise<void> => {
    if (accessToken == null) return;
    const stamp = uaOwnerStampForAccessToken(accessToken);
    if (stamp == null || stamp === lastWritten) return;
    const tempPath = `${path}.tmp`;
    try {
      await fs.writeFile(tempPath, `${stamp}\n`, { encoding: "utf8", mode: 0o644 });
      await fs.rename(tempPath, path);
      lastWritten = stamp;
    } catch (error) { options.log(`ua-owner stamp write failed: ${String(error)}`); }
  };
}

