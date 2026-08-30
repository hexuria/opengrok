export class ReplayableAsyncIterable<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private closed = false;
  private declare error: Error | undefined;
  private waiters: Array<() => void> = [];

  constructor(source: AsyncIterable<T> | Iterable<T>) { void this.consume(source); }

  private async consume(source: AsyncIterable<T> | Iterable<T>): Promise<void> {
    try {
      for await (const value of source) {
        this.buffer.push(value);
        const toNotify = this.waiters;
        this.waiters = [];
        for (const waiter of toNotify) waiter();
      }
    } catch (error) {
      this.error = error instanceof Error ? error : new Error(String(error));
    } finally {
      this.closed = true;
      const toNotify = this.waiters;
      this.waiters = [];
      for (const waiter of toNotify) waiter();
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    let index = 0;
    while (true) {
      while (index < this.buffer.length) yield this.buffer[index++] as T;
      if (this.closed) {
        if (this.error !== undefined) throw this.error;
        return;
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}
