/**
 * Preload for the Collections window.
 *
 * It exposes exactly the ten guarded `sand:collections-*` channels plus a
 * navigate event. There is deliberately no desktop bridge and no coordinator
 * port here: the Collections page renders snapshots that already live on this
 * machine and must never gain a path to the agent transport.
 */

export const COLLECTIONS_PRELOAD_CHANNELS = {
  list: "sand:collections-list",
  get: "sand:collections-get",
  rename: "sand:collections-rename",
  delete: "sand:collections-delete",
  removeMessages: "sand:collections-remove-messages",
  addMessages: "sand:collections-add-messages",
  exportHtml: "sand:collections-export-html",
  exportJson: "sand:collections-export-json",
  exportPdf: "sand:collections-export-pdf",
  importJson: "sand:collections-import-json",
  openOriginal: "sand:collections-open-original",
} as const;

export const COLLECTIONS_PRELOAD_NAVIGATE_CHANNEL = "sand:collections-navigate";

export interface CollectionsPreloadIpc {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void;
  off(channel: string, listener: (event: unknown, payload: unknown) => void): void;
}

export interface CollectionsPreloadBridge {
  list(): Promise<unknown>;
  get(collectionId: string): Promise<unknown>;
  rename(collectionId: string, name: string): Promise<unknown>;
  deleteCollection(collectionId: string): Promise<unknown>;
  removeMessages(collectionId: string, keys: readonly string[]): Promise<unknown>;
  addMessages(request: unknown): Promise<unknown>;
  exportHtml(collectionId: string, theme?: string): Promise<unknown>;
  exportJson(collectionId: string): Promise<unknown>;
  exportPdf(collectionId: string, theme?: string): Promise<unknown>;
  importJson(): Promise<unknown>;
  openOriginal(agentId: string, entryId: string): Promise<unknown>;
  onNavigate(listener: (payload: unknown) => void): () => void;
}

export function createCollectionsPreloadBridge(ipc: CollectionsPreloadIpc): CollectionsPreloadBridge {
  return {
    list: () => ipc.invoke(COLLECTIONS_PRELOAD_CHANNELS.list, {}),
    get: (collectionId) => ipc.invoke(COLLECTIONS_PRELOAD_CHANNELS.get, { collectionId }),
    rename: (collectionId, name) => ipc.invoke(COLLECTIONS_PRELOAD_CHANNELS.rename, { collectionId, name }),
    deleteCollection: (collectionId) => ipc.invoke(COLLECTIONS_PRELOAD_CHANNELS.delete, { collectionId }),
    removeMessages: (collectionId, keys) => ipc.invoke(COLLECTIONS_PRELOAD_CHANNELS.removeMessages, { collectionId, keys: [...keys] }),
    addMessages: (request) => ipc.invoke(COLLECTIONS_PRELOAD_CHANNELS.addMessages, request),
    exportHtml: (collectionId, theme) => ipc.invoke(COLLECTIONS_PRELOAD_CHANNELS.exportHtml, { collectionId, theme }),
    exportJson: (collectionId) => ipc.invoke(COLLECTIONS_PRELOAD_CHANNELS.exportJson, { collectionId }),
    exportPdf: (collectionId, theme) => ipc.invoke(COLLECTIONS_PRELOAD_CHANNELS.exportPdf, { collectionId, theme }),
    importJson: () => ipc.invoke(COLLECTIONS_PRELOAD_CHANNELS.importJson, {}),
    openOriginal: (agentId, entryId) => ipc.invoke(COLLECTIONS_PRELOAD_CHANNELS.openOriginal, { agentId, entryId }),
    onNavigate: (listener) => {
      const wrapped = (_event: unknown, payload: unknown): void => listener(payload);
      ipc.on(COLLECTIONS_PRELOAD_NAVIGATE_CHANNEL, wrapped);
      return () => ipc.off(COLLECTIONS_PRELOAD_NAVIGATE_CHANNEL, wrapped);
    },
  };
}

export interface CollectionsPreloadElectronRuntime {
  readonly ipcRenderer: CollectionsPreloadIpc;
  readonly contextBridge: { exposeInMainWorld(name: string, value: unknown): void };
}

export function installCollectionsPreload(options: {
  readonly ipc: CollectionsPreloadIpc;
  readonly contextBridge: { exposeInMainWorld(name: string, value: unknown): void };
}): CollectionsPreloadBridge {
  const bridge = createCollectionsPreloadBridge(options.ipc);
  options.contextBridge.exposeInMainWorld("collections", bridge);
  return bridge;
}

export function installCollectionsPreloadEntrypoint(
  electron: CollectionsPreloadElectronRuntime,
): CollectionsPreloadBridge {
  return installCollectionsPreload({ ipc: electron.ipcRenderer, contextBridge: electron.contextBridge });
}

export function loadCollectionsPreloadElectron(electronModule: unknown): CollectionsPreloadElectronRuntime {
  const runtime = electronModule as Partial<CollectionsPreloadElectronRuntime> | null;
  if (runtime == null || typeof runtime !== "object") throw new Error("electron collections preload bindings are unavailable");
  const ipc = runtime.ipcRenderer as Partial<CollectionsPreloadIpc> | null | undefined;
  const bridge = runtime.contextBridge as { exposeInMainWorld?: unknown } | null | undefined;
  if (ipc == null || typeof ipc.invoke !== "function" || typeof ipc.on !== "function" || typeof ipc.off !== "function"
    || bridge == null || typeof bridge.exposeInMainWorld !== "function") {
    throw new Error("electron collections preload bindings are unavailable");
  }
  return runtime as CollectionsPreloadElectronRuntime;
}
