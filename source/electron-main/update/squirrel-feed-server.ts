import { createReadStream, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { SAND_PRODUCT_DISPLAY_NAME } from "../../shared/product-name.js";

function listeningAddress(server: Server) { const address = server.address(); if (address == null || typeof address === "string") throw new Error("Squirrel feed server has no bound TCP address."); return address; }
export class SquirrelFeedServer {
  private server: Server | null = null;
  async start(options: { readonly zipPath: string; readonly version: string; readonly releaseName?: string; readonly pubDate?: string }): Promise<string> {
    this.stop(); const zipSize = statSync(options.zipPath).size;
    const server = createServer((request, response) => { const path = request.url?.split("?")[0]; if (request.method !== "GET") { response.writeHead(405).end(); return; } if (path === "/feed.json") { const address = listeningAddress(server); response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ url: `http://127.0.0.1:${address.port}/update.zip`, name: options.releaseName ?? `${SAND_PRODUCT_DISPLAY_NAME} ${options.version}`, pub_date: options.pubDate ?? new Date().toISOString() })); return; } if (path === "/update.zip") { response.writeHead(200, { "content-type": "application/zip", "content-length": zipSize, "cache-control": "no-store" }); const stream = createReadStream(options.zipPath); stream.on("error", () => response.destroy()); stream.pipe(response); return; } response.writeHead(404).end(); });
    this.server = server; await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); return `http://127.0.0.1:${listeningAddress(server).port}/feed.json`;
  }
  stop(): void { this.server?.close(); this.server = null; }
}
