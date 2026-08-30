const ERRNO_TOKEN = /\b(E[A-Z0-9]+)\b/;

export type LocalExecFailureClass = "other" | "spawn_enoent" | "spawn_permissions" | "spawn_other";
export interface LocalExecFailureClassification { readonly errorClass: LocalExecFailureClass; readonly errno?: string; }

export function classifyLocalExecFailure(message: string): LocalExecFailureClassification {
  const isSpawn = /\bspawn(?:Sync)?\b/i.test(message);
  const errno = ERRNO_TOKEN.exec(message)?.[1];
  if (!isSpawn) return errno === undefined ? { errorClass: "other" } : { errorClass: "other", errno };
  if (errno === "ENOENT") return { errorClass: "spawn_enoent", errno };
  if (errno === "EACCES" || errno === "EPERM") return { errorClass: "spawn_permissions", errno };
  return errno === undefined ? { errorClass: "spawn_other" } : { errorClass: "spawn_other", errno };
}

