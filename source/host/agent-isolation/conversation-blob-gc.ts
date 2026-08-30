import { isMessage, type FieldInfo, type Message } from "@bufbuild/protobuf";

import { ConversationStateStructure } from "../../packages/proto/generated/agent/v1/agent_pb.js";
import {
  BLOB_REFERENCE_MESSAGE_TYPE_BY_NAME,
  getBlobReferenceMessageMetadata,
  isProtoBlobReferenceTypeName
} from "../../packages/proto/generated/agent/v1/blob-reference-metadata.js";

export const EDGES_NOT_WALKED_SO_REFERENTS_COLLECT = new Set([
  "agent.v1.UserMessage.conversation_state_blob_id",
  "agent.v1.ConversationStateStructure.summary_archive",
  "agent.v1.ConversationStateStructure.summary_archives"
]);

function fieldValue(message: Message, field: FieldInfo): unknown {
  const record = message as unknown as Record<string, unknown>;
  if (field.oneof == null) return record[field.localName];
  const selection = record[field.oneof.localName];
  if (selection == null || typeof selection !== "object") return undefined;
  const selected = selection as { readonly case?: unknown; readonly value?: unknown };
  return selected.case === field.localName ? selected.value : undefined;
}

function* blobIdsIn(rawValue: unknown): Iterable<Uint8Array> {
  if (rawValue instanceof Uint8Array) {
    yield rawValue;
    return;
  }
  if (Array.isArray(rawValue)) {
    for (const entry of rawValue) if (entry instanceof Uint8Array) yield entry;
    return;
  }
  if (rawValue != null && typeof rawValue === "object") {
    for (const entry of Object.values(rawValue)) if (entry instanceof Uint8Array) yield entry;
  }
}

export function toHexId(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex");
}

export function collectReachableBlobHexIds(options: {
  readonly rootBytes: Uint8Array;
  getBlobByHexId(id: string): Uint8Array | undefined;
}): { readonly reachableHexIds: Set<string>; readonly unresolvedProtoRefs: number } {
  const reachableHexIds = new Set<string>();
  let unresolvedProtoRefs = 0;

  function visitBlobReference(blobId: Uint8Array, blobReferenceType: string): void {
    if (blobId.length === 0) return;
    const hexId = toHexId(blobId);
    if (reachableHexIds.has(hexId)) return;
    reachableHexIds.add(hexId);
    if (!isProtoBlobReferenceTypeName(blobReferenceType)) return;
    const childBytes = options.getBlobByHexId(hexId);
    if (childBytes == null) {
      unresolvedProtoRefs += 1;
      return;
    }
    let child: Message;
    try {
      child = BLOB_REFERENCE_MESSAGE_TYPE_BY_NAME[blobReferenceType]!.fromBinary(childBytes);
    } catch {
      unresolvedProtoRefs += 1;
      return;
    }
    visitMessage(child);
  }

  function visitMessage(message: Message): void {
    const messageType = message.getType();
    const blobFieldsByLocalName = new Map(
      (getBlobReferenceMessageMetadata(messageType.typeName)?.fields ?? []).map(field => [field.localFieldName, field])
    );
    for (const field of messageType.fields.list()) {
      const rawValue = fieldValue(message, field);
      if (rawValue == null) continue;
      const blobField = blobFieldsByLocalName.get(field.localName);
      if (blobField != null) {
        if (EDGES_NOT_WALKED_SO_REFERENTS_COLLECT.has(`${messageType.typeName}.${blobField.protoFieldName}`)) continue;
        for (const blobId of blobIdsIn(rawValue)) visitBlobReference(blobId, blobField.blobReferenceType);
        continue;
      }
      if (field.kind === "message") {
        if (field.repeated) {
          if (Array.isArray(rawValue)) for (const entry of rawValue) if (isMessage(entry)) visitMessage(entry);
        } else if (isMessage(rawValue)) {
          visitMessage(rawValue);
        }
        continue;
      }
      if (field.kind === "map" && field.V.kind === "message" && rawValue != null && typeof rawValue === "object") {
        for (const entry of Object.values(rawValue)) if (isMessage(entry)) visitMessage(entry);
      }
    }
  }

  visitMessage(ConversationStateStructure.fromBinary(options.rootBytes));
  return { reachableHexIds, unresolvedProtoRefs };
}
