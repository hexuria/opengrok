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

## The decision that comes first

**Can one ascii.dev box run several X displays, or does a screen each mean a box
each?** Nobody knows yet, and everything below branches on it.

- **Several displays in one box** — matches the original, keeps
  one-account-one-computer, costs nothing extra. Needs the box image to run more
  than one X server plus a router, and the server to assign and report them.
- **A box per agent** — simpler to reach, but collides with the sharing model
  the user chose, and multiplies the ascii.dev bill by the number of bots. It
  also stops being a *shared* computer, which was the point.

**This is the server session's question** (and possibly ascii.dev's). Do not
build toward either answer until it is settled. Note that a box per agent is a
product decision with a cost, not a technical fallback — it needs the user, not
just us.

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
