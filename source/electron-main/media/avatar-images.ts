import { promises as fs } from "node:fs";
import { basename, extname } from "node:path";
import { isHttpExternalUrl } from "../../shared/external-url-policy.js";
export const MAX_AVATAR_DECODE_DIMENSION = 4_096, AVATAR_CROP_SOURCE_MAX_DIMENSION = 1_024, AVATAR_SOURCE_MAX_BYTES = 25 * 1024 * 1024;
export class AvatarInputError extends Error { constructor(message: string) { super(message); this.name = "AvatarInputError"; } }
const IMAGE_MIME_EXTENSIONS = new Map([["image/png", "png"], ["image/jpeg", "jpg"], ["image/jpg", "jpg"], ["image/gif", "gif"], ["image/webp", "webp"], ["image/svg+xml", "svg"], ["image/bmp", "bmp"], ["image/avif", "avif"]]);
const AVATAR_EXTENSION_MIME = new Map([[".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".webp", "image/webp"], [".gif", "image/gif"], [".bmp", "image/bmp"], [".avif", "image/avif"], [".svg", "image/svg+xml"]]);
export const extensionForImageMime = (mime: string): string => IMAGE_MIME_EXTENSIONS.get(mime.toLowerCase()) ?? "png";
export const avatarMimeHintForExtension = (extension: string): string => AVATAR_EXTENSION_MIME.get(extension.toLowerCase()) ?? "application/octet-stream";
export const avatarSourceSizeError = (byteLength: number): string | null => byteLength > AVATAR_SOURCE_MAX_BYTES ? "Choose an image smaller than 25 MB." : null;
export function decodeImageDataUrl(dataUrl: string): { mime: string; bytes: Buffer } | null { const comma = dataUrl.indexOf(","); if (comma === -1) return null; const header = dataUrl.slice("data:".length, comma), payload = dataUrl.slice(comma + 1), base64 = header.endsWith(";base64"), mime = (base64 ? header.slice(0, -7) : header).split(";")[0] || "image/png"; try { const bytes = base64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8"); return bytes.byteLength === 0 ? null : { mime, bytes }; } catch { return null; } }
export interface NativeImagePort { isEmpty(): boolean; getSize(): { width: number; height: number }; resize(options: { width: number; height: number; quality: "best" }): NativeImagePort; toPNG(): Buffer }
export interface AvatarImageDialogOptions { readonly title: string; readonly properties: readonly ["openFile"]; readonly filters: readonly [{ readonly name: "Images"; readonly extensions: readonly ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }]; }
export interface AvatarImageDeps { getMainWindow(): { isDestroyed(): boolean; webContents: { executeJavaScript(script: string, userGesture: boolean): Promise<unknown> } } | null; createHiddenWindow(options: { readonly show: false }): unknown; showOpenDialog(window: unknown, options: AvatarImageDialogOptions): Promise<{ canceled: boolean; filePaths: readonly string[] }>; createFromPath(path: string): NativeImagePort; createFromBuffer(bytes: Buffer): NativeImagePort; generate(description: string): Promise<{ imageData: string; mimeType: string }>; onEdgeFailure(failure: { leg: string; errorClass: string }): void }
const errorClass = (error: unknown): string => error instanceof Error && error.name.length > 0 ? error.name : typeof error;
export function avatarSourceDataUrl(image: NativeImagePort): string { const { width, height } = image.getSize(), longest = Math.max(width, height); const sized = longest > AVATAR_CROP_SOURCE_MAX_DIMENSION ? image.resize({ width: Math.max(1, Math.round(width / longest * AVATAR_CROP_SOURCE_MAX_DIMENSION)), height: Math.max(1, Math.round(height / longest * AVATAR_CROP_SOURCE_MAX_DIMENSION)), quality: "best" }) : image; return `data:image/png;base64,${sized.toPNG().toString("base64")}`; }
export function createAvatarImageEdgePort(deps: AvatarImageDeps) { const report = (leg: string, error: unknown) => deps.onEdgeFailure({ leg, errorClass: errorClass(error) }); const decodeWithChromium = async (sourcePath: string): Promise<NativeImagePort | null> => { const window = deps.getMainWindow(); if (window == null || window.isDestroyed()) return null; let bytes: Buffer; try { bytes = await fs.readFile(sourcePath); } catch (error) { report("decode-read", error); return null; } if (bytes.byteLength === 0 || avatarSourceSizeError(bytes.byteLength) != null) return null; const dataUrl = `data:${avatarMimeHintForExtension(extname(sourcePath))};base64,${bytes.toString("base64")}`; let result: unknown; try { result = await window.webContents.executeJavaScript(`(async()=>{try{const image=new Image();image.src=${JSON.stringify(dataUrl)};await image.decode();const naturalWidth=image.naturalWidth,naturalHeight=image.naturalHeight;if(naturalWidth<=0||naturalHeight<=0)return null;const scale=Math.min(1,${MAX_AVATAR_DECODE_DIMENSION}/Math.max(naturalWidth,naturalHeight)),width=Math.max(1,Math.round(naturalWidth*scale)),height=Math.max(1,Math.round(naturalHeight*scale)),canvas=document.createElement("canvas");canvas.width=width;canvas.height=height;const context=canvas.getContext("2d");if(context==null)return null;context.drawImage(image,0,0,width,height);return canvas.toDataURL("image/png")}catch{return null}})()`, true); } catch (error) { report("decode-render", error); return null; } if (typeof result !== "string") return null; const decoded = decodeImageDataUrl(result); if (decoded == null) return null; const image = deps.createFromBuffer(decoded.bytes); return image.isEmpty() ? null : image; }; const load = async (path: string): Promise<NativeImagePort> => { let image = deps.createFromPath(path); if (image.isEmpty()) image = await decodeWithChromium(path) ?? image; if (image.isEmpty()) throw new AvatarInputError("Selected file is not a valid image."); return image; }; const pickFile = async () => { const result = await deps.showOpenDialog(deps.getMainWindow() ?? deps.createHiddenWindow({ show: false }), { title: "Choose an avatar image", properties: ["openFile"], filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }] }); if (result.canceled || result.filePaths.length === 0) return null; const path = result.filePaths[0]; if (path == null) return null; return { dataUrl: avatarSourceDataUrl(await load(path)), fileName: basename(path) }; }; return { pickSource: async () => (await pickFile())?.dataUrl ?? null, pickFile, generateImage: async (description: unknown) => { if (typeof description !== "string" || description.trim().length === 0) throw new AvatarInputError("Describe the avatar to generate first."); const generated = await deps.generate(description.trim()), image = deps.createFromBuffer(Buffer.from(generated.imageData, "base64")); return image.isEmpty() ? `data:${generated.mimeType};base64,${generated.imageData}` : avatarSourceDataUrl(image); } }; }
export interface ImageContextActions { copyImage(): void; saveImage(): Promise<void>; copyImageAddress?(): void }
export function createImageContextActions(options: { srcUrl: string; copyDataImage(bytes: Buffer): boolean; copyImageAt(): void; fetch(url: string): Promise<Response>; save(bytes: Buffer, defaultName: string): Promise<void>; copyText(text: string): void }): ImageContextActions { return { copyImage() { if (options.srcUrl.startsWith("data:")) { const decoded = decodeImageDataUrl(options.srcUrl); if (decoded != null && options.copyDataImage(decoded.bytes)) return; } options.copyImageAt(); }, async saveImage() { let mime: string, bytes: Buffer; if (options.srcUrl.startsWith("data:")) { const decoded = decodeImageDataUrl(options.srcUrl); if (decoded == null) return; ({ mime, bytes } = decoded); } else { let url: URL; try { url = new URL(options.srcUrl); } catch { return; } if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "sand-media:") return; const response = await options.fetch(options.srcUrl); if (!response.ok) return; bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length === 0) return; mime = response.headers.get("content-type")?.split(";")[0]?.trim() || "image/png"; } await options.save(bytes, `image.${extensionForImageMime(mime)}`); }, ...(options.srcUrl.length === 0 ? {} : { copyImageAddress: () => options.copyText(options.srcUrl) }) }; }

export interface ImageContextMenuParams { srcURL: string; linkURL: string; mediaType: string; selectionText: string; isEditable: boolean; editFlags: Record<string, boolean>; x: number; y: number }
export interface ImageContextMenuItem { label?: string; type?: "separator"; accelerator?: string; enabled?: boolean; click?: () => void }
export function buildImageContextMenuTemplate(contents: { copyImageAt(x: number, y: number): void; undo(): void; redo(): void; cut(): void; copy(): void; paste(): void; selectAll(): void }, params: ImageContextMenuParams, deps: { openExternalUrl(url: string): Promise<unknown>; copyText(text: string): void; imageActions: ImageContextActions }): ImageContextMenuItem[] {
  const sections: ImageContextMenuItem[][] = [];
  if (params.linkURL.length > 0) sections.push([{ label: "Open link", click: () => { void deps.openExternalUrl(params.linkURL); } }, { label: "Copy link address", click: () => deps.copyText(params.linkURL) }]);
  if (params.mediaType === "image") { const items: ImageContextMenuItem[] = [{ label: "Copy image", click: deps.imageActions.copyImage }, { label: "Save image…", click: () => { void deps.imageActions.saveImage(); } }]; if (params.srcURL.length > 0 && deps.imageActions.copyImageAddress != null) items.push({ label: "Copy image address", click: deps.imageActions.copyImageAddress }); sections.push(items); }
  if (params.isEditable) sections.push([{ label: "Undo", accelerator: "CmdOrCtrl+Z", enabled: params.editFlags.canUndo === true, click: () => contents.undo() }, { label: "Redo", accelerator: "Shift+CmdOrCtrl+Z", enabled: params.editFlags.canRedo === true, click: () => contents.redo() }, { label: "Cut", accelerator: "CmdOrCtrl+X", enabled: params.editFlags.canCut === true, click: () => contents.cut() }, { label: "Copy", accelerator: "CmdOrCtrl+C", enabled: params.editFlags.canCopy === true, click: () => contents.copy() }, { label: "Paste", accelerator: "CmdOrCtrl+V", enabled: params.editFlags.canPaste === true, click: () => contents.paste() }, { label: "Select All", accelerator: "CmdOrCtrl+A", enabled: params.editFlags.canSelectAll === true, click: () => contents.selectAll() }]); else if (params.selectionText.length > 0) sections.push([{ label: "Copy", accelerator: "CmdOrCtrl+C", click: () => contents.copy() }]);
  return sections.flatMap((section, index) => index === 0 ? section : [{ type: "separator" as const }, ...section]);
}
export interface ImageContextMenuNativeImage {
  isEmpty(): boolean;
  toPNG(): Buffer;
}

export interface ImageContextMenuResponse {
  readonly ok: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
  readonly headers: { get(name: string): string | null };
}

export interface ImageContextMenuContents {
  getType(): string;
  on(event: "context-menu", listener: (event: unknown, params: ImageContextMenuParams) => void): void;
  copyImageAt(x: number, y: number): void;
  undo(): void;
  redo(): void;
  cut(): void;
  copy(): void;
  paste(): void;
  selectAll(): void;
  readonly session: { fetch(url: string): Promise<ImageContextMenuResponse> };
}

export interface ImageContextMenuElectronPorts {
  readonly app: { on(event: "web-contents-created", listener: (event: unknown, contents: ImageContextMenuContents) => void): void };
  readonly BrowserWindow: { fromWebContents(contents: ImageContextMenuContents): unknown };
  readonly clipboard: {
    writeImage(image: ImageContextMenuNativeImage): void;
    readImage(): ImageContextMenuNativeImage;
    writeText(text: string): void;
  };
  readonly dialog: {
    showSaveDialog(window: unknown, options: { readonly defaultPath: string; readonly filters: readonly [{ readonly name: "Images"; readonly extensions: readonly ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"] }] }): Promise<{ readonly canceled: boolean; readonly filePath?: string }>;
  };
  readonly Menu: new() => {
    readonly items: readonly unknown[];
    append(item: unknown): void;
    popup(options: { readonly window?: unknown }): void;
  };
  readonly MenuItem: new(options: { readonly label?: string; readonly type?: "separator"; readonly accelerator?: string; readonly enabled?: boolean; readonly click?: () => void }) => unknown;
  readonly nativeImage: { createFromDataURL(dataUrl: string): ImageContextMenuNativeImage };
  readonly writeFile: (path: string, bytes: Buffer) => Promise<void>;
  readonly openExternalUrl: (url: string) => Promise<unknown>;
  readonly onEdgeFailure: (failure: { readonly leg: string; readonly errorClass: string }) => void;
}

/** Exact immutable image context-menu registration at main.cjs:498143-498309. */
export function registerImageContextMenu(deps: ImageContextMenuElectronPorts): void {
  const reportEdgeFailure = (leg: string, error: unknown): void => {
    deps.onEdgeFailure({ leg, errorClass: errorClass(error) });
  };
  const copyImageFromContextMenu = (contents: ImageContextMenuContents, params: ImageContextMenuParams): void => {
    if (params.srcURL.startsWith("data:")) {
      const image = deps.nativeImage.createFromDataURL(params.srcURL);
      if (!image.isEmpty()) {
        deps.clipboard.writeImage(image);
        return;
      }
    }
    contents.copyImageAt(params.x, params.y);
  };
  const saveImageFromContextMenu = async (contents: ImageContextMenuContents, params: ImageContextMenuParams): Promise<void> => {
    try {
      const srcUrl = params.srcURL;
      let mime: string;
      let bytes: Buffer;
      if (srcUrl.startsWith("data:")) {
        const decoded = decodeImageDataUrl(srcUrl);
        if (decoded == null) return;
        mime = decoded.mime;
        bytes = decoded.bytes;
      } else if (isHttpExternalUrl(srcUrl)) {
        const response = await contents.session.fetch(srcUrl);
        if (!response.ok) return;
        bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.byteLength === 0) return;
        mime = response.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
      } else {
        contents.copyImageAt(params.x, params.y);
        const image = deps.clipboard.readImage();
        if (image.isEmpty()) return;
        bytes = image.toPNG();
        mime = "image/png";
      }
      const extension = extensionForImageMime(mime);
      const owner = deps.BrowserWindow.fromWebContents(contents) ?? undefined;
      const result = await deps.dialog.showSaveDialog(owner, {
        defaultPath: `image.${extension}`,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"] }],
      });
      if (result.canceled || result.filePath == null || result.filePath.length === 0) return;
      await deps.writeFile(result.filePath, bytes);
    } catch (error) {
      reportEdgeFailure("save", error);
    }
  };
  const buildImageContextMenu = (contents: ImageContextMenuContents, params: ImageContextMenuParams): { readonly items: readonly unknown[]; append(item: unknown): void; popup(options: { readonly window?: unknown }): void } => {
    const menu = new deps.Menu();
    const sections: unknown[][] = [];
    const linkUrl = params.linkURL;
    const hasLink = linkUrl.length > 0;
    const mediaUrl = params.srcURL;
    const hasImage = params.mediaType === "image";
    if (hasLink) {
      sections.push([
        new deps.MenuItem({ label: "Open link", click: () => void deps.openExternalUrl(linkUrl) }),
        new deps.MenuItem({ label: "Copy link address", click: () => deps.clipboard.writeText(linkUrl) }),
      ]);
    }
    if (hasImage) {
      const imageItems: unknown[] = [
        new deps.MenuItem({ label: "Copy image", click: () => copyImageFromContextMenu(contents, params) }),
        new deps.MenuItem({ label: "Save image…", click: () => void saveImageFromContextMenu(contents, params) }),
      ];
      if (mediaUrl.length > 0) imageItems.push(new deps.MenuItem({ label: "Copy image address", click: () => deps.clipboard.writeText(mediaUrl) }));
      sections.push(imageItems);
    }
    if (params.isEditable) {
      sections.push([
        new deps.MenuItem({ label: "Undo", accelerator: "CmdOrCtrl+Z", enabled: params.editFlags.canUndo === true, click: () => contents.undo() }),
        new deps.MenuItem({ label: "Redo", accelerator: "Shift+CmdOrCtrl+Z", enabled: params.editFlags.canRedo === true, click: () => contents.redo() }),
        new deps.MenuItem({ label: "Cut", accelerator: "CmdOrCtrl+X", enabled: params.editFlags.canCut === true, click: () => contents.cut() }),
        new deps.MenuItem({ label: "Copy", accelerator: "CmdOrCtrl+C", enabled: params.editFlags.canCopy === true, click: () => contents.copy() }),
        new deps.MenuItem({ label: "Paste", accelerator: "CmdOrCtrl+V", enabled: params.editFlags.canPaste === true, click: () => contents.paste() }),
        new deps.MenuItem({ label: "Select All", accelerator: "CmdOrCtrl+A", enabled: params.editFlags.canSelectAll === true, click: () => contents.selectAll() }),
      ]);
    } else if (params.selectionText.length > 0) {
      sections.push([new deps.MenuItem({ label: "Copy", accelerator: "CmdOrCtrl+C", click: () => contents.copy() })]);
    }
    for (let index = 0; index < sections.length; index += 1) {
      if (index > 0) menu.append(new deps.MenuItem({ type: "separator" }));
      for (const item of sections[index] ?? []) menu.append(item);
    }
    return menu;
  };
  deps.app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() !== "window") return;
    contents.on("context-menu", (_event, params) => {
      const menu = buildImageContextMenu(contents, params);
      if (menu.items.length === 0) return;
      const owner = deps.BrowserWindow.fromWebContents(contents) ?? undefined;
      menu.popup({ window: owner });
    });
  });
}
