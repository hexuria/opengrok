# opengrok (OpenGrok) — agent rules

The product brand is **OpenGrok**; the bundle is `Open Grok.app`. The inner
executable stays `Grok Bot` (Electron helper-name constraint) and the
user-data dir is `~/Library/Application Support/OpenGrok` (migrated
automatically from the pre-rebrand `Grok-0.27` / `OpenGrok-0.27` on first launch).

## The repository is public, and what that cost

`hexuria/opengrok` is **public** (made so 2 Sep 2026, after eight days private).
Before it was flipped, its whole history was rewritten to remove the material
recovered from a shipped binary: 576 files, most of all
`source/packages/proto/generated/` (161 files of Anysphere's own protobuf
message definitions) and `frontend/` (the reconstruction), plus `manifests/`,
`patches/`, `research-archives/`, `PROVENANCE.md` and the 0.27/0.29/0.30
disparity and gap docs. A fresh clone of the remote reports zero files ever at
every one of those paths, and no secret anywhere in the history. `NOTICE.md`
stays here; `PROVENANCE.md` lives in the archive now, not in this repository.

**None of that material is tracked here, and none of it may be committed back.**
`.gitignore` excludes every one of those paths. What sits in your working tree
is restored, not tracked, which is why a build works locally and a bare clone
cannot typecheck, test or package: 369 source files import the generated trees
(counted 2 Sep 2026).

**Restoring it into a fresh checkout:**

```sh
git clone git@github.com:hexuria/opengrok-stow.git /tmp/stow   # private archive
scripts/ci-restore-recovered.sh /tmp/stow
```

CI does exactly this, with a read-only deploy key in `STOW_DEPLOY_KEY` — which
must exist in **both** the Actions and the Dependabot secret stores, because
GitHub withholds Actions secrets from Dependabot-triggered runs and every
Dependabot pull request otherwise fails at that step.

A second copy lives in the `.stow` archive, pushed to the private
`hexuria/grok-bot-release-archive`, managed with the `stow` CLI (`stow add`,
`stow status`, `stow push`); `.stow/` is gitignored here. `opengrok-stow` is
what the build pulls from; `grok-bot-release-archive` is the backup behind it.

**The reconstruction itself is public now** — the renderer patch scripts, the
ported code under `source/packages`, and the documentation describing how the
app was rebuilt. The vendor bytes are gone; the technique is not. Weigh that
before adding a document that walks through recovering someone else's binary.

## Resuming work: read `.handoff/STATE.md` first

If you are picking up work rather than starting something new, read `.handoff/STATE.md` before
anything else. It is gitignored and disposable — the queue, what is half-done, decisions that live
in nobody's code, and what is pending between the three repos. The other two repos each carry the
same file at the same path.

It deliberately does NOT restate git history or file lists; those are already true, and a handoff
that duplicates them goes stale and lies. Verify anything it claims about a *running* process
before acting on it.

## The stack: gateway, server, desktop

The desktop is one of three repositories and cannot do real inference alone:
`open-ai-gateway` (:29080, holds provider credentials and the catalogue) ->
`opengrok-server` (:1447, holds coworkers and pins) -> this app, which talks
only to the server and never to the gateway.

**`RUNBOOK.md` in this repository is the end-to-end setup**, and specifically
the seams between the three — the failures that belong to no single repo. Read
it before debugging anything that looks like "the model will not answer". Four
separate faults produced near-identical symptoms on 2026-09-08 and they are all
written down there, including the one where the error names the wrong provider
entirely.

The two that catch people most often:

- `OG_MODEL_DOOR=rig` on the server silently drops the model, so the gateway
  classifies by prompt and the coworker's pin is ignored. Turns still succeed,
  which is what makes it hard to see. Use `gateway`.
- Gateway seats imported without `--shared` are invisible to the per-coworker
  keys the server mints, so a turn authenticates and then finds no credential
  of any kind.

## V1 and V2 side by side

Two apps, two worktrees, two branches. Nothing in the running apps is shared.

| | V1 (shipping) | V2 (migration, this branch) |
|---|---|---|
| Worktree / branch | `/Volumes/goldcoders/OSS/.wt/v1` on `v1` (cut from `main`) | `/Volumes/goldcoders/OSS/.wt/v2` on `v2` |
| Bundle | `/Applications/Open Grok.app`, `bot.opengrok.app` | `/Applications/Open Grok V2.app`, `bot.opengrok.app.v2` |
| Renderer | fidelity build (patched 0.18 artifact) | Vite frontend from stow |
| URL schemes | `sand://` (Cursor sign-in) + `opengrok://` | `opengrokv2://` only; never claims `sand://` |
| User data | `~/Library/Application Support/OpenGrok` | `~/Library/Application Support/OpenGrok V2` |
| Data root | `~/.grokbot` | `~/.grokbot-v2` |
| CDP port (by convention) | 9223 | 9225 (official Grok Bot stays 9224) |

The variant is decided by `app-variant.json` at the repo root (`{"variant":"v2"}`
here; absent on `main`/`v1`) or `OPENGROK_APP_VARIANT`, and at runtime by the
bundle name in the executable path (`scripts/lib/config.mjs`,
`source/electron-main/startup/desktop-user-data-bootstrap.ts`). Inner
executable and `CFBundleName` stay `Grok Bot` in both. Deep links minted by
V2 still use `opengrok://` and therefore open V1; change the minting scheme
only when V2 becomes the product.

Build V2 from `.wt/v2` with the normal package loop; install to
`/Applications/Open Grok V2.app` (rsync in place). Build V1 from `.wt/v1`
(`main`'s fidelity packager): it needs `src/app`, `.cache/runtime`,
`node_modules`, `frontend/manifests/` and `manifests/` copied in, never
symlinked. macOS treats V2 as a new app: grant Full Disk Access (and any other
permission) again for `Open Grok V2.app`; the FDA check relaunches the app
without its argv, so add `--remote-debugging-port` again after that first run.
Secrets and sign-ins are per profile: V2 starts signed out.

**Sign-in is the OpenGrok server only, and the server URL is configuration.**
Set `OPENGROK_SERVER_URL` (environment, or a repo-root `.env` line) when
packaging; the packager bakes it into the app's `package.json` and the main
process copies it into the environment at startup. A dev launch can export
`OPENGROK_SERVER_URL` to point at another server. The sign-in page has no URL
field and shows an unconfigured notice when neither is set.

Still shared, by design or not yet split: the Local VM Docker container
`grok-bot-local-vm` and its published ports (1337, 1339, 1340, 6080, 6081,
8790) plus the desktop host port 1350, so run Local VM in only one of the two
at a time; `~/.cursor` and `~/.codex`/`~/.claude` mounts; the stow frontend
repository (V1 does not consume it beyond `frontend/manifests`).

## Driving and verifying the app: use CDP, not computer-use or browser-use

This is an Electron app. To interact with it, inspect its DOM, or verify UI
changes, use **Chrome DevTools Protocol (CDP)** — never screen/computer
control and never the Chrome browser-extension tools (those drive Chrome, not
this app).

Launch with the debug port (kill existing instances first — `open -a` on a
running instance silently ignores `--args`):

```sh
pkill -9 -f "Open Grok.app/Contents"; sleep 2
"/Applications/Open Grok.app/Contents/MacOS/Grok Bot" --remote-debugging-port=9223 > /tmp/grok.log 2>&1 &
```

- The main process name is `Grok Bot` (match processes by bundle path
  `Open Grok.app/Contents`, not by app name).
- Evaluate in the renderer by connecting a WebSocket to the page target from
  `http://localhost:9223/json/list` and calling `Runtime.evaluate`
  (`returnByValue: true, awaitPromise: true`). Use the hostname `localhost`,
  not `127.0.0.1`.
- Type into the composer with `document.execCommand("insertText", ...)` on the
  focused `.ProseMirror` element (it is TipTap — setting `.value` does not
  exist and synthetic keystrokes need macOS accessibility permission).
- Send by dispatching an Enter `KeyboardEvent` on the composer.
- Navigate chats by clicking `.sand-agent-item[data-agent-id]` sidebar rows.
- The transcript scroller is `.sand-virtual-transcript`; it is virtualized —
  off-screen rows are unmounted, so scroll to mount them before querying.
- For screenshots of the app, `screencapture -R<x,y,w,h>` on the window
  bounds; only fight window focus if the user is not actively using the Mac.

**Hand the driving to a Sonnet subagent.** Typing a fixture, reading the DOM
back and reporting what it says is mechanical work whose intermediate output —
DOM dumps, screenshots, retries — is worth nothing once the answer is known.
Spawn it with the Agent tool at `model: "sonnet"`, brief it with the exact
selectors and the exact questions, and keep only its findings. The judgement
that follows (what the result means, what to change) stays in the main session.

## Media debug overlay

The production build ships a runtime media debugger (no debug build needed):
press **Cmd+Shift+D** in the app, or set `localStorage.sandMediaDebug="1"`,
or call `__sandMediaDebug.enable()` from CDP. A DevTools-style overlay marks
every transcript media frame: **green outline** = rendered at natural aspect
and scale, **red outline** = cropped or upscaled (judged only once cached),
dashed grey = not yet cached. Corner dot: grey = no cache entry, blue = dims
cached, dark blue = dims + blur thumb; a spinner shows while loading. A tag
shows `natural > rendered` sizes. Toggle off the same way; it is fully inert
when disabled.

Independent of the overlay, a **layout lint** watcher judges cached media
frames on idle ticks and records real violations (single-image
aspect/upscale breaks, gallery-tile upscales, skeleton-vs-final mismatches —
never by-design cover crops) deduped into `localStorage`
`sandLayoutFindings.v1`. It is **opt-in diagnostics**: off by default in the
shipped build; the first ⌘⇧D toggle arms it (`sandLayoutLint="1"`), it stays
armed across relaunches, and `__sandLayoutReport.enable()/.disable()/
.active()` control it directly (an explicit disable is never re-armed by
⌘⇧D). Skeleton capture is gated behind the same flag; the feature stores
(image dims, text heights) are NOT gated — the renderer and estimator
consume them. Pull the aggregated report any time from CDP with
`__sandLayoutReport()` (`.clear()` resets); findings survive relaunches, so
"end of session" needs no quit hook — the report is simply always current.
Use it to decide which loading rule to tune (y7n box math, tile cells, dims
store/estimator) instead of hover-hunting reds.

## URL schemes: why both sand:// and opengrok:// exist

Never remove or rename `sand://` — it is the scheme Cursor's official auth
callback redirects to; changing it silently breaks Cursor sign-in.
`opengrok://` is the brand scheme for links we mint (shareable message URLs:
`opengrok://app/v1/message?agent=<id>&id=<id>`). The parser in
`source/shared/deep-link.ts` accepts both.

## Build & verify loop

`npm run package` (runs typecheck + full test suite, then packages
`dist/Open Grok.app`) → install **in place**, never deleting the installed
bundle first:

```sh
rsync -a --delete "dist/Open Grok.app/" "/Applications/Open Grok.app/"
```

Deleting `/Applications/Open Grok.app` and re-copying makes macOS prune the
app's Full Disk Access entry, so the granted permission silently disappears
and Messages reads start failing again. Replacing the contents in place keeps
the grant, which the Developer ID signature already makes stable across builds.
→ relaunch with the CDP flag → verify live → clean relaunch. Renderer changes
are exact-string patches in `scripts/lib/router-renderer-patch.mjs` applied to
the pinned minified bundle at package time; pre-flight every new anchor string
against `src/app/dist/renderer/assets/index-UbX-y3il.js` (must match exactly
once).

`src/app/` is the recovered 0.18 upstream app and is **read-only material**.
The build stages a copy and patches the copy; nothing may write back into it.
Never symlink it into another working tree either — on 2 Sep 2026 a package run
in a worktree wrote its seams through such a symlink into the shared original,
and since git does not track those files, nothing could restore them from
history. They came back only because the checksum-verified asar was still in
`.cache/runtime/`. If you package from a worktree, copy `src/app` and
`.cache/runtime` into it, or package from the main checkout.

## Dead spots: `-webkit-app-region: drag` outranks z-index

**Symptom.** An area of the window takes no hover and no click, dragging there
moves the whole window instead, and nothing in the DOM explains it. The dead
area has a hard edge that lines up with some other element's box. Raising
z-index does nothing.

**Cause.** Electron resolves `-webkit-app-region: drag` in the OS, *before the
page sees the mouse*. It is a native hit target: it ignores z-index, ignores
paint order, and ignores webviews. The only holes in a drag region are elements
that themselves declare `app-region: no-drag`, and that declaration is read off
the element's own computed style — a parent's `no-drag` does not cover a child
painted over the region from elsewhere in the DOM.

**Why it keeps biting this app.** Two full-height drag strips exist by design:
`.sand-workspace-rail` (production.css) and `.sand-chat-header` (workspace
view.css). Each exempts its own interactive descendants (`button`, `a`, `input`,
`[role="button"]`). Anything portalled to `<body>` — every menu, popover,
tooltip, select, dialog, hover card and banner — is NOT a descendant, so it
lands on bare drag region wherever it overlaps one.

Three instances so far, all the same bug:
- the 16:9 computer stage over the rail (you saw VNC, clicks dragged the window);
- modals over the rail;
- the roster's context menu, dead below the last row because the roster rows are
  buttons that had already punched holes for the part above (2026-09-07).

**The invariant, as of 2026-09-07.** *Nothing below the title bar is a drag
region.* There is exactly ONE drag strip: `.sand-cover-drag`, fixed across the
top 52px (`window-chrome/view.css`). The rail and the chat header used to be
drag regions too — the rail over its full height — and that is what produced all
three dead-spot bugs. They are not any more; the rail reserves the same 52px as
padding, so dragging the window by the top of the sidebar still works. What no
longer works is dragging the window by empty roster space, which is the trade.

**Check it with a tool, because you cannot check it by clicking.**

```sh
CDP_PORT=9225 node docs/research/tools/cdp-drag-regions.mjs   # exit 1 = dead-spot risk
```

It walks computed styles and prints the geometry Electron will actually use.
Close any open menu first: a click-away overlay makes the strips no-drag by
design, so a broken build reads as clean (the tool says so when it sees one).

**The rule for new overlays.** If you must add a drag region below the title bar,
anything that floats over the window has to punch its own hole:

```css
.my-overlay, .my-overlay * { -webkit-app-region: no-drag; app-region: no-drag; }
```

Floating surfaces get it for free — `sand-floating-primitives.css` declares it
on `[data-sand-floating-surface="true"]`. Surfaces that are not floating
primitives are listed beside the fullscreen-stage rule in `production.css`. Add
yours there. Leave genuinely empty chrome draggable; that is what the strips are
for.

## Drag and drop: synthetic DragEvents prove nothing

A dispatched `new DragEvent("dragstart")` runs your handlers whether or not a
real drag could survive, so it will report a feature working that a mouse cannot
use. Two things it hides:

- **A DOM change inside `dragstart` aborts the drag.** Chromium cancels the drag
  it was about to start; `dragstart` and `dragend` both fire in the same tick.
  Any state update that renders a drop target must be deferred — a `setTimeout`
  of zero is enough (roster pin zone, 2026-09-08).
- **`setDragImage` needs its element attached** and rasterised during the
  handler, and removed a frame later, not synchronously.

To drive a REAL drag over CDP: `Input.setInterceptDrags({enabled:true})`, then
`Input.dispatchMouseEvent` mousePressed plus several mouseMoved steps. Chromium
emits `Input.dragIntercepted` only if a drag genuinely began — that event is the
proof. Continue with `Input.dispatchDragEvent` (`dragEnter`, `dragOver`, `drop`,
passing back the intercepted `data`) to finish the gesture. Watch `dragend`
firing immediately after `dragstart`: that is the abort signature.

**Do not try to reproduce it with CDP.** `elementFromPoint`, `elementsFromPoint`
and `Input.dispatchMouseEvent` all run inside the renderer and report the DOM's
answer, which is that the overlay is perfectly clickable. They cannot see a drag
region, so they will tell you the bug does not exist while the operator is
looking straight at it. What CDP *can* check is the computed property: read
`getComputedStyle(el).getPropertyValue("-webkit-app-region")` on the overlay, its
rows and its icons, and on the strip underneath. `drag` under an overlay whose
own value is not `no-drag` is the bug. Confirming the feel needs a real mouse.

## Locked UI rules

See `docs/performance-optimizations.md` (the locked ruleset) and
`docs/gap-analysis-0.29.md` before changing transcript, media, or avatar
behavior.
