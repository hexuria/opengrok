import { DEFAULT_MOCK_HOST, DEFAULT_MOCK_PORT } from "./constants.js";
import { listenMockServer, mockServerUrl, resolveMockListenOptions } from "./http-server.js";

export async function startMockServerCli(): Promise<void> {
  const listen = resolveMockListenOptions();
  const server = await listenMockServer(listen);
  const url = mockServerUrl(server);
  console.log(`GrokBot mock server listening on ${url}`);
  console.log("Point a packaged grok-bot at it with:");
  console.log(`  SAND_BACKEND_URL=${url}`);
  console.log("Point Barok (port 3010) at it with:");
  console.log(`  GROK_BOT_MOCK_URL=${url}`);
  console.log("Then use the existing AuthServicePort.devLogin hook (localhost selects DEV_AUTH_CLIENT_ID).");
  console.log(`Override the port with SAND_MOCK_PORT (default ${DEFAULT_MOCK_PORT} on ${DEFAULT_MOCK_HOST}).`);
  console.log("Mock-only teach helpers: GET|POST /mock/teach/start and /mock/teach/stop.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startMockServerCli();
}
