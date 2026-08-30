export class HookAdditionalContextTooLargeError extends Error {
  readonly hookEventName: string;
  readonly actualLength: number;
  readonly maxLength: number;

  constructor(params: { hookEventName: string; actualLength: number; maxLength: number }) {
    super(
      `Hook additional_context for ${params.hookEventName} is ${params.actualLength} chars (max ${params.maxLength}).`,
    );
    this.name = "HookAdditionalContextTooLargeError";
    this.hookEventName = params.hookEventName;
    this.actualLength = params.actualLength;
    this.maxLength = params.maxLength;
  }
}
