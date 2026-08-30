import * as path from "node:path";
import { AGENT_STORE_SYNC_DIR_NAME } from "./paths.js";
import { readActiveStoreLockOwner, type StoreLockOwner } from "./store-lock.js";

const AGENT_STORE_EXCLUSIVE_MUTATION_LOCK_FILE_NAME = "exclusive-mutation.lock";

function exclusiveMutationLockPathForFilesDir(filesDir: string): string {
  return path.join(path.dirname(path.resolve(filesDir)), AGENT_STORE_SYNC_DIR_NAME, AGENT_STORE_EXCLUSIVE_MUTATION_LOCK_FILE_NAME);
}

export async function readAgentStoreExclusiveMutationClaimOwner(args: { readonly filesDir: string }): Promise<StoreLockOwner | undefined> {
  return await readActiveStoreLockOwner({
    lockPath: exclusiveMutationLockPathForFilesDir(args.filesDir),
  });
}
