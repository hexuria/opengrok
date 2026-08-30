import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { extractAll } from "@electron/asar";
import { cacheDir, cachedRuntimeApp, sourceAppDir, upstreamAsarSha256, upstreamVersion } from "./config.mjs";
import { capture, run } from "./process.mjs";
import { SYSTEM_TOOLS } from "./system-tools.mjs";

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function validateRuntimeApp(appPath) {
  const infoPlist = path.join(appPath, "Contents", "Info.plist");
  const executable = path.join(appPath, "Contents", "MacOS", "Grok Bot");
  const unpacked = path.join(appPath, "Contents", "Resources", "app.asar.unpacked");
  const version = await capture(SYSTEM_TOOLS.plutil, ["-extract", "CFBundleShortVersionString", "raw", infoPlist]);
  if (version !== upstreamVersion) {
    throw new Error(`Expected Grok Bot ${upstreamVersion}, got ${version} at ${appPath}`);
  }
  if (!(await stat(executable)).isFile() || !(await stat(unpacked)).isDirectory()) {
    throw new Error(`Incomplete Grok Bot runtime at ${appPath}`);
  }
  return appPath;
}

export async function resolveRuntimeApp() {
  const configured = process.env.GROK_BOT_018_APP?.trim();
  if (configured) {
    return await validateRuntimeApp(path.resolve(configured));
  }
  if (await exists(cachedRuntimeApp)) {
    return await validateRuntimeApp(cachedRuntimeApp);
  }
  throw new Error("Missing 0.18.0 runtime. Run `npm run bootstrap` first.");
}

export async function cacheRuntimeFromApp(source) {
  const validated = await validateRuntimeApp(path.resolve(source));
  const runtimeDir = path.dirname(cachedRuntimeApp);
  await mkdir(runtimeDir, { recursive: true });
  await rm(cachedRuntimeApp, { recursive: true, force: true });
  await run(SYSTEM_TOOLS.ditto, [validated, cachedRuntimeApp]);
  return await validateRuntimeApp(cachedRuntimeApp);
}

export async function hydrateSourcePayloadFromAsar(archive, {
  destination = sourceAppDir,
  expectedSha256 = upstreamAsarSha256,
} = {}) {
  const bytes = await readFile(archive);
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(`Upstream app.asar checksum mismatch: expected ${expectedSha256}, got ${actualSha256}`);
  }

  const hydrationRoot = path.join(cacheDir, "source-payloads");
  await mkdir(hydrationRoot, { recursive: true });
  const temporary = await mkdtemp(path.join(hydrationRoot, "grok-bot-018-"));
  try {
    extractAll(archive, temporary);
    for (const required of [
      "dist/electron-main/main.cjs",
      "dist/host/host-main.cjs",
      "dist/renderer/index.html",
    ]) {
      if (!(await stat(path.join(temporary, required))).isFile()) {
        throw new Error(`Upstream app.asar is missing ${required}`);
      }
    }
    await mkdir(destination, { recursive: true });
    await rm(path.join(destination, "dist"), { recursive: true, force: true });
    await cp(path.join(temporary, "dist"), path.join(destination, "dist"), {
      recursive: true,
      dereference: false,
      preserveTimestamps: true,
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return { archive, sha256: actualSha256, destination: path.join(destination, "dist") };
}

export async function hydrateSourcePayloadFromRuntime(runtimeApp, options = {}) {
  const archive = path.join(await validateRuntimeApp(runtimeApp), "Contents", "Resources", "app.asar");
  return hydrateSourcePayloadFromAsar(archive, options);
}

export async function copyTree(source, destination) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, dereference: false, preserveTimestamps: true });
}
