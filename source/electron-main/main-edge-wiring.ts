import { createMainEdgeServedHandlers, createMainEdgeTrust, type MainEdgeDeps } from "./main-edge.js";

export interface MainEdgeSender { readonly mainFrame: unknown }
export interface MainEdgeIpcPort {
  handle(channel: string, listener: (event: { sender: unknown; senderFrame: unknown }, payload: unknown) => unknown): void;
  removeHandler(channel: string): void;
}
export interface MainEdgeWiringDeps extends MainEdgeDeps {
  readonly ipcMain: MainEdgeIpcPort;
  readonly getTrustedContents: () => MainEdgeSender | null;
  readonly broadcast: (channel: string, payload: unknown) => void;
  readonly serveEdge: (contract: unknown, methodTable: unknown, options: { transport: ReturnType<typeof mainEdgeTransport>; trust: ReturnType<typeof createMainEdgeTrust>; handlers: ReturnType<typeof createMainEdgeServedHandlers> }) => unknown;
  readonly mainRpcContract: unknown;
  readonly mainMethodTable: unknown;
}

export function mainEdgeTransport(deps: Pick<MainEdgeWiringDeps, "ipcMain" | "getTrustedContents" | "broadcast">) {
  return {
    handle(channel: string, run: (sender: { isAppWindowTopFrame: boolean }, payload: unknown) => unknown): void { deps.ipcMain.handle(channel, (event, payload) => { const contents = deps.getTrustedContents(); return run({ isAppWindowTopFrame: contents != null && event.sender === contents && event.senderFrame === contents.mainFrame }, payload); }); },
    removeHandler(channel: string): void { deps.ipcMain.removeHandler(channel); },
    broadcast(channel: string, payload: unknown): void { deps.broadcast(channel, payload); },
  };
}

export function serveMainEdge(deps: MainEdgeWiringDeps): unknown {
  return deps.serveEdge(deps.mainRpcContract, deps.mainMethodTable, { transport: mainEdgeTransport(deps), trust: createMainEdgeTrust(), handlers: createMainEdgeServedHandlers(deps) });
}
