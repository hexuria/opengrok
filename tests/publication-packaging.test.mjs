import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import createIgnore from "ignore";

import { resolvePackagedAppArtifacts } from "../scripts/lib/packaged-app.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("packaged verification authority is the selected app bundle", () => {
  const appPath = path.join(repoRoot, "dist", "Example.app");
  const artifacts = resolvePackagedAppArtifacts(appPath);
  assert.equal(artifacts.appPath, appPath);
  assert.equal(artifacts.asarPath, path.join(appPath, "Contents", "Resources", "app.asar"));
  assert.equal(artifacts.unpackedPath, `${artifacts.asarPath}.unpacked`);
  assert.notEqual(artifacts.asarPath, path.join(repoRoot, ".build", "app.asar"));
  assert.throws(() => resolvePackagedAppArtifacts(path.join(repoRoot, ".build", "app.asar")), /\.app bundle/);
});

// Reversed deliberately on 30 Aug 2026. This used to assert that the frontend
// reconstruction stayed addable; the material recovered from the upstream
// binary now lives only in the private hexuria/opengrok-stow archive, so the
// guard is that it can never be committed here again. See CLAUDE.md.
test("publication ignore rules keep the recovered material out of this repository", async () => {
  const ignoreRules = await readFile(path.join(repoRoot, ".gitignore"), "utf8");
  assert.match(ignoreRules, /^\/recovered\/$/m);
  assert.doesNotMatch(ignoreRules, /^recovered\/$/m);
  assert.match(ignoreRules, /^docs\/$/m);
  assert.match(ignoreRules, /^docq\/$/m);
  const matcher = createIgnore().add(ignoreRules);
  for (const excluded of [
    "frontend/src/recovered/ui/sand-form-primitives.css",
    "source/packages/proto/generated/aiserver/v1/grok_bot_pb.ts",
    "source/packages/redacted-protos/generated/agent/v1/agent_redacted.ts",
    "manifests/reconstruction/evidence/anything.js",
    "patches/@connectrpc__connect@1.6.1.patch",
    "research-archives/original/0.18.0/SHA256SUMS",
    "PROVENANCE.md",
    "docs/ARCHITECTURE.md",
    "docq/README.md",
  ]) {
    assert.equal(matcher.ignores(excluded), true, `${excluded} must stay out of this repository`);
  }
  assert.equal(matcher.ignores("recovered/generated-output.txt"), true, "root recovery output must remain ignored");
  // Our own work must stay committable.
  for (const kept of ["scripts/lib/select-messages-helper.mjs", "source/host/gateway-server.ts"]) {
    assert.equal(matcher.ignores(kept), false, `${kept} must remain addable`);
  }
});

test("default packaging ships the Vite renderer", async () => {
  const source = await readFile(path.join(repoRoot, "scripts", "package-macos.mjs"), "utf8");
  const build = await readFile(path.join(repoRoot, "scripts", "build.mjs"), "utf8");
  assert.match(source, /import \{ buildReconstructedAsar \} from "\.\/clean-build\.mjs"/);
  assert.match(source, /await buildReconstructedAsar\(\)/);
  assert.doesNotMatch(source, /buildFidelityReconstructedAsar/);
  assert.match(build, /import \{ buildReconstructedAsar \} from "\.\/clean-build\.mjs"/);
  assert.match(build, /await buildReconstructedAsar\(\)/);
  assert.doesNotMatch(build, /buildFidelityReconstructedAsar/);
});

test("default packaging wraps npm Electron and does not require the official Mac shell", async () => {
  const source = await readFile(path.join(repoRoot, "scripts", "package-macos.mjs"), "utf8");
  const bundle = await readFile(path.join(repoRoot, "scripts", "lib", "package-app-bundle.mjs"), "utf8");
  const shell = await readFile(path.join(repoRoot, "scripts", "lib", "electron-shell.mjs"), "utf8");
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts.bootstrap, undefined);
  assert.equal(pkg.scripts["package:diagnostic"], undefined);
  assert.match(source, /assembleReconstructedAppBundle/);
  assert.match(bundle, /stageNpmElectronShell/);
  assert.match(bundle, /signAppBundle/);
  assert.doesNotMatch(source, /signAppBundleForDistribution/);
  assert.doesNotMatch(bundle, /signAppBundleForDistribution/);
  assert.doesNotMatch(source, /verifyOfficialMacReference/);
  assert.doesNotMatch(bundle, /verifyOfficialMacReference/);
  assert.doesNotMatch(source, /ditto, \[runtimeApp, outputApp\]/);
  assert.doesNotMatch(bundle, /ditto, \[runtimeApp, outputApp\]/);
  assert.doesNotMatch(source, /officialMacReleaseShellHash/);
  assert.doesNotMatch(source, /expectedSignatureExcludedMachOHash/);
  assert.match(shell, /CFBundleName/);
  assert.match(shell, /<string>sand<\/string>/);
  assert.match(shell, /<string>opengrok<\/string>/);
  assert.match(shell, /MACOS_EXECUTABLE_NAME/);
  const verify = await readFile(path.join(repoRoot, "scripts", "verify.mjs"), "utf8");
  assert.match(verify, /\["sand", "opengrok"\]/);
  assert.doesNotMatch(verify, /checksum-pinned-artifact-runtime/);
  const cleanBuild = await readFile(path.join(repoRoot, "scripts", "lib", "clean-build.mjs"), "utf8");
  assert.match(cleanBuild, /wraps npm Electron 42\.1\.0/);
  assert.doesNotMatch(cleanBuild, /reuses the checksum-pinned, ABI-matched Electron 0\.18 application shell/);
  assert.match(cleanBuild, /rebuilt against Electron 42\.1\.0 \(ABI 146\)/);
  assert.doesNotMatch(cleanBuild, /ABI-matched native and packaged dependencies are copied from the checksum-pinned 0\.18 runtime/);
  assert.doesNotMatch(cleanBuild, /buildFidelityDistribution/);
  assert.doesNotMatch(cleanBuild, /checksum-pinned-artifact-runtime/);
  const natives = await readFile(path.join(repoRoot, "scripts", "build-electron-natives.mjs"), "utf8");
  const asar = await readFile(path.join(repoRoot, "scripts", "lib", "build-asar.mjs"), "utf8");
  assert.match(natives, /better-sqlite3/);
  assert.match(natives, /stageRetainedElectronNatives/);
  assert.match(asar, /stageElectronNativeDeps/);
  assert.doesNotMatch(asar, /stageRetainedElectronNatives/);
  assert.doesNotMatch(asar, /\["deps", "native"\]/);
  assert.doesNotMatch(asar, /resolveRuntimeApp/);
  const cleanBuildScripts = await readFile(path.join(repoRoot, "scripts", "clean-build.mjs"), "utf8");
  assert.match(cleanBuildScripts, /overlayRetainedNativesFromActivations/);
  assert.match(cleanBuildScripts, /retainedNativePackagesFromActivations/);
  assert.match(cleanBuildScripts, /Packaging refuses 0\.18 retained natives/);
  assert.doesNotMatch(cleanBuildScripts, /buildFidelityReconstructedAsar/);
  assert.doesNotMatch(cleanBuildScripts, /applyOriginalRendererRouterPatch/);
});

test("package:vite shares the Vite asar builder and writes a side-by-side app", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts.package, "npm run check && node scripts/package-macos.mjs");
  assert.equal(pkg.scripts["package:vite"], "node scripts/package-vite.mjs");
  assert.equal(pkg.scripts["package:diagnostic"], undefined);
  assert.equal(pkg.scripts.bootstrap, undefined);
  const source = await readFile(path.join(repoRoot, "scripts", "package-vite.mjs"), "utf8");
  const macos = await readFile(path.join(repoRoot, "scripts", "package-macos.mjs"), "utf8");
  const config = await readFile(path.join(repoRoot, "scripts", "lib", "config.mjs"), "utf8");
  assert.match(source, /import \{ buildReconstructedAsar \} from "\.\/clean-build\.mjs"/);
  assert.match(source, /await buildReconstructedAsar\(\)/);
  assert.doesNotMatch(source, /buildFidelityReconstructedAsar/);
  assert.match(macos, /import \{ buildReconstructedAsar \} from "\.\/clean-build\.mjs"/);
  assert.match(macos, /await buildReconstructedAsar\(\)/);
  assert.doesNotMatch(macos, /buildFidelityReconstructedAsar/);
  assert.match(source, /assembleReconstructedAppBundle/);
  assert.match(macos, /assembleReconstructedAppBundle/);
  assert.match(config, /Open Grok Vite\.app/);
});

test("Router settings use the trusted backend and display recorded inference usage", async () => {
  const selectHelper = await readFile(path.join(repoRoot, "scripts/lib/select-messages-helper.mjs"), "utf8");
  const preload = await readFile(path.join(repoRoot, "source", "electron-preload", "preload.ts"), "utf8");
  const mainEdge = await readFile(path.join(repoRoot, "source", "electron-main", "main-edge.ts"), "utf8");
  const inference = await readFile(path.join(repoRoot, "source", "host", "extensions", "inference", "inference-service.ts"), "utf8");
  const cursorSession = await readFile(path.join(repoRoot, "source", "host", "extensions", "inference", "cursor-session.ts"), "utf8");
  const cursorBackend = await readFile(path.join(repoRoot, "source", "shared", "node", "cursor-backend", "cursor-inference.ts"), "utf8");
  const providers = await readFile(path.join(repoRoot, "source", "host", "extensions", "inference", "provider-session.ts"), "utf8");
  const codexDirect = await readFile(path.join(repoRoot, "source", "host", "extensions", "inference", "codex-direct-responses.ts"), "utf8");
  const turnShell = await readFile(path.join(repoRoot, "source", "host", "runner", "turn-run-shell.ts"), "utf8");
  const coordinator = await readFile(path.join(repoRoot, "source", "node-agent-coordinator", "inference-router.ts"), "utf8");
  const coordinatorMain = await readFile(path.join(repoRoot, "source", "node-agent-coordinator", "main.ts"), "utf8");
  const mcpBridge = await readFile(path.join(repoRoot, "source", "node-agent-coordinator", "routed-mcp-bridge.ts"), "utf8");
  const localDocker = await readFile(path.join(repoRoot, "source", "electron-main", "box", "local-docker-host-connector.ts"), "utf8");
  assert.match(preload, /getInferenceRouter: \(\) => edge\("getInferenceRouter"\)/);
  assert.match(preload, /setOpenRouterModel: \(model: string\) => edge\("setInferenceRouter", \{ openRouterModel:/);
  // Settings must render from what is already on disk. Measured with a stopped
  // Docker engine, the box read did not reject — it simply never answered, and
  // held the whole panel for seventeen seconds.
  assert.match(mainEdge, /HOST_SETTINGS_READ_BUDGET_MS/);
  assert.match(mainEdge, /withDeadline\(deps\.readHostSettingsFromBox\(\)/);
  // The provider and computer come from the local store and must not be gated
  // behind it, and the CLI probe must happen once per refresh, not twice.
  assert.match(mainEdge, /localStatus\.then\(\(status\) => firstRunLoginsOf\(deps, status\)\)/);
  assert.match(mainEdge, /openRouterModel/);
  assert.match(mainEdge, /persistOpenRouterModel/);
  assert.match(providers, /OpenRouter needs a model id/);
  assert.match(providers, /resolveOpenRouterModelId/);
  assert.match(coordinator, /openRouterModel: settings\.getOpenRouterModel\(\)/);
  assert.doesNotMatch(providers, /openai\/gpt-5\.2/);
  assert.match(preload, /getBoxRuntime: \(\) => edge\("getBoxRuntime"\)/);
  assert.match(preload, /setBoxRuntime: \(mode: string\) => edge\("setBoxRuntime", \{ mode \}\)/);
  assert.match(preload, /setProviderComputer: \(kind: string, enabled: boolean\) => edge\("setProviderComputer", \{ kind, enabled \}\)/);
  assert.match(preload, /setComputerScreen: \(screen: string\) => edge\("setComputerScreen", \{ screen \}\)/);
  assert.match(preload, /skipCursorLoginWall/);
  assert.match(mainEdge, /skipCursorLoginWall/);
  assert.doesNotMatch(mainEdge, /logoutCursor: \(\) => withPreservedComputers/);
  assert.doesNotMatch(mainEdge, /syncHostSettingsToBox\(\{ inferenceProvider:/);
  assert.match(mainEdge, /applyInferenceProviderSwitch/);
  assert.match(mainEdge, /invoke\(deps\.settingsStore, "setInferenceProvider", value\)/);
  assert.match(mainEdge, /provider: switched\.provider/);
  assert.match(mainEdge, /invoke\(deps\.boxRecovery, "restartCoordinator"\)/);
  assert.match(mainEdge, /mode === "local-docker"\) await \(deps\.startLocalDockerBox \?\? startLocalDockerBox\)\(settingsPath\)/);
  assert.match(mainEdge, /coerceBoxRuntimeForProvider/);
  assert.match(mainEdge, /nextRuntime !== currentRuntime/);
  // Leaving a runtime must not stop Docker for anything else using it.
  assert.doesNotMatch(mainEdge, /stopLocalDockerBox/);
  assert.match(mainEdge, /setBoxRuntime", previous\)/);
  assert.match(mainEdge, /checkoutWindows365/);
  assert.match(localDocker, /public\.ecr\.aws\/k0i0n2g5\/cursorenvironments\/universal:sand-box-latest/);
  assert.match(localDocker, /"127\.0\.0\.1:1340:1340"/);
  assert.match(localDocker, /SAND_BOX_AUTO_UPDATE=0/);
  assert.match(localDocker, /dst=\/home\/box\/sand-host\/host-main\.cjs,readonly/);
  // local-docker routes by provider: subscription CLIs get the desktop host
  // (claude cannot run inside the linux VM), everything else the Docker VM.
  assert.match(localDocker, /isSubscriptionInferenceProvider\(provider\)/);
  assert.match(localDocker, /return await desktopConnect\(\);/);
  assert.match(localDocker, /return await localConnect\(\);/);
  // Multi-select mode (scripts/lib/select-messages-helper.mjs): JS-store selection
  // (virtualization-safe), a toolbar under the chat header with a master checkbox and
  // icon buttons, checkboxes painted on an overlay, ids from the row's entry label on
  // every route, the native menu entry point, feature-detected Collections actions, and a
  // delete confirm that says whether the server deletes or only this device hides.
  assert.match(selectHelper, /sand-conversation-entry-\(\.\+\?\)-\(\?:author\|timestamp\|body\)/);
  assert.match(selectHelper, /deleteTranscriptEntries\(\{agentId:ag,entryIds:ids\}\)/);
  assert.match(selectHelper, /for everyone on this server\?/);
  assert.match(selectHelper, /on this device\? The server copy is unchanged\./);
  assert.match(selectHelper, /Add "\+fresh\.length\+" loaded/);
  assert.match(selectHelper, /All loaded added/);
  assert.doesNotMatch(selectHelper, /Select all/, "a virtualized feed cannot promise all");
  assert.doesNotMatch(selectHelper, /coordinatorPort/);
  // Remote-box agents answer through Cursor's in-box gateway (not extensible),
  // so delete falls back to device-local tombstones filtered in the row
  // builder before grouping.
  assert.match(selectHelper, /__sandTombstones/);
  assert.match(selectHelper, /sandTombstones\.v1/);
  assert.match(selectHelper, /New collection\\\\u2026/);
  assert.match(selectHelper, /ev\.key==="A"\|\|ev\.key==="a"/);
  assert.doesNotMatch(localDocker, /await stopLocalDockerBox\(\)\.catch/);
  assert.match(localDocker, /Leave grok-bot-local-vm running/);
  assert.match(localDocker, /target=account-computer/);
  assert.match(localDocker, /const connection = await remote\.connect\(\)/);
  assert.match(mainEdge, /account: getAccountComputerStatus\(\)/);
  assert.match(localDocker, /ensureDesktopHost\(/);
  assert.match(localDocker, /connectLocalDocker\(/);
  assert.match(localDocker, /chooseLocalHostTarget\(/);
  assert.match(localDocker, /SAND_USE_EXISTING_BOX_EXEC_DAEMON: "1"/);
  assert.match(localDocker, /DESKTOP_HOST_PORT = 1350/);
  assert.match(localDocker, /spawn\(executable,/);
  assert.match(localDocker, /PATH: dockerSearchPath\(\)/);
  assert.match(inference, /recordInferenceUsage\(provider/);
  assert.match(inference, /routerSettings\.getInferenceProvider\(\)/);
  assert.match(inference, /typeof extendedUsage\.then === "function"/);
  assert.match(inference, /createProviderPromptSession\(provider\)/);
  assert.match(providers, /https:\/\/chatgpt\.com\/backend-api\/codex/);
  assert.match(providers, /headers\.set\("ChatGPT-Account-Id", credentials\.accountId\)/);
  assert.match(providers, /streamCodexDirectResponses/);
  assert.doesNotMatch(providers, /provider\.responses\(configuredCodexModel\(\)\)/);
  assert.match(codexDirect, /store: false/);
  assert.match(codexDirect, /response\.output_text\.delta/);
  assert.match(codexDirect, /type: "function_call_output"/);
  assert.match(providers, /parameters: jsonSchema\(parameters\)/);
  assert.match(providers, /Your inference provider is \$\{label\}/);
  assert.match(providers, /Do not claim to be Grok, Grok Bot the model, or xAI/);
  assert.doesNotMatch(providers, /You are Grok Bot, a warm, concise desktop assistant/);
  assert.match(providers, /Never suggest crontab, launchd, Task Scheduler, or an OS timer/);
  assert.match(providers, /permissionMode: mcpServerUrl == null \? "default" : "bypassPermissions"/);
  assert.match(providers, /mcpServers: \{ grok_bot_plugins:/);
  assert.match(providers, /recordRoutedUsage\(provider, usage\)/);
  assert.match(providers, /queryClaude/);
  assert.match(providers, /tools: mcpServerUrl == null \? \[\] : \["mcp__grok_bot_plugins__\*"\]/);
  assert.match(providers, /https:\/\/openrouter\.ai\/api\/v1/);
  assert.match(providers, /OpenRouter needs OPENROUTER_API_KEY/);
  assert.match(cursorSession, /routedProvider !== "cursor"/);
  assert.match(cursorSession, /createProviderPromptSession\(routedProvider\)/);
  assert.match(cursorBackend, /routedProvider !== "cursor"/);
  assert.match(cursorBackend, /createProviderPromptSession\(routedProvider\)/);
  assert.match(turnShell, /inferenceProvider === "cursor"/);
  assert.match(turnShell, /createProviderPromptSession\(inferenceProvider\)/);
  assert.match(coordinator, /method !== "sendPrompt" \|\| provider === "cursor"/);
  assert.match(coordinator, /executeTool: async \(definition, toolArgs, toolCallId\)/);
  assert.match(coordinatorMain, /command\(commands, "listRoutedMcpTools", args\)/);
  assert.match(coordinator, /inference-router-transcript\.json/);
  assert.match(mcpBridge, /openWorldHint: !readOnly/);
  assert.match(mcpBridge, /extraTools/);
  assert.match(coordinator, /LOCAL_AUTOMATION_METHODS/);
  // The routed loop carries more than one coordinator-native tool now, so it
  // looks the tool up by name instead of comparing against a single hardcoded
  // one, and every native tool reaches both the direct path and the MCP bridge.
  assert.match(coordinator, /const nativeTools = \[automations\.extraTool\(agentId\), \.\.\.messagesTools\.tools\(agentId\)\]/);
  assert.match(coordinator, /nativeByName/);
  assert.doesNotMatch(coordinator, /=== "update_state"/);
  // The read is delegated to the main process, not run in the coordinator. The
  // coordinator is an Electron utility helper — a separate signed bundle with
  // no Full Disk Access grant of its own — so opening chat.db there is denied.
  // Main is the bundle the user actually granted access to.
  assert.match(coordinator, /dispatchRemote\("runMessagesOp", op\)/);
  assert.doesNotMatch(coordinator, /import \{ runMessagesOp \} from "\.\.\/host\/local-exec\/messages-op\.js"/);
  // Reading private conversations on the routed path is gated by the same card
  // the Cursor route uses, and only asks this coordinator raised are answered.
  assert.match(coordinator, /method === "resolveLocalToolPermission" && messagesTools\.resolveAsk\(args\)/);
  assert.match(coordinator, /schemaVersion: 2/);
  assert.match(coordinator, /\["getAgentTranscriptTail", "openAgentTail", "getAgentTranscriptWindow"\]/);
  assert.match(coordinator, /\.map\(projectInferenceRouterTranscriptEntry\)/);
  assert.match(coordinator, /readonly richText\?: string/);
  assert.match(coordinator, /richText: entry\.richText/);
  assert.match(coordinator, /setTimeout\(resolve, ROUTED_COMPOSING_REVEAL_MS\)/);
  assert.match(coordinator, /method === "reactToMessage"/);
  assert.match(coordinator, /reaction\.by === "me"/);
  assert.match(coordinator, /currentActivity: \{ kind: "thinking" \}/);
  assert.match(coordinator, /onTextDelta/);
  assert.match(coordinator, /streaming/);
  assert.match(coordinator, /postEvent\("agents"/);
  assert.match(coordinator, /createRoutedMcpBridge/);
  assert.match(coordinator, /listRoutedMcpTools/);
  assert.match(coordinator, /executeRoutedMcpTool/);
  assert.match(mcpBridge, /server\.listen\(0, "127\.0\.0\.1"/);
  assert.match(mcpBridge, /readOnlyHint: readOnly/);
  assert.match(mcpBridge, /request\.url !== `\/mcp\/\$\{secret\}`/);
  assert.match(coordinator, /kind: "send-message"/);
  assert.match(coordinatorMain, /createCoordinatorInferenceRouter/);
  assert.match(coordinatorMain, /routed\.handled/);
});

test("Collections ships its page assets and its own preload in the packaged layout", async () => {
  const cleanBuild = await readFile(path.join(repoRoot, "scripts", "lib", "clean-build.mjs"), "utf8");
  const resourceContract = await readFile(path.join(repoRoot, "source", "electron-main", "production-ipc-contract.ts"), "utf8");
  const mainServices = await readFile(path.join(repoRoot, "source", "electron-main", "main-production-services.ts"), "utf8");
  const collectionsHtml = await readFile(path.join(repoRoot, "source", "electron-collections", "page", "collections.html"), "utf8");
  const preload = await readFile(path.join(repoRoot, "source", "electron-preload", "preload.ts"), "utf8");
  const coordinatorMainTable = await readFile(path.join(repoRoot, "source", "shared", "rpc", "coordinator-main.ts"), "utf8");
  // Clean-source outputs: the preload bundle and the shared bubble renderer the
  // page loads as a classic script (file:// blocks ES module imports).
  assert.match(cleanBuild, /runtime: "collections-preload", path: "dist\/electron-preload\/preload-collections\.cjs", mode: "clean-source"/);
  assert.match(cleanBuild, /runtime: "collections-page-renderer".*mode: "clean-source"/);
  assert.match(cleanBuild, /bundlePreloadSource\("source\/electron-preload\/runtime\/collections\.ts", path\.join\(outputRoot, "dist\/electron-preload\/preload-collections\.cjs"\)\)/);
  assert.match(cleanBuild, /stageCollectionsPage\(outputRoot\)/);
  assert.match(cleanBuild, /collectionsPageStaticAssets = Object\.freeze\(\["collections\.html", "collections\.css", "collections\.js"\]\)/);
  assert.match(cleanBuild, /globalName: "SandCollectionRender"/);
  // Overlaid into the staged app beside the other clean replacements.
  assert.match(cleanBuild, /"dist\/electron-preload\/preload-collections\.cjs",\n {2}"dist\/electron-collections",/);
  assert.match(resourceContract, /collectionsPreload: "dist\/electron-preload\/preload-collections\.cjs"/);
  assert.match(resourceContract, /collectionsPage: "dist\/electron-collections\/page\/collections\.html"/);
  assert.match(resourceContract, /"sand:collections-list"/);
  assert.match(resourceContract, /"sand:collections-open-original"/);
  // Resolved relative to the packaged dist root, so loadFile works inside the ASAR.
  assert.match(mainServices, /collectionsHtmlPath: join\(args\.moduleDir, "\.\.", "electron-collections", "page", "collections\.html"\)/);
  assert.match(mainServices, /collectionsPreloadPath: join\(args\.moduleDir, "\.\.", "electron-preload", "preload-collections\.cjs"\)/);
  assert.match(collectionsHtml, /<script src="\.\/collection-render\.js"><\/script>/);
  assert.match(collectionsHtml, /<script src="\.\/collections\.js"><\/script>/);
  assert.match(collectionsHtml, /script-src 'self' file:/);
  assert.match(preload, /addMessages: \(args: \{ readonly agentId: string; readonly entryIds: readonly string\[\]/);
  assert.match(preload, /edge\("addCollectionMessages", args\)/);
  // Snapshotting rides an existing gateway method name; a new one would be
  // rejected by Cursor's in-box gateway for remote agents.
  assert.match(coordinatorMainTable, /getAgentTranscriptWindow: \{ args: "object" \}/);
});
