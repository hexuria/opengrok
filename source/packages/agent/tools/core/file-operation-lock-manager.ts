import type { Context } from "../../../context/core.js";
import { ToolCallAbortedError } from "../common.js";

interface FileWaiter {
  readonly type: "file";
  readonly path: string;
  readonly resolve: () => void;
}

interface ExclusiveWaiter {
  readonly type: "exclusive";
  readonly resolve: () => void;
}

type Waiter = FileWaiter | ExclusiveWaiter;

export interface FileOperationLock {
  readonly acquisitionOrder: bigint | undefined;
  [Symbol.dispose](): void;
}

export interface ExclusiveFileOperationLock {
  [Symbol.dispose](): void;
}

export class FileOperationLockManager {
  private readonly lockedFiles = new Set<string>();
  private exclusiveLockActive = false;
  private readonly waitQueue: Waiter[] = [];
  private nextAcquisitionOrder = 0n;

  get activeFileOperationCount(): number {
    return this.lockedFiles.size;
  }

  async waitForLock(
    ctx: Context,
    targetPath: string,
    options?: { readonly trackAcquisitionOrder?: boolean | undefined },
  ): Promise<FileOperationLock> {
    if (ctx.signal.aborted) throw new ToolCallAbortedError();
    const needsToWait = this.exclusiveLockActive ||
      this.lockedFiles.has(targetPath) ||
      this.hasExclusiveWaiterAhead();
    if (needsToWait) {
      let wasGranted = false;
      await new Promise<void>(resolve => {
        const wrappedResolve = () => {
          wasGranted = true;
          ctx.signal.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          const index = this.waitQueue.findIndex(waiter =>
            waiter.type === "file" &&
            waiter.path === targetPath &&
            waiter.resolve === wrappedResolve
          );
          if (index >= 0) this.waitQueue.splice(index, 1);
          resolve();
        };
        ctx.signal.addEventListener("abort", onAbort, { once: true });
        this.waitQueue.push({ type: "file", path: targetPath, resolve: wrappedResolve });
      });
      if (ctx.signal.aborted) {
        if (wasGranted) this.releaseFileLock(targetPath);
        throw new ToolCallAbortedError();
      }
    } else {
      this.lockedFiles.add(targetPath);
    }
    let released = false;
    const dispose = () => {
      if (released) return;
      released = true;
      this.releaseFileLock(targetPath);
    };
    return {
      acquisitionOrder: options?.trackAcquisitionOrder === true
        ? ++this.nextAcquisitionOrder
        : undefined,
      [Symbol.dispose]: dispose,
    };
  }

  async waitForExclusiveLock(ctx: Context): Promise<ExclusiveFileOperationLock> {
    if (ctx.signal.aborted) throw new ToolCallAbortedError();
    const needsToWait = this.exclusiveLockActive || this.activeFileOperationCount > 0;
    if (needsToWait) {
      let wasGranted = false;
      await new Promise<void>(resolve => {
        const wrappedResolve = () => {
          wasGranted = true;
          ctx.signal.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          const index = this.waitQueue.findIndex(waiter =>
            waiter.type === "exclusive" && waiter.resolve === wrappedResolve
          );
          if (index >= 0) this.waitQueue.splice(index, 1);
          resolve();
        };
        ctx.signal.addEventListener("abort", onAbort, { once: true });
        this.waitQueue.push({ type: "exclusive", resolve: wrappedResolve });
      });
      if (ctx.signal.aborted) {
        if (wasGranted) this.releaseExclusiveLock();
        throw new ToolCallAbortedError();
      }
    } else {
      this.exclusiveLockActive = true;
    }
    let released = false;
    const dispose = () => {
      if (released) return;
      released = true;
      this.releaseExclusiveLock();
    };
    return { [Symbol.dispose]: dispose };
  }

  private hasExclusiveWaiterAhead(): boolean {
    return this.waitQueue.some(waiter => waiter.type === "exclusive");
  }

  private releaseFileLock(pathKey: string): void {
    this.lockedFiles.delete(pathKey);
    this.processQueue();
  }

  private releaseExclusiveLock(): void {
    this.exclusiveLockActive = false;
    this.processQueue();
  }

  private processQueue(): void {
    while (this.waitQueue.length > 0) {
      const front = this.waitQueue[0]!;
      if (front.type === "exclusive") {
        if (this.activeFileOperationCount > 0 || this.exclusiveLockActive) break;
        this.exclusiveLockActive = true;
        this.waitQueue.shift();
        front.resolve();
        break;
      }
      if (this.exclusiveLockActive || this.lockedFiles.has(front.path)) break;
      this.lockedFiles.add(front.path);
      this.waitQueue.shift();
      front.resolve();
    }
  }
}
