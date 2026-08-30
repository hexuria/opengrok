import {
  allowedPurpose,
  DataClassification,
  type PrivacyCapability,
} from "./classification.js";
import {
  resolveEnforceRedaction,
  toPrivacyContext,
  type PrivacyContext,
} from "./privacy-context.js";
import { type PrivacyMode as PrivacyModeValue, PrivacyMode } from "./privacy-mode.js";
import { formatRedacted, getRedactionAwareDisplayValue, shouldRedact } from "./shouldRedact.js";

const IS_DEV =
  typeof process !== "undefined" &&
  process.env.NODE_ENV === "development" &&
  process.env.VITEST !== "true";

function stringAtIndex(value: string, index: number): string | undefined {
  const normalizedIndex = index < 0 ? value.length + index : index;
  if (normalizedIndex < 0 || normalizedIndex >= value.length) return undefined;
  return value[normalizedIndex];
}

const REDACTION_LOG_MESSAGES = {
  UNSPECIFIED_FIELD: "[PRIVACY REDACTION] unwrapping UNSPECIFIED field — classify this field",
  UNSPECIFIED_PRIVACY_MODE: "[PRIVACY REDACTION] unwrapping with PrivacyMode.UNSPECIFIED — resolve privacy mode",
  LOGGER_NOT_INITIALIZED: "[PRIVACY REDACTION] logger not initialized — call setRedactionLogger() at process startup",
  ENFORCEMENT_SKIPPED: "[PRIVACY REDACTION] would have been redacted but enforceRedaction is false",
  LOGGING_ERROR: "[PRIVACY REDACTION] error logging violation",
  IMPLICIT_SERIALIZATION: "[PRIVACY REDACTION] implicit serialization of would-be-redacted field",
  IMPLICIT_SERIALIZATION_DEV: "[PRIVACY REDACTION] ERROR: Redaction via implicit serialization caught in test, please call unwrap() explicitly",
};

interface RedactionLogger {
  info(attributes: Record<string, unknown>, message: string): void;
}

interface RedactionInfo {
  readonly fieldName: string;
  readonly classification: DataClassification;
  readonly privacyMode: PrivacyModeValue;
}

let logger: RedactionLogger | undefined;

function logUnspecifiedWarnings(info: RedactionInfo): void {
  if (info.classification === DataClassification.UNSPECIFIED) {
    try {
      logger?.info({
        redaction_field_name: info.fieldName,
        redaction_classification: info.classification,
      }, REDACTION_LOG_MESSAGES.UNSPECIFIED_FIELD);
    } catch (error) {
      console.error(REDACTION_LOG_MESSAGES.LOGGING_ERROR, error);
    }
  }
  if (info.privacyMode === PrivacyMode.UNSPECIFIED) {
    try {
      logger?.info({
        redaction_field_name: info.fieldName,
        redaction_classification: info.classification,
        redaction_privacy_mode: info.privacyMode,
      }, REDACTION_LOG_MESSAGES.UNSPECIFIED_PRIVACY_MODE);
    } catch (error) {
      console.error(REDACTION_LOG_MESSAGES.LOGGING_ERROR, error);
    }
  }
}

function logEnforcementSkipped(info: RedactionInfo): void {
  if (logger === undefined) {
    console.error(REDACTION_LOG_MESSAGES.LOGGER_NOT_INITIALIZED);
  } else {
    try {
      logger.info({
        redaction_field_name: info.fieldName,
        redaction_classification: info.classification,
        redaction_privacy_mode: info.privacyMode,
        redaction_enforcement_skipped: true,
      }, REDACTION_LOG_MESSAGES.ENFORCEMENT_SKIPPED);
    } catch (error) {
      console.error(REDACTION_LOG_MESSAGES.LOGGING_ERROR, error);
    }
  }
}

export interface RedactedUnwrapOptions {
  readonly enforcing?: boolean | undefined;
  readonly redactUnallowedFieldsInsteadOfThrowing?: boolean | undefined;
}

export class RedactedString {
  readonly __classification: DataClassification;
  readonly __fieldName: string;
  readonly __privacyMode: PrivacyModeValue;
  readonly __isRedacted: boolean;
  readonly #value: string;
  readonly #privacyContext: PrivacyContext;

  constructor(
    value: string,
    classification: DataClassification,
    fieldName: string,
    modeOrContext: PrivacyModeValue | PrivacyContext,
  ) {
    const context = toPrivacyContext(modeOrContext);
    this.#value = value;
    this.#privacyContext = context;
    this.__classification = classification;
    this.__fieldName = fieldName;
    this.__privacyMode = context.privacyMode;
    this.__isRedacted = shouldRedact(context.privacyMode, classification);
  }

  get length(): number { return this.#value.length; }
  get empty(): boolean { return this.#value.length === 0; }

  getPrivacyContext(): PrivacyContext {
    return this.#privacyContext.enforceRedaction !== undefined ? {
      privacyMode: this.#privacyContext.privacyMode,
      enforceRedaction: this.#privacyContext.enforceRedaction,
    } : { privacyMode: this.#privacyContext.privacyMode };
  }

  unwrap(purpose: PrivacyCapability, options?: RedactedUnwrapOptions): string {
    const info = {
      fieldName: this.__fieldName,
      classification: this.__classification,
      privacyMode: this.__privacyMode,
    };
    logUnspecifiedWarnings(info);
    if (allowedPurpose(this.__privacyMode, purpose, this.__classification)) return this.#value;
    const enforce = options?.enforcing ||
      resolveEnforceRedaction(this.#privacyContext, this.__classification);
    if (!enforce && !IS_DEV) logEnforcementSkipped(info);
    if (!enforce) return this.#value;
    if (options?.redactUnallowedFieldsInsteadOfThrowing) return formatRedacted(this.__fieldName);
    throw new Error(
      `Unwrap not allowed for purpose ${purpose} with classification ${this.__classification} and privacy mode ${this.__privacyMode}`,
    );
  }

  __clone(newValue: string): RedactedString {
    return new RedactedString(
      newValue,
      this.__classification,
      `${this.__fieldName}.clone`,
      this.#privacyContext,
    );
  }

  #rewrap(newValue: string): RedactedString {
    return new RedactedString(newValue, this.__classification, this.__fieldName, this.#privacyContext);
  }

  safeTransform(transform: (value: string) => string): RedactedString {
    return this.#rewrap(transform(this.#value));
  }

  #displayValue(): string {
    return getRedactionAwareDisplayValue({
      privacyMode: this.#privacyContext.privacyMode,
      classification: this.__classification,
      fieldName: this.__fieldName,
      unredactedValue: this.#value,
      enforceRedaction: this.#privacyContext.enforceRedaction,
    });
  }

  #logImplicitSerialization(serializationPath: string): void {
    if (!this.__isRedacted || resolveEnforceRedaction(this.#privacyContext, this.__classification)) return;
    if (IS_DEV) {
      throw new Error(
        `${REDACTION_LOG_MESSAGES.IMPLICIT_SERIALIZATION_DEV} (field=${this.__fieldName}, classification=${this.__classification}, path=${serializationPath})`,
      );
    }
    try {
      logger?.info({
        redaction_field_name: this.__fieldName,
        redaction_classification: this.__classification,
        redaction_privacy_mode: this.__privacyMode,
        redaction_serialization_path: serializationPath,
      }, REDACTION_LOG_MESSAGES.IMPLICIT_SERIALIZATION);
    } catch {}
  }

  toString(): string { this.#logImplicitSerialization("toString"); return this.#displayValue(); }
  toJSON(): string { this.#logImplicitSerialization("toJSON"); return this.#displayValue(); }
  valueOf(): string { this.#logImplicitSerialization("valueOf"); return this.#displayValue(); }
  [Symbol.toPrimitive](hint: string): string | number {
    if (hint === "string" || hint === "default") {
      this.#logImplicitSerialization("toPrimitive");
      return this.#displayValue();
    }
    return Number.NaN;
  }
  get [Symbol.toStringTag](): string { return "RedactedString"; }

  startsWith(searchString: string, position?: number): boolean { return this.#value.startsWith(searchString, position); }
  endsWith(searchString: string, endPosition?: number): boolean { return this.#value.endsWith(searchString, endPosition); }
  includes(searchString: string, position?: number): boolean { return this.#value.includes(searchString, position); }
  trim(): RedactedString { return this.#rewrap(this.#value.trim()); }
  trimStart(): RedactedString { return this.#rewrap(this.#value.trimStart()); }
  trimLeft(): RedactedString { return this.#rewrap(this.#value.trimStart()); }
  trimEnd(): RedactedString { return this.#rewrap(this.#value.trimEnd()); }
  trimRight(): RedactedString { return this.#rewrap(this.#value.trimEnd()); }
  slice(start?: number, end?: number): RedactedString { return this.#rewrap(this.#value.slice(start, end)); }
  substring(start: number, end?: number): RedactedString { return this.#rewrap(this.#value.substring(start, end)); }
  substr(start: number, length?: number): RedactedString { return this.#rewrap(this.#value.substr(start, length)); }
  toLowerCase(): RedactedString { return this.#rewrap(this.#value.toLowerCase()); }
  toUpperCase(): RedactedString { return this.#rewrap(this.#value.toUpperCase()); }
  toLocaleLowerCase(locales?: Intl.LocalesArgument): RedactedString { return this.#rewrap(this.#value.toLocaleLowerCase(locales)); }
  toLocaleUpperCase(locales?: Intl.LocalesArgument): RedactedString { return this.#rewrap(this.#value.toLocaleUpperCase(locales)); }
  replace(searchValue: string | RegExp, replaceValue: string): RedactedString { return this.#rewrap(this.#value.replace(searchValue, replaceValue)); }
  replaceAll(searchValue: string | RegExp, replaceValue: string): RedactedString { return this.#rewrap(this.#value.replaceAll(searchValue, replaceValue)); }
  padStart(maxLength: number, fillString?: string): RedactedString { return this.#rewrap(this.#value.padStart(maxLength, fillString)); }
  padEnd(maxLength: number, fillString?: string): RedactedString { return this.#rewrap(this.#value.padEnd(maxLength, fillString)); }
  repeat(count: number): RedactedString { return this.#rewrap(this.#value.repeat(count)); }
  normalize(form?: "NFC" | "NFD" | "NFKC" | "NFKD"): RedactedString { return this.#rewrap(this.#value.normalize(form)); }
  concat(...strings: string[]): RedactedString { return this.#rewrap(this.#value.concat(...strings)); }
  charAt(position: number): RedactedString { return this.#rewrap(this.#value.charAt(position)); }
  at(index: number): RedactedString | undefined {
    const char = stringAtIndex(this.#value, index);
    return char !== undefined ? this.#rewrap(char) : undefined;
  }
  split(separator: string | RegExp, limit?: number): RedactedString[] {
    return this.#value.split(separator, limit).map((value) => this.#rewrap(value));
  }
  indexOf(searchString: string, position?: number): number { return this.#value.indexOf(searchString, position); }
  lastIndexOf(searchString: string, position?: number): number { return this.#value.lastIndexOf(searchString, position); }
  search(regexp: string | RegExp): number { return this.#value.search(regexp); }
  localeCompare(that: string, locales?: Intl.LocalesArgument, options?: Intl.CollatorOptions): number {
    return this.#value.localeCompare(that, locales, options);
  }
}

export class RedactedBytes {
  readonly __classification: DataClassification;
  readonly __fieldName: string;
  readonly __privacyMode: PrivacyModeValue;
  readonly __isRedacted: boolean;
  readonly #value: Uint8Array;
  readonly #privacyContext: PrivacyContext;

  constructor(
    value: Uint8Array,
    classification: DataClassification,
    fieldName: string,
    modeOrContext: PrivacyModeValue | PrivacyContext,
  ) {
    const context = toPrivacyContext(modeOrContext);
    this.#value = value;
    this.#privacyContext = context;
    this.__classification = classification;
    this.__fieldName = fieldName;
    this.__privacyMode = context.privacyMode;
    this.__isRedacted = shouldRedact(context.privacyMode, classification);
  }

  getPrivacyContext(): PrivacyContext {
    return this.#privacyContext.enforceRedaction !== undefined ? {
      privacyMode: this.#privacyContext.privacyMode,
      enforceRedaction: this.#privacyContext.enforceRedaction,
    } : { privacyMode: this.#privacyContext.privacyMode };
  }

  unwrap(purpose: PrivacyCapability, options?: RedactedUnwrapOptions): Uint8Array {
    const info = {
      fieldName: this.__fieldName,
      classification: this.__classification,
      privacyMode: this.__privacyMode,
    };
    logUnspecifiedWarnings(info);
    if (allowedPurpose(this.__privacyMode, purpose, this.__classification)) return this.#value;
    const enforce = options?.enforcing ||
      resolveEnforceRedaction(this.#privacyContext, this.__classification);
    if (!enforce && !IS_DEV) logEnforcementSkipped(info);
    if (!enforce) return this.#value;
    if (options?.redactUnallowedFieldsInsteadOfThrowing) return new Uint8Array(0);
    throw new Error(
      `Unwrap not allowed for purpose ${purpose} with classification ${this.__classification} and privacy mode ${this.__privacyMode}`,
    );
  }

  __clone(newValue: Uint8Array): RedactedBytes {
    return new RedactedBytes(newValue, this.__classification, this.__fieldName, this.#privacyContext);
  }
  get empty(): boolean { return this.#value.length === 0; }
  get length(): number { return this.#value.length; }
  safeTransform(transform: (value: Uint8Array) => Uint8Array): RedactedBytes {
    return new RedactedBytes(
      transform(this.#value),
      this.__classification,
      this.__fieldName,
      this.#privacyContext,
    );
  }
}

export function isRedactedString(value: unknown): value is RedactedString {
  return value instanceof RedactedString;
}
