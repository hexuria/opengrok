import fs from "node:fs";
import path from "node:path";
import { LRUCache } from "./lru-cache.js";

function statSyncNoException(file: string): fs.Stats | null {
  try {
    return fs.statSync(
      /* turbopackIgnore: true */
      file,
    );
  } catch {
    return null;
  }
}

const isWindows = typeof process !== "undefined" && process.platform === "win32";
const runDownPathCache = new LRUCache<string, string>({ max: 512 });

function runDownPath(executable: string, pathMustMatch?: RegExp): string {
  if (executable.match(/[\\/]/)) return executable;
  const cacheKey = pathMustMatch ? `${executable}\0${pathMustMatch.source}\0${pathMustMatch.flags}` : executable;
  const cached = runDownPathCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const target = path.join(
    /* turbopackIgnore: true */
    ".",
    executable,
  );
  if (statSyncNoException(target)) {
    runDownPathCache.set(cacheKey, target);
    return target;
  }
  const haystack = process.env.PATH!.split(isWindows ? ";" : ":");
  for (const entry of haystack) {
    const needle = path.join(
      /* turbopackIgnore: true */
      entry,
      executable,
    );
    if (statSyncNoException(needle) && (!pathMustMatch || pathMustMatch.test(needle))) {
      runDownPathCache.set(cacheKey, needle);
      return needle;
    }
  }
  runDownPathCache.set(cacheKey, executable);
  return executable;
}

export function findActualExecutable(executable: string, args: string[], pathMustMatch?: RegExp): { cmd: string; args: string[] } {
  if (process.platform !== "win32") return { cmd: runDownPath(executable), args };
  if (!fs.existsSync(
    /* turbopackIgnore: true */
    executable,
  )) {
    const possibleExtensions = [".exe", ".bat", ".cmd", ".ps1"];
    const executableLower = executable.toLowerCase();
    if (possibleExtensions.some((extension) => executableLower.endsWith(extension))) {
      const resolvedPath = runDownPath(executable, pathMustMatch);
      if (fs.existsSync(
        /* turbopackIgnore: true */
        resolvedPath,
      )) return findActualExecutable(resolvedPath, args, pathMustMatch);
    }
    for (const extension of possibleExtensions) {
      const possibleFullPath = runDownPath(`${executable}${extension}`, pathMustMatch);
      if (fs.existsSync(
        /* turbopackIgnore: true */
        possibleFullPath,
      )) return findActualExecutable(possibleFullPath, args, pathMustMatch);
    }
  }
  if (executable.match(/\.ps1$/i)) {
    const cmd = path.join(
      /* turbopackIgnore: true */
      process.env.SYSTEMROOT!,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "PowerShell.exe",
    );
    const powershellArgs = ["-ExecutionPolicy", "Unrestricted", "-NoLogo", "-NonInteractive", "-File", executable];
    return { cmd, args: powershellArgs.concat(args) };
  }
  if (executable.match(/\.(bat|cmd)$/i)) {
    const cmd = path.join(
      /* turbopackIgnore: true */
      process.env.SYSTEMROOT!,
      "System32",
      "cmd.exe",
    );
    return { cmd, args: ["/C", executable, ...args] };
  }
  if (executable.match(/\.js$/i)) return { cmd: process.execPath, args: [executable].concat(args) };
  return { cmd: executable, args };
}
