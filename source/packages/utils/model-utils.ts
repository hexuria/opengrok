export const DSV3_TOOL_TOKENS_TO_STRIP = [
  "<｜tool▁calls▁begin｜>", "<｜tool▁calls▁end｜>", "<｜tool▁call▁begin｜>", "<｜tool▁call▁end｜>",
  "<｜tool▁outputs▁begin｜>", "<｜tool▁outputs▁end｜>", "<｜tool▁output▁begin｜>", "<｜tool▁output▁end｜>", "<｜tool▁sep｜>",
  "<|redacted_tool_calls_begin|>", "<|redacted_tool_calls_end|>", "<|redacted_tool_call_begin|>", "<|redacted_tool_call_end|>",
  "<|redacted_tool_outputs_begin|>", "<|redacted_tool_outputs_end|>", "<|redacted_tool_output_begin|>", "<|redacted_tool_output_end|>", "<|redacted_tool_sep|>",
] as const;

export function isCursorBigModel(modelName: string | null | undefined): boolean {
  if (!modelName) return false;
  const lower = modelName.toLowerCase();
  return ["cursor-big", "dsv3", "kimi2p5-uninitialized", "kimi-k2p5-rl-", "kimi-k2p5-agent-", "titanium-0318", "composer", "genericbase"].some((part) => lower.includes(part));
}
