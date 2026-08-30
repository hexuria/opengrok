import { join } from "node:path";
import {
  createPersistedGatewayDescriptorStore,
  type GatewayDescriptorStore,
} from "./gateway-descriptor-cache.js";

export function createDesktopGatewayDescriptorFastPath(options: {
  readonly app: { getPath(name: "userData"): string };
  readonly safeStorage: {
    isEncryptionAvailable(): boolean;
    encryptString(plaintext: string): Buffer;
    decryptString(stored: Buffer): string;
  };
  readonly getAccountScope: () => string | undefined;
  readonly reportFailure?: Parameters<typeof createPersistedGatewayDescriptorStore>[0]["reportFailure"];
}): { readonly store: GatewayDescriptorStore; readonly getAccountScope: () => string | undefined } {
  return {
    store: createPersistedGatewayDescriptorStore({
      filePath: join(options.app.getPath("userData"), "gateway-descriptor.json"),
      codec: {
        isAvailable: () => options.safeStorage.isEncryptionAvailable(),
        encrypt: (plaintext) => options.safeStorage.encryptString(plaintext).toString("base64"),
        decrypt: (stored) => options.safeStorage.decryptString(Buffer.from(stored, "base64")),
      },
      ...(options.reportFailure === undefined ? {} : { reportFailure: options.reportFailure }),
    }),
    getAccountScope: options.getAccountScope,
  };
}
