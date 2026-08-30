type ShellOutputType = "stdout" | "stderr";
type ShellOutputEvent = { type: ShellOutputType; data: Buffer };
type ShellOutputWritable = { write(event: ShellOutputEvent): Promise<void> };
type ShellOutputStream = AsyncIterable<Buffer> & {
  on(event: "data", listener: (data: Buffer) => void): unknown;
};
type ShellOutputLimiterOptions = {
  flushIntervalMs?: number | undefined;
  maxBufferedBytes?: number | undefined;
};
type AttachShellOutputStreamsOptions = {
  stdout?: ShellOutputStream | null | undefined;
  stderr?: ShellOutputStream | null | undefined;
  writable: ShellOutputWritable;
  bufferOutputEvents?: boolean | undefined;
  outputLimiterOptions?: ShellOutputLimiterOptions | undefined;
};

const SHELL_OUTPUT_LIMITER_DEFAULTS = {
  flushIntervalMs: 50,
  maxBufferedBytes: 256 * 1024,
};

function coalesceAdjacentShellOutputEvents(events: readonly ShellOutputEvent[]): ShellOutputEvent[] {
  if (events.length === 0) {
    return [];
  }
  const coalesced: ShellOutputEvent[] = [];
  let currentType = events[0]!.type;
  let dataChunks = [events[0]!.data];
  for (let index = 1; index < events.length; index += 1) {
    const next = events[index]!;
    if (next.type === currentType) {
      dataChunks.push(next.data);
      continue;
    }
    coalesced.push({ type: currentType, data: Buffer.concat(dataChunks) });
    currentType = next.type;
    dataChunks = [next.data];
  }
  coalesced.push({ type: currentType, data: Buffer.concat(dataChunks) });
  return coalesced;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function attachShellOutputStreams(options: AttachShellOutputStreamsOptions): {
  waitForOutput(): Promise<void>;
  flush(): Promise<void>;
} {
  if (!options.bufferOutputEvents) {
    const writeOutputEvent = (type: ShellOutputType, data: Buffer): void => {
      void options.writable.write({ type, data }).catch(() => {});
    };
    options.stdout?.on("data", (data) => {
      writeOutputEvent("stdout", data);
    });
    options.stderr?.on("data", (data) => {
      writeOutputEvent("stderr", data);
    });
    return {
      async waitForOutput() {},
      async flush() {},
    };
  }
  const limiter = new ShellOutputLimiter(options.writable, options.outputLimiterOptions);
  let outputPumpError: unknown;
  const outputPumpPromise = Promise.all([
    pumpShellOutputStream(options.stdout, "stdout", limiter),
    pumpShellOutputStream(options.stderr, "stderr", limiter),
  ]).then(() => undefined).catch((error: unknown) => {
    outputPumpError = error;
  });
  return {
    async waitForOutput() {
      await outputPumpPromise;
      if (outputPumpError !== undefined) {
        throw toError(outputPumpError);
      }
    },
    async flush() {
      await limiter.flush();
    },
  };
}

async function pumpShellOutputStream(stream: ShellOutputStream | null | undefined, type: ShellOutputType, limiter: ShellOutputLimiter): Promise<void> {
  if (!stream) return;
  for await (const chunk of stream) {
    await limiter.push(type, chunk);
  }
}

class ShellOutputLimiter {
  private pending: ShellOutputEvent[] = [];
  private pendingBytes = 0;
  private flushTimeout: ReturnType<typeof setTimeout> | undefined;
  private flushPromise: Promise<void> | undefined;
  private readonly flushIntervalMs: number;
  private readonly maxBufferedBytes: number;

  constructor(private readonly writable: ShellOutputWritable, options?: ShellOutputLimiterOptions) {
    this.flushIntervalMs = options?.flushIntervalMs ?? SHELL_OUTPUT_LIMITER_DEFAULTS.flushIntervalMs;
    this.maxBufferedBytes = options?.maxBufferedBytes ?? SHELL_OUTPUT_LIMITER_DEFAULTS.maxBufferedBytes;
  }

  async push(type: ShellOutputType, data: Buffer): Promise<void> {
    if (data.length === 0) return;
    this.pending.push({ type, data });
    this.pendingBytes += data.length;
    if (this.pendingBytes >= this.maxBufferedBytes) {
      await this.flush();
      return;
    }
    this.scheduleFlush();
  }

  async flush(): Promise<void> {
    this.clearFlushTimeout();
    if (this.flushPromise) {
      await this.flushPromise;
      if (this.pendingBytes > 0) {
        await this.flush();
      }
      return;
    }
    if (this.pendingBytes === 0) return;
    const pendingEvents = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    this.flushPromise = this.writeBufferedOutput(pendingEvents);
    try {
      await this.flushPromise;
    } finally {
      this.flushPromise = undefined;
    }
  }

  async close(): Promise<void> {
    await this.flush();
  }

  private scheduleFlush(): void {
    if (this.flushTimeout !== undefined) return;
    this.flushTimeout = setTimeout(() => {
      this.flushTimeout = undefined;
      void this.flush();
    }, this.flushIntervalMs);
  }

  private clearFlushTimeout(): void {
    if (this.flushTimeout === undefined) return;
    clearTimeout(this.flushTimeout);
    this.flushTimeout = undefined;
  }

  private async writeBufferedOutput(events: readonly ShellOutputEvent[]): Promise<void> {
    for (const event of coalesceAdjacentShellOutputEvents(events)) {
      try {
        await this.writable.write(event);
      } catch {}
    }
  }
}
