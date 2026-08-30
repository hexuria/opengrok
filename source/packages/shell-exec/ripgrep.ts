import { delimiter, dirname, isAbsolute } from "node:path";

function findPathEnvKey(env: NodeJS.ProcessEnv): string | undefined {
  const pathKeys = Object.keys(env).filter((key) => key.toLowerCase() === "path");
  if (pathKeys.length === 0) {
    return undefined;
  }
  if (process.platform === "win32") {
    return pathKeys.find((key) => key === "Path") ?? pathKeys[0];
  }
  return pathKeys.find((key) => key === "PATH") ?? pathKeys[0];
}

function getPathEnvValue(env: NodeJS.ProcessEnv): string {
  const pathKey = findPathEnvKey(env);
  return pathKey !== undefined ? env[pathKey] ?? "" : "";
}

function setPathEnvValue(env: NodeJS.ProcessEnv, pathValue: string): NodeJS.ProcessEnv {
  const pathKey = findPathEnvKey(env) ?? (process.platform === "win32" ? "Path" : "PATH");
  const result = { ...env };
  for (const key of Object.keys(result)) {
    if (key !== pathKey && key.toLowerCase() === "path") {
      delete result[key];
    }
  }
  result[pathKey] = pathValue;
  return result;
}

function prependExecutableDirToPath(env: NodeJS.ProcessEnv, executablePath: string): NodeJS.ProcessEnv {
  const executableDir = dirname(executablePath);
  if (!executableDir || executableDir === ".") {
    return env;
  }
  const currentPathEntries = getPathEnvValue(env).split(delimiter).filter(Boolean);
  const newPathValue = [executableDir, ...currentPathEntries.filter((entry) => entry !== executableDir)].join(delimiter);
  return setPathEnvValue(env, newPathValue);
}

let configuredPath: string | undefined;

export function withConfiguredRipgrepEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!configuredPath || !isAbsolute(configuredPath)) {
    return env;
  }
  return {
    ...prependExecutableDirToPath(env, configuredPath),
    CURSOR_RIPGREP_PATH: configuredPath,
  };
}

export function getRipgrepBinaryPath(): string {
  if (!configuredPath) {
    throw new Error("Ripgrep path not configured. Call configureRipgrepPath() at startup.");
  }
  return configuredPath;
}
