import { defineHostExtension } from "../../../internal/host-extensions.js";
import { HostExtensions } from "../extension-ids.generated.js";
import { TurnExecutionRegistry } from "./turn-execution-service.js";

export const turnExecutionExtension = defineHostExtension({ id: HostExtensions.TurnExecution, dependencies: [], start: () => new TurnExecutionRegistry() });

