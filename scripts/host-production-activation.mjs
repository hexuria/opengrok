import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build as esbuild } from "esbuild";

import { repoRoot } from "./lib/config.mjs";
import { packagedElectronRuntimePackages, retainedElectronNativePackagesFromMetafile } from "./build-electron-natives.mjs";

export const hostBindingProvenancePath = "dist/host-production-bindings.json";

export const requiredHostProductionBindings = Object.freeze([
  "ports.executeBoxCopyInFromEnv",
  "ports.extensionHost.boxGenerated",
  "ports.extensionHost.convertCloudAgentConversationToTrace",
  "ports.runnerContext",
  "ports.createTranscriptMirror",
  "extensionBindings.stateBackstop",
  "extensionBindings.localExecCodec",
  "extensionBindings.secretsContext",
]);

const hostArtifact = "src/app/dist/host/host-main.cjs";
const runnerAuditPath = "manifests/reconstruction/runner-parity-audit.json";

// Capsule presence is not a production dependency criterion. These two
// remaining B5 Shell modules have exact semantic edges in the immutable graph,
// but must be represented by their real consumer inputs rather than imported
// solely to make the parity inventory reachable. B1-closed computer-use,
// remote-box, automation, CloudAgent, listener-card, and subagent edges are
// intentionally absent from this residual catalog.
const conditionalRunnerSemanticGaps = Object.freeze([
  { module: "source/host/runner/sand-auto-review-tool-escalations.ts", reason: "shell/MCP approval-provider projection is absent" },
  { module: "source/host/runner/sand-shell-auto-review-enrichment.ts", reason: "shell approval enrichment input is absent" },
]);
const toolLocalSemanticMismatches = Object.freeze([
  { module: "source/host/runner/tools/tool-input-error.ts", reason: "tool-local invalid-input error identity is not yet exact" },
]);

const unavailableAgentCapabilities = Object.freeze([
  {
    key: "pdfTextExtraction",
    tool: "externalRead",
    status: "fail-closed",
    reason: "the immutable Piscina producer is present, but pdf-worker.{js,ts} is absent from both shipped host carriers",
  },
]);

export const mandatoryLocalExecRuntimeBlockers = Object.freeze([
  {
    key: "localExecShellStreamRuntime",
    reason: "LocalShellStreamExecutor is registered without a concrete ShellExecutionRuntime",
  },
  {
    key: "localExecBackgroundShellRuntime",
    reason: "LocalBackgroundShellExecutor is registered without a concrete BackgroundRuntime",
  },
]);

/**
 * Exact immutable construction/provider evidence for every production seam.
 * A slot is bound only when a complete typed provider export exists. Partial
 * recovered compositions are recorded as candidates, never promoted through
 * a missing generated/native/external constructor input.
 */
export const hostProductionBindingInventorySpecs = Object.freeze([
  { path: "ports.executeBoxCopyInFromEnv", owner: "box-store-sync", artifactAnchors: [{ line: 500598, needle: "async function executeBoxCopyInFromEnv(env = process.env) {" }, { line: 668679, needle: "code = await executeBoxCopyInFromEnv();" }], binding: { classification: "recovered-source", module: "./source/host/extensions/box-store-sync/box-copy-in.ts", export: "executeBoxCopyInFromEnv", access: "value", sourceAnchor: { line: 525, needle: "export async function executeBoxCopyInFromEnv(" } } },
  { path: "ports.extensionHost.boxGenerated", owner: "host-extension", artifactAnchors: [{ line: 614162, needle: "function createContextPropagatingClient(service, transport, options2 = {}) {" }, { line: 614443, needle: "const control = createContextPropagatingClient(ControlService, transport);" }, { line: 614724, needle: "new BoxRemoteExecManager(createContextPropagatingClient(ExecService, transport))" }, { line: 615538, needle: "function createSandBox(options2 = {}) {" }, { line: 615547, needle: "function applySharedDesktop(box, options2 = {}) {" }, { line: 616596, needle: "const box = new HostBox(" }], binding: { classification: "recovered-source", module: "./source/host/box/generated-production.ts", export: "productionBoxGeneratedPorts", access: "value", sourceAnchor: { line: 251, needle: "export const productionBoxGeneratedPorts = createProductionBoxGeneratedPorts(" } } },
  { path: "ports.extensionHost.convertCloudAgentConversationToTrace", owner: "host-extension", artifactAnchors: [{ line: 598288, needle: "const trace2 = convertConversationMessagesToTrace(conversation, HistoryVisibilityMode.NO_PREAMBLE);" }], binding: { classification: "recovered-source", module: "./source/host/production-binding-providers.ts", export: "convertProductionCloudAgentConversationToTrace", access: "value", sourceAnchor: { line: 26, needle: "export function convertProductionCloudAgentConversationToTrace(" } } },
  { path: "ports.runnerContext", owner: "runner", artifactAnchors: [{ line: 665646, needle: "ctx = createContext().with(loggerKey, { log: () => {" }, { line: 668234, needle: "ctx = createContext().with(loggerKey, { log: () => {" }], binding: { classification: "recovered-source", module: "./source/host/runner-context-production-provider.ts", export: "createProductionRunnerContext", access: "call", sourceAnchor: { line: 14, needle: "export function createProductionRunnerContext(): Context {" } } },
  { path: "ports.createTranscriptMirror", owner: "runner", artifactAnchors: [{ line: 652826, needle: "var OffloadingTranscriptMirror = class _OffloadingTranscriptMirror {" }, { line: 652838, needle: "static forTranscriptsDir(pool, options2, previousRootPromptCount = 0) {" }, { line: 667421, needle: "async deriveTurn(ctx, blobStore, turnIndex, currentBlobId, previousBlobId, finalizeTurn = false, deferredStep) {" }, { line: 667919, needle: "transcriptMirror: (transcriptJournal ??= new FileTranscriptMirror(" }], binding: { classification: "recovered-source", module: "./source/host/transcript-mirror/production-provider.ts", export: "createDefaultProductionTranscriptMirrorProvider", access: "call", sourceAnchor: { line: 92, needle: "export function createDefaultProductionTranscriptMirrorProvider(): CreateTranscriptMirror {" } } },
  { path: "extensionBindings.stateBackstop", owner: "host-extension", artifactAnchors: [{ line: 634635, needle: "checkpointSandAgentDb(dbPath);" }, { line: 634636, needle: "return (0, import_node_fs79.readFileSync)(dbPath);" }, { line: 634719, needle: "const backstop = new SandStateBackstop({" }], binding: { classification: "recovered-source", module: "./source/host/production-binding-providers.ts", export: "createProductionStateBackstop", access: "call", sourceAnchor: { line: 18, needle: "export function createProductionStateBackstop():" } } },
  { path: "extensionBindings.localExecCodec", owner: "local-exec", artifactAnchors: [{ line: 617932, needle: "yield ExecClientMessage.fromJson(frame.message, {" }, { line: 617936, needle: "const control = ExecClientControlMessage.fromJson(frame.message, {" }, { line: 617977, needle: "remoteAccessor: new RemoteResourceAccessor(" }, { line: 618469, needle: "box: new GatewayLocalExecSandBox(bridge, { gate, reportFailure })," }], binding: { classification: "recovered-source", module: "./source/host/extensions/local-exec/production.ts", export: "productionLocalExecCodec", access: "value", sourceAnchor: { line: 16, needle: "export const productionLocalExecCodec:" } } },
  { path: "extensionBindings.secretsContext", owner: "host-extension", artifactAnchors: [{ line: 627636, needle: "const ctx = createContext().withName(\"secrets\");" }], binding: { classification: "recovered-source", module: "./source/host/production-binding-providers.ts", export: "productionSecretsContext", access: "value", sourceAnchor: { line: 16, needle: "Parameters<typeof createSecretsExtension>[0] = createContext;" } } },
]);

const classifications = new Set(["recovered-source", "generated-source", "third-party", "native"]);
const localSourceClassifications = new Set(["recovered-source", "generated-source"]);
const accessKinds = new Set(["value", "call"]);
const builtinSet = new Set(builtinModules.flatMap(module => [module, module.replace(/^node:/, ""), `node:${module.replace(/^node:/, "")}`]));
const scriptPath = fileURLToPath(import.meta.url);

async function assembleLocalExecProductionEvidence() {
  const sourcePath = "source/local-exec-daemon/production-executor.ts";
  const [source, shellSource, backgroundSource] = await Promise.all([
    readFile(path.join(repoRoot, sourcePath), "utf8"),
    readFile(path.join(repoRoot, "source/packages/local-exec/shell-stream.ts"), "utf8"),
    readFile(path.join(repoRoot, "source/packages/local-exec/background-shell.ts"), "utf8"),
  ]);
  const shellRuntimeBound = source.includes("new BaseShellCoreExecutor")
    && source.includes("createDefaultTerminalExecutor")
    && !shellSource.includes("MissingShellExecutionBindingError");
  const backgroundRuntimeBound = source.includes("new LocalBackgroundShellExecutor")
    && backgroundSource.includes("class LocalBackgroundShellExecutor")
    && !backgroundSource.includes("MissingBackgroundShellBindingError");
  const blockers = [
    ...(shellRuntimeBound ? [] : [mandatoryLocalExecRuntimeBlockers[0]]),
    ...(backgroundRuntimeBound ? [] : [mandatoryLocalExecRuntimeBlockers[1]]),
  ];
  return {
    status: blockers.length === 0 ? "supported" : "blocked",
    source: sourcePath,
    shellRuntimeBound,
    backgroundRuntimeBound,
    blockers,
    blocker: blockers.length === 0
      ? null
      : `${blockers.length} mandatory local-exec runtime bindings remain fail-closed: ${blockers.map(item => item.key).join(", ")}`,
  };
}

function normalize(value) {
  return value.split(path.sep).join("/");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function packageName(specifier) {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0];
}

function assertRepoLocalGeneratedModule(manifestPath, specifier) {
  if (!specifier.startsWith(".")) {
    throw new Error(`Generated host binding modules must be manifest-relative: ${specifier}`);
  }
  const absolute = path.resolve(path.dirname(manifestPath), specifier);
  const relative = normalize(path.relative(repoRoot, absolute));
  if (relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error(`Generated host binding module escapes the repository: ${specifier}`);
  }
  for (const forbidden of ["src/app/", "recovered/source-capsules/", "dist/deps/", ".build/app/"]) {
    if (relative === forbidden.slice(0, -1) || relative.startsWith(forbidden)) {
      throw new Error(`Generated host binding module uses a forbidden artifact/first-party fallback path: ${relative}`);
    }
  }
  if (!(relative === "source" || relative.startsWith("source/"))) {
    throw new Error(`Local host binding modules must live under reviewed source/: ${relative}`);
  }
  return { absolute, relative };
}

function bindingExpression(bindings, key) {
  const index = bindings.findIndex(binding => binding.path === key);
  if (index < 0) throw new Error(`Internal host binding lookup failed: ${key}`);
  return bindings[index].access === "call" ? `binding${index}()` : `binding${index}`;
}

function productionEntrySource(bindings) {
  const imports = bindings.map((binding, index) => {
    const imported = binding.export === "default" ? `binding${index}` : `{ ${binding.export} as binding${index} }`;
    return `import ${imported} from ${JSON.stringify(binding.resolvedModule)};`;
  });
  const extensionHostKeys = [
    "boxGenerated",
    "convertCloudAgentConversationToTrace",
  ];
  const extensionBindingKeys = requiredHostProductionBindings
    .filter(key => key.startsWith("extensionBindings."))
    .map(key => key.slice("extensionBindings.".length));
  return `${imports.join("\n")}
import { startProductionHost } from "./source/host/main.ts";
import { bindRecoveredProductionExtensions } from "./source/host/host-production-extensions.ts";

const ports = {
  executeBoxCopyInFromEnv: ${bindingExpression(bindings, "ports.executeBoxCopyInFromEnv")},
  extensionHost: {
${extensionHostKeys.map(key => `    ${key}: ${bindingExpression(bindings, `ports.extensionHost.${key}`)},`).join("\n")}
  },
  runnerContext: ${bindingExpression(bindings, "ports.runnerContext")},
  createTranscriptMirror: ${bindingExpression(bindings, "ports.createTranscriptMirror")},
};
const extensionBindings = {
${extensionBindingKeys.map(key => `  ${key}: ${bindingExpression(bindings, `extensionBindings.${key}`)},`).join("\n")}
};

void startProductionHost(bindRecoveredProductionExtensions(ports, extensionBindings)).catch((error) => {
  process.stderr.write("[sand-host] fatal: " + String(error) + "\\n");
  process.exitCode = 1;
});
`;
}

const firstPartyArtifactSourceMarker = /^\/\/ (src\/[^\s]+|\.\.\/packages\/[^\s]+)$/;

export function artifactSourceMarkerAt(lines, line) {
  for (let index = line - 1; index >= 0; index -= 1) {
    const match = lines[index]?.match(firstPartyArtifactSourceMarker);
    if (match != null) return match[1];
  }
  return null;
}

async function validateArtifactAnchor(anchor, artifactText) {
  if (anchor == null || (anchor.artifact ?? hostArtifact) !== hostArtifact || !Number.isInteger(anchor.line) || anchor.line < 1 || typeof anchor.needle !== "string" || anchor.needle.length === 0) {
    throw new Error("Every host production binding requires an exact host artifact anchor");
  }
  const lines = artifactText.split("\n");
  const line = lines[anchor.line - 1] ?? "";
  if (!line.includes(anchor.needle)) {
    throw new Error(`Host binding artifact anchor drifted at ${hostArtifact}:${anchor.line}: ${anchor.needle}`);
  }
  const sourceMarker = artifactSourceMarkerAt(lines, anchor.line);
  if (sourceMarker == null) throw new Error(`Host binding artifact anchor has no immutable source marker at ${hostArtifact}:${anchor.line}`);
  if (anchor.sourceMarker != null && anchor.sourceMarker !== sourceMarker) {
    throw new Error(`Host binding artifact source marker drifted at ${hostArtifact}:${anchor.line}: ${anchor.sourceMarker}`);
  }
  return { artifact: hostArtifact, line: anchor.line, sourceMarker, needle: anchor.needle };
}

async function validateLocalSourceAnchor(binding, resolved) {
  const anchor = binding.sourceAnchor;
  if (anchor == null || !Number.isInteger(anchor.line) || anchor.line < 1 || typeof anchor.needle !== "string" || anchor.needle.length === 0) {
    throw new Error(`Local host binding ${binding.path} requires an exact sourceAnchor`);
  }
  const text = await readFile(resolved.absolute, "utf8");
  const firstMatch = text.indexOf(anchor.needle);
  if (firstMatch < 0) {
    throw new Error(`Host binding source anchor drifted at ${resolved.relative}: ${anchor.needle}`);
  }
  if (text.indexOf(anchor.needle, firstMatch + anchor.needle.length) >= 0) {
    throw new Error(`Host binding source anchor is ambiguous at ${resolved.relative}: ${anchor.needle}`);
  }
  const line = text.slice(0, firstMatch).split("\n").length;
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
      sourcefile: "scripts/build-entry/validate-host-binding-export.mjs",
    },
    write: false,
  });
  return { source: resolved.relative, line, needle: anchor.needle };
}

async function validateRecoveredCandidate(slotPath, candidate) {
  if (candidate == null || typeof candidate.module !== "string" || !candidate.module.startsWith("source/") || typeof candidate.export !== "string") {
    throw new Error(`Invalid recovered candidate for ${slotPath}`);
  }
  const absolute = path.resolve(repoRoot, candidate.module);
  const relative = normalize(path.relative(repoRoot, absolute));
  if (relative !== candidate.module || relative.startsWith("../")) {
    throw new Error(`Recovered candidate escapes reviewed source for ${slotPath}: ${candidate.module}`);
  }
  const sourceAnchor = await validateLocalSourceAnchor(
    { path: slotPath, export: candidate.export, sourceAnchor: candidate.sourceAnchor },
    { absolute, relative },
  );
  return { ...candidate, sourceAnchor };
}

async function validateBinding(binding, baseManifestPath, artifactText, runtimePackages) {
  if (!requiredHostProductionBindings.includes(binding?.path)) {
    throw new Error(`Unknown host production binding path: ${binding?.path}`);
  }
  if (!classifications.has(binding.classification)) throw new Error(`Invalid host binding classification for ${binding.path}: ${binding.classification}`);
  if (!accessKinds.has(binding.access)) throw new Error(`Invalid host binding access for ${binding.path}: ${binding.access}`);
  if (typeof binding.module !== "string" || typeof binding.export !== "string" || !/^(?:default|[A-Za-z_$][\w$]*)$/.test(binding.export)) {
    throw new Error(`Invalid host binding module/export for ${binding.path}`);
  }
  const rawAnchors = binding.artifactAnchors ?? (binding.artifactAnchor == null ? null : [binding.artifactAnchor]);
  if (!Array.isArray(rawAnchors) || rawAnchors.length === 0) {
    throw new Error(`Host binding ${binding.path} requires one or more artifactAnchors`);
  }
  const artifactAnchors = [];
  for (const anchor of rawAnchors) artifactAnchors.push(await validateArtifactAnchor(anchor, artifactText));

  let resolvedModule;
  let sourceAnchor;
  if (localSourceClassifications.has(binding.classification)) {
    const resolved = assertRepoLocalGeneratedModule(baseManifestPath, binding.module);
    await stat(resolved.absolute);
    sourceAnchor = await validateLocalSourceAnchor(binding, resolved);
    resolvedModule = resolved.absolute;
  } else {
    if (binding.module.startsWith(".") || path.isAbsolute(binding.module) || binding.module.includes("src/app") || binding.module.includes("dist/deps")) {
      throw new Error(`Runtime host binding must use an approved bare package specifier: ${binding.module}`);
    }
    const dependency = packageName(binding.module);
    if (!runtimePackages.copied.has(dependency)) throw new Error(`Host binding package is absent from the immutable runtime dependency manifest: ${dependency}`);
    if (binding.classification === "native" && !runtimePackages.native.has(dependency)) {
      throw new Error(`Host binding classified native has no immutable .node payload: ${dependency}`);
    }
    resolvedModule = binding.module;
  }
  const { artifactAnchor: _legacyAnchor, ...rest } = binding;
  return { ...rest, artifactAnchors, ...(sourceAnchor == null ? {} : { sourceAnchor }), resolvedModule };
}

async function runtimeBindingPackages() {
  return packagedElectronRuntimePackages();
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function assembleExternalReadProductionEvidence() {
  const artifactText = await readFile(path.join(repoRoot, hostArtifact), "utf8");
  const producerAnchors = [];
  for (const anchor of [
    { line: 578037, needle: 'resolveWorkerLocation(__import_meta_url, "pdf-worker")' },
    { line: 578042, needle: "_pdfWorkerPool = new Piscina({" },
    { line: 578052, needle: "const params = { bytes };" },
    { line: 578054, needle: "`./pdf-worker.${extension2}`" },
    { line: 578056, needle: "return result.text;" },
    { line: 663309, needle: 'createReadTool(props.resourceAccessor, SAND_READ_FORMATTING_OPTIONS, "latest", {' },
  ]) producerAnchors.push(await validateArtifactAnchor(anchor, artifactText));

  const manifest = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(path.join(repoRoot, "package-lock.json"), "utf8"));
  const lockedPiscina = lock.packages?.["node_modules/piscina"];
  if (manifest.dependencies?.piscina !== "4.9.0" || lockedPiscina?.version !== "4.9.0") {
    throw new Error("ExternalRead Piscina package identity drifted from immutable producer version 4.9.0");
  }
  const workerCandidates = ["js", "ts", "cjs", "mjs"].map(extension =>
    normalize(path.join("src/app/dist/host", `pdf-worker.${extension}`))
  );
  const presentWorkers = [];
  for (const candidate of workerCandidates) {
    if (await pathExists(path.join(repoRoot, candidate))) presentWorkers.push(candidate);
  }
  if (presentWorkers.length > 0) {
    throw new Error(`Unexpected backend PDF worker carrier requires contract review: ${presentWorkers.join(", ")}`);
  }

  return {
    externalRead: {
      status: "supported",
      factory: await sourceNeedleAnchor(
        "source/host/host-runner-composition.ts",
        "createExternalReadToolInputs: (_turn, props): TurnReadToolFactoryInput => ({",
      ),
      owner: await sourceNeedleAnchor(
        "source/packages/agent/tools/core/read/read.ts",
        "export function createReadTool(",
      ),
    },
    pdfTextExtraction: {
      status: "blocked-missing-shipped-worker",
      failure: await sourceNeedleAnchor(
        "source/packages/agent/tools/core/read/read.ts",
        'if (extractor === undefined) throw new TypeError("Read PDF worker is not bound");',
      ),
      producer: {
        artifact: hostArtifact,
        anchors: producerAnchors,
        input: "{ bytes: Uint8Array }",
        output: "{ text: string }",
        workerBasename: "pdf-worker",
        resolvedExtensions: ["ts", "js"],
      },
      package: {
        name: "piscina",
        version: "4.9.0",
        lockIntegrity: lockedPiscina.integrity,
      },
      workerPayload: {
        status: "absent",
        searched: workerCandidates,
      },
    },
  };
}

async function sourceNeedleAnchor(source, needle) {
  const text = await readFile(path.join(repoRoot, source), "utf8");
  const offset = text.indexOf(needle);
  if (offset < 0) throw new Error(`Runner activation evidence drifted at ${source}: ${needle}`);
  return { source, line: text.slice(0, offset).split("\n").length, needle };
}

async function assembleRunnerActivationEvidence(inventory) {
  const auditBytes = await readFile(path.join(repoRoot, runnerAuditPath));
  const audit = JSON.parse(auditBytes.toString("utf8"));
  if (!Array.isArray(audit.modules) || audit.modules.length !== audit.summary?.modulesAudited) {
    throw new Error("Runner activation audit has inconsistent module inventory");
  }
  const auditedModules = new Set(audit.modules.map(module => module.cleanSource));
  if ([...auditedModules].some(source => typeof source !== "string" || !source.startsWith("source/host/runner/"))) {
    throw new Error("Runner activation audit contains an invalid clean module path");
  }
  const graph = await esbuild({
    absWorkingDir: repoRoot,
    bundle: true,
    entryPoints: ["source/host/main.ts"],
    format: "esm",
    logLevel: "silent",
    metafile: true,
    packages: "external",
    platform: "node",
    write: false,
  });
  const hostInputs = new Set(Object.keys(graph.metafile.inputs).map(input => normalize(input)));
  const reachableModules = [...auditedModules].filter(source => hostInputs.has(source)).sort();
  const outsideHostGraph = [...auditedModules].filter(source => !hostInputs.has(source)).sort();
  const semanticGaps = conditionalRunnerSemanticGaps.filter(
    gap => outsideHostGraph.includes(gap.module),
  );
  const toolLocalMismatches = toolLocalSemanticMismatches.filter(
    gap => outsideHostGraph.includes(gap.module),
  );
  const runnerBindingPaths = ["ports.runnerContext", "ports.createTranscriptMirror"];
  const blockingBindings = runnerBindingPaths.filter(bindingPath =>
    inventory.find(item => item.path === bindingPath)?.status !== "bound"
  );
  const providerAnchors = [
    await sourceNeedleAnchor("source/host/runner/turn-agent-composition.ts", "export function createTurnAgentComposition("),
    await sourceNeedleAnchor("source/host/runner/tools/turn-toolset.ts", "export function buildTurnTools("),
    await sourceNeedleAnchor("source/host/runner/sand-agent-runner.ts", "if (this.#productionTurnRunShell !== undefined) {"),
  ];
  const providerModules = providerAnchors.map(anchor => anchor.source);
  const recoveredProvidersReachable = providerModules.every(source => hostInputs.has(source));
  const hostRunnerSource = "source/host/host-runner-composition.ts";
  const hostRunnerText = await readFile(path.join(repoRoot, hostRunnerSource), "utf8");
  const runnerOptionsStart = hostRunnerText.indexOf("const runnerOptions:");
  const buildRunnerNeedle = "const runner = deps.buildRunner(runnerOptions);";
  const buildRunnerOffset = hostRunnerText.indexOf(buildRunnerNeedle, runnerOptionsStart);
  if (runnerOptionsStart < 0 || buildRunnerOffset < 0) {
    throw new Error("Runner activation evidence cannot locate the production runnerOptions composition");
  }
  const productionTurnRunShellConnected = /runnerOptions\.productionTurnRunShell\s*=/.test(hostRunnerText.slice(runnerOptionsStart, buildRunnerOffset));
  const productionRunStep = {
    status: productionTurnRunShellConnected ? "connected" : "blocked",
    connected: productionTurnRunShellConnected,
    buildRunnerAnchor: await sourceNeedleAnchor(hostRunnerSource, buildRunnerNeedle),
    optionalGuardAnchor: await sourceNeedleAnchor(
      "source/host/runner/sand-agent-runner.ts",
      "if (this.options.runStep == null) return undefined;",
    ),
  };
  const externalReadProduction = await assembleExternalReadProductionEvidence();
  const supported = blockingBindings.length === 0
    && semanticGaps.length === 0
    && recoveredProvidersReachable
    && productionTurnRunShellConnected
    && externalReadProduction.externalRead.status === "supported";
  const blockerReasons = [
    ...(!productionTurnRunShellConnected ? ["production runnerOptions do not connect the recovered turn-run-shell owner"] : []),
    ...(blockingBindings.length > 0 ? [`${blockingBindings.length} mandatory Runner bindings remain unbound`] : []),
    ...(semanticGaps.length > 0 ? [`${semanticGaps.length} conditional Runner semantic edges remain unrepresented: ${semanticGaps.map(gap => gap.reason).join("; ")}`] : []),
    ...(!recoveredProvidersReachable ? ["recovered real turn provider modules are outside the production host graph"] : []),
    ...(externalReadProduction.externalRead.status === "supported" ? [] : ["ExternalRead factory is not production-bound"]),
  ];
  return {
    runnerRealTurn: {
      status: supported ? "supported" : "blocked",
      composition: {
        status: recoveredProvidersReachable
          ? "recovered-real-turn-providers-host-reachable"
          : "recovered-real-turn-provider-reachability-blocked",
        providers: providerAnchors,
      },
      productionRunStep,
      unavailableCapabilities: unavailableAgentCapabilities,
      externalReadProduction,
      mandatoryBindings: runnerBindingPaths,
      blockingBindings,
      runtimeAudit: {
        path: runnerAuditPath,
        sha256: sha256(auditBytes),
        executableCleanModules: audit.summary.modulesAudited,
        highFindings: audit.summary.high,
        directlyBehaviorTested: audit.summary.directlyBehaviorTested,
      },
      hostGraph: {
        entrypoint: "source/host/main.ts",
        reachableRunnerModules: reachableModules.length,
        totalRunnerModules: auditedModules.size,
        outsideHostGraph: outsideHostGraph.length,
        outsideHostGraphModules: outsideHostGraph,
        conditionalSemanticGaps: semanticGaps,
        toolLocalSemanticMismatches: toolLocalMismatches,
      },
      blocker: supported ? null : `${blockerReasons.join("; ")}.`,
    },
  };
}

/** Assembles built-in recovered providers with an optional residual manifest. */
export async function assembleHostProductionBindingManifest(manifestPath = null) {
  const artifactText = await readFile(path.join(repoRoot, hostArtifact), "utf8");
  const runtimePackages = await runtimeBindingPackages();
  const catalogPath = path.join(repoRoot, "host-production-bindings.catalog.json");
  const supplied = [];
  let suppliedManifestPath = null;
  let suppliedManifestSha256 = null;
  if (manifestPath != null) {
    const absoluteManifest = path.resolve(repoRoot, manifestPath);
    const manifestBytes = await readFile(absoluteManifest);
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.bindings)) {
      throw new Error("Host production binding manifest must use schemaVersion 1 and a bindings array");
    }
    suppliedManifestPath = normalize(path.relative(repoRoot, absoluteManifest));
    suppliedManifestSha256 = sha256(manifestBytes);
    for (const binding of manifest.bindings) supplied.push(await validateBinding(binding, absoluteManifest, artifactText, runtimePackages));
  }

  const builtIn = [];
  const inventory = [];
  for (const spec of hostProductionBindingInventorySpecs) {
    const artifactAnchors = [];
    for (const anchor of spec.artifactAnchors) artifactAnchors.push(await validateArtifactAnchor(anchor, artifactText));
    const recoveredCandidate = spec.recoveredCandidate == null
      ? null
      : await validateRecoveredCandidate(spec.path, spec.recoveredCandidate);
    if (spec.binding != null) {
      builtIn.push(await validateBinding({ path: spec.path, ...spec.binding, artifactAnchors }, catalogPath, artifactText, runtimePackages));
    }
    inventory.push({
      path: spec.path,
      owner: spec.owner,
      mandatory: true,
      artifactAnchors,
      ...(recoveredCandidate == null ? {} : { recoveredCandidate }),
      ...(spec.blocker == null ? {} : { blocker: spec.blocker }),
    });
  }

  const allBindings = [...builtIn, ...supplied];
  const duplicates = [...new Set(allBindings.map(binding => binding.path).filter((value, index, values) => values.indexOf(value) !== index))];
  if (duplicates.length > 0) throw new Error(`Host production binding manifest duplicates evidence-derived bindings: ${duplicates.join(",")}`);
  const byPath = new Map(allBindings.map(binding => [binding.path, binding]));
  const orderedBindings = requiredHostProductionBindings.flatMap(bindingPath => byPath.has(bindingPath) ? [byPath.get(bindingPath)] : []);
  const detailedInventory = inventory.map(item => {
    const binding = byPath.get(item.path);
    return binding == null
      ? { ...item, status: "unbound" }
      : { ...item, status: "bound", binding: Object.fromEntries(Object.entries(binding).filter(([key]) => key !== "resolvedModule")) };
  });
  const boundBindings = detailedInventory.filter(item => item.status === "bound").map(item => item.path);
  const unboundBindings = detailedInventory.filter(item => item.status === "unbound").map(item => item.path);
  const activationEvidence = await assembleRunnerActivationEvidence(detailedInventory);
  activationEvidence.localExecProduction = await assembleLocalExecProductionEvidence();
  const assemblyBytes = Buffer.from(JSON.stringify({ inventory: detailedInventory, activationEvidence }));
  return {
    status: unboundBindings.length === 0 ? "complete" : "incomplete",
    manifestPath: suppliedManifestPath,
    manifestSha256: sha256(assemblyBytes),
    suppliedManifestSha256,
    bindings: orderedBindings,
    inventory: detailedInventory,
    boundBindings,
    unboundBindings,
    activationEvidence,
  };
}

export async function validateHostProductionBindingManifest(manifestPath) {
  if (manifestPath == null) throw new TypeError("validateHostProductionBindingManifest requires manifestPath");
  return assembleHostProductionBindingManifest(manifestPath);
}

export async function buildProductionHostIfSupplied({ outputRoot, manifestPath = process.env.GROK_BOT_HOST_BINDINGS_MANIFEST?.trim() || null } = {}) {
  const validated = await assembleHostProductionBindingManifest(manifestPath);
  if (validated.unboundBindings.length > 0) {
    return {
      status: "incomplete-evidence-derived-manifest",
      clean: false,
      blocker: `${validated.unboundBindings.length} mandatory production host bindings remain fail-closed: ${validated.unboundBindings.join(", ")}`,
      requiredBindings: requiredHostProductionBindings,
      boundBindings: validated.boundBindings,
      unboundBindings: validated.unboundBindings,
      inventory: validated.inventory,
      activationEvidence: validated.activationEvidence,
    };
  }
  if (outputRoot == null) throw new TypeError("buildProductionHostIfSupplied requires outputRoot");
  if (validated.activationEvidence.runnerRealTurn.status !== "supported") {
    return {
      status: "bindings-complete-native-evidence-blocked",
      clean: false,
      blocker: validated.activationEvidence.runnerRealTurn.blocker,
      requiredBindings: requiredHostProductionBindings,
      boundBindings: validated.boundBindings,
      unboundBindings: validated.unboundBindings,
      inventory: validated.inventory,
      activationEvidence: validated.activationEvidence,
    };
  }
  const outfile = path.join(outputRoot, "dist/host/host-main.cjs");
  await mkdir(path.dirname(outfile), { recursive: true });
  const external = [...new Set(validated.bindings.filter(binding => !localSourceClassifications.has(binding.classification)).map(binding => binding.resolvedModule))];
  const result = await esbuild({
    absWorkingDir: repoRoot,
    banner: { js: `// Deterministic clean-source production host; bindings ${validated.manifestSha256}` },
    bundle: true,
    entryNames: "host-main",
    external,
    format: "cjs",
    legalComments: "none",
    logLevel: "silent",
    // Prefer package ESM entrypoints when bundling to CJS. UMD entrypoints such
    // as jsonc-parser capture a factory-local `require`, which cannot retain
    // its package-relative resolution once flattened into host-main.cjs.
    mainFields: ["module", "main"],
    metafile: true,
    outfile,
    platform: "node",
    sourcemap: false,
    stdin: {
      contents: productionEntrySource(validated.bindings),
      loader: "ts",
      resolveDir: repoRoot,
      sourcefile: "scripts/build-entry/production-host.ts",
    },
    target: "node22",
  });
  const inputs = Object.keys(result.metafile.inputs).map(input => normalize(path.relative(repoRoot, path.resolve(repoRoot, input)))).sort();
  const forbiddenInputs = inputs.filter(input => input === "src/app" || input.startsWith("src/app/") || input.startsWith("recovered/source-capsules/") || input.startsWith("dist/deps/"));
  if (forbiddenInputs.length > 0) {
    throw new Error(`Clean production host graph reaches forbidden first-party artifact inputs: ${forbiddenInputs.join(", ")}`);
  }
  const externalImports = [...new Set(Object.values(result.metafile.outputs).flatMap(output => output.imports.map(item => item.path)))].sort();
  const allowedExternal = new Set([...external, ...builtinSet]);
  const unexpectedExternal = externalImports.filter(specifier => !allowedExternal.has(specifier));
  if (unexpectedExternal.length > 0) throw new Error(`Clean production host has undeclared external imports: ${unexpectedExternal.join(", ")}`);

  const outputBytes = await readFile(outfile);
  const forbiddenOutput = outputBytes.toString("utf8").match(/(?:src\/app\/|recovered\/source-capsules\/|dist\/host\/host-main\.cjs)/g) ?? [];
  if (forbiddenOutput.length > 0) throw new Error(`Clean production host embeds forbidden artifact references: ${[...new Set(forbiddenOutput)].join(", ")}`);
  const provenance = {
    schemaVersion: 2,
    status: "validated-clean-source",
    manifestPath: validated.manifestPath,
    manifestSha256: validated.manifestSha256,
    suppliedManifestSha256: validated.suppliedManifestSha256,
    requiredBindings: requiredHostProductionBindings,
    boundBindings: validated.boundBindings,
    unboundBindings: validated.unboundBindings,
    inventory: validated.inventory,
    activationEvidence: validated.activationEvidence,
    bindings: validated.bindings.map(({ resolvedModule: _resolvedModule, ...binding }) => binding),
    executableGraph: { inputs, externalImports, forbiddenInputs, forbiddenOutputReferences: [], retainedNativePackages: retainedElectronNativePackagesFromMetafile(result.metafile) },
    output: { path: "dist/host/host-main.cjs", bytes: outputBytes.byteLength, sha256: sha256(outputBytes) },
  };
  const provenancePath = path.join(outputRoot, hostBindingProvenancePath);
  await mkdir(path.dirname(provenancePath), { recursive: true });
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  return { status: "validated-clean-source", clean: true, requiredBindings: requiredHostProductionBindings, boundBindings: validated.boundBindings, unboundBindings: validated.unboundBindings, inventory: validated.inventory, provenance, provenancePath, outputPath: outfile };
}

if (process.argv[1] != null && path.resolve(process.argv[1]) === scriptPath) {
  const manifestPath = process.argv[2] ?? process.env.GROK_BOT_HOST_BINDINGS_MANIFEST?.trim() ?? null;
  const validated = await assembleHostProductionBindingManifest(manifestPath);
  console.log(`Host production bindings: ${validated.boundBindings.length} bound, ${validated.unboundBindings.length} mandatory unbound (${validated.manifestSha256}).`);
  for (const item of validated.inventory) console.log(`${item.status.padEnd(7)} ${item.path}`);
}
