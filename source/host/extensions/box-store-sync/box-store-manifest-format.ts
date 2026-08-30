import { z } from "zod";
export const BOX_STORE_MANIFEST_REL_PATH = "manifest.json";
export const BOX_STORE_BLOBS_PREFIX = "blobs";
export const BOX_STORE_LEGACY_MANIFEST_VERSION = 1;
export const BOX_STORE_MANIFEST_VERSION = 2;
export const SAND_MANIFEST_V2_ENV = "SAND_MANIFEST_V2";
const identity = { sha: z.string().min(1), size: z.number().int().nonnegative() };
export const legacyManifestFileEntrySchema = z.object({ ...identity, kind: z.undefined().optional(), mode: z.undefined().optional() });
export const manifestFileEntrySchema = z.object({ kind: z.literal("file"), ...identity, mode: z.number().int().min(0).max(0o777) });
export const manifestSymlinkEntrySchema = z.object({ kind: z.literal("symlink"), target: z.string().min(1) });
export const manifestEntrySchema = z.union([manifestFileEntrySchema, manifestSymlinkEntrySchema, legacyManifestFileEntrySchema]);
const header = { updatedAtMs: z.number().int().nonnegative(), writerWindowId: z.string().optional(), fullyHydrated: z.boolean().optional() };
export const legacyManifestSchema = z.object({ version: z.literal(BOX_STORE_LEGACY_MANIFEST_VERSION), ...header, entries: z.record(z.string(), legacyManifestFileEntrySchema) });
export const currentManifestSchema = z.object({ version: z.literal(BOX_STORE_MANIFEST_VERSION), ...header, entries: z.record(z.string(), manifestEntrySchema) });
export const manifestSchema = z.discriminatedUnion("version", [legacyManifestSchema, currentManifestSchema]);
export type BoxStoreManifestEntry = z.infer<typeof manifestEntrySchema>;
export function isBoxStoreManifestFileEntry(entry: BoxStoreManifestEntry): entry is Exclude<BoxStoreManifestEntry, { kind: "symlink" }> { return entry.kind !== "symlink"; }
export function isBoxStoreManifestSymlinkEntry(entry: BoxStoreManifestEntry): entry is z.infer<typeof manifestSymlinkEntrySchema> { return entry.kind === "symlink"; }
export function boxStoreManifestEntriesEqual(left: BoxStoreManifestEntry | null | undefined, right: BoxStoreManifestEntry | null | undefined): boolean { if (left == null || right == null) return left === right; if (isBoxStoreManifestSymlinkEntry(left) || isBoxStoreManifestSymlinkEntry(right)) return isBoxStoreManifestSymlinkEntry(left) && isBoxStoreManifestSymlinkEntry(right) && left.target === right.target; return left.sha === right.sha && left.size === right.size && left.kind === right.kind && left.mode === right.mode; }
export function isSymlinkManifestValue(entry: unknown): boolean { return manifestSymlinkEntrySchema.safeParse(entry).success; }
