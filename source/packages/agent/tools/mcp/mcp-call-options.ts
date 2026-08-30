import { z } from "zod";

import { McpDescriptor, type McpFileSystemOptions, type McpMetaToolOptions } from "../../../proto/generated/agent/v1/mcp_pb.js";
import { parseArgumentsLeniently } from "./dynamic-tool-argument-repair.js";

export const MCP_AUTH_VIRTUAL_TOOL_NAME = "mcp_auth";

export interface McpDescriptorSession {
  readonly serverDescriptors: ReadonlyMap<string, McpDescriptor>;
  readonly toolDefinitionPaths: ReadonlyMap<string, string>;
}

export function buildMcpDescriptorSession({
  mcpMetaToolEnabled,
  mcpMetaToolOptions,
  mcpFileSystemOptions,
  allowInteractiveMcpAuth = false,
}: {
  readonly mcpMetaToolEnabled: boolean;
  readonly mcpMetaToolOptions?: McpMetaToolOptions | undefined;
  readonly mcpFileSystemOptions?: McpFileSystemOptions | undefined;
  readonly allowInteractiveMcpAuth?: boolean | undefined;
}): McpDescriptorSession {
  const serverDescriptors = new Map<string, McpDescriptor>();
  const toolDefinitionPaths = new Map<string, string>();
  const descriptorSource = mcpMetaToolEnabled
    ? mcpMetaToolOptions?.mcpDescriptors ?? []
    : mcpFileSystemOptions?.mcpDescriptors ?? [];

  for (const descriptor of descriptorSource) {
    const rawTools = descriptor.tools;
    const descriptorTools = allowInteractiveMcpAuth
      ? rawTools
      : rawTools.filter(tool => tool.toolName !== MCP_AUTH_VIRTUAL_TOOL_NAME);
    const descriptorForRegistration = allowInteractiveMcpAuth || descriptorTools.length === rawTools.length
      ? descriptor
      : new McpDescriptor({
        serverIdentifier: descriptor.serverIdentifier,
        serverName: descriptor.serverName,
        ...(descriptor.plugin !== undefined ? { plugin: descriptor.plugin } : {}),
        ...(descriptor.marketplace !== undefined ? { marketplace: descriptor.marketplace } : {}),
        ...(descriptor.serverUseInstructions !== undefined ? { serverUseInstructions: descriptor.serverUseInstructions } : {}),
        ...(descriptor.folderPath !== undefined ? { folderPath: descriptor.folderPath } : {}),
        ...(descriptor.pluginDbId !== undefined ? { pluginDbId: descriptor.pluginDbId } : {}),
        ...(descriptor.marketplaceId !== undefined ? { marketplaceId: descriptor.marketplaceId } : {}),
        tools: descriptorTools,
      });
    serverDescriptors.set(descriptor.serverIdentifier, descriptorForRegistration);
    for (const tool of descriptorTools) {
      if (tool.definitionPath !== undefined) {
        toolDefinitionPaths.set(`${descriptor.serverIdentifier}:${tool.toolName}`, tool.definitionPath);
      }
    }
  }

  return { serverDescriptors, toolDefinitionPaths };
}

export interface McpCallToolSchemas {
  readonly parametersSchema: z.ZodType<unknown>;
  readonly parsingParametersSchema: z.ZodType<unknown>;
  readonly normalizeInput: (raw: unknown) => unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function buildJsonValueSchema(): z.ZodType<unknown> {
  let jsonValueSchema: z.ZodType<unknown>;
  jsonValueSchema = z.lazy(() => z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.record(jsonValueSchema),
    z.array(jsonValueSchema),
  ]));
  return jsonValueSchema;
}

export function buildMcpCallToolSchemas({
  useDynamicToolNamespaces,
  smartModeClassifierMode,
}: {
  readonly useDynamicToolNamespaces: boolean;
  readonly smartModeClassifierMode: boolean;
}): McpCallToolSchemas {
  const jsonValueSchema = buildJsonValueSchema();
  const argumentsRecordSchema = z.record(jsonValueSchema);
  const argumentsParameterSchema = argumentsRecordSchema
    .optional()
    .describe(useDynamicToolNamespaces
      ? "Arguments to pass to the tool, as described by the tool descriptor."
      : "Arguments to pass to the MCP tool, as described in the tool descriptor.");
  const baseParametersSchema = z.object({
    server: z.string().describe("Identifier of the MCP server hosting the tool."),
    toolName: z.string().describe("Name of the MCP tool to invoke."),
    arguments: argumentsParameterSchema,
  });
  const modelIdentityParametersSchema = useDynamicToolNamespaces
    ? z.object({
      namespace: z.string().describe("Dynamic namespace hosting the tool, e.g. an MCP server."),
      toolName: z.string().describe("Name of the tool to invoke."),
    })
    : baseParametersSchema.omit({ arguments: true });
  const callDescriptionSchema = z.string().describe("Short plain-language description of what this call will do. One sentence naming the outcome and where it applies (channel, page, file, or service) when known. Do not include tool names, argument keys, or JSON.");
  const descriptionParametersSchema = z.object({ description: callDescriptionSchema.optional() });
  const smartModeApprovalParametersSchema = z.object({
    requestSmartModeApproval: z.boolean().optional().describe("Set to true when immediately retrying the exact same MCP call after Auto-review blocks it and you decide the user should approve it through the native approval card."),
    smartModeBlockReason: z.string().optional().describe("Provide the exact block reason returned by Auto-review in the prior rejection. Required when requestSmartModeApproval is true so the approval card shows the original classifier reason without re-running the classifier."),
  });
  const mcpDetailsParametersSchema = z.object({
    description: callDescriptionSchema,
    ...(smartModeClassifierMode
      ? {
        requestSmartModeApproval: smartModeApprovalParametersSchema.shape.requestSmartModeApproval.default(false),
        smartModeBlockReason: smartModeApprovalParametersSchema.shape.smartModeBlockReason,
      }
      : {}),
  });
  const mcpDetailsInputSchema = z.object({
    description: callDescriptionSchema.optional(),
    ...smartModeApprovalParametersSchema.shape,
  });
  const parametersSchema = useDynamicToolNamespaces
    ? modelIdentityParametersSchema.extend({
      mcpDetails: mcpDetailsParametersSchema.optional().describe("MCP-specific call metadata. Set this only when invoking a tool from an external MCP namespace; omit it for first-party tools in the cursor namespace."),
      arguments: argumentsParameterSchema,
    })
    : modelIdentityParametersSchema.extend({
      ...descriptionParametersSchema.shape,
      ...(smartModeClassifierMode ? smartModeApprovalParametersSchema.shape : {}),
      arguments: argumentsParameterSchema,
    });

  const normalizeInput = (raw: unknown): unknown => {
    if (!isRecord(raw)) return raw;
    const normalized = { ...raw };
    if (useDynamicToolNamespaces) {
      if (normalized.namespace !== undefined) {
        normalized.server = normalized.namespace;
        delete normalized.namespace;
      }
      const missingIdentity = [
        normalized.server === undefined ? "namespace" : undefined,
        normalized.toolName === undefined ? "toolName" : undefined,
      ].filter((field): field is string => field !== undefined);
      if (missingIdentity.length > 0) {
        throw new Error(`Missing required ${missingIdentity.length === 1 ? "field" : "fields"}: ${missingIdentity.join(", ")}. Re-issue the call with the tool's identity set; \`arguments\` alone does not identify the tool.`);
      }
    }
    if (normalized.descriptionForMcp !== undefined) {
      normalized.description ??= normalized.descriptionForMcp;
      delete normalized.descriptionForMcp;
    }
    if (typeof normalized.arguments === "string") {
      const recovered = parseArgumentsLeniently(normalized.arguments);
      if (recovered === undefined) {
        throw new Error("Failed to parse arguments string as JSON object. Re-issue the call with `arguments` as a JSON object literal rather than a quoted string.");
      }
      const args = recovered.args;
      if (recovered.repaired) {
        const foldedDetails = args.mcpDetails;
        if (foldedDetails !== undefined) {
          delete args.mcpDetails;
          normalized.mcpDetails ??= foldedDetails;
        }
        const foldedDescription = args.descriptionForMcp;
        if (foldedDescription !== undefined) {
          delete args.descriptionForMcp;
          normalized.description ??= foldedDescription;
        }
      }
      const leakedDescription = recovered.envelopeFields?.description;
      if (leakedDescription !== undefined && normalized.description === undefined) {
        normalized.description = leakedDescription;
      }
      normalized.arguments = args;
    }
    if (smartModeClassifierMode && isRecord(normalized.arguments)) {
      if ("requestSmartModeApproval" in normalized.arguments || "smartModeBlockReason" in normalized.arguments) {
        const stripped = { ...normalized.arguments };
        normalized.requestSmartModeApproval ??= stripped.requestSmartModeApproval;
        normalized.smartModeBlockReason ??= stripped.smartModeBlockReason;
        delete stripped.requestSmartModeApproval;
        delete stripped.smartModeBlockReason;
        normalized.arguments = stripped;
      }
    }
    return normalized;
  };

  const internalParametersSchema = useDynamicToolNamespaces
    ? baseParametersSchema.extend({
      ...descriptionParametersSchema.shape,
      ...smartModeApprovalParametersSchema.shape,
      mcpDetails: mcpDetailsInputSchema.optional(),
    }).transform(({ mcpDetails, ...args }) => ({
      ...args,
      description: mcpDetails?.description ?? args.description,
      requestSmartModeApproval: mcpDetails?.requestSmartModeApproval ?? args.requestSmartModeApproval,
      smartModeBlockReason: mcpDetails?.smartModeBlockReason ?? args.smartModeBlockReason,
    }))
    : baseParametersSchema.extend({
      ...descriptionParametersSchema.shape,
      ...(smartModeClassifierMode ? smartModeApprovalParametersSchema.shape : {}),
    });

  return {
    parametersSchema,
    parsingParametersSchema: z.preprocess(normalizeInput, internalParametersSchema),
    normalizeInput,
  };
}
