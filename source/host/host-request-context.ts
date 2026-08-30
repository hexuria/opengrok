import { release, type } from "node:os";
import { normalizeSandUserFullName } from "./sand-user-identity.js";
export function resolveTimeZone(): string | undefined { try { return new Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; } }
export function createHostRequestContext(transcriptsFolder: string, resolveUserTimeZone: () => string | undefined = () => undefined, resolveRules: () => Promise<readonly unknown[]> = async () => [], resolveUserFullName: () => string | undefined = () => undefined) {
  return { resolve: () => { const userFullName = normalizeSandUserFullName(resolveUserFullName()); return { osVersion: `${type()} ${release()}`, shell: process.env.SHELL || undefined, timeZone: resolveUserTimeZone() ?? resolveTimeZone(), transcriptsFolder, ...(userFullName == null ? {} : { userFullName }) }; }, resolveRules };
}
