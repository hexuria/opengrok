import { parseJwtPayload } from "../../../shared/node/cursor-token.js";
import { createSandCursorBackendClient, getSandInferenceBackendUrl } from "../../../shared/node/cursor-backend/cursor-inference.js";
import { DashboardService } from "../../../packages/proto/generated/aiserver/v1/dashboard_connect.js";
import { GetMeRequest, type GetMeResponse } from "../../../packages/proto/generated/aiserver/v1/dashboard_pb.js";
import type { MethodInfoUnary } from "@bufbuild/protobuf";

export const GET_ME_TIMEOUT_MS = 10_000;

export function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed != null && trimmed.length > 0 ? trimmed : undefined;
}

export function displayNameFrom(name: { readonly firstName?: string | undefined; readonly lastName?: string | undefined }): string | undefined {
  const parts = [name.firstName?.trim(), name.lastName?.trim()].filter((part): part is string => part != null && part.length > 0);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

async function fetchFullNameOverBackend(accessToken: string, getMachineId: () => Promise<string>): Promise<string | undefined> {
  const service = DashboardService as typeof DashboardService & {
    readonly methods: typeof DashboardService.methods & {
      readonly getMe: MethodInfoUnary<GetMeRequest, GetMeResponse>;
    };
  };
  const client = createSandCursorBackendClient(service, {
    getAccessToken: async () => accessToken,
    getMachineId
  });
  const me = await client.getMe(new GetMeRequest({}), { timeoutMs: GET_ME_TIMEOUT_MS });
  return nonEmpty(displayNameFrom({ firstName: me.firstName, lastName: me.lastName }));
}

export function createSandUserFullNameResolver(options: {
  readonly getAccessToken: (options: { readonly backendUrl: string }) => Promise<string>;
  readonly peekAccessToken: () => string | null;
  readonly getMachineId: () => Promise<string>;
  readonly fetchFullName?: (accessToken: string) => Promise<string | undefined>;
  readonly log: (message: string) => void;
}) {
  const fetchFullName = options.fetchFullName ?? ((accessToken: string) => fetchFullNameOverBackend(accessToken, options.getMachineId));
  let resolvedPrincipal: string | undefined;
  let resolvedFullName: string | undefined;
  let inFlight: { principal: string; done: Promise<void> } | undefined;
  let inFlightGeneration = 0;
  const currentPrincipal = () => {
    const token = options.peekAccessToken();
    return token == null ? undefined : parseJwtPayload(token)?.sub;
  };
  const resolve = async (principal: string) => {
    try {
      const accessToken = await options.getAccessToken({ backendUrl: getSandInferenceBackendUrl() });
      if (parseJwtPayload(accessToken)?.sub !== principal) return;
      const fullName = await fetchFullName(accessToken);
      if (currentPrincipal() !== principal) return;
      resolvedPrincipal = principal;
      resolvedFullName = fullName;
    } catch (error) { options.log(`user full-name resolve failed: ${String(error)}`); }
  };
  return {
    getUserFullName: (): string | undefined => resolvedPrincipal !== undefined && resolvedPrincipal === currentPrincipal() ? resolvedFullName : undefined,
    async refresh(): Promise<void> {
      const principal = currentPrincipal();
      if (principal === undefined || resolvedPrincipal === principal) return;
      let pending = inFlight;
      if (pending === undefined || pending.principal !== principal) {
        const generation = ++inFlightGeneration;
        pending = { principal, done: resolve(principal).finally(() => { if (inFlightGeneration === generation) inFlight = undefined; }) };
        inFlight = pending;
      }
      await pending.done;
    }
  };
}
