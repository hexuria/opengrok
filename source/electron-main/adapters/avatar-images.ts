import { writeFile } from "node:fs/promises";
import { createContext } from "../../packages/context/core.js";
import { loggerKey } from "../../packages/context/logger.js";
import { SAND_DEFAULT_MODEL_ID } from "../../shared/agents/agent-model.js";
import { createCursorGenerateImageService } from "../../shared/node/cursor-backend/cursor-generate-image.js";
import { generateAvatarImageWithGemini } from "../account/gemini-image.js";
import {
  createAvatarImageEdgePort,
  registerImageContextMenu,
  type AvatarImageDeps,
  type AvatarImageDialogOptions,
  type ImageContextMenuElectronPorts,
  type NativeImagePort,
} from "../media/avatar-images.js";
import type { ElectronProductionAdapterBindings } from "../production-adapters.js";
import type { ProductionServiceContext } from "../main-production-services.js";
import { requireFunction } from "./provider-guards.js";

export interface ElectronAvatarImageCompositionPorts {
  readonly BrowserWindow: new(options: { readonly show: false }) => unknown;
  readonly dialog: {
    showOpenDialog(window: unknown, options: AvatarImageDialogOptions): Promise<{ canceled: boolean; filePaths: readonly string[] }>;
  };
  readonly nativeImage: {
    createFromPath(path: string): NativeImagePort;
    createFromBuffer(bytes: Buffer): NativeImagePort;
  };
}

export interface ProductionAvatarImagesPorts {
  readonly electron: ElectronAvatarImageCompositionPorts;
}

type ElectronImageContextMenuRuntimePorts = Omit<ImageContextMenuElectronPorts, "writeFile" | "openExternalUrl" | "onEdgeFailure">;

export interface ProductionImageContextMenuBinding {
  register(deps: Pick<ImageContextMenuElectronPorts, "openExternalUrl" | "onEdgeFailure">): void;
}

function requireImageContextMenuPorts(ports: ElectronImageContextMenuRuntimePorts): ElectronImageContextMenuRuntimePorts {
  if (ports?.app == null || typeof ports.app.on !== "function") throw new TypeError("Incomplete Electron image context-menu ABI: app.on.");
  if (ports.BrowserWindow == null || typeof ports.BrowserWindow.fromWebContents !== "function") throw new TypeError("Incomplete Electron image context-menu ABI: BrowserWindow.fromWebContents.");
  if (ports.clipboard == null || typeof ports.clipboard.writeImage !== "function" || typeof ports.clipboard.readImage !== "function" || typeof ports.clipboard.writeText !== "function") throw new TypeError("Incomplete Electron image context-menu ABI: clipboard.");
  if (ports.dialog == null || typeof ports.dialog.showSaveDialog !== "function") throw new TypeError("Incomplete Electron image context-menu ABI: dialog.showSaveDialog.");
  if (typeof ports.Menu !== "function" || typeof ports.MenuItem !== "function") throw new TypeError("Incomplete Electron image context-menu ABI: Menu/MenuItem.");
  if (ports.nativeImage == null || typeof ports.nativeImage.createFromDataURL !== "function") throw new TypeError("Incomplete Electron image context-menu ABI: nativeImage.createFromDataURL.");
  return ports;
}

function validatePorts(ports: ProductionAvatarImagesPorts): ProductionAvatarImagesPorts {
  if (typeof ports?.electron?.BrowserWindow !== "function") throw new TypeError("Missing Electron production adapter port: avatarImages.electron.BrowserWindow.");
  requireFunction(ports.electron.dialog?.showOpenDialog, "avatarImages.electron.dialog.showOpenDialog");
  requireFunction(ports.electron.nativeImage?.createFromPath, "avatarImages.electron.nativeImage.createFromPath");
  requireFunction(ports.electron.nativeImage?.createFromBuffer, "avatarImages.electron.nativeImage.createFromBuffer");
  return ports;
}

/** Exact avatar edge join: main.cjs:506253, `avatarImages: createAvatarImageEdgePort({`. */
export function createProductionAvatarImagesAdapter(
  ports: ProductionAvatarImagesPorts,
): ElectronProductionAdapterBindings["avatarImages"] {
  validatePorts(ports);
  return {
    create(context) {
      let generator: ReturnType<typeof createCursorGenerateImageService> | undefined;
      const deps: AvatarImageDeps = {
        getMainWindow: () => context.getMainWindow() ?? null,
        createHiddenWindow: (options) => new ports.electron.BrowserWindow(options),
        showOpenDialog: (window, options) => ports.electron.dialog.showOpenDialog(window, options),
        createFromPath: (path) => ports.electron.nativeImage.createFromPath(path),
        createFromBuffer: (bytes) => ports.electron.nativeImage.createFromBuffer(bytes),
        generate: async (description) => {
          // Cursor's image service needs a signed-in account; routed sessions
          // fall back to the user's own Gemini key (the Dictation tab key).
          let cursorError: unknown;
          try {
            generator ??= createCursorGenerateImageService({
              getAccessToken: (options) => context.requireAccount().getAuthService().then((auth) => auth.getValidAccessToken(options)),
              getMachineId: () => context.machineId,
              modelId: context.env.SAND_AGENT_MODEL ?? SAND_DEFAULT_MODEL_ID,
            });
            return await generator(createContext().with(loggerKey, { log() {} }), description);
          } catch (error) { cursorError = error; }
          const stores = (context as { secretsStores?: { userSecretsStore?: { reveal?: (key: string) => Promise<string | null> } } }).secretsStores;
          const revealed = await stores?.userSecretsStore?.reveal?.("GEMINI_API_KEY").catch(() => null) ?? null;
          const fallback = await generateAvatarImageWithGemini(description, revealed == null || revealed.trim().length === 0 ? {} : { apiKey: revealed.trim() });
          if (fallback != null) return fallback;
          throw cursorError;
        },
        onEdgeFailure: (failure) => context.readTelemetry()?.telemetry.reportImageEdgeFailure?.(failure),
      };
      return createAvatarImageEdgePort(deps);
    },
  };
}

/** Manifest-call export. Electron remains a real bare runtime dependency. */
export function createElectronProductionAvatarImagesBinding(): ElectronProductionAdapterBindings["avatarImages"] {
  const electron = require("electron") as ElectronAvatarImageCompositionPorts;
  return createProductionAvatarImagesAdapter({ electron });
}

/** Built-in root registration for immutable main.cjs:506695; not a manifest slot. */
export function createElectronProductionImageContextMenuBinding(): ProductionImageContextMenuBinding {
  const electron = requireImageContextMenuPorts(require("electron") as ElectronImageContextMenuRuntimePorts);
  return {
    register(deps) {
      registerImageContextMenu({
        ...electron,
        writeFile: async (path, bytes) => { await writeFile(path, bytes); },
        openExternalUrl: deps.openExternalUrl,
        onEdgeFailure: deps.onEdgeFailure,
      });
    },
  };
}
