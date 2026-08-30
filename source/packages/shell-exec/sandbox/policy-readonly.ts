import { ensureSandboxPolicyDirectory } from "./policy-file.js";

export function withPolicyDirectoryReadonly(additionalReadonlyPaths?: readonly string[]): readonly string[] {
  const directory = ensureSandboxPolicyDirectory();
  if (additionalReadonlyPaths === undefined || additionalReadonlyPaths.length === 0) {
    return [directory];
  }
  if (additionalReadonlyPaths.includes(directory)) {
    return additionalReadonlyPaths;
  }
  return [...additionalReadonlyPaths, directory];
}

export function withSandboxPolicyDirectoryReadonly<Policy extends { readonly additionalReadonlyPaths?: readonly string[] }>(policy: Policy): Policy & { readonly additionalReadonlyPaths: readonly string[] } {
  return {
    ...policy,
    additionalReadonlyPaths: withPolicyDirectoryReadonly(policy.additionalReadonlyPaths),
  };
}
