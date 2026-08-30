import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findSystemErrno } from "../system-errno.js";

export function isPathWithin(parent: string, child: string, options: { readonly isInclusive?: boolean } = {}): boolean {
  const rel = relative(resolve(parent), resolve(child));
  if (rel === "") return options.isInclusive ?? false;
  return !rel.startsWith("..") && !isAbsolute(rel);
}

export function filePathFromFileUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "file:" ? fileURLToPath(url) : null;
  } catch { return null; }
}

export function posixPathFromFileUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "file:" ? decodeURIComponent(url.pathname) : null;
  } catch { return null; }
}

export async function containWithin(roots: readonly string[], path: unknown): Promise<string | null> {
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path)) return null;
  const resolved = resolve(path);
  if (!roots.some((root) => isPathWithin(root, resolved))) return null;
  const [realResolved, realRoots] = await Promise.all([
    realpathNearestExisting(resolved),
    Promise.all(roots.map((root) => realpathNearestExisting(root)))
  ]);
  return realRoots.some((root) => isPathWithin(root, realResolved)) ? resolved : null;
}

export async function realpathNearestExisting(path: string): Promise<string> {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      const real = await realpath(current);
      return missing.length === 0 ? real : join(real, ...missing.reverse());
    } catch (error) {
      if (findSystemErrno(error) !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) return path;
      missing.push(basename(current));
      current = parent;
    }
  }
}

