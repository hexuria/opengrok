import { Fragment, jsx, type PromptElement, type PromptProps } from "./jsx-runtime.js";

export const System = (props: PromptProps): PromptElement => jsx("System", props);
export const User = (props: PromptProps): PromptElement => jsx("User", props);
export const Assistant = (props: PromptProps): PromptElement => jsx("Assistant", props);
export const Tool = (props: PromptProps): PromptElement => jsx("Tool", props);
export const Conversation = (props: PromptProps): PromptElement => jsx(Fragment, props);

export const builtinComponents = {
  System,
  User,
  Assistant,
  Tool,
  Conversation,
  Fragment,
};
