import { DeadlineExceededError, type DeadlinePolicy } from "../internal/scheduling.js";

export { DeadlineExceededError } from "../internal/scheduling.js";

export const PASSKEY_STALL_MS = 60_000;

export async function raceWithPasskeyStallDeadline<T>(options: {
  readonly policy: DeadlinePolicy;
  readonly method: string;
  readonly since: number;
  readonly call: Promise<T>;
  readonly reportStall: (report: { readonly method: string; readonly since: number }) => void;
  readonly buildStallError: () => Error;
}): Promise<T> {
  return options.policy.run(() => options.call).catch((error: unknown) => {
    if (error instanceof DeadlineExceededError) {
      options.reportStall({ method: options.method, since: options.since });
      throw options.buildStallError();
    }
    throw error;
  });
}
