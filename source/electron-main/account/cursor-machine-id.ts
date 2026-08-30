import { randomUUID } from "node:crypto";
import { readSecret, waitForEncryptedStorage, writeSecret } from "../secrets/secret-store.js";

export const MACHINE_ID_SECRET_KEY = "cursor-machine-id";

export interface MachineIdSecretStore {
  readSecret(key: string): Promise<string | null | undefined>;
  writeSecret(key: string, value: string): Promise<void>;
  waitForEncryptedStorage(): Promise<void>;
}

export async function getOrCreateMachineId(): Promise<string> {
  const existing = await readSecret(MACHINE_ID_SECRET_KEY);
  if (existing != null) return existing;
  await waitForEncryptedStorage();
  const afterSettle = await readSecret(MACHINE_ID_SECRET_KEY);
  if (afterSettle != null) return afterSettle;
  const machineId = randomUUID();
  await writeSecret(MACHINE_ID_SECRET_KEY, machineId);
  return machineId;
}

export function createGetOrCreateMachineId(
  secrets: MachineIdSecretStore,
  createId: () => string = randomUUID,
): () => Promise<string> {
  return async () => {
    const existing = await secrets.readSecret(MACHINE_ID_SECRET_KEY);
    if (existing != null) return existing;
    await secrets.waitForEncryptedStorage();
    const afterSettle = await secrets.readSecret(MACHINE_ID_SECRET_KEY);
    if (afterSettle != null) return afterSettle;
    const machineId = createId();
    await secrets.writeSecret(MACHINE_ID_SECRET_KEY, machineId);
    return machineId;
  };
}
