import { DataClassification, type PrivacyCapability } from "./classification.js";
import { createRedactedString } from "./factory.js";
import { toPrivacyContext, type PrivacyContext } from "./privacy-context.js";
import type { PrivacyMode } from "./privacy-mode.js";
import { getRedactionAwareDisplayValue } from "./shouldRedact.js";
import { isRedactedString, RedactedString, type RedactedUnwrapOptions } from "./types.js";

type ProviderOptions = unknown;
type LooseObject = Record<string, unknown>;

export interface CoreMessageLike extends LooseObject {
  readonly role: string;
  readonly content: unknown;
  readonly providerOptions?: ProviderOptions;
  readonly id?: unknown;
}

interface ContentPart extends LooseObject {
  readonly type: string;
}

interface RedactedCoreMessageLike extends LooseObject {
  readonly _privacyMode: PrivacyMode;
  readonly role: string;
  readonly content: unknown;
  readonly providerOptions?: ProviderOptions;
  readonly id?: unknown;
}

class RedactedTextPart {
  readonly text: RedactedString;
  readonly providerOptions: ProviderOptions;
  readonly type: "text";

  constructor(text: RedactedString, providerOptions: ProviderOptions) {
    this.text = text;
    this.providerOptions = providerOptions;
    this.type = "text";
  }

  toString(): string { return String(this.text); }
}

class RedactedImagePart {
  readonly image: unknown;
  readonly mimeType: unknown;
  readonly providerOptions: ProviderOptions;
  readonly type: "image";
  readonly __privacyContext: PrivacyContext;

  constructor(image: unknown, mimeType: unknown, providerOptions: ProviderOptions, modeOrContext: PrivacyMode | PrivacyContext) {
    this.image = image;
    this.mimeType = mimeType;
    this.providerOptions = providerOptions;
    this.type = "image";
    this.__privacyContext = modeOrContext ? toPrivacyContext(modeOrContext) : { privacyMode: 0 };
  }

  toString(): string {
    const unredactedValue = typeof this.image === "string"
      ? this.image
      : (this.image as { toString(): string }).toString();
    return getRedactionAwareDisplayValue({
      privacyMode: this.__privacyContext.privacyMode,
      classification: DataClassification.CODE,
      fieldName: "image",
      unredactedValue,
      enforceRedaction: this.__privacyContext.enforceRedaction,
    });
  }

  toJSON(): string { return this.toString(); }
}

class RedactedFilePart {
  readonly data: unknown;
  readonly mimeType: unknown;
  readonly providerOptions: ProviderOptions;
  readonly type: "file";
  readonly __privacyContext: PrivacyContext;

  constructor(data: unknown, mimeType: unknown, providerOptions: ProviderOptions, modeOrContext: PrivacyMode | PrivacyContext) {
    this.data = data;
    this.mimeType = mimeType;
    this.providerOptions = providerOptions;
    this.type = "file";
    this.__privacyContext = modeOrContext ? toPrivacyContext(modeOrContext) : { privacyMode: 0 };
  }

  toString(): string {
    const unredactedValue = typeof this.data === "string"
      ? this.data
      : (this.data as { toString(): string }).toString();
    return getRedactionAwareDisplayValue({
      privacyMode: this.__privacyContext.privacyMode,
      classification: DataClassification.CODE,
      fieldName: "file",
      unredactedValue,
      enforceRedaction: this.__privacyContext.enforceRedaction,
    });
  }

  toJSON(): string { return this.toString(); }
}

class RedactedToolCallPart {
  readonly type: "tool-call";
  readonly toolCallId: unknown;
  readonly toolName: unknown;
  readonly args: RedactedString;
  readonly providerOptions: ProviderOptions;

  constructor(params: { toolCallId: unknown; toolName: unknown; args: RedactedString; providerOptions: ProviderOptions }) {
    this.type = "tool-call";
    this.toolCallId = params.toolCallId;
    this.toolName = params.toolName;
    this.args = params.args;
    this.providerOptions = params.providerOptions;
  }

  toString(): string { return String(this.args); }
}

class RedactedUnknownPart {
  readonly originalType: string;
  readonly data: RedactedString;
  readonly type: "unknown";

  constructor(originalType: string, data: RedactedString) {
    this.originalType = originalType;
    this.data = data;
    this.type = "unknown";
  }

  toString(): string { return String(this.data); }
}

interface ExperimentalContentItem extends LooseObject {
  readonly type: string;
}

class RedactedToolResultPart {
  readonly type: "tool-result";
  readonly toolCallId: unknown;
  readonly toolName: unknown;
  readonly result: RedactedString;
  readonly isError: unknown;
  readonly providerOptions: ProviderOptions;
  readonly experimental_content: readonly ExperimentalContentItem[] | undefined;

  constructor(params: {
    toolCallId: unknown;
    toolName: unknown;
    result: RedactedString;
    isError: unknown;
    providerOptions: ProviderOptions;
    experimental_content: readonly ExperimentalContentItem[] | undefined;
  }) {
    this.type = "tool-result";
    this.toolCallId = params.toolCallId;
    this.toolName = params.toolName;
    this.result = params.result;
    this.isError = params.isError;
    this.providerOptions = params.providerOptions;
    this.experimental_content = params.experimental_content;
  }

  toString(): string { return String(this.result); }
}

const DEFAULT_MEMO_CONFIG = { messageIdentity: true, contentIdentity: true };
const memoConfig = Object.assign({}, DEFAULT_MEMO_CONFIG);

interface CoreMessageCaches {
  readonly message: WeakMap<object, RedactedCoreMessageLike>;
  readonly userContent: WeakMap<object, readonly unknown[]>;
  readonly assistantContent: WeakMap<object, readonly unknown[]>;
  readonly toolContent: WeakMap<object, readonly unknown[]>;
}

const coreMessageCachesByContext = new Map<string, CoreMessageCaches>();

function cacheKey(context: PrivacyContext): string {
  return `${context.privacyMode}:${context.enforceRedaction ?? "gate"}`;
}

function getCoreMessageCaches(context: PrivacyContext): CoreMessageCaches {
  const key = cacheKey(context);
  const existing = coreMessageCachesByContext.get(key);
  if (existing !== undefined) return existing;
  const created: CoreMessageCaches = {
    message: new WeakMap(),
    userContent: new WeakMap(),
    assistantContent: new WeakMap(),
    toolContent: new WeakMap(),
  };
  coreMessageCachesByContext.set(key, created);
  return created;
}

function memoize<T>(enabled: boolean, cache: WeakMap<object, T>, key: object, build: () => T): T {
  if (!enabled) return build();
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const value = build();
  cache.set(key, value);
  return value;
}

export function toRedactedCoreMessage(
  message: CoreMessageLike,
  modeOrContext: PrivacyMode | PrivacyContext,
): RedactedCoreMessageLike {
  const context = toPrivacyContext(modeOrContext);
  const caches = getCoreMessageCaches(context);
  if (memoConfig.messageIdentity) {
    const cached = caches.message.get(message);
    if (cached !== undefined) return cached;
  }
  const role = message.role;
  let result: RedactedCoreMessageLike;
  switch (role) {
    case "user": result = toRedactedUserMessage(message, context, caches); break;
    case "assistant": result = toRedactedAssistantMessage(message, context, caches); break;
    case "tool": result = toRedactedToolMessage(message, context, caches); break;
    case "system": result = toRedactedSystemMessage(message, context); break;
    default: throw new Error(`Unhandled CoreMessage role: ${role}`);
  }
  if (memoConfig.messageIdentity) caches.message.set(message, result);
  return result;
}

export function fromRedactedCoreMessage(
  message: RedactedCoreMessageLike,
  purpose: PrivacyCapability,
  options?: RedactedUnwrapOptions,
): CoreMessageLike {
  const role = message.role;
  switch (role) {
    case "user": return fromRedactedUserMessage(message, purpose, options);
    case "assistant": return fromRedactedAssistantMessage(message, purpose, options);
    case "tool": return fromRedactedToolMessage(message, purpose, options);
    case "system": return fromRedactedSystemMessage(message, purpose, options);
    default: throw new Error(`Unhandled RedactedCoreMessage role: ${role}`);
  }
}

export function toRedactedCoreMessages(
  messages: readonly CoreMessageLike[],
  modeOrContext: PrivacyMode | PrivacyContext,
): RedactedCoreMessageLike[] {
  return messages.map(message => toRedactedCoreMessage(message, modeOrContext));
}

export function fromRedactedCoreMessages(
  messages: readonly RedactedCoreMessageLike[],
  purpose: PrivacyCapability,
  options?: RedactedUnwrapOptions,
): CoreMessageLike[] {
  return messages.map(message => fromRedactedCoreMessage(message, purpose, options));
}

function toRedactedUserContentPart(part: ContentPart, context: PrivacyContext): unknown {
  const partType = part.type;
  switch (partType) {
    case "text": return new RedactedTextPart(createRedactedString(part.text as string, DataClassification.CODE, "user_text", context), part.providerOptions);
    case "image": return new RedactedImagePart(part.image, part.mimeType, part.providerOptions, context);
    case "file": return new RedactedFilePart(part.data, part.mimeType, part.providerOptions, context);
    default: throw new Error(`Unhandled user content part type: ${partType}`);
  }
}

function toRedactedAssistantContentPart(part: ContentPart, context: PrivacyContext): unknown {
  const partType = part.type;
  switch (partType) {
    case "text":
      return new RedactedTextPart(createRedactedString(part.text as string, DataClassification.CODE, "assistant_text", context), part.providerOptions);
    case "tool-call":
      return new RedactedToolCallPart({
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        args: createRedactedString(JSON.stringify(part.args) as string, DataClassification.CODE, "tool_call_args", context),
        providerOptions: part.providerOptions,
      });
    default:
      return new RedactedUnknownPart(
        partType,
        createRedactedString(JSON.stringify(part) as string, DataClassification.CODE, `assistant_${partType}`, context),
      );
  }
}

function toRedactedUserMessage(message: CoreMessageLike, context: PrivacyContext, caches: CoreMessageCaches): RedactedCoreMessageLike {
  if (typeof message.content === "string") {
    return {
      _privacyMode: context.privacyMode,
      role: "user",
      content: createRedactedString(message.content, DataClassification.CODE, "user_content", context),
      providerOptions: message.providerOptions,
    };
  }
  const content = message.content as readonly ContentPart[];
  const redactedContent = memoize(
    memoConfig.contentIdentity,
    caches.userContent,
    content,
    () => content.map(part => toRedactedUserContentPart(part, context)),
  );
  return { _privacyMode: context.privacyMode, role: "user", content: redactedContent, providerOptions: message.providerOptions };
}

function toRedactedAssistantMessage(message: CoreMessageLike, context: PrivacyContext, caches: CoreMessageCaches): RedactedCoreMessageLike {
  if (typeof message.content === "string") {
    return Object.assign(
      Object.assign(
        { _privacyMode: context.privacyMode, role: "assistant", content: createRedactedString(message.content, DataClassification.CODE, "assistant_content", context) },
        message.id !== undefined && { id: message.id },
      ),
      message.providerOptions !== undefined && { providerOptions: message.providerOptions },
    ) as RedactedCoreMessageLike;
  }
  const content = message.content as readonly ContentPart[];
  const redactedContent = memoize(
    memoConfig.contentIdentity,
    caches.assistantContent,
    content,
    () => content.map(part => toRedactedAssistantContentPart(part, context)),
  );
  return Object.assign(
    Object.assign({ _privacyMode: context.privacyMode, role: "assistant", content: redactedContent }, message.id !== undefined && { id: message.id }),
    message.providerOptions !== undefined && { providerOptions: message.providerOptions },
  ) as RedactedCoreMessageLike;
}

function toRedactedToolResultPart(part: ContentPart, context: PrivacyContext): RedactedToolResultPart {
  const resultString = typeof part.result === "string" ? part.result : JSON.stringify(part.result) as string;
  const experimentalContent = part.experimental_content as readonly ExperimentalContentItem[] | undefined;
  const redactedExperimentalContent = experimentalContent?.map(item => {
    if (item.type === "text" && typeof item.text === "string") {
      return { type: "text", text: createRedactedString(item.text, DataClassification.CODE, "experimental_content_text", context) };
    }
    return item;
  });
  return new RedactedToolResultPart({
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    result: createRedactedString(resultString, DataClassification.CODE, "tool_result", context),
    isError: part.isError,
    providerOptions: part.providerOptions,
    experimental_content: redactedExperimentalContent,
  });
}

function toRedactedToolMessage(message: CoreMessageLike, context: PrivacyContext, caches: CoreMessageCaches): RedactedCoreMessageLike {
  const content = message.content as readonly ContentPart[];
  const redactedContent = memoize(
    memoConfig.contentIdentity,
    caches.toolContent,
    content,
    () => content.map(part => toRedactedToolResultPart(part, context)),
  );
  return Object.assign(
    Object.assign({ _privacyMode: context.privacyMode, role: "tool", content: redactedContent }, message.id !== undefined && { id: message.id }),
    message.providerOptions !== undefined && { providerOptions: message.providerOptions },
  ) as RedactedCoreMessageLike;
}

function toRedactedSystemMessage(message: CoreMessageLike, context: PrivacyContext): RedactedCoreMessageLike {
  return {
    _privacyMode: context.privacyMode,
    role: "system",
    content: createRedactedString(message.content as string, DataClassification.CODE, "system_content", context),
    providerOptions: message.providerOptions,
  };
}

function fromRedactedUserContentPart(part: ContentPart, purpose: PrivacyCapability, options?: RedactedUnwrapOptions): LooseObject {
  const partType = part.type;
  switch (partType) {
    case "text": return { type: "text", text: (part.text as RedactedString).unwrap(purpose, options), providerOptions: part.providerOptions };
    case "image": return { type: "image", image: part.image, mimeType: part.mimeType, providerOptions: part.providerOptions };
    case "file": return { type: "file", data: part.data, mimeType: part.mimeType, providerOptions: part.providerOptions };
    default: throw new Error(`Unhandled redacted user content part type: ${partType}`);
  }
}

function fromRedactedAssistantContentPart(part: ContentPart, purpose: PrivacyCapability, options?: RedactedUnwrapOptions): unknown {
  const partType = part.type;
  switch (partType) {
    case "text":
      return Object.assign(
        { type: "text", text: (part.text as RedactedString).unwrap(purpose, options) },
        part.providerOptions !== undefined && { providerOptions: part.providerOptions },
      );
    case "tool-call": {
      const argsString = (part.args as RedactedString).unwrap(purpose, options);
      let args: unknown;
      try { args = JSON.parse(argsString); } catch { args = argsString; }
      return Object.assign(
        { type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, args },
        part.providerOptions !== undefined && { providerOptions: part.providerOptions },
      );
    }
    case "unknown": {
      const dataString = (part.data as RedactedString).unwrap(purpose, options);
      try { return JSON.parse(dataString); } catch { return dataString; }
    }
    default: throw new Error(`Unhandled redacted assistant content part type: ${partType}`);
  }
}

function fromRedactedUserMessage(message: RedactedCoreMessageLike, purpose: PrivacyCapability, options?: RedactedUnwrapOptions): CoreMessageLike {
  if (isRedactedString(message.content)) {
    return { role: "user", content: message.content.unwrap(purpose, options), providerOptions: message.providerOptions };
  }
  const content = (message.content as readonly ContentPart[]).map(part => fromRedactedUserContentPart(part, purpose, options));
  return { role: "user", content, providerOptions: message.providerOptions };
}

function fromRedactedAssistantMessage(message: RedactedCoreMessageLike, purpose: PrivacyCapability, options?: RedactedUnwrapOptions): CoreMessageLike {
  if (isRedactedString(message.content)) {
    return Object.assign(
      Object.assign({ role: "assistant", content: message.content.unwrap(purpose, options) }, message.id !== undefined && { id: message.id }),
      message.providerOptions !== undefined && { providerOptions: message.providerOptions },
    ) as CoreMessageLike;
  }
  const content = (message.content as readonly ContentPart[]).map(part => fromRedactedAssistantContentPart(part, purpose, options));
  return Object.assign(
    Object.assign({ role: "assistant", content }, message.id !== undefined && { id: message.id }),
    message.providerOptions !== undefined && { providerOptions: message.providerOptions },
  ) as CoreMessageLike;
}

function fromRedactedToolMessage(message: RedactedCoreMessageLike, purpose: PrivacyCapability, options?: RedactedUnwrapOptions): CoreMessageLike {
  const content = (message.content as readonly ContentPart[]).map(part => {
    const resultString = (part.result as RedactedString).unwrap(purpose, options);
    let result: unknown;
    try { result = JSON.parse(resultString); } catch { result = resultString; }
    const experimentalContent = part.experimental_content as readonly ExperimentalContentItem[] | undefined;
    const unwrappedExperimentalContent = experimentalContent?.map(item => {
      if (item.type === "text" && isRedactedString(item.text)) {
        return { type: "text", text: item.text.unwrap(purpose, options) };
      }
      return item;
    });
    return Object.assign(
      Object.assign(
        Object.assign(
          { type: "tool-result", toolCallId: part.toolCallId, toolName: part.toolName, result },
          part.isError !== undefined && { isError: part.isError },
        ),
        part.providerOptions !== undefined && { providerOptions: part.providerOptions },
      ),
      unwrappedExperimentalContent !== undefined && { experimental_content: unwrappedExperimentalContent },
    );
  });
  return Object.assign(
    Object.assign({ role: "tool", content }, message.id !== undefined && { id: message.id }),
    message.providerOptions !== undefined && { providerOptions: message.providerOptions },
  ) as CoreMessageLike;
}

function fromRedactedSystemMessage(message: RedactedCoreMessageLike, purpose: PrivacyCapability, options?: RedactedUnwrapOptions): CoreMessageLike {
  return {
    role: "system",
    content: (message.content as RedactedString).unwrap(purpose, options),
    providerOptions: message.providerOptions,
  };
}
