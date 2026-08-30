import type {
  ProductionCoordinatorMessageChannelConstructor,
  ProductionCoordinatorUtilityProcess,
} from "../coordinator/production-provider.js";
import type {
  WebAuthnPromptWindow,
  WebAuthnPromptWindowOptions,
} from "../coordinator/coordinator-executors.js";
import {
  isProcessAlive,
  readProcessIdentity,
  spawnLocalExecDaemon,
  terminateProcess,
} from "../local-exec/local-exec-native.js";

export interface ElectronCoordinatorNativeSource {
  readonly utilityProcess: ProductionCoordinatorUtilityProcess;
  readonly MessageChannelMain: ProductionCoordinatorMessageChannelConstructor;
  readonly net: { isOnline(): boolean };
  readonly powerMonitor: { on(event: "resume", listener: () => void): void };
  readonly BrowserWindow: new(options: WebAuthnPromptWindowOptions) => WebAuthnPromptWindow;
}

export interface ElectronCoordinatorNativePorts {
  readonly utilityProcess: ProductionCoordinatorUtilityProcess;
  readonly MessageChannelMain: ProductionCoordinatorMessageChannelConstructor;
  readonly net: { isOnline(): boolean };
  readonly powerMonitor: { on(event: "resume", listener: () => void): void };
  readonly createWebAuthnPromptWindow: (options: WebAuthnPromptWindowOptions) => WebAuthnPromptWindow;
  readonly localExecNative: {
    readonly spawnLocalExecDaemon: typeof spawnLocalExecDaemon;
    readonly terminateProcess: typeof terminateProcess;
    readonly isProcessAlive: typeof isProcessAlive;
    readonly readProcessIdentity: typeof readProcessIdentity;
  };
}

function requireFunction(value: unknown, label: string): asserts value is (...args: never[]) => unknown {
  if (typeof value !== "function") throw new Error(`Electron coordinator native binding requires ${label}.`);
}

export function createProductionCoordinatorNativePorts(
  source: ElectronCoordinatorNativeSource,
): ElectronCoordinatorNativePorts {
  requireFunction(source?.utilityProcess?.fork, "electron.utilityProcess.fork");
  requireFunction(source?.MessageChannelMain, "electron.MessageChannelMain");
  requireFunction(source?.net?.isOnline, "electron.net.isOnline");
  requireFunction(source?.powerMonitor?.on, "electron.powerMonitor.on");
  requireFunction(source?.BrowserWindow, "electron.BrowserWindow");
  return {
    utilityProcess: source.utilityProcess,
    MessageChannelMain: source.MessageChannelMain,
    net: source.net,
    powerMonitor: source.powerMonitor,
    createWebAuthnPromptWindow: (options) => new source.BrowserWindow(options),
    localExecNative: { spawnLocalExecDaemon, terminateProcess, isProcessAlive, readProcessIdentity },
  };
}

/** Exact emitted coordinator native seam: utilityProcess, MessageChannelMain, net, powerMonitor, BrowserWindow. */
export function createElectronProductionCoordinatorNativePorts(): ElectronCoordinatorNativePorts {
  const electron = require("electron") as ElectronCoordinatorNativeSource;
  return createProductionCoordinatorNativePorts(electron);
}
