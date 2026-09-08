# Bringing up the whole stack

Three repositories, in this order, because each depends on the one before it:

```
open-ai-gateway  ->  opengrok-server  ->  opengrok (this repo, the desktop app)
   :29080/:29081        :1447                Open Grok V2.app
```

The gateway holds the provider credentials and the model catalogue. The server
holds coworkers, transcripts and pins, and calls the gateway for inference. The
desktop calls the server and never talks to the gateway at all.

Each repository documents its own half authoritatively:

- `open-ai-gateway` — infrastructure, migrations, seats, ladder, catalogue.
- `opengrok-server` — `docs/setup/README.md` is the index; `environment.md` and
  `running.md` carry the model door, the token-secret discipline and the restart
  gotchas. `docs/known-gaps.md` holds its open items.
- this file — the order, the seams between them, and the desktop.

What follows is the seams: the things that are nobody's half alone, and the
failures that come from getting them out of order. It was written the night of
2026-09-08, when a Docker restart wiped the gateway's database and it took three
sessions and about six hours to get a single "ok" back from a model. Nearly all
of that time went on four separate faults that produced identical-looking
symptoms. They are all called out below.

---

## 1. The gateway

Full detail lives in `open-ai-gateway`. The seams that matter here:

**Its dev database must be on a named volume.** It used to mount
`/var/lib/postgresql` as tmpfs, which means *any* container recreate — not just
a deliberate `just dev-reset` — silently empties the schema, every principal,
every API key and the whole catalogue. A Docker Desktop restart did exactly that
and nothing surfaced it, because the server kept its own keys and went on
presenting them to a gateway that no longer had the rows behind them.

Mount at `/var/lib/postgresql`, **not** `/var/lib/postgresql/data`. The `/data`
form is correct for Postgres 17 and earlier and makes an 18 container refuse to
start.

**Setup order is infra → migrate → principal/route/key → catalogue → seats.**
Importing a seat for a provider whose models are not in the catalogue yields a
credential that authenticates and routes nowhere, which looks exactly like a
broken credential.

**`just dev` migrates as a side effect** — it is `dev-up migrate`. Nobody types
`just migrate` thinking "this is the destructive one"; everybody types `just
dev`. If you are restoring a dump, bring up Postgres alone first, and always
restore with `psql -v ON_ERROR_STOP=1`, or a collision half-applies and leaves a
database that *looks* migrated.

**Provider credentials are subscriptions, not API keys**, and they import from
files your own CLI already wrote (`~/.codex/auth.json`, `~/.grok/auth.json`) —
no secret is ever pasted. Two traps: Codex needs
`gateway.codex.instructions_path` set or the seat is refused in a way
indistinguishable from a bad credential; and **Anthropic subscriptions are
refused by design** (ProhibitedByTerms — Anthropic's terms forbid intermediating
Claude.ai credentials). The sanctioned route for Anthropic is a Console API key.

**Seats must be shared, or coworkers cannot see them.** See §4.

---

## 2. The server

Full detail lives in `opengrok-server`. The seams:

**It needs two keys from the gateway**, an inference token and an admin token,
which go in its `.env` as `OG_GATEWAY_TOKEN` and `OG_GATEWAY_ADMIN_TOKEN`.
Crossing them is a specific and confusing failure: admin routes keep working
while every inference call 401s.

Keys move as a **mode-600 file on disk**, read by whoever needs them. No key
value should ever pass through a chat transcript, a commit, or an agent message
— only prefixes, which are not secret and are enough to verify.

**Editing that `.env` can sign out every desktop.** `OG_TOKEN_SECRET` is
required with no per-boot fallback, so a rewrite that regenerates it invalidates
every desktop token at once — and recovery is a full sign-in through a
three-minute window with a person at the keyboard, not a quiet refresh.
Fingerprint the secret (`sha256`, first 12 hex is plenty) before and after any
`.env` edit and confirm it did not move.

**Migrations run in-process at startup** under an advisory lock. There is no
external migrate step; rebuilding and restarting applies anything new.

**Stop it with `pgrep -x opengrok`, never `lsof -ti:1447`.** Caddy holds
`*:1447` on IPv6 while the server holds `127.0.0.1:1447` on IPv4. The port form
finds caddy and kills the wrong thing.

**`OG_MODEL_DOOR` decides whether any of this matters:**

| value | what happens |
|---|---|
| `gateway` | the default. Sends the coworker's pin explicitly. Use this. |
| `rig` | **drops the model.** The gateway then classifies by prompt and the pin is silently ignored. |
| `mock-cards` | serves transcript fixtures. No real inference, and the model picker is empty by design. |

`rig` deserves its warning. Turns still *succeed* under it, so nothing looks
broken — they are simply answered by whatever tier a classifier picked, at that
tier's cost, rather than by the model anyone chose.

---

## 3. The desktop

This repository. See `CLAUDE.md` for the build and CDP rules; the short version:

```sh
node scripts/package-macos.mjs
rsync -a --delete "dist/Open Grok V2.app/" "/Applications/Open Grok V2.app/"
```

Install **in place**. Deleting the installed bundle first makes macOS prune its
Full Disk Access grant, and the permission silently stops working.

The desktop holds two secrets, both minted by and validated against the
**server**, never the gateway. So rotating the server's gateway keys, or
rebuilding and restarting the server, does **not** sign anyone out. If a gateway
bearer does go stale there is a no-browser self-heal that re-mints it from the
still-valid access token; full sign-in is only the last resort.

The model picker lists exactly what the gateway *advertises*. A pin that is
servable but unadvertised — which is normal, see §5 — appears under
"Pinned · not advertised" with a **Test** button that probes it. The probe is a
real billed completion, so it is user-initiated only, one request per click, and
never retried.

---

## 4. The seam that will bite you: principals

The gateway filters credentials by principal:
`owner_principal_id IS NULL OR owner_principal_id = <caller>`.

The server authenticates to the gateway as **two different identities**
depending on the path:

- its **deployment key**, on the principal the seats were imported under; and
- a **per-coworker key**, minted on the server's own org principal, attached to
  any request for a coworker that has one.

If the seats are imported bound to an owner, a coworker turn authenticates
perfectly and then sees **no credentials at all** — because it is asking as a
principal the seats are not visible to. Import seats with `--shared`, which sets
the owner to NULL and satisfies both sides.

Two things make this hard to diagnose, which is why it is written down here:

- **`--shared` applies only at import.** There is no CLI subcommand to change an
  existing credential's ownership.
- **The error names the wrong provider.** On a route where nothing is visible,
  the ladder tries each rung and reports the *last* one it tried. The same
  single fault appeared as `no credential available for provider anthropic`,
  then `...for provider openai`, then `no subscription credential for xai`,
  purely depending on which rung the request reached. The named provider is your
  ceiling, not your floor.

Related: per-coworker key rows live in the server's database, which survives
independently of the gateway's. If the gateway's database is ever wiped, those
rows point at keys that no longer exist and the server has no way to know —
every affected coworker gets `401 authentication failed` on dispatch. Deleting
the stale rows is the fix; they carry no recoverable accounting, because the
usage they pointed at lived on the gateway side and died with it.

---

## 5. Advertised is not servable, in both directions

`GET /v1/models` reports what each seat's provider *advertises*, which is filled
from each provider's own usage endpoint. It is a list for a picker, never an
authority on what will answer:

- **`xai/grok-4.6` is servable but never advertised** — xAI's endpoint returns
  quota and no model list at all, so nothing is ever recorded for it. It
  dispatches fine. This is permanent, not a bug, and not worth "fixing" by
  changing a default away from it.
- **`openai/gpt-5.5` is advertised but 404s** on a Codex seat.

Probe before trusting either direction. The desktop's Test button and the
server's `POST /models/probe` exist for exactly this.

---

## 6. Verifying the whole chain

In order, stopping at the first failure:

```sh
# 1. gateway serves models
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:29080/v1/models \
  -H "Authorization: Bearer $OG_GATEWAY_TOKEN"          # expect 200

# 2. gateway answers a pinned completion
#    expect 200 and a real reply

# 3. server is up and on the right door
curl -sk https://<host>:1447/health                      # expect ok:true
ps eww $(pgrep -x opengrok) | tr ' ' '\n' | grep OG_MODEL_DOOR   # expect gateway

# 4. seats are visible to every principal
docker exec oag-dev-postgres-1 psql -U oag -d oag -At \
  -c "select name, coalesce(owner_principal_id::text,'SHARED') from account;"
                                                          # expect SHARED
```

Then send one message from the desktop to a coworker with a known pin. Success
is **not** "it answered" — turns answer even when the pin is being ignored. The
proof is that the gateway logs the request as `Passthrough` with your model,
rather than `Classified` onto a tier.

---

## 7. What the gateway cannot tell you

Worth knowing before your next incident, because it shaped this one:

- **A rejected key is not logged at all.** Verified by presenting junk and
  watching the log not grow. So "no 401s in my log" is not evidence of anything,
  and neither the key presented nor the principal it searched as is recoverable
  after the fact.

Logging the presented prefix on a refusal, and naming the searched principal in
the no-credential error, are both on the gateway's list. Until they land, the
server's side is the only place that can say which credential went out.
