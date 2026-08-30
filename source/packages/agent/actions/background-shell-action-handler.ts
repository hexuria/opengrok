interface StateHandler<Context, State> {
  computeNewStructure(ctx: Context): Promise<State> | State;
}

export class NoOpSideChannelActionHandler {
  async handle<Context, State>(
    ctx: Context,
    _action: unknown,
    _rootPromptExecutor: unknown,
    stateHandler: StateHandler<Context, State>,
    _mcpTools: unknown,
    _onStateUpdate: unknown,
  ): Promise<State> {
    return stateHandler.computeNewStructure(ctx);
  }

  async handleSingleStep<Context, State>(
    ctx: Context,
    _action: unknown,
    _rootPromptExecutor: unknown,
    stateHandler: StateHandler<Context, State>,
    _mcpTools: unknown,
    _onStateUpdate: unknown,
  ): Promise<{ state: State; hasToolCall: false }> {
    return {
      state: await stateHandler.computeNewStructure(ctx),
      hasToolCall: false,
    };
  }
}

export class BackgroundShellActionHandler extends NoOpSideChannelActionHandler {}
