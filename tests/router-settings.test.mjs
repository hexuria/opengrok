import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const routerSourcePath = path.join(repoRoot, "frontend/src/recovered/features/settings/overlay/router.ts");

async function loadRouterModule() {
  const source = await readFile(routerSourcePath, "utf8");
  const { code: output } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("router provider preference defaults to Cursor and round-trips every provider", async () => {
  const router = await loadRouterModule();
  assert.deepEqual(router.ROUTER_PROVIDERS.map(({ id }) => id), ["cursor", "claude-code", "codex", "openrouter"]);
  assert.equal(router.parseRouterProviderPreference(null), "cursor");
  assert.equal(router.parseRouterProviderPreference("not-json"), "cursor");
  assert.equal(router.parseRouterProviderPreference(JSON.stringify({ schemaVersion: 1, provider: "unknown" })), "cursor");

  let stored = null;
  const persistence = {
    async read(key) {
      assert.equal(key, router.ROUTER_PROVIDER_PERSISTENCE_KEY);
      return stored;
    },
    async write(key, value) {
      assert.equal(key, router.ROUTER_PROVIDER_PERSISTENCE_KEY);
      stored = value;
    }
  };
  for (const provider of router.ROUTER_PROVIDERS) {
    await router.saveRouterProvider(persistence, provider.id);
    assert.equal(await router.loadRouterProvider(persistence), provider.id);
  }
});

test("OpenRouter model ids accept vendor/model and :free suffixes", async () => {
  const source = await readFile(path.join(repoRoot, "source/shared/inference-router.ts"), "utf8");
  const { code } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  assert.equal(loaded.parseOpenRouterModelId("openai/gpt-4o-mini"), "openai/gpt-4o-mini");
  assert.equal(loaded.parseOpenRouterModelId("  meta-llama/llama-3.2-3b-instruct:free  "), "meta-llama/llama-3.2-3b-instruct:free");
  assert.equal(loaded.parseOpenRouterModelId("openai/gpt-5.2"), "openai/gpt-5.2");
  assert.equal(loaded.parseOpenRouterModelId("minimax/minimax-m3:free"), "minimax/minimax-m3:free");
  assert.equal(loaded.parseOpenRouterModelId(""), null);
  assert.equal(loaded.parseOpenRouterModelId("gpt-4o-mini"), null);
  assert.equal(loaded.parseOpenRouterModelId("bad id/with space"), null);
  assert.equal(loaded.resolveOpenRouterModelId({
    explicit: "minimax/minimax-m3:free",
    stored: "nvidia/nemotron-3-ultra-550b-a55b:free",
    env: "openai/gpt-4o-mini",
  }), "minimax/minimax-m3:free");
  assert.equal(loaded.resolveOpenRouterModelId({
    stored: "minimax/minimax-m3:free",
    env: "nvidia/nemotron-3-ultra-550b-a55b:free",
  }), "minimax/minimax-m3:free");
  assert.equal(loaded.resolveOpenRouterModelId({ env: "nvidia/nemotron-3-ultra-550b-a55b:free" }), "nvidia/nemotron-3-ultra-550b-a55b:free");
});

test("settings registry exposes Router with the native settings icon contract", async () => {
  const source = await readFile(path.join(repoRoot, "frontend/src/recovered/features/settings/overlay/view.tsx"), "utf8");
  assert.match(source, /\{ id: "router", label: "Router", icon: "git-branch" \}/);
  assert.doesNotMatch(source, /\{ id: "computer", label: "Computer", icon: "computer" \}/);
});
