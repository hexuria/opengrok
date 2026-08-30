import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

export const BINDING_VERSION = 1 as const;
const SHA256_HEX = /^[a-f0-9]{64}$/;
export interface EnvDescriptorBindings { readonly version: 1; readonly bindings: Readonly<Record<string, string>> }

function sha256(namespace: string, value: string): string {
  return createHash("sha256").update(namespace).update("\0").update(value).digest("hex");
}
export function descriptorKey(rawUrl: string): string { return sha256("sand-env-descriptor", new URL(rawUrl).toString()); }
export function accountKey(slot: string): string { return sha256("sand-account-slot", slot); }

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error != null && "code" in error && error.code === "ENOENT";
}

export async function hasExistingDevBoxDurableData(devBoxRoot: string): Promise<boolean> {
  for (const directory of ["sand-data", "box-store"]) {
    try { if ((await fs.readdir(join(devBoxRoot, directory))).length > 0) return true; }
    catch (error) { if (!isEnoent(error)) throw error; }
  }
  try { await fs.stat(join(devBoxRoot, "box-store-id")); return true; }
  catch (error) { if (isEnoent(error)) return false; throw error; }
}

export class SandEnvDescriptorAccountBindingError extends Error {}

export function parseBindingFile(raw: string): EnvDescriptorBindings {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value == null || !("version" in value) || value.version !== BINDING_VERSION
    || !("bindings" in value) || typeof value.bindings !== "object" || value.bindings == null || Array.isArray(value.bindings)) {
    throw new SandEnvDescriptorAccountBindingError("invalid env-descriptor account binding file");
  }
  const bindings: Record<string, string> = {};
  for (const [descriptor, account] of Object.entries(value.bindings)) {
    if (!SHA256_HEX.test(descriptor) || typeof account !== "string" || !SHA256_HEX.test(account)) {
      throw new SandEnvDescriptorAccountBindingError("invalid env-descriptor account binding entry");
    }
    bindings[descriptor] = account;
  }
  return { version: BINDING_VERSION, bindings };
}

export async function readBindings(path: string): Promise<EnvDescriptorBindings | null> {
  try { return parseBindingFile(await fs.readFile(path, "utf8")); }
  catch (error) { if (isEnoent(error)) return null; throw error; }
}

export async function writeBindings(path: string, value: EnvDescriptorBindings, onCleanupFailure: (error: unknown) => void = () => {}): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, path);
  } catch (error) {
    try { await fs.rm(temporary, { force: true }); } catch (cleanupError) { onCleanupFailure(cleanupError); }
    throw error;
  }
}

export function createEnvDescriptorAccountBinding(path: string, onCleanupFailure?: (error: unknown) => void) {
  return {
    async authorize(args: {
      readonly accountSlot: string;
      readonly descriptorUrl: string;
      readonly allowExistingDataClaim: boolean;
      readonly hasExistingDurableData: () => boolean | Promise<boolean>;
    }): Promise<boolean> {
      const descriptor = descriptorKey(args.descriptorUrl);
      const account = accountKey(args.accountSlot);
      const stored = await readBindings(path);
      const owner = stored?.bindings[descriptor];
      if (owner === account) return true;
      if (owner != null) return false;
      if (!args.allowExistingDataClaim && await args.hasExistingDurableData()) return false;
      await writeBindings(path, { version: BINDING_VERSION, bindings: { ...stored?.bindings, [descriptor]: account } }, onCleanupFailure);
      return true;
    },
  };
}
