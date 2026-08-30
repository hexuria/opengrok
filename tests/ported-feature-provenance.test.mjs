import assert from "node:assert/strict";
import test from "node:test";

import { auditPortedFeatures } from "../scripts/audit-ported-features.mjs";

/*
 * Ported features make a different claim from the rest of this tree: they did
 * not exist in 0.18. The ledger is how that claim is recorded, and this is the
 * check that it stays true — every file it names still exists, sits in an
 * editable tree, is claimed once, and cites what it came from.
 */
test("every ported feature is accounted for and still on disk", async () => {
  const { findings, features } = await auditPortedFeatures();
  assert.deepEqual(findings, [], `ported-feature provenance findings: ${JSON.stringify(findings, null, 2)}`);
  assert.ok(features.length > 0);
});

test("the ledger does not claim a file the 0.18 catalogs own", async () => {
  const { features } = await auditPortedFeatures();
  // The pinned theme installer is the one file a careless accent port would
  // have touched; it must never appear here.
  const claimed = features.flatMap((feature) => feature.cleanPaths);
  assert.ok(
    !claimed.includes("frontend/src/recovered/features/runtime-theme-token-installer.ts"),
    "the pinned theme installer is recovered 0.18, not ported",
  );
  for (const recovered of [
    "source/packages/proto/generated/aiserver/v1/grok_bot_connect.ts",
    "source/packages/proto/generated/aiserver/v1/sand_box_pb.ts",
    "source/shared/node/experiments/experiment-config.gen.ts",
  ]) {
    assert.ok(!claimed.includes(recovered), `${recovered} is recovered 0.18, not ported`);
  }
  assert.ok(
    claimed.includes("source/packages/proto/generated/aiserver/v1/grok_bot_pb.ts"),
    "the additive grok_bot_pb port must be in the ledger",
  );
  assert.ok(
    claimed.includes("source/packages/proto/generated/aiserver/v1/grok_bot_connect.ported.ts"),
    "the ported GrokBotService must be in the ledger",
  );
});
