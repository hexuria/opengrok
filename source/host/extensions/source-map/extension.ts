import { defineHostExtension } from "../../../internal/host-extensions.js";
import { HostExtensions } from "../extension-ids.generated.js";
import { SandSourceMap } from "./source-map-service.js";

export const sourceMapExtension = defineHostExtension({ id: HostExtensions.SourceMap, dependencies: [], start: () => new SandSourceMap() });

