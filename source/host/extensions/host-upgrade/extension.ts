import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { defineHostExtension } from "../../../internal/host-extensions.js";
import { createRealPollingPolicy, realClock } from "../../../internal/scheduling.js";
import { getHostUpgradeMarkerPath } from "../../host-paths.js";
import { HostExtensions } from "../extension-ids.generated.js";
import { HOST_BUNDLE_WATCH_INTERVAL_MS, HOST_BUNDLE_WATCH_JITTER_RATIO, isHostVersionSwapVetoed, readLocalHostVersion, stageHostBundleUpgrade } from "./host-bundle-upgrade.js";
import { resolveHostBundleSource } from "./host-bundle-source.js";
import { HostUpgradeService, type HostUpgradeServiceDependencies } from "./host-upgrade-service.js";

export const HOST_UPGRADE_MARKER_FORWARD_INTERVAL_MS = 5 * 60_000;
export function isHostBundleAutoUpdateEnabled(env: NodeJS.ProcessEnv = process.env): boolean { const raw = env.SAND_BOX_AUTO_UPDATE?.trim().toLowerCase(); return !(raw === "0" || raw === "false" || raw === "no"); }
export function hostBundleWatchIntervalMs(env: NodeJS.ProcessEnv = process.env): number { const raw = Number.parseInt(env.SAND_BOX_UPDATE_WATCH_INTERVAL_MS ?? "", 10); return Number.isInteger(raw) && raw > 0 ? raw : HOST_BUNDLE_WATCH_INTERVAL_MS; }
export function hostBundleWatchJitterRatio(env: NodeJS.ProcessEnv = process.env): number { const raw = Number.parseFloat(env.SAND_BOX_UPDATE_WATCH_JITTER_RATIO ?? ""); return Number.isFinite(raw) && raw >= 0 ? raw : HOST_BUNDLE_WATCH_JITTER_RATIO; }
export function createMarkerStore(markerPath = getHostUpgradeMarkerPath()): HostUpgradeServiceDependencies["markerStore"] { return { readRaw: async () => { try { return existsSync(markerPath) ? await readFile(markerPath, "utf8") : null; } catch { return null; } }, deleteMarker: async () => { try { await rm(markerPath, { force: true }); } catch {} } }; }

type PeerDependencies = Pick<HostUpgradeServiceDependencies, "automations" | "sharing" | "telemetry" | "transcript">;
export function createHostUpgradeExtension(overrides: Partial<Omit<HostUpgradeServiceDependencies, keyof PeerDependencies>> = {}) {
  return defineHostExtension({ id: HostExtensions.HostUpgrade, dependencies: [HostExtensions.Automations, HostExtensions.CrossUserSharing, HostExtensions.Telemetry, HostExtensions.Transcript], start: (context) => {
    const peers: PeerDependencies = { automations: context.deps[HostExtensions.Automations] as PeerDependencies["automations"], sharing: context.deps[HostExtensions.CrossUserSharing] as PeerDependencies["sharing"], telemetry: (context.deps[HostExtensions.Telemetry] as { logs: PeerDependencies["telemetry"] }).logs, transcript: context.deps[HostExtensions.Transcript] as PeerDependencies["transcript"] };
    const service = new HostUpgradeService({ ...peers, markerStore: createMarkerStore(), markerForwardPolicy: createRealPollingPolicy({ name: "host-upgrade-marker-forward", intervalMs: HOST_UPGRADE_MARKER_FORWARD_INTERVAL_MS }), createUpdateWatchDelayPolicy: (delayMs) => createRealPollingPolicy({ name: "host-upgrade-shared-update-watch", intervalMs: delayMs }), clock: realClock, random: Math.random, isInBox: process.env.SAND_HOST_IN_BOX === "1", isAutoUpdateEnabled: isHostBundleAutoUpdateEnabled(), updateWatchIntervalMs: hostBundleWatchIntervalMs(), updateWatchJitterRatio: hostBundleWatchJitterRatio(), resolveBundleSource: resolveHostBundleSource, readLocalVersion: readLocalHostVersion, isVersionSwapVetoed: isHostVersionSwapVetoed, stageUpgrade: stageHostBundleUpgrade, log: (level, message) => { if (level === "warn") console.warn(`[sand-host] ${message}`); else console.info(`[sand-host] ${message}`); }, ...overrides });
    context.onStop(() => service.dispose()); service.startMarkerForwardWake(); return service;
  } });
}
export const hostUpgradeExtension = createHostUpgradeExtension();
