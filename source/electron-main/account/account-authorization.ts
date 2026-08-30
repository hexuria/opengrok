import { accountCacheScope } from "../../shared/node/cursor-token.js";

export function createDesktopAccountAuthorizer(deps: {
  readonly binding?: { authorize(args: { accountSlot: string; descriptorUrl: string; allowExistingDataClaim: boolean; hasExistingDurableData: () => boolean | Promise<boolean> }): Promise<boolean> };
  readonly descriptorUrl?: string;
  readonly hasExistingDurableData: () => boolean | Promise<boolean>;
  readonly store: { getMcpCustomInstructionsAccountScope(): string | null | undefined; scopeToAccount(scope: string): void };
  readonly abandonForeignOnboardingMirror: () => void;
}) {
  return async (slot: string, context: { readonly isStartup: boolean; readonly previousSlot?: string | null }): Promise<boolean> => {
    const authorized = deps.binding == null || deps.descriptorUrl == null ? true : await deps.binding.authorize({ accountSlot: slot, descriptorUrl: deps.descriptorUrl, allowExistingDataClaim: context.isStartup && context.previousSlot === undefined, hasExistingDurableData: deps.hasExistingDurableData });
    if (authorized) {
      const scope = accountCacheScope(slot);
      const storedScope = deps.store.getMcpCustomInstructionsAccountScope();
      if (storedScope != null && storedScope !== scope) deps.abandonForeignOnboardingMirror();
      deps.store.scopeToAccount(scope);
    }
    return authorized;
  };
}
