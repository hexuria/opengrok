export const UNBOUND_EXECUTION_MESSAGE = "Sand turn execution is not bound: the host asked for a runner before the composition root handed the turn-execution extension its executor.";
export const DOUBLE_BIND_MESSAGE = "Sand turn execution is already bound: a second executor would mint a second runner for the same agent.";

export interface TurnExecutor {
  isInferenceReady(): Promise<boolean>;
  createRunner(session: unknown, hooks: unknown): unknown;
  createGroupMemberRunner(session: unknown, hooks: unknown, overrides: unknown): unknown;
}

export class TurnExecutionRegistry {
  private executor: TurnExecutor | undefined;
  get canExecute(): boolean { return this.executor !== undefined; }
  bindExecutor(executor: TurnExecutor): void {
    if (this.executor !== undefined) throw new Error(DOUBLE_BIND_MESSAGE);
    this.executor = executor;
  }
  async isRunReady(): Promise<boolean> { return this.executor === undefined ? false : await this.executor.isInferenceReady(); }
  createRunner(session: unknown, hooks: unknown): unknown { return this.require().createRunner(session, hooks); }
  createGroupMemberRunner(session: unknown, hooks: unknown, overrides: unknown): unknown { return this.require().createGroupMemberRunner(session, hooks, overrides); }
  private require(): TurnExecutor { if (this.executor === undefined) throw new Error(UNBOUND_EXECUTION_MESSAGE); return this.executor; }
}

