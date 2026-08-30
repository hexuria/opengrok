import { DEV_CONTROLS_METHOD_TABLE } from "../shared/rpc/dev-controls.js";
import { bridgeRpcEdge } from "./rpc-edge-runtime.js";

export interface DevControlsPreloadIpc {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void;
  off(channel: string, listener: (event: unknown, payload: unknown) => void): void;
}

export function createDevControlsTransport(ipc: DevControlsPreloadIpc): {
  invoke(channel: string, payload: unknown): Promise<unknown>;
  on(channel: string, listener: (payload: unknown) => void): () => void;
} {
  return {
    invoke: (channel, payload) => ipc.invoke(channel, payload),
    on: (channel, listener) => {
      const wrapped = (_event: unknown, payload: unknown): void => listener(payload);
      ipc.on(channel, wrapped);
      return () => ipc.off(channel, wrapped);
    },
  };
}

export function installDevControlsPreload<TDevControls>(options: {
  readonly ipc: DevControlsPreloadIpc;
  readonly contextBridge: { exposeInMainWorld(name: string, value: unknown): void };
  readonly bridgeEdge: (
    contractName: "dev-controls",
    methods: typeof DEV_CONTROLS_METHOD_TABLE,
    transport: ReturnType<typeof createDevControlsTransport>,
  ) => TDevControls;
}): TDevControls {
  const devControls = options.bridgeEdge("dev-controls", DEV_CONTROLS_METHOD_TABLE, createDevControlsTransport(options.ipc));
  options.contextBridge.exposeInMainWorld("sand", { devControls });
  return devControls;
}

export interface DevControlsPreloadElectronRuntime {
  readonly ipcRenderer: DevControlsPreloadIpc;
  readonly contextBridge: { exposeInMainWorld(name: string, value: unknown): void };
}

export function installDevControlsPreloadEntrypoint(electron: DevControlsPreloadElectronRuntime): Record<string, any> {
  return installDevControlsPreload({
    ipc: electron.ipcRenderer,
    contextBridge: electron.contextBridge,
    bridgeEdge: (_contractName, methods, transport) => bridgeRpcEdge("dev-controls", methods, transport),
  });
}

export function loadDevControlsPreloadElectron(
  electronModule: unknown,
): DevControlsPreloadElectronRuntime {
  const runtime = electronModule as Partial<DevControlsPreloadElectronRuntime> | null;
  if (runtime == null || typeof runtime !== "object") throw new Error("electron dev-controls preload bindings are unavailable");
  const ipc = runtime.ipcRenderer as Partial<DevControlsPreloadIpc> | null | undefined;
  const bridge = runtime.contextBridge as { exposeInMainWorld?: unknown } | null | undefined;
  if (ipc == null || typeof ipc.invoke !== "function" || typeof ipc.on !== "function" || typeof ipc.off !== "function"
    || bridge == null || typeof bridge.exposeInMainWorld !== "function") throw new Error("electron dev-controls preload bindings are unavailable");
  return runtime as DevControlsPreloadElectronRuntime;
}
