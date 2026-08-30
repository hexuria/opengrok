import {
  createSandBoxMigrationRelay,
  type MigrationEvent,
  type MigrationStatus,
  type MigrationWatchTelemetry,
} from "./box-migration-watcher.js";
import { createSandRecreateCommands, type RecreateResult } from "./box-recreate-commands.js";

export interface BoxRecoveryConnector {
  recreate?(args: { readonly preserveData: boolean; readonly force?: boolean }): Promise<RecreateResult>;
  forceRecreate?(): Promise<RecreateResult>;
}

export interface BoxRecovery {
  readBoxMigrationStatus(): MigrationEvent | null;
  restartCoordinator(): void;
  recreateComputer(args: { readonly preserveData: boolean; readonly force?: boolean }): Promise<RecreateResult>;
  forceRecreateComputer(): Promise<RecreateResult>;
  updateForeverBox(args: { readonly id: string; readonly force: boolean }): Promise<unknown>;
  dispose(): void;
}

export interface ProductionBoxRecovery extends BoxRecovery {
  start(): void;
  ingestMigration(event: MigrationEvent): void;
}

export interface ProductionBoxRecoveryOptions {
  readonly connector: BoxRecoveryConnector;
  readonly watch?: (signal: AbortSignal) => AsyncIterable<MigrationStatus>;
  broadcast(event: MigrationEvent): void;
  onWatchTelemetry?: (event: MigrationWatchTelemetry) => void;
  restartCoordinator(): void;
  updateForeverBox(args: { readonly id: string; readonly force: boolean }): Promise<unknown>;
}

export function createProductionBoxRecovery(options: ProductionBoxRecoveryOptions): ProductionBoxRecovery {
  const relay = createSandBoxMigrationRelay({
    ...(options.watch === undefined ? {} : { watch: options.watch }),
    broadcast: options.broadcast,
    ...(options.onWatchTelemetry === undefined ? {} : { onWatchTelemetry: options.onWatchTelemetry }),
  });
  const commands = createSandRecreateCommands({
    connector: options.connector,
    noteRecreateAccepted: (operationId) => relay.noteRecreateAccepted(operationId),
  });
  let started = false;
  let disposed = false;
  return {
    start(): void {
      if (disposed || started) return;
      started = true;
      relay.start();
    },
    ingestMigration: relay.ingest,
    readBoxMigrationStatus: () => relay.getStatus(),
    restartCoordinator: options.restartCoordinator,
    recreateComputer: commands.recreateComputer,
    forceRecreateComputer: commands.forceRecreateComputer,
    updateForeverBox: options.updateForeverBox,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      relay.dispose();
    },
  };
}
