import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createPackage } from "@electron/asar";

import { downloadDmg, hydrateSourcePayloadFromAsar } from "../scripts/lib/runtime.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

test("checked-in production bindings resolve only to reviewed source", async (t) => {
  const manifestPath = path.join(
    repositoryRoot,
    "manifests/reconstruction/electron-main-production-bindings-manifest.json",
  );
  try {
    await access(manifestPath);
  } catch {
    t.skip("production bindings manifest is restored from the stow archive");
    return;
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.ok(manifest.bindings.length > 0);
  for (const binding of manifest.bindings) {
    assert.match(binding.module, /^\.\.\/\.\.\/source\//);
    const resolved = path.resolve(path.dirname(manifestPath), binding.module);
    assert.ok(resolved.startsWith(`${path.join(repositoryRoot, "source")}${path.sep}`));
    await access(resolved);
  }
});

test("bootstrap hydration verifies and extracts the minimum upstream runtime payload", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "grok-publication-bootstrap-"));
  try {
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    for (const relative of [
      "dist/electron-main/main.cjs",
      "dist/host/host-main.cjs",
      "dist/renderer/index.html",
    ]) {
      const target = path.join(source, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `fixture:${relative}\n`);
    }
    await writeFile(path.join(source, "package.json"), "{\"name\":\"fixture\"}\n");
    const archive = path.join(root, "app.asar");
    await createPackage(source, archive);
    const archiveBytes = await readFile(archive);
    const expectedSha256 = createHash("sha256").update(archiveBytes).digest("hex");

    const result = await hydrateSourcePayloadFromAsar(archive, { destination, expectedSha256 });
    assert.equal(result.sha256, expectedSha256);
    assert.equal(
      await readFile(path.join(destination, "dist/renderer/index.html"), "utf8"),
      "fixture:dist/renderer/index.html\n",
    );

    await assert.rejects(
      hydrateSourcePayloadFromAsar(archive, { destination, expectedSha256: "0".repeat(64) }),
      /checksum mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bootstrap copies a hash-checked archived DMG without fetching", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "grok-publication-bootstrap-dmg-"));
  try {
    const archivedPath = path.join(root, "Grok_Bot_0.18.0.dmg");
    const cachedPath = path.join(root, "cache", "Grok_Bot_0.18.0.dmg");
    const payload = "fixture-archived-dmg\n";
    await writeFile(archivedPath, payload);
    const expectedSha256 = createHash("sha256").update(payload).digest("hex");
    let fetched = 0;

    const result = await downloadDmg({
      archivedDmg: archivedPath,
      cachedDmg: cachedPath,
      dmgSha256: expectedSha256,
      fetch: async () => {
        fetched += 1;
        throw new Error("Cursor CDN must not be contacted when the archive is present");
      },
    });

    assert.equal(fetched, 0);
    assert.equal(result, cachedPath);
    assert.equal(await readFile(cachedPath, "utf8"), payload);

    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    for (const relative of [
      "dist/electron-main/main.cjs",
      "dist/host/host-main.cjs",
      "dist/renderer/index.html",
    ]) {
      const target = path.join(source, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `fixture:${relative}\n`);
    }
    const archive = path.join(root, "app.asar");
    await createPackage(source, archive);
    const archiveBytes = await readFile(archive);
    const asarSha256 = createHash("sha256").update(archiveBytes).digest("hex");
    const hydrated = await hydrateSourcePayloadFromAsar(archive, { destination, expectedSha256: asarSha256 });
    assert.equal(hydrated.sha256, asarSha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bootstrap fails closed when the archived DMG hash does not match", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "grok-publication-bootstrap-dmg-mismatch-"));
  try {
    const archivedPath = path.join(root, "Grok_Bot_0.18.0.dmg");
    const cachedPath = path.join(root, "cache", "Grok_Bot_0.18.0.dmg");
    await mkdir(path.dirname(cachedPath), { recursive: true });
    await writeFile(archivedPath, "fixture-bad-archive\n");
    let fetched = 0;

    await assert.rejects(
      downloadDmg({
        archivedDmg: archivedPath,
        cachedDmg: cachedPath,
        dmgSha256: "0".repeat(64),
        fetch: async () => {
          fetched += 1;
          throw new Error("hash mismatch must not fall back to the CDN");
        },
      }),
      /Archived DMG checksum mismatch/,
    );

    assert.equal(fetched, 0);
    await assert.rejects(access(cachedPath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
