import { defineHostExtension } from "../../../internal/host-extensions.js";
import { HostExtensions } from "../extension-ids.generated.js";
import { TrayManager } from "./trays-service.js";

export const traysExtension = defineHostExtension({
  id: HostExtensions.Trays, dependencies: [], start: () => {
    const trays = new TrayManager();
    return {
      list: () => trays.getTrays(), dismiss: ({ id }: { id: string }) => trays.dismiss(id), clearAll: () => trays.clearAll(),
      subscribe: (listener: Parameters<typeof trays.subscribe>[0]) => trays.subscribe(listener),
      pushError: (options: Parameters<typeof trays.pushError>[0]) => trays.pushError(options), clearForAgent: (agentId: string) => trays.clearForAgent(agentId)
    };
  }
});

