export interface SecretsSenderContext<TContents = unknown, TFrame = unknown> {
  readonly sender: TContents;
  readonly senderFrame: TFrame;
  readonly trustedContents: TContents | null | undefined;
  readonly trustedMainFrame: TFrame | null | undefined;
}

export const UNTRUSTED_SECRETS_SENDER_MESSAGE = "Secrets are only accessible from the Sand app window.";
export const UNTRUSTED_CLIENT_PERSISTENCE_SENDER_MESSAGE = "Client persistence is only accessible from the Sand app window.";

export class UntrustedSecretsSenderError extends Error {
  constructor() { super(UNTRUSTED_SECRETS_SENDER_MESSAGE); this.name = "UntrustedSecretsSenderError"; }
}

export class UntrustedClientPersistenceSenderError extends Error {
  constructor() { super(UNTRUSTED_CLIENT_PERSISTENCE_SENDER_MESSAGE); this.name = "UntrustedClientPersistenceSenderError"; }
}

export function isTrustedSecretsSender<TContents, TFrame>(context: SecretsSenderContext<TContents, TFrame>): boolean {
  return context.trustedContents != null
    && context.trustedMainFrame != null
    && context.sender === context.trustedContents
    && context.senderFrame === context.trustedMainFrame;
}

export function assertTrustedSecretsSender<TContents, TFrame>(context: SecretsSenderContext<TContents, TFrame>): void {
  if (!isTrustedSecretsSender(context)) throw new UntrustedSecretsSenderError();
}

export function assertTrustedClientPersistenceSender<TContents, TFrame>(context: SecretsSenderContext<TContents, TFrame>): void {
  if (!isTrustedSecretsSender(context)) throw new UntrustedClientPersistenceSenderError();
}
