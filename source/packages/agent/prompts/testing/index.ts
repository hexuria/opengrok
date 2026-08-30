import { jsx, type PromptNode, type PromptProps } from "../../../prompt-jsx/jsx-runtime.js";
import { TestingInstructions } from "./parent.js";

type TestingInstructionsOptions = Parameters<typeof TestingInstructions>[0];

export function TestingInstructions2(options2: TestingInstructionsOptions) {
  return jsx(TestingInstructions as unknown as (props: PromptProps) => PromptNode, { ...options2 });
}
