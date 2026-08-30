import { defineHostExtension } from "../../../internal/host-extensions.js";
import { HostExtensions } from "../extension-ids.generated.js";
import { SettingsService } from "./settings-service.js";

export const settingsExtension = defineHostExtension({ id: HostExtensions.Settings, dependencies: [], start: () => new SettingsService() });
