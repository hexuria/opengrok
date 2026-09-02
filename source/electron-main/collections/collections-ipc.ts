/**
 * Collections IPC: the guarded channels the Collections page talks to, plus the
 * share/bookmark entry point the app window reaches through the main edge.
 *
 * Snapshotting deliberately uses only transcript reads the stock app already
 * performs against the box gateway. Agents can live on Cursor's remote box,
 * whose in-box gateway is Cursor's own build and rejects any method it does not
 * already implement, so a bespoke "fetch these entry ids" call is impossible.
 * Instead this pages backwards through `getAgentTranscriptWindow` - the exact
 * read the transcript UI uses - and filters to the requested ids here.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

import {
  buildCollectionDeepLinkUrl,
  buildSandMessageDeepLinkUrl,
} from "../../shared/deep-link.js";
import { parseCoordinatorTranscriptWindowResponse } from "../../shared/rpc/coordinator.js";
import { buildSandMediaUrl, handleSandMediaRequest } from "../media/media-protocol.js";
import { reportDesktopEdgeFailure } from "../desktop-edge-failures.js";
import type { ProductionServiceContext } from "../main-production-services.js";
import {
  CollectionsError,
  SandCollectionsStore,
  buildCollectionHtmlExport,
  buildCollectionJsonExport,
  collectEntryMedia,
  isCollectionId,
  materializeImportedMessages,
  parseCollectionImport,
  type CollectionMediaBytes,
  type CollectionMediaReader,
  type CollectionMessageInput,
  type CollectionSummary,
} from "./collections-store.js";
import {
  COLLECTIONS_NAVIGATE_CHANNEL,
  electronCollectionsWindowPort,
  getCollectionsWindowContents,
  openCollectionsWindow,
  takePendingCollectionId,
} from "./collections-window.js";

export const COLLECTIONS_CHANNELS = {
  list: "sand:collections-list",
  get: "sand:collections-get",
  rename: "sand:collections-rename",
  delete: "sand:collections-delete",
  removeMessages: "sand:collections-remove-messages",
  addMessages: "sand:collections-add-messages",
  exportHtml: "sand:collections-export-html",
  exportJson: "sand:collections-export-json",
  exportPdf: "sand:collections-export-pdf",
  importJson: "sand:collections-import-json",
  openOriginal: "sand:collections-open-original",
} as const;

/** A defensive ceiling on backwards paging; a transcript is not infinite. */
export const COLLECTIONS_TRANSCRIPT_MAX_PAGES = 50;
export const COLLECTIONS_TRANSCRIPT_PAGE_LIMIT = 200;
export const COLLECTIONS_MAX_SHARE_ENTRIES = 500;
export const COLLECTIONS_MEDIA_DIR = "collections-media";

export const UNTRUSTED_COLLECTIONS_SENDER_MESSAGE = "Collections are only accessible from the Collections window.";

export class UntrustedCollectionsSenderError extends Error {
  constructor() { super(UNTRUSTED_COLLECTIONS_SENDER_MESSAGE); this.name = "UntrustedCollectionsSenderError"; }
}

export interface CollectionsIpcMain {
  handle(channel: string, listener: (event: any, request: any) => unknown): void;
}

export interface CollectionsSaveDialogResult { readonly canceled: boolean; readonly filePath?: string | undefined }
export interface CollectionsOpenDialogResult { readonly canceled: boolean; readonly filePaths?: readonly string[] | undefined }

export interface CollectionsIpcDeps {
  readonly ipcMain: CollectionsIpcMain;
  readonly store: SandCollectionsStore;
  /** Stock windowed transcript read; never a new gateway method. */
  readonly readTranscriptWindow: (request: { readonly id: string; readonly limit: number; readonly beforeSeq?: number }) => Promise<unknown>;
  readonly listAgents: () => Promise<unknown>;
  readonly readMedia: CollectionMediaReader;
  readonly writeImportedMedia: (collectionId: string, relPath: string, bytes: Uint8Array) => Promise<string>;
  readonly showSaveDialog: (options: { readonly defaultPath: string; readonly filters: readonly { name: string; extensions: string[] }[] }) => Promise<CollectionsSaveDialogResult>;
  readonly showOpenDialog: (options: { readonly filters: readonly { name: string; extensions: string[] }[] }) => Promise<CollectionsOpenDialogResult>;
  readonly writeTextFile: (path: string, data: string) => Promise<void>;
  readonly writeBinaryFile?: (path: string, data: Uint8Array) => Promise<void>;
  /** Prints one self-contained HTML document to PDF bytes; absent where printing is not wired. */
  readonly printHtmlToPdf?: (html: string) => Promise<Uint8Array>;
  readonly readTextFile: (path: string) => Promise<string>;
  readonly openWindow: (collectionId?: string) => void;
  readonly getTrustedContents: () => { readonly mainFrame?: unknown } | null | undefined;
  readonly dispatchDeepLink: (url: string) => void;
  readonly now?: () => number;
  readonly reportFailure?: (leg: string, error: unknown) => void;
}

export interface CollectionsService {
  addMessagesFromApp(request: unknown): Promise<{ readonly collectionId: string; readonly name: string; readonly added: number; readonly duplicates: number; readonly dropped: number; readonly missing: number }>;
  listCollectionsFromApp(): Promise<{ readonly collections: CollectionSummary[] }>;
}

let activeService: CollectionsService | null = null;

/**
 * The share/bookmark call arrives on the main edge from the app window, which
 * is a different (already trusted) sender than the Collections window, so it
 * reaches the same logic through this holder rather than the guarded channels.
 */
export function addCollectionMessagesFromApp(request: unknown): Promise<unknown> {
  if (activeService == null) return Promise.reject(new CollectionsError("Collections are not available yet."));
  return activeService.addMessagesFromApp(request);
}

/** The share picker in the app window lists collections through the same holder. */
export function listCollectionsFromApp(): Promise<unknown> {
  if (activeService == null) return Promise.reject(new CollectionsError("Collections are not available yet."));
  return activeService.listCollectionsFromApp();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The window says which theme it is showing; anything else exports light. */
function themeField(request: unknown): "dark" | "light" {
  const value = typeof request === "object" && request != null ? (request as Record<string, unknown>).theme : undefined;
  return value === "dark" ? "dark" : "light";
}

function stringField(request: unknown, name: string): string {
  if (!isRecord(request)) return "";
  const value = request[name];
  return typeof value === "string" ? value : "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

export function assertTrustedCollectionsSender(context: {
  readonly sender: unknown;
  readonly senderFrame: unknown;
  readonly trustedContents: unknown;
}): void {
  const trusted = context.trustedContents;
  const trustedFrame = trusted == null ? null : Reflect.get(trusted as object, "mainFrame") ?? null;
  if (trusted == null || trustedFrame == null || context.sender !== trusted || context.senderFrame !== trustedFrame) {
    throw new UntrustedCollectionsSenderError();
  }
}

/** Resolves display names from the roster main can already reach; ids are the fallback. */
async function agentNames(deps: CollectionsIpcDeps): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const roster = await deps.listAgents();
    if (Array.isArray(roster)) for (const raw of roster) {
      if (!isRecord(raw) || typeof raw.id !== "string") continue;
      const name = typeof raw.name === "string" && raw.name.trim().length > 0 ? raw.name.trim() : null;
      if (name != null) names.set(raw.id, name);
    }
  } catch (error) { deps.reportFailure?.("list-agents", error); }
  return names;
}

/**
 * Pages backwards through the stock windowed transcript read until every
 * requested id is found or the transcript runs out.
 */
export async function snapshotTranscriptEntries(
  deps: Pick<CollectionsIpcDeps, "readTranscriptWindow" | "reportFailure">,
  agentId: string,
  entryIds: readonly string[],
): Promise<Map<string, Record<string, unknown>>> {
  const wanted = new Set(entryIds);
  const found = new Map<string, Record<string, unknown>>();
  let beforeSeq: number | undefined;
  for (let page = 0; page < COLLECTIONS_TRANSCRIPT_MAX_PAGES && wanted.size > 0; page += 1) {
    let reply: unknown;
    try {
      reply = await deps.readTranscriptWindow({
        id: agentId,
        limit: COLLECTIONS_TRANSCRIPT_PAGE_LIMIT,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
      });
    } catch (error) {
      deps.reportFailure?.("transcript-window", error);
      break;
    }
    const parsed = parseCoordinatorTranscriptWindowResponse(reply);
    if (parsed == null) break;
    for (const entry of parsed.entries) {
      if (wanted.delete(entry.id)) found.set(entry.id, entry as unknown as Record<string, unknown>);
    }
    if (parsed.nextBeforeSeq === undefined || parsed.entries.length === 0) break;
    beforeSeq = parsed.nextBeforeSeq;
  }
  return found;
}

function createService(deps: CollectionsIpcDeps): CollectionsService {
  return {
    async addMessagesFromApp(request: unknown) {
      const agentId = stringField(request, "agentId");
      const entryIds = [...new Set(stringList(isRecord(request) ? request.entryIds : null))].slice(0, COLLECTIONS_MAX_SHARE_ENTRIES);
      if (agentId.length === 0 || entryIds.length === 0) throw new CollectionsError("Select at least one message first.");
      const requestedId = stringField(request, "collectionId");
      const collectionId = isCollectionId(requestedId) ? requestedId : null;
      const [entries, names] = await Promise.all([
        snapshotTranscriptEntries(deps, agentId, entryIds),
        agentNames(deps),
      ]);
      const agentName = names.get(agentId) ?? agentId.slice(0, 8);
      const messages: CollectionMessageInput[] = [];
      for (const entryId of entryIds) {
        const entry = entries.get(entryId);
        if (entry == null) continue;
        messages.push({ agentId, agentName, entryId, entry, media: collectEntryMedia(entry) });
      }
      if (messages.length === 0) throw new CollectionsError("Those messages are no longer in the transcript.");
      const result = await deps.store.addMessages({
        collectionId,
        name: stringField(request, "name"),
        messages,
      });
      deps.openWindow(result.collectionId);
      return { ...result, missing: entryIds.length - messages.length };
    },
    async listCollectionsFromApp() {
      return { collections: await deps.store.listCollections() };
    },
  };
}

function exportTimestampFormatter(): (timestampMs: number | undefined) => string {
  const format = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
  return (timestampMs) => (timestampMs == null || !Number.isFinite(timestampMs) ? "" : format.format(new Date(timestampMs)));
}

function safeFileName(name: string): string {
  const trimmed = name.replace(/[^A-Za-z0-9 ._-]/g, "_").trim();
  return trimmed.length === 0 ? "collection" : trimmed.slice(0, 80);
}

export function registerCollectionsIpc(deps: CollectionsIpcDeps): { dispose(): void } {
  const now = deps.now ?? Date.now;
  const service = createService(deps);
  activeService = service;
  const guard = (event: { readonly sender: unknown; readonly senderFrame: unknown }): void => {
    assertTrustedCollectionsSender({ sender: event.sender, senderFrame: event.senderFrame, trustedContents: deps.getTrustedContents() ?? null });
  };
  const requireDocument = async (collectionId: string) => {
    const document = await deps.store.getCollection(collectionId);
    if (document == null) throw new CollectionsError("Unknown collection.");
    return document;
  };

  deps.ipcMain.handle(COLLECTIONS_CHANNELS.list, async (event) => {
    guard(event);
    const collections: CollectionSummary[] = await deps.store.listCollections();
    return { collections, selected: takePendingCollectionId() };
  });
  deps.ipcMain.handle(COLLECTIONS_CHANNELS.get, async (event, request) => {
    guard(event);
    return deps.store.getCollection(stringField(request, "collectionId"));
  });
  deps.ipcMain.handle(COLLECTIONS_CHANNELS.rename, async (event, request) => {
    guard(event);
    return deps.store.renameCollection(stringField(request, "collectionId"), stringField(request, "name"));
  });
  deps.ipcMain.handle(COLLECTIONS_CHANNELS.delete, async (event, request) => {
    guard(event);
    await deps.store.deleteCollection(stringField(request, "collectionId"));
    return { collections: await deps.store.listCollections() };
  });
  deps.ipcMain.handle(COLLECTIONS_CHANNELS.removeMessages, async (event, request) => {
    guard(event);
    return deps.store.removeMessages(stringField(request, "collectionId"), stringList(isRecord(request) ? request.keys : null));
  });
  deps.ipcMain.handle(COLLECTIONS_CHANNELS.addMessages, async (event, request) => {
    guard(event);
    return service.addMessagesFromApp(request);
  });
  deps.ipcMain.handle(COLLECTIONS_CHANNELS.exportHtml, async (event, request) => {
    guard(event);
    const document = await requireDocument(stringField(request, "collectionId"));
    const chosen = await deps.showSaveDialog({
      defaultPath: `${safeFileName(document.name)}.html`,
      filters: [{ name: "HTML", extensions: ["html"] }],
    });
    if (chosen.canceled || chosen.filePath == null || chosen.filePath.length === 0) return { saved: false };
    const nowMs = now();
    const exported = await buildCollectionHtmlExport({
      document,
      readMedia: deps.readMedia,
      permalink: buildCollectionDeepLinkUrl(document.id),
      exportedAt: exportTimestampFormatter()(nowMs),
      formatTimestamp: exportTimestampFormatter(),
      theme: themeField(request),
    });
    await deps.writeTextFile(chosen.filePath, exported.html);
    return { saved: true, path: chosen.filePath, embedded: exported.embedded, skipped: exported.skipped };
  });
  deps.ipcMain.handle(COLLECTIONS_CHANNELS.exportJson, async (event, request) => {
    guard(event);
    const document = await requireDocument(stringField(request, "collectionId"));
    const chosen = await deps.showSaveDialog({
      defaultPath: `${safeFileName(document.name)}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (chosen.canceled || chosen.filePath == null || chosen.filePath.length === 0) return { saved: false };
    const payload = await buildCollectionJsonExport(document, deps.readMedia, now());
    await deps.writeTextFile(chosen.filePath, JSON.stringify(payload));
    return { saved: true, path: chosen.filePath };
  });
  // PDF is the HTML export, printed. One document, one renderer, one palette: whatever the
  // window was showing when the person pressed Export goes into the file, because a printed
  // page has no reader to ask what it prefers.
  deps.ipcMain.handle(COLLECTIONS_CHANNELS.exportPdf, async (event, request) => {
    guard(event);
    const print = deps.printHtmlToPdf;
    const writeBinary = deps.writeBinaryFile;
    if (print == null || writeBinary == null) return { saved: false, error: "Printing is not available in this build." };
    const document = await requireDocument(stringField(request, "collectionId"));
    const chosen = await deps.showSaveDialog({
      defaultPath: `${safeFileName(document.name)}.pdf`,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (chosen.canceled || chosen.filePath == null || chosen.filePath.length === 0) return { saved: false };
    const nowMs = now();
    const exported = await buildCollectionHtmlExport({
      document,
      readMedia: deps.readMedia,
      permalink: buildCollectionDeepLinkUrl(document.id),
      exportedAt: exportTimestampFormatter()(nowMs),
      formatTimestamp: exportTimestampFormatter(),
      theme: themeField(request),
    });
    await writeBinary(chosen.filePath, await print(exported.html));
    return { saved: true, path: chosen.filePath, embedded: exported.embedded, skipped: exported.skipped };
  });
  deps.ipcMain.handle(COLLECTIONS_CHANNELS.importJson, async (event) => {
    guard(event);
    const chosen = await deps.showOpenDialog({ filters: [{ name: "JSON", extensions: ["json"] }] });
    const path = chosen.filePaths?.[0];
    if (chosen.canceled || path == null) return { imported: false };
    const parsed = parseCollectionImport(await deps.readTextFile(path));
    const nowMs = now();
    const summary = await deps.store.importDocument({
      name: parsed.name,
      createdAtMs: parsed.createdAtMs,
      preferredId: parsed.id,
      materialize: (collectionId) => materializeImportedMessages(parsed, collectionId, deps.writeImportedMedia, nowMs),
    });
    return { imported: true, collection: summary, collections: await deps.store.listCollections() };
  });
  deps.ipcMain.handle(COLLECTIONS_CHANNELS.openOriginal, async (event, request) => {
    guard(event);
    const agentId = stringField(request, "agentId");
    const entryId = stringField(request, "entryId");
    if (agentId.length === 0 || entryId.length === 0) return { opened: false };
    deps.dispatchDeepLink(buildSandMessageDeepLinkUrl(agentId, entryId));
    return { opened: true };
  });

  return {
    dispose() { if (activeService === service) activeService = null; },
  };
}

/* ------------------------------------------------------- production wiring */

/** Serves media through the existing sand-media handler, so remote box paths resolve too. */
export async function readCollectionMedia(srcPath: string, maxBytes?: number): Promise<CollectionMediaBytes | null> {
  let response: Response;
  try { response = await handleSandMediaRequest(new Request(buildSandMediaUrl(srcPath))); }
  catch { return null; }
  if (!response.ok) return null;
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (maxBytes != null && Number.isFinite(declared) && declared > maxBytes) return null;
  const buffer = await response.arrayBuffer();
  if (maxBytes != null && buffer.byteLength > maxBytes) return null;
  return { bytes: new Uint8Array(buffer), mime: response.headers.get("content-type") ?? "application/octet-stream" };
}

export function createProductionCollectionsIpcRegistrar(): (
  context: ProductionServiceContext,
  ipc: CollectionsIpcMain,
) => { dispose(): void } {
  return (context, ipc) => {
    const mediaRoot = join(context.native.app.getPath("userData"), COLLECTIONS_MEDIA_DIR);
    const store = new SandCollectionsStore(context.secretsStores.clientPersistenceStore);
    const openWindow = (collectionId?: string): void => {
      openCollectionsWindow({
        port: electronCollectionsWindowPort(),
        htmlPath: context.resources.collectionsHtmlPath,
        preloadPath: context.resources.collectionsPreloadPath,
        ...(collectionId == null ? {} : { collectionId }),
        openExternalUrl: (url) => { void context.shell.openExternalUrl(url).catch((error: unknown) => reportDesktopEdgeFailure("collections", "open-external", error)); },
        reportFailure: (leg, error) => reportDesktopEdgeFailure("collections", leg, error),
      });
    };
    const dialog = (): {
      showSaveDialog(options: unknown): Promise<CollectionsSaveDialogResult>;
      showOpenDialog(options: unknown): Promise<CollectionsOpenDialogResult>;
    } => (require("electron") as { readonly dialog: any }).dialog;
    return registerCollectionsIpc({
      ipcMain: ipc,
      store,
      readTranscriptWindow: (request) => context.coordinatorLegs.legs.getAgentTranscriptWindow!(request),
      listAgents: () => context.coordinatorLegs.legs.listAgents!(),
      readMedia: readCollectionMedia,
      writeImportedMedia: async (collectionId, relPath, bytes) => {
        const dir = join(mediaRoot, collectionId);
        await fs.mkdir(dir, { recursive: true });
        const target = join(dir, relPath);
        await fs.writeFile(target, bytes);
        return target;
      },
      showSaveDialog: (options) => dialog().showSaveDialog(options),
      showOpenDialog: (options) => dialog().showOpenDialog({ ...options, properties: ["openFile"] }),
      writeTextFile: async (path, data) => { await fs.writeFile(path, data, "utf8"); },
      writeBinaryFile: async (path, data) => { await fs.writeFile(path, data); },
      // An offscreen window loads the export as a data: url and prints itself. Nothing is
      // fetched: the document is self-contained, its media already inlined.
      printHtmlToPdf: async (html) => {
        const electron = require("electron") as { readonly BrowserWindow: new (options: unknown) => any };
        const printer = new electron.BrowserWindow({
          show: false,
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, javascript: false, images: true },
        });
        try {
          await printer.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
          const pdf = await printer.webContents.printToPDF({ printBackground: true, margins: { marginType: "default" }, pageSize: "A4" });
          return new Uint8Array(pdf);
        } finally {
          if (!printer.isDestroyed()) printer.destroy();
        }
      },
      readTextFile: (path) => fs.readFile(path, "utf8"),
      openWindow,
      getTrustedContents: () => getCollectionsWindowContents() as { readonly mainFrame?: unknown } | null,
      dispatchDeepLink: (url) => context.handleDeepLink(url),
      reportFailure: (leg, error) => reportDesktopEdgeFailure("collections", leg, error),
    });
  };
}

export { COLLECTIONS_NAVIGATE_CHANNEL };
