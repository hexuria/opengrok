export interface NetworkPolicy { version: 1; default: "allow" | "deny"; allow?: readonly string[]; deny?: readonly string[] }
export const getEffectiveNetworkPolicy = (policy: NetworkPolicy | undefined): NetworkPolicy => policy !== undefined ? policy : { version: 1, default: "deny" };
export const isNetworkEnabledByPolicy = (policy: NetworkPolicy | undefined): boolean => policy !== undefined && (policy.default === "allow" || (policy.allow !== undefined && policy.allow.length > 0));
export const networkDisabledPolicy = (): NetworkPolicy => ({ version: 1, default: "deny" });
export const networkAllowAllPolicy = (): NetworkPolicy => ({ version: 1, default: "allow" });
