import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractFile, listPackage } from "@electron/asar";
import { build as esbuild } from "esbuild";

import { runtimeComposition } from "./lib/clean-build.mjs";
import { repoRoot, sourceAppDir } from "./lib/config.mjs";
import { requiredElectronMainProductionBindings } from "./electron-main-production-activation.mjs";
import { assembleHostProductionBindingManifest } from "./host-production-activation.mjs";

export const compositionAuditPath = "dist/runtime-composition-audit.json";
const forbiddenEvidencePrefix = "src/app/";
const runnerNonClosureFidelityResiduals = Object.freeze([
  {
    source: "source/host/runner/tools/tool-input-error.ts",
    classification: "reachable-consumer-semantic-fidelity-gap",
    reason: "The shipped tools throw the shared SandToolInputError identity, while clean consumers do not import or use the recovered class; this is not an entry-graph dependency, but exact error semantics remain incomplete.",
  },
]);
const scriptPath = fileURLToPath(import.meta.url);
const runnerParityPath = "manifests/reconstruction/runner-parity-audit.json";

// The adapter catalog is a structural contract, not a historical count. Keep
// the required ownership keys explicit so a newly added area does not silently
// replace a production area, and a removed area fails with its name.
const requiredElectronProductionAreas = new Set([
  "secureStorage",
  "settings",
  "attachmentGateway",
  "avatarImages",
  "cursorAccount",
  "mainRpc",
  "updaterInstaller",
  "mediaProtocol",
  "accountOAuth",
  "experiments",
  "mcpOAuth",
  "telemetry",
  "notifications",
  "coordinator",
  "ipc",
]);

// These are immutable support roots intentionally preserved in the packaged
// ASAR and loaded by the clean renderer through /upstream/assets. They are
// not clean-source chunks and therefore cannot carry the deterministic clean
// source banner. The policy is derived from the recovery manifest so an
// exemption is exact manifest path + size + SHA, followed by exact ASAR
// placement when a packaged output is being audited.
const rendererRuntimeManifest = JSON.parse(readFileSync(
  path.join(repoRoot, "frontend/manifests/renderer-runtime-assets.json"),
  "utf8",
));
const forbiddenImmutableRendererAssets = new Set([
  "assets/index-UbX-y3il.js",
  "assets/mermaid.core-CYC_FcEu.js",
]);
export const IMMUTABLE_RENDERER_ASSET_FORBIDDEN = Object.freeze([...forbiddenImmutableRendererAssets]);
export const IMMUTABLE_RENDERER_ASSET_ALLOWLIST = Object.freeze(Object.fromEntries(
  (rendererRuntimeManifest.immutableAssets ?? [])
    .map((asset) => [`assets/${asset.file}`, Object.freeze({
      artifact: `${rendererRuntimeManifest.artifactRoot}/${asset.file}`,
      manifestFile: asset.file,
      bytes: asset.bytes ?? readFileSync(path.join(repoRoot, rendererRuntimeManifest.artifactRoot, asset.file)).byteLength,
      sha256: asset.sha256,
    })])
    .filter(([relativePath]) => !forbiddenImmutableRendererAssets.has(relativePath)),
));

export function isAllowlistedImmutableRendererAsset(relativePath, content) {
  if (forbiddenImmutableRendererAssets.has(relativePath)) return false;
  const record = IMMUTABLE_RENDERER_ASSET_ALLOWLIST[relativePath];
  const bytes = typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;
  return record != null && bytes === record.bytes && sha256(content) === record.sha256;
}

const runtimeSpecs = Object.freeze({
  "electron-main": {
    entrypoint: "source/electron-main/main.ts",
    artifact: "src/app/dist/electron-main/main.cjs",
    artifactSourceMarker: "// src/electron-main/main.cts",
    contract: "ElectronMainDependencies",
    nestedContracts: [
      { interface: "ElectronMainServices", source: "source/electron-main/main.ts" },
      { interface: "ElectronProductionServiceFactories", source: "source/electron-main/main-production-services.ts" },
      { interface: "ElectronProductionAdapterBindings", source: "source/electron-main/production-adapters.ts" },
    ],
    requirements: {
      app: ["native-boundary", null, "import_electron51.app.disableHardwareAcceleration()"],
      menu: ["adapter-required", "source/electron-main/application-menu.ts#installApplicationMenu", "installApplicationMenu({"],
      platform: ["clean-runtime-global", "process.platform", "process.platform"],
      env: ["clean-runtime-global", "process.env", "process.env.SAND_PACKAGED"],
      isLabBuild: ["metadata-binding-required", null, "var isSandLabBuild2 ="],
      isAttachProdBox: ["metadata-binding-required", null, "var isAttachProdBox ="],
      appVersion: ["metadata-binding-required", null, "SAND_CLIENT_APP_VERSION"],
      appName: ["native-boundary", null, "app.getName()"],
      devAppIcon: ["resource-binding-required", null, "SAND_DEV_APP_ICON"],
      preloadPath: ["resource-binding-required", null, "var PRELOAD_DIST_DIR ="],
      rendererHtmlPath: ["resource-binding-required", null, "../renderer/index.html"],
      createBrowserWindow: ["native-boundary", null, "new import_electron51.BrowserWindow("],
      getAllWindows: ["native-boundary", null, "BrowserWindow.getAllWindows()"],
      windowStatePersistence: ["clean-provider", "source/electron-main/window-state-persistence.ts#createWindowStatePersistence", "resolveSandWindowPlacement()"],
      deepLinks: ["clean-provider-needs-adapter", "source/electron-main/deep-link/deep-link-controller.ts#SandDeepLinkController", "new SandDeepLinkController("],
      startup: ["clean-providers-need-adapter", "source/electron-main/telemetry/desktop-startup-telemetry.ts#createDesktopStartupTracker", "var desktopStartup = createDesktopStartupTracker("],
      initializeFoundation: ["clean-composite-provider-needs-explicit-adapters", "source/electron-main/main-production-services.ts#createElectronMainProductionComposition", "var sandSettingsStore = new SandSettingsStore("],
      initializeServices: ["clean-composite-provider-needs-explicit-adapters", "source/electron-main/main-production-services.ts#createElectronMainProductionComposition", "const mainEdge = serveMainEdge("],
      syncWindowFocused: ["clean-composite-provider-needs-coordinator-adapter", "source/electron-main/main-production-services.ts#createElectronMainProductionComposition", "var syncWindowFocused = createWindowFocusSync("],
      beginBeforeQuit: ["clean-composite-provider-needs-service-adapters", "source/electron-main/main-production-services.ts#createElectronMainProductionComposition", "const decision = quitTelemetryFlush.noteQuit("],
    },
    blockers: [
      "electron-native-adapter",
      "electron-resource-and-package-metadata-adapter",
      "electron-production-adapter-binding-manifest-not-supplied",
      "electron-generated-protobuf-and-backend-bindings",
      "electron-artifact-runtime-dependencies",
    ],
  },
  host: {
    entrypoint: "source/host/main.ts",
    artifact: "src/app/dist/host/host-main.cjs",
    artifactSourceMarker: "// src/host/main.ts",
    contract: "HostMainDependencies",
    nestedContracts: [
      { interface: "HostProductionPorts", source: "source/host/main.ts" },
      { interface: "ProductionSandHostPorts", source: "source/host/sand-host.ts" },
      { interface: "ProductionExtensionHostAdapters", source: "source/host/sand-host.ts" },
      { interface: "RecoveredProductionExtensionBindings", source: "source/host/host-production-extensions.ts" },
    ],
    requirements: {
      executeBoxCopyInFromEnv: ["generated-binding-manifest-required", "HostProductionPorts.executeBoxCopyInFromEnv", "executeBoxCopyInFromEnv()"],
      installProcessCrashGuards: ["clean-provider", "source/host/process-crash-guard.ts#installProcessCrashGuards", "installProcessCrashGuards({"],
      installInvariantReporter: ["clean-provider", "source/shared/invariant.ts#installInvariantReporter", "installInvariantReporter((report)"],
      pinHostDiagnosticsReporter: ["clean-provider", "source/host/host-diagnostics.ts#pinHostDiagnosticsReporter", "pinHostDiagnosticsReporter((diagnostic)"],
      acquireHostLock: ["clean-provider", "source/host/host-lock.ts#acquireHostLock", "await acquireHostLock()"],
      startBoxExecDaemon: ["clean-provider", "source/host/box/exec-daemon-process.ts#startBoxExecDaemonProcess", "await acquireHostLock()"],
      getSandRootDir: ["clean-provider", "source/host/host-paths.ts#getSandRootDir", "getSandRootDir()}"],
      createHost: ["clean-provider-needs-explicit-ports", "source/host/sand-host.ts#createProductionSandHost", "new SandHost()"],
      resolveGatewayServerConfig: ["clean-provider", "source/host/gateway-config.ts#resolveGatewayServerConfig", "resolveGatewayServerConfig()"],
      gatewayScheme: ["clean-provider", "source/host/gateway-config.ts#gatewayScheme", "gatewayScheme(gatewayConfig)"],
      startGatewayServer: ["clean-provider", "source/host/gateway-server.ts#startGatewayServer", "await startGatewayServer({"],
      writeGatewayDiscovery: ["clean-provider", "source/host/host-discovery.ts#writeGatewayDiscovery", "await writeGatewayDiscovery({"],
      clearGatewayDiscovery: ["clean-provider", "source/host/host-discovery.ts#clearGatewayDiscovery", "clearGatewayDiscovery"],
      log: ["clean-runtime-global", "console", "console.error("],
    },
    blockers: [
      "host-box-copy-in-bootstrap",
      "host-production-binding-manifest-not-supplied",
      "host-generated-and-external-production-ports",
      "host-artifact-runtime-dependencies",
    ],
  },
});

function normalize(value) {
  return value.split(path.sep).join("/");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function walk(root, current = root) {
  const found = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const target = path.join(current, entry.name);
    if (entry.isDirectory()) found.push(...await walk(root, target));
    else if (entry.isFile()) found.push(normalize(path.relative(root, target)));
  }
  return found.sort();
}

function lineNumberAt(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

function sourceMarkerBefore(text, offset) {
  const prefix = text.slice(0, offset);
  const matches = [...prefix.matchAll(/^\/\/ (.+)$/gm)];
  return matches.at(-1)?.[1] ?? null;
}

function anchorFor(text, artifact, needle, start = 0) {
  const offset = text.indexOf(needle, start);
  if (offset < 0) throw new Error(`Artifact anchor not found in ${artifact}: ${needle}`);
  return {
    artifact,
    line: lineNumberAt(text, offset),
    sourceMarker: sourceMarkerBefore(text, offset),
    needle,
  };
}

function interfaceMembers(sourceText, fileName, interfaceName) {
  const declaration = new RegExp(`\\binterface\\s+${interfaceName}\\b[^\\{]*\\{`).exec(sourceText);
  if (declaration == null) throw new Error(`Missing interface ${interfaceName} in ${fileName}`);
  const bodyStart = declaration.index + declaration[0].length;
  let braceDepth = 1;
  let parenDepth = 0;
  let bracketDepth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let memberStart = bodyStart;
  const signatures = [];
  for (let index = bodyStart; index < sourceText.length; index += 1) {
    const character = sourceText[index];
    const nextCharacter = sourceText[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && nextCharacter === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote != null) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "/" && nextCharacter === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && nextCharacter === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") { quote = character; continue; }
    if (character === "{") braceDepth += 1;
    else if (character === "}") {
      braceDepth -= 1;
      if (braceDepth === 0) break;
    } else if (character === "(") parenDepth += 1;
    else if (character === ")") parenDepth -= 1;
    else if (character === "[") bracketDepth += 1;
    else if (character === "]") bracketDepth -= 1;
    else if (character === ";" && braceDepth === 1 && parenDepth === 0 && bracketDepth === 0) {
      const signature = sourceText.slice(memberStart, index + 1).trim();
      if (signature) signatures.push(signature);
      memberStart = index + 1;
    }
  }
  return signatures.map(signature => {
    const uncommented = signature
      .replace(/^\s*\/\*[\s\S]*?\*\/\s*/g, "")
      .replace(/^(?:\s*\/\/[^\n]*\n)+\s*/g, "");
    const head = uncommented.replace(/^readonly\s+/, "").match(/^(?:["']([^"']+)["']|([A-Za-z_$][\w$]*))(\?)?\s*(?=[:(<])/);
    if (head == null) throw new Error(`Cannot parse ${interfaceName} member in ${fileName}: ${signature}`);
    return { name: head[1] ?? head[2], optional: head[3] === "?", signature: uncommented.replace(/\s+/g, " ") };
  });
}

async function sourceGraph(entrypoint, { platform = "node", format = "cjs", loader = undefined } = {}) {
  const result = await esbuild({
    absWorkingDir: repoRoot,
    bundle: true,
    entryPoints: [path.join(repoRoot, entrypoint)],
    external: ["electron"],
    format,
    ...(loader == null ? {} : { loader }),
    logLevel: "silent",
    metafile: true,
    platform,
    write: false,
  });
  const inputs = Object.keys(result.metafile.inputs).map(input => normalize(path.relative(repoRoot, path.resolve(repoRoot, input)))).sort();
  const externalImports = [...new Set(Object.values(result.metafile.outputs).flatMap(output => output.imports.map(item => `${item.kind}:${item.path}`)))].sort();
  return {
    entrypoint,
    inputs,
    externalImports,
    forbiddenEvidenceInputs: inputs.filter(input => input === "src/app" || input.startsWith(forbiddenEvidencePrefix)),
  };
}

async function exportedSymbols() {
  const sourceRoot = path.join(repoRoot, "source");
  const files = (await walk(sourceRoot)).filter(file => /\.[cm]?tsx?$/.test(file));
  const symbols = new Map();
  for (const relative of files) {
    const repoRelative = `source/${relative}`;
    const text = await readFile(path.join(sourceRoot, relative), "utf8");
    for (const match of text.matchAll(/\bexport\s+(?:declare\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
      const name = match[1];
      const providers = symbols.get(name) ?? [];
      providers.push(repoRelative);
      symbols.set(name, providers);
    }
  }
  return symbols;
}

function factoryInventory(text, artifact, marker, cleanExports) {
  const start = text.lastIndexOf(marker);
  if (start < 0) throw new Error(`Composition marker not found in ${artifact}: ${marker}`);
  const composition = text.slice(start);
  const pattern = /\b(?:new\s+)?((?:create|install|initialize|bootstrap|register|serve|wire|resolve|start|execute|acquire|write|clear|pin|get)[A-Z][A-Za-z0-9_]*|SandHost|[A-Za-z0-9_]+\.BrowserWindow)\s*\(/g;
  const found = new Map();
  for (const match of composition.matchAll(pattern)) {
    const raw = match[1];
    const absoluteOffset = start + match.index + match[0].indexOf(raw);
    if (raw !== "SandHost" && !raw.endsWith(".BrowserWindow") && text[absoluteOffset - 1] === ".") continue;
    const symbol = raw.endsWith(".BrowserWindow") ? "BrowserWindow" : raw;
    if (found.has(symbol)) continue;
    const offset = absoluteOffset;
    const providers = cleanExports.get(symbol) ?? [];
    const isRuntimeGlobal = ["clearTimeout", "setTimeout"].includes(symbol);
    const isArtifactLocal = new RegExp(`(?:function\\s+${symbol}\\s*\\(|(?:var|let|const)\\s+${symbol}\\s*=)`).test(composition);
    found.set(symbol, {
      symbol,
      kind: raw.endsWith(".BrowserWindow") ? "native-constructor" : raw === "SandHost" ? "constructor" : "factory-or-binding",
      status: raw.endsWith(".BrowserWindow") ? "artifact-native-boundary"
        : providers.length > 0 ? "clean-export-present"
        : isRuntimeGlobal ? "node-runtime-global"
        : isArtifactLocal ? "artifact-local-binding"
        : "artifact-only-or-not-exported",
      cleanProviders: providers,
      anchor: {
        artifact,
        line: lineNumberAt(text, offset),
        sourceMarker: sourceMarkerBefore(text, offset),
        needle: raw,
      },
    });
  }
  return [...found.values()].sort((left, right) => left.anchor.line - right.anchor.line || left.symbol.localeCompare(right.symbol));
}

function generatedBindings(text, artifact) {
  const found = [];
  for (const match of text.matchAll(/^\/\/ (.*(?:\/generated\/|_pb\.(?:js|ts)$|_connect\.(?:js|ts)$).*)$/gm)) {
    found.push({
      generatedModule: match[1],
      status: "artifact-only-generated-binding",
      anchor: { artifact, line: lineNumberAt(text, match.index), sourceMarker: match[1], needle: `// ${match[1]}` },
    });
  }
  return found;
}

async function electronProductionAdapterEvidence() {
  const source = "source/electron-main/production-adapters.ts";
  const text = await readFile(path.join(repoRoot, source), "utf8");
  const declaration = text.match(/ELECTRON_PRODUCTION_AREA_EVIDENCE\s*=\s*Object\.freeze\(\{([\s\S]*?)\n\}\s+as const\);/);
  if (declaration == null) throw new Error("Electron production adapter evidence catalog is missing");
  const areas = [];
  for (const match of declaration[1].matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):\s*\{([\s\S]*?)^\s{2}\},?$/gm)) {
    const strings = name => {
      const value = new RegExp(`${name}:\\s*\\[([^\\]]*)\\]`).exec(match[2]);
      return value == null ? [] : [...value[1].matchAll(/"([^"]+)"/g)].map(item => item[1]);
    };
    const recoveredProviders = strings("recoveredProviders");
    const injectedPorts = strings("injectedPorts");
    if (recoveredProviders.length === 0 || injectedPorts.length === 0) throw new Error(`Electron production adapter evidence area is incomplete: ${match[1]}`);
    const providers = [];
    for (const provider of recoveredProviders) {
      if (!provider.startsWith("source/") || provider.includes("../")) throw new Error(`Electron production provider escapes clean source: ${provider}`);
      const bytes = await readFile(path.join(repoRoot, provider));
      providers.push({ path: provider, status: "clean-provider-recovered", sha256: sha256(bytes) });
    }
    areas.push({ area: match[1], providers, injectedPorts: injectedPorts.map(port => ({ port, status: "explicit-native-generated-or-executable-boundary" })) });
  }
  const areaNames = areas.map((area) => area.area);
  const duplicateAreas = areaNames.filter((area, index) => areaNames.indexOf(area) !== index);
  const missingAreas = [...requiredElectronProductionAreas].filter((area) => !areaNames.includes(area));
  const unexpectedAreas = areaNames.filter((area) => !requiredElectronProductionAreas.has(area));
  if (duplicateAreas.length > 0 || missingAreas.length > 0 || unexpectedAreas.length > 0) {
    throw new Error(`Electron production adapter evidence ownership mismatch: duplicate=${duplicateAreas.join(",") || "none"}, missing=${missingAreas.join(",") || "none"}, unexpected=${unexpectedAreas.join(",") || "none"}`);
  }
  return { source, areas };
}

function externalRequires(text, artifact) {
  const nodeBuiltins = new Set(builtinModules.flatMap(module => [module, module.replace(/^node:/, ""), `node:${module.replace(/^node:/, "")}`]));
  const byModule = new Map();
  for (const match of text.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const module = match[1];
    const current = byModule.get(module);
    if (current != null) {
      current.occurrences += 1;
      continue;
    }
    byModule.set(module, {
      module,
      occurrences: 1,
      status: module.includes("%") ? "dynamic-require-template"
        : module === "electron" ? "packaged-electron-native-boundary"
        : nodeBuiltins.has(module) ? "node-runtime-boundary"
        : "packaged-module-boundary",
      anchor: { artifact, line: lineNumberAt(text, match.index), sourceMarker: sourceMarkerBefore(text, match.index), needle: match[0] },
    });
  }
  return [...byModule.values()].sort((left, right) => left.module.localeCompare(right.module));
}

async function nativeRuntimeInventory() {
  const roots = ["src/app/dist/native", "src/app/dist/deps"];
  const inventory = [];
  for (const root of roots) {
    const absolute = path.join(repoRoot, root);
    for (const relative of await walk(absolute)) {
      if (!root.endsWith("/native") && !relative.endsWith(".node")) continue;
      const target = path.join(absolute, relative);
      const bytes = await readFile(target);
      inventory.push({ path: `${root}/${relative}`, bytes: bytes.byteLength, sha256: sha256(bytes), status: "artifact-runtime-boundary" });
    }
  }
  return inventory.sort((left, right) => left.path.localeCompare(right.path));
}

async function runnerCompositionClosure({ hostGraph, hostProductionExtensionsGraph, hostActivation, hostMode }) {
  const parity = JSON.parse(await readFile(path.join(repoRoot, runnerParityPath), "utf8"));
  const modules = Array.isArray(parity.modules) ? parity.modules : [];
  const allCleanSources = modules.map((module) => module.cleanSource).sort();
  const hostInputs = new Set(hostGraph.inputs);
  const reachableCleanSources = allCleanSources.filter((source) => hostInputs.has(source));
  const unreachableCleanSources = allCleanSources.filter((source) => !hostInputs.has(source));
  const generatedEntryInputs = new Set([...hostGraph.inputs, ...hostProductionExtensionsGraph.inputs]);
  const generatedEntryReachableCleanSources = allCleanSources.filter((source) => generatedEntryInputs.has(source));
  const generatedEntryUnreachableCleanSources = allCleanSources.filter((source) => !generatedEntryInputs.has(source));
  const nonClosureResidualPaths = new Set(runnerNonClosureFidelityResiduals.map(residual => residual.source));
  const generatedEntryUnreachableExecutableSources = generatedEntryUnreachableCleanSources.filter(source => !nonClosureResidualPaths.has(source));
  const activeFidelityResiduals = runnerNonClosureFidelityResiduals.filter(residual => generatedEntryUnreachableCleanSources.includes(residual.source));
  const directBehaviorAnchors = modules.filter((module) => (module.testAnchors?.behavior?.length ?? 0) > 0).length;
  const sourceOnlyRunnerFindings = (parity.findings ?? []).filter((finding) => finding.code === "source-only-runner-module");
  const unauditedCleanModules = Number(parity.summary?.cleanModules) - modules.length;
  const duplicateCleanSources = allCleanSources.filter((source, index) => allCleanSources.indexOf(source) !== index);
  const malformedModules = modules.filter((module) => (
    typeof module.source !== "string"
    || !module.source.startsWith("src/")
    || typeof module.cleanSource !== "string"
    || !module.cleanSource.startsWith("source/")
    || typeof module.capsule !== "string"
    || !module.capsule.startsWith("recovered/")
    || typeof module.artifact !== "object"
    || module.artifact == null
    || !Array.isArray(module.artifact.symbols)
    || !Array.isArray(module.clean?.runtimeExports)
  ));
  if (modules.length === 0 || duplicateCleanSources.length > 0 || malformedModules.length > 0 || parity.summary?.manifestCapsules !== modules.length || unauditedCleanModules < 0 || sourceOnlyRunnerFindings.length !== unauditedCleanModules || sourceOnlyRunnerFindings.some((finding) => finding.severity !== "medium") || parity.summary?.high !== 0 || directBehaviorAnchors === 0 || directBehaviorAnchors > modules.length) {
    throw new Error(`Runner composition metadata ownership/reachability mismatch: modules=${modules.length}, duplicateCleanSources=${duplicateCleanSources.join(",") || "none"}, malformedModules=${malformedModules.length}, capsules=${String(parity.summary?.manifestCapsules)}, clean=${String(parity.summary?.cleanModules)}, high=${String(parity.summary?.high)}, directBehaviorAnchors=${directBehaviorAnchors}`);
  }

  const artifact = "src/app/dist/host/host-main.cjs";
  const artifactText = await readFile(path.join(repoRoot, artifact), "utf8");
  const sandHostSource = "source/host/sand-host.ts";
  const sandHostText = await readFile(path.join(repoRoot, sandHostSource), "utf8");
  const runnerCompositionSource = "source/host/host-runner-composition.ts";
  const runnerCompositionText = await readFile(path.join(repoRoot, runnerCompositionSource), "utf8");
  const bindingInventory = hostActivation.inventory ?? [];
  const directHostBindings = bindingInventory.filter((binding) => binding.owner === "runner");
  const unboundDirectHostBindings = directHostBindings.filter((binding) => binding.status !== "bound");
  const unboundHostBindings = bindingInventory.filter((binding) => binding.status !== "bound");
  const runnerRealTurn = hostActivation.activationEvidence?.runnerRealTurn ?? { status: "not-supplied" };
  const blockers = [
    ...(hostMode === "clean-source" ? [] : ["host-runtime-remains-artifact-fallback"]),
    ...unboundDirectHostBindings.map((binding) => `unbound-runner-host-port:${binding.path}`),
    ...(runnerRealTurn.status === "supported" ? [] : [`runner-real-turn:${runnerRealTurn.status}`]),
    ...(generatedEntryUnreachableExecutableSources.length === 0 ? [] : [`runner-executable-modules-outside-generated-host-entry-graph:${generatedEntryUnreachableExecutableSources.length}`]),
  ];

  return {
    policy: "Executable Runner recovery is reported separately from source-graph reachability and production activation. No module is production-composed merely because its standalone source or focused tests pass.",
    parity: {
      report: runnerParityPath,
      executableModules: modules.length,
      highFindings: parity.summary.high,
      mediumFindings: parity.summary.medium,
      directBehaviorAnchors,
      sourceImportEdges: parity.summary.sourceImportEdges,
      importCycles: parity.summary.runnerImportCycles,
    },
    hostSourceGraph: {
      entrypoint: hostGraph.entrypoint,
      reachableModules: reachableCleanSources.length,
      unreachableModules: unreachableCleanSources.length,
      reachableCleanSources,
      unreachableCleanSources,
    },
    generatedHostEntryGraph: {
      actualEntryPaths: [hostGraph.entrypoint, hostProductionExtensionsGraph.entrypoint],
      reachableModules: generatedEntryReachableCleanSources.length,
      unreachableModules: generatedEntryUnreachableCleanSources.length,
      reachableCleanSources: generatedEntryReachableCleanSources,
      unreachableCleanSources: generatedEntryUnreachableCleanSources,
      unreachableExecutableModules: generatedEntryUnreachableExecutableSources.length,
      unreachableExecutableSources: generatedEntryUnreachableExecutableSources,
      nonClosureFidelityResiduals: activeFidelityResiduals,
    },
    immutableConstructionOrder: [
      { step: "start-host-extension-graph", anchor: anchorFor(artifactText, artifact, "const hostExtensions = await startHostPluginRegistry({") },
      { step: "create-roster-bookkeeping", anchor: anchorFor(artifactText, artifact, "this.rosterBookkeeping = createHostRosterBookkeeping(hostExtensions);") },
      { step: "create-runner-composition", anchor: anchorFor(artifactText, artifact, "this.runnerComposition = createHostRunnerComposition({") },
      { step: "bind-local-permission-surfaces", anchor: anchorFor(artifactText, artifact, "hostExtensions.api(\"local-tool-permission\").bindAskSurfaces(") },
      { step: "bind-turn-executor", anchor: anchorFor(artifactText, artifact, "hostExtensions.api(\"turn-execution\").bindExecutor({") },
      { step: "construct-runner-on-demand", anchor: anchorFor(artifactText, artifact, "const runner = new SandAgentRunner({") },
      { step: "dispose-runner-before-extension-stop", anchor: anchorFor(artifactText, artifact, "await this.runnerComposition?.dispose();") },
    ],
    cleanConstructionAnchors: [
      { step: "create-roster-bookkeeping", anchor: anchorFor(sandHostText, sandHostSource, "this.rosterBookkeeping = createHostRosterBookkeeping(extensions);") },
      { step: "create-runner-composition", anchor: anchorFor(sandHostText, sandHostSource, "this.runnerComposition = this.runtime.createRunnerComposition({") },
      { step: "bind-turn-executor", anchor: anchorFor(sandHostText, sandHostSource, "optionalMethod(extensions.api(\"turn-execution\"), \"bindExecutor\")?.({") },
      { step: "construct-runner-on-demand", anchor: anchorFor(runnerCompositionText, runnerCompositionSource, "return deps.buildRunner(runnerOptions);") },
      { step: "dispose-runner-before-extension-stop", anchor: anchorFor(sandHostText, sandHostSource, "await this.runnerComposition?.dispose();") },
    ],
    productionActivation: {
      hostMode,
      composed: blockers.length === 0,
      verified: blockers.length === 0 && activeFidelityResiduals.length === 0,
      blockers,
      exactFidelityVerified: blockers.length === 0 && activeFidelityResiduals.length === 0,
      fidelityResiduals: activeFidelityResiduals,
      runnerRealTurn,
      directHostBindings: directHostBindings.map(({ path: bindingPath, status, blocker, artifactAnchors, recoveredCandidate }) => ({
        path: bindingPath,
        status,
        ...(blocker == null ? {} : { blocker }),
        artifactAnchors,
        ...(recoveredCandidate == null ? {} : { recoveredCandidate }),
      })),
      remainingHostBindings: unboundHostBindings.map((binding) => binding.path),
    },
  };
}

function bundleSourceMarkers(text) {
  return [...new Set([...text.matchAll(/^\/\/ ((?:source|frontend|scripts|src\/app)\/[^\n]+)$/gm)].map(match => match[1]))].sort();
}

async function auditImmutableRendererAssets({ outputRoot, outputPath, outputFiles }) {
  const assets = [];
  const blockers = [];
  for (const [relativePath, record] of Object.entries(IMMUTABLE_RENDERER_ASSET_ALLOWLIST)) {
    const outputFile = path.join(outputPath, relativePath);
    let content = null;
    try {
      content = await readFile(outputFile);
    } catch {
      blockers.push(`missing-immutable-renderer-asset:${relativePath}`);
    }
    const validOutput = content != null && isAllowlistedImmutableRendererAsset(relativePath, content);
    if (content != null && !validOutput) {
      blockers.push(`immutable-renderer-asset-drift:${relativePath}`);
    }
    assets.push({
      path: relativePath,
      manifestFile: record.manifestFile,
      bytes: record.bytes,
      sha256: record.sha256,
      output: content == null ? null : { bytes: content.byteLength, sha256: sha256(content), valid: validOutput },
    });
  }

  const forbiddenOutputAssets = outputFiles.filter((file) => forbiddenImmutableRendererAssets.has(file));
  for (const file of forbiddenOutputAssets) blockers.push(`forbidden-immutable-renderer-asset:${file}`);

  const asarCandidates = [
    path.join(path.dirname(outputRoot), "app.asar"),
    path.join(outputRoot, "app.asar"),
  ];
  let asarPath = null;
  for (const candidate of asarCandidates) {
    try {
      await stat(candidate);
      asarPath = candidate;
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  let asar = { path: asarPath, status: "not-present", assets: [] };
  if (asarPath != null) {
    const listing = new Set(listPackage(asarPath));
    const packagedAssets = [];
    for (const [relativePath, record] of Object.entries(IMMUTABLE_RENDERER_ASSET_ALLOWLIST)) {
      const packagedPath = `dist/renderer/${relativePath}`;
      const listed = listing.has(`/${packagedPath}`) && !listing.has(`/${packagedPath}.unpacked`);
      let packaged = null;
      if (listed) {
        packaged = extractFile(asarPath, packagedPath);
        if (!isAllowlistedImmutableRendererAsset(relativePath, packaged)) {
          blockers.push(`immutable-renderer-asset-asar-drift:${relativePath}`);
        }
      } else {
        blockers.push(`missing-immutable-renderer-asset-asar-placement:${relativePath}`);
      }
      packagedAssets.push({
        path: relativePath,
        listed,
        ...(packaged == null ? {} : { bytes: packaged.byteLength, sha256: sha256(packaged) }),
      });
    }
    asar = { path: asarPath, status: "verified", assets: packagedAssets };
  }

  return { assets, asar, blockers };
}

async function cleanRuntimeVerdicts(outputRoot, requireOutputs, runtimeNames = null, composition = runtimeComposition) {
  const verdicts = [];
  for (const runtime of composition) {
    if (runtime.mode !== "clean-source") continue;
    if (runtimeNames != null && !runtimeNames.has(runtime.runtime)) continue;
    const isRenderer = runtime.runtime === "renderer";
    const graph = await sourceGraph(runtime.entrypoint ?? runtime.source, isRenderer ? {
      platform: "browser",
      format: "esm",
      // The graph audit only needs every asset to resolve so it shows up as an
      // input; how it would be emitted is Vite's business, not esbuild's.
      loader: { ".css": "empty", ".woff2": "dataurl", ".wav": "dataurl" },
    } : {});
    const outputPath = outputRoot == null ? null : path.join(outputRoot, runtime.path);
    if (isRenderer) {
      let provenance = null;
      let outputFiles = [];
      let jsChunks = [];
      if (outputPath != null) {
        try {
          provenance = JSON.parse(await readFile(path.join(outputRoot, runtime.provenance), "utf8"));
          outputFiles = await walk(outputPath);
          jsChunks = await Promise.all(outputFiles.filter(file => file.endsWith(".js")).map(async file => ({
            file,
            text: await readFile(path.join(outputPath, file), "utf8"),
          })));
        } catch (error) {
          if (requireOutputs) throw new Error(`Cannot call renderer clean: missing output ${runtime.path}`, { cause: error });
        }
      }
      const immutableAudit = outputPath == null ? { assets: [], asar: { status: "not-evaluated", assets: [] }, blockers: [] } : await auditImmutableRendererAssets({ outputRoot, outputPath, outputFiles });
      const missingBanners = jsChunks.filter(({ file, text }) => (
        !text.includes(`"Deterministic clean-source renderer: ${runtime.entrypoint}";`)
        && !isAllowlistedImmutableRendererAsset(file, text)
      )).map(({ file }) => file);
      const blockers = [
        ...graph.forbiddenEvidenceInputs.map(input => `source-graph:${input}`),
        ...(requireOutputs && provenance == null ? ["missing-renderer-provenance"] : []),
        ...(provenance != null && provenance.mode !== "clean-source" ? ["invalid-renderer-provenance-mode"] : []),
        ...(provenance?.graph?.forbiddenInputs ?? []).map(input => `provenance-source-graph:${input}`),
        ...immutableAudit.blockers,
        ...missingBanners.map(file => `missing-clean-source-build-banner:${file}`),
        ...(requireOutputs && !outputFiles.includes("index.html") ? ["missing-renderer-index"] : []),
      ];
      verdicts.push({
        runtime: runtime.runtime,
        declaration: runtime.mode,
        graph,
        output: provenance == null ? { path: runtime.path, status: "not-evaluated" } : {
          path: runtime.path,
          status: "evaluated",
          files: outputFiles.length,
          jsChunks: jsChunks.length,
          provenance: runtime.provenance,
          provenanceSha256: sha256(await readFile(path.join(outputRoot, runtime.provenance))),
          forbiddenEvidenceMarkers: [],
          forbiddenEvidenceReferences: [],
          missingCleanSourceBanners: missingBanners,
          immutableAssets: immutableAudit.assets,
          immutableAssetAsar: immutableAudit.asar,
        },
        blockers,
        verdict: provenance == null && !requireOutputs ? "not-evaluated" : blockers.length === 0 ? "clean" : "blocked",
      });
      continue;
    }
    let output = null;
    if (outputPath != null) {
      try {
        output = await readFile(outputPath, "utf8");
      } catch (error) {
        if (requireOutputs) throw new Error(`Cannot call ${runtime.runtime} clean: missing output ${runtime.path}`, { cause: error });
      }
    }
    const bundleMarkers = output == null ? [] : bundleSourceMarkers(output);
    const forbiddenBundleMarkers = bundleMarkers.filter(marker => marker === "src/app" || marker.startsWith(forbiddenEvidencePrefix));
    const forbiddenOutputReferences = output == null ? [] : [
      ...new Set([...output.matchAll(/(?:^|[^A-Za-z0-9_-])(src\/app\/[A-Za-z0-9_./-]+)/g)].map(match => match[1])),
    ].sort();
    const blockers = [
      ...graph.forbiddenEvidenceInputs.map(input => `source-graph:${input}`),
      ...forbiddenBundleMarkers.map(input => `bundle-marker:${input}`),
      ...forbiddenOutputReferences.map(input => `bundle-reference:${input}`),
      ...(output != null
        && !output.includes("Deterministic clean-source")
        && !(runtime.runtime === "box-exec-daemon" && output.startsWith("// Reconstructed loopback box exec-daemon; Connect/protobuf transport, no desktop local-exec dependency."))
        ? ["missing-clean-source-build-banner"]
        : []),
      ...(requireOutputs && output == null ? ["missing-output"] : []),
    ];
    verdicts.push({
      runtime: runtime.runtime,
      declaration: runtime.mode,
      graph,
      output: output == null ? { path: runtime.path, status: "not-evaluated" } : {
        path: runtime.path,
        bytes: Buffer.byteLength(output),
        sha256: sha256(output),
        bundleSourceMarkers: bundleMarkers,
        forbiddenEvidenceMarkers: forbiddenBundleMarkers,
        forbiddenEvidenceReferences: forbiddenOutputReferences,
      },
      verdict: blockers.length === 0 && output != null ? "clean" : output == null && !requireOutputs ? "not-evaluated" : "rejected",
      blockers,
    });
  }
  const rejected = verdicts.filter(item => item.verdict === "rejected");
  if (rejected.length > 0) {
    throw new Error(`Fail-closed runtime composition audit rejected: ${rejected.map(item => `${item.runtime} (${item.blockers.join(", ")})`).join("; ")}`);
  }
  return verdicts;
}

async function checksumPinnedRendererVerdict(outputRoot, requireOutputs, declaration) {
  if (declaration?.mode !== "checksum-pinned-artifact-runtime") return null;
  if (outputRoot == null) return {
    declaration: declaration.mode,
    verdict: "not-evaluated",
    blockers: ["renderer-artifact-provenance-not-evaluated"],
  };
  const blockers = [];
  let provenance = null;
  try {
    provenance = JSON.parse(await readFile(path.join(outputRoot, declaration.provenance), "utf8"));
  } catch (error) {
    if (requireOutputs) throw new Error("Checksum-pinned renderer provenance is missing", { cause: error });
    blockers.push("missing-renderer-artifact-provenance");
  }
  const expectedRoot = "src/app/dist/renderer";
  if (provenance != null) {
    if (provenance.mode !== declaration.mode) blockers.push("renderer-artifact-provenance-mode-drift");
    if (provenance.artifactRoot !== expectedRoot || declaration.artifactRoot !== expectedRoot) blockers.push("renderer-artifact-root-drift");
    const artifactRoot = path.join(repoRoot, expectedRoot);
    const files = [];
    for (const relative of await walk(artifactRoot)) {
      const bytes = await readFile(path.join(artifactRoot, relative));
      files.push({ path: relative, bytes: bytes.byteLength, sha256: sha256(bytes) });
    }
    const inventorySha256 = sha256(JSON.stringify(files));
    if (JSON.stringify(provenance.files) !== JSON.stringify(files)) blockers.push("renderer-artifact-file-inventory-drift");
    if (provenance.fileCount !== files.length) blockers.push("renderer-artifact-file-count-drift");
    if (provenance.inventorySha256 !== inventorySha256) blockers.push("renderer-artifact-inventory-hash-drift");
  }
  const verdict = blockers.length === 0 ? "verified" : "rejected";
  if (requireOutputs && verdict === "rejected") {
    throw new Error(`Fail-closed checksum-pinned renderer audit rejected: ${blockers.join(", ")}`);
  }
  return {
    declaration: declaration.mode,
    provenance: declaration.provenance,
    artifactRoot: declaration.artifactRoot,
    fileCount: provenance?.fileCount ?? 0,
    inventorySha256: provenance?.inventorySha256 ?? null,
    verdict,
    blockers,
  };
}

export async function assertCleanRuntimeClosures({ outputRoot, runtimes = null, composition = runtimeComposition }) {
  if (outputRoot == null) throw new TypeError("assertCleanRuntimeClosures requires outputRoot");
  return cleanRuntimeVerdicts(outputRoot, true, runtimes == null ? null : new Set(runtimes), composition);
}

export async function createRuntimeCompositionAudit({ outputRoot = null, requireOutputs = outputRoot != null, composition = runtimeComposition, hostActivation = null, electronMainActivation = null } = {}) {
  const effectiveHostActivation = hostActivation ?? await assembleHostProductionBindingManifest();
  const hostBindingStatus = new Map((effectiveHostActivation.inventory ?? []).map(item => [item.path, item.status]));
  const productionBindingStatus = bindingPath => hostBindingStatus.get(bindingPath) === "bound"
    ? "validated-recovered-production-binding"
    : "mandatory-production-binding-unbound";
  const cleanExports = await exportedSymbols();
  const electronAdapterEvidence = await electronProductionAdapterEvidence();
  const runtimes = {};
  let hostEntrypointGraph = null;
  for (const [runtimeName, spec] of Object.entries(runtimeSpecs)) {
    const sourceText = await readFile(path.join(repoRoot, spec.entrypoint), "utf8");
    const artifactText = await readFile(path.join(repoRoot, spec.artifact), "utf8");
    const members = interfaceMembers(sourceText, spec.entrypoint, spec.contract);
    const declaredMode = composition.find(runtime => runtime.runtime === runtimeName)?.mode ?? null;
    const cleanActivated = declaredMode === "clean-source";
    const catalogNames = Object.keys(spec.requirements).sort();
    const memberNames = members.map(member => member.name).sort();
    if (JSON.stringify(catalogNames) !== JSON.stringify(memberNames)) {
      throw new Error(`${runtimeName} audit catalog drifted from ${spec.contract}: contract=${memberNames.join(",")} catalog=${catalogNames.join(",")}`);
    }
    const requirements = members.map(member => {
      let [status, cleanProvider, needle] = spec.requirements[member.name];
      if (runtimeName === "host" && member.name === "executeBoxCopyInFromEnv") {
        status = productionBindingStatus("ports.executeBoxCopyInFromEnv");
      }
      return {
        ...member,
        status,
        cleanProvider,
        artifactAnchor: anchorFor(artifactText, spec.artifact, needle, artifactText.lastIndexOf(spec.artifactSourceMarker)),
      };
    });
    const nestedContracts = [];
    for (const contractSpec of spec.nestedContracts) {
      const contract = contractSpec.interface;
      const nestedFile = contractSpec.source;
      const nestedText = nestedFile === spec.entrypoint ? sourceText : await readFile(path.join(repoRoot, nestedFile), "utf8");
      nestedContracts.push({
        interface: contract,
        source: nestedFile,
        requirements: interfaceMembers(nestedText, nestedFile, contract).map(member => {
          let status = member.optional ? "clean-default-or-optional" : "missing-composite-binding";
          if (runtimeName === "electron-main") {
            if (contract === "ElectronMainServices") status = "clean-composed-service-surface";
            else if (contract === "ElectronProductionServiceFactories") status = "clean-grouped-adapter-composition";
            else if (contract === "ElectronProductionAdapterBindings") status = member.optional ? "clean-default-or-optional" : cleanActivated ? "validated-generated-or-external-binding" : "generated-or-external-binding-manifest-required";
          }
          if (runtimeName === "host" && !member.optional) {
            if (contract === "ProductionSandHostPorts" && member.name === "extensionsById") status = "clean-recovered-extension-registry";
            else if (contract === "ProductionSandHostPorts" && member.name === "extensionHost") status = "composed-from-mandatory-extension-host-bindings";
            else if (contract === "ProductionSandHostPorts") status = productionBindingStatus(`ports.${member.name}`);
            else if (contract === "ProductionExtensionHostAdapters") status = productionBindingStatus(`ports.extensionHost.${member.name}`);
            else if (contract === "RecoveredProductionExtensionBindings") status = productionBindingStatus(`extensionBindings.${member.name}`);
            else status = cleanActivated ? "validated-generated-or-external-binding" : "generated-binding-manifest-required";
          }
          return { ...member, status };
        }),
      });
    }
    const artifactBytes = Buffer.from(artifactText);
    const cleanEntrypointGraph = await sourceGraph(spec.entrypoint);
    if (runtimeName === "host") hostEntrypointGraph = cleanEntrypointGraph;
    runtimes[runtimeName] = {
      declaredMode,
      verdict: cleanActivated ? "clean-source" : "blocked-artifact-fallback",
      cleanEntrypointGraph,
      compositionContract: { interface: spec.contract, source: spec.entrypoint, requirements, nestedContracts },
      blockers: cleanActivated ? [] : spec.blockers,
      ...(runtimeName === "electron-main" ? { bindingManifest: electronMainActivation ?? { status: "not-supplied", clean: false, requiredBindings: requiredElectronMainProductionBindings } } : {}),
      ...(runtimeName === "electron-main" ? { productionAdapterGraph: electronAdapterEvidence } : {}),
      ...(runtimeName === "host" ? { bindingManifest: effectiveHostActivation } : {}),
      constructorFactoryClosure: factoryInventory(artifactText, spec.artifact, spec.artifactSourceMarker, cleanExports),
      generatedBindingClosure: generatedBindings(artifactText, spec.artifact),
      externalRuntimeBoundaries: externalRequires(artifactText, spec.artifact),
      artifact: {
        path: spec.artifact,
        bytes: artifactBytes.byteLength,
        sha256: sha256(artifactBytes),
        compositionAnchor: anchorFor(artifactText, spec.artifact, spec.artifactSourceMarker, artifactText.lastIndexOf(spec.artifactSourceMarker)),
      },
    };
  }

  if (hostEntrypointGraph == null) throw new Error("Host entrypoint graph was not audited");
  const hostMode = composition.find(runtime => runtime.runtime === "host")?.mode ?? null;
  const hostProductionExtensionsGraph = await sourceGraph("source/host/host-production-extensions.ts");
  const runnerComposition = await runnerCompositionClosure({ hostGraph: hostEntrypointGraph, hostProductionExtensionsGraph, hostActivation: effectiveHostActivation, hostMode });

  const cleanRuntimeAssertions = await cleanRuntimeVerdicts(outputRoot, requireOutputs, null, composition);
  const rendererDeclaration = composition.find(runtime => runtime.runtime === "renderer") ?? null;
  const rendererAssertion = cleanRuntimeAssertions.find(runtime => runtime.runtime === "renderer") ?? null;
  const rendererArtifactAssertion = await checksumPinnedRendererVerdict(outputRoot, requireOutputs, rendererDeclaration);
  const rendererBootstrap = JSON.parse(await readFile(path.join(repoRoot, "frontend/manifests/renderer-bootstrap.json"), "utf8"));
  const rendererClosure = JSON.parse(await readFile(path.join(repoRoot, "manifests/reconstruction/renderer-closure.json"), "utf8"));
  let rendererProvenance = null;
  if (outputRoot != null && rendererDeclaration?.provenance != null) {
    try {
      rendererProvenance = JSON.parse(await readFile(path.join(outputRoot, rendererDeclaration.provenance), "utf8"));
    } catch (error) {
      if (requireOutputs) throw new Error("Renderer production provenance is missing", { cause: error });
    }
  }
  const rendererComposition = {
    declaration: rendererDeclaration,
    sourceEntrypoint: rendererDeclaration?.entrypoint ?? null,
    immutableBootstrap: rendererBootstrap,
    evidenceClosure: {
      report: "manifests/reconstruction/renderer-closure.json",
      status: rendererClosure.verdict?.status ?? null,
      canReplaceShippedBundleWithoutFeatureLoss: rendererClosure.verdict?.canReplaceShippedBundleWithoutFeatureLoss === true,
      composedFeatureSurfaces: rendererClosure.summary?.composedFeatureSurfaces ?? 0,
      shippedFeatureRoutes: rendererClosure.summary?.shippedFeatureRoutes ?? 0,
      findings: rendererClosure.summary?.findings ?? null,
    },
    routeContracts: rendererProvenance?.evidence?.routeContracts ?? [],
    emittedLazyEntries: rendererProvenance?.evidence?.emittedLazyEntries ?? [],
    unsupportedLazyChunks: rendererBootstrap.unsupportedLazyChunks,
    productionActivation: {
      composed: rendererDeclaration?.mode === "clean-source" && rendererAssertion?.verdict === "clean",
      verified: requireOutputs && rendererAssertion?.verdict === "clean",
      blockers: rendererAssertion?.blockers ?? ["renderer-clean-runtime-not-evaluated"],
      provenance: rendererDeclaration?.provenance ?? null,
    },
    artifactRuntimeAcceptance: rendererArtifactAssertion,
  };
  return {
    schemaVersion: 1,
    upstreamVersion: "0.18.0",
    generatedBy: "scripts/audit-runtime-composition.mjs",
    policy: {
      cleanRuntime: "A clean-source declaration is accepted only when its declared entry graph avoids immutable src/app/capsule inputs and its emitted runtime carries deterministic clean-source provenance. Renderer evidence paths may remain as inert provenance strings but never as bundle inputs.",
      fallback: "Recovered orchestration is not an executable clean runtime until every required contract member and nested factory is concretely composed.",
      renderer: "The clean renderer is accepted only when live UI provenance and renderer closure remain finding-free, the 5/5 feature and 11/11 route contracts remain composed, bootstrap anchors are byte-exact, and all five lazy boundaries are independently emitted without src/app/capsule inputs.",
      fidelityRenderer: "A checksum-pinned artifact renderer is accepted only as non-source runtime when its complete shipped-file inventory, byte counts, and SHA-256 hashes match src/app/dist/renderer exactly. This does not satisfy or bypass clean-source renderer policy.",
    },
    runtimeComposition: composition,
    rendererComposition,
    runnerComposition,
    cleanRuntimeAssertions,
    replacementClosures: runtimes,
    nativeRuntimeBoundaries: await nativeRuntimeInventory(),
    summary: {
      cleanAccepted: cleanRuntimeAssertions.filter(item => item.verdict === "clean").map(item => item.runtime),
      cleanNotEvaluated: cleanRuntimeAssertions.filter(item => item.verdict === "not-evaluated").map(item => item.runtime),
      blockedFallbacks: Object.entries(runtimes).filter(([, closure]) => closure.verdict === "blocked-artifact-fallback").map(([runtime]) => runtime),
    },
  };
}

export async function writeRuntimeCompositionAudit({ outputRoot, requireOutputs = true, composition = runtimeComposition, hostActivation = null, electronMainActivation = null } = {}) {
  if (outputRoot == null) throw new TypeError("writeRuntimeCompositionAudit requires outputRoot");
  const audit = await createRuntimeCompositionAudit({ outputRoot, requireOutputs, composition, hostActivation, electronMainActivation });
  const target = path.join(outputRoot, compositionAuditPath);
  await writeFile(target, `${JSON.stringify(audit, null, 2)}\n`);
  return { audit, path: target, sha256: sha256(await readFile(target)) };
}

if (process.argv[1] != null && path.resolve(process.argv[1]) === scriptPath) {
  const outputRoot = process.argv[2] == null ? null : path.resolve(process.argv[2]);
  const audit = await createRuntimeCompositionAudit({ outputRoot, requireOutputs: outputRoot != null });
  process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
}
