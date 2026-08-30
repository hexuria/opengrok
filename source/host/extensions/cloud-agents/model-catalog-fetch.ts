import { AiService } from "../../../packages/proto/generated/aiserver/v1/aiserver_connect.js";
import { AvailableModelsRequest, AvailableModelsScope } from "../../../packages/proto/generated/aiserver/v1/aiserver_pb.js";
import { mapAvailableModels, type SandModelCatalogEntry } from "../../../shared/agents/model-catalog.js";
import { createSandCursorBackendClient } from "../../../shared/node/cursor-backend/cursor-inference.js";

export interface FetchSandModelCatalogOptions {
  readonly getAccessToken: (options: { readonly backendUrl: string }) => Promise<string>;
  readonly getMachineId: () => Promise<string>;
  readonly onRequestId?: (requestId: string) => void;
}

export async function fetchSandModelCatalog(
  options: FetchSandModelCatalogOptions,
): Promise<SandModelCatalogEntry[]> {
  const client = createSandCursorBackendClient(AiService, options);
  const response = await client.availableModels(
    new AvailableModelsRequest({
      useModelParameters: true,
      doNotUseMarkdown: true,
      scope: AvailableModelsScope.USER_AVAILABLE,
    }),
  );
  return mapAvailableModels(response.models);
}
