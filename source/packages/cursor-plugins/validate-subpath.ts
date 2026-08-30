import { isAbsolute, relative, resolve } from "node:path";
export function validateAndResolveSubpath(baseDir: string, subPath: string): string {
  const resolvedBase = resolve(baseDir), resolved = resolve(baseDir, subPath), rel = relative(resolvedBase, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Invalid subPath: path traversal not allowed (${JSON.stringify(subPath)})`);
  return resolved;
}
