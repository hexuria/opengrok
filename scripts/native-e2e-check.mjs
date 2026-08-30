#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, open, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { extractFile, listPackage } from "@electron/asar";
import {
  NATIVE_OBSERVATION_CLASSES,
  NATIVE_OBSERVATION_ENV_DENYLIST,
  NATIVE_OBSERVATION_REPORT_KIND,
  NATIVE_OBSERVATION_SCHEMA_VERSION,
  assertNativeObservationReport,
} from "./lib/native-observation-report.mjs";
import { SYSTEM_TOOLS } from "./lib/system-tools.mjs";

export const REQUIRED_PACKAGED_ARTIFACTS = Object.freeze([
  "package.json",
  "dist/electron-main/main.cjs",
  "dist/electron-preload/preload.cjs",
  "dist/electron-preload/preload-dev-controls.cjs",
  "dist/electron-preload/preload-vnc.cjs",
  "dist/electron-preload/preload-webview.cjs",
  "dist/node-agent-coordinator/main.cjs",
  "dist/host/host-main.cjs",
  "dist/local-exec-daemon/main.cjs",
  "dist/renderer/index.html",
  "dist/renderer/renderer-source-provenance.json"
]);

export const PRODUCTION_ENTRYPOINTS = Object.freeze({
  main: "dist/electron-main/main.cjs",
  preload: "dist/electron-preload/preload.cjs",
  preloadDevControls: "dist/electron-preload/preload-dev-controls.cjs",
  preloadVnc: "dist/electron-preload/preload-vnc.cjs",
  preloadWebview: "dist/electron-preload/preload-webview.cjs",
  coordinator: "dist/node-agent-coordinator/main.cjs",
  host: "dist/host/host-main.cjs",
  daemon: "dist/local-exec-daemon/main.cjs",
  renderer: "dist/renderer/index.html"
});

const CLEAN_ENTRY_SOURCES = Object.freeze({
  main: "source/electron-main/main.ts",
  preload: "source/electron-preload/preload.ts",
  preloadDevControls: "source/electron-preload/preload-dev-controls.ts",
  preloadVnc: "source/electron-preload/preload-vnc.ts",
  preloadWebview: "source/electron-preload/preload-webview.ts",
  coordinator: "source/node-agent-coordinator/main.ts",
  host: "source/host/main.ts",
  daemon: "source/local-exec-daemon/main.ts",
  renderer: "frontend/src/main.tsx"
});

export const FATAL_LOG_PATTERNS = Object.freeze([
  /uncaught exception/i,
  /unhandled(?:promise)?rejection/i,
  /fatal error/i,
  /segmentation fault/i,
  /renderer process (?:crashed|gone)/i,
  /failed to load (?:the )?(?:main|preload|renderer|host|coordinator)/i,
  /cannot find module/i,
  /syntaxerror:/i
]);

export const OPAQUE_FALLBACK_PATTERNS = Object.freeze([
  /opaque bundle fallback/i,
  /fall(?:ing)? back to (?:the )?(?:shipped|packaged|legacy) bundle/i,
  /loading .*src\/app/i,
  /GROK_BOT_ALLOW_OPAQUE_FALLBACK/i
]);

export const NATIVE_TEST_RUNTIME_ARGUMENTS = Object.freeze(["--use-mock-keychain"]);
export const PRODUCTION_NATIVE_ENV_DENYLIST = Object.freeze([
  "GROK_BOT_RECONSTRUCTED_DEV",
  "ELECTRON_RUN_AS_NODE",
  "VITE_DEV_SERVER_URL",
  "SAND_DEV_LOGIN",
  "SAND_DEV_LOGIN_EMAIL",
  "SAND_BACKEND_URL",
  "CURSOR_API_BASE_URL",
  "NODE_PATH",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "NODE_V8_COVERAGE",
  "ELECTRON_LOG_FILE",
  "ELECTRON_ENABLE_LOGGING",
  "SAND_HOST_GATEWAY_URL",
  "SAND_HOST_GATEWAY_TOKEN",
  "SAND_HOST_GATEWAY_NETWORK_TOKEN",
  "SAND_FEATURE_GATE_OVERRIDES",
  "SAND_MODEL_EXPERIMENT_OVERRIDE",
]);
const MOCK_KEYCHAIN_CAPABILITY = Buffer.from("use-mock-keychain", "utf8");
const SYSTEM_APPLICATIONS_ROOT = "/Applications";

const normalizeArchivePath = (value) => value.replace(/^\/+/, "").replaceAll("\\", "/");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exists = async (target) => access(target).then(() => true, () => false);

function unobservedProcessWindow() {
  return { carrier: "none", durationMs: null, completed: false, renderer: null, host: null, coordinator: null, daemon: null };
}

async function existingRealpath(target) {
  try { return await realpath(target); } catch { return null; }
}

function makeNativeE2EReport({ generatedAt, options, payloadPath, targetRealpath, status, diagnostics, runtime }) {
  const productionStartup = options.structuralOnly !== true && options.appPath.endsWith(".app");
  const observationClass = status === "prerequisite"
    ? NATIVE_OBSERVATION_CLASSES.prerequisiteNoLaunch
    : runtime == null
      ? NATIVE_OBSERVATION_CLASSES.structuralOnly
      : NATIVE_OBSERVATION_CLASSES.productionStartup;
  const runtimeMetadata = runtime?.observationMetadata ?? null;
  const keychainDiagnostic = runtime?.diagnostics?.find((item) => item.check === "runtime:keychain-isolation");
  const report = {
    schemaVersion: NATIVE_OBSERVATION_SCHEMA_VERSION,
    reportKind: NATIVE_OBSERVATION_REPORT_KIND,
    observationClass,
    status,
    generatedAt,
    provenance: {
      producer: "native-e2e",
      targetRealpath,
      applicationsLocation: {
        systemRoot: "/Applications",
        status: productionStartup ? (isNativeTestSystemApplicationsPath(targetRealpath) ? "accepted" : "refused") : "not-applicable",
      },
      environmentDenylist: {
        keys: [...NATIVE_OBSERVATION_ENV_DENYLIST],
        deniedKeysAbsent: runtimeMetadata?.deniedKeysAbsent ?? null,
      },
      mockKeychainCapability: runtimeMetadata?.mockKeychainCapability
        ?? (keychainDiagnostic == null ? "not-applicable" : keychainDiagnostic.status === "pass" ? "present" : "absent"),
      freshRoots: runtimeMetadata == null
        ? { status: "not-applicable", userDataDir: null, dataRoot: null }
        : { status: "isolated", userDataDir: runtimeMetadata.userDataDir, dataRoot: runtimeMetadata.dataRoot },
      productionStartup,
      replacementMain: false,
    },
    diagnostics,
    observedProcessWindow: runtime?.observedProcessWindow ?? unobservedProcessWindow(),
    payload: {
      requestedAppPath: options.appPath,
      requestedPayloadPath: payloadPath,
      structuralOnly: options.structuralOnly === true,
      timeoutMs: options.timeoutMs,
      runtime,
    },
  };
  return assertNativeObservationReport(report);
}

export function createNativeTestEnvironment(baseEnv, userDataRoot) {
  if (!path.isAbsolute(userDataRoot)) {
    throw new TypeError("Native test user-data root must be an absolute isolated path.");
  }
  const environment = { ...baseEnv };
  for (const key of PRODUCTION_NATIVE_ENV_DENYLIST) delete environment[key];
  environment.SAND_USER_DATA_DIR = userDataRoot;
  environment.SAND_DATA_ROOT = path.join(userDataRoot, "sand-data");
  environment.SAND_DISABLE_UPDATES = "1";
  environment.SAND_DISABLE_TELEMETRY = "1";
  environment.SAND_DISABLE_ANALYTICS = "1";
  return environment;
}

async function fileContainsBytes(target, needle) {
  const handle = await open(target, "r");
  const chunk = Buffer.alloc(64 * 1024);
  let carry = Buffer.alloc(0);
  let position = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) return false;
      const combined = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      if (combined.includes(needle)) return true;
      carry = combined.subarray(Math.max(0, combined.length - needle.length + 1));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
}

export async function inspectNativeTestKeychainCapability(appPath) {
  const framework = path.join(
    appPath,
    "Contents",
    "Frameworks",
    "Electron Framework.framework",
    "Electron Framework",
  );
  if (!await exists(framework)) {
    return {
      status: "fail",
      detail: `Missing ${framework}; native tests refuse to start without a provable mock-Keychain runtime.`,
    };
  }
  const supported = await fileContainsBytes(framework, MOCK_KEYCHAIN_CAPABILITY);
  return supported
    ? { status: "pass", detail: "packaged Electron runtime contains the use-mock-keychain capability" }
    : { status: "fail", detail: "packaged Electron runtime does not prove use-mock-keychain support; native launch refused" };
}

export function isNativeTestSystemApplicationsPath(resolvedPath) {
  if (typeof resolvedPath !== "string" || !path.posix.isAbsolute(resolvedPath)) return false;
  const relative = path.posix.relative(SYSTEM_APPLICATIONS_ROOT, resolvedPath);
  return relative.length > 0
    && relative !== ".."
    && !relative.startsWith("../")
    && !path.posix.isAbsolute(relative);
}

export async function inspectNativeTestApplicationsLocation(appPath) {
  let resolved;
  try {
    resolved = await realpath(appPath);
  } catch (error) {
    return {
      status: "fail",
      detail: `Cannot resolve native application path ${appPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return isNativeTestSystemApplicationsPath(resolved)
    ? { status: "pass", detail: `resolved application path is inside system /Applications: ${resolved}` }
    : { status: "fail", detail: `resolved application path is outside system /Applications: ${resolved}; native launch refused before the immutable move-to-Applications prompt` };
}

function signalProcessGroup(child, signal) {
  if (child?.pid != null) {
    try { process.kill(-child.pid, signal); return; } catch {}
  }
  try { child?.kill(signal); } catch {}
}

export function classifyRuntimeLogs(output) {
  return {
    fatal: FATAL_LOG_PATTERNS.map((pattern) => output.match(pattern)?.[0]).filter(Boolean),
    opaqueFallback: OPAQUE_FALLBACK_PATTERNS.map((pattern) => output.match(pattern)?.[0]).filter(Boolean),
    isolatedProfileConfirmed: /using isolated user-data dir/i.test(output),
    hostMentioned: /(?:host-main\.cjs|\[sand:host\]|host (?:started|ready|listening))/i.test(output),
    coordinatorMentioned: /(?:node-agent-coordinator\/main\.cjs|\[sand:coordinator\]|coordinator (?:started|ready|listening))/i.test(output)
  };
}

export function classifyFreshProfileRuntimeEvidence(evidence) {
  const rendererRequired = evidence?.renderer === true;
  const hostAbsent = evidence?.host === false;
  const coordinatorAbsent = evidence?.coordinator === false;
  return {
    accepted: rendererRequired && hostAbsent && coordinatorAbsent,
    rendererRequired,
    hostAbsent,
    coordinatorAbsent,
  };
}

export function classifyProcessSnapshot(rows, rootPid) {
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.parent) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  const owned = rows.filter((row) => descendants.has(row.pid));
  return {
    pids: [...descendants],
    renderer: owned.some((row) => row.command.includes("--type=renderer")),
    host: owned.some((row) => /(?:dist\/host\/host-main\.cjs|--sand-host)/.test(row.command)),
    coordinator: owned.some((row) => /(?:node-agent-coordinator\/main\.cjs|--sand-coordinator)/.test(row.command)),
    daemon: owned.some((row) => /(?:local-exec-daemon\/main\.cjs|--sand-local-exec)/.test(row.command)),
    commands: owned.map((row) => row.command)
  };
}

function provenanceMarkers(text) {
  const cleanMarkers = [...text.matchAll(/^\/\/ (source\/[^\s]+|src\/[^\s]+|frontend\/src\/[^\s]+)/gm)].map((match) => match[1]);
  return {
    cleanMarkers: cleanMarkers.filter((marker) => marker.startsWith("source/") || marker.startsWith("frontend/src/")),
    immutableMarkers: cleanMarkers.filter((marker) => marker.startsWith("src/")),
    explicitCleanBanner: /GROK BOT 0\.18 CLEAN RECONSTRUCTION|reconstructed from clean source/i.test(text)
  };
}

function resolveCleanSource(sourceRoot, source) {
  const repositoryRoot = path.basename(sourceRoot) === "source" ? path.dirname(sourceRoot) : sourceRoot;
  return source.startsWith("source/")
    ? path.join(repositoryRoot, source)
    : path.join(repositoryRoot, source);
}

export function importsImmutableRendererModule(text) {
  const moduleSpecifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bnew\s+URL\s*\(\s*)["']([^"']+)["']/g;
  return [...text.matchAll(moduleSpecifier)].some((match) => /(?:^|\/)src\/app(?:\/|$)|(?:^|\/)recovered\/source-capsules(?:\/|$)/.test(match[1]));
}

export function classifyPackagedSandLab(packageJson) {
  if (packageJson == null || typeof packageJson !== "object" || Array.isArray(packageJson)) {
    return { status: "fail", detail: "package.json must be an object to prove non-lab production startup" };
  }
  if (!Object.hasOwn(packageJson, "sandLab")) {
    return { status: "pass", detail: "package.json sandLab is absent" };
  }
  if (packageJson.sandLab === false) {
    return { status: "pass", detail: "package.json sandLab is exactly false" };
  }
  return {
    status: "fail",
    detail: `package.json sandLab must be absent or exactly false for production startup; found ${JSON.stringify(packageJson.sandLab)}`,
  };
}

function artifactProvenance(manifest, role, artifact) {
  const roleEntry = manifest?.entrypoints?.[role];
  const artifactEntry = manifest?.artifacts?.[artifact];
  const compositionEntry = manifest?.runtimeComposition?.find?.((entry) => entry?.path === artifact || (role === "renderer" && typeof entry?.path === "string" && artifact.startsWith(`${entry.path}/`)));
  const outputEntry = manifest?.outputs?.find?.((entry) => entry?.path === artifact);
  return {
    sources: roleEntry?.sources ?? artifactEntry?.sources ?? (typeof compositionEntry?.source === "string" ? [compositionEntry.source] : undefined),
    hash: roleEntry?.sha256 ?? artifactEntry?.sha256 ?? outputEntry?.sha256,
    mode: roleEntry?.mode ?? artifactEntry?.mode ?? compositionEntry?.mode,
    reason: roleEntry?.reason ?? artifactEntry?.reason ?? compositionEntry?.reason
  };
}

export async function verifyEntrypointGraph({ readArtifact, immutableRoot, sourceRoot, provenanceManifest }) {
  const diagnostics = [];
  let manifest = provenanceManifest;
  if (manifest == null) {
    for (const candidate of ["dist/reconstruction-source-manifest.json", "dist/reconstruction-build.json"]) {
      try { manifest = JSON.parse((await readArtifact(candidate)).toString("utf8")); break; }
      catch { manifest = null; }
    }
  }
  for (const [role, artifact] of Object.entries(PRODUCTION_ENTRYPOINTS)) {
    let bytes;
    try { bytes = await readArtifact(artifact); }
    catch { diagnostics.push({ check: `entrypoint:${role}`, status: "fail", detail: `Missing production entrypoint ${artifact}` }); continue; }
    const text = bytes.toString("utf8");
    if (role === "renderer") {
      const script = text.match(/<script[^>]+(?:type=["']module["'][^>]+)?src=["']([^"']+)/i)?.[1];
      if (script == null) {
        diagnostics.push({ check: "entrypoint:renderer", status: "fail", detail: "Renderer index has no script entrypoint" });
        continue;
      }
      const rendererArtifact = normalizeArchivePath(path.posix.join(path.posix.dirname(artifact), script.split(/[?#]/, 1)[0]));
      if (script.startsWith("/") || rendererArtifact.startsWith("../")) {
        diagnostics.push({ check: "entrypoint:renderer", status: "fail", detail: `Renderer entrypoint escapes packaged payload: ${script}` });
        continue;
      }
      let rendererBytes;
      try { rendererBytes = await readArtifact(rendererArtifact); }
      catch {
        diagnostics.push({ check: "entrypoint:renderer", status: "fail", detail: `Renderer script does not resolve in packaged payload: ${rendererArtifact}` });
        continue;
      }
      const provenance = artifactProvenance(manifest, role, rendererArtifact);
      let rendererRuntimeProvenance = null;
      try { rendererRuntimeProvenance = JSON.parse((await readArtifact("dist/renderer/renderer-source-provenance.json")).toString("utf8")); }
      catch {}
      const rendererText = rendererBytes.toString("utf8"), rendererMarkers = provenanceMarkers(rendererText);
      const rendererSources = provenance.sources;
      const invalidRendererSource = Array.isArray(rendererSources)
        ? rendererSources.find((entry) => typeof entry !== "string" || entry.startsWith("src/app/") || path.isAbsolute(entry))
        : undefined;
      const expectedSource = CLEAN_ENTRY_SOURCES[role];
      const rendererSourceBacked = Array.isArray(rendererSources) && rendererSources.length > 0 && invalidRendererSource == null
        ? rendererSources.includes(expectedSource) && rendererSources.every((entry) => entry.startsWith("source/") || entry.startsWith("frontend/src/"))
        : rendererMarkers.cleanMarkers.includes(expectedSource);
      const rendererImportsImmutable = importsImmutableRendererModule(rendererText);
      const rendererDeclaredFallback = provenance.mode != null && provenance.mode !== "clean-source";
      let immutableRendererHash = null;
      if (immutableRoot != null) {
        try { immutableRendererHash = sha256(await readFile(path.join(immutableRoot, rendererArtifact))); } catch {}
      }
      const rendererHash = sha256(rendererBytes);
      const rendererByteIdentical = immutableRendererHash != null && immutableRendererHash === rendererHash;
      const rendererHashMismatch = typeof provenance.hash === "string" && provenance.hash !== rendererHash;
      const rendererRouteContracts = rendererRuntimeProvenance?.evidence?.routeContracts;
      const invalidRendererRuntimeProvenance = rendererRuntimeProvenance?.mode !== "clean-source"
        || rendererRuntimeProvenance?.entrypoint !== expectedSource
        || rendererRuntimeProvenance?.graph?.forbiddenInputs?.length !== 0
        || !Array.isArray(rendererRouteContracts)
        || rendererRouteContracts.length !== 11
        || rendererRouteContracts.some(route => route?.reviewed !== true || route?.cleanComposition !== "present");
      if (!rendererSourceBacked || invalidRendererSource != null || rendererImportsImmutable || rendererDeclaredFallback || rendererByteIdentical || rendererHashMismatch || invalidRendererRuntimeProvenance) {
        const reasons = [
          !rendererSourceBacked ? `no provenance for expected entry source ${expectedSource}` : null,
          invalidRendererSource != null ? `invalid provenance source ${String(invalidRendererSource)}` : null,
          rendererImportsImmutable ? "imports immutable src/app" : null,
          rendererDeclaredFallback ? `manifest declares ${provenance.mode}${provenance.reason ? `: ${provenance.reason}` : ""}` : null,
          rendererByteIdentical ? "byte-identical to immutable shipped bundle" : null,
          rendererHashMismatch ? "artifact hash does not match provenance manifest" : null,
          invalidRendererRuntimeProvenance ? "renderer runtime provenance does not prove the exact 11 clean route contracts" : null
        ].filter(Boolean);
        diagnostics.push({ check: "entrypoint:renderer", status: "fail", detail: `${rendererArtifact}: opaque bundle fallback (${reasons.join("; ")})` });
        continue;
      }
      diagnostics.push({ check: "entrypoint:renderer", status: "pass", detail: `Renderer index resolves clean-source script ${rendererArtifact} with 11/11 packaged route contracts` });
      continue;
    }
    const provenance = artifactProvenance(manifest, role, artifact);
    const manifestSources = provenance.sources;
    const invalidManifestSource = Array.isArray(manifestSources)
      ? manifestSources.find((entry) => typeof entry !== "string" || entry.startsWith("src/app/") || path.isAbsolute(entry))
      : undefined;
    const markers = provenanceMarkers(text);
    const expectedSource = CLEAN_ENTRY_SOURCES[role];
    const sourceBacked = Array.isArray(manifestSources) && manifestSources.length > 0 && invalidManifestSource == null
      ? manifestSources.includes(expectedSource) && manifestSources.every((entry) => entry.startsWith("source/") || entry.startsWith("frontend/src/"))
      : markers.cleanMarkers.includes(expectedSource);
    let immutableHash = null;
    if (immutableRoot != null) {
      const immutablePath = path.join(immutableRoot, artifact);
      try { immutableHash = sha256(await readFile(immutablePath)); } catch {}
    }
    const byteIdenticalToImmutable = immutableHash != null && immutableHash === sha256(bytes);
    const hashMismatch = typeof provenance.hash === "string" && provenance.hash !== sha256(bytes);
    const declaredFallback = provenance.mode != null && provenance.mode !== "clean-source";
    const importsImmutable = /(?:require\(|from\s+)["'][^"']*src\/app|\/src\/app\/dist\//.test(text);
    if (!sourceBacked || invalidManifestSource != null || byteIdenticalToImmutable || hashMismatch || declaredFallback || importsImmutable) {
      const reasons = [
        !sourceBacked ? `no provenance for expected entry source ${expectedSource}` : null,
        invalidManifestSource != null ? `invalid provenance source ${String(invalidManifestSource)}` : null,
        byteIdenticalToImmutable ? "byte-identical to immutable shipped bundle" : null,
        hashMismatch ? "artifact hash does not match provenance manifest" : null,
        declaredFallback ? `manifest declares ${provenance.mode}${provenance.reason ? `: ${provenance.reason}` : ""}` : null,
        importsImmutable ? "imports immutable src/app" : null
      ].filter(Boolean);
      diagnostics.push({ check: `entrypoint:${role}`, status: "fail", detail: `${artifact}: opaque bundle fallback (${reasons.join("; ")})` });
      continue;
    }
    if (sourceRoot != null && Array.isArray(manifestSources)) {
      const missing = [];
      for (const source of manifestSources) if (!await exists(resolveCleanSource(sourceRoot, source))) missing.push(source);
      if (missing.length > 0) { diagnostics.push({ check: `entrypoint:${role}`, status: "fail", detail: `Provenance references missing clean sources: ${missing.join(", ")}` }); continue; }
    }
    diagnostics.push({ check: `entrypoint:${role}`, status: "pass", detail: `${artifact} has clean-source provenance` });
  }
  return diagnostics;
}

export async function openPackagedPayload(input) {
  const stats = await stat(input);
  if (stats.isDirectory()) {
    const root = input.endsWith(".app") ? path.join(input, "Contents", "Resources") : input;
    const asar = path.join(root, "app.asar");
    if (await exists(asar)) return openPackagedPayload(asar);
    return {
      kind: "directory",
      location: root,
      list: async () => {
        const result = [];
        async function walk(directory, prefix = "") { for (const entry of await readdir(directory, { withFileTypes: true })) { const relative = normalizeArchivePath(path.join(prefix, entry.name)); if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative); else result.push(relative); } }
        await walk(root); return result;
      },
      read: (relative) => readFile(path.join(root, normalizeArchivePath(relative)))
    };
  }
  return {
    kind: "asar",
    location: input,
    list: async () => listPackage(input).map(normalizeArchivePath),
    read: async (relative) => Buffer.from(extractFile(input, normalizeArchivePath(relative)))
  };
}

export async function inspectPackagedArtifacts(payload) {
  const listing = new Set(await payload.list());
  const diagnostics = REQUIRED_PACKAGED_ARTIFACTS.map((required) => listing.has(required)
    ? { check: `artifact:${required}`, status: "pass", detail: "present" }
    : { check: `artifact:${required}`, status: "fail", detail: `Missing required packaged artifact ${required}` });
  try {
    const packageJson = JSON.parse((await payload.read("package.json")).toString("utf8"));
    diagnostics.push(packageJson.main === PRODUCTION_ENTRYPOINTS.main
      ? { check: "package:main", status: "pass", detail: packageJson.main }
      : { check: "package:main", status: "fail", detail: `Expected ${PRODUCTION_ENTRYPOINTS.main}, found ${String(packageJson.main)}` });
    diagnostics.push({ check: "package:sand-lab", ...classifyPackagedSandLab(packageJson) });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    diagnostics.push({ check: "package:json", status: "fail", detail });
    diagnostics.push({ check: "package:sand-lab", status: "fail", detail: `Cannot prove non-lab production startup: ${detail}` });
  }
  return diagnostics;
}

async function processRows() {
  return await new Promise((resolve, reject) => {
    const child = spawn(SYSTEM_TOOLS.ps, ["-axo", "ppid=,pid=,command="], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = ""; child.stdout.on("data", (chunk) => output += chunk); child.stderr.on("data", (chunk) => error += chunk);
    child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve(output.split("\n").flatMap((line) => { const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/); return match == null ? [] : [{ parent: Number(match[1]), pid: Number(match[2]), command: match[3] }]; })) : reject(new Error(error)));
  });
}

async function findRuntimeEvidence(root) {
  const names = [];
  async function walk(directory, depth) { if (depth < 0) return; let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; } for (const entry of entries) { names.push(path.join(directory, entry.name)); if (entry.isDirectory()) await walk(path.join(directory, entry.name), depth - 1); } }
  await walk(root, 4);
  return {
    files: names,
    startup: names.length > 0,
    host: names.some((name) => /(?:host\.lock|gateway\.json|host.*log)/i.test(name)),
    coordinator: names.some((name) => /(?:coordinator|control-port|renderer-port)/i.test(name))
  };
}

async function runCommand(command, args) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => stdout += chunk); child.stderr.on("data", (chunk) => stderr += chunk);
    child.once("error", (error) => resolve({ code: null, stdout, stderr, error }));
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr, error: null }));
  });
}

export async function inspectMacAppPrerequisites(appPath, { productionStartup = false } = {}) {
  if (process.platform !== "darwin") return { status: "prerequisite", diagnostics: [{ check: "runtime:platform", status: "skip", detail: "Packaged macOS launch requires Darwin" }] };
  if (productionStartup) {
    const applicationsLocation = await inspectNativeTestApplicationsLocation(appPath);
    if (applicationsLocation.status !== "pass") {
      return {
        status: "prerequisite",
        diagnostics: [{ check: "runtime:applications-location", ...applicationsLocation }],
      };
    }
  }
  const infoPlist = path.join(appPath, "Contents", "Info.plist");
  if (!await exists(infoPlist)) return { status: "prerequisite", diagnostics: [{ check: "runtime:bundle", status: "fail", detail: `Missing ${infoPlist}; run the native package build first` }] };
  const plist = await runCommand(SYSTEM_TOOLS.plutil, ["-extract", "CFBundleExecutable", "raw", "-o", "-", infoPlist]);
  const executableName = plist.code === 0 ? plist.stdout.trim() : "";
  if (executableName.length === 0) return { status: "prerequisite", diagnostics: [{ check: "runtime:bundle-executable", status: "fail", detail: `Cannot read CFBundleExecutable from ${infoPlist}: ${(plist.stderr || plist.error?.message || "unknown plutil error").trim()}` }] };
  const executable = path.join(appPath, "Contents", "MacOS", executableName);
  if (!await exists(executable)) return { status: "prerequisite", diagnostics: [{ check: "runtime:executable", status: "fail", detail: `Missing ${executable}; run the native package build first` }] };
  const signature = await runCommand(SYSTEM_TOOLS.codesign, ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  if (signature.code !== 0) {
    const reason = (signature.stderr || signature.stdout || signature.error?.message || "unknown codesign error").trim();
    return { status: "prerequisite", diagnostics: [{ check: "runtime:codesign", status: "fail", detail: `${reason}. Prerequisite: sign the final app payload after all Info.plist and ASAR changes.` }] };
  }
  return { status: "pass", executable, diagnostics: [{ check: "runtime:codesign", status: "pass", detail: "bundle signature is internally valid" }] };
}

export async function launchPackagedApp({ appPath, timeoutMs = 15_000, pollMs = 250 }) {
  const prerequisites = await inspectMacAppPrerequisites(appPath, { productionStartup: true });
  if (prerequisites.status !== "pass") return prerequisites;
  const keychainCapability = await inspectNativeTestKeychainCapability(appPath);
  if (keychainCapability.status !== "pass") {
    return {
      status: "prerequisite",
      diagnostics: [
        ...prerequisites.diagnostics,
        { check: "runtime:keychain-isolation", ...keychainCapability },
      ],
    };
  }
  const { executable } = prerequisites;
  const userDataRoot = await mkdtemp(path.join(tmpdir(), "grok-bot-native-e2e-"));
  let output = "", child;
  try {
    const nativeEnvironment = createNativeTestEnvironment(process.env, userDataRoot);
    const observationStartedAt = Date.now();
    child = spawn(executable, NATIVE_TEST_RUNTIME_ARGUMENTS, { cwd: path.dirname(executable), detached: true, env: nativeEnvironment, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", (chunk) => output += chunk); child.stderr.on("data", (chunk) => output += chunk);
    let exited = null, spawnError = null;
    child.once("error", (error) => { spawnError = error; });
    child.once("exit", (code, signal) => { exited = { code, signal }; });
    const deadline = Date.now() + timeoutMs; let snapshot = { renderer: false, host: false, coordinator: false, daemon: false, pids: [], commands: [] };
    while (Date.now() < deadline && exited == null) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      if (spawnError != null || child.pid == null) break;
      try {
        const observed = classifyProcessSnapshot(await processRows(), child.pid);
        snapshot = {
          renderer: snapshot.renderer || observed.renderer,
          host: snapshot.host || observed.host,
          coordinator: snapshot.coordinator || observed.coordinator,
          daemon: snapshot.daemon || observed.daemon,
          pids: [...new Set([...snapshot.pids, ...observed.pids])],
          commands: [...new Set([...snapshot.commands, ...observed.commands])],
        };
      }
      catch (error) { output += `\n[native-e2e] process inspection failed: ${error instanceof Error ? error.message : String(error)}\n`; }
      const logs = classifyRuntimeLogs(output); if (logs.fatal.length > 0 || logs.opaqueFallback.length > 0) break;
    }
    const files = await findRuntimeEvidence(userDataRoot), logs = classifyRuntimeLogs(output);
    const evidence = { startup: exited == null && (logs.isolatedProfileConfirmed || files.startup), renderer: snapshot.renderer, host: snapshot.host || logs.hostMentioned || files.host, coordinator: snapshot.coordinator || logs.coordinatorMentioned || files.coordinator, daemon: snapshot.daemon, logs, processCommands: snapshot.commands, userDataFiles: files.files.map((name) => path.relative(userDataRoot, name)) };
    const freshProfile = classifyFreshProfileRuntimeEvidence(evidence);
    const diagnostics = [
      ...prerequisites.diagnostics,
      { check: "runtime:keychain-isolation", ...keychainCapability },
      { check: "runtime:startup", status: evidence.startup ? "pass" : "fail", detail: spawnError != null ? `launch failed: ${spawnError.message}` : exited == null ? "application remained alive under isolated root" : `application exited early (${exited.code ?? exited.signal})` },
      { check: "runtime:renderer", status: freshProfile.rendererRequired ? "pass" : "fail", detail: freshProfile.rendererRequired ? "renderer descendant observed" : "no renderer descendant observed" },
      { check: "runtime:host", status: freshProfile.hostAbsent ? "pass" : "fail", detail: freshProfile.hostAbsent ? "host remained absent for the fresh profile" : "unexpected host process/log/file evidence observed for the fresh profile" },
      { check: "runtime:coordinator", status: freshProfile.coordinatorAbsent ? "pass" : "fail", detail: freshProfile.coordinatorAbsent ? "coordinator remained absent for the fresh profile" : "unexpected coordinator process/log/file evidence observed for the fresh profile" },
      { check: "runtime:daemon-observation", status: "pass", detail: evidence.daemon ? "local-exec daemon process evidence observed" : "no local-exec daemon process evidence observed" },
      { check: "runtime:fatal-logs", status: logs.fatal.length === 0 ? "pass" : "fail", detail: logs.fatal.length === 0 ? "no fatal startup logs" : logs.fatal.join(", ") },
      { check: "runtime:opaque-fallback", status: logs.opaqueFallback.length === 0 ? "pass" : "fail", detail: logs.opaqueFallback.length === 0 ? "no opaque fallback logs" : logs.opaqueFallback.join(", ") }
    ];
    return {
      status: diagnostics.some((item) => item.status === "fail") ? "fail" : "pass",
      diagnostics,
      evidence,
      output,
      observationMetadata: {
        deniedKeysAbsent: PRODUCTION_NATIVE_ENV_DENYLIST.every((key) => !(key in nativeEnvironment)),
        mockKeychainCapability: "present",
        userDataDir: nativeEnvironment.SAND_USER_DATA_DIR,
        dataRoot: nativeEnvironment.SAND_DATA_ROOT,
      },
      observedProcessWindow: {
        carrier: "electron-window",
        durationMs: Date.now() - observationStartedAt,
        completed: true,
        renderer: evidence.renderer,
        host: evidence.host,
        coordinator: evidence.coordinator,
        daemon: evidence.daemon,
      },
    };
  } finally {
    if (child != null) {
      signalProcessGroup(child, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      signalProcessGroup(child, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await rm(userDataRoot, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const options = { appPath: path.resolve("dist/Grok-0.27.app"), payloadPath: null, structuralOnly: false, json: false, timeoutMs: 15_000 };
  for (let index = 0; index < argv.length; index += 1) { const arg = argv[index]; if (arg === "--app") options.appPath = path.resolve(argv[++index]); else if (arg === "--payload") options.payloadPath = path.resolve(argv[++index]); else if (arg === "--structural-only") options.structuralOnly = true; else if (arg === "--json") options.json = true; else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++index]); else throw new Error(`Unknown argument ${arg}`); }
  return options;
}

export async function runNativeE2E(options) {
  const generatedAt = new Date().toISOString();
  const diagnostics = [], payloadPath = options.payloadPath ?? options.appPath;
  const targetRealpath = await existingRealpath(options.appPath);
  if (!await exists(payloadPath)) return makeNativeE2EReport({ generatedAt, options, payloadPath, targetRealpath, status: "prerequisite", diagnostics: [{ check: "package:available", status: "fail", detail: `Missing ${payloadPath}. Prerequisite: complete the native package build.` }], runtime: null });
  let payload;
  try { payload = await openPackagedPayload(payloadPath); }
  catch (error) { return makeNativeE2EReport({ generatedAt, options, payloadPath, targetRealpath, status: "prerequisite", diagnostics: [{ check: "package:open", status: "fail", detail: error instanceof Error ? error.message : String(error) }], runtime: null }); }
  diagnostics.push(...await inspectPackagedArtifacts(payload));
  diagnostics.push(...await verifyEntrypointGraph({ readArtifact: payload.read, immutableRoot: path.resolve("src/app"), sourceRoot: path.resolve("source") }));
  const structuralFailed = diagnostics.some((item) => item.status === "fail");
  const productionLaunchRequested = !options.structuralOnly && options.appPath.endsWith(".app");
  if (productionLaunchRequested && structuralFailed) {
    diagnostics.push({ check: "runtime:launch", status: "skip", detail: "native launch refused because packaged structural prerequisites failed" });
    return makeNativeE2EReport({ generatedAt, options, payloadPath, targetRealpath, status: "prerequisite", diagnostics, runtime: null });
  }
  let runtime = null;
  if (productionLaunchRequested) { runtime = await launchPackagedApp({ appPath: options.appPath, timeoutMs: options.timeoutMs }); diagnostics.push(...runtime.diagnostics); }
  else diagnostics.push({ check: "runtime:launch", status: "skip", detail: options.structuralOnly ? "disabled by --structural-only" : "launch requires a packaged .app path" });
  const status = runtime?.status === "prerequisite"
    ? "prerequisite"
    : structuralFailed || runtime?.status === "fail"
      ? "fail"
      : "pass";
  return makeNativeE2EReport({ generatedAt, options, payloadPath, targetRealpath, status, diagnostics, runtime });
}

async function main() {
  const options = parseArgs(process.argv.slice(2)), report = await runNativeE2E(options);
  assertNativeObservationReport(report);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else { for (const item of report.diagnostics) console.log(`${item.status.toUpperCase().padEnd(4)} ${item.check}: ${item.detail}`); console.log(`Native E2E verification: ${report.status.toUpperCase()}`); }
  process.exitCode = report.status === "pass" ? 0 : report.status === "prerequisite" ? 2 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
