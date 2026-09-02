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
  const matcher = createIgnore().add(ignoreRules);
  for (const excluded of [
    "frontend/src/recovered/ui/sand-form-primitives.css",
    "source/packages/proto/generated/aiserver/v1/grok_bot_pb.ts",
    "source/packages/redacted-protos/generated/agent/v1/agent_redacted.ts",
    "manifests/reconstruction/evidence/anything.js",
    "patches/@connectrpc__connect@1.6.1.patch",
    "research-archives/original/0.18.0/SHA256SUMS",
    "PROVENANCE.md",
    "docs/research/versions/rpc-methods-0.30.txt",
    "docs/gap-analysis-0.30.md",
  ]) {
    assert.equal(matcher.ignores(excluded), true, `${excluded} must stay out of this repository`);
  }
  assert.equal(matcher.ignores("recovered/generated-output.txt"), true, "root recovery output must remain ignored");
  // Our own work must stay committable.
  for (const kept of ["scripts/lib/router-renderer-patch.mjs", "source/host/gateway-server.ts", "docs/ARCHITECTURE.md"]) {
    assert.equal(matcher.ignores(kept), false, `${kept} must remain addable`);
  }
});

test("default packaging keeps the polished checksum-pinned renderer", async () => {
  const source = await readFile(path.join(repoRoot, "scripts", "package-macos.mjs"), "utf8");
  assert.match(source, /import \{ buildFidelityReconstructedAsar \} from "\.\/clean-build\.mjs"/);
  assert.match(source, /await buildFidelityReconstructedAsar\(\)/);
});

test("Router settings use the trusted backend and display recorded inference usage", async () => {
  const rendererPatch = await readFile(path.join(repoRoot, "scripts", "lib", "router-renderer-patch.mjs"), "utf8");
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
  assert.match(rendererPatch, /desktop\.agent\.getInferenceRouter\(\)/);
  assert.match(rendererPatch, /desktop\.agent\.setInferenceRouter\(n\)/);
  assert.match(rendererPatch, /desktop\.agent\.getBoxRuntime\(\)/);
  assert.match(rendererPatch, /desktop\.agent\.setBoxRuntime\(n\)/);
  assert.match(rendererPatch, /Grok VM/);
  assert.match(rendererPatch, /value:"remote"/);
  assert.match(rendererPatch, /Computer for this account/);
  assert.match(rendererPatch, /title:"Computer",children:a.jsx\(RBoxRuntime/);
  assert.match(rendererPatch, /n\.value!=="remote"/);
  // The Router and Computer panels used to poll every 2s, and each refresh
  // shells out to the provider CLIs — continuous subprocess churn for as long
  // as Settings stayed open.
  assert.doesNotMatch(rendererPatch, /setInterval\(load,2e3\)/);
  assert.match(rendererPatch, /setInterval\(load,15e3\)/);
  // Neither panel may present a default as though it were the saved choice:
  // starting at "cursor"/"remote" made every reopen look like the setting had
  // reverted. Both seed from the last answer instead.
  assert.match(rendererPatch, /let RRouterLast=null;/);
  assert.match(rendererPatch, /let RBoxLast=null;/);
  assert.match(rendererPatch, /RRouterLast\?\?RRouterSeed\(\)\?\?\{provider:null/);
  assert.match(rendererPatch, /sandRouterSeed\.v1/);
  // The in-memory cache is empty until the Computer panel has run once, so
  // opening Settings straight onto Usage rendered the wrong provider and
  // corrected itself a moment later. Both panels seed from the mode already on
  // disk, which costs no round-trip, and only then confirm it with the main
  // process.
  assert.match(rendererPatch, /RBoxLast\?\?\{mode:ROpenGrokSeeded\(\)\?"opengrok":null,provider:null/);
  assert.match(rendererPatch, /function ROpenGrokSeeded\(\)/);
  assert.match(rendererPatch, /function ROpenGrokActive\(\)\{const\[v,setV\]=de\.useState\(\(\)=>ROpenGrokSeeded\(\)\)/);
  assert.doesNotMatch(rendererPatch, /id:"computer",label:"Computer"/);
  assert.doesNotMatch(rendererPatch, /RComputerPanel/);
  // The live runtime picker replaced the placeholder computer toggles.
  assert.doesNotMatch(rendererPatch, /Use local Docker VM/);
  // The ban was a proxy for the placeholder computer toggles (asserted gone
  // just above). Boolean settings now use Ne, the bundle's own Switch, rather
  // than any hand-rolled control: reuse is the point, so pin that.
  assert.match(rendererPatch, /a\.jsx\(Ne,\{label:"This computer accepts bot commands",isChecked:/);
  assert.doesNotMatch(rendererPatch, /const RSwitch=/);
  assert.doesNotMatch(rendererPatch, /role:"switch"/);
  assert.match(rendererPatch, /desktop\.agent\.setComputerScreen/);
  assert.match(rendererPatch, /desktop\.agent\.startSubscriptionLogin/);
  assert.match(rendererPatch, /Official Codex\/ChatGPT login on this Mac/);
  assert.match(rendererPatch, /Paste an API key first/);
  assert.match(rendererPatch, /label:"Claude Code"/);
  assert.match(rendererPatch, /label:"Codex"/);
  // Replaced by the login page's gear and provider sheet.
  assert.match(rendererPatch, /sand-lp-back/);
  assert.match(rendererPatch, /function RSendNotDelivered\(\)/);
  assert.match(rendererPatch, /if\(we==null\)\{RSendNotDelivered\(\);return\}/);
  assert.match(rendererPatch, /patchOriginalMainChrome/);
  assert.match(rendererPatch, /sand-cursor-login-skip/);
  assert.match(rendererPatch, /first-run-login-skip/);
  assert.match(rendererPatch, /data-computer-screen-switcher/);
  assert.match(rendererPatch, /a\.setInferenceRouter\(pick\)/);
  assert.match(rendererPatch, /desktop\.secrets\.upsert/);
  assert.doesNotMatch(rendererPatch, /settings\.router-provider\.v1/);
  assert.match(rendererPatch, /id:"dictation",label:"Dictation"/);
  assert.match(rendererPatch, /id:"usage",label:"Usage"/);
  assert.match(rendererPatch, /RDictationPanel/);
  assert.match(rendererPatch, /Requests/);
  assert.match(rendererPatch, /Input tokens/);
  assert.match(rendererPatch, /Last used/);
  assert.match(rendererPatch, /Tracked activity/);
  assert.match(rendererPatch, /RRouterProviders\.filter/);
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
  assert.match(rendererPatch, /claude \/login/);
  assert.match(rendererPatch, /codex login/);
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
  assert.match(rendererPatch, /getWindows365Settings/);
  assert.match(rendererPatch, /checkoutWindows365/);
  assert.match(rendererPatch, /Tenant ID/);
  assert.match(rendererPatch, /RW365Setup/);
  assert.match(rendererPatch, /Windows 365 credentials/);
  assert.doesNotMatch(rendererPatch, /title:"Windows 365 credentials"/);
  // 0.29 parity: jump-to-newest pill and first-layout reveal gate.
  assert.match(rendererPatch, /sand-jump-newest/);
  assert.match(rendererPatch, /const JUMP_PILL_HELPER =/);
  // The pill is fixed-positioned on document.body, so it lands in the root
  // stacking context: at z-index 40 it painted over the composer and stayed up
  // over the fullscreen computer view. It only needs to clear transcript rows,
  // and it hides outright whenever an overlay surface is showing.
  assert.match(rendererPatch, /\.sand-jump-newest\{position:fixed;z-index:5;/);
  assert.match(rendererPatch, /var covered=function\(\)/);
  assert.match(rendererPatch, /\.sand-computer-fullscreen/);
  assert.match(rendererPatch, /if\(!el\|\|covered\(\)\|\|nativePill\(\)/);
  assert.match(rendererPatch, /const REVEAL_GATE_HELPER =/);
  // 0.29 parity: math rendered inside the markdown pipeline (remark-math +
  // KaTeX MathML component), never as DOM post-processing - mutating
  // React-owned message nodes loses text on reconciliation.
  assert.match(rendererPatch, /sand-math-kit\.js/);
  assert.match(rendererPatch, /patchOriginalMathPipeline/);
  assert.match(rendererPatch, /"sand-math"/);
  assert.doesNotMatch(rendererPatch, /renderMathInElement/);
  assert.match(rendererPatch, /const DRAFTS_HELPER =/);
  assert.match(rendererPatch, /const MEDIA_DEBUG_HELPER =/);
  assert.match(rendererPatch, /const DEEPLINK_MSG_HELPER =/);
  assert.match(rendererPatch, /Copy message ID/);
  assert.match(rendererPatch, /Copy message URL/);
  assert.match(rendererPatch, /data-entry-id/);
  assert.match(rendererPatch, /KATEX_BUNDLE_PREPEND \+ MEDIA_META_HELPER \+ JUMP_PILL_HELPER \+ REVEAL_GATE_HELPER \+ DRAFTS_HELPER \+ MEDIA_DEBUG_HELPER \+ DEEPLINK_MSG_HELPER \+ SELECT_MODE_HELPER \+ LOCAL_TOOL_ASK_HELPER \+ A11Y_ANNOUNCE_HELPER \+ OPENGROK_MODE_HELPER \+ LOGIN_PROVIDER_HELPER \+ ASKPASS_CARD_HELPER \+ ACCOUNT_CARD_HELPER \+ AGENT_AUTOREVIEW_HELPER \+ patched/);
  // A screen reader is told nothing when a reply starts or finishes. The
  // announcer owns its own live region because the bundle has no shared
  // announce hook, and keys off data-pending so it needs no drift-prone anchor.
  assert.match(rendererPatch, /const A11Y_ANNOUNCE_HELPER =/);
  // The login wall may only be bypassed when there is no backend to sign in to.
  // An OpenGrok server is one, so every gate must consult the same rule.
  assert.match(rendererPatch, /const OPENGROK_MODE_HELPER =/);
  // The banner for a server that cannot be read rides with the main chrome, from its own module.
  assert.match(rendererPatch, /\$\{MAIN_CHROME_SOURCE\}\\n\$\{SERVER_READS_BANNER_HELPER\}\\n\$\{DELETE_MESSAGE_HELPER\}/);
  // The login page's provider chooser replaces the old skip button.
  assert.match(rendererPatch, /const LOGIN_PROVIDER_HELPER =/);
  assert.match(rendererPatch, /sand-lp-back/);
  assert.match(rendererPatch, /const MAY_SKIP_LOGIN_WALL =/);
  assert.equal((rendererPatch.match(/\$\{MAY_SKIP_LOGIN_WALL\}/g) || []).length, 4,
    "every login-wall bypass must go through the shared rule");
  // The miss that blacked out the app: a helper read the skip key directly, so
  // the gate showed the sign-in screen and our own code then hid it. Any read of
  // the key must also consult the mode, wherever it lives.
  for (const raw of rendererPatch.match(/localStorage\.getItem\("sand-cursor-login-skip"\)[^;]{0,80}/g) || []) {
    assert.match(raw, /sand-opengrok-mode/, `a raw skip-key read ignores OpenGrok mode: ${raw}`);
  }

  // OpenGrok server mode: the runtime is offered for every provider, the bearer
  // never reaches settings.json, and the Router tab stops offering a provider
  // the server has taken over.
  assert.match(rendererPatch, /\{value:"opengrok",label:"OpenGrok Server"\}/);
  assert.match(rendererPatch, /function ROpenGrokServer\(\)/);
  assert.match(rendererPatch, /function ROpenGrokActive\(\)/);
  assert.doesNotMatch(rendererPatch, /a\.jsx\(re,\{title:"Routing"/);
  // Every settings tab icon must name an entry in the renderer's own icon
  // registry. "desktop" looked plausible and drew nothing, because the registry
  // calls it "device-desktop"; asserting the literal alone could not tell the
  // difference, so check the name the tab actually asks for really exists.
  assert.match(rendererPatch, /label:"Computer",icon:"device-desktop"/);
  // The pinned renderer is recovered by `npm run bootstrap`, not committed, so
  // this icon-registry cross-check only runs where it is present.
  const pinnedRenderer = await readFile(
    path.join(repoRoot, "src", "app", "dist", "renderer", "assets", "index-UbX-y3il.js"),
    "utf8",
  ).catch(() => null);
  for (const [, icon] of (pinnedRenderer == null ? [] : rendererPatch.matchAll(/\{id:"[a-z]+",label:"[^"]+",icon:"([a-z0-9-]+)"\}/g))) {
    assert.ok(
      new RegExp(`[,{]"?${icon}"?:"`).test(pinnedRenderer),
      `settings tab icon "${icon}" is not a name in the renderer icon registry`,
    );
  }
  assert.match(rendererPatch, /sand-box-runtime-changed/);
  for (const code of ["no_org_key", "invalid_key", "quota_exceeded", "provider_unreachable", "provider_error", "not_supported", "unknown"]) {
    assert.match(rendererPatch, new RegExp(`${code}:\\[`), `the Computer panel has no copy for the "${code}" failure`);
  }
  assert.ok(!/setOpenGrokServer\([^)]*token[^)]*\)[^;]*settings\.json/.test(rendererPatch), "the bearer must not be described as living in settings");
  assert.match(rendererPatch, /sand-a11y-announcer/);
  assert.match(rendererPatch, /"aria-live","polite"/);
  assert.match(rendererPatch, /Assistant is replying/);
  // Turn boundaries only: announcing per token would be unusable noise, so the
  // finish is debounced behind a quiet period.
  assert.match(rendererPatch, /Reply finished\./);
  assert.match(rendererPatch, /QUIET_MS=1500/);
  // data-pending marks a user message awaiting acknowledgement, not a reply
  // being written - measured live, it toggles once and never during streaming.
  assert.doesNotMatch(rendererPatch, /attributeFilter:\["data-pending"\]/);
  // Scoped to the scroller and to text, so scrolling and the virtualizer
  // mounting rows never read out as a reply.
  assert.match(rendererPatch, /\.observe\(sc,\{subtree:true,childList:true,characterData:true\}\)/);
  // The local-tool consent prompt names the action it is asking about. One
  // hardcoded title covered every action, so a file read asked to "run
  // commands"; an unnamed action still falls back to that original title.
  assert.match(rendererPatch, /const LOCAL_TOOL_ASK_HELPER =/);
  assert.match(rendererPatch, /patchOriginalLocalToolAsk/);
  assert.match(rendererPatch, /__sandLocalToolAskTitle/);
  assert.match(rendererPatch, /"read-file":"read files on your local computer"/);
  assert.match(rendererPatch, /self\.__sandLocalToolAskTitle\(s\.action\)\|\|TLn/);
  // Multi-select mode: JS-store selection (virtualization-safe), overlay
  // chrome, native menu entry point, feature-detected Collections actions,
  // and the delete confirm that names the device-local scope.
  assert.match(rendererPatch, /const SELECT_MODE_HELPER =/);
  assert.match(rendererPatch, /__sandSelect/);
  assert.match(rendererPatch, /Select messages/);
  assert.match(rendererPatch, /deleteTranscriptEntries\(\{agentId:ag,entryIds:ids\}\)/);
  assert.match(rendererPatch, /from this device\?/);
  assert.doesNotMatch(rendererPatch, /coordinatorPort/);
  // Remote-box agents answer through Cursor's in-box gateway (not extensible),
  // so delete falls back to device-local tombstones filtered in the row
  // builder before grouping.
  assert.match(rendererPatch, /__sandTombstones/);
  assert.match(rendererPatch, /patchOriginalRowTombstones/);
  assert.match(rendererPatch, /sandTombstones\.v1/);
  // Deep links teleport via the engine's own find-in-chat navigate instead of
  // sweeping the virtualized transcript from the top; the hover inspector
  // replaced the always-on overlay's boot auto-restore.
  assert.match(rendererPatch, /__sandNavToRow/);
  assert.match(rendererPatch, /patchOriginalRowNavigate/);
  assert.match(rendererPatch, /INSPECT/);
  assert.doesNotMatch(rendererPatch, /localStorage\.getItem\(K\)==="1"&&setTimeout/);
  // Share picker (named collections instead of silently minted names) and the
  // Cmd+Shift+A selection entry point.
  assert.match(rendererPatch, /New collection\\\\u2026/);
  assert.match(rendererPatch, /ev\.key==="A"\|\|ev\.key==="a"/);
  // Width-keyed text-height cache (user-approved rule amendment): heights are
  // keyed by transcript width + root font size, replayed only on exact
  // condition match, and pending/streaming rows never record or replay.
  assert.match(rendererPatch, /sandTextHeights\.v2/);
  assert.match(rendererPatch, /__sandTextHeights/);
  assert.match(rendererPatch, /__sandTextHeights\.est\(n\.entry\)/);
  // Inspector: occlusion pause under viewers/dialogs/popovers, viewer stats
  // chip, and skeleton-phase capture with skeleton-vs-final comparison.
  assert.match(rendererPatch, /__sandSkel/);
  assert.match(rendererPatch, /skeleton match/);
  assert.match(rendererPatch, /sand-media-viewer/);
  assert.match(rendererPatch, /PAUSED/);
  // Layout lint: always-on idle watcher, persistent deduped findings,
  // aggregated report pullable any time.
  assert.match(rendererPatch, /sandLayoutFindings\.v1/);
  assert.match(rendererPatch, /__sandLayoutReport/);
  assert.match(rendererPatch, /skeleton-mismatch/);
  assert.match(rendererPatch, /requestIdleCallback/);
  // Lint is opt-in diagnostics: off by default, armed by first debugger use,
  // never re-armed over an explicit disable.
  assert.match(rendererPatch, /sandLayoutLint/);
  // Lint-driven layout fixes: gallery rows keep the app's planned height
  // (no forced 200 upscale), single boxes clamp instead of cropping, and
  // sharpness is judged against the device pixel ratio.
  assert.match(rendererPatch, /sand-fit-natural/);
  assert.match(rendererPatch, /under-dpr-source/);
  assert.match(rendererPatch, /under-dpr-fetch/);
  // Variant ladder: each image asks for the pixels its box needs at this
  // density instead of a flat 1120, and undersized sources draw at their own
  // size (scale-down) while gallery cells keep their cover-fill rule.
  assert.match(rendererPatch, /__sandVariantWidth/);
  assert.match(rendererPatch, /of!=="contain"&&of!=="scale-down"/);
  assert.match(rendererPatch, /getItem\("sandLayoutLint"\)==null&&localStorage\.setItem\("sandLayoutLint","1"\)/);
  // Jump-loading: transcript store exposed for in-place older-page streaming
  // (no synthetic snapshots - they desync the live replica), wider older
  // pages, deeper reveal chase, and the geometry-hit-test inspector.
  assert.match(rendererPatch, /__sandTranscript/);
  assert.match(rendererPatch, /patchOriginalJumpLoad/);
  assert.match(rendererPatch, /dVn=400/);
  assert.match(rendererPatch, /kOn=40/);
  // Zero-jump: exact estimator heights for cached media rows (estimate ==
  // measured for cached tiles; text rows stay live-measured) and the pill's
  // snap loop yields to the engine's bottom-pin instead of racing it.
  assert.match(rendererPatch, /__sandMediaEstimate/);
  assert.match(rendererPatch, /patchOriginalRowEstimator/);
  // Gallery rows keep a content-independent height so the estimate can never
  // disagree with the render (measured: content-planned heights cost 144
  // scroll shoves per pass versus 4); blur is solved by letterboxing instead.
  assert.match(rendererPatch, /case"attachment-group":return\[The\(200,!1,e\)\]/);
  assert.match(rendererPatch, /if\(el\.scrollHeight-el\.clientHeight-el\.scrollTop<2\)return;/);
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
  assert.doesNotMatch(rendererPatch, /ANTHROPIC_API_KEY|OPENAI_API_KEY/);
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

// Each provider's login page is its own page: its own accent, its own opening
// line, and a sentence saying what pressing Sign in will actually do. Upstream
// ships one line about Grok Bot, which is simply wrong over somebody else's
// sign-in, and says nothing about a terminal being about to open.
test("every provider's login page has its own colour and its own words", async () => {
  const rendererPatch = await readFile(path.join(repoRoot, "scripts", "lib", "router-renderer-patch.mjs"), "utf8");

  const providers = [...rendererPatch.matchAll(/\{id:"([a-z-]+)",label:"[^"]+",title:"([^"]+)",lede:"([^"]+)",how:"([^"]+)",[^}]*?accent:"(#[0-9a-f]{6})"/g)]
    .map(([, id, title, lede, how, accent]) => ({ id, title, lede, how, accent }));
  assert.equal(providers.length, 4, "all four providers must carry their own page content");
  assert.deepEqual(providers.map((p) => p.id).sort(), ["claude-code", "codex", "cursor", "opengrok"]);

  // No two providers may share a colour, or the page is not theirs.
  assert.equal(new Set(providers.map((p) => p.accent)).size, 4, "each provider needs its own accent");
  assert.equal(new Set(providers.map((p) => p.lede)).size, 4, "each provider needs its own opening line");

  for (const provider of providers) {
    // The CLI providers open a terminal; saying so is the whole point.
    if (provider.id === "codex" || provider.id === "claude-code") {
      assert.match(provider.how, /terminal/i, `${provider.id} must say a terminal opens`);
    } else {
      assert.match(provider.how, /browser/i, `${provider.id} must say the browser opens`);
    }
    assert.doesNotMatch(provider.lede, /Grok Bot/, `${provider.id} must not be sold as Grok Bot`);
  }

  // And the page must actually use them, not merely carry them.
  assert.match(rendererPatch, /root\.style\.setProperty\("--lp-accent",p\.accent\)/);
  assert.match(rendererPatch, /lede\.textContent=p\.lede/);
  assert.match(rendererPatch, /how\.textContent=p\.how/);
  // The CLI state is shown so pressing Sign in is not a guess.
  assert.match(rendererPatch, /Already signed in on this Mac/);
  assert.match(rendererPatch, /Not installed yet/);
});
