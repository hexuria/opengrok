# A server that cannot answer must not look like an account with no bots

2 Sep 2026. The dev server's database went away for about twenty minutes and the desktop client
showed an empty roster. The person's reading of that was the correct one to fear: "did you reset
the database, my bots are gone".

## What was actually happening

The volume filled from per-branch build directories. The Docker VM's filesystem went read-only on
the resulting write error, Postgres panicked on a write-ahead-log sync and sat in recovery, and the
server could not reach it. From the server's own log:

```
ERROR opengrok_server::gateway::routes: listAgents could not read the roster
      error=the database refused: pool timed out while waiting for an open connection
INFO  request method=POST uri=/api/createAgent status=500 ms=10001
INFO  request method=POST uri=/api/listAgents  status=500
```

Ten seconds, then a 500, on every roster read and every hire.

## What the client did with that, and why it was the wrong thing

`seedAgentsRosterToMain` in `source/node-agent-coordinator/main.ts` caught the failure, wrote one
line to stderr, and returned. The page was told nothing at all, so it rendered the roster it had —
on a fresh launch, none. A total outage and an empty account are the same picture.

The app already has the right surface and was already driving it from elsewhere: a `down` on
`coordinator-transport-state` puts the roster's reconnect notice and its Retry in front of the
person. A comment a few lines below the bug says as much, about the mirror-image mistake:
announcing only "down" once left the page believing it was offline so it never asked for a roster.

The failure path now posts that state. It is posted after the caller's synchronous "connected",
because this catch is asynchronous, so the state the page keeps is the true one.

## What this run proved, and what it did not

**Proved.** The outage itself, above, from the server's log; that the client swallowed it, from the
code; and that the fix typechecks, passes the suite (326 tests, 0 failures), packages and installs.

**NOT proved: nobody has watched the notice appear.** The fix was written during the real outage
precisely so it could be shown on a genuinely dead server, and the outage was resolved by the
server session — Docker restarted, Postgres recovered cleanly from its checkpoint — while this
build was still packaging. By the time it was installed the server was healthy and the roster
loaded normally, which is the right outcome for the person and the wrong one for the camera.

To capture it, point the app at a gateway that is not listening and relaunch: the notice should
appear where the roster would be, with a Retry, instead of an empty list. Add the capture here.
