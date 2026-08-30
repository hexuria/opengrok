export const WINDOWS365_RESET_REJECT_REASON = "Reset the Cloud PC from the computer pane or Settings → Router.";
export const UNKNOWN_RUNTIME_RESET_REJECT_REASON = "This computer cannot use the hosted Grok VM reset.";
export const GROK_VM_RESET_WARNING = "This resets the hosted Grok VM (Grok Bot's Computer) for every client signed into this Cursor account.";

export type ComputerResetRoute =
  | { readonly action: "hosted-grok-vm" }
  | { readonly action: "local-docker" }
  | { readonly action: "reject"; readonly reason: string };

export function routeComputerReset(runtime: string | null | undefined): ComputerResetRoute {
  if (runtime === "remote") return { action: "hosted-grok-vm" };
  if (runtime === "local-docker") return { action: "local-docker" };
  if (runtime === "windows365") return { action: "reject", reason: WINDOWS365_RESET_REJECT_REASON };
  return { action: "reject", reason: UNKNOWN_RUNTIME_RESET_REJECT_REASON };
}

export function mayCallHostedGrokVmRecreate(runtime: string | null | undefined): boolean {
  return routeComputerReset(runtime).action === "hosted-grok-vm";
}

export async function dispatchComputerReset<T>(args: {
  readonly runtime: string | null | undefined;
  readonly hosted: () => Promise<T>;
  readonly localDocker: () => Promise<T>;
}): Promise<T | { readonly status: "rejected"; readonly reason: string }> {
  const route = routeComputerReset(args.runtime);
  if (route.action === "hosted-grok-vm") return await args.hosted();
  if (route.action === "local-docker") return await args.localDocker();
  return { status: "rejected", reason: route.reason };
}
