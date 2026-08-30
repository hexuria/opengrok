export const ALLOWED_CLIENT_PERSISTENCE_KEY_PREFIX = "sand.";
export const CLIENT_PERSISTENCE_MAX_VALUE_BYTES = 8 * 1024 * 1024;
export const CLIENT_PERSISTENCE_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const CLIENT_PERSISTENCE_MIGRATION_MARKER_FILENAME = ".migrated-from-local-storage";
const FILE_NAME_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const FILE_NAME_SUFFIX = ".blob";
const MAX_FILE_NAME_LENGTH = 240;
const TEMP_FILE_SUFFIX = ".tmp";
const textEncoder = new TextEncoder();

export function encodeClientPersistenceFileName(key: string): string {
  const bytes = textEncoder.encode(key);
  let name = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = buffer << 8 | byte;
    bits += 8;
    while (bits >= 5) {
      name += FILE_NAME_ALPHABET[buffer >>> bits - 5 & 31];
      bits -= 5;
    }
  }
  if (bits > 0) name += FILE_NAME_ALPHABET[buffer << 5 - bits & 31];
  return `${name}${FILE_NAME_SUFFIX}`;
}

export function decodeClientPersistenceFileName(name: string): string | null {
  if (!name.endsWith(FILE_NAME_SUFFIX)) return null;
  const body = name.slice(0, -FILE_NAME_SUFFIX.length);
  if (body.length === 0) return null;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of body) {
    const index = FILE_NAME_ALPHABET.indexOf(character);
    if (index < 0) return null;
    buffer = buffer << 5 | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push(buffer >>> bits - 8 & 255);
      bits -= 8;
    }
  }
  if ((buffer & (1 << bits) - 1) !== 0) return null;
  let key: string;
  try { key = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes)); }
  catch { return null; }
  return key.startsWith(ALLOWED_CLIENT_PERSISTENCE_KEY_PREFIX) ? key : null;
}

export function clientPersistenceFileNameFor(key: string): string | null {
  if (!key.startsWith(ALLOWED_CLIENT_PERSISTENCE_KEY_PREFIX)) return null;
  const name = encodeClientPersistenceFileName(key);
  return name.length > MAX_FILE_NAME_LENGTH ? null : name;
}

function encodedFileName(key: string): string {
  const name = clientPersistenceFileNameFor(key);
  if (name == null) throw new Error(`client persistence: key "${key}" is outside the "${ALLOWED_CLIENT_PERSISTENCE_KEY_PREFIX}" namespace or too long to store`);
  return name;
}

export class ClientPersistenceCapError extends Error {
  constructor(message: string) { super(message); this.name = "ClientPersistenceCapError"; }
}

export interface ClientPersistenceFiles {
  joinPath(dir: string, name: string): string;
  ensureDir(dir: string): Promise<void>;
  listFiles(dir: string): Promise<string[]>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  fileSize(path: string): Promise<number | null>;
}

interface BlobFact { readonly key: string; readonly size: number }

export class SandClientPersistenceStore {
  private blobs: Map<string, BlobFact> | undefined;
  private chain = Promise.resolve();
  private readonly maxValueBytes: number;
  private readonly maxTotalBytes: number;

  constructor(
    private readonly dir: string,
    private readonly files: ClientPersistenceFiles,
    caps: { readonly maxValueBytes?: number; readonly maxTotalBytes?: number } = {},
  ) {
    this.maxValueBytes = caps.maxValueBytes ?? CLIENT_PERSISTENCE_MAX_VALUE_BYTES;
    this.maxTotalBytes = caps.maxTotalBytes ?? CLIENT_PERSISTENCE_MAX_TOTAL_BYTES;
  }

  read(key: string): Promise<string | null> {
    const name = encodedFileName(key);
    return this.run(async () => {
      const blobs = await this.ledger();
      if (!blobs.has(name)) return null;
      try { return await this.files.readTextFile(this.files.joinPath(this.dir, name)); }
      catch { return null; }
    });
  }

  write(key: string, value: string): Promise<void> {
    const name = encodedFileName(key);
    return this.run(async () => this.writeBlob({ blobs: await this.ledger(), name, key, value }));
  }

  remove(key: string): Promise<void> {
    const name = encodedFileName(key);
    return this.run(async () => {
      const blobs = await this.ledger();
      if (!blobs.has(name)) return;
      blobs.delete(name);
      await this.files.removeFile(this.files.joinPath(this.dir, name));
    });
  }

  listKeys(prefix: string): Promise<string[]> {
    return this.run(async () => {
      const keys: string[] = [];
      for (const fact of (await this.ledger()).values()) if (fact.key.startsWith(prefix)) keys.push(fact.key);
      return keys;
    });
  }

  async hasCompletedOneShotMigration(): Promise<boolean> {
    return this.files.fileSize(this.files.joinPath(this.dir, CLIENT_PERSISTENCE_MIGRATION_MARKER_FILENAME)).then(
      (size) => size != null,
      () => false,
    );
  }

  migrateFromLocalStorage(entries: readonly { readonly key: string; readonly value: string }[]): Promise<boolean> {
    return this.run(async () => {
      if (await this.hasCompletedOneShotMigration()) return true;
      const blobs = await this.ledger();
      for (const entry of entries) {
        const name = clientPersistenceFileNameFor(entry.key);
        if (name == null || blobs.has(name)) continue;
        try { await this.writeBlob({ blobs, name, key: entry.key, value: entry.value }); }
        catch (error) {
          if (error instanceof ClientPersistenceCapError) continue;
          return false;
        }
      }
      await this.files.ensureDir(this.dir);
      await this.files.writeTextFile(this.files.joinPath(this.dir, CLIENT_PERSISTENCE_MIGRATION_MARKER_FILENAME), new Date().toISOString());
      return true;
    });
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation, operation);
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }

  private async ledger(): Promise<Map<string, BlobFact>> {
    if (this.blobs !== undefined) return this.blobs;
    const blobs = new Map<string, BlobFact>();
    let names: string[];
    try { names = await this.files.listFiles(this.dir); }
    catch { this.blobs = blobs; return blobs; }
    for (const name of names) {
      if (name.endsWith(TEMP_FILE_SUFFIX)) {
        await this.files.removeFile(this.files.joinPath(this.dir, name));
        continue;
      }
      const key = decodeClientPersistenceFileName(name);
      if (key == null) continue;
      let size: number | null;
      try { size = await this.files.fileSize(this.files.joinPath(this.dir, name)); }
      catch { size = null; }
      if (size != null) blobs.set(name, { key, size });
    }
    this.blobs = blobs;
    return blobs;
  }

  private async writeBlob(args: { readonly blobs: Map<string, BlobFact>; readonly name: string; readonly key: string; readonly value: string }): Promise<void> {
    const size = textEncoder.encode(args.value).length;
    if (size > this.maxValueBytes) throw new ClientPersistenceCapError("client persistence: value exceeds the per-key size cap");
    let total = size;
    for (const [existing, fact] of args.blobs) if (existing !== args.name) total += fact.size;
    if (total > this.maxTotalBytes) throw new ClientPersistenceCapError("client persistence: store exceeds its total size cap");
    await this.files.ensureDir(this.dir);
    const temporary = this.files.joinPath(this.dir, `${args.name}${TEMP_FILE_SUFFIX}`);
    await this.files.writeTextFile(temporary, args.value);
    await this.files.rename(temporary, this.files.joinPath(this.dir, args.name));
    args.blobs.set(args.name, { key: args.key, size });
  }
}
