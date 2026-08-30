import WebSocketModule from "ws";

import type { ExitWebSocket } from "./exit-client.js";

export interface EgressWebSocketOptions {
  readonly headers: Record<string, string>;
}

interface EgressWebSocketConstructor {
  new (url: string, options: EgressWebSocketOptions): ExitWebSocket;
  readonly OPEN: number;
}

const WebSocket = WebSocketModule as unknown as EgressWebSocketConstructor;

export const EGRESS_TUNNEL_OPEN_READY_STATE = WebSocket.OPEN;

/** The production ws@8 client used by the Electron egress tunnel. */
export function createWebSocket(url: string, options: EgressWebSocketOptions): ExitWebSocket {
  return new WebSocket(url, options);
}
