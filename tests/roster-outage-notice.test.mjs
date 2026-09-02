import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A server that cannot answer used to look exactly like an account with no bots: the roster seed
// swallowed its failure into stderr, the page never heard, and it rendered the roster it had —
// nothing. On 2 Sep 2026 a database outage read to the person as "my bots are gone".
//
// The compose function this lives in takes a live gateway, a renderer port and a data directory,
// so it is not reachable from a unit test. What is checked here is the shape of the handler: that
// the failure path tells the page, guarded the same way every other transport post in the file is.
// The behaviour itself was verified by running the packaged app against a dead server; that
// evidence is in docs/verification/roster-outage/.
test("a roster read that fails tells the page, instead of leaving it to render an empty list", async () => {
  const source = await readFile(path.join(repoRoot, "source/node-agent-coordinator/main.ts"), "utf8");
  const start = source.indexOf("async function seedAgentsRosterToMain");
  assert.ok(start > 0, "the roster seed function moved; this test needs to move with it");
  const body = source.slice(start, source.indexOf("\n  function handleTransportEvent", start));

  const failurePath = body.slice(body.indexOf("} catch (error) {"));
  assert.ok(failurePath.length > 0, "the seed still has a failure path");
  assert.match(
    failurePath,
    /server\.postEvent\(COORDINATOR_TRANSPORT_STATE_FAMILY, \{ state: "down" \}\)/,
    "the page is told the transport is down when the roster cannot be read",
  );
  assert.match(
    failurePath,
    /if \(!usesLocalCoordinator\(dataDir\)\)/,
    "guarded like every other transport post in this file: the local route has no gateway to be down",
  );
  assert.ok(
    failurePath.includes("process.stderr.write"),
    "the log line stays: the page shows a person the notice, the log tells an engineer which error",
  );
});

test("the page has somewhere to put it: the state family is the one the renderer consumes", async () => {
  const port = await readFile(path.join(repoRoot, "source/shared/rpc/coordinator-port.ts"), "utf8");
  assert.match(
    port,
    /COORDINATOR_TRANSPORT_STATE_FAMILY = "coordinator-transport-state"/,
    "renaming this family silently disconnects the notice from the failure",
  );
});
