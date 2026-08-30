import { Struct, Value, type JsonValue } from "@bufbuild/protobuf";
import {
  InferenceAgentTool,
  InferenceAnthropicOptions,
  InferenceCacheControl,
  InferenceContentPart,
  InferenceContentParts,
  InferenceCoreMessage,
  InferenceCursorOptions,
  InferenceCustomToolFormat,
  InferenceImagePart,
  InferenceMessageRole,
  InferenceModelConfig,
  InferenceModelParameterValue,
  InferenceNamedProviderDefinedTool,
  InferenceProviderOptions,
  type InferenceReason,
  InferenceReasoningPart,
  InferenceRequestedModel,
  InferenceStreamErrorType,
  InferenceStreamRequest,
  InferenceTextPart,
  InferenceToolCall,
  InferenceToolResultContent,
  InferenceToolResultPart,
  type InferenceStreamError,
} from "../proto/generated/aiserver/v1/inference_pb.js";
import { classifyTokenLimitErrorFromMessage } from "../chat-inference/token-limit-error-classification.js";
import { InputTokenLimitError, OutputTokensLimitExceededError } from "../chat-inference/prompt-executor.js";
import { getCursorModelName } from "./cursorModelProviderOptions.js";

type Loose = Record<string, any>;
const DEFAULT_IMAGE_MIME_TYPE = "image/png";
const EMPTY_JSON_OBJECT: Record<string, JsonValue> = {};

export function jsonObjectForProtobufStruct(value: unknown): Record<string, JsonValue> {
  const unwrapped = value != null && typeof value === "object" && !Array.isArray(value)
    && (value as { jsonSchema?: unknown }).jsonSchema != null
    && typeof (value as { jsonSchema?: unknown }).jsonSchema === "object"
    && !Array.isArray((value as { jsonSchema?: unknown }).jsonSchema)
    ? (value as { jsonSchema: unknown }).jsonSchema
    : value;
  if (unwrapped == null || typeof unwrapped !== "object" || Array.isArray(unwrapped)) return EMPTY_JSON_OBJECT;
  try {
    const cloned = JSON.parse(JSON.stringify(unwrapped)) as unknown;
    return cloned != null && typeof cloned === "object" && !Array.isArray(cloned)
      ? cloned as Record<string, JsonValue>
      : EMPTY_JSON_OBJECT;
  } catch {
    return EMPTY_JSON_OBJECT;
  }
}

export function applyToolCallArgs(toolCall: InferenceToolCall, args: unknown, explicitRawToolCallArgs?: string): void {
  const isJsonObject = typeof args === "object" && args !== null && !Array.isArray(args);
  if (isJsonObject) {
    toolCall.args = Struct.fromJson(jsonObjectForProtobufStruct(args));
    if (explicitRawToolCallArgs !== undefined) toolCall.rawToolCallArgs = explicitRawToolCallArgs;
    return;
  }
  const rawText = typeof args === "string" ? args : JSON.stringify(args);
  if (rawText === undefined) throw new Error(`cannot represent tool call arguments of type ${typeof args} as a JSON object or raw text`);
  toolCall.rawToolCallArgs = explicitRawToolCallArgs ?? rawText;
}

export function toolCallArgsFromProto(toolCall: InferenceToolCall): unknown {
  return toolCall.args?.toJson() ?? toolCall.rawToolCallArgs ?? {};
}

function roleToProto(role: unknown): InferenceMessageRole {
  switch (role) {
    case "user": return InferenceMessageRole.USER;
    case "assistant": return InferenceMessageRole.ASSISTANT;
    case "tool": return InferenceMessageRole.TOOL;
    case "system": return InferenceMessageRole.SYSTEM;
    default: return InferenceMessageRole.UNSPECIFIED;
  }
}

function cursorOptionsToProto(cursor: unknown): InferenceCursorOptions | undefined {
  if (!cursor || typeof cursor !== "object") return undefined;
  const options = cursor as Loose;
  const proto = new InferenceCursorOptions();
  let populated = false;
  if (typeof options.imageDescription === "string" && options.imageDescription.length > 0) {
    proto.imageDescription = options.imageDescription;
    populated = true;
  }
  if (options.imageDescriptions !== null && typeof options.imageDescriptions === "object") {
    for (const [key, value] of Object.entries(options.imageDescriptions as Loose)) {
      const index = Number(key);
      if (Number.isInteger(index) && index >= 0 && typeof value === "string" && value.length > 0) {
        proto.imageDescriptions[index] = value;
        populated = true;
      }
    }
  }
  return populated ? proto : undefined;
}

function providerOptionsToProto(options: unknown): InferenceProviderOptions | undefined {
  if (!options || typeof options !== "object") return undefined;
  const values = options as Loose;
  const proto = new InferenceProviderOptions();
  let populated = false;
  if (values.anthropic?.cacheControl) {
    proto.anthropic = new InferenceAnthropicOptions({
      cacheControl: new InferenceCacheControl({ type: values.anthropic.cacheControl.type }),
    });
    populated = true;
  }
  const cursor = cursorOptionsToProto(values.cursor);
  if (cursor !== undefined) {
    proto.cursor = cursor;
    populated = true;
  }
  return populated ? proto : undefined;
}

function imageBytesToDataUrl(bytes: Uint8Array, mimeType: unknown): string {
  const mime = typeof mimeType === "string" && mimeType.trim() !== "" ? mimeType : DEFAULT_IMAGE_MIME_TYPE;
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

function userContentPartToProto(part: Loose): InferenceContentPart {
  const proto = new InferenceContentPart();
  if (part.type === "text") {
    const providerOptions = providerOptionsToProto(part.providerOptions);
    proto.part = { case: "text", value: new InferenceTextPart({ text: part.text, ...(providerOptions === undefined ? {} : { providerOptions }) }) };
  } else if (part.type === "image") {
    let data = "";
    if (typeof part.image === "string") data = part.image;
    else if (part.image instanceof URL) data = part.image.toString();
    else if (part.image instanceof Uint8Array) data = imageBytesToDataUrl(part.image, part.mimeType);
    else if (part.image instanceof ArrayBuffer) data = imageBytesToDataUrl(new Uint8Array(part.image), part.mimeType);
    const providerOptions = providerOptionsToProto(part.providerOptions);
    proto.part = { case: "image", value: new InferenceImagePart({ data, mimeType: part.mimeType, ...(providerOptions === undefined ? {} : { providerOptions }) }) };
  } else if (part.type === "file") {
    proto.part = { case: "text", value: new InferenceTextPart({ text: `[File: ${part.name ?? "unnamed"}]` }) };
  } else {
    proto.part = { case: "text", value: new InferenceTextPart({ text: "" }) };
  }
  return proto;
}

function toolResultExperimentalContentToProto(content: readonly Loose[]): InferenceContentPart[] {
  return content.map((item) => new InferenceContentPart({
    part: item.type === "image"
      ? { case: "image", value: new InferenceImagePart({ data: item.data, mimeType: item.mimeType }) }
      : { case: "text", value: new InferenceTextPart({ text: item.text }) },
  }));
}

export function coreMessageToProto(message: Loose): InferenceCoreMessage {
  const proto = new InferenceCoreMessage({ role: roleToProto(message.role) });
  if (message.role === "user") {
    if (typeof message.content === "string") proto.content = { case: "text", value: message.content };
    else if (Array.isArray(message.content)) proto.content = { case: "parts", value: new InferenceContentParts({ parts: message.content.map(userContentPartToProto) }) };
  } else if (message.role === "assistant") {
    const responsesMetadata = getResponsesMetadataFromProviderOptions(message);
    if (responsesMetadata.modelProviderMessageId !== undefined) proto.modelProviderMessageId = responsesMetadata.modelProviderMessageId;
    if (typeof responsesMetadata.openaiPhase === "string") proto.openaiPhase = responsesMetadata.openaiPhase;
    else if (responsesMetadata.openaiPhase === null) proto.openaiPhaseNull = true;
    if (typeof message.content === "string") proto.content = { case: "text", value: message.content };
    else if (Array.isArray(message.content)) {
      const text: string[] = [];
      for (const part of message.content as Loose[]) {
        if (part.type === "text") text.push(part.text);
        else if (part.type === "tool-call") {
          const call = new InferenceToolCall({ toolCallId: part.toolCallId, toolName: part.toolName });
          const raw = part.providerOptions?.cursor?.rawToolCallArgs;
          applyToolCallArgs(call, part.args, typeof raw === "string" ? raw : undefined);
          proto.toolCalls.push(call);
        } else if (part.type === "reasoning") {
          const modelName = getCursorModelName(part);
          proto.reasoningParts.push(new InferenceReasoningPart({ isRedacted: false, text: part.text, signature: part.signature, ...(modelName === undefined ? {} : { modelName }) }));
        } else if (part.type === "redacted-reasoning") {
          const modelName = getCursorModelName(part);
          proto.reasoningParts.push(new InferenceReasoningPart({ isRedacted: true, redactedData: part.data, ...(modelName === undefined ? {} : { modelName }) }));
        }
      }
      if (text.length > 0) proto.content = { case: "text", value: text.join("") };
    }
  } else if (message.role === "tool" && Array.isArray(message.content)) {
    const parts = (message.content as Loose[]).filter((part) => part.type === "tool-result").map((part) => {
      const result = new InferenceToolResultPart({ toolCallId: part.toolCallId, toolName: part.toolName });
      if (part.result !== undefined) result.result = Value.fromJson(typeof part.result === "string" ? part.result : JSON.parse(JSON.stringify(part.result)) as JsonValue);
      if (part.isError) result.isError = true;
      if (part.experimental_content?.length > 0) result.experimentalContent = toolResultExperimentalContentToProto(part.experimental_content);
      result.providerOptions = providerOptionsToProto(part.providerOptions)!;
      return result;
    });
    proto.content = { case: "toolContent", value: new InferenceToolResultContent({ parts }) };
  } else if (message.role === "system") {
    proto.content = { case: "text", value: message.content };
  }
  return proto;
}

function getResponsesMetadataFromProviderOptions(message: Loose): { modelProviderMessageId?: string; openaiPhase?: string | null } {
  const cursorOptions = message.providerOptions?.cursor;
  const modelProviderMessageId = cursorOptions?.modelProviderMessageId;
  const openaiPhase = cursorOptions?.openaiPhase;
  return {
    ...(typeof modelProviderMessageId === "string" ? { modelProviderMessageId } : {}),
    ...(typeof openaiPhase === "string" || openaiPhase === null ? { openaiPhase } : {}),
  };
}

function agentToolToProto(tool: Loose): InferenceAgentTool {
  const proto = new InferenceAgentTool({
    name: tool.name,
    description: typeof tool.description === "string" ? tool.description : "",
    parameters: Struct.fromJson(jsonObjectForProtobufStruct(tool.inputSchema ?? tool.parameters)),
  });
  if (tool.customToolFormat) proto.customToolFormat = new InferenceCustomToolFormat(tool.customToolFormat);
  return proto;
}

function namedProviderDefinedToolToProto(tool: Loose): InferenceNamedProviderDefinedTool {
  const options = tool.options ? Struct.fromJson(tool.options as JsonValue) : undefined;
  return new InferenceNamedProviderDefinedTool({
    name: tool.name,
    id: tool.id,
    type: tool.type,
    ...(options === undefined ? {} : { options }),
  });
}

export function protoStreamErrorToError(error: InferenceStreamError): Error {
  if (error.errorType === InferenceStreamErrorType.INPUT_TOKEN_LIMIT || error.isInputTokenLimitError) return new InputTokenLimitError(error.message);
  if (error.errorType === InferenceStreamErrorType.OUTPUT_TOKEN_LIMIT || error.isOutputTokenLimitError) return new OutputTokensLimitExceededError(error.message);
  return classifyTokenLimitErrorFromMessage(error.message) ?? new Error(error.message);
}

export interface StreamRequestOptions {
  messages: readonly Loose[];
  requestedModel: Loose;
  tools?: readonly Loose[];
  providerDefinedTools?: readonly Loose[];
  modelConfig?: Loose | undefined;
  invocationId?: string | undefined;
  conversationId?: string | undefined;
  automationId?: string | undefined;
  inferenceReason?: InferenceReason | undefined;
  acceptedUnadvertisedToolNames?: readonly string[] | undefined;
}

export function buildStreamRequest(options: StreamRequestOptions): InferenceStreamRequest {
  const request = new InferenceStreamRequest({
    messages: options.messages.map(coreMessageToProto),
    tools: (options.tools ?? []).map(agentToolToProto),
    providerDefinedTools: (options.providerDefinedTools ?? []).map(namedProviderDefinedToolToProto),
    acceptedUnadvertisedToolNames: [...(options.acceptedUnadvertisedToolNames ?? [])],
    requestedModel: new InferenceRequestedModel({
      modelId: options.requestedModel.modelId,
      maxMode: options.requestedModel.maxMode,
      parameters: (options.requestedModel.parameters ?? []).map((parameter: Loose) => new InferenceModelParameterValue({ id: parameter.id, value: parameter.value })),
      builtInModel: options.requestedModel.builtInModel,
      isVariantStringRepresentation: options.requestedModel.isVariantStringRepresentation,
    }),
  });
  if (options.invocationId) request.invocationId = options.invocationId;
  if (options.conversationId) request.conversationId = options.conversationId;
  if (options.automationId) request.automationId = options.automationId;
  if (options.inferenceReason) request.inferenceReason = options.inferenceReason;
  if (options.modelConfig) request.modelConfig = new InferenceModelConfig({
    maxTokens: options.modelConfig.maxTokens,
    temperature: options.modelConfig.temperature,
    topP: options.modelConfig.topP,
    stopSequences: options.modelConfig.stopSequences ?? [],
  });
  return request;
}
