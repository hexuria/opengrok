export class SandboxUnsupportedError extends Error {
  readonly reason: string | undefined;

  constructor(message: string, reason?: string | undefined) {
    super(message);
    this.reason = reason;
    this.name = "SandboxUnsupportedError";
  }
}
