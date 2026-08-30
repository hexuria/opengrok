/**
 * Fields consumed by the shipped transcript mirror. The complete generated
 * ConversationStateStructure has many more fields; the worker skips those in
 * standard protobuf fashion because transcript JSONL production never reads them.
 */
export interface TranscriptMirrorConversationState {
  readonly rootPromptMessagesJson: readonly Uint8Array[];
  readonly turns: readonly Uint8Array[];
  readonly summaryArchives: readonly Uint8Array[];
}

export class TranscriptMirrorProtobufDecodeError extends Error {
  override name = "TranscriptMirrorProtobufDecodeError";
}

interface Cursor {
  offset: number;
}

function readVarint(bytes: Uint8Array, cursor: Cursor): number {
  let value = 0;
  let multiplier = 1;
  for (let index = 0; index < 10; index += 1) {
    const byte = bytes[cursor.offset++];
    if (byte === undefined) {
      throw new TranscriptMirrorProtobufDecodeError("truncated protobuf varint");
    }
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) {
      if (!Number.isSafeInteger(value)) {
        throw new TranscriptMirrorProtobufDecodeError("protobuf varint exceeds the safe integer range");
      }
      return value;
    }
    multiplier *= 128;
  }
  throw new TranscriptMirrorProtobufDecodeError("invalid protobuf varint");
}

function readBytes(bytes: Uint8Array, cursor: Cursor): Uint8Array {
  const length = readVarint(bytes, cursor);
  const end = cursor.offset + length;
  if (!Number.isSafeInteger(end) || end > bytes.length) {
    throw new TranscriptMirrorProtobufDecodeError("truncated protobuf bytes field");
  }
  const value = bytes.slice(cursor.offset, end);
  cursor.offset = end;
  return value;
}

function skipField(
  bytes: Uint8Array,
  cursor: Cursor,
  wireType: number,
  fieldNumber: number
): void {
  switch (wireType) {
    case 0:
      readVarint(bytes, cursor);
      return;
    case 1:
      cursor.offset += 8;
      break;
    case 2: {
      const length = readVarint(bytes, cursor);
      cursor.offset += length;
      break;
    }
    case 3:
      while (cursor.offset < bytes.length) {
        const tag = readVarint(bytes, cursor);
        const nestedFieldNumber = Math.floor(tag / 8);
        const nestedWireType = tag & 7;
        if (nestedWireType === 4) {
          if (nestedFieldNumber !== fieldNumber) {
            throw new TranscriptMirrorProtobufDecodeError("mismatched protobuf group");
          }
          return;
        }
        skipField(bytes, cursor, nestedWireType, nestedFieldNumber);
      }
      throw new TranscriptMirrorProtobufDecodeError("unterminated protobuf group");
    case 4:
      throw new TranscriptMirrorProtobufDecodeError("unexpected protobuf end group");
    case 5:
      cursor.offset += 4;
      break;
    default:
      throw new TranscriptMirrorProtobufDecodeError("invalid protobuf wire type");
  }
  if (cursor.offset > bytes.length) {
    throw new TranscriptMirrorProtobufDecodeError("truncated protobuf field");
  }
}

function decodeRepeatedBytesFields(
  bytes: Uint8Array,
  targetFields: ReadonlySet<number>
): ReadonlyMap<number, readonly Uint8Array[]> {
  const cursor = { offset: 0 };
  const values = new Map<number, Uint8Array[]>();
  for (const field of targetFields) values.set(field, []);

  while (cursor.offset < bytes.length) {
    const tag = readVarint(bytes, cursor);
    const fieldNumber = Math.floor(tag / 8);
    const wireType = tag & 7;
    if (fieldNumber === 0) {
      throw new TranscriptMirrorProtobufDecodeError("invalid protobuf field number");
    }
    if (wireType === 2 && targetFields.has(fieldNumber)) {
      values.get(fieldNumber)?.push(readBytes(bytes, cursor));
      continue;
    }
    skipField(bytes, cursor, wireType, fieldNumber);
  }
  return values;
}

/**
 * Decodes exactly the repeated byte-reference fields shared by the shipped
 * journal and LegacyFileTranscriptMirror. Field numbers come from agent.v1's
 * emitted ConversationStateStructure schema.
 */
export function decodeTranscriptMirrorConversationState(
  bytes: Uint8Array
): TranscriptMirrorConversationState {
  const fields = decodeRepeatedBytesFields(bytes, new Set([1, 8, 13]));
  return {
    rootPromptMessagesJson: fields.get(1) ?? [],
    turns: fields.get(8) ?? [],
    summaryArchives: fields.get(13) ?? []
  };
}

/** Decodes ConversationSummaryArchive.summarized_messages (field 1). */
export function decodeSummaryArchiveMessageIds(
  bytes: Uint8Array
): readonly Uint8Array[] {
  return decodeRepeatedBytesFields(bytes, new Set([1])).get(1) ?? [];
}
