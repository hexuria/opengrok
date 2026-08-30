export type OnePasswordProvisioningErrorCode = "sink-unavailable" | (string & {});

export class OnePasswordProvisioningError extends Error {
  constructor(
    readonly code: OnePasswordProvisioningErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OnePasswordProvisioningError";
  }
}

export interface OnePasswordProvisioningSink<TCredential = unknown> {
  readonly availability: "available" | "unavailable";
  accept(credential: TCredential): Promise<void>;
}

export const unavailableOnePasswordProvisioningSink: OnePasswordProvisioningSink = {
  availability: "unavailable",
  async accept(): Promise<never> {
    throw new OnePasswordProvisioningError(
      "sink-unavailable",
      "1Password provisioning is unavailable until a credential consumer is configured.",
    );
  },
};
