import { execFile } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface ExecOptions { timeoutMs?: number; env?: NodeJS.ProcessEnv }

export function exec(command: string, args: readonly (string | number)[], options?: ExecOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const opts = {
      timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      env: options?.env ? { ...process.env, ...options.env } : undefined,
    };
    execFile(command, args.map(String), { windowsHide: true, ...opts, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}
