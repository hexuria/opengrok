export interface CoordinatorPortRequesterContext<TContents = unknown, TFrame = unknown> {
  readonly sender: TContents;
  readonly senderFrame: TFrame;
  readonly trustedContents: TContents | null | undefined;
  readonly trustedMainFrame: TFrame | null | undefined;
}

export const UNTRUSTED_COORDINATOR_PORT_REQUESTER_MESSAGE =
  "Coordinator access is only available from the Sand app window.";

export class UntrustedCoordinatorPortRequesterError extends Error {
  constructor() {
    super(UNTRUSTED_COORDINATOR_PORT_REQUESTER_MESSAGE);
    this.name = "UntrustedCoordinatorPortRequesterError";
  }
}

export function isTrustedCoordinatorPortRequester<TContents, TFrame>(
  context: CoordinatorPortRequesterContext<TContents, TFrame>,
): boolean {
  return context.trustedContents != null
    && context.trustedMainFrame != null
    && context.sender === context.trustedContents
    && context.senderFrame === context.trustedMainFrame;
}

export function assertTrustedCoordinatorPortRequester<TContents, TFrame>(
  context: CoordinatorPortRequesterContext<TContents, TFrame>,
): void {
  if (!isTrustedCoordinatorPortRequester(context)) throw new UntrustedCoordinatorPortRequesterError();
}
