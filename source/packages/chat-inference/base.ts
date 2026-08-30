export interface PromptMessage { role: string; content: string | readonly unknown[] }

export class BasePromptBuilder<TMessage = PromptMessage> {
  protected messages: TMessage[] = [];
  constructor(initialMessages?: TMessage | readonly TMessage[]) {
    if (initialMessages !== undefined) this.messages = Array.isArray(initialMessages) ? [...initialMessages] : [initialMessages as TMessage];
  }
  appendMessages(newMessages: TMessage | readonly TMessage[]): this {
    this.messages.push(...(Array.isArray(newMessages) ? newMessages : [newMessages as TMessage]));
    return this;
  }
  getState(): TMessage[] { return [...this.messages]; }
  getMessages(): TMessage[] { return [...this.messages]; }
  clearMessages(): void { this.messages = []; }
}

export class BasePromptExecutor<TMessage = PromptMessage> {
  constructor(protected readonly builder: BasePromptBuilder<TMessage>) {}
  appendMessages(messages: TMessage | readonly TMessage[]): this { this.builder.appendMessages(messages); return this; }
  getState(): TMessage[] { return this.builder.getState(); }
  getMessages(): TMessage[] { return this.builder.getMessages(); }
  clearMessages(): void { this.builder.clearMessages(); }
}

export interface PromptExecutor<TMessage = PromptMessage> {
  appendMessages(messages: TMessage | readonly TMessage[]): unknown;
  getState(): unknown;
  getMessages(): TMessage[];
  clearMessages(): void;
  stream(...args: readonly unknown[]): unknown;
}

export class BaseMiddleware<TMessage = PromptMessage> implements PromptExecutor<TMessage> {
  constructor(protected readonly innerExecutor: PromptExecutor<TMessage>) {}
  appendMessages(messages: TMessage | readonly TMessage[]): this { this.innerExecutor.appendMessages(messages); return this; }
  getState(): unknown { return this.innerExecutor.getState(); }
  getMessages(): TMessage[] { return this.innerExecutor.getMessages(); }
  clearMessages(): void { this.innerExecutor.clearMessages(); }
  stream(...args: readonly unknown[]): unknown { return this.innerExecutor.stream(...args); }
}
