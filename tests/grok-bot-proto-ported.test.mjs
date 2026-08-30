import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const RECOVERED_METHOD_NAMES = [
  "EnsureSandBox",
  "EnsureSandBoxWindow",
  "RecreateSandBox",
  "ForceRecreateSandBox",
  "AdminRecreateSandBox",
  "AdminForceRecreateSandBox",
  "PresignSandBoxStoreWrites",
  "CompleteSandBoxStoreMultipartWrites",
  "AbortSandBoxStoreMultipartWrites",
  "PresignSandBoxStoreReads",
  "StatSandBoxStoreObject",
  "ListSandBoxStoreObjects",
  "AdminGetSandBoxStoreStatus",
  "AdminUpdateSandBoxHost",
  "AdminGetSandBoxHostStatus",
  "AdminSnapshotSandBoxStore",
  "AdminHibernateSandBox",
  "AdminListSandAgents",
  "AdminGetSandAgentTranscriptPage",
  "WatchSandBoxMigration",
  "AdminWatchSandBoxMigration",
  "GetSandBoxRunState",
  "ListSandBoxes",
  "NotifySandAgentTurnFinished",
  "ListSandSetupManifests",
  "ListTeamSandSetupManifests",
  "SaveTeamSandSetupManifest",
  "DeleteTeamSandSetupManifest",
  "ListTeamMemberSandBoxes",
  "KillTeamMemberSandBox",
];

const TRANSCRIPT_TRIO = {
  WatchGrokBotTranscripts: "ServerStreaming",
  ListGrokBotTranscriptEntries: "Unary",
  CommitGrokBotTranscriptEntries: "Unary",
};

const ENUMS = [
  "GrokBotAgentHarnessKind",
  "GrokBotTemplateVisibility",
  "GrokBotFirstPartyTemplate",
  "GrokBotClientSurface",
  "GrokBotUserMessageDelivery",
  "GrokBotTemporalHarnessMode",
  "GrokBotSendStatus",
  "GrokBotFeedbackAction",
  "GrokBotAgentMessageDelivery",
  "GrokBotAutoReviewApprovalResolution",
  "GrokBotLocalToolPermissionCardResolution",
  "GrokBotBoxHandBackTrigger",
  "GrokBotRoomMemberTurnDispatch",
];

async function load(entry, outfileName) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-bot-proto-"));
  const output = path.join(temporary, outfileName);
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

function methodNames(service) {
  return Object.values(service.methods).map((method) => method.name);
}

test("recovered grok_bot_connect.ts still exports exactly the original 30 method names", async () => {
  const loaded = await load(
    "source/packages/proto/generated/aiserver/v1/grok_bot_connect.ts",
    "grok-bot-connect.mjs",
  );
  try {
    const names = methodNames(loaded.module.GrokBotService);
    assert.deepEqual(names, RECOVERED_METHOD_NAMES);
    assert.equal(names.length, 30);
  } finally {
    await loaded.dispose();
  }
});

test("ported GrokBotService has 76 names including the transcript trio with the right MethodKind", async () => {
  const loaded = await load(
    "source/packages/proto/generated/aiserver/v1/grok_bot_connect.ported.ts",
    "grok-bot-connect-ported.mjs",
  );
  try {
    const { GrokBotService } = loaded.module;
    const names = methodNames(GrokBotService);
    assert.equal(names.length, 76);
    assert.ok(RECOVERED_METHOD_NAMES.every((name) => names.includes(name)));
    for (const [name, kind] of Object.entries(TRANSCRIPT_TRIO)) {
      const method = Object.values(GrokBotService.methods).find((entry) => entry.name === name);
      assert.ok(method, `missing ${name}`);
      assert.equal(method.kind, { Unary: 0, ServerStreaming: 1 }[kind]);
    }
    // Streaming kinds must stay ServerStreaming even if the numeric enum is inlined.
    assert.equal(GrokBotService.methods.watchGrokBotTranscripts.kind, GrokBotService.methods.watchSandBoxMigration.kind);
    assert.equal(GrokBotService.methods.listGrokBotTranscriptEntries.kind, GrokBotService.methods.ensureSandBox.kind);
    assert.equal(GrokBotService.methods.commitGrokBotTranscriptEntries.kind, GrokBotService.methods.ensureSandBox.kind);
  } finally {
    await loaded.dispose();
  }
});

test("grok_bot_pb exports the 13 enums and the transcript request/response types", async () => {
  const loaded = await load(
    "source/packages/proto/generated/aiserver/v1/grok_bot_pb.ts",
    "grok-bot-pb.mjs",
  );
  try {
    for (const name of ENUMS) {
      assert.equal(typeof loaded.module[name], "object", name);
      assert.equal(loaded.module[name].UNSPECIFIED, 0, name);
    }
    for (const name of [
      "ListGrokBotTranscriptEntriesRequest",
      "ListGrokBotTranscriptEntriesResponse",
      "CommitGrokBotTranscriptEntriesRequest",
      "CommitGrokBotTranscriptEntriesResponse",
      "WatchGrokBotTranscriptsRequest",
      "GrokBotTranscriptWatchFrame",
      "GrokBotTranscriptEntry",
    ]) {
      assert.equal(loaded.module[name].typeName, `aiserver.v1.${name}`);
    }
    assert.equal(
      loaded.module.GrokBotRoomMemberTurnMessage_ReplyTarget.typeName,
      "aiserver.v1.GrokBotRoomMemberTurnMessage.ReplyTarget",
    );
    assert.equal(
      loaded.module.GrokBotRoomMemberTurnMessage_SpeakerKind.UNSPECIFIED,
      0,
    );
    assert.equal(loaded.module.GrokBotRoomMemberTurnMessage_SpeakerKind.HUMAN, 1);
    assert.equal(loaded.module.GrokBotRoomMemberTurnMessage_SpeakerKind.AGENT, 2);
  } finally {
    await loaded.dispose();
  }
});

test("ported SandBoxService has 37 methods and does not replace recovered GrokBotService", async () => {
  const recovered = await load(
    "source/packages/proto/generated/aiserver/v1/grok_bot_connect.ts",
    "recovered-connect.mjs",
  );
  const ported = await load(
    "source/packages/proto/generated/aiserver/v1/sand_box_connect.ported.ts",
    "sandbox-connect.mjs",
  );
  try {
    assert.equal(methodNames(recovered.module.GrokBotService).length, 30);
    assert.equal(ported.module.SandBoxService.typeName, "aiserver.v1.SandBoxService");
    assert.equal(methodNames(ported.module.SandBoxService).length, 37);
    assert.ok(methodNames(ported.module.SandBoxService).includes("MintSandVoiceCallSecret"));
    assert.ok(methodNames(ported.module.SandBoxService).includes("GetSandBoxUpgradeSchedule"));
  } finally {
    await recovered.dispose();
    await ported.dispose();
  }
});

test("sand_box_pb.ported.ts exports the 16 box-extra messages with typeName only", async () => {
  const loaded = await load(
    "source/packages/proto/generated/aiserver/v1/sand_box_pb.ported.ts",
    "sand-box-pb-ported.mjs",
  );
  try {
    const names = loaded.module.PORTED_SAND_BOX_MESSAGE_NAMES;
    assert.equal(names.length, 16);
    for (const name of names) {
      assert.equal(loaded.module[name].typeName, `aiserver.v1.${name}`);
      assert.equal(loaded.module[name].fields.list().length, 0, name);
    }
  } finally {
    await loaded.dispose();
  }
});
