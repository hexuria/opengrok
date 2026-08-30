import { join } from "node:path";

import { createDesktopAccountAuthorizer } from "./account-authorization.js";
import {
  createEnvDescriptorAccountBinding,
  hasExistingDevBoxDurableData,
} from "./env-descriptor-account-binding.js";
import {
  resolveDevBoxControlPlaneConfig,
  type DevBoxControlPlaneConfig,
} from "../dev/dev-box-recreate-plane.js";

export interface ProductionAccountAuthorizationPorts {
  readonly env: NodeJS.ProcessEnv;
  readonly isPackaged: boolean;
  readonly userDataDir: string;
  readonly store: {
    getMcpCustomInstructionsAccountScope(): string | null | undefined;
    scopeToAccount(scope: string): void;
  };
  readonly abandonForeignOnboardingMirror: () => void;
  readonly onBindingCleanupFailure?: (error: unknown) => void;
}

export interface ProductionAccountAuthorization {
  readonly descriptorUrl?: string;
  readonly devBoxConfig: DevBoxControlPlaneConfig | null;
  readonly authorizeAccount: (
    slot: string,
    context: { readonly isStartup: boolean; readonly previousSlot?: string | null },
  ) => Promise<boolean>;
}

/**
 * Reproduces the immutable root's descriptor/dev-box authorization decision.
 * The returned authorizer scopes settings only after the persistent descriptor
 * binding accepts the account; no coordinator or activation registration is
 * performed here.
 */
export function createProductionAccountAuthorization(
  ports: ProductionAccountAuthorizationPorts,
): ProductionAccountAuthorization {
  const descriptorUrl = ports.env.SAND_HOST_GATEWAY_URL?.trim();
  const descriptorBinding = descriptorUrl == null || descriptorUrl.length === 0
    ? undefined
    : createEnvDescriptorAccountBinding(
      join(ports.userDataDir, ".env-descriptor-account-bindings.json"),
      ports.onBindingCleanupFailure,
    );
  const devBoxConfig = resolveDevBoxControlPlaneConfig(ports.env, {
    isPackaged: ports.isPackaged,
  });
  const hasExistingDurableData = async (): Promise<boolean> => {
    if (devBoxConfig == null) return true;
    return await hasExistingDevBoxDurableData(devBoxConfig.devBoxRoot);
  };
  const authorize = createDesktopAccountAuthorizer({
    ...(descriptorBinding === undefined ? {} : { binding: descriptorBinding }),
    ...(descriptorUrl == null || descriptorUrl.length === 0 ? {} : { descriptorUrl }),
    hasExistingDurableData,
    store: ports.store,
    abandonForeignOnboardingMirror: ports.abandonForeignOnboardingMirror,
  });
  return {
    ...(descriptorUrl == null || descriptorUrl.length === 0 ? {} : { descriptorUrl }),
    devBoxConfig,
    authorizeAccount: authorize,
  };
}
