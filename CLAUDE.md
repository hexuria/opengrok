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

## Locked UI rules

See `docs/performance-optimizations.md` (the locked ruleset) and
`docs/gap-analysis-0.29.md` before changing transcript, media, or avatar
behavior.
