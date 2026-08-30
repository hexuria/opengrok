import type {
  CoordinatorAuthStatus,
  CoordinatorRefusedAccountResult,
} from "./coordinator-account-runtime.js";

export interface ProductionCoordinatorRefusalAuthService<Status extends CoordinatorAuthStatus> {
  revokeForAccountRefusal(): Promise<CoordinatorRefusedAccountResult<Status>>;
}

export interface ProductionCoordinatorRevokeRefusedAccount<Status extends CoordinatorAuthStatus> {
  revokeRefusedAccount(): Promise<CoordinatorRefusedAccountResult<Status>>;
}

/**
 * Typed handoff for the immutable refusal path. Revocation remains owned by
 * the auth service, so cancellation, retained-credential errors, status
 * identity, and disposal stay in that service rather than being rewritten at
 * the coordinator boundary.
 */
export function createProductionCoordinatorRevokeRefusedAccount<Status extends CoordinatorAuthStatus>(
  getAuthService: () => Promise<ProductionCoordinatorRefusalAuthService<Status>>,
): ProductionCoordinatorRevokeRefusedAccount<Status> {
  return {
    async revokeRefusedAccount(): Promise<CoordinatorRefusedAccountResult<Status>> {
      return await (await getAuthService()).revokeForAccountRefusal();
    },
  };
}
