# Per-bot desktops — a screen each, on one computer

Two bots share a computer and share a screen. Chrome opened by one is sitting
there when the other looks, and if both work at once they fight over the same
mouse, keyboard, focus and window stack. Original Grok Bot does not have this
problem, and the way it avoids it is already modelled in this repository.

**This is mostly server work.** The client half is largely built.

---

## How the original does it

One box. One user (`box`). One filesystem. **Several X displays**, one per bot.

| Piece | Where |
|---|---|
| `DEFAULT_SHARED_BOX_ID = "shared"` | `source/host/box/shared-desktop-sand-box.ts` |
| `/home/box/.sand-window-assignments.json` — agent → window index, plus owner tokens | same file, `parseAssignments()` |
| noVNC **6080** for window 0, **6081** for every fork, routed by a per-display token | `source/packages/constants/sand-box.ts` |
| `ensureWindow(agentId, windowIndex, {ownerToken})` / `releaseWindow` | `SharedInnerBox`, `loopback-sand-box.ts` |
| `boxMaxWindows` caps how many | `box-capabilities.ts` |

So `whoami` is the same on every bot and the files are shared, while the screens
are separate. Both of the user's observations were true at once.

**The multi-display machinery lives in the box image, not in a provider API.**
The original runs several X servers and a fork router *inside* the box. That
matters for the decision below: it is not primarily a question of what
box.ascii.dev exposes, but of what the box is running.

## What this repository already has

- `parseAssignments()` — reads the assignments file, validates indices, rejects
  duplicate forks, carries owner tokens.
- `SharedDesktopSandBox` — assignment lifecycle over a `SharedInnerBox`, with
  `maxWindowCount` and optional persistence.
- `BoxStatus.windows?: Array<{ windowIndex, vncUrl }>` — already on the wire.
- `proxifyBoxVncUrl` — already distinguishes the primary port from the fork port
  and rewrites fork URLs by display token.
- The renderer already reads `windows ?? []` into its monitor strip.

**So the client can already display a per-agent screen.** What it has never
received is a server that provides one.

---

## The decision that came first — ANSWERED 31 Aug 2026

**One box hosts several displays. Box-per-agent is ruled out.** The server
session settled it with a real probe (a paid box created, inspected,
destroyed), not an inference from the API surface:

- A second server on port 6081 coexists with the managed noVNC on 6080 —
  both listening at once, confirmed with `ss`.
- `expose_port(6081)` returns a real external URL
  (`https://box-node-…-6081.on.ascii.dev?_token=…`), so `/host` maps an
  arbitrary port, not just the managed desktop.
- `/commands` and the desktop session both run as `user` on `/home/user` —
  same `whoami`, same files. The product promise (separate screens, shared
  computer) holds with no extra work.

So one-account-one-computer survives and the ascii.dev bill does not multiply.
A fork display is **build work in the box image**, not a new box:
`apt-get install -y xvfb x11vnc` → `Xvfb :1` → `x11vnc -display :1 -rfbport
5901` → `websockify --web=/usr/share/novnc 6081 localhost:5901` →
`expose_port(6081)`.

**Known work items from the probe**, so they are not rediscovered later:

- The image ships no X/VNC tooling by default; ascii's managed desktop
  installs x11vnc/novnc/websockify on first `POST /desktop` and runs the
  primary as real Xorg `:0`. Forks must `apt-get install xvfb` first —
  a provisioning step, not a blocker.
- Server-side bug found in passing: `AsciiBoxes::start` (detached exec)
  mis-parses the reply — the API returns a numeric pid where a string is
  expected. `run` is fine; fix `start` before leaning on detached starts.
- ascii's proxy wants its `_token` handling matched the way the managed
  6080 URL already does it; a bare service on the exposed port answers 403.

---

## The work, once that is answered

### Server — assign and report a display per agent

1. Run more than one X display in the box, with something routing a display
   token to the right one. The original's shape — 6080 primary, 6081 forks,
   token-routed — is worth copying because the client already speaks it.
2. Assign agents to displays and persist it. `/home/box/.sand-window-assignments.json`
   is the original's location and `parseAssignments()` already reads that format:
   `{ assignments: { "<agentId>": <index> }, tokens: { "<agentId>": "<token>" } }`,
   indices from 1, forks unique.
3. Report it: `getForeverBoxStatus` returns the **calling agent's own** screen as
   `vncUrl`, and may list others in `windows[]`. Today it returns the box's one
   desktop to everybody.
4. Release a display when a bot is deleted, so displays are not leaked.

### Client — small, and only after the server reports something

1. Render the calling agent's own screen. Likely nothing to change: the status
   already flows into the viewer.
2. Handle `windows[]` in the monitor strip when more than one is present.
3. Say something honest while a display is being assigned, the same way
   "Starting the desktop…" already covers a screen still arriving.

### Done when

Two bots, one box. Chrome opened by bot 1 is **not** on bot 2's screen. Both
report the same `whoami` and see the same files. Verified in the running app
over CDP with both bots open — not by reading a status, by looking at two
screens.

---

## Rules

Same as the rest of this work: one task at a time; verified in the running app
over CDP before moving on; never guess a contract, ask and wait; a green suite
is not evidence that a screen shows the right thing.

The coordination agreement with the `opengrok-server` session is in
[the remaining-work doc](./opengrok-remaining-work.md) and holds unchanged.
