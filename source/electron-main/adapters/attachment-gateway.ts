import { attachmentByteLimitForName } from "../../shared/media/attachment-limits.js";
import { getFilePreviewKind, previewKindNeedsBytes, type FilePreviewKind } from "../../shared/media/file-preview-kind.js";
import { readWebpOrHeicDimensions } from "../../shared/media/image-dimensions.js";
import { audioMimeFromPath, imageMimeFromPath, servableImageMimeFromPath, videoMimeFromPath } from "../../shared/media/image-mime.js";
import { createAttachmentEdgePort, type AttachmentEdgeDeps, type AttachmentLegs } from "../attachments/attachments.js";
import {
  ATTACHMENT_PREVIEW_BYTE_CAP,
  getDesktopAttachmentStagingDir,
  isWithinDesktopAttachmentStaging,
  resolveImageAttachment,
} from "../attachments/attachment-manager.js";
import { fetchLinkMetadata } from "../../host/extensions/attachments/attachments-service.js";
import { resolveDefaultDownloadPath, resolveSuggestedDownloadName } from "../downloads/download-path.js";
import { boundPreviewImageDataUrl } from "../../host/extensions/attachments/link-preview-image-bounds.js";
import { buildSandMediaUrl } from "../media/media-protocol.js";
import type { ElectronProductionAdapterBindings } from "../production-adapters.js";
import type { ProductionServiceContext } from "../main-production-services.js";
import { requireFunction, requireObject } from "./provider-guards.js";

export interface ProductionAttachmentGatewayPorts {
  readonly resolveDeps: (context: Omit<ProductionServiceContext, "attachments" | "avatarImages" | "cursorAccount" | "ensureTranscriptionManager">) => AttachmentEdgeDeps;
}

export interface ElectronAttachmentGatewayCompositionPorts {
  readonly app: { getPath(name: "userData" | "downloads"): string };
  readonly BrowserWindow: new(options: { readonly show: false }) => unknown;
  readonly dialog: {
    showSaveDialog(window: unknown, options: { readonly defaultPath: string }): Promise<{ readonly canceled: boolean; readonly filePath?: string }>;
    showMessageBox(windowOrOptions: unknown, options?: { readonly type: "error"; readonly title: string; readonly message: string }): Promise<unknown>;
  };
  readonly nativeImage: AttachmentEdgeDeps["nativeImage"] & {
    createFromBuffer(buffer: Buffer): { isEmpty(): boolean; getSize(): { width: number; height: number } };
  };
}

const REQUIRED_FUNCTIONS = [
  "getMainWindow", "onEdgeFailure", "videoMimeFromPath", "audioMimeFromPath",
  "displayableImageMimeFromPath", "buildMediaUrl", "resolveImage",
  "fetchLinkMetadata", "boundPreviewImage", "previewKindNeedsBytes",
  "getFilePreviewKind", "byteLimitForName", "getStagingDir",
  "isWithinStagingDir", "resolveSuggestedDownloadName",
  "resolveDefaultDownloadPath", "showSaveDialog", "createHiddenWindow",
  "showErrorMessage", "getUserDataDir",
] as const;

function validateAttachmentDeps(deps: AttachmentEdgeDeps): AttachmentEdgeDeps {
  requireObject(deps, "attachmentGateway.deps");
  requireObject(deps.legs, "attachmentGateway.legs");
  for (const method of ["readAttachmentImage", "readAttachmentText", "readAttachmentChunk", "uploadAttachment"] as const) {
    requireFunction(deps.legs[method], `attachmentGateway.legs.${method}`);
  }
  requireObject(deps.nativeImage, "attachmentGateway.nativeImage");
  requireFunction(deps.nativeImage.createFromDataURL, "attachmentGateway.nativeImage.createFromDataURL");
  for (const method of REQUIRED_FUNCTIONS) requireFunction(deps[method], `attachmentGateway.${method}`);
  if (typeof deps.downloadsDir !== "string" || deps.downloadsDir.length === 0) throw new TypeError("Missing Electron production adapter port: attachmentGateway.downloadsDir.");
  if (!Number.isSafeInteger(deps.previewByteCap) || deps.previewByteCap <= 0) throw new TypeError("Invalid Electron production adapter port: attachmentGateway.previewByteCap.");
  return deps;
}

/** Artifact anchor: main.cjs:506233, `attachments: createAttachmentEdgePort({`. */
export function createProductionAttachmentGatewayAdapter(
  ports: ProductionAttachmentGatewayPorts,
): ElectronProductionAdapterBindings["attachmentGateway"] {
  requireFunction(ports?.resolveDeps, "attachmentGateway.resolveDeps");
  return {
    create(context) {
      return createAttachmentEdgePort(validateAttachmentDeps(ports.resolveDeps(context)));
    },
  };
}

/**
 * Exact main.cjs:506233 collaborator join. Telemetry is intentionally read
 * lazily because the emitted attachment edge is constructed before telemetry.
 */
export function createProductionAttachmentGatewayBinding(
  electron: ElectronAttachmentGatewayCompositionPorts,
): ElectronProductionAdapterBindings["attachmentGateway"] {
  requireFunction(electron?.app?.getPath, "attachmentGateway.electron.app.getPath");
  if (typeof electron?.BrowserWindow !== "function") {
    throw new TypeError("Missing Electron production adapter port: attachmentGateway.electron.BrowserWindow.");
  }
  requireFunction(electron?.dialog?.showSaveDialog, "attachmentGateway.electron.dialog.showSaveDialog");
  requireFunction(electron?.dialog?.showMessageBox, "attachmentGateway.electron.dialog.showMessageBox");
  requireFunction(electron?.nativeImage?.createFromBuffer, "attachmentGateway.electron.nativeImage.createFromBuffer");
  requireFunction(electron?.nativeImage?.createFromDataURL, "attachmentGateway.electron.nativeImage.createFromDataURL");
  return createProductionAttachmentGatewayAdapter({
    resolveDeps(context) {
      const legs = context.coordinatorLegs.legs as unknown as AttachmentLegs;
      return {
        legs,
        getMainWindow: context.getMainWindow,
        onEdgeFailure: (failure) => {
          context.readTelemetry()?.telemetry.reportAttachmentEdgeFailure?.(failure);
        },
        videoMimeFromPath: (path) => videoMimeFromPath(path) ?? null,
        audioMimeFromPath: (path) => audioMimeFromPath(path) ?? null,
        displayableImageMimeFromPath: (path) => imageMimeFromPath(path) ?? null,
        buildMediaUrl: buildSandMediaUrl,
        resolveImage: (path, readRemote) => resolveImageAttachment(path, readRemote, {
          nativeImage: electron.nativeImage,
          readPortableDimensions: (buffer) => readWebpOrHeicDimensions(buffer),
          servableImageMimeFromPath: (value) => servableImageMimeFromPath(value) ?? null,
        }),
        fetchLinkMetadata: ({ cacheDir, url }) => fetchLinkMetadata(cacheDir, url),
        boundPreviewImage: (dataUrl, target, resize) => boundPreviewImageDataUrl(
          dataUrl ?? null,
          target,
          (value, dimensions, encoding) => resize(
            value,
            dimensions,
            encoding === "jpeg" ? "jpeg" : "png",
          ),
        ),
        nativeImage: electron.nativeImage,
        getUserDataDir: () => electron.app.getPath("userData"),
        downloadsDir: electron.app.getPath("downloads"),
        previewKindNeedsBytes: (kind) => previewKindNeedsBytes(kind as FilePreviewKind),
        getFilePreviewKind,
        previewByteCap: ATTACHMENT_PREVIEW_BYTE_CAP,
        byteLimitForName: attachmentByteLimitForName,
        getStagingDir: getDesktopAttachmentStagingDir,
        isWithinStagingDir: isWithinDesktopAttachmentStaging,
        resolveSuggestedDownloadName,
        resolveDefaultDownloadPath,
        showSaveDialog: (window, options) => electron.dialog.showSaveDialog(window, options),
        createHiddenWindow: (options) => new electron.BrowserWindow(options),
        showErrorMessage: async (window, options) => {
          if (window == null) await electron.dialog.showMessageBox(options);
          else await electron.dialog.showMessageBox(window, options);
        },
      };
    },
  });
}

/** Manifest-call export: all remaining ports come from the real Electron ABI. */
export function createElectronProductionAttachmentGatewayBinding(): ElectronProductionAdapterBindings["attachmentGateway"] {
  return createProductionAttachmentGatewayBinding(require("electron") as ElectronAttachmentGatewayCompositionPorts);
}
