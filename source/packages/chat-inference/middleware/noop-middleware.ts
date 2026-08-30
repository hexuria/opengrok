import { BaseMiddleware, type PromptExecutor, type PromptMessage } from "../base.js";
export class NoopMiddleware<TMessage = PromptMessage> extends BaseMiddleware<TMessage> {}
export const createNoopMiddleware = <TMessage>() => (executor: PromptExecutor<TMessage>): NoopMiddleware<TMessage> => new NoopMiddleware(executor);
export const noopMiddleware = createNoopMiddleware();
