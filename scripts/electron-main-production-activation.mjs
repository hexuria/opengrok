import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build as esbuild } from "esbuild";
import { applyReconstructedUpdaterGuard } from "./lib/build-asar.mjs";

import { repoRoot, sourceAppDir } from "./lib/config.mjs";

export const electronMainBindingProvenancePath = "dist/electron-main-production-bindings.json";
export const electronMainNodeTarget = "node22";
export const electronMainProductionBindingEvidence = Object.freeze({
  "adapters.secureStorage": "initializeSecureStorage();",
  "adapters.settings": "var sandSettingsStore = new SandSettingsStore(",
  "adapters.attachmentGateway": "attachments: createAttachmentEdgePort({",
  "adapters.mainRpc": "const mainEdge = serveMainEdge({",
  "adapters.updaterInstaller": "updateService = createUpdateServiceWiring({",
  "adapters.mediaProtocol": "registerSandMediaProtocol();",
  "adapters.accountOAuth": "var cursorAuthWiring = createCursorAuthWiring({",
  "adapters.experiments": "var experimentsRuntime = createExperimentsRuntime({",
  "adapters.mcpOAuth": "var mcpRuntime = createMcpRuntime({",
  "adapters.telemetry": "desktopTelemetry = await SandDesktopStructuredLogTelemetry.create({",
  "adapters.notifications": "const osNotificationManager = new SandOsNotificationManager({",
  "adapters.coordinator": "const createCoordinatorSession = () => createCoordinatorRuntime({",
  "adapters.ipc": "registerSecretsIpc({",
  "startup": "var desktopStartup = createDesktopStartupTracker({",
  "parseAllowedExternalUrl": "function parseAllowedExternalUrl(value)",
  "reportFailure": "function reportDesktopEdgeFailure(area, leg, error6)",
});
export const requiredElectronMainProductionBindings = Object.freeze(Object.keys(electronMainProductionBindingEvidence));

/**
 * The sixteen slots whose clean providers are already present in reviewed source.
 * These coordinates are deliberately kept in this activation seam: they are
 * not a default path or a native shim, but the exact source/export pairs
 * promoted by the Mac/Windows recovery inventories.
 */
export const electronMainProductionBindingInventorySpecs = Object.freeze([
  { path: "adapters.secureStorage", classification: "generated-source", module: "./source/electron-main/production-binding-providers.ts", export: "createElectronProductionSecureStorageBinding", access: "call", artifactAnchor: { artifact: "src/app/dist/electron-main/main.cjs", line: 506194, needle: "initializeSecureStorage();" } },
  { path: "adapters.settings", classification: "generated-source", module: "./source/electron-main/production-binding-providers.ts", export: "createElectronProductionSettingsBinding", access: "call", artifactAnchor: { artifact: "src/app/dist/electron-main/main.cjs", line: 505950, needle: "var sandSettingsStore = new SandSettingsStore(" } },
  { path: "adapters.attachmentGateway", classification: "generated-source", module: "./source/electron-main/adapters/attachment-gateway.ts", export: "createElectronProductionAttachmentGatewayBinding", access: "call", artifactAnchor: { artifact: "src/app/dist/electron-main/main.cjs", line: 506233, needle: "attachments: createAttachmentEdgePort({" } },
  { path: "adapters.mainRpc", classification: "generated-source", module: "./source/electron-main/adapters/main-rpc.ts", export: "createElectronProductionMainRpcBinding", access: "call", artifactAnchor: { artifact: "src/app/dist/electron-main/main.cjs", line: 506198, needle: "const mainEdge = serveMainEdge({" } },
  { path: "adapters.ipc", classification: "generated-source", module: "./source/electron-main/adapters/ipc.ts", export: "createElectronProductionIpcBinding", access: "call", artifactAnchor: { artifact: "src/app/dist/electron-main/main.cjs", line: 506728, needle: "registerSecretsIpc({" } },
  { path: "adapters.updaterInstaller", classification: "generated-source", module: "./source/electron-main/production-binding-providers.ts", export: "createElectronProductionUpdaterInstallerBinding", access: "call", artifactAnchor: { artifact: "src/app/dist/electron-main/main.cjs", line: 506321, needle: "updateService = createUpdateServiceWiring({" } },
  { path: "adapters.mediaProtocol", classification: "generated-source", module: "./source/electron-main/production-binding-providers.ts", export: "createElectronProductionMediaProtocolBinding", access: "call", artifactAnchor: { artifact: "src/app/dist/electron-main/main.cjs", line: 506337, needle: "registerSandMediaProtocol();" } },
  { path: "adapters.accountOAuth", classification: "generated-source", module: "./source/electron-main/adapters/account-oauth.ts", export: "createElectronProductionAccountOAuthBinding", access: "call", artifactAnchor: { artifact: "src/app/dist/electron-main/main.cjs", line: 505993, needle: "var cursorAuthWiring = createCursorAuthWiring({" } },
  { path: "adapters.experiments", classification: "generated-source", module: "./source/electron-main/adapters/production-experiments-binding.ts", export: "createElectronProductionExperimentsBinding", access: "call", artifactAnchor: { artifact: "src/app/dist/electron-main/main.cjs", line: 506018, needle: "var experimentsRuntime = createExperimentsRuntime({" } },
  { path: "adapters.mcpOAuth", classification: "generated-source", module: "./source/electron-main/adapters/mcp-oauth.ts", export: "createProductionMcpOAuthAdapter", access: "call", artifactAnchor: { artifact: "src/app/dist/electron-main/main.cjs", line: 506056, needle: "var mcpRuntime = createMcpRuntime({" } },
  { path: "adapters.telemetry", classification: "generated-source", module: "./source/electron-main/adapters/telemetry.ts", export: "createElectronProductionTelemetryBinding", access: "call", artifactAnchor: { artifact: "src/app/dist/electron-main/main.cjs", line: 506459, needle: "desktopTelemetry = await SandDesktopStructuredLogTelemetry.create({" } },
  { path: "adapters.notifications", classification: "generated-source", module: "./source/electron-main/production-binding-providers.ts", export: "createElectronProductionNotificationsBinding", access: "call", artifactAnchor: { artifact: "src/app/dist/electron-main/main.cjs", line: 506432, needle: "const osNotificationManager = new SandOsNotificationManager({" } },
  { path: "adapters.coordinator", classification: "generated-source", module: "./source/electron-main/coordinator/production-root-provider.ts", export: "createElectronProductionCoordinatorBinding", access: "value", artifactAnchor: { artifact: "src/app/dist/electron-main/main.cjs", line: 506501, needle: "const createCoordinatorSession = () => createCoordinatorRuntime({" } },
  { path: "startup", classification: "generated-source", module: "./source/electron-main/production-binding-providers.ts", export: "createElectronProductionStartupBinding", access: "call", artifactAnchor: { artifact: "src/app/dist/electron-main/main.cjs", line: 505780, needle: "var desktopStartup = createDesktopStartupTracker({" } },
  { path: "parseAllowedExternalUrl", classification: "generated-source", module: "./source/shared/external-url-policy.ts", export: "parseAllowedExternalUrl", access: "value", artifactAnchor: { artifact: "src/app/dist/electron-main/main.cjs", line: 406210, needle: "function parseAllowedExternalUrl(value)" } },
  { path: "reportFailure", classification: "generated-source", module: "./source/electron-main/desktop-edge-failures.ts", export: "reportDesktopEdgeFailure", access: "value", artifactAnchor: { artifact: "src/app/dist/electron-main/main.cjs", line: 6162, needle: "function reportDesktopEdgeFailure(area, leg, error6)" } },
]);

export const electronMainProductionBindingInventoryPaths = Object.freeze(
  electronMainProductionBindingInventorySpecs.map(binding => binding.path),
);
export const electronMainProductionBindingResidualPaths = Object.freeze(
  requiredElectronMainProductionBindings.filter(binding => !electronMainProductionBindingInventoryPaths.includes(binding)),
);

/** Runtime package edges retained by the clean Electron-main bundle. */
export const electronMainExternalRuntimePackageSpecs = Object.freeze([
  {
    name: "undici",
    version: "5.29.0",
    lockPath: "node_modules/undici",
    integrity: "sha512-raqeBD6NQK4SkWhQzeYKd1KmIG6dllBOTt55Rmkt4HtI9mwdWtJljnrXjAFUBLTSN67HWrOIZ3EPF4kjUw80Bg==",
  },
  {
    name: "@fastify/busboy",
    version: "2.1.1",
    lockPath: "node_modules/@fastify/busboy",
    integrity: "sha512-vBZP4NlzfOlerQTnba4aqZoMhE/a9HY7HRqoOPaETQcSQuWEIyZMHGfVu6w9wGtGK5fED5qRs2DteVCjOH60sA==",
  },
  {
    name: "ws",
    version: "8.20.0",
    lockPath: "node_modules/ws",
    integrity: "sha512-sAt8BhgNbzCtgGbt2OxmpuryO63ZoDk/sqaB/znQm94T4fCEsy/yV+7CdC1kJhOU9lboAEU7R3kquuycDoibVA==",
  },
]);

const classifications = new Set(["generated-source", "third-party", "native"]);
const accessKinds = new Set(["value", "call"]);
const builtins = new Set(builtinModules.flatMap(name => [name, name.replace(/^node:/, ""), `node:${name.replace(/^node:/, "")}`]));
const scriptPath = fileURLToPath(import.meta.url);
const normalize = value => value.split(path.sep).join("/");
const sha256 = value => createHash("sha256").update(value).digest("hex");

async function walkFiles(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const target = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(root, target));
    else if (entry.isFile()) files.push(path.relative(root, target).split(path.sep).join("/"));
  }
  return files.sort();
}

async function materializeElectronMainRuntimePackages(outputRoot) {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const lockfile = JSON.parse(await readFile(path.join(repoRoot, "package-lock.json"), "utf8"));
  for (const spec of electronMainExternalRuntimePackageSpecs) {
    if (["undici", "ws"].includes(spec.name) && packageJson.dependencies?.[spec.name] !== spec.version) {
      throw new Error(`Clean Electron main requires the exact root ${spec.name}@${spec.version} dependency.`);
    }
  }
  const packageRecords = [];
  const files = [];
  for (const spec of electronMainExternalRuntimePackageSpecs) {
    const lockRecord = lockfile.packages?.[spec.lockPath];
    if (lockRecord?.version !== spec.version || lockRecord?.integrity !== spec.integrity) throw new Error(`Clean Electron main runtime package drifted: ${spec.name}@${spec.version}.`);
    const source = path.join(repoRoot, spec.lockPath);
    const metadata = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
    if (metadata.version !== spec.version) throw new Error(`Installed Electron runtime package drifted: ${spec.name}@${spec.version}.`);
    if (spec.name === "undici" && (metadata.main !== "index.js" || metadata.types !== "index.d.ts" || metadata.engines?.node !== ">=14.0" || metadata.exports !== undefined)) {
      throw new Error("Clean Electron main requires undici's exact CJS main/types/engine surface with no conditional exports.");
    }
    if (spec.name === "ws" && (
      metadata.main !== "index.js"
      || metadata.types !== undefined
      || metadata.dependencies !== undefined
      || metadata.optionalDependencies !== undefined
      || metadata.engines?.node !== ">=10.0.0"
      || JSON.stringify(metadata.exports) !== JSON.stringify({
        ".": { browser: "./browser.js", import: "./wrapper.mjs", require: "./index.js" },
        "./package.json": "./package.json",
      })
      || JSON.stringify(metadata.peerDependencies) !== JSON.stringify({ bufferutil: "^4.0.1", "utf-8-validate": ">=5.0.2" })
      || metadata.peerDependenciesMeta?.bufferutil?.optional !== true
      || metadata.peerDependenciesMeta?.["utf-8-validate"]?.optional !== true
    )) {
      throw new Error("Clean Electron main requires ws's exact CJS/ESM export surface without native runtime peers.");
    }
    const destination = path.join(outputRoot, spec.lockPath);
    await cp(source, destination, { recursive: true, dereference: false, preserveTimestamps: true });
    const packageFiles = await walkFiles(destination);
    files.push(...packageFiles.map(relative => path.posix.join(spec.lockPath, relative)));
    packageRecords.push({ name: spec.name, version: spec.version, integrity: spec.integrity, path: spec.lockPath, files: packageFiles.length });
  }
  return { packages: packageRecords, files: files.sort() };
}

function packageName(specifier) {
  return specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
}

function resolveGeneratedModule(manifestPath, specifier) {
  if (!specifier.startsWith(".")) throw new Error(`Generated Electron-main binding modules must be manifest-relative: ${specifier}`);
  const absolute = path.resolve(path.dirname(manifestPath), specifier);
  const relative = normalize(path.relative(repoRoot, absolute));
  if (relative.startsWith("../") || path.isAbsolute(relative)) throw new Error(`Generated Electron-main binding module escapes the repository: ${specifier}`);
  for (const forbidden of ["src/app/", "recovered/source-capsules/", "dist/deps/", ".build/app/"]) {
    if (relative === forbidden.slice(0, -1) || relative.startsWith(forbidden)) throw new Error(`Generated Electron-main binding module uses a forbidden artifact/first-party fallback path: ${relative}`);
  }
  return { absolute, relative };
}

function resolveReviewedSourceModule(specifier) {
  if (typeof specifier !== "string" || !specifier.startsWith(".")) {
    throw new Error(`Built-in Electron-main binding modules must be repository-relative: ${specifier}`);
  }
  const absolute = path.resolve(repoRoot, specifier);
  const relative = normalize(path.relative(repoRoot, absolute));
  if (relative.startsWith("../") || path.isAbsolute(relative) || !(relative === "source" || relative.startsWith("source/"))) {
    throw new Error(`Built-in Electron-main binding module is outside reviewed source/: ${specifier}`);
  }
  return { absolute, relative };
}

async function validateGeneratedSourceExport(binding, resolved) {
  await stat(resolved.absolute);
  await esbuild({
    absWorkingDir: repoRoot,
    bundle: true,
    format: "esm",
    logLevel: "silent",
    packages: "external",
    platform: "node",
    stdin: {
      contents: `${binding.export === "default" ? `import candidate from ${JSON.stringify(resolved.absolute)};` : `import { ${binding.export} as candidate } from ${JSON.stringify(resolved.absolute)};`} void candidate;`,
      loader: "js",
      resolveDir: repoRoot,
      sourcefile: "scripts/build-entry/validate-electron-main-binding.mjs",
    },
    write: false,
  });
}

async function validateAnchor(bindingPath, anchor, artifactLines) {
  if (anchor == null || anchor.artifact !== "src/app/dist/electron-main/main.cjs" || !Number.isInteger(anchor.line) || anchor.line < 1 || typeof anchor.needle !== "string" || anchor.needle.length === 0) {
    throw new Error("Every Electron-main production binding requires an exact immutable main artifact anchor");
  }
  const expectedNeedle = electronMainProductionBindingEvidence[bindingPath];
  if (anchor.needle !== expectedNeedle) throw new Error(`Electron-main binding ${bindingPath} must use its exact evidence needle: ${expectedNeedle}`);
  if (!(artifactLines[anchor.line - 1] ?? "").includes(anchor.needle)) throw new Error(`Electron-main binding artifact anchor drifted at ${anchor.artifact}:${anchor.line}: ${anchor.needle}`);
}

function expression(bindings, key) {
  const index = bindings.findIndex(binding => binding.path === key);
  if (index < 0) throw new Error(`Internal Electron-main binding lookup failed: ${key}`);
  return bindings[index].access === "call" ? `binding${index}()` : `binding${index}`;
}

function entrySource(bindings) {
  const imports = bindings.map((binding, index) => binding.export === "default"
    ? `import binding${index} from ${JSON.stringify(binding.resolvedModule)};`
    : `import { ${binding.export} as binding${index} } from ${JSON.stringify(binding.resolvedModule)};`);
  const adapterKeys = requiredElectronMainProductionBindings.filter(key => key.startsWith("adapters.")).map(key => key.slice("adapters.".length));
  return `${imports.join("\n")}
import { app, safeStorage, ipcMain, BrowserWindow, Menu, shell, screen, systemPreferences } from "electron";
import { startElectronMainProduction } from "./source/electron-main/main.ts";
import { createElectronProductionNativeBindings } from "./source/electron-main/main-production-services.ts";
import { createElectronProductionAvatarImagesBinding } from "./source/electron-main/adapters/avatar-images.ts";
import { createElectronProductionImageContextMenuBinding } from "./source/electron-main/adapters/avatar-images.ts";
import { createElectronProductionCursorAccountBinding } from "./source/electron-main/adapters/account-edge.ts";
import { composeElectronProductionCoordinatorBindings, createElectronProductionServiceFactories } from "./source/electron-main/production-adapters.ts";

const coordinatorBindings = composeElectronProductionCoordinatorBindings(
  ${expression(bindings, "adapters.coordinator")},
  ${expression(bindings, "adapters.ipc")},
);
const adapters = {
  // These two edge objects are constructed by the immutable post-context
  // root, not by the sixteen external manifest slots. They receive the live
  // root context when createElectronProductionServiceFactories invokes them.
  avatarImages: createElectronProductionAvatarImagesBinding(),
  imageContextMenu: createElectronProductionImageContextMenuBinding(),
  cursorAccount: createElectronProductionCursorAccountBinding(),
${adapterKeys.filter(key => key !== "coordinator" && key !== "ipc").map(key => `  ${key}: ${expression(bindings, `adapters.${key}`)},`).join("\n")}
  ...coordinatorBindings,
};

try {
  startElectronMainProduction({
    native: createElectronProductionNativeBindings({ app, safeStorage, ipcMain, BrowserWindow, Menu, shell, screen, systemPreferences }),
    moduleDir: __dirname,
    startup: ${expression(bindings, "startup")},
    services: createElectronProductionServiceFactories(adapters),
    parseAllowedExternalUrl: ${expression(bindings, "parseAllowedExternalUrl")},
    reportFailure: ${expression(bindings, "reportFailure")},
  });
} catch (error) {
  process.stderr.write("[sand-electron-main] fatal composition failure: " + String(error) + "\\n");
  process.exitCode = 1;
}
`;
}

export async function validateElectronMainProductionBindingManifest(manifestPath) {
  const absoluteManifest = path.resolve(repoRoot, manifestPath);
  const manifestBytes = await readFile(absoluteManifest);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.bindings)) throw new Error("Electron-main production binding manifest must use schemaVersion 1 and a bindings array");
  const actual = manifest.bindings.map(binding => binding?.path).sort();
  const expected = [...requiredElectronMainProductionBindings].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const missing = expected.filter(key => !actual.includes(key));
    const extra = actual.filter(key => !expected.includes(key));
    throw new Error(`Electron-main production binding manifest is not exact: missing=[${missing.join(",")}] extra=[${extra.join(",")}]`);
  }
  const runtimeManifest = JSON.parse(await readFile(path.join(sourceAppDir, "dist/deps/runtime-deps-manifest.json"), "utf8"));
  const copiedPackages = new Set(runtimeManifest.copied ?? []);
  const nativePackages = new Set((runtimeManifest.nodeFiles ?? []).map(packageName));
  const artifactLines = (await readFile(path.join(sourceAppDir, "dist/electron-main/main.cjs"), "utf8")).split("\n");
  const bindings = await validateElectronMainBindingEntries(manifest.bindings, absoluteManifest, artifactLines, { copiedPackages, nativePackages });
  return { manifestPath: normalize(path.relative(repoRoot, absoluteManifest)), manifestSha256: sha256(manifestBytes), bindings };
}

async function validateElectronMainBindingEntries(entries, baseManifestPath, artifactLines, { copiedPackages, nativePackages }) {
  const bindings = [];
  const paths = new Set();
  for (const binding of entries) {
    if (paths.has(binding?.path)) throw new Error(`Electron-main production binding manifest contains a duplicate path: ${binding?.path}`);
    paths.add(binding?.path);
    if (!requiredElectronMainProductionBindings.includes(binding?.path)) throw new Error(`Unknown Electron-main production binding path: ${binding?.path}`);
    if (!classifications.has(binding.classification)) throw new Error(`Invalid Electron-main binding classification for ${binding.path}: ${binding.classification}`);
    if (!accessKinds.has(binding.access)) throw new Error(`Invalid Electron-main binding access for ${binding.path}: ${binding.access}`);
    if (typeof binding.module !== "string" || typeof binding.export !== "string" || !/^(?:default|[A-Za-z_$][\w$]*)$/.test(binding.export)) throw new Error(`Invalid Electron-main binding module/export for ${binding.path}`);
    await validateAnchor(binding.path, binding.artifactAnchor, artifactLines);
    let resolvedModule;
    if (binding.classification === "generated-source") {
      const resolved = resolveGeneratedModule(baseManifestPath, binding.module);
      await validateGeneratedSourceExport(binding, resolved);
      resolvedModule = resolved.absolute;
    } else {
      if (binding.module.startsWith(".") || path.isAbsolute(binding.module) || binding.module.includes("src/app") || binding.module.includes("dist/deps")) throw new Error(`Runtime Electron-main binding must use an approved bare package specifier: ${binding.module}`);
      const dependency = packageName(binding.module);
      if (!copiedPackages.has(dependency)) throw new Error(`Electron-main binding package is absent from the immutable runtime dependency manifest: ${dependency}`);
      if (binding.classification === "native" && !nativePackages.has(dependency)) throw new Error(`Electron-main binding classified native has no immutable .node payload: ${dependency}`);
      resolvedModule = binding.module;
    }
    bindings.push({ ...binding, resolvedModule });
  }
  return bindings;
}

async function electronMainRuntimePackages() {
  const runtimeManifest = JSON.parse(await readFile(path.join(sourceAppDir, "dist/deps/runtime-deps-manifest.json"), "utf8"));
  return {
    copiedPackages: new Set(runtimeManifest.copied ?? []),
    nativePackages: new Set((runtimeManifest.nodeFiles ?? []).map(packageName)),
  };
}

async function reviewedElectronMainBindings(artifactLines) {
  const bindings = [];
  for (const spec of electronMainProductionBindingInventorySpecs) {
    const resolved = resolveReviewedSourceModule(spec.module);
    await validateGeneratedSourceExport(spec, resolved);
    await validateAnchor(spec.path, spec.artifactAnchor, artifactLines);
    bindings.push({ ...spec, resolvedModule: resolved.absolute });
  }
  return bindings;
}

async function readElectronMainBindingManifest(manifestPath) {
  const absoluteManifest = path.resolve(repoRoot, manifestPath);
  const manifestBytes = await readFile(absoluteManifest);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.bindings)) throw new Error("Electron-main production binding manifest must use schemaVersion 1 and a bindings array");
  return {
    absoluteManifest,
    manifestBytes,
    manifest,
    manifestPath: normalize(path.relative(repoRoot, absoluteManifest)),
    manifestSha256: sha256(manifestBytes),
  };
}

/**
 * Compose the complete evidence-derived source tranche with an optional
 * manifest. A supplied full manifest remains accepted for compatibility,
 * while a partial manifest may only bind any future residual slots; it cannot
 * override a reviewed source provider.
 */
export async function assembleElectronMainProductionBindingManifest(manifestPath = null) {
  const artifactLines = (await readFile(path.join(sourceAppDir, "dist/electron-main/main.cjs"), "utf8")).split("\n");
  const builtins = await reviewedElectronMainBindings(artifactLines);
  const orderBindings = bindings => requiredElectronMainProductionBindings.flatMap(bindingPath => bindings.filter(binding => binding.path === bindingPath));
  if (manifestPath == null) {
    const orderedBuiltins = orderBindings(builtins);
    return {
      manifestPath: null,
      manifestSha256: null,
      bindings: orderedBuiltins,
      boundBindings: orderedBuiltins.map(binding => binding.path),
      unboundBindings: electronMainProductionBindingResidualPaths,
      inventory: electronMainProductionBindingInventorySpecs,
    };
  }
  const supplied = await readElectronMainBindingManifest(manifestPath);
  if (!Array.isArray(supplied.manifest.bindings)) throw new Error("Electron-main production binding manifest must contain bindings");
  const suppliedPaths = supplied.manifest.bindings.map(binding => binding?.path);
  const allPaths = [...requiredElectronMainProductionBindings].sort();
  if (JSON.stringify([...suppliedPaths].sort()) === JSON.stringify(allPaths)) {
    const validated = await validateElectronMainProductionBindingManifest(manifestPath);
    return { ...validated, boundBindings: requiredElectronMainProductionBindings, unboundBindings: [], inventory: electronMainProductionBindingInventorySpecs };
  }
  const builtinPathSet = new Set(electronMainProductionBindingInventoryPaths);
  const overlap = suppliedPaths.filter(bindingPath => builtinPathSet.has(bindingPath));
  if (overlap.length > 0) throw new Error(`Electron-main residual manifest overlaps evidence-derived bindings: ${[...new Set(overlap)].join(",")}`);
  const runtimePackages = await electronMainRuntimePackages();
  const residual = await validateElectronMainBindingEntries(supplied.manifest.bindings, supplied.absoluteManifest, artifactLines, runtimePackages);
  const bound = orderBindings([...builtins, ...residual]);
  const boundPaths = new Set(bound.map(binding => binding.path));
  const unbound = requiredElectronMainProductionBindings.filter(bindingPath => !boundPaths.has(bindingPath));
  return {
    manifestPath: supplied.manifestPath,
    manifestSha256: supplied.manifestSha256,
    bindings: bound,
    boundBindings: [...boundPaths],
    unboundBindings: unbound,
    inventory: electronMainProductionBindingInventorySpecs,
  };
}

export function resolveElectronMainBindingManifestPath({ argv = process.argv, env = process.env } = {}) {
  const cliPath = typeof argv?.[2] === "string" ? argv[2].trim() : "";
  if (cliPath.length > 0) return cliPath;
  const environmentPath = typeof env?.GROK_BOT_ELECTRON_MAIN_BINDINGS_MANIFEST === "string"
    ? env.GROK_BOT_ELECTRON_MAIN_BINDINGS_MANIFEST.trim()
    : "";
  return environmentPath.length > 0 ? environmentPath : null;
}

export async function buildProductionElectronMainIfSupplied({ outputRoot, manifestPath = resolveElectronMainBindingManifestPath(), reconstructedPackage = false } = {}) {
  const assembled = await assembleElectronMainProductionBindingManifest(manifestPath);
  if (assembled.unboundBindings.length > 0) return {
    status: "incomplete-evidence-derived-manifest",
    clean: false,
    blocker: `Electron-main clean activation remains fail-closed for exact residual bindings: ${assembled.unboundBindings.join(", ")}. Supply a schemaVersion 1 manifest for those slots through GROK_BOT_ELECTRON_MAIN_BINDINGS_MANIFEST; no default/native fallback is inferred.`,
    requiredBindings: requiredElectronMainProductionBindings,
    boundBindings: assembled.boundBindings,
    unboundBindings: assembled.unboundBindings,
    manifestPath: assembled.manifestPath,
    manifestSha256: assembled.manifestSha256,
  };
  if (outputRoot == null) throw new TypeError("buildProductionElectronMainIfSupplied requires outputRoot");
  const validated = assembled;
  const outfile = path.join(outputRoot, "dist/electron-main/main.cjs");
  await mkdir(path.dirname(outfile), { recursive: true });
  const declaredExternal = [...new Set(validated.bindings.filter(binding => binding.classification !== "generated-source").map(binding => binding.resolvedModule))];
  const result = await esbuild({
    absWorkingDir: repoRoot,
    banner: { js: `const __import_meta_url = require("node:url").pathToFileURL(__filename).href;\n// Deterministic clean-source production Electron main; bindings ${validated.manifestSha256}` },
    bundle: true,
    define: { "import.meta.url": "__import_meta_url" },
    external: ["electron", "undici", "ws", ...declaredExternal],
    format: "cjs",
    legalComments: "none",
    logLevel: "silent",
    metafile: true,
    outfile,
    platform: "node",
    sourcemap: false,
    stdin: { contents: entrySource(validated.bindings), loader: "ts", resolveDir: repoRoot, sourcefile: "scripts/build-entry/production-electron-main.ts" },
    target: electronMainNodeTarget,
  });
  if (reconstructedPackage) {
    const bundledSource = await readFile(outfile, "utf8");
    await writeFile(outfile, applyReconstructedUpdaterGuard(bundledSource));
  }
  const inputs = Object.keys(result.metafile.inputs).map(input => normalize(path.relative(repoRoot, path.resolve(repoRoot, input)))).sort();
  const forbiddenInputs = inputs.filter(input => input === "src/app" || input.startsWith("src/app/") || input.startsWith("recovered/source-capsules/") || input.startsWith("dist/deps/"));
  if (forbiddenInputs.length > 0) throw new Error(`Clean production Electron main reaches forbidden first-party artifact inputs: ${forbiddenInputs.join(", ")}`);
  const externalImports = [...new Set(Object.values(result.metafile.outputs).flatMap(output => output.imports.map(item => item.path)))].sort();
  const allowedPackages = new Set(["electron", "undici", "ws", ...declaredExternal, ...builtins]);
  const unexpectedExternal = externalImports.filter(specifier => !allowedPackages.has(specifier));
  if (unexpectedExternal.length > 0) throw new Error(`Clean production Electron main has undeclared external imports: ${unexpectedExternal.join(", ")}`);
  const runtimePackages = await materializeElectronMainRuntimePackages(outputRoot);
  if (!externalImports.includes("undici")) throw new Error("Clean production Electron main did not retain the real undici package edge.");
  const outputBytes = await readFile(outfile);
  const forbiddenOutput = outputBytes.toString("utf8").match(/(?:src\/app\/|recovered\/source-capsules\/|dist\/electron-main\/main\.cjs)/g) ?? [];
  if (forbiddenOutput.length > 0) throw new Error(`Clean production Electron main embeds forbidden artifact references: ${[...new Set(forbiddenOutput)].join(", ")}`);
  const provenance = {
    schemaVersion: 1,
    status: "validated-clean-source",
    manifestPath: validated.manifestPath,
    manifestSha256: validated.manifestSha256,
    requiredBindings: requiredElectronMainProductionBindings,
    electronAbi: ["app", "BrowserWindow", "Menu", "shell", "screen"],
    bindings: validated.bindings.map(({ resolvedModule: _resolvedModule, ...binding }) => binding),
    boundBindings: validated.boundBindings,
    unboundBindings: validated.unboundBindings,
    executableGraph: { target: electronMainNodeTarget, inputs, externalImports, forbiddenInputs, forbiddenOutputReferences: [], runtimePackages },
    output: { path: "dist/electron-main/main.cjs", bytes: outputBytes.byteLength, sha256: sha256(outputBytes) },
  };
  const provenancePath = path.join(outputRoot, electronMainBindingProvenancePath);
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  return { status: "validated-clean-source", clean: true, requiredBindings: requiredElectronMainProductionBindings, provenance, provenancePath, outputPath: outfile, runtimePackageFiles: runtimePackages.files };
}

if (process.argv[1] != null && path.resolve(process.argv[1]) === scriptPath) {
  const manifestPath = resolveElectronMainBindingManifestPath();
  if (!manifestPath) throw new Error("Pass an Electron-main binding manifest path or set GROK_BOT_ELECTRON_MAIN_BINDINGS_MANIFEST");
  const validated = await assembleElectronMainProductionBindingManifest(manifestPath);
  if (validated.unboundBindings.length > 0) throw new Error(`Electron-main production binding manifest remains incomplete: ${validated.unboundBindings.join(",")}`);
  console.log(`Validated ${validated.bindings.length} exact Electron-main production bindings (${validated.manifestSha256}).`);
}
