#!/usr/bin/env node
// Packaged-install smoke for the bundled tree-sitter runtime and grammars.
// Every registered grammar — including the vendored "optional" ones, which
// ship prebuilds for every supported platform — must load and parse a sample
// cleanly from the INSTALLED package, on the main thread and in a worker
// thread (the parse pipeline's real host). Usage:
//   node scripts/assert-native-parsers.mjs <installed gitnexus dir>
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';

// One sample per grammar key. A key without a sample fails the check, so a new
// grammar cannot ship without packaged coverage.
const SAMPLES = {
  javascript: 'function f(a) { return a + 1; }\n',
  typescript: 'class A { m(x: number): void {} }\n',
  'typescript:tsx': 'const C = () => <div className="x">{1}</div>;\n',
  python: 'def f(x):\n    return x\n',
  java: 'class A { void m() {} }\n',
  csharp: 'class A { void M() {} }\n',
  cpp: 'struct A { void m(); };\nint main() { return 0; }\n',
  'objective-c': '@interface A : NSObject\n- (void)m;\n@end\n',
  go: 'package main\nfunc main() {}\n',
  rust: 'fn main() { let x = 1; }\n',
  php: '<?php function f($a) { return $a; }\n',
  ruby: 'def f(a)\n  a\nend\n',
  vue: 'export default { data() { return {}; } };\n',
  c: 'int add(int a, int b) { return a + b; }\n',
  swift: 'class A { func m() {} }\n',
  dart: 'void main() { print(1); }\n',
  kotlin: 'class A {\n  fun m() {}\n}\n',
  zig: 'pub fn main() void {}\n',
};

async function check(installedDir) {
  const load = (rel) => import(pathToFileURL(path.join(installedDir, rel)).href);
  const Parser = createRequire(path.join(installedDir, 'package.json'))('tree-sitter');
  const { listGrammarSources, getLanguageGrammar } = await load(
    'dist/core/tree-sitter/parser-loader.js',
  );
  const failures = [];
  const keys = listGrammarSources().map((s) => s.key);
  for (const key of keys) {
    const sample = SAMPLES[key];
    if (sample === undefined) {
      failures.push(`${key}: no sample in assert-native-parsers.mjs`);
      continue;
    }
    try {
      const [language, variant] = key.split(':');
      const parser = new Parser();
      parser.setLanguage(getLanguageGrammar(language, variant ? `x.${variant}` : undefined));
      const root = parser.parse(sample).rootNode;
      if (root.hasError || root.namedChildCount === 0) {
        failures.push(`${key}: parsed with errors: ${root.toString().slice(0, 200)}`);
      }
    } catch (err) {
      failures.push(`${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const { PROTO_GRPC_PLUGIN } = await load('dist/core/group/extractors/grpc-patterns/proto.js');
  if (PROTO_GRPC_PLUGIN === null) {
    failures.push('proto: native Protobuf grammar failed to initialize');
  } else {
    const parser = new Parser();
    parser.setLanguage(PROTO_GRPC_PLUGIN.language);
    const found = PROTO_GRPC_PLUGIN.scan(
      parser.parse('syntax = "proto3";\nservice S { rpc M (R) returns (R); }\n'),
    ).map((d) => d.symbolName);
    if (found.join() !== 'S.M') failures.push(`proto: expected [S.M], got [${found}]`);
  }
  return { checked: keys.length + 1, failures };
}

if (!isMainThread) {
  parentPort.postMessage(await check(workerData));
} else {
  const installedDir = path.resolve(process.argv[2] ?? '.');
  const main = await check(installedDir);
  const worker = await new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: installedDir });
    w.once('message', resolve);
    w.once('error', reject);
  });
  const failures = [
    ...main.failures.map((f) => `[main] ${f}`),
    ...worker.failures.map((f) => `[worker] ${f}`),
  ];
  if (failures.length > 0) {
    console.error(`[native-parsers] ${failures.length} failure(s):\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(
    `[native-parsers] ${main.checked} grammar(s) parsed cleanly on the main thread and in a worker`,
  );
}
