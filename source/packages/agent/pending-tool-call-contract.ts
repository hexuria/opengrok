import { CURSOR_DYNAMIC_TOOLS_NAMESPACE } from "../agent-exec/mcp.js";
import {
  getEffectiveToolCallArgs,
  getEffectiveToolCallName,
  parseNativeToolArguments,
  resolveEffectiveToolCallDescriptor,
  type NativeToolCallDescriptor,
} from "./tool-stream-executor.js";
import {
  resolveToolCallIdentity,
  type ToolExecutionSet,
} from "./tools/core.js";

interface ToolCallContentPart {
  readonly type: "tool-call";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args?: unknown;
}

export interface PendingToolExecutionContract {
  readonly toolCallId: string;
  readonly outerToolName: string;
  readonly toolIdentifier: string;
  readonly isDynamic: boolean;
  readonly allowedToolNames: readonly string[];
  readonly effectiveToolName?: string | undefined;
  readonly effectiveToolIdentifier?: string | undefined;
}

interface ToolIdentity {
  readonly toolIdentifier: string;
  readonly isDynamic: boolean;
}

type ResolveIdentity = (input: {
  readonly toolName: string;
  readonly args: unknown;
}) => ToolIdentity | undefined;

interface PendingContractCarrierMessage {
  readonly providerOptions?: {
    readonly cursor?: {
      readonly pendingToolExecutionContracts?: unknown;
    };
  };
}

function isToolCallContentPart(value: unknown): value is ToolCallContentPart {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const part = value as Record<string, unknown>;
  return part.type === "tool-call" &&
    typeof part.toolCallId === "string" &&
    typeof part.toolName === "string";
}

function isToolIdentifierOrUnknown(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseContract(value: unknown): PendingToolExecutionContract | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.toolCallId !== "string" ||
    typeof raw.outerToolName !== "string" ||
    !isToolIdentifierOrUnknown(raw.toolIdentifier) ||
    typeof raw.isDynamic !== "boolean" ||
    !Array.isArray(raw.allowedToolNames) ||
    !raw.allowedToolNames.every(name => typeof name === "string")
  ) {
    return undefined;
  }
  const contract: PendingToolExecutionContract = {
    toolCallId: raw.toolCallId,
    outerToolName: raw.outerToolName,
    toolIdentifier: raw.toolIdentifier,
    isDynamic: raw.isDynamic,
    allowedToolNames: raw.allowedToolNames,
  };
  if (typeof raw.effectiveToolName === "string") {
    (contract as { effectiveToolName?: string }).effectiveToolName = raw.effectiveToolName;
  }
  if (isToolIdentifierOrUnknown(raw.effectiveToolIdentifier)) {
    (contract as { effectiveToolIdentifier?: string }).effectiveToolIdentifier =
      raw.effectiveToolIdentifier;
  }
  return contract;
}

export function readPendingToolExecutionContracts(
  message: PendingContractCarrierMessage,
): Map<string, PendingToolExecutionContract> {
  const raw = message.providerOptions?.cursor?.pendingToolExecutionContracts;
  const contracts = new Map<string, PendingToolExecutionContract>();
  if (raw === undefined || raw === null || typeof raw !== "object") {
    return contracts;
  }
  for (const [toolCallId, value] of Object.entries(raw)) {
    const contract = parseContract(value);
    if (contract === undefined || contract.toolCallId !== toolCallId) {
      continue;
    }
    contracts.set(toolCallId, contract);
  }
  return contracts;
}

export function buildPendingToolExecutionContract(options: {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly resolveIdentity: ResolveIdentity;
  readonly toolExecutionSet: ToolExecutionSet;
  readonly allowedToolNames: Iterable<string>;
}): PendingToolExecutionContract {
  const descriptor = resolveEffectiveToolCallDescriptor({
    toolCallId: options.toolCallId,
    toolName: options.toolName,
    args: parseNativeToolArguments(options.args) ?? {},
  }, options.toolExecutionSet);
  const outerIdentity = options.resolveIdentity({
    toolName: options.toolName,
    args: options.args,
  }) ?? {
    toolIdentifier: "unknown",
    isDynamic: false,
  };
  const effectiveToolName = descriptor.effectiveNativeToolCall?.toolName;
  const effectiveArgs = descriptor.effectiveNativeToolCall?.args;
  const effectiveIdentity = effectiveToolName === undefined
    ? undefined
    : options.resolveIdentity({
      toolName: effectiveToolName,
      args: effectiveArgs,
    }) ?? {
      toolIdentifier: "unknown",
      isDynamic: true,
    };
  return {
    toolCallId: options.toolCallId,
    outerToolName: options.toolName,
    toolIdentifier: outerIdentity.toolIdentifier,
    isDynamic: outerIdentity.isDynamic || effectiveIdentity?.isDynamic === true,
    ...(effectiveToolName !== undefined
      ? {
        effectiveToolName,
        effectiveToolIdentifier: effectiveIdentity?.toolIdentifier ?? "unknown",
      }
      : {}),
    allowedToolNames: [...options.allowedToolNames],
  };
}

export function enrichPendingToolCallJson(
  pendingMessage: string,
  options: {
    readonly resolveIdentity: ResolveIdentity;
    readonly toolExecutionSet: ToolExecutionSet;
    readonly allowedToolNames: Iterable<string>;
    readonly pendingToolCallStartedAtMs?: number | undefined;
  },
): string {
  try {
    const parsed = JSON.parse(pendingMessage) as Record<string, unknown> & {
      content?: unknown;
      providerOptions?: Record<string, unknown> & {
        cursor?: Record<string, unknown>;
      };
    };
    const contracts: Record<string, unknown> = {
      ...(parsed.providerOptions?.cursor?.pendingToolExecutionContracts as
        | Record<string, unknown>
        | undefined) ?? {},
    };
    if (Array.isArray(parsed.content)) {
      for (const part of parsed.content) {
        if (!isToolCallContentPart(part)) {
          continue;
        }
        contracts[part.toolCallId] = buildPendingToolExecutionContract({
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          args: part.args,
          resolveIdentity: options.resolveIdentity,
          toolExecutionSet: options.toolExecutionSet,
          allowedToolNames: options.allowedToolNames,
        });
      }
    }
    const existingStartedAtMs =
      parsed.providerOptions?.cursor?.pendingToolCallStartedAtMs;
    parsed.providerOptions = {
      ...parsed.providerOptions,
      cursor: {
        ...parsed.providerOptions?.cursor,
        ...(options.pendingToolCallStartedAtMs !== undefined
          ? {
            pendingToolCallStartedAtMs:
              existingStartedAtMs ?? options.pendingToolCallStartedAtMs,
          }
          : {}),
        pendingToolExecutionContracts: contracts,
      },
    };
    return JSON.stringify(parsed);
  } catch {
    return pendingMessage;
  }
}

export function getAdmittedEffectiveToolName(
  descriptor: NativeToolCallDescriptor,
  allowedToolNames: ReadonlySet<string> | undefined,
): string | undefined {
  return descriptor.effectiveNativeToolCall !== undefined &&
      allowedToolNames?.has(descriptor.toolName) === true
    ? descriptor.effectiveNativeToolCall.toolName
    : undefined;
}

export function collectPendingToolAdmission(options: {
  readonly contracts: Iterable<PendingToolExecutionContract>;
}): {
  readonly allowedToolNames: Set<string> | undefined;
  readonly admittedEffectiveToolNames: Set<string>;
} {
  const admittedEffectiveToolNames = new Set<string>();
  let allowedToolNames: Set<string> | undefined;
  for (const contract of options.contracts) {
    allowedToolNames ??= new Set(contract.allowedToolNames);
    for (const name of contract.allowedToolNames) {
      allowedToolNames.add(name);
    }
    admittedEffectiveToolNames.add(contract.outerToolName);
    if (
      contract.effectiveToolName !== undefined &&
      allowedToolNames.has(contract.outerToolName)
    ) {
      admittedEffectiveToolNames.add(contract.effectiveToolName);
    }
  }
  return { allowedToolNames, admittedEffectiveToolNames };
}

export function resolveDescriptorForPendingToolCall(options: {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly contract?: PendingToolExecutionContract | undefined;
  readonly toolExecutionSet: ToolExecutionSet;
}): NativeToolCallDescriptor {
  const outerDescriptor: NativeToolCallDescriptor = {
    toolCallId: options.toolCallId,
    toolName: options.toolName,
    args: parseNativeToolArguments(options.args) ?? {},
  };
  if (
    options.contract?.effectiveToolName !== undefined &&
    outerDescriptor.args !== null &&
    typeof outerDescriptor.args === "object" &&
    !Array.isArray(outerDescriptor.args)
  ) {
    const outerArgs = outerDescriptor.args as Record<string, unknown>;
    const nestedArgs =
      outerArgs.namespace === CURSOR_DYNAMIC_TOOLS_NAMESPACE &&
        outerArgs.toolName === options.contract.effectiveToolName
        ? parseNativeToolArguments(outerArgs.arguments)
        : undefined;
    if (nestedArgs !== undefined) {
      return {
        ...outerDescriptor,
        effectiveNativeToolCall: {
          toolName: options.contract.effectiveToolName,
          args: nestedArgs,
        },
      };
    }
  }
  return resolveEffectiveToolCallDescriptor(outerDescriptor, options.toolExecutionSet);
}

function expectedPendingToolIdentifier(contract: PendingToolExecutionContract): string {
  return contract.effectiveToolIdentifier ?? contract.toolIdentifier;
}

export function validatePendingToolContractIdentity(options: {
  readonly contract: PendingToolExecutionContract;
  readonly descriptor: NativeToolCallDescriptor;
  readonly tool: Record<string, unknown>;
  readonly directDynamicToolNames: ReadonlySet<string>;
}): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (
    options.contract.effectiveToolName !== undefined &&
    options.descriptor.effectiveNativeToolCall === undefined
  ) {
    return {
      ok: false,
      reason:
        `Pending tool contract mismatch for ${options.descriptor.toolName}: expected effective tool ${options.contract.effectiveToolName}, but none resolved`,
    };
  }
  const effectiveToolName = getEffectiveToolCallName(options.descriptor);
  const effectiveArgs = getEffectiveToolCallArgs(options.descriptor);
  const actual = resolveToolCallIdentity({
    tool: options.tool,
    args: effectiveArgs,
    isDirectDynamicTool:
      options.descriptor.effectiveNativeToolCall !== undefined ||
      options.directDynamicToolNames.has(effectiveToolName),
  });
  const expected = expectedPendingToolIdentifier(options.contract);
  if (actual.toolIdentifier !== expected) {
    return {
      ok: false,
      reason:
        `Pending tool contract mismatch for ${effectiveToolName}: expected ${expected}, got ${String(actual.toolIdentifier)}`,
    };
  }
  return { ok: true };
}

export function createPendingToolContractMismatchResult(
  descriptor: NativeToolCallDescriptor,
  reason: string,
): Record<string, unknown> {
  return {
    role: "tool",
    id: descriptor.toolCallId,
    content: [{
      type: "tool-result",
      toolName: descriptor.toolName,
      toolCallId: descriptor.toolCallId,
      result: reason,
    }],
  };
}
