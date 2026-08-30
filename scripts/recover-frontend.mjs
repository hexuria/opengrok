import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "acorn";
import { simple as walkAst } from "acorn-walk";
import { transform } from "esbuild";
import { recoveredFrontendDir, recoveredRendererDir, sourceAppDir } from "./lib/config.mjs";

const sourceRenderer = path.join(sourceAppDir, "dist", "renderer");
const reportsDir = path.join(recoveredFrontendDir, "reports");

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function importsFrom(source) {
  const imports = [];
  const patterns = [
    { kind: "dynamic", regex: /import\(\s*["'](\.[^"']+)["']\s*\)/g },
    { kind: "static", regex: /(?:from\s*|import\s*)["'](\.[^"']+)["']/g }
  ];
  for (const { kind, regex } of patterns) {
    for (const match of source.matchAll(regex)) imports.push({ kind, target: match[1] });
  }
  return imports;
}

function candidateStrings(source) {
  const values = [];
  for (const match of source.matchAll(/"((?:\\.|[^"\\]){4,160})"/g)) {
    let value;
    try {
      value = JSON.parse(`"${match[1]}"`);
    } catch {
      continue;
    }
    if (!/[A-Za-z]{3}/.test(value)) continue;
    if (/^[A-Za-z0-9_./:@-]+$/.test(value) && !value.includes(" ")) continue;
    if (/[{}<>]{3,}|\\[dDsSwW]|source\.|constant\.|punctuation\./.test(value)) continue;
    values.push(value.replace(/\s+/g, " ").trim());
  }
  return values;
}

function reactComponentCandidates(source) {
  const ast = parse(source, {
    allowHashBang: true,
    ecmaVersion: "latest",
    locations: true,
    sourceType: "module"
  });
  const candidates = [];
  const record = (name, node, kind) => {
    const body = source.slice(node.start, node.end);
    const jsxCalls = (body.match(/\.(?:jsx|jsxs)\(/g) ?? []).length;
    const createElementCalls = (body.match(/\.createElement\(/g) ?? []).length;
    if (jsxCalls + createElementCalls === 0) return;
    candidates.push({
      name,
      kind,
      startLine: node.loc.start.line,
      endLine: node.loc.end.line,
      jsxCalls,
      createElementCalls
    });
  };

  walkAst(ast, {
    FunctionDeclaration(node) {
      record(node.id?.name ?? "<anonymous>", node, "declaration");
    },
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier") return;
      if (node.init?.type !== "ArrowFunctionExpression" && node.init?.type !== "FunctionExpression") return;
      record(node.id.name, node.init, node.init.type === "ArrowFunctionExpression" ? "arrow" : "expression");
    }
  });
  return candidates.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
}

await rm(recoveredRendererDir, { recursive: true, force: true });
await rm(reportsDir, { recursive: true, force: true });
await mkdir(recoveredRendererDir, { recursive: true });
await mkdir(reportsDir, { recursive: true });

const manifest = [];
const importRows = ["source\tkind\ttarget"];
const uiStrings = new Set();

for (const sourcePath of (await walk(sourceRenderer)).sort()) {
  const relative = path.relative(sourceRenderer, sourcePath);
  const destination = path.join(recoveredRendererDir, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  const extension = path.extname(sourcePath).toLowerCase();
  const sourceBytes = await readFile(sourcePath);
  let transformed = false;
  let outputBytes = sourceBytes;

  if (extension === ".js" || extension === ".mjs" || extension === ".css") {
    const sourceText = sourceBytes.toString("utf8");
    const loader = extension === ".css" ? "css" : "js";
    const result = await transform(sourceText, {
      loader,
      format: loader === "js" ? "esm" : undefined,
      legalComments: "inline",
      minify: false,
      sourcefile: `upstream/${relative}`,
      sourcemap: "external",
      target: "esnext",
      treeShaking: false
    });
    const mapName = `${path.basename(destination)}.map`;
    outputBytes = Buffer.from(`${result.code.trimEnd()}\n/*# sourceMappingURL=${mapName} */\n`);
    await writeFile(`${destination}.map`, result.map);
    transformed = true;

    if (loader === "js") {
      for (const item of importsFrom(sourceText)) {
        importRows.push(`${relative}\t${item.kind}\t${item.target}`);
      }
      if (relative === "assets/index-UbX-y3il.js" || /^assets\/(?:view-|messages-|channel-|connector-card-)/.test(relative)) {
        for (const value of candidateStrings(sourceText)) uiStrings.add(value);
      }
    }
  } else {
    await cp(sourcePath, destination, { preserveTimestamps: true });
  }

  if (transformed) await writeFile(destination, outputBytes);
  const outputStats = await stat(destination);
  manifest.push({
    path: relative,
    sha256: sha256(sourceBytes),
    sourceBytes: sourceBytes.length,
    outputBytes: outputStats.size,
    transformed
  });
}

await writeFile(
  path.join(reportsDir, "manifest.json"),
  `${JSON.stringify({ files: manifest }, null, 2)}\n`
);
await writeFile(path.join(reportsDir, "imports.tsv"), `${importRows.join("\n")}\n`);
await writeFile(
  path.join(reportsDir, "candidate-ui-strings.txt"),
  `${[...uiStrings].sort((a, b) => a.localeCompare(b)).join("\n")}\n`
);

const recoveredMain = await readFile(
  path.join(recoveredRendererDir, "assets", "index-UbX-y3il.js"),
  "utf8"
);
const componentRows = ["name\tkind\tstart_line\tend_line\tjsx_calls\tcreate_element_calls"];
for (const candidate of reactComponentCandidates(recoveredMain)) {
  componentRows.push([
    candidate.name,
    candidate.kind,
    candidate.startLine,
    candidate.endLine,
    candidate.jsxCalls,
    candidate.createElementCalls
  ].join("\t"));
}
await writeFile(
  path.join(reportsDir, "react-component-candidates.tsv"),
  `${componentRows.join("\n")}\n`
);

const transformedCount = manifest.filter((entry) => entry.transformed).length;
console.log(`Recovered ${transformedCount} JavaScript/CSS assets out of ${manifest.length} renderer files.`);
console.log(`Runnable expanded renderer: ${recoveredRendererDir}`);
