export const LOCAL_CLI_MODE_ENV = "CURSOR_AGENT_CLI_LOCAL_MODE";
export const LOCAL_CLI_MODE_HEADER = "local-cli-mode";
export function isLocalCliMode(): boolean { return typeof process !== "undefined" && process.env?.[LOCAL_CLI_MODE_ENV] === "true"; }
export function applyLocalCliModeHeader(headers: Headers): void { if (isLocalCliMode()) headers.set(LOCAL_CLI_MODE_HEADER, "true"); }
export function createLocalCliModeHeaders<T extends Record<string, string> | undefined>(headers: T): T | (T & Record<string, string>) {
  return isLocalCliMode() ? { ...headers, [LOCAL_CLI_MODE_HEADER]: "true" } as T & Record<string, string> : headers;
}
