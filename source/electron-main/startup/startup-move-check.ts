import type { DataRootSettlement } from "./startup-data-root-migration.js";
import { retireIdleLegacyDaemon } from "./legacy-daemon-retirement.js";
import { moveToApplicationsFolderIfNeeded } from "./move-to-applications-folder.js";
import { brandText } from "../../shared/product-name.js";

export type StartupDisposition = "continue-bootstrap" | "stop-bootstrap";

export interface StartupMoveCheckDependencies {
  readonly platform?: NodeJS.Platform;
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly app: {
    readonly isPackaged: boolean;
    isInApplicationsFolder(): boolean;
    moveToApplicationsFolder(): boolean;
    relaunch(options: { args: readonly string[] }): void;
    exit(code: number): void;
  };
  readonly dialog: {
    showMessageBox(options: Record<string, unknown>): Promise<{ readonly response: number }>;
  };
  readDiscovery(): Promise<{ readonly pid: number; readonly entryRealpath?: string; readonly generationToken?: string; readonly inflightCount?: number } | null>;
  isDaemonProcess(pid: number, discovery: { readonly entryRealpath?: string; readonly generationToken?: string }): boolean;
  terminate(pid: number): Promise<void>;
  isProcessAlive(pid: number): boolean;
  reportFailure?(surface: string, operation: string, error: unknown): void;
  reportFailureClass?(surface: string, operation: string, reason: string): void;
}

export interface StartupMoveCheckArgs {
  readonly dataRootSettlement: DataRootSettlement | null;
  readonly isLabBuild: boolean;
  hasPendingActivation(): boolean;
  beforeExit(): void;
}

export async function runStartupMoveCheck(
  args: StartupMoveCheckArgs,
  deps: StartupMoveCheckDependencies,
): Promise<StartupDisposition> {
  const env = deps.env ?? process.env;
  const argv = deps.argv ?? process.argv;
  const daemonDisposition = await retireIdleLegacyDaemon({
    settlement: args.dataRootSettlement,
    hasPendingActivation: args.hasPendingActivation,
    readDiscovery: deps.readDiscovery,
    isDaemonProcess: deps.isDaemonProcess,
    terminate: deps.terminate,
    isProcessAlive: deps.isProcessAlive,
    relaunch: () => {
      const settledRoot = env.SAND_DATA_ROOT;
      delete env.SAND_DATA_ROOT;
      try { deps.app.relaunch({ args: argv.slice(1) }); }
      catch (error) {
        if (settledRoot != null) env.SAND_DATA_ROOT = settledRoot;
        throw error;
      }
    },
    exit: () => { args.beforeExit(); deps.app.exit(0); },
  });
  if (daemonDisposition === "continue-bootstrap" && args.dataRootSettlement?.reason === "idle-legacy-writer") {
    deps.reportFailureClass?.("local-exec", "legacy-retirement", "retirement-declined");
  }
  if (daemonDisposition === "stop-bootstrap") return "stop-bootstrap";

  const moveDisposition = await moveToApplicationsFolderIfNeeded({
    platform: deps.platform ?? process.platform,
    isLabBuild: args.isLabBuild,
    app: deps.app,
    confirmMove: async () => {
      const result = await deps.dialog.showMessageBox({
        type: "question",
        title: brandText("Move Grok Bot to Applications"),
        message: brandText("Move Grok Bot to the Applications folder?"),
        detail: brandText("Grok Bot cannot install updates from its current location. It will reopen after moving."),
        buttons: ["Move to Applications", "Not Now"],
        defaultId: 0,
        cancelId: 1,
      });
      return result.response === 0;
    },
    reportFailure: async (error) => {
      deps.reportFailure?.("startup", "move-to-applications", error);
      await deps.dialog.showMessageBox({
        type: "error",
        title: brandText("Couldn't Move Grok Bot"),
        message: brandText("Grok Bot couldn't move to Applications"),
        detail: brandText("Move Grok Bot to the Applications folder manually, then reopen Grok Bot"),
        buttons: ["OK"],
        defaultId: 0,
      });
    },
    reportSecondaryFailure: (error) => deps.reportFailure?.("startup", "move-report", error),
  });
  if (moveDisposition === "stop-bootstrap") args.beforeExit();
  return moveDisposition;
}
