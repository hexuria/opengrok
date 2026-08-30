import { join } from "node:path";
import { resolveReleaseTrackGate } from "../../shared/update-track.js";
import { createUpdateApplyMarkerStore } from "./apply-marker.js";
import { createIdleRelaunchSignals } from "./idle-relaunch-signals.js";
import { SandUpdateService, type SandUpdateServiceOptions } from "./sand-update-service.js";
import { SandWindowsInstaller } from "./win32-installer.js";

export function createUpdateServiceWiring(deps: {
  readonly currentVersion: string; readonly buildDefaultTrack: SandUpdateServiceOptions["buildDefaultTrack"]; readonly disabledReason?: SandUpdateServiceOptions["disabledReason"]; readonly machineId: string;
  readonly electron: { readonly app: { getPath(name: "temp" | "userData"): string; quit(): void }; readonly autoUpdater: NonNullable<SandUpdateServiceOptions["squirrel"]>; readonly powerMonitor: { getSystemIdleState(seconds: number): string; getSystemIdleTime(): number } };
  readonly settingsStore: { getUpdateTrackOverride(): any; setUpdateTrackOverride(track: any): void; getAutoUpdateWhenIdleOptIn(): boolean; setAutoUpdateWhenIdleOptIn(enabled: boolean): void };
  readonly getExperimentService: () => { checkFeatureGate(name: string): boolean; getDynamicConfig(name: string): any; hasLiveStatsigBootstrap(): boolean; getFlagsAgeMs(): number | undefined } | null | undefined;
  readonly getHostStatus: () => Promise<{ isBusy: boolean }>; readonly emitStatus: (status: any) => void; readonly reportOutcome?: (report: any) => void; readonly reportCheck?: (report: any) => void; readonly reportApply?: (report: any) => void;
  readonly platform?: NodeJS.Platform; readonly env?: NodeJS.ProcessEnv; readonly log?: (message: string) => void; readonly createService?: (options: SandUpdateServiceOptions) => SandUpdateService; readonly createWindowsInstaller?: (options: ConstructorParameters<typeof SandWindowsInstaller>[0]) => NonNullable<SandUpdateServiceOptions["windows"]>;
}) {
  const platform = deps.platform ?? process.platform; const log = deps.log ?? ((message: string) => console.error(`[sand-update] ${message}`));
  const feedBaseUrl = (deps.env ?? process.env).SAND_UPDATE_FEED_BASE_URL;
  const windows = platform === "win32" ? (deps.createWindowsInstaller ?? ((options) => new SandWindowsInstaller(options)))({ quit: () => deps.electron.app.quit(), log }) : null;
  const options: SandUpdateServiceOptions = {
    currentVersion: deps.currentVersion, buildDefaultTrack: deps.buildDefaultTrack, ...(deps.disabledReason === undefined ? {} : { disabledReason: deps.disabledReason }), squirrel: platform === "darwin" ? deps.electron.autoUpdater : null, windows, tempDir: deps.electron.app.getPath("temp"), machineId: deps.machineId, ...(feedBaseUrl === undefined ? {} : { feedBaseUrl }),
    getTrackOverride: () => deps.settingsStore.getUpdateTrackOverride(), persistTrackOverride: (track) => deps.settingsStore.setUpdateTrackOverride(track), getAutoUpdateWhenIdleOptIn: () => deps.settingsStore.getAutoUpdateWhenIdleOptIn(), persistAutoUpdateWhenIdleOptIn: (enabled) => deps.settingsStore.setAutoUpdateWhenIdleOptIn(enabled), getAutoUpdateWhenIdleGateEnabled: () => deps.getExperimentService()?.checkFeatureGate("sand_auto_update_when_idle") ?? false,
    idleRelaunchSignals: createIdleRelaunchSignals({ powerMonitor: deps.electron.powerMonitor, probeHostIdle: () => deps.getHostStatus().then((status) => status.isBusy ? { kind: "busy" } : { kind: "confirmed-idle" }, () => ({ kind: "unavailable" })) }),
    getMinimumVersion: () => deps.getExperimentService()?.getDynamicConfig("sand_min_client_version").min_version ?? null, getReleaseTrackGate: () => resolveReleaseTrackGate(deps.getExperimentService()?.getDynamicConfig("sand_internal_release_track_override") ?? {}), hasLiveExperimentBootstrap: () => deps.getExperimentService()?.hasLiveStatsigBootstrap() === true, getFlagsAgeMs: () => deps.getExperimentService()?.getFlagsAgeMs(), onStatusChange: deps.emitStatus, log,
    applyMarker: createUpdateApplyMarkerStore(join(deps.electron.app.getPath("userData"), "sand-update-apply-marker.json")), ...(deps.reportOutcome === undefined ? {} : { reportOutcome: deps.reportOutcome }), ...(deps.reportCheck === undefined ? {} : { reportCheck: deps.reportCheck }), ...(deps.reportApply === undefined ? {} : { reportApply: deps.reportApply }),
  };
  const service = (deps.createService ?? ((value) => new SandUpdateService(value)))(options); service.start(); return service;
}
