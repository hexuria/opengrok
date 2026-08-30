export class CancelActionHandler {
  constructor(
    readonly config: unknown,
    readonly resourceAccessor: unknown,
    readonly interactionListener: unknown,
    readonly summarizationHandler: unknown,
    readonly conversationActionReceiver: unknown,
  ) {}

  async handle(
    _ctx: unknown,
    _action: unknown,
    _rootPromptExecutor: unknown,
    _stateHandler: unknown,
    _mcpTools: unknown,
    _onStateUpdate: unknown,
  ): Promise<never> {
    throw new Error("Cancel Conversation action should never be routed directly to runStream!");
  }
}
