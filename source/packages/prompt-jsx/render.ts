import { builtinComponents } from "./components.js";
import type { PromptElement, PromptNode, PromptProps } from "./jsx-runtime.js";

interface PromptMessage {
  readonly role: string;
  readonly content: string;
  readonly name?: unknown;
  readonly toolCallId?: unknown;
}

interface RenderOptions {
  readonly components?: Readonly<Record<string, (props: PromptProps) => PromptNode>> | undefined;
}

interface RenderParagraph {
  readonly content: string;
  readonly isSection: boolean;
}

function isElement(value: PromptNode): value is PromptElement {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "type" in value;
}

class RenderContext {
  readonly metadata: Record<string, unknown> = {};
  private readonly components: Readonly<Record<string, (props: PromptProps) => PromptNode>>;

  constructor(options: RenderOptions) {
    this.components = Object.assign({}, builtinComponents, options.components);
  }

  renderToMessages(node: PromptNode): PromptMessage[] {
    if (node == null || typeof node === "boolean") return [];
    if (typeof node === "string" || typeof node === "number") {
      return [{ role: "user", content: String(node) }];
    }
    if (Array.isArray(node)) return node.flatMap(child => this.renderToMessages(child));
    return this.renderElement(node);
  }

  private renderElement(element: PromptElement): PromptMessage[] {
    if (typeof element.type === "function") {
      return this.renderToMessages(element.type(element.props));
    }
    if (typeof element.type === "string") {
      return this.renderIntrinsicElement(element.type, element.props);
    }
    throw new Error(`Unknown element type: ${String(element.type)}`);
  }

  private renderIntrinsicElement(type: string, props: PromptProps): PromptMessage[] {
    switch (type) {
      case "System":
        return [Object.assign(
          { role: "system", content: this.renderContent(props.children) },
          props.name && { name: props.name },
        )];
      case "User":
        return [Object.assign(
          { role: "user", content: this.renderContent(props.children) },
          props.name && { name: props.name },
        )];
      case "Assistant":
        return [Object.assign(
          { role: "assistant", content: this.renderContent(props.children) },
          props.name && { name: props.name },
        )];
      case "Tool":
        return [Object.assign(
          {
            role: "tool",
            content: this.renderContent(props.children),
            toolCallId: props.tool_call_id,
          },
          props.name && { name: props.name },
        )];
      case "Fragment": return this.renderToMessages(props.children);
      case "p":
      case "section":
      case "ul":
      case "ol":
      case "li":
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
      case "x":
      case "pre":
      case "br":
        return [];
      default: {
        const component = this.components[type];
        if (component !== undefined) return this.renderToMessages(component(props));
        throw new Error(`Unknown component type: ${type}`);
      }
    }
  }

  renderContent(children: PromptNode): string {
    if (children == null || typeof children === "boolean") return "";
    if (typeof children === "string" || typeof children === "number") return String(children);
    if (Array.isArray(children)) return this.renderParagraphAwareContent(children);
    return this.renderContentNode(children);
  }

  private renderContentNode(node: PromptNode): string {
    if (node == null || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) {
      const flattened: PromptNode[] = [];
      for (const item of node) {
        if (Array.isArray(item)) flattened.push(...item);
        else flattened.push(item);
      }
      return this.renderParagraphAwareContent(flattened);
    }
    const element = node;
    if (typeof element.type === "function") {
      return this.renderContent(element.type(element.props));
    }
    if (element.type === "p") return this.renderContent(element.props.children);
    if (element.type === "Fragment") return this.renderContent(element.props.children);
    if (/^h[1-6]$/.test(element.type)) {
      return this.formatHeading(element.type, this.renderContent(element.props.children));
    }
    if (element.type === "x") return this.renderXElement(element.props);
    if (element.type === "section") return this.renderSection(element.props);
    if (element.type === "br") return "\n";
    if (element.type === "pre") return this.renderPreContent(element.props.children);
    if (element.type === "ul") return this.renderUnorderedList(element.props.children);
    if (element.type === "ol") return this.renderOrderedList(element.props.children);
    if (element.type === "li") return `- ${this.renderContent(element.props.children)}`;
    return this.renderToMessages(element).map(message => message.content).join("\n");
  }

  private renderParagraphAwareContent(nodes: PromptNode[]): string {
    const flattenedNodes = this.flattenNodes(nodes);
    const paragraphs: RenderParagraph[] = [];
    let currentParagraph: string[] = [];
    const flushCurrentParagraph = (): void => {
      if (currentParagraph.length > 0) {
        const content = currentParagraph.join("");
        if (content.trim()) {
          paragraphs.push({ content: this.normalizeWhitespace(content), isSection: false });
        } else if (content.includes("\n")) {
          paragraphs.push({ content, isSection: false });
        }
        currentParagraph = [];
      }
    };
    for (const node of flattenedNodes) {
      if (isElement(node)) {
        const element = node;
        if (typeof element.type === "function") {
          const resolvedNode = element.type(element.props);
          if (this.isBlockElement(resolvedNode)) {
            flushCurrentParagraph();
            const content = this.renderContentNode(resolvedNode);
            if (content.trim()) {
              paragraphs.push({ content: content.trim(), isSection: this.isSectionElement(resolvedNode) });
            }
          } else {
            const resolvedNodes = this.flattenNodes(
              Array.isArray(resolvedNode) ? resolvedNode : [resolvedNode],
            );
            for (const resolvedChild of resolvedNodes) {
              const rendered = this.renderContentNode(resolvedChild);
              if (rendered) currentParagraph.push(rendered);
            }
          }
        } else if (
          element.type === "p" || element.type === "section" ||
          element.type === "ul" || element.type === "ol" ||
          /^h[1-6]$/.test(element.type) || element.type === "x" || element.type === "pre"
        ) {
          flushCurrentParagraph();
          const content = this.renderContentNode(element);
          const isPre = element.type === "pre";
          const finalContent = isPre ? content : content.trim();
          if (finalContent || isPre) {
            paragraphs.push({ content: finalContent, isSection: element.type === "section" });
          }
        } else {
          const rendered = this.renderContentNode(node);
          if (rendered !== null && rendered !== undefined) currentParagraph.push(rendered);
        }
      } else {
        const rendered = this.renderContentNode(node);
        if (rendered) currentParagraph.push(rendered);
      }
    }
    flushCurrentParagraph();
    if (paragraphs.length === 0) return "";
    let result = paragraphs[0]!.content;
    for (let index = 1; index < paragraphs.length; index++) {
      const previous = paragraphs[index - 1]!;
      const current = paragraphs[index]!;
      const currentIsOnlyNewlines = !current.content.trim();
      const previousHasContentAndEndsWithNewline =
        previous.content.trim() && previous.content.endsWith("\n");
      if (currentIsOnlyNewlines) result += current.content;
      else if (previousHasContentAndEndsWithNewline) result += current.content;
      else result += `\n\n${current.content}`;
    }
    return result.replace(/^\n+/, "").replace(/\n+$/, "");
  }

  private flattenNodes(nodes: PromptNode[]): PromptNode[] {
    const result: PromptNode[] = [];
    for (const node of nodes) {
      if (node == null || typeof node === "boolean") continue;
      if (Array.isArray(node)) {
        result.push(...this.flattenNodes(node));
      } else if (isElement(node)) {
        if (node.type === "Fragment") {
          const children = node.props.children;
          if (children != null) {
            result.push(...this.flattenNodes(Array.isArray(children) ? children : [children]));
          }
        } else if (typeof node.type === "function") {
          const resolvedNode = node.type(node.props);
          if (resolvedNode != null) {
            result.push(...this.flattenNodes(Array.isArray(resolvedNode) ? resolvedNode : [resolvedNode]));
          }
        } else {
          result.push(node);
        }
      } else {
        result.push(node);
      }
    }
    return result;
  }

  private formatHeading(type: string, content: string): string {
    if (!content.trim()) return "";
    const headingLevel = Number.parseInt(type.slice(1), 10);
    return `${"#".repeat(headingLevel)} ${content.trim()}`;
  }

  private renderXElement(props: PromptProps): string {
    const { children, key: _key, tag, ...attributes } = props;
    const tagName = tag || "x";
    const content = this.renderContent(children);
    const attributeString = Object.keys(attributes)
      .filter(attribute => attributes[attribute] != null)
      .map(attribute => {
        const value = attributes[attribute];
        if (typeof value === "boolean") return value ? attribute : "";
        return `${attribute}="${String(value).replace(/"/g, "&quot;")}"`;
      })
      .filter(attribute => attribute)
      .join(" ");
    const attributePrefix = attributeString ? ` ${attributeString}` : "";
    return !content.trim()
      ? `<${String(tagName)}${attributePrefix} />`
      : `<${String(tagName)}${attributePrefix}>${content}</${String(tagName)}>`;
  }

  private renderSection(props: PromptProps): string {
    const { children, key: _key, title, ...attributes } = props;
    const tagName = String(title).toLowerCase().replace(/\s+/g, "-");
    const content = this.renderContent(children);
    const attributeString = Object.keys(attributes)
      .filter(attribute => attributes[attribute] != null)
      .map(attribute => {
        const value = attributes[attribute];
        if (typeof value === "boolean") return value ? attribute : "";
        return `${attribute}="${String(value).replace(/"/g, "&quot;")}"`;
      })
      .filter(attribute => attribute)
      .join(" ");
    const attributePrefix = attributeString ? ` ${attributeString}` : "";
    return !content.trim()
      ? `<${tagName}${attributePrefix} />`
      : `<${tagName}${attributePrefix}>\n${content}\n</${tagName}>`;
  }

  private renderOrderedList(children: PromptNode, indent = 0, baseIndentWidth = 0): string {
    if (children == null) return "";
    const items: string[] = [];
    let itemNumber = 1;
    const indentString = " ".repeat(baseIndentWidth);
    const markerWidth = 3;
    const flattenedChildren = this.flattenListChildren(
      Array.isArray(children) ? children : [children],
    );
    for (const child of flattenedChildren) {
      if (isElement(child)) {
        if (child.type === "li") {
          const { textContent, nestedLists } = this.extractListItemContent(
            child.props.children,
            indent + 1,
            baseIndentWidth + markerWidth,
          );
          if (textContent.trim() || nestedLists.length > 0) {
            if (textContent.trim()) {
              items.push(`${indentString}${itemNumber}. ${textContent.trim()}`);
              items.push(...nestedLists);
            } else if (nestedLists.length > 0) {
              const combinedNested = nestedLists.join("\n");
              const firstNewline = combinedNested.indexOf("\n");
              const totalIndent = baseIndentWidth + markerWidth;
              if (firstNewline === -1) {
                items.push(`${indentString}${itemNumber}. ${combinedNested.trimStart()}`);
              } else {
                const firstLine = combinedNested.substring(0, firstNewline);
                const rest = combinedNested.substring(firstNewline + 1);
                items.push(`${indentString}${itemNumber}. ${firstLine.trimStart()}`);
                items.push(rest.split("\n").map(line =>
                  " ".repeat(totalIndent) + line.trimStart()
                ).join("\n"));
              }
            }
            itemNumber++;
          }
        } else {
          const rendered = this.renderContentNode(child);
          if (rendered.trim()) items.push(indentString + rendered.trim());
        }
      } else {
        const rendered = this.renderContentNode(child);
        if (rendered.trim()) items.push(indentString + rendered.trim());
      }
    }
    return items.join("\n");
  }

  private renderUnorderedList(children: PromptNode, indent = 0, baseIndentWidth = 0): string {
    if (children == null) return "";
    const items: string[] = [];
    const indentString = " ".repeat(baseIndentWidth);
    const markerWidth = 2;
    const flattenedChildren = this.flattenListChildren(
      Array.isArray(children) ? children : [children],
    );
    for (const child of flattenedChildren) {
      if (isElement(child)) {
        if (child.type === "li") {
          const { textContent, nestedLists } = this.extractListItemContent(
            child.props.children,
            indent + 1,
            baseIndentWidth + markerWidth,
          );
          if (textContent.trim() || nestedLists.length > 0) {
            if (textContent.trim()) items.push(`${indentString}- ${textContent.trim()}`);
            items.push(...nestedLists);
          }
        } else {
          const rendered = this.renderContentNode(child);
          if (rendered.trim()) items.push(indentString + rendered.trim());
        }
      } else {
        const rendered = this.renderContentNode(child);
        if (rendered.trim()) items.push(indentString + rendered.trim());
      }
    }
    return items.join("\n");
  }

  private flattenListChildren(children: PromptNode[]): PromptNode[] {
    const flattened: PromptNode[] = [];
    for (const child of children) {
      if (Array.isArray(child)) flattened.push(...this.flattenListChildren(child));
      else flattened.push(child);
    }
    return flattened;
  }

  private extractListItemContent(
    children: PromptNode,
    nestedIndent: number,
    baseIndentWidth = 0,
  ): { textContent: string; nestedLists: string[] } {
    if (children == null) return { textContent: "", nestedLists: [] };
    const textParts: string[] = [];
    const nestedLists: string[] = [];
    const flattenedChildren = this.flattenListChildren(
      Array.isArray(children) ? children : [children],
    );
    for (const child of flattenedChildren) {
      if (isElement(child)) {
        let element = child;
        if (typeof element.type === "function") {
          const resolvedNode = element.type(element.props);
          if (isElement(resolvedNode)) element = resolvedNode;
          else {
            const rendered = this.renderContent(resolvedNode);
            if (rendered) textParts.push(rendered);
            continue;
          }
        }
        if (element.type === "ul") {
          const rendered = this.renderUnorderedList(
            element.props.children,
            nestedIndent,
            baseIndentWidth,
          );
          if (rendered.trim()) nestedLists.push(rendered);
        } else if (element.type === "ol") {
          const rendered = this.renderOrderedList(
            element.props.children,
            nestedIndent,
            baseIndentWidth,
          );
          if (rendered.trim()) nestedLists.push(rendered);
        } else {
          const rendered = this.renderContentNode(element);
          if (rendered) textParts.push(rendered);
        }
      } else {
        const rendered = this.renderContentNode(child);
        if (rendered) textParts.push(rendered);
      }
    }
    return { textContent: textParts.join(""), nestedLists };
  }

  private renderPreContent(children: PromptNode): string {
    if (children == null || typeof children === "boolean") return "";
    if (typeof children === "string" || typeof children === "number") return String(children);
    if (Array.isArray(children)) {
      return children.map(child => this.renderPreContent(child)).join("");
    }
    if (typeof children.type === "function") {
      return this.renderPreContent(children.type(children.props));
    }
    if (children.type === "Fragment") return this.renderPreContent(children.props.children);
    if (children.type === "br") return "\n";
    return this.renderPreContent(children.props.children);
  }

  private isBlockElement(node: PromptNode): boolean {
    if (!isElement(node)) return false;
    const type = node.type;
    return type === "p" || type === "section" || type === "ul" || type === "ol" ||
      typeof type === "string" && /^h[1-6]$/.test(type) || type === "x" || type === "pre";
  }

  private isSectionElement(node: PromptNode): boolean {
    return isElement(node) && node.type === "section";
  }

  private normalizeWhitespace(text: string): string {
    const trailingNewlineMatch = text.match(/\n+$/);
    const trailingNewlines = trailingNewlineMatch ? trailingNewlineMatch[0] : "";
    const normalized = text.replace(/ +/g, " ").trim();
    return normalized + trailingNewlines;
  }
}

export function renderContent(element: PromptNode, options?: RenderOptions): string {
  const context = new RenderContext(options || {});
  return context.renderContent(element);
}
