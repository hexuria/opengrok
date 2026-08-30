import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type ParserType from "tree-sitter";

type ParserConstructor = typeof ParserType;

const runtimeRequire = createRequire(
  typeof import.meta.url === "string"
    ? import.meta.url
    : pathToFileURL(typeof __filename === "string" ? __filename : path.join(process.cwd(), "package.json")).href,
);

function runtimeDependencyRoots(): readonly string[] {
  const roots: string[] = [];
  const configured = process.env.SAND_TREE_SITTER_NODE_DEPS?.trim();
  const resourcesPath = (process as NodeJS.Process & { readonly resourcesPath?: string }).resourcesPath;
  const isElectronRuntime = process.versions.electron !== undefined;
  const isPackagedRuntime = process.env.SAND_PACKAGED === "1";

  if (isPackagedRuntime) {
    if (isElectronRuntime) {
      if (resourcesPath !== undefined) {
        roots.push(
          path.join(resourcesPath, "app.asar.unpacked", "dist", "deps"),
          path.join(resourcesPath, "dist", "deps"),
        );
      }
      return roots;
    }

    if (configured) return [path.resolve(configured)];
    const bundleDirectory = typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
    return [path.resolve(bundleDirectory, "..", "node-deps")];
  }

  // A configured root is an explicit developer/test resolution path. It is
  // deliberately not accepted as an override for a packaged Electron load.
  if (configured) return [path.resolve(configured)];

  // Unpackaged source/developer execution resolves through the local package
  // installation below; no packaged-domain fallback is inferred here.
  return roots;
}

function runtimeDependencyDomain(): "electron dist/deps" | "node dist/node-deps" | "developer" {
  if (process.env.SAND_PACKAGED === "1") {
    return process.versions.electron !== undefined ? "electron dist/deps" : "node dist/node-deps";
  }
  return "developer";
}

function runtimeDependencyError(name: string, roots: readonly string[], cause?: unknown): Error {
  const domain = runtimeDependencyDomain();
  const rootText = roots.length === 0 ? "<no staged root>" : roots.join(", ");
  const detail = cause instanceof Error ? ` Loader error: ${cause.message}` : "";
  const error = new Error(
    `shell-parser: cannot load ${name} from the ${domain} runtime domain (searched ${rootText}). `
      + "The ABI-specific tree-sitter packages are missing or incompatible; rebuild and stage the matching runtime, "
      + "and refusing cross-ABI fallback." + detail,
  );
  Object.assign(error, {
    code: "SAND_TREE_SITTER_RUNTIME_UNAVAILABLE",
    dependency: name,
    domain,
    roots: [...roots],
    cause,
  });
  return error;
}

function loadDeveloperDependency<T>(name: string): T {
  // Resolve from the module's local developer installation explicitly. This
  // path is available only outside a packaged runtime.
  const localPath = runtimeRequire.resolve(name);
  return runtimeRequire(localPath) as T;
}

function loadRuntimeDependency<T>(name: string): T {
  const roots = runtimeDependencyRoots();
  if (process.env.SAND_PACKAGED !== "1" && roots.length === 0) return loadDeveloperDependency<T>(name);

  for (const root of roots) {
    const packageDirectory = path.join(root, name);
    if (!existsSync(path.join(packageDirectory, "package.json"))) continue;
    try {
      return runtimeRequire(packageDirectory) as T;
    } catch (cause: unknown) {
      // A native load failure is terminal; never retry another ABI domain or
      // the developer's root node_modules.
      throw runtimeDependencyError(name, roots, cause);
    }
  }
  throw runtimeDependencyError(name, roots);
}

const Parser = loadRuntimeDependency<ParserConstructor>("tree-sitter");
const bashLanguage = loadRuntimeDependency<unknown>("tree-sitter-bash");

export interface ShellCommandArgument {
  readonly type: string;
  readonly value: string;
}

export interface ShellExecutableCommand {
  readonly name: string;
  readonly args: readonly ShellCommandArgument[];
  readonly fullText: string;
}

export interface ShellRedirect {
  readonly operator: string;
  readonly destinationFds: readonly number[];
  readonly targetNodeType: string;
  readonly targetText?: string;
}

export interface ShellCommandParsingResult {
  readonly parsingFailed: boolean;
  readonly executableCommands: readonly ShellExecutableCommand[];
  readonly hasRedirects: boolean;
  readonly hasCommandSubstitution: boolean;
  readonly allRedirectsAreDevNull?: boolean;
  readonly redirects: readonly ShellRedirect[];
}

export interface LegacyShellCommandAnalysis {
  readonly simpleCommands: readonly string[];
  readonly hasInputRedirect: boolean;
  readonly hasOutputRedirect: boolean;
}

export interface ShellCommandAnalysis {
  readonly legacy: LegacyShellCommandAnalysis;
  readonly structured: ShellCommandParsingResult;
}

export const TREE_SITTER_STUBBED_ERROR_CODE = "CURSOR_TREE_SITTER_STUBBED";

let cachedParser: ParserType | null | undefined;

function isStubbedTreeSitterError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === TREE_SITTER_STUBBED_ERROR_CODE;
}

function getParser(): ParserType | null {
  if (cachedParser !== undefined) return cachedParser;
  try {
    const parser = new Parser();
    parser.setLanguage(bashLanguage);
    cachedParser = parser;
  } catch (error: unknown) {
    if (!isStubbedTreeSitterError(error)) throw error;
    cachedParser = null;
    console.warn("shell-parser: tree-sitter natives are unavailable in this artifact; shell command analysis degrades to parsingFailed");
  }
  return cachedParser;
}

const redirectNodeTypes = new Set([
  "file_redirect",
  "heredoc_redirect",
  "herestring_redirect",
  "heredoc",
  "here_string",
  "redirect",
  "redirection",
]);

const fileRedirectOperatorTypes = new Set([
  "<",
  ">",
  ">>",
  ">|",
  "<>",
  "<&",
  ">&",
  "&>",
  "&>>",
]);

function parsingFailedResult(): ShellCommandAnalysis {
  return {
    legacy: {
      simpleCommands: [],
      hasInputRedirect: false,
      hasOutputRedirect: false,
    },
    structured: {
      parsingFailed: true,
      executableCommands: [],
      hasRedirects: false,
      hasCommandSubstitution: false,
      redirects: [],
    },
  };
}

export function analyzeShellCommand(cmd: string): ShellCommandAnalysis {
  const parser = getParser();
  if (parser === null) return parsingFailedResult();

  const tree = parser.parse(cmd);
  const processedRedirectNodes = new WeakSet<ParserType.SyntaxNode>();
  let sawRedirect = false;
  let allRedirectsAreAllowlistSafe = true;
  const legacy = {
    simpleCommands: [] as string[],
    hasInputRedirect: false,
    hasOutputRedirect: false,
  };
  const structured: {
    parsingFailed: boolean;
    executableCommands: ShellExecutableCommand[];
    hasRedirects: boolean;
    hasCommandSubstitution: boolean;
    allRedirectsAreDevNull?: boolean;
    redirects: ShellRedirect[];
  } = {
    parsingFailed: false,
    executableCommands: [],
    hasRedirects: false,
    hasCommandSubstitution: false,
    redirects: [],
  };

  const recordRedirect = (isAllowlistSafe: boolean): void => {
    sawRedirect = true;
    structured.hasRedirects = true;
    allRedirectsAreAllowlistSafe = allRedirectsAreAllowlistSafe && isAllowlistSafe;
  };

  const markRedirectsFromText = (txt: string): void => {
    if (/(^|\s)[0-9]*<<?<?/.test(txt)) legacy.hasInputRedirect = true;
    if (/(^|\s)[0-9]*>>/.test(txt) || /(^|\s)[0-9]*>(\||&)?/.test(txt) || /(^|\s)&>/.test(txt) || /(^|\s)[0-9]+>&[0-9]+/.test(txt)) {
      legacy.hasOutputRedirect = true;
    }
  };

  const getFileRedirectParts = (node: ParserType.SyntaxNode): { operator: string; target: ParserType.SyntaxNode | undefined } | undefined => {
    const operatorIndex = node.children.findIndex(child => fileRedirectOperatorTypes.has(child.type));
    if (operatorIndex === -1) return undefined;
    return {
      operator: node.children[operatorIndex]?.type ?? "",
      target: node.children.slice(operatorIndex + 1).find(child => child.type !== "comment"),
    };
  };

  const parseFd = (node: ParserType.SyntaxNode | undefined): number | undefined => {
    if (!node || !/^\d+$/.test(node.text)) return undefined;
    return Number.parseInt(node.text, 10);
  };

  const getExplicitRedirectFd = (node: ParserType.SyntaxNode): number | undefined => parseFd(node.children.find(child => child.type === "file_descriptor"));

  const createRedirectClassificationState = (): { fdTargets: Map<number, string> } => ({
    fdTargets: new Map([
      [0, "original-stdin"],
      [1, "original-stdout"],
      [2, "original-stderr"],
    ]),
  });

  const isAllowlistSafeOutputTarget = (target: string | undefined): boolean => target === "original-stdout" || target === "original-stderr" || target === "dev-null";

  const getRedirectDestinationFds = (node: ParserType.SyntaxNode, operator: string): number[] => {
    if (operator === "&>" || operator === "&>>") return [1, 2];
    const explicitFd = getExplicitRedirectFd(node);
    if (explicitFd !== undefined) return [explicitFd];
    return operator.startsWith("<") ? [0] : [1];
  };

  const markRedirectLegacyFields = (node: ParserType.SyntaxNode): void => {
    markRedirectsFromText(node.text);
    if (node.type === "heredoc_redirect" || node.type === "herestring_redirect") legacy.hasInputRedirect = true;
  };

  const getHeredocReceiverCommandName = (node: ParserType.SyntaxNode): string | undefined => {
    const redirectedStatement = node.parent;
    if (redirectedStatement?.type !== "redirected_statement") return undefined;
    const commandNode = redirectedStatement.children.find(child => child.type === "command");
    return commandNode?.childForFieldName("name")?.text;
  };

  const isInsideUnquotedCommandSubstitution = (node: ParserType.SyntaxNode): boolean => {
    let current = node.parent;
    while (current) {
      if (current.type === "command_substitution" && current.parent?.type !== "string") return true;
      current = current.parent;
    }
    return false;
  };

  const classifyHeredocRedirect = (node: ParserType.SyntaxNode): { redirect: ShellRedirect; isAllowlistSafe: boolean } => {
    const receiverCommandName = getHeredocReceiverCommandName(node);
    const isAllowlistSafe = receiverCommandName !== undefined && !isInsideUnquotedCommandSubstitution(node);
    const redirect: ShellRedirect = {
      operator: isAllowlistSafe ? "<<" : "",
      destinationFds: isAllowlistSafe ? [0] : [],
      targetNodeType: node.type,
      ...(isAllowlistSafe ? { targetText: receiverCommandName } : {}),
    };
    return { redirect, isAllowlistSafe };
  };

  const isExactDevNullTarget = (node: ParserType.SyntaxNode | undefined): boolean => {
    if (!node) return false;
    if (node.type === "word") return node.text === "/dev/null";
    if (node.type === "raw_string") return node.text === "'/dev/null'";
    if (node.type === "string") {
      const namedChildren = node.namedChildren;
      return namedChildren.length === 1 && namedChildren[0]?.type === "string_content" && namedChildren[0].text === "/dev/null";
    }
    return false;
  };

  const getStaticRedirectTargetText = (node: ParserType.SyntaxNode | undefined): string | undefined => {
    if (!node) return undefined;
    if (node.type === "word") return node.namedChildren.length === 0 ? node.text : undefined;
    if (node.type === "number") return node.text;
    if (node.type === "raw_string") return node.text.length < 2 ? undefined : node.text.slice(1, -1);
    if (node.type === "string") {
      const namedChildren = node.namedChildren;
      if (namedChildren.length === 0 || namedChildren.some(child => child.type !== "string_content")) return undefined;
      return namedChildren.map(child => child.text).join("");
    }
    return undefined;
  };

  const classifyFileRedirect = (node: ParserType.SyntaxNode, state: { fdTargets: Map<number, string> }): boolean => {
    const parts = getFileRedirectParts(node);
    if (!parts) return false;
    const { operator, target } = parts;
    const destinationFds = getRedirectDestinationFds(node, operator);
    const targetText = getStaticRedirectTargetText(target);
    const redirect: ShellRedirect = {
      operator,
      destinationFds,
      targetNodeType: target?.type ?? "",
      ...(targetText !== undefined ? { targetText } : {}),
    };
    structured.redirects.push(redirect);
    if (operator === ">&") {
      const sourceFd = parseFd(target);
      const sourceTarget = sourceFd === undefined ? undefined : state.fdTargets.get(sourceFd);
      if (!isAllowlistSafeOutputTarget(sourceTarget)) {
        for (const fd of destinationFds) state.fdTargets.set(fd, "unsafe");
        return false;
      }
      for (const fd of destinationFds) state.fdTargets.set(fd, sourceTarget!);
      return true;
    }
    if (operator === "<&") {
      const sourceFd = parseFd(target);
      const sourceTarget = sourceFd === undefined ? undefined : state.fdTargets.get(sourceFd);
      if (sourceTarget !== "dev-null") {
        for (const fd of destinationFds) state.fdTargets.set(fd, "unsafe");
        return false;
      }
      for (const fd of destinationFds) state.fdTargets.set(fd, sourceTarget);
      return true;
    }
    if (!isExactDevNullTarget(target)) {
      for (const fd of destinationFds) state.fdTargets.set(fd, "unsafe");
      return false;
    }
    for (const fd of destinationFds) state.fdTargets.set(fd, "dev-null");
    return true;
  };

  const processRedirectNode = (node: ParserType.SyntaxNode, state: { fdTargets: Map<number, string> }): void => {
    if (processedRedirectNodes.has(node)) return;
    processedRedirectNodes.add(node);
    markRedirectLegacyFields(node);
    if (node.type === "heredoc_redirect") {
      const { redirect, isAllowlistSafe } = classifyHeredocRedirect(node);
      structured.redirects.push(redirect);
      recordRedirect(isAllowlistSafe);
      return;
    }
    if (node.type !== "file_redirect") {
      structured.redirects.push({ operator: "", destinationFds: [], targetNodeType: node.type });
      recordRedirect(false);
      return;
    }
    recordRedirect(classifyFileRedirect(node, state));
  };

  const processDirectRedirectChildren = (node: ParserType.SyntaxNode): void => {
    const state = createRedirectClassificationState();
    for (const child of node.children) {
      if (redirectNodeTypes.has(child.type)) processRedirectNode(child, state);
    }
  };

  function traverse(node: ParserType.SyntaxNode): void {
    const type = node.type;
    processDirectRedirectChildren(node);
    if (redirectNodeTypes.has(type) && !processedRedirectNodes.has(node)) processRedirectNode(node, createRedirectClassificationState());
    if (type === "command") {
      const commandName = node.childForFieldName("name");
      if (commandName === null) {
        structured.parsingFailed = true;
      } else {
        legacy.simpleCommands.push(commandName.text);
        let commandFullText = commandName.text;
        const commandArgs: ShellCommandArgument[] = [];
        for (const arg of node.childrenForFieldName("argument")) {
          commandArgs.push({ type: arg.type, value: arg.text });
          commandFullText += ` ${arg.text}`;
        }
        structured.executableCommands.push({ name: commandName.text, args: commandArgs, fullText: commandFullText });
      }
    }
    if (type === "command_name" || type === "simple_command") {
      if (type === "command_name" && !legacy.simpleCommands.includes(node.text)) {
        legacy.simpleCommands.push(node.text);
      } else if (type === "simple_command") {
        const firstChild = node.firstNamedChild;
        if (firstChild && firstChild.type === "command_name") {
          if (!legacy.simpleCommands.includes(firstChild.text)) legacy.simpleCommands.push(firstChild.text);
        } else {
          legacy.simpleCommands.push(node.text);
        }
      }
    }
    if (type === "command_substitution" || type === "process_substitution") structured.hasCommandSubstitution = true;
    for (const child of node.children) traverse(child);
  }

  traverse(tree.rootNode);
  if (sawRedirect) structured.allRedirectsAreDevNull = allRedirectsAreAllowlistSafe;
  return { legacy, structured };
}
