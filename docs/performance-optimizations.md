# Chat performance optimizations — the complete record (2026-08-28)

Every optimization applied to the reconstructed app's chat experience, in the
order the investigation found them, with how each was diagnosed and verified.
All measurements were taken live via CDP against the packaged production app,
usually side-by-side with official Grok Bot 0.29 on the same conversations.

## 1. GPU acceleration (the big one)

**Found**: `SystemInfo.getInfo` showed every pipeline stage in
`disabled_software` — the inherited 0.18 main calls
`app.disableHardwareAcceleration()` unconditionally, so the entire app was
CPU-rendered. Official 0.29 added a startup policy
(`storedPreference ?? platform === "darwin"`) that enables the GPU on Macs —
a large share of its perceived smoothness.

**Fix**: mirror the 0.29 policy (`source/electron-main/main.ts`), resolved
from the settings store before app ready (Chromium fixes its GPU decision at
startup — toggling always requires a full restart). Persisted preference in
Settings → Router → Performance; `SAND_DISABLE_GPU=1` forces off.

**Verified**: `gpu_compositing: enabled` through ANGLE Metal on Apple
Silicon; real-wheel p95 frame time 17ms → 9ms.

## 2. Real-input scrolling stalls (non-passive wheel)

**Found**: programmatic scrolling measured perfectly smooth while real
trackpad scrolling stop-and-goed — the discrepancy exposed a **non-passive
wheel listener** (the horizontal timestamp-peek gesture) on the transcript
container: every vertical wheel tick waited for main-thread JS before the
page could move.

**Fix**: the peek listener is passive (it works without preventDefault).
Renderer patch `patchOriginalScrollInput`.

## 3. Layout thrash from the Show-more clamp (self-inflicted)

**Found**: CPU profile attributed ~1.4s of a 5s scroll to one function — the
clamp's ResizeObserver reading `scrollHeight` (a forced synchronous layout)
per assistant bubble per resize. Our extension of the official 664px user-
bubble clamp to all assistant bubbles created an observer swarm.

**Fix**: width-gated observer (scroll never changes width) with rAF-batched
re-measures, plus a **CSS-first pre-clamp** — the clamp root carries
`data-sand-clamp`, injected CSS caps it at 664px from first paint, and a
`:has(button[aria-expanded])` rule lifts the cap on expand. JS only decides
whether the Show more button renders. Bubbles are born at final height.

**Verified**: the function vanished from the profile; the same exercise ran
in 1.8s instead of 4.5s.

## 4. Stable row heights (the virtualizer's food)

The transcript virtualizer estimates unmounted rows from per-kind constants;
any mounted height that differs forces an anchor correction — the "scroll
jumps up/down" feel. Official 0.29 has the identical behavior (measured: 18
anchor jumps on the same synthetic fast-scroll vs our 16 pre-fix). Every
change below shrinks estimate error:

- **Assistant bubbles clamp at 664px** like user bubbles (streaming messages
  stay unclamped; the clamp engages when they settle).
- **Every image renders at a locked 200px height.** Known-dimension images
  keep their natural aspect uncropped (landscape up to 560px wide);
  dimension-less rows fall back to a 200px cover-cropped square. Both are
  height-invariant, so image rows can never change row height.
- **Dimensions persist on the rows**: sniffed from real bytes at send
  (`readImageFileDimensions`), and **lazily backfilled** for legacy rows on
  first transcript load — measured once, stored forever, evicted only when
  the agent is deleted. Succeeding loads reserve exact boxes with zero
  measurement. This works even with the GPU off.
- **Renderer-side media store (box agents, videos, everything)**: the
  coordinator backfill only reaches the local routed store, so box-agent
  transcripts (served over the Cursor RPC) would square-fallback forever. A
  capture-phase `load`/`loadedmetadata` listener records every transcript
  image's and video's natural size the first time it loads — plus a ~24px
  **blur-up thumbnail** — into localStorage keyed by the content-hashed file
  path (immutable content, so entries never go stale; size-capped ~3.5MB).
  The attachment frame reads the store **first** — ahead of row dims and
  the resolver's dims — because the store records what the browser
  actually rendered (orientation-corrected), while sniffed metadata can
  disagree (EXIF-transposed photos). With store-first precedence the
  placeholder and the resolved image build the identical box by
  construction: once cached, the frame can never change size at resolve
  time. The blurred preview paints in place of the grey skeleton shimmer
  for images and videos (other attachment widgets keep their loaders),
  and the JPEG sniffer itself now honors EXIF orientations 5–8 (swapped
  width/height) so even first-mount row dims match the rendered image.
  Canvas capture across the custom scheme required CORS-mode requests
  (`crossOrigin="anonymous"` on transcript img/video, sand-media sources
  only — the gallery thumb variant included, or tainted canvases leave
  tile-first images permanently blur-less), an
  `access-control-allow-origin` header on sand-media responses, **and
  `corsEnabled: true` in the scheme privileges** — without that last one
  Electron blocks CORS-mode requests to the scheme outright and every
  image breaks. Wrong entries are repairable from the UI: right-click an
  agent in the sidebar → **Clear media cache** (a native item in the
  official context menu) drops that agent's store entries and busts its
  coordinator row dims via the `clearAgentMediaCache` edge.
- **No `<video>` elements in the chat area**: every mounted video keeps a
  live decoder/demuxer, so a video-heavy transcript would hold dozens in
  memory. The first-ever sight of a video mounts one muted element once,
  nudges a tiny seek so a frame loads under `preload="metadata"`, and
  captures a real 320px poster into the store; every later mount renders a
  static poster image plus the play badge, and actual `<video>` elements
  exist only inside the viewer after a click. Full-resolution media in
  general lives only in the viewer — the transcript never decodes it.

## 5. Image pipeline (bytes, decode, textures)

- **Streaming instead of base64**: `resolveMedia` returns a
  `sand-media://` URL (the scheme videos already used, including the gateway
  remote reader for box-resident files) instead of materializing multi-MB
  base64 data URLs over IPC. Image responses are `immutable` (content-hash
  filenames). Required adding `sand-media:` to the renderer CSP's `img-src`.
- **Async decode**: transcript `<img>` tags carry `decoding="async"` so
  full-image decode never blocks the frame.
- **Downscaled tile variants, persisted to disk**: the media protocol
  answers `?w=<px>` with a native-image resize cached in a 48MB true-LRU
  (hits refresh recency) **and written to `sand-data/media-variants/`** —
  each image is decoded and resized once ever; every later load, including
  after an app restart, streams the small file instead of re-computing
  (content-addressed names never go stale; a 256MB mtime sweep bounds the
  directory). Resizes run in the main process behind a 2-slot gate so a
  fast scroll can't fan out into CPU-saturating parallel decodes. Formats
  are alpha-smart: PNG only when a sampled scan finds real transparency
  (so it never flattens to black), otherwise JPEG q82 even for PNG/WebP
  sources — most screenshots are opaque and the JPEG variant is 5–10x
  smaller and faster to decode. GIFs are excluded so animation survives.
  Tiles request
  Retina-aware variants — the main transcript image asks for 1120px on 2x
  displays / 560px on 1x (its cell caps at 560 CSS px), gallery thumbs ask
  for 560px / 440px (cells cap at 280 CSS px) — while the media viewer keeps
  full resolution. Sized to exactly 2x the largest possible cell, nothing is
  ever upscaled (no softness) and full-resolution textures never reach the
  compositor. This removed three deterministic 100–200ms texture-upload
  stalls per scroll-through.
- **Upload-time shrinking**: the composer re-encodes large images (>1MB,
  >2048px long edge) to 2048px WebP before staging — lossless for PNG
  screenshots (vision models ingest at or below this resolution, so nothing
  legible is lost), q0.85 for photos, original kept when transcoding would
  not shrink. A main-process backstop applies the same cap for non-composer
  callers. Everything downstream (storage, box upload, vision payloads,
  tiles) gets smaller for free.
- **In-memory byte cache** (64MB LRU) for the routed vision reader, so
  history images are fetched through the gateway once, not on every send.

## 6. Mounted-context window

Transcript overscan raised from 6 to 24 rows (a few tens of MB of DOM and
decoded tiles) so scrolling several screens and back does not unmount and
skeleton-reload images. Grey boxes now only appear on genuinely long jumps.

## 7. Streaming and turn latency (routed providers)

- Token deltas coalesce to one transcript event per 80ms (was one per
  token — hundreds of renderer updates per reply).
- The artificial pre-stream composing delay dropped from 1.2s to 400ms.

## 8. Screen-share cost

The "screen" thumbnail embeds a live noVNC session; with no encoding hints
it decoded near-full-quality frames continuously. The VNC URL now requests
`quality=2&compression=9` for the passive preview and `quality=6` when
interactive.

## Where we ended up (real-wheel harness, image-heavy chat)

| metric | before campaign | after | official 0.29 |
|---|---|---|---|
| frames >50ms | 18 | **0** | 1 |
| frames >100ms | 5 | **0** | 0 |
| worst frame | 134ms | **34ms** | 76ms |
| p50 | 8ms (120Hz) | 8ms (120Hz) | 8ms |

Cleaner than official on the same conversation — while rendering box
attachments the official app shows as broken.

## Design rule: only images get persisted size metadata

Text rows (and any text-dominant row) are **deliberately excluded** from the
size cache. Text height is a function of viewport width — the same message
reflows taller on a narrower window or mobile-sized layout, so a persisted
height would be wrong the moment the window changes. Images are the opposite:
their intrinsic dimensions never change, which is what makes persisting them
safe. The backfill/measure pipeline enforces this by filtering to rows whose
`file_path` has an image MIME; text rows stay live-measured by the
virtualizer, with the 664px clamp bounding the estimate error.

## The locked ruleset (finalized 2026-08-28)

The rules every future change must preserve. Together they make transcript
jank structurally impossible rather than merely tuned away:

1. **Row heights are invariant.** Transcript images always render at 200px
   height; message bubbles clamp at 664px from first paint (CSS pre-clamp)
   and unclamp only on explicit expand. A mounted row must never change
   height on its own.
2. **Unknown image size → 200×200 cover-cropped square** — skeleton and
   image alike. **Known size → exact-size frame, then natural aspect
   uncropped** (landscape capped at 560px wide). The crop exists only while
   dimensions are unknown — and "known" now includes the renderer-side
   store, so any image or video seen once loads exact-size forever, box
   agents included. When a blur-up thumbnail is cached, it replaces the
   grey skeleton for images and videos.
3. **Galleries use uniform equal-width cells** (≤280px, cover-fill, 6px
   gaps): cell geometry depends only on the image *count*, never on aspect
   ratios, so layout can never break sizing. Single images keep true aspect.
   Cells stay a content-independent 200px tall on purpose — a height planned
   from the pictures cannot be known before they arrive, and measuring that
   variant cost 144 scroll shoves per pass against 4. Sharpness is protected
   without touching geometry instead: a tile whose source cannot fill the
   cell (or whose shape would be cover-cropped away) gets
   `object-fit:scale-down` via the `sand-fit-natural` class, so it draws at
   its own size rather than being stretched. Everything else keeps the app's
   own fit: cells cover-fill (the locked rule) and single frames already
   letterbox themselves. Measured by the layout lint across a full thread:
   19 upscaled tiles → 2, and 138 of 154 tiles cover-fill as specified.
4. **Size metadata is persisted for images unconditionally — for text only
   width-keyed.** Text height depends on viewport width (narrow windows
   reflow it taller), so a height is never reused under different
   conditions. Image intrinsic dimensions never change: sniffed at send,
   backfilled once on first transcript load, **evicted only when the agent
   is deleted**, repairable via `clearAgentImageMetadata`; every store
   mutation rides the per-agent queue so backfills can never race a message
   append. Text row heights (2026-08-29 amendment, user-approved) persist in
   `sandTextHeights.v1` keyed by agent + row key + transcript width + root
   font size; the estimator (`iAn`) replays them only on an exact condition
   match, pending/streaming rows never record or replay, and the engine
   still measures every mounted row — a stale entry degrades to the old
   settle, never a wrong layout. Measured effect: a fresh-launch first
   scroll-through of an image-heavy chat went from ~190 shove events to
   zero.
5. **Bytes stay small end to end**: ≤2048px WebP at upload, `sand-media://`
   streaming with immutable caching, Retina-exact `?w=` variants sized per
   element — each image asks for `boxWidth × devicePixelRatio` rounded up to a
   fixed ladder (128…2048) using the box width remembered in the media store,
   falling back to the old flat constant on an image's first sighting. A
   186px tile now fetches 384 instead of 1120, roughly a ninth of the decoded
   pixels, with sharpness unchanged (never
   upscaled, never full-res in the feed) resized once ever and persisted to
   disk, alpha-smart formats, async decode, passive listeners.
6. **Full resolution only in the viewer.** The transcript renders variants
   and posters exclusively; clicking opens the viewer, which is the only
   place full-res images decode and the only place `<video>` elements exist —
   the chat area shows a captured static poster, never a mounted video.
7. **RAM is spent deliberately** for smoothness: 64MB routed-reader LRU,
   48MB resize LRU, 24-row overscan.
8. **GPU compositing on by default on macOS**, persisted preference,
   restart-to-apply, `SAND_DISABLE_GPU=1` escape hatch.

## Deliberately not done (see also chat-performance-0.29-notes.md)

- ~~**Measured-height cache** for text rows in the virtualizer~~ — done
  2026-08-29 as the width-keyed variant described in rule 4; the original
  objection (stale heights across width changes) is answered by exact
  condition keying.
- **Jump-to-newest pill** and **first-layout gate** ports from 0.29.
- Code splitting and Electron/Chromium upgrades (impossible on the pinned
  0.18 runtime).
- Velocity-aware media loading (mega-fling optimization; one-time skeletons
  on long jumps are acceptable).
