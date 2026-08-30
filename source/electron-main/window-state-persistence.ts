import { readFileSync, promises as fs } from "node:fs";
import path from "node:path";
import {
  SAND_MIN_WINDOW_SIZE,
  SandWindowStateStore,
  resolveSandWindowLaunchPlacement,
  type SandWindowBounds,
} from "./window-state-store.js";

export interface WindowStatePersistenceWindow {
  isDestroyed(): boolean;
  isMaximized(): boolean;
  isFullScreen(): boolean;
  maximize(): void;
  getBounds(): SandWindowBounds;
  getNormalBounds(): SandWindowBounds;
  getContentBounds(): SandWindowBounds;
  setContentBounds(bounds: SandWindowBounds): void;
  on(event: "resize" | "move" | "maximize" | "unmaximize" | "close", listener: () => void): void;
}

export interface WindowStatePersistenceScreen {
  getAllDisplays(): readonly { readonly workArea: SandWindowBounds }[];
  getDisplayMatching(bounds: SandWindowBounds): { readonly workArea: SandWindowBounds };
}

export interface SandWindowPlacement {
  readonly windowOptions: {
    readonly x?: number;
    readonly y?: number;
    readonly width: number;
    readonly height: number;
    readonly minWidth: number;
    readonly minHeight: number;
  };
  readonly bounds: SandWindowBounds | null;
  readonly persistedNormalBounds: SandWindowBounds | null;
  readonly maximize: boolean;
}

export function isCloudAgentVm(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["IS_CLOUD_AGENT", "EVERYSPHERE_DEV_IN_CLOUD", "CURSOR_AGENT"].some((key) => {
    const value = env[key]?.trim().toLowerCase();
    return value != null && value !== "" && value !== "0" && value !== "false";
  });
}

export function windowStatePath(app: { readonly getPath: (name: "userData") => string }): string {
  return path.join(app.getPath("userData"), "window-state.json");
}

function errorCode(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  return code ?? error.name;
}

export function reportWindowStateFailure(
  stage: string,
  error: unknown,
  captureWarning: (message: string) => void,
): void {
  captureWarning(`sand window-state ${stage} failed: ${errorCode(error)}`);
}

export function createWindowStatePersistence(deps: {
  readonly app: { readonly getPath: (name: "userData") => string };
  readonly screen: WindowStatePersistenceScreen;
  readonly captureWarning: (message: string) => void;
  readonly env?: NodeJS.ProcessEnv;
  readonly pid?: number;
  readonly readTextFile?: (statePath: string) => string;
  readonly writeTextFile?: (statePath: string, text: string, pid: number) => Promise<void>;
}): {
  readonly store: SandWindowStateStore;
  readonly resolveSandWindowPlacement: () => SandWindowPlacement;
  readonly applySandWindowPlacement: (
    window: WindowStatePersistenceWindow,
    placement: SandWindowPlacement,
  ) => void;
  readonly attachWindowStatePersistence: (
    window: WindowStatePersistenceWindow,
    initialBounds: SandWindowBounds | null,
  ) => void;
  readonly windowChromeEdgeDeps: <T extends WindowStatePersistenceWindow>(
    getMainWindow: () => T | null | undefined,
  ) => {
    readonly getMainWindow: () => T | null | undefined;
    readonly workAreaFor: (window: T) => SandWindowBounds;
  };
} {
  const reportFailure = (stage: string, error: unknown): void => {
    reportWindowStateFailure(stage, error, deps.captureWarning);
  };
  const statePath = (): string => windowStatePath(deps.app);
  const store = new SandWindowStateStore({
    readTextFile: () => {
      try {
        return deps.readTextFile?.(statePath()) ?? readFileSync(statePath(), "utf-8");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          reportFailure("read", error);
        }
        return null;
      }
    },
    writeTextFile: async (text) => {
      const target = statePath();
      if (deps.writeTextFile != null) {
        await deps.writeTextFile(target, text, deps.pid ?? process.pid);
        return;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      const tempPath = `${target}.${deps.pid ?? process.pid}.tmp`;
      await fs.writeFile(tempPath, text, { encoding: "utf-8", mode: 0o600 });
      await fs.rename(tempPath, target);
    },
    reportFailure,
  });

  const attachWindowStatePersistence = (
    window: WindowStatePersistenceWindow,
    initialBounds: SandWindowBounds | null,
  ): void => {
    let normalBounds = initialBounds ?? window.getContentBounds();
    const isPlainWindowed = (): boolean => {
      if (window.isMaximized() || window.isFullScreen()) return false;
      const bounds = window.getBounds();
      const normal = window.getNormalBounds();
      return (
        bounds.x === normal.x &&
        bounds.y === normal.y &&
        bounds.width === normal.width &&
        bounds.height === normal.height
      );
    };
    const persist = (): void => {
      if (window.isDestroyed()) return;
      if (isPlainWindowed()) normalBounds = window.getContentBounds();
      store.note({ version: 1, normalBounds, isMaximized: window.isMaximized() });
    };
    window.on("resize", persist);
    window.on("move", persist);
    window.on("maximize", persist);
    window.on("unmaximize", persist);
    window.on("close", persist);
  };

  const resolveSandWindowPlacement = (): SandWindowPlacement => {
    const persisted = store.load();
    const placement = resolveSandWindowLaunchPlacement({
      persisted,
      workAreas: deps.screen.getAllDisplays().map((display) => display.workArea),
    });
    const onCloud = isCloudAgentVm(deps.env ?? process.env);
    const fallback = { width: onCloud ? 1440 : 1040, height: onCloud ? 960 : 760 };
    return {
      windowOptions: {
        ...(placement.bounds ?? fallback),
        minWidth: SAND_MIN_WINDOW_SIZE.width,
        minHeight: SAND_MIN_WINDOW_SIZE.height,
      },
      bounds: placement.bounds,
      persistedNormalBounds: persisted?.normalBounds ?? null,
      maximize: placement.maximize,
    };
  };

  const applySandWindowPlacement = (
    window: WindowStatePersistenceWindow,
    placement: SandWindowPlacement,
  ): void => {
    if (placement.bounds != null) window.setContentBounds(placement.bounds);
    attachWindowStatePersistence(window, placement.bounds ?? placement.persistedNormalBounds);
    if (placement.maximize) window.maximize();
  };

  const windowChromeEdgeDeps = <T extends WindowStatePersistenceWindow>(
    getMainWindow: () => T | null | undefined,
  ) => ({
    getMainWindow,
    workAreaFor: (window: T): SandWindowBounds =>
      deps.screen.getDisplayMatching(window.getBounds()).workArea,
  });

  return {
    store,
    resolveSandWindowPlacement,
    applySandWindowPlacement,
    attachWindowStatePersistence,
    windowChromeEdgeDeps,
  };
}
