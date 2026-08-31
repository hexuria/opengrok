import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadDockerCliModule() {
  const source = await readFile(path.join(repoRoot, "source/electron-main/box/docker-cli.ts"), "utf8");
  const { code: output } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("GUI apps resolve Docker Desktop's CLI outside the LaunchServices PATH", async () => {
  const dockerCli = await loadDockerCliModule();
  const restrictedPath = "/usr/bin:/bin:/usr/sbin:/sbin";
  const candidates = dockerCli.dockerCliCandidates({ PATH: restrictedPath }, "/Users/tester");
  assert.equal(candidates[0], "/usr/local/bin/docker");
  assert.ok(candidates.includes("/Applications/Docker.app/Contents/Resources/bin/docker"));
  assert.ok(candidates.includes("/Users/tester/.docker/bin/docker"));
  assert.equal(
    dockerCli.dockerCliCandidates({ PATH: restrictedPath, DOCKER_BIN: "/custom/bin/docker" }, "/Users/tester")[0],
    "/custom/bin/docker",
  );

  const searchPath = dockerCli.dockerSearchPath({ PATH: restrictedPath }, "/Users/tester");
  assert.match(searchPath, /^\/usr\/local\/bin:/);
  assert.match(searchPath, /\/usr\/bin:\/bin:\/usr\/sbin:\/sbin$/);
});

test("local Docker connector spawns the resolved CLI instead of a PATH-only docker binary", async () => {
  const source = await readFile(path.join(repoRoot, "source/electron-main/box/local-docker-host-connector.ts"), "utf8");
  assert.match(source, /spawn\(executable,/);
  assert.doesNotMatch(source, /spawn\("docker"/);
  assert.match(source, /PATH: dockerSearchPath\(\)/);
});

test("local-docker reconnects to a ready VM gateway before spawning a desktop host", async () => {
  const source = await readFile(path.join(repoRoot, "source/electron-main/box/local-docker-host-connector.ts"), "utf8");
  assert.match(source, /export const DESKTOP_HOST_PORT = 1350/);
  assert.match(source, /chooseLocalHostTarget\(/);
  assert.match(source, /connectLocalDocker\(/);
  assert.match(source, /target === "docker-gateway"/);
  assert.match(source, /return await ensureLocalDockerBox\(/);
  assert.match(source, /SAND_USE_EXISTING_BOX_EXEC_DAEMON: "1"/);
  assert.doesNotMatch(source, /stale && !inspected\.running/);
  assert.match(source, /tokenForExistingBox\(/);
  assert.match(source, /Local VM is running\./);
  assert.doesNotMatch(source, /Container is starting\./);
  assert.doesNotMatch(source, /if \(inspected\.exists && \(inspected\.schemaVersion !== LOCAL_DOCKER_SCHEMA_VERSION \|\| inspected\.hostSha256 !== hostBundle\.sha256/);
});

test("Local VM reconnect starts a stopped container and does not stop Docker when leaving", async () => {
  const connector = await readFile(path.join(repoRoot, "source/electron-main/box/local-docker-host-connector.ts"), "utf8");
  const edge = await readFile(path.join(repoRoot, "source/electron-main/main-edge.ts"), "utf8");
  assert.match(connector, /target=docker-start container=/);
  assert.match(connector, /runDocker\(\["start", LOCAL_DOCKER_BOX_CONTAINER\]\)/);
  assert.doesNotMatch(connector, /await stopLocalDockerBox\(\)\.catch/);
  assert.match(edge, /mode === "local-docker"\) await \(deps\.startLocalDockerBox \?\? startLocalDockerBox\)\(settingsPath\)/);
  assert.doesNotMatch(edge, /stopLocalDockerBox/);
});

test("switching Local VM does not mint a placeholder agent when bots already exist", async () => {
  const fallback = await readFile(path.join(repoRoot, "source/host/extensions/session/session-materialization.ts"), "utf8");
  const gateway = await readFile(path.join(repoRoot, "source/host/host-gateway-api.ts"), "utf8");
  const sessions = await readFile(path.join(repoRoot, "source/host/extensions/transcript/session-runtime.ts"), "utf8");
  assert.match(fallback, /Existing local agents could not be opened/);
  assert.doesNotMatch(fallback, /if \(await this\.isAgentCapReached\(\)\) \{\s*for \(const agentId of await this\.listAgentRecordIds\(\)\)/);
  assert.match(gateway, /LEGACY_SAND_DEFAULT_AGENT_NAME/);
  assert.match(gateway, /isPlaceholderName/);
  assert.match(sessions, /ensureSessionInFlight/);
  assert.match(sessions, /openOrAdoptSession/);
});

test("chooseLocalHostTarget prefers a live Docker gateway and starts a stopped VM", async () => {
  const source = await readFile(path.join(repoRoot, "source/electron-main/box/local-host-target.ts"), "utf8");
  const { code: output } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  const mod = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
  assert.equal(mod.chooseLocalHostTarget({ dockerGatewayReady: true, desktopGatewayReady: false, dockerContainerRunning: true }), "docker-gateway");
  assert.equal(mod.chooseLocalHostTarget({ dockerGatewayReady: false, desktopGatewayReady: true, dockerContainerRunning: false }), "ensure-docker");
  assert.equal(mod.chooseLocalHostTarget({ dockerGatewayReady: false, desktopGatewayReady: false, dockerContainerRunning: true }), "wait-docker-gateway");
  assert.equal(mod.chooseLocalHostTarget({ dockerGatewayReady: false, desktopGatewayReady: false, dockerContainerRunning: false }), "ensure-docker");
});

test("subscription providers route the local runtime to the desktop host, not the Docker VM", async () => {
  const connector = await readFile(path.join(repoRoot, "source/electron-main/box/local-docker-host-connector.ts"), "utf8");
  const edge = await readFile(path.join(repoRoot, "source/electron-main/main-edge.ts"), "utf8");
  // Claude's binary and Keychain login only exist on this Mac: claude-code and
  // codex must connect to ensureDesktopHost before any Docker routing runs.
  assert.match(connector, /isSubscriptionInferenceProvider\(provider\)/);
  assert.match(connector, /target=desktop-host provider=/);
  assert.match(connector, /return await desktopConnect\(\);/);
  // Switching to a subscription provider must not boot the Docker VM.
  assert.match(edge, /nextRuntime === "local-docker" && !isSubscriptionInferenceProvider\(switched\.provider\)/);
  assert.match(edge, /nextRuntime === "local-docker" && !isSubscriptionInferenceProvider\(requested\)/);
});
