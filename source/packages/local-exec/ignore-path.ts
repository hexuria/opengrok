import { isAbsolute } from "node:path";
import { resolveRealPathStrict } from "../utils/path-utils.js";

function makeResolvedIgnorePath(path: string): string {
  return path;
}

export async function resolvePathForIgnoreService(absolutePath: string): Promise<string | null> {
  if (!isAbsolute(absolutePath)) return null;
  const resolved = await resolveRealPathStrict(absolutePath);
  if (resolved === null) return null;
  return makeResolvedIgnorePath(resolved);
}
