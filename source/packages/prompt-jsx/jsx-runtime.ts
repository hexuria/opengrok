export interface PromptElement {
  readonly type: string | ((props: PromptProps) => PromptNode);
  readonly props: PromptProps;
  readonly children?: PromptNode[] | undefined;
}

export interface PromptProps {
  readonly children?: PromptNode | PromptNode[] | undefined;
  readonly [key: string]: unknown;
}

export type PromptNode =
  | PromptElement
  | PromptNode[]
  | string
  | number
  | boolean
  | null
  | undefined;

export function jsx(
  type: PromptElement["type"],
  props: PromptProps | null | undefined,
  ...children: PromptNode[]
): PromptElement {
  const normalizedProps = props || {};
  const propChildren = normalizedProps.children;
  const allChildren = propChildren
    ? Array.isArray(propChildren) ? propChildren : [propChildren]
    : children;
  const filteredChildren = allChildren.filter(
    child => child != null && typeof child !== "boolean" && child !== "",
  );
  return {
    type,
    props: Object.assign({}, normalizedProps, {
      children: filteredChildren.length > 0 ? filteredChildren : undefined,
    }),
    children: filteredChildren.length > 0 ? filteredChildren : undefined,
  };
}

export function Fragment(props: PromptProps): PromptElement {
  return jsx("Fragment", props);
}

export function jsxs(type: PromptElement["type"], props: PromptProps): PromptElement {
  return jsx(type, props);
}
