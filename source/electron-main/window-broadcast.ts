export interface ProductionBroadcastWindow {
  readonly webContents: {
    send(channel: string, payload: unknown): void;
  };
}

export interface ProductionBroadcastBrowserWindowSource {
  getAllWindows(): readonly ProductionBroadcastWindow[];
}

/** Exact Electron-main broadcast owner: every open BrowserWindow receives the event. */
export function createProductionWindowBroadcaster(
  browserWindow: ProductionBroadcastBrowserWindowSource,
): (channel: string, payload: unknown) => void {
  return (channel, payload) => {
    for (const window of browserWindow.getAllWindows()) {
      window.webContents.send(channel, payload);
    }
  };
}
