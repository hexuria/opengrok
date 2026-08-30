import type { ConnectRouter } from "@connectrpc/connect";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import { DashboardService } from "../packages/proto/generated/aiserver/v1/dashboard_connect.js";
import { GrokBotService } from "../packages/proto/generated/aiserver/v1/grok_bot_connect.ported.js";
import { createDashboardHandlers, createDefaultMockProfile, type MockProfile } from "./dashboard-handlers.js";
import { createDefaultServiceImpl } from "./default-handlers.js";
import { createGrokBotHandlers } from "./grok-bot-handlers.js";
import { createSeededMockStore, type MockGrokBotStore } from "./store.js";

export interface MockRouterOptions {
  readonly store?: MockGrokBotStore;
  readonly profile?: MockProfile;
  readonly holdWatchStreams?: boolean;
}

export function createMockServices(options: MockRouterOptions = {}): {
  readonly store: MockGrokBotStore;
  readonly profile: MockProfile;
  readonly routes: (router: ConnectRouter) => void;
} {
  const store = options.store ?? createSeededMockStore();
  const profile = options.profile ?? createDefaultMockProfile();
  const routes = (router: ConnectRouter): void => {
    router.service(GrokBotService, {
      ...createDefaultServiceImpl(GrokBotService),
      ...createGrokBotHandlers({
        store,
        ...(options.holdWatchStreams === undefined ? {} : { holdWatchStreams: options.holdWatchStreams }),
      }),
    } as never);
    router.service(DashboardService, {
      ...createDefaultServiceImpl(DashboardService),
      ...createDashboardHandlers(profile),
    } as never);
  };
  return { store, profile, routes };
}

export function createInProcessMock(options: MockRouterOptions = {}) {
  const services = createMockServices({
    holdWatchStreams: false,
    ...options,
  });
  const transport = createRouterTransport(services.routes);
  return {
    store: services.store,
    profile: services.profile,
    grokBot: createClient(GrokBotService, transport),
    dashboard: createClient(DashboardService, transport),
  };
}
