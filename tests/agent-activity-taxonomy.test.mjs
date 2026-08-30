import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load(entry) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "agent-activity-"));
  const outfile = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile,
    bundle: true,
    format: "esm",
    platform: "neutral",
  });
  const loaded = await import(pathToFileURL(outfile).href);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

const TAXONOMY = "frontend/src/recovered/features/conversation/activity/agent-activity.ts";
const HOLD = "frontend/src/recovered/features/conversation/activity/activity-hold.ts";

const tool = (name, extra = {}) => ({ kind: "tool", tool: name, ...extra });

/*
 * Every row was read off the 0.27 renderer bundle (the `xb` switch), so these
 * are transcription assertions: if a label or glyph drifts, the port stopped
 * matching the app it came from.
 */
const CASES = [
  [{ kind: "thinking" }, "thinking", "Thinking", "thinking-medium"],
  [tool("WebSearch"), "searching", "Searching the web", "magnifying-glass"],
  [tool("WebFetch"), "browsing", "Reading the web", "globe"],
  [tool("Read"), "reading", "Reading file", "book-open"],
  [tool("ExternalRead"), "reading", "Reading file", "book-open"],
  [tool("BoxRead"), "reading", "Reading file", "book-open"],
  [tool("ExternalShell"), "on-your-computer", "On your computer", "laptop"],
  [tool("ExternalShell", { detail: "notes.md" }), "writing", "Drafting the file", "pencil"],
  [tool("Shell"), "running-commands", "Running commands", "terminal"],
  [tool("BoxShell"), "running-commands", "Running commands", "terminal"],
  [tool("Shell", { detail: "report.txt" }), "writing", "Drafting the file", "pencil"],
  [tool("CopyToBox"), "on-your-computer", "Organizing files", "laptop"],
  [tool("CopyFromBox"), "on-your-computer", "Organizing files", "laptop"],
  [tool("Await"), "waiting", "Waiting on a command", "hourglass"],
  [tool("AwaitShell"), "waiting", "Waiting on a command", "hourglass"],
  [tool("AwaitExternalShell"), "waiting", "Waiting on a command", "hourglass"],
  // 0.18's host spells this the other way round; both must land here.
  [tool("ExternalAwaitShell"), "waiting", "Waiting on a command", "hourglass"],
  [tool("GenerateImage"), "generating", "Generating a photo", "image"],
  [tool("CloudAgent"), "coding", "Coding", "cursor-logo"],
  [tool("Task"), "waiting", "Waiting on another Bot", "hourglass"],
  [tool("Screenshot"), "on-its-computer", "On its computer", "device-desktop"],
  [tool("Computer"), "on-its-computer", "On its computer", "device-desktop"],
  [tool("request_box_help"), "on-its-computer", "On its computer", "device-desktop"],
  [tool("request_user_form"), "waiting", "Waiting for you", "hourglass"],
  [tool("CreateAgent"), "messaging", "Messaging", "person-chat-bubble"],
  [tool("ReactToMessage"), "messaging", "Messaging", "person-chat-bubble"],
  [tool("CheckSubagent"), "waiting", "Waiting on another Bot", "hourglass"],
  [tool("MessageSubagent"), "waiting", "Waiting on another Bot", "hourglass"],
  [tool("StopSubagent"), "waiting", "Waiting on another Bot", "hourglass"],
  [tool("browser_navigate"), "browsing", "Browsing the web", "globe"],
  [tool("SomethingNobodyMapped"), "working", "Working", "wrench"],
  [tool(""), "working", "Working", "wrench"],
];

test("every tool maps to the verb, label and glyph 0.27 gives it", async () => {
  const { loaded, cleanup } = await load(TAXONOMY);
  try {
    for (const [activity, verb, text, glyphName] of CASES) {
      const described = loaded.describeAgentActivity(activity);
      assert.ok(described, `no descriptor for ${JSON.stringify(activity)}`);
      assert.equal(described.verb, verb, `verb for ${activity.tool ?? activity.kind}`);
      assert.equal(described.text, text, `text for ${activity.tool ?? activity.kind}`);
      assert.deepEqual(described.icon, { kind: "glyph", name: glyphName });
    }
    assert.equal(loaded.describeAgentActivity(null), null);
    assert.equal(loaded.describeAgentActivity({ kind: "idle" }), null);
  } finally {
    await cleanup();
  }
});

test("MCP tools read as connecting, and name the service when it is known", async () => {
  const { loaded, cleanup } = await load(TAXONOMY);
  try {
    const anonymous = loaded.describeAgentActivity(tool("CallMcpTool"));
    assert.equal(anonymous.text, "Connecting to a third party app");
    assert.deepEqual(anonymous.icon, { kind: "glyph", name: "plug" });

    const named = loaded.describeAgentActivity(tool("CallMcpTool", { detail: "linear" }));
    assert.equal(named.verb, "connecting");
    assert.equal(named.text, "Connecting to Linear");
    assert.deepEqual(named.textParams, { service: "Linear" });
    assert.deepEqual(named.icon, { kind: "connector", service: "linear" });

    // The whole plugin/MCP family shares the connector story.
    for (const name of ["GetMcpTools", "McpAuth", "InstallPlugin", "EnableTeamServer"]) {
      assert.equal(loaded.describeAgentActivity(tool(name)).verb, "connecting");
    }
  } finally {
    await cleanup();
  }
});

test("messaging another agent shows that agent's own mark when it has one", async () => {
  const { loaded, cleanup } = await load(TAXONOMY);
  try {
    const anonymous = loaded.describeAgentActivity(tool("SendToAgent"));
    assert.equal(anonymous.verb, "sending");
    assert.equal(anonymous.text, "Messaging another assistant");
    assert.deepEqual(anonymous.icon, { kind: "glyph", name: "person-chat-bubble" });

    const named = loaded.describeAgentActivity(tool("SendToAgent", { target: "agent-7" }), {
      targetAgentName: "  Puck  ",
    });
    assert.equal(named.text, "Messaging Puck");
    assert.deepEqual(named.textParams, { name: "Puck" });
    assert.deepEqual(named.icon, { kind: "agent", agentId: "agent-7" });

    // UpdateAgent is the same story told with a different verb.
    assert.equal(loaded.describeAgentActivity(tool("UpdateAgent")).verb, "messaging");
  } finally {
    await cleanup();
  }
});

test("labels are collapsed and clamped to 60 characters", async () => {
  const { loaded, cleanup } = await load(TAXONOMY);
  try {
    assert.equal(loaded.clampActivityText("  Reading   the \n web  "), "Reading the web");
    const long = loaded.clampActivityText("x".repeat(120));
    assert.equal(long.length, 60);
    assert.ok(long.endsWith("…"));

    const service = loaded.describeAgentActivity(tool("CallMcpTool", { detail: "a".repeat(80) }));
    assert.ok(service.text.length <= 60);
  } finally {
    await cleanup();
  }
});

test("the verb decides the mark animation, and an unknown activity is idle", async () => {
  const { loaded, cleanup } = await load(TAXONOMY);
  try {
    assert.equal(loaded.personaStateForActivity({ kind: "thinking" }), "thinking");
    assert.equal(loaded.personaStateForActivity(tool("WebSearch")), "searching");
    assert.equal(loaded.personaStateForActivity(tool("Shell")), "working");
    assert.equal(loaded.personaStateForActivity(tool("GenerateImage")), "loading");
    assert.equal(loaded.personaStateForActivity(tool("Task")), "orbit");
    assert.equal(loaded.personaStateForActivity(tool("SendToAgent")), "sending");
    assert.equal(loaded.personaStateForActivity(null), "idle");

    // Every verb must have a state, or a real activity would fall back to idle.
    for (const verb of Object.keys(loaded.PERSONA_STATE_BY_ACTIVITY_VERB)) {
      assert.ok(loaded.PERSONA_STATE_BY_ACTIVITY_VERB[verb].length > 0, `${verb} has no state`);
    }
  } finally {
    await cleanup();
  }
});

test("two activities that read alike share one display key", async () => {
  const { loaded, cleanup } = await load(TAXONOMY);
  try {
    const first = loaded.activityDisplayKey(tool("Shell", { callId: "a" }));
    const second = loaded.activityDisplayKey(tool("Shell", { callId: "b" }));
    assert.equal(first, second, "the call id must not make it a different label");
    assert.notEqual(first, loaded.activityDisplayKey(tool("WebSearch")));
    assert.equal(loaded.activityDisplayKey(null), null);
  } finally {
    await cleanup();
  }
});

test("a label stays put for its minimum, then the newest one takes over", async () => {
  const { loaded, cleanup } = await load(HOLD);
  try {
    const { EMPTY_ACTIVITY_HOLD, advanceActivityHold, flushActivityHold, activityHoldDelayMs, ACTIVITY_MIN_SHOW_MS } = loaded;
    assert.equal(ACTIVITY_MIN_SHOW_MS, 800);

    // The first activity shows at once.
    let state = advanceActivityHold(EMPTY_ACTIVITY_HOLD, tool("Shell"), 1_000);
    assert.equal(state.shown.tool, "Shell");
    assert.equal(state.queued, null);

    // A like activity is not a change, so it neither queues nor restarts.
    state = advanceActivityHold(state, tool("Shell", { callId: "other" }), 1_100);
    assert.equal(state.shownAtMs, 1_000);
    assert.equal(state.queued, null);

    // A different one arriving too soon waits its turn.
    state = advanceActivityHold(state, tool("WebSearch"), 1_200);
    assert.equal(state.shown.tool, "Shell");
    assert.equal(state.queued.tool, "WebSearch");
    assert.equal(activityHoldDelayMs(state, 1_200), 600);

    // Flushing early changes nothing.
    assert.equal(flushActivityHold(state, 1_500).shown.tool, "Shell");

    // Once the minimum has passed the queued label is promoted.
    state = flushActivityHold(state, 1_900);
    assert.equal(state.shown.tool, "WebSearch");
    assert.equal(state.queued, null);
    assert.equal(activityHoldDelayMs(state, 1_900), null);

    // Past the minimum, a new activity shows immediately.
    state = advanceActivityHold(state, tool("Task"), 3_000);
    assert.equal(state.shown.tool, "Task");

    // The last arrival in a burst wins the queue.
    state = advanceActivityHold(state, tool("Read"), 3_100);
    state = advanceActivityHold(state, tool("GenerateImage"), 3_200);
    assert.equal(state.queued.tool, "GenerateImage");
    assert.equal(flushActivityHold(state, 4_000).shown.tool, "GenerateImage");
  } finally {
    await cleanup();
  }
});

test("the avatar reads the shared taxonomy instead of guessing from tool names", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    path.join(repoRoot, "frontend/src/recovered/features/conversation/workspace/agent-avatar.tsx"),
    "utf8",
  );
  // The private copy of the verb table is gone; one table now serves both.
  assert.ok(!source.includes("ACTIVITY_TO_STATE"), "the duplicated verb table must be deleted");
  assert.match(source, /PERSONA_STATE_BY_ACTIVITY_VERB/);
  assert.match(source, /describeAgentActivity/);
  // A pre-described activity still resolves through its own verb.
  assert.match(source, /typeof value\.verb === "string" \? value\.verb : null/);
});

test("the sidebar shows the named activity and rings the mark for it", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    path.join(repoRoot, "frontend/src/recovered/features/conversation/workspace/sidebar.tsx"),
    "utf8",
  );
  assert.match(source, /useActivityHold/);
  // A row waiting on the person is not busy, so it names nothing.
  assert.match(source, /agent\.awaitingUserResponse != null \? null : \(agent\.currentActivity/);
  assert.match(source, /describeAgentActivity\(heldActivity\)/);
  assert.match(source, /isActivityNamed: namedActivity != null/);
  // The label wins over the last message, but the last message still stands in.
  assert.match(source, /namedActivity\?\.text \?\? agent\.lastMessage \?\? null/);
});

test("connector logos come from the recovered tool-asset set and fall back to plug", async () => {
  const { loaded, cleanup } = await load("frontend/src/recovered/features/conversation/activity/connector-logo.ts");
  try {
    assert.equal(loaded.connectorAssetKey("GitHub"), "github");
    assert.equal(loaded.connectorAssetKey("microsoft 365"), "microsoft-365");
    assert.ok(typeof loaded.connectorLogoUrl("github") === "string" && loaded.connectorLogoUrl("github").length > 0);
    assert.ok(typeof loaded.connectorLogoUrl("slack") === "string" && loaded.connectorLogoUrl("slack").length > 0);
    assert.equal(loaded.connectorLogoUrl("linear"), null);
    assert.equal(loaded.connectorLogoUrl(""), null);
  } finally {
    await cleanup();
  }
});

test("the transcript activity line sits outside the virtualized window", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    path.join(repoRoot, "frontend/src/recovered/features/conversation/workspace/transcript.tsx"),
    "utf8",
  );
  assert.match(source, /TranscriptActivityLine/);
  assert.match(source, /useActivityHold/);
  assert.match(source, /sand-virtual-transcript/);
  // The slot is a sibling of the virtualized window, not a mapped row.
  const slotIndex = source.indexOf("<TranscriptActivityLine");
  const windowClose = source.lastIndexOf("sand-virtual-transcript");
  assert.ok(slotIndex > 0, "the activity line must be mounted");
  assert.ok(slotIndex > windowClose, "the activity line must sit after the virtualized window");
});
