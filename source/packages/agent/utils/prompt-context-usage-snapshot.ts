import type { BlobStore } from "../../agent-kv/blob-store.js";
import { getBlobId } from "../../agent-kv/blob-store.js";
import { toHex } from "../../agent-kv/serde.js";
import {
  getBlobMetadataCallback,
  setBlobReadableFromCloudMirror,
} from "../../agent-kv/typed-blob-store.js";
import { PrivacyCapability } from "../../redaction/classification.js";
import { fromRedactedPromptContextUsageTree } from "../../redacted-protos/generated/agent/v1/agent_redacted.js";
import { PrivacyMode, type PrivacyMode as PrivacyModeValue } from "../../proto/generated/aiserver/v1/privacy_mode_pb.js";
import { PromptContextUsageSnapshot } from "../../proto/generated/agent/v1/agent_pb.js";
import type { PromptContextUsageTree } from "../../proto/generated/agent/v1/agent_pb.js";

interface RedactedPromptContextUsageTree {
  readonly _privacyMode: PrivacyModeValue;
  readonly schemaVersion: number;
  readonly nodes: readonly unknown[];
}

interface PersistPromptContextUsageSnapshotOptions<Context> {
  readonly blobStore: BlobStore<Context>;
  readonly ctx: Context;
  readonly privacyMode: PrivacyModeValue;
  readonly rootPromptMessagesJson: readonly Uint8Array[];
  readonly usageTree: RedactedPromptContextUsageTree | undefined;
}

const fromRedactedUsageTree = fromRedactedPromptContextUsageTree as unknown as (
  message: RedactedPromptContextUsageTree,
  purpose: PrivacyCapability,
) => PromptContextUsageTree;

const serializedSnapshotCache = new WeakMap<object, {
  rootPromptBlobIdsKey: string;
  blobId: Uint8Array;
}>();

function rootPromptBlobIdsKey(blobIds: readonly Uint8Array[]): string {
  return blobIds.map(toHex).join(",");
}

export async function persistPromptContextUsageSnapshot<Context>(
  options: PersistPromptContextUsageSnapshotOptions<Context>,
): Promise<Uint8Array | undefined> {
  if (options.privacyMode === PrivacyMode.NO_STORAGE || options.usageTree === undefined) {
    return undefined;
  }
  const rootBlobIdsKey = rootPromptBlobIdsKey(options.rootPromptMessagesJson);
  const cached = serializedSnapshotCache.get(options.usageTree);
  if (cached?.rootPromptBlobIdsKey === rootBlobIdsKey) {
    return cached.blobId;
  }
  const snapshot = new PromptContextUsageSnapshot({
    promptContextUsageTree: fromRedactedUsageTree(
      options.usageTree,
      PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
    ),
    rootPromptMessagesJson: [...options.rootPromptMessagesJson],
  });
  const serialized = snapshot.toBinary();
  const blobId = await getBlobId(serialized);
  getBlobMetadataCallback(options.blobStore)?.({
    blobId,
    blobType: {
      kind: "proto",
      typeName: "agent.v1.PromptContextUsageSnapshot",
    },
  });
  await setBlobReadableFromCloudMirror({
    blobStore: options.blobStore,
    ctx: options.ctx,
    blobId,
    blobData: serialized,
  });
  serializedSnapshotCache.set(options.usageTree, {
    rootPromptBlobIdsKey: rootBlobIdsKey,
    blobId,
  });
  return blobId;
}
