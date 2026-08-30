export class SandBoxStoreSyncError extends Error { constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "SandBoxStoreSyncError"; } }
