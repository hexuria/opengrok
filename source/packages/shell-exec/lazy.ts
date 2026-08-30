import { createSpan } from "../context/otel.js";
import type { Context } from "../context/core.js";
import type { TerminalEvent, TerminalExecuteOptions, TerminalExecutor } from "./naive.js";

export class LazyTerminalExecutor implements TerminalExecutor {
  private readonly initializer: () => Promise<TerminalExecutor>;
  private promise: Promise<TerminalExecutor> | undefined;

  constructor(initializer: () => Promise<TerminalExecutor>) {
    this.initializer = initializer;
  }

  getExecutor(): Promise<TerminalExecutor> {
    if (this.promise === undefined) {
      this.promise = this.initializer();
    }
    return this.promise;
  }

  async getCwd(): Promise<string> {
    const executor = await this.getExecutor();
    return executor.getCwd();
  }

  clone(workingDirectory?: string): TerminalExecutor {
    return new LazyTerminalExecutor(async () => {
      const executor = await this.getExecutor();
      return executor.clone(workingDirectory);
    });
  }

  async *execute(ctx: Context, command: string, options?: TerminalExecuteOptions): AsyncIterable<TerminalEvent> {
    using span = createSpan(ctx.withName("LazyTerminalExecutor.execute"));
    const executor = await this.getExecutor();
    for await (const event of executor.execute(ctx, command, options)) {
      yield event;
    }
  }
}
