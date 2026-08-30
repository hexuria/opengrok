declare module "ws" {
  interface WebSocketOptions {
    readonly headers?: Record<string, string>;
  }

  interface WebSocketInstance {
    readonly readyState: number;
    binaryType: string;
    readonly bufferedAmount: number;
    on(event: string, listener: (...args: any[]) => void): this;
    send(data: Buffer, callback?: () => void): void;
    close(): void;
    terminate(): void;
    removeAllListeners(): this;
  }

  interface WebSocketConstructor {
    new (url: string, options?: WebSocketOptions): WebSocketInstance;
    readonly OPEN: number;
  }

  const WebSocket: WebSocketConstructor;
  export default WebSocket;
}
