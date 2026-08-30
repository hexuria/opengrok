import { z } from "zod";

import { lenientArray } from "../../../lenient-array.js";

export interface SandboxNetworkInfo {
  readonly hasDefaults: boolean;
  readonly explicitEntries: readonly string[];
}

export function hasNetworkAllowlist(info: SandboxNetworkInfo | undefined): boolean {
  if (!info) return false;
  return info.hasDefaults || info.explicitEntries.length > 0;
}

export function getRequiredPermissionsSchema(options: { readonly isReadonly: boolean; readonly strict?: boolean }): z.ZodTypeAny {
  if (options.isReadonly) {
    return lenientArray(z.array(z.enum(["full_network", "network"])), {
      field: "required_permissions",
      primitiveItems: true,
    }).optional().describe("Optional list of permissions to request if the command needs them (full_network).");
  }
  if (options.strict === true) {
    return lenientArray(z.array(z.enum(["full_network", "all"])).max(1), {
      field: "required_permissions",
      primitiveItems: true,
    }).optional().describe("Optional list of permissions to request if the command needs them (full_network, all).");
  }
  return lenientArray(z.array(z.enum(["git_write", "full_network", "network", "all"])), {
    field: "required_permissions",
    primitiveItems: true,
  }).optional().describe("Optional list of permissions to request if the command needs them (full_network, all).");
}
