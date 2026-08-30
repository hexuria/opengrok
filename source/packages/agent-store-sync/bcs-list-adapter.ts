import type { AgentStoreListFile, AgentStoreListing, AgentStoreTombstone } from "./bcs-transport.js";
import { normalizeRelPath } from "./safe-paths.js";

type FlatListArgs = {
  readonly files: readonly AgentStoreListFile[];
  readonly relPath: string;
  readonly tombstones?: readonly AgentStoreTombstone[];
  readonly listingComplete?: boolean;
};
type AdaptedFlatListing = Omit<AgentStoreListing, "tombstones" | "listingComplete"> & Partial<Pick<AgentStoreListing, "tombstones" | "listingComplete">>;

export function adaptFlatAgentStoreList(args: FlatListArgs & { readonly tombstones: readonly AgentStoreTombstone[]; readonly listingComplete: boolean }): AgentStoreListing;
export function adaptFlatAgentStoreList(args: FlatListArgs): AdaptedFlatListing;
export function adaptFlatAgentStoreList({ files, relPath, tombstones, listingComplete }: FlatListArgs): AdaptedFlatListing {
  const requestedRelPath = normalizeListDirRelPath(relPath);
  const prefix = listDirPrefix(requestedRelPath);
  const subdirs = new Set<string>();
  const matchedFiles: AgentStoreListFile[] = [];
  let skippedUnsafeEntries = 0;
  for (const file of files) {
    let normalizedPath: string;
    try {
      normalizedPath = normalizeRelPath(file.relPath);
    } catch {
      skippedUnsafeEntries += 1;
      continue;
    }
    collectSubdir({ prefix, relObjectPath: normalizedPath, subdirs });
    if (!normalizedPath.startsWith(prefix)) continue;
    matchedFiles.push({ ...file, relPath: normalizedPath });
  }
  return {
    files: matchedFiles.sort((left, right) => left.relPath.localeCompare(right.relPath)),
    subdirs: [...subdirs].sort(),
    ...(tombstones === undefined ? {} : { tombstones }),
    ...(listingComplete === undefined ? {} : { listingComplete }),
    skippedUnsafeEntries,
  };
}

function normalizeListDirRelPath(relPath: string): string {
  return relPath === "" ? "" : normalizeRelPath(relPath);
}

function listDirPrefix(requestedRelPath: string): string {
  return requestedRelPath.length === 0 ? "" : `${requestedRelPath.replace(/\/$/, "")}/`;
}

function collectSubdir({ prefix, relObjectPath, subdirs }: { readonly prefix: string; readonly relObjectPath: string; readonly subdirs: Set<string> }): void {
  if (!relObjectPath.startsWith(prefix)) return;
  const remaining = relObjectPath.slice(prefix.length);
  const firstSlash = remaining.indexOf("/");
  if (firstSlash > 0) subdirs.add(`${prefix}${remaining.slice(0, firstSlash)}`);
}
