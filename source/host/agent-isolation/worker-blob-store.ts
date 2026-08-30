import type { AgentWorkerPool } from "./agent-worker-pool.js";

export class WorkerBlobStore {
  constructor(
    readonly pool: AgentWorkerPool,
    readonly agentId: string,
    readonly blobDbPath: string,
    readonly legacyBlobDbPath?: string
  ) {}

  async getBlob(
    _ctx: unknown,
    blobId: Uint8Array
  ): Promise<Uint8Array | undefined> {
    return await this.pool.getBlob(
      this.agentId,
      this.blobDbPath,
      blobId,
      this.legacyBlobDbPath
    );
  }

  async setBlob(
    _ctx: unknown,
    blobId: Uint8Array,
    blobData: Uint8Array
  ): Promise<void> {
    await this.pool.setBlob(
      this.agentId,
      this.blobDbPath,
      blobId,
      blobData,
      this.legacyBlobDbPath
    );
  }

  async setBlobLocallyOnly(
    ctx: unknown,
    blobId: Uint8Array,
    blobData: Uint8Array
  ): Promise<void> {
    await this.setBlob(ctx, blobId, blobData);
  }

  async flush(_ctx: unknown): Promise<void> {}
}
