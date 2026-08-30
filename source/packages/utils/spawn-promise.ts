import { spawn as spawnChild, type SpawnOptions } from "node:child_process";
import { AsyncSubject, merge, Observable, of, Subscription, timer, type Observer, type Subject } from "rxjs";
import { map, reduce, retry as rxRetry } from "rxjs/operators";
import { findActualExecutable } from "./find-executable.js";

type ProcessInfo = { pid?: number | undefined };
type SpawnExtras = {
  stdin?: Observable<string> | undefined;
  echoOutput?: boolean | undefined;
  split?: boolean | undefined;
  encoding?: BufferEncoding | undefined;
  timeout?: number | undefined;
  retries?: number | undefined;
  retryDelay?: number | undefined;
  processInfo?: ProcessInfo | undefined;
};
type SpawnOptionsWithExtras = SpawnOptions & SpawnExtras;
type OutputLine = { source: "stdout" | "stderr"; text: string };

class SpawnError extends Error {
  readonly exitCode: number;
  readonly code: number;
  readonly stdout: string | undefined;
  readonly stderr: string | undefined;
  readonly command: string;
  readonly args: string[];

  constructor(message: string, exitCode: number, command: string, args: string[], stdout?: string, stderr?: string) {
    super(message);
    this.name = "SpawnError";
    this.exitCode = exitCode;
    this.code = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
    this.command = command;
    this.args = args;
    if (Error.captureStackTrace) Error.captureStackTrace(this, SpawnError);
  }
}

function spawn(executable: string, params: string[], options: SpawnOptionsWithExtras & { split: true }): Observable<OutputLine>;
function spawn(executable: string, params: string[], options?: SpawnOptionsWithExtras & { split?: false | undefined }): Observable<string>;
function spawn(executable: string, params: string[], options?: SpawnOptionsWithExtras): Observable<string> | Observable<OutputLine> {
  const opts = options ?? {};
  const spawnObservable = new Observable<OutputLine>((subject: Observer<OutputLine>) => {
    const { encoding, timeout, ...spawnOptions } = opts;
    const { cmd, args } = findActualExecutable(executable, params);
    const stdinObservable = spawnOptions.stdin;
    if (stdinObservable) {
      delete spawnOptions.stdin;
      spawnOptions.stdio ??= ["pipe", "pipe", "pipe"];
    }
    spawnOptions.stdio ??= ["ignore", "pipe", "pipe"];
    const process = spawnChild(cmd, args, spawnOptions);
    if (opts.processInfo && process.pid !== undefined) opts.processInfo.pid = process.pid;

    let timeoutHandle: NodeJS.Timeout | null = null;
    if (timeout && timeout > 0) {
      timeoutHandle = setTimeout(() => {
        if (!process.killed) process.kill();
        subject.error(new SpawnError(`Process timed out after ${timeout}ms`, -1, cmd, args));
      }, timeout);
    }

    const bufferHandler = (source: "stdout" | "stderr") => (buffer: string | Buffer) => {
      if (buffer.length < 1) return;
      if (opts.echoOutput) (source === "stdout" ? globalThis.process.stdout : globalThis.process.stderr).write(buffer);
      let chunk = "<< String sent back was too long >>";
      try {
        chunk = typeof buffer === "string" ? buffer.toString() : buffer.toString(encoding || "utf8");
      } catch {
        chunk = `<< Lost chunk of process output for ${executable} - length was ${buffer.length}>>`;
      }
      subject.next({ source, text: chunk });
    };

    const subscription = new Subscription();
    if (stdinObservable) {
      if (process.stdin) {
        const stdin = process.stdin;
        subscription.add(stdinObservable.subscribe({
          next: (value) => stdin.write(value),
          error: subject.error.bind(subject),
          complete: () => stdin.end(),
        }));
      } else {
        subject.error(new Error("opts.stdio conflicts with provided spawn opts.stdin observable, 'pipe' is required"));
      }
    }

    let stderrCompleted: Subject<boolean> | Observable<boolean> | null = null;
    let stdoutCompleted: Subject<boolean> | Observable<boolean> | null = null;
    let noClose = false;
    if (process.stdout) {
      stdoutCompleted = new AsyncSubject<boolean>();
      process.stdout.on("data", bufferHandler("stdout"));
      process.stdout.on("close", () => {
        (stdoutCompleted as Subject<boolean>).next(true);
        (stdoutCompleted as Subject<boolean>).complete();
      });
    } else stdoutCompleted = of(true);
    if (process.stderr) {
      stderrCompleted = new AsyncSubject<boolean>();
      process.stderr.on("data", bufferHandler("stderr"));
      process.stderr.on("close", () => {
        (stderrCompleted as Subject<boolean>).next(true);
        (stderrCompleted as Subject<boolean>).complete();
      });
    } else stderrCompleted = of(true);

    process.on("error", (error) => {
      noClose = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      subject.error(error);
    });
    process.on("close", (code) => {
      noClose = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      const pipesClosed = merge(stdoutCompleted, stderrCompleted).pipe(reduce(() => true, true));
      if (code === 0) pipesClosed.subscribe(() => subject.complete());
      else pipesClosed.subscribe(() => subject.error(new SpawnError(`Process failed with exit code: ${code}`, code!, cmd, args)));
    });
    subscription.add(new Subscription(() => {
      if (noClose) return;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      process.kill();
    }));
    return subscription;
  });

  let resultObservable: Observable<OutputLine> = spawnObservable;
  if (opts.retries && opts.retries > 0) {
    const retryCount = opts.retries;
    const retryDelay = opts.retryDelay ?? 1000;
    resultObservable = resultObservable.pipe(rxRetry({
      count: retryCount,
      delay: (error) => {
        if (error instanceof SpawnError && error.exitCode !== 0) return timer(retryDelay);
        throw error;
      },
    }));
  }
  return opts.split ? resultObservable : resultObservable.pipe(map((value) => value?.text));
}

function wrapObservableInPromise(observable: Observable<string>): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    observable.subscribe({
      next: (value) => { output += value; },
      error: (error: unknown) => {
        if (error instanceof SpawnError) reject(new SpawnError(`${output}\n${error.message}`, error.exitCode, error.command, error.args, output, error.stderr));
        else reject(new Error(`${output}\n${error instanceof Error ? error.message : String(error)}`));
      },
      complete: () => resolve(output),
    });
  });
}

function wrapObservableInSplitPromise(observable: Observable<OutputLine>): Promise<[string, string]> {
  return new Promise((resolve, reject) => {
    let output = "";
    let errorOutput = "";
    observable.subscribe({
      next: (value) => { if (value.source === "stdout") output += value.text; else errorOutput += value.text; },
      error: (error: unknown) => {
        if (error instanceof SpawnError) reject(new SpawnError(`${output}\n${error.message}`, error.exitCode, error.command, error.args, output, errorOutput));
        else reject(new Error(`${output}\n${error instanceof Error ? error.message : String(error)}`));
      },
      complete: () => resolve([output, errorOutput]),
    });
  });
}

export function spawnPromise(executable: string, params: string[], options: SpawnOptionsWithExtras & { split: true }): Promise<[string, string]>;
export function spawnPromise(executable: string, params: string[], options?: SpawnOptionsWithExtras): Promise<string>;
export function spawnPromise(executable: string, params: string[], options?: SpawnOptionsWithExtras): Promise<string> | Promise<[string, string]> {
  if (options?.split) return wrapObservableInSplitPromise(spawn(executable, params, { ...(options ?? {}), split: true }));
  return wrapObservableInPromise(spawn(executable, params, { ...(options ?? {}), split: false }));
}
