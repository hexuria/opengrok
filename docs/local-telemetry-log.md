# The local telemetry log

`~/Library/Application Support/OpenGrok/<sand data dir>/telemetry-log.jsonl` (the same directory
`getSandRootDir()` names; a `.1` sibling holds the previous 2 MB). One JSON object per line:
`{"at": ISO time, "level", "event", ...metadata}`. Switch it off with `SAND_LOCAL_TELEMETRY_LOG=0`.

**Why it exists.** On 2 Sep 2026 the question "was the live stream up when the user sent hello"
took an hour of process start times, hand-run SQL and four test messages, because the coordinator
already reported every transport event and the upstream uploader they flow into answers empty
against an OpenGrok server. This file is the durable copy of those reports, on the user's own disk.

**What you will find in it** (grep the `event` field):

| event | what it says |
|---|---|
| `sand.box_reachability` | one line per gateway call and per `/events` connect: `method`, `outcome`, `latency_ms`, `http_status`, `request_id` |
| `sand.gateway_command` | the command span: `method`, `request_id`, `duration_ms`, `is_error` |
| `sand.send_stage` | each stage of a send by `client_nonce`: `post`, `accepted`, `echo-coordinator-sse` (the user message came back over the stream, `duration_ms` = round trip), and **`echo-coordinator-sse-missing`** (it did not, within 30s: the stream is dead) |
| transport stream events | connected / down with `generation`, `reason`, `cause` (`stall-timeout`, `forced-reconnect`, …) |
| coordinator lifecycle | `exited` (with exit class and uptime) and `relaunched`; the renderer port handoff phases |

**Joining with the server.** Every gateway call and stream connect sends `X-Request-Id`; the
server echoes it and stamps it on its request log lines (opengrok-server, `OG_TRACE_REQUESTS`), so
`grep <request_id>` on both machines names the same request.

**The silent-failure detector.** When a send's echo has not arrived after 30s the coordinator
writes the `echo-coordinator-sse-missing` line, tells the renderer the transport is down (its own
reconnecting state), and forces a fresh `/events` stream. A late echo is still recorded, marked
`attempt: 1`, with how late it was.

Secrets never reach the file: keys naming a token, password, secret, authorization or `vncUrl`
are written as `<redacted>`, and `_token=` / `password=` query values are blanked inside any URL.
