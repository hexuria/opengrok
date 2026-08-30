import { accessSync, constants, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveCsnapsBinPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SAND_CSNAPS_BIN?.trim();
  if (override) return override;
  const hostBundleDirectory =
    typeof __dirname === "string"
      ? __dirname
      : dirname(fileURLToPath(import.meta.url));
  return join(hostBundleDirectory, "extensions", "codebase-telemetry", "csnaps");
}

export function resolveCsnapsCapability(env: NodeJS.ProcessEnv = process.env):
  | { readonly available: true; readonly executablePath: string }
  | { readonly available: false; readonly executablePath: string; readonly reason: "missing" | "not-file" | "not-executable" } {
  const executablePath = resolveCsnapsBinPath(env);
  try {
    if (!statSync(executablePath).isFile()) {
      return { available: false, executablePath, reason: "not-file" };
    }
  } catch {
    return { available: false, executablePath, reason: "missing" };
  }
  try {
    accessSync(executablePath, constants.X_OK);
  } catch {
    return { available: false, executablePath, reason: "not-executable" };
  }
  return { available: true, executablePath };
}
