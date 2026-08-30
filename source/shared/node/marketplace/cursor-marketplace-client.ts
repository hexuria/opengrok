import { createClient, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";

import { DashboardService } from "../../../packages/proto/generated/aiserver/v1/dashboard_connect.js";
import { createCursorChecksum, getSandInferenceBackendUrl } from "../cursor-backend/cursor-inference.js";
import { getSandBackendClientHeaders } from "../sand-client-metadata.js";

export const CURSOR_MARKETPLACE_REQUEST_TIMEOUT_MS = 12_000;
export interface MarketplaceHeader { set(name: string, value: string): void }
export interface MarketplaceRequest { readonly header: MarketplaceHeader }
export type MarketplaceNext<Request extends MarketplaceRequest, Response> = (request: Request) => Promise<Response>;

export async function bestEffortToken(getAccessToken: () => Promise<string | null | undefined>): Promise<string | undefined> {
  try { const token = await getAccessToken(); return token != null && token.length > 0 ? token : undefined; } catch { return undefined; }
}

export function createMarketplaceInterceptor<Request extends MarketplaceRequest, Response>(
  getAccessToken: () => Promise<string | null | undefined>,
  getMachineId?: () => Promise<string>,
  options: { readonly env?: NodeJS.ProcessEnv; readonly uuid?: () => string } = {},
) {
  return (next: MarketplaceNext<Request, Response>): MarketplaceNext<Request, Response> => async (request) => {
    try { if (getMachineId != null) request.header.set("x-cursor-checksum", createCursorChecksum(await getMachineId())); } catch {}
    for (const [name, value] of Object.entries(getSandBackendClientHeaders(options.env))) request.header.set(name, value);
    request.header.set("x-ghost-mode", "true");
    request.header.set("x-request-id", options.uuid?.() ?? globalThis.crypto.randomUUID());
    const token = await bestEffortToken(getAccessToken); if (token != null) request.header.set("authorization", `Bearer ${token}`);
    return await next(request);
  };
}

export function createDashboardClient(
  getAccessToken: () => Promise<string | null | undefined>,
  getMachineId?: () => Promise<string>,
) {
  const transport = createConnectTransport({
    baseUrl: getSandInferenceBackendUrl(),
    httpVersion: "1.1",
    interceptors: [createMarketplaceInterceptor(getAccessToken, getMachineId) as Interceptor]
  });
  return createClient(DashboardService, transport);
}
