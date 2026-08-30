// @ts-nocheck
// Recovered from the exact host-main.cjs evidence regions for this module.
import {
  PromptContextNode,
  PromptContextSourceRef,
  PromptContextUsageTree,
} from "../../proto/generated/agent/v1/agent_pb.js";
import {
  PROMPT_TOKEN_BREAKDOWN_CATEGORIES,
} from "./prompt-token-breakdown.js";
import {
  extractCompleteTagRanges,
  extractCompleteTagRangesMatching,
  extractMcpServerTagRanges,
} from "./prompt-tag-parsing.js";
import { estimateStringTokenCount } from "./token-estimate.js";
import { buildDescriptionGeneratorProps, toAgentTools } from "../tools/core.js";

export function buildPromptContextUsageTree(params) {
  const nodes = [];
  const categoryById = indexBreakdownCategoriesById(params.breakdown);
  for (const category of PROMPT_TOKEN_BREAKDOWN_CATEGORIES) {
    const breakdownCategory = categoryById.get(category.id);
    nodes.push(new PromptContextNode({
      id: categoryNodeId(category.id),
      kind: "category",
      label: category.label,
      categoryId: category.id,
      estimatedTokens: breakdownCategory?.estimatedTokens ?? 0,
      characterCount: breakdownCategory?.characterCount ?? 0,
      contentAvailable: false
    }));
  }
  appendMessageOverviewNodes(nodes, params.messages);
  appendToolOverviewNodes(nodes, params.tools, params.descriptionProps);
  return new PromptContextUsageTree({
    schemaVersion: PROMPT_CONTEXT_USAGE_TREE_SCHEMA_VERSION,
    nodes
  });
}
const PROMPT_CONTEXT_USAGE_TREE_SCHEMA_VERSION = 1;
const PROMPT_CONTEXT_INLINE_CONTENT_CHARS = 4e4;
const PROMPT_CONTEXT_MAX_NODES = 4e3;
function appendMessageOverviewNodes(nodes, messages) {
  let initialUserPromptSeen = false;
  const pairings = pairToolCallsAndResults(messages);
  messages.forEach((message, messageIndex) => {
    const isSummary = isSummaryCarrierMessage(message);
    if (message.role === "system") {
      if (!isSummary) {
        for (const segment of getOverviewTextSegments(message.content)) {
          appendMcpBlockOverviewNodes(nodes, { messageIndex, segment });
        }
      }
      return;
    }
    const isInitialUserPrompt = message.role === "user" && !initialUserPromptSeen && !isSummary;
    if (message.role === "user" && !isSummary) {
      initialUserPromptSeen = true;
    }
    const baseCategory = getOverviewCategoryForMessage(message, isSummary);
    const baseKind = getOverviewKindForMessage(message, isSummary);
    for (const segment of getOverviewTextSegments(message.content)) {
      if (segment.partType === "redacted-reasoning") {
        continue;
      }
      if (segment.partType === "tool-call" && segment.toolCallId !== void 0) {
        appendToolCallPairNodes(nodes, {
          messageIndex,
          callSegment: segment,
          pairedResult: pairings.resultByCallKey.get(messageContentKey(messageIndex, segment.contentPath))
        });
        continue;
      }
      if (segment.partType === "tool-result" && pairings.pairedResultKeys.has(messageContentKey(messageIndex, segment.contentPath))) {
        continue;
      }
      appendOverviewNode(nodes, {
        id: `message:${messageIndex}:${segment.contentPath}`,
        parentId: categoryNodeId(baseCategory),
        kind: baseKind,
        label: formatOverviewMessageLabel(message.role),
        categoryId: baseCategory,
        text: segment.text,
        carrier: {
          kind: "blob",
          source: rootPromptMessageSourceRef(messageIndex, segment)
        }
      });
      appendTaggedPromptBlockNodes(nodes, {
        messageIndex,
        segment,
        isInitialUserPrompt,
        isSummary,
        role: message.role
      });
    }
  });
}
function getOverviewTextSegments(content) {
  if (typeof content === "string") {
    return [{ contentPath: "content", text: content }];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const segments = [];
  content.forEach((part, index) => {
    if (typeof part === "string") {
      segments.push({ contentPath: `content[${index}]`, text: part });
      return;
    }
    if (typeof part !== "object" || part === null) {
      return;
    }
    const segment = extractStructuredPartSegment(part, index);
    if (segment !== void 0) {
      segments.push(segment);
    }
  });
  return segments;
}
function extractStructuredPartSegment(part, index) {
  const record3 = part;
  const partType = typeof record3.type === "string" ? record3.type : void 0;
  const toolCallId = typeof record3.toolCallId === "string" ? record3.toolCallId : void 0;
  const toolName = typeof record3.toolName === "string" ? record3.toolName : void 0;
  if (partType === "tool-call" && "args" in record3) {
    return {
      contentPath: `content[${index}].args`,
      text: stringifyOverviewValue(record3.args),
      partType,
      toolCallId,
      toolName
    };
  }
  if (partType === "tool-result" && "result" in record3) {
    return {
      contentPath: `content[${index}].result`,
      text: stringifyOverviewValue(record3.result),
      partType,
      toolCallId,
      toolName
    };
  }
  if (typeof record3.text === "string") {
    return {
      contentPath: `content[${index}].text`,
      text: record3.text,
      partType,
      toolCallId,
      toolName
    };
  }
  try {
    return {
      contentPath: `content[${index}]`,
      text: JSON.stringify(part, void 0, 2),
      partType,
      toolCallId,
      toolName
    };
  } catch {
    return void 0;
  }
}
function getOverviewCategoryForMessage(message, isSummary) {
  if (message.role === "system") {
    return "system_prompt";
  }
  if (isSummary) {
    return "summarized_conversation";
  }
  return "conversation";
}
function getOverviewKindForMessage(message, isSummary) {
  if (message.role === "tool") {
    return "tool_result";
  }
  if (isSummary) {
    return "summary_message";
  }
  return `${message.role}_message`;
}
function pairToolCallsAndResults(messages) {
  const resultByCallId = indexToolResultsByCallId(messages);
  const resultByCallKey = new Map();
  const pairedResultKeys = new Set();
  messages.forEach((message, messageIndex) => {
    for (const segment of getOverviewTextSegments(message.content)) {
      if (segment.partType !== "tool-call" || segment.toolCallId === void 0) {
        continue;
      }
      const result = resultByCallId.get(segment.toolCallId);
      if (result === void 0) {
        continue;
      }
      const resultKey = messageContentKey(result.messageIndex, result.segment.contentPath);
      if (pairedResultKeys.has(resultKey)) {
        continue;
      }
      resultByCallKey.set(messageContentKey(messageIndex, segment.contentPath), result);
      pairedResultKeys.add(resultKey);
    }
  });
  return { resultByCallKey, pairedResultKeys };
}
function indexToolResultsByCallId(messages) {
  const map4 = new Map();
  messages.forEach((message, messageIndex) => {
    if (message.role !== "tool") {
      return;
    }
    for (const segment of getOverviewTextSegments(message.content)) {
      if (segment.partType === "tool-result" && segment.toolCallId !== void 0 && !map4.has(segment.toolCallId)) {
        map4.set(segment.toolCallId, { messageIndex, segment });
      }
    }
  });
  return map4;
}
function formatOverviewMessageLabel(role) {
  if (role === "user") {
    return "User Message";
  }
  if (role === "assistant") {
    return "Agent Message";
  }
  const normalized = role.length > 0 ? role[0].toUpperCase() + role.slice(1) : role;
  return `${normalized} Message`;
}
function formatOverviewToolCallPairLabel(toolName) {
  return `${toolName} Tool`;
}
function appendToolCallPairNodes(nodes, params) {
  const { callSegment, messageIndex, pairedResult } = params;
  const toolCallId = callSegment.toolCallId;
  if (toolCallId === void 0) {
    return;
  }
  if (nodes.length + 2 > PROMPT_CONTEXT_MAX_NODES) {
    return;
  }
  const parentNodeId = `tool_call_pair:${messageIndex}:${toolCallId}`;
  const toolName = callSegment.toolName ?? "tool";
  nodes.push(new PromptContextNode({
    id: parentNodeId,
    parentId: categoryNodeId("conversation"),
    kind: "tool_call_pair",
    label: formatOverviewToolCallPairLabel(toolName),
    categoryId: "conversation",
    estimatedTokens: 0,
    characterCount: 0,
    contentAvailable: false
  }));
  appendOverviewNode(nodes, {
    id: `${parentNodeId}:call`,
    parentId: parentNodeId,
    kind: "tool_call",
    label: "Call",
    categoryId: "conversation",
    text: callSegment.text,
    carrier: {
      kind: "blob",
      source: rootPromptMessageSourceRef(messageIndex, callSegment)
    }
  });
  if (pairedResult === void 0) {
    return;
  }
  appendOverviewNode(nodes, {
    id: `${parentNodeId}:result`,
    parentId: parentNodeId,
    kind: "tool_result",
    label: "Result",
    categoryId: "conversation",
    text: pairedResult.segment.text,
    carrier: {
      kind: "blob",
      source: rootPromptMessageSourceRef(pairedResult.messageIndex, pairedResult.segment)
    }
  });
}
const TAGGED_PROMPT_ITEM_BLOCKS = [
  {
    tagName: "rules",
    categoryId: "rules",
    item: {
      matcher: (tagName2) => tagName2.endsWith("_rule"),
      kind: "rule",
      labelPrefix: "Rule"
    }
  },
  {
    tagName: "agent_skills",
    categoryId: "skills",
    item: {
      matcher: (tagName2) => tagName2 === "agent_skill",
      kind: "skill",
      labelPrefix: "Skill"
    }
  }
];
function appendTaggedPromptBlockNodes(nodes, params) {
  if (params.isSummary || params.role === "tool") {
    return;
  }
  if (params.isInitialUserPrompt) {
    for (const block of TAGGED_PROMPT_ITEM_BLOCKS) {
      appendTaggedBlockItemNodes(nodes, {
        messageIndex: params.messageIndex,
        segment: params.segment,
        block
      });
    }
  }
  appendMcpBlockOverviewNodes(nodes, {
    messageIndex: params.messageIndex,
    segment: params.segment
  });
}
function appendTaggedBlockItemNodes(nodes, params) {
  const { block, messageIndex, segment } = params;
  for (const envelopeRange of extractCompleteTagRanges(segment.text, block.tagName)) {
    const envelopeNodeId = `message:${messageIndex}:${segment.contentPath}:${block.tagName}:${envelopeRange.start}`;
    const envelopeText = segment.text.slice(envelopeRange.start, envelopeRange.end);
    const itemRanges = extractCompleteTagRangesMatching(envelopeText, block.item.matcher);
    itemRanges.forEach((itemRange, index) => {
      const absoluteStart = envelopeRange.start + itemRange.start;
      const absoluteEnd = envelopeRange.start + itemRange.end;
      const itemText = segment.text.slice(absoluteStart, absoluteEnd);
      appendOverviewNode(nodes, {
        id: `${envelopeNodeId}:${block.item.kind}:${absoluteStart}`,
        parentId: categoryNodeId(block.categoryId),
        kind: block.item.kind,
        label: buildNestedPromptItemLabel(itemText, `${block.item.labelPrefix} ${index + 1}`),
        categoryId: block.categoryId,
        text: itemText,
        carrier: {
          kind: "blob",
          source: rootPromptMessageSourceRef(messageIndex, segment, {
            start: absoluteStart,
            end: absoluteEnd
          })
        }
      });
    });
  }
}
function buildNestedPromptItemLabel(text2, fallback2) {
  const openTagEnd = text2.indexOf(">");
  if (openTagEnd === -1) {
    return fallback2;
  }
  const openTag = decodePromptTagAttributeEntities(text2.slice(0, openTagEnd + 1));
  return NESTED_ITEM_LABEL_PATTERN.exec(openTag)?.[1] ?? fallback2;
}
function decodePromptTagAttributeEntities(text2) {
  return text2.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}
const NESTED_ITEM_LABEL_PATTERN = /\b(?:name|fullPath|title)="([^"]*)"/;
const SUBAGENT_BULLET_LINE_PATTERN = /^-\s+([^:]+?)(?:\s*:\s*(.*))?$/;
const MCP_OVERVIEW_WRAPPER_TAGS = new Set([
  "mcp_file_system",
  "mcp_file_system_servers",
  "mcp_meta_tool_servers",
  "mcp_server_catalog",
  "mcp_file_system_server",
  "mcp_meta_tool_server",
  "dynamic_tools",
  "dynamic_tool_namespaces",
  "dynamic_tool_catalog",
  "namespace",
  // Legacy dynamic-tool prompts used this name.
  "dynamic_tool_namespace"
]);
function appendMcpBlockOverviewNodes(nodes, params) {
  const { messageIndex, segment } = params;
  appendMcpServerEntryNodes(nodes, { messageIndex, segment });
  const mcpRanges = extractCompleteTagRangesMatching(segment.text, isToolDiscoveryBlockTag);
  for (const range2 of selectOutermostRanges(mcpRanges)) {
    if (MCP_OVERVIEW_WRAPPER_TAGS.has(range2.tagName)) {
      continue;
    }
    const parentNodeId = `message:${messageIndex}:${segment.contentPath}:mcp:${range2.start}`;
    appendOverviewNode(nodes, {
      id: parentNodeId,
      parentId: categoryNodeId("mcp"),
      kind: "mcp_block",
      label: `<${range2.tagName}>`,
      categoryId: "mcp",
      text: segment.text.slice(range2.start, range2.end),
      carrier: {
        kind: "blob",
        source: rootPromptMessageSourceRef(messageIndex, segment, range2)
      }
    });
    appendMcpBlockChildNodes(nodes, {
      messageIndex,
      segment,
      parentNodeId,
      parentRange: range2
    });
  }
}
function appendMcpServerEntryNodes(nodes, params) {
  const { messageIndex, segment } = params;
  for (const range2 of extractMcpServerTagRanges(segment.text)) {
    const serverText = segment.text.slice(range2.start, range2.end);
    appendOverviewNode(nodes, {
      id: `message:${messageIndex}:${segment.contentPath}:mcp_server:${range2.start}`,
      parentId: categoryNodeId("mcp"),
      kind: range2.tagName,
      label: buildNestedPromptItemLabel(serverText, `<${range2.tagName}>`),
      categoryId: "mcp",
      text: serverText,
      carrier: {
        kind: "blob",
        source: rootPromptMessageSourceRef(messageIndex, segment, range2)
      }
    });
  }
}
function appendMcpBlockChildNodes(nodes, params) {
  const { messageIndex, segment, parentNodeId, parentRange } = params;
  const parentText = segment.text.slice(parentRange.start, parentRange.end);
  const childRanges = extractCompleteTagRangesMatching(parentText, isToolDiscoveryBlockTag);
  childRanges.forEach((childRange) => {
    if (childRange.start === 0 && childRange.end === parentText.length && childRange.tagName === parentRange.tagName) {
      return;
    }
    if (MCP_OVERVIEW_WRAPPER_TAGS.has(childRange.tagName)) {
      return;
    }
    const absoluteStart = parentRange.start + childRange.start;
    const absoluteEnd = parentRange.start + childRange.end;
    const childText = segment.text.slice(absoluteStart, absoluteEnd);
    appendOverviewNode(nodes, {
      id: `${parentNodeId}:mcp:${absoluteStart}`,
      parentId: parentNodeId,
      kind: "mcp_block",
      label: `<${childRange.tagName}>`,
      categoryId: "mcp",
      text: childText,
      carrier: {
        kind: "blob",
        source: rootPromptMessageSourceRef(messageIndex, segment, {
          start: absoluteStart,
          end: absoluteEnd
        })
      }
    });
  });
}
function appendToolOverviewNodes(nodes, tools, descriptionProps) {
  const descriptionPropsToUse = descriptionProps ?? buildDescriptionGeneratorProps(tools);
  const agentTools = toAgentTools(tools, descriptionPropsToUse);
  for (let index = 0; index < tools.length; index++) {
    const tool = tools[index];
    const agentTool = agentTools[index];
    if (tool === void 0 || agentTool === void 0) {
      continue;
    }
    const split = splitSubagentDescriptionFromTool(tool, agentTool.description, descriptionPropsToUse);
    const toolText = serializeProviderFacingToolDefinition({
      ...agentTool,
      description: split.toolDescription
    });
    appendTokenEstimateOverviewNode(nodes, {
      id: `tool:${index}`,
      parentId: categoryNodeId("tools"),
      kind: "tool_definition",
      label: agentTool.name,
      categoryId: "tools",
      text: toolText
    });
    if (split.subagentText.length > 0) {
      appendSubagentOverviewNodes(nodes, {
        toolIndex: index,
        toolName: agentTool.name,
        text: split.subagentText
      });
    }
  }
}
function appendSubagentOverviewNodes(nodes, params) {
  const bullets = extractSubagentBulletLines(params.text);
  const categoryParentId = categoryNodeId("subagents");
  if (bullets.length === 0) {
    appendOverviewNode(nodes, {
      id: `tool:${params.toolIndex}:subagents`,
      parentId: categoryParentId,
      kind: "subagent_description",
      label: params.toolName,
      categoryId: "subagents",
      text: params.text,
      carrier: { kind: "inline" }
    });
    return;
  }
  for (const [index, bullet] of bullets.entries()) {
    appendOverviewNode(nodes, {
      id: `tool:${params.toolIndex}:subagent:${index}`,
      parentId: categoryParentId,
      kind: "subagent_type",
      label: bullet.label,
      categoryId: "subagents",
      text: bullet.line,
      carrier: { kind: "inline" }
    });
  }
}
function extractSubagentBulletLines(text2) {
  const bullets = [];
  for (const line of text2.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const match2 = SUBAGENT_BULLET_LINE_PATTERN.exec(trimmed);
    if (match2 === null) {
      continue;
    }
    bullets.push({
      label: match2[1]?.trim() ?? trimmed,
      line: trimmed
    });
  }
  return bullets;
}
function appendTokenEstimateOverviewNode(nodes, params) {
  if (params.text.length === 0 || nodes.length >= PROMPT_CONTEXT_MAX_NODES) {
    return;
  }
  nodes.push(new PromptContextNode({
    id: params.id,
    parentId: params.parentId,
    kind: params.kind,
    label: params.label,
    categoryId: params.categoryId,
    estimatedTokens: estimateStringTokenCount(params.text),
    characterCount: params.text.length,
    contentAvailable: false
  }));
}
function appendOverviewNode(nodes, params) {
  if (params.text.length === 0 || nodes.length >= PROMPT_CONTEXT_MAX_NODES) {
    return;
  }
  const truncated = params.carrier.kind === "inline" && params.text.length > PROMPT_CONTEXT_INLINE_CONTENT_CHARS;
  const inlineContent = params.carrier.kind === "inline" ? truncated ? params.text.slice(0, PROMPT_CONTEXT_INLINE_CONTENT_CHARS) : params.text : void 0;
  nodes.push(new PromptContextNode({
    id: params.id,
    parentId: params.parentId,
    kind: params.kind,
    label: params.label,
    categoryId: params.categoryId,
    estimatedTokens: estimateStringTokenCount(params.text),
    characterCount: params.text.length,
    contentAvailable: true,
    inlineContent,
    source: params.carrier.kind === "blob" ? params.carrier.source : void 0
  }));
}
function rootPromptMessageSourceRef(messageIndex, segment, range2) {
  return new PromptContextSourceRef({
    sourceType: "root_prompt_message",
    messageIndex,
    contentPath: segment.contentPath,
    startOffset: range2?.start ?? 0,
    endOffset: range2?.end ?? segment.text.length
  });
}
function categoryNodeId(categoryId) {
  return `category:${categoryId}`;
}
function messageContentKey(messageIndex, contentPath) {
  return `${messageIndex}:${contentPath}`;
}
function stringifyOverviewValue(value) {
  if (value === void 0 || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, void 0, 2);
  } catch {
    return String(value);
  }
}
function indexBreakdownCategoriesById(snapshot) {
  const map4 = new Map();
  for (const category of snapshot.categories) {
    map4.set(category.id, {
      estimatedTokens: category.estimatedTokens ?? 0,
      characterCount: category.characterCount ?? 0
    });
  }
  return map4;
}

function splitSubagentDescriptionFromTool(tool, description3, descriptionProps) {
  if (tool.toolIdentifier !== "TASK" || !("descriptionTokenPartsGenerator" in tool)) {
    return { toolDescription: description3, subagentText: "" };
  }
  const subagentText = tool.descriptionTokenPartsGenerator?.(descriptionProps).subagentDescriptionText ?? "";
  if (subagentText.length === 0) {
    return { toolDescription: description3, subagentText: "" };
  }
  const lastOccurrence = description3.lastIndexOf(subagentText);
  if (lastOccurrence === -1) {
    return { toolDescription: description3, subagentText: "" };
  }
  return {
    toolDescription: description3.slice(0, lastOccurrence) + description3.slice(lastOccurrence + subagentText.length),
    subagentText
  };
}
function serializeProviderFacingToolDefinition(tool) {
  return `${tool.name} ${tool.description} ${JSON.stringify(tool.customToolFormat ?? tool.parameters)}`;
}
function isSummaryCarrierMessage(message) {
  return message.role === "user" && message.providerOptions?.cursor?.isSummary === true;
}
function isMcpBlockTag(tagName2) {
  return tagName2.startsWith("mcp_");
}
function isDynamicToolBlockTag(tagName2) {
  return tagName2.startsWith("dynamic_tool");
}
function isToolDiscoveryBlockTag(tagName2) {
  return isMcpBlockTag(tagName2) || isDynamicToolBlockTag(tagName2);
}
function selectOutermostRanges(ranges) {
  const sorted = [...ranges].sort((left, right) => {
    if (left.start !== right.start) {
      return left.start - right.start;
    }
    return right.end - left.end;
  });
  const selected = [];
  let coveredUntil = -1;
  for (const range2 of sorted) {
    if (range2.start < coveredUntil) {
      continue;
    }
    selected.push(range2);
    coveredUntil = range2.end;
  }
  return selected;
}
