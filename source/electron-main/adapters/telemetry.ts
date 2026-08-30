import { join } from "node:path";
import { AnalyticsService } from "../../packages/proto/generated/aiserver/v1/analytics_connect.js";
import { createSandCursorBackendClient } from "../../shared/node/cursor-backend/cursor-inference.js";
import { getSandClientVersion } from "../../shared/node/sand-client-metadata.js";
import { SandDesktopStructuredLogTelemetry, type DesktopStructuredLogTelemetryOptions } from "../telemetry/desktop-structured-log-telemetry.js";
import { createDesktopStructuredLogAccessTokenResolver } from "../telemetry/desktop-structured-log-telemetry.js";
import { createDesktopStructuredLogSpill, desktopStructuredLogAccountSlot, DESKTOP_STRUCTURED_LOG_SPILL_FILE_NAME } from "../telemetry/desktop-structured-log-spill.js";
import type { ElectronProductionAdapterBindings } from "../production-adapters.js";
import type { ProductionDisposable, ProductionServiceContext, ProductionTelemetryService } from "../main-production-services.js";
import { requireDisposable, requireFunction, requireObject } from "./provider-guards.js";
import { captureSandSentryWarning } from "../telemetry/sentry.js";

type ProductionTelemetryOptions = Omit<DesktopStructuredLogTelemetryOptions, "createClient" | "createAnonymousClient"> & {
  readonly createClient?: DesktopStructuredLogTelemetryOptions["createClient"];
  readonly createAnonymousClient?: DesktopStructuredLogTelemetryOptions["createAnonymousClient"];
  readonly getAccessToken?: (options: { readonly backendUrl: string }) => Promise<string>;
  readonly getMachineId?: () => Promise<string> | string;
  readonly currentAccountSlot?: () => string | undefined;
  readonly onRequestId?: (requestId: string) => void;
};

export interface ProductionTelemetryPorts {
  readonly resolveOptions: (context: ProductionServiceContext) => ProductionTelemetryOptions | Promise<ProductionTelemetryOptions>;
  readonly attach: (telemetry: SandDesktopStructuredLogTelemetry, context: ProductionServiceContext) => ProductionDisposable;
}

function completeTelemetryOptions(options: ProductionTelemetryOptions): DesktopStructuredLogTelemetryOptions {
  const getAccessToken = options.getAccessToken;
  const getMachineId = options.getMachineId;
  const currentAccountSlot = options.currentAccountSlot ?? (() => options.accountSlot);
  const createClient = options.createClient ?? (getAccessToken === undefined || getMachineId === undefined
    ? undefined
    : () => createSandCursorBackendClient(AnalyticsService, {
      getAccessToken: createDesktopStructuredLogAccessTokenResolver({ getAccessToken: (request) => getAccessToken(request as { readonly backendUrl: string }), currentAccountSlot }),
      getMachineId,
      ...(options.onRequestId === undefined ? {} : { onRequestId: options.onRequestId }),
    }));
  const createAnonymousClient = options.createAnonymousClient ?? (getMachineId === undefined
    ? undefined
    : () => createSandCursorBackendClient(AnalyticsService, { authMode: "anonymous", getAccessToken: async () => "", getMachineId }));
  if (createClient === undefined) throw new TypeError("Missing Electron production adapter port: telemetry.createClient");
  if (createAnonymousClient === undefined) throw new TypeError("Missing Electron production adapter port: telemetry.createAnonymousClient");
  return {
    machineId: options.machineId,
    clientVersion: options.clientVersion,
    ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
    ...(options.accountSlot === undefined ? {} : { accountSlot: options.accountSlot }),
    ...(options.spill === undefined ? {} : { spill: options.spill }),
    ...(options.disabled === undefined ? {} : { disabled: options.disabled }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.enablePolling === undefined ? {} : { enablePolling: options.enablePolling }),
    createClient,
    createAnonymousClient,
  };
}

/** Artifact anchor: main.cjs:506459, `desktopTelemetry = await SandDesktopStructuredLogTelemetry.create({`. */
export function createProductionTelemetryAdapter(
  ports: ProductionTelemetryPorts,
): ElectronProductionAdapterBindings["telemetry"] {
  requireFunction(ports?.resolveOptions, "telemetry.resolveOptions");
  requireFunction(ports?.attach, "telemetry.attach");
  return {
    async create(context): Promise<ProductionTelemetryService> {
      const options = await ports.resolveOptions(context);
      requireObject(options, "telemetry.options");
      const completeOptions = completeTelemetryOptions(options);
      if (typeof completeOptions.machineId !== "string" || completeOptions.machineId.length === 0) throw new TypeError("Missing Electron production adapter port: telemetry.machineId.");
      if (typeof completeOptions.clientVersion !== "string" || completeOptions.clientVersion.length === 0) throw new TypeError("Missing Electron production adapter port: telemetry.clientVersion.");
      const telemetry = await SandDesktopStructuredLogTelemetry.create(completeOptions);
      let attachment: ProductionDisposable;
      try { attachment = requireDisposable(ports.attach(telemetry, context), "telemetry.attachment"); }
      catch (error) { await telemetry.dispose(); throw error; }
      let disposed = false;
      const spillPending = () => (telemetry as unknown as { spillPending(): Promise<void> }).spillPending();
      return {
        telemetry,
        flushBeforeQuit: async () => { await spillPending(); },
        spillPending: async () => { await spillPending(); },
        async dispose() {
          if (disposed) return;
          disposed = true;
          const failures: unknown[] = [];
          try { await attachment.dispose(); } catch (error) { failures.push(error); }
          try { await telemetry.dispose(); } catch (error) { failures.push(error); }
          if (failures.length === 1) throw failures[0];
          if (failures.length > 1) throw new AggregateError(failures, "Electron production telemetry cleanup failed.");
        },
      };
    },
  };
}

/** Manifest-call export: the emitted main process owns these Electron/account seams. */
export function createElectronProductionTelemetryBinding(): ElectronProductionAdapterBindings["telemetry"] {
  const electron = require("electron") as { readonly app: { getPath(name: "userData"): string } };
  requireFunction(electron?.app?.getPath, "electron.app.getPath");
  let currentAccountSlot: string | undefined;
  let telemetry: SandDesktopStructuredLogTelemetry | undefined;
  return createProductionTelemetryAdapter({
    async resolveOptions(context) {
      const account = context.requireAccount();
      const status = await account.getStatus();
      currentAccountSlot = desktopStructuredLogAccountSlot(status as Parameters<typeof desktopStructuredLogAccountSlot>[0]);
      return {
        machineId: context.machineId,
        clientVersion: getSandClientVersion(context.env),
        appVersion: context.resources.metadata.version,
        // The emitted object always carries this key, including the transient
        // logging-in `undefined` value; retain that runtime shape under
        // exactOptionalPropertyTypes.
        accountSlot: currentAccountSlot as string,
        spill: createDesktopStructuredLogSpill({
          path: join(electron.app.getPath("userData"), DESKTOP_STRUCTURED_LOG_SPILL_FILE_NAME),
          onFailure: (failure) => {
            if (context.env.SAND_DISABLE_SENTRY !== "1") captureSandSentryWarning(`desktop telemetry spill ${failure.operation} failed: ${failure.errorClass}`);
          },
        }),
        getAccessToken: async ({ backendUrl }) => (await account.getAuthService()).getValidAccessToken({ backendUrl }),
        getMachineId: () => context.machineId,
        currentAccountSlot: () => telemetry?.currentAccountSlot() ?? currentAccountSlot,
      };
    },
    attach(value, context) {
      telemetry = value;
      const account = context.requireAccount();
      const unsubscribe = account.subscribe(() => {
        void account.getStatus().then((status) => {
          currentAccountSlot = desktopStructuredLogAccountSlot(status as Parameters<typeof desktopStructuredLogAccountSlot>[0]);
          return telemetry?.setAccountSlot(currentAccountSlot);
        }).catch(() => undefined);
      });
      return { dispose: unsubscribe };
    },
  });
}
