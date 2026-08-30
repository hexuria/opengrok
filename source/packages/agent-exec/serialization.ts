import { ExecClientMessage, ExecServerMessage } from "../proto/generated/agent/v1/exec_pb.js";

export type Serializer<T, Message> = (id: number, value: T) => Message;
export type Deserializer<T, Message> = (message: Message) => { id: number; args: T } | undefined;

type ExecServerMessageArm = Exclude<ExecServerMessage["message"], { case: undefined }>;
type ExecServerMessageCase = ExecServerMessageArm["case"];
type ExecServerMessageValue<Case extends ExecServerMessageCase> = Extract<ExecServerMessageArm, { case: Case }>["value"];

type ExecClientMessageArm = Exclude<ExecClientMessage["message"], { case: undefined }>;
type ExecClientMessageCase = ExecClientMessageArm["case"];
type ExecClientMessageValue<Case extends ExecClientMessageCase> = Extract<ExecClientMessageArm, { case: Case }>["value"];

export function createServerSerializer<Case extends ExecServerMessageCase>(argsKey: Case): Serializer<ExecServerMessageValue<Case>, ExecServerMessage> {
  function serialize(id: number, args: ExecServerMessageValue<Case>): ExecServerMessage {
    return new ExecServerMessage({
      id,
      message: { case: argsKey, value: args } as ExecServerMessageArm,
    });
  }
  return serialize;
}

export function createClientDeserializer<Case extends ExecClientMessageCase>(resultKey: Case): (message: ExecClientMessage) => ExecClientMessageValue<Case> | undefined {
  return (result) => {
    if (result.message.case !== resultKey) {
      return undefined;
    }
    return result.message.value as ExecClientMessageValue<Case>;
  };
}

export function createClientSerializer<Case extends ExecClientMessageCase>(resultKey: Case): Serializer<ExecClientMessageValue<Case>, ExecClientMessage> {
  function serialize(id: number, result: ExecClientMessageValue<Case>): ExecClientMessage {
    const message = {
      case: resultKey,
      value: result,
    } as ExecClientMessageArm;
    return new ExecClientMessage({
      id,
      message,
    });
  }
  return serialize;
}

export function createServerDeserializer<Case extends ExecServerMessageCase>(argsKey: Case): Deserializer<ExecServerMessageValue<Case>, ExecServerMessage> {
  function deserialize(result: ExecServerMessage): { id: number; args: ExecServerMessageValue<Case> } | undefined {
    if (result.message.case !== argsKey) {
      return undefined;
    }
    return { id: result.id, args: result.message.value as ExecServerMessageValue<Case> };
  }
  return deserialize;
}
