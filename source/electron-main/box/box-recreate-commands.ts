import type { SandBoxMigrationOperationId } from "../../shared/box-migration.js";

export type RecreateOperationId = SandBoxMigrationOperationId;
export type RecreateResult = { readonly status: "started"; readonly operationId: RecreateOperationId } | { readonly status: "started-untrackable" } | { readonly status: "dev-fallback" } | { readonly status: "rejected"; readonly reason: string };
export function createSandRecreateCommands<TArgs>(deps: { readonly connector: { recreate?: (args: TArgs) => Promise<RecreateResult>; forceRecreate?: () => Promise<RecreateResult> }; readonly noteRecreateAccepted: (operationId: RecreateOperationId | null) => void }) {
  const noteIfStarted = (result: RecreateResult) => { if (result.status === "started") deps.noteRecreateAccepted(result.operationId); else if (result.status === "started-untrackable") deps.noteRecreateAccepted(null); };
  return {
    async recreateComputer(args: TArgs): Promise<RecreateResult> { if (deps.connector.recreate == null) return { status: "dev-fallback" }; const result = await deps.connector.recreate(args); noteIfStarted(result); return result; },
    async forceRecreateComputer(): Promise<RecreateResult> { if (deps.connector.forceRecreate == null) return { status: "rejected", reason: "Reset Grok Bot's Computer is unavailable without a backend connection." }; const result = await deps.connector.forceRecreate(); noteIfStarted(result); return result; },
  };
}
