import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const targets = [
  {
    path: "node_modules/@connectrpc/connect/dist/esm/protocol-connect/transport.js",
    stockSha256: "5d9e5b823eaeee1d18f9a98ef7dc4c392b46f8b6d0f6c843116c9e85dd27cd92",
    patchedSha256: "ac07be449192be33f9082b10db53416018e7fc068614093b2dda9c9c62411445",
    stock: "                        body = createAsyncIterable([requestBody]);\n",
  },
  {
    path: "node_modules/@connectrpc/connect/dist/cjs/protocol-connect/transport.js",
    stockSha256: "affac422964a9e948d77abe41819390be705ead6e67fcdcdfc425cdd956b7b5a",
    patchedSha256: "d3be1bb5752b0af6c4359af05ea45fd9694232a8e6af643fe0b741e4eb7680f4",
    stock: "                        body = (0, async_iterable_js_1.createAsyncIterable)([requestBody]);\n",
  },
  {
    path: "node_modules/tree-sitter/binding.gyp",
    stockSha256: "d94979694bc3b1854ba0030be33e9941df9867f99d956117b704e9cfaca37a7d",
    patchedSha256: "8f7eb83b314277458e41d0096c03d58849c2921ee8705b14376b712e1eb647d4",
    transform(source) {
      const cxxstd = [
        '    "v8_enable_31bit_smis_on_64bit_arch%": 0,',
        '    "cxxstd%": "<!(node -p \\"parseInt(process.env.npm_config_target ?? process.versions.node) < 22 ? \'c++17\' : \'c++20\'\\")",',
        "",
      ].join("\n");
      return source
        .replace(`      "cflags": [\n        "-std=c++17"\n      ],\n      "cflags_cc": [\n        "-std=c++17"\n      ],\n`, "")
        .replace('"CLANG_CXX_LANGUAGE_STANDARD": "c++17"', '"CLANG_CXX_LANGUAGE_STANDARD": "<(cxxstd)"')
        .replace('"/std:c++17"', '"/std:<(cxxstd)"')
        .replace('          "cflags_cc": [\n            "-Wno-cast-function-type"\n', '          "cflags_cc": [\n            "-std=<(cxxstd)",\n            "-Wno-cast-function-type",\n')
        .replace('    "v8_enable_31bit_smis_on_64bit_arch%": 0,\n', cxxstd);
    },
  },
];

const addition =
  "                        if (requestBody.length === 0) {\n" +
  "                            req.header.set(\"Content-Length\", \"0\");\n" +
  "                        }\n";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

for (const target of targets) {
  const absolute = path.join(repoRoot, target.path);
  const source = await readFile(absolute, "utf8");
  const before = sha256(source);
  if (before === target.patchedSha256) continue;
  if (before !== target.stockSha256) {
    throw new Error(
      `Refusing to patch unexpected @connectrpc/connect input ${target.path}: ${before}`,
    );
  }
  let patched;
  if (target.transform) {
    patched = target.transform(source);
  } else {
    const first = source.indexOf(target.stock);
    if (first < 0 || source.indexOf(target.stock, first + target.stock.length) >= 0) {
      throw new Error(`Patch anchor is not unique in ${target.path}`);
    }
    patched = source.slice(0, first + target.stock.length)
      + (target.replacement ?? addition)
      + source.slice(first + target.stock.length);
  }
  const after = sha256(patched);
  if (after !== target.patchedSha256) {
    throw new Error(`Connect patch output drifted for ${target.path}: ${after}`);
  }
  await writeFile(absolute, patched);
}
