// Isolate retained JS heap from whole-process RSS. Run with --expose-gc.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const root = path.resolve(option('--root', '.'));
const language = option('--language', 'java');
const count = Number(option('--declarations', '10000'));
assert(global.gc, 'Run node with --expose-gc');
assert(['java', 'typescript'].includes(language));
assert(Number.isSafeInteger(count) && count > 0);
const load = (name) => import(pathToFileURL(path.join(root, 'dist', name)));
const Parser = createRequire(path.join(root, 'package.json'))('tree-sitter');
const { getLanguageGrammar } = await load('core/tree-sitter/parser-loader.js');
const { createMethodExtractor } = await load('core/ingestion/method-extractors/generic.js');
const { buildMethodProps } = await load('core/ingestion/utils/method-props.js');
const java = language === 'java';
const configModule = await load(
  `core/ingestion/method-extractors/configs/${java ? 'jvm' : 'typescript-javascript'}.js`,
);
const config = configModule[`${language}MethodConfig`];
const arityModule = await load(`core/ingestion/languages/${language}/arity-metadata.js`);
const arity = arityModule[java ? 'computeJavaArityMetadata' : 'computeTsArityMetadata'];
const extractor = createMethodExtractor(config);
const parser = new Parser();
parser.setLanguage(getLanguageGrammar(language));
const source = `class C {\n${Array.from({ length: count }, (_, i) =>
  java
    ? `int f${i}(int x, String y) { return x; }`
    : `f${i}(x: number, y: string): number { return x; }`,
).join('\n')}\n}`;
const nodeType = java ? 'method_declaration' : 'method_definition';
const context = { filePath: `fixture.${java ? 'java' : 'ts'}`, language };

async function heap() {
  // WeakRef targets and pending native finalizers need a new event-loop turn.
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    global.gc();
  }
  return process.memoryUsage().heapUsed;
}

// Warm module/class initialization separately from the measured tree.
for (let i = 0; i < 20; i++) {
  const warm = parser.parse(
    java
      ? 'class W { int f(int x, String y) { return x; } }'
      : 'class W { f(x: number, y: string): number { return x; } }',
  );
  const node = warm.rootNode.descendantsOfType(nodeType)[0];
  arity(node);
  buildMethodProps(extractor.extractFromNode(node, context));
}
const emptyHeap = await heap();
let tree = parser.parse(source);
assert(!tree.rootNode.hasError);
let nodes = tree.rootNode.descendantsOfType(nodeType);
assert.equal(nodes.length, count);
const treeHeap = await heap();
function extract(declarations) {
  const methods = [];
  const emitted = [];
  const start = performance.now();
  for (const node of declarations) {
    const scope = arity(node);
    const method = extractor.extractFromNode(node, context);
    assert(method);
    methods.push(method);
    emitted.push({ scope, graph: buildMethodProps(method) });
  }
  return { methods, emitted, extractionMs: performance.now() - start };
}
let { methods, emitted, extractionMs } = extract(nodes);
const liveHeap = await heap();
assert.equal(methods.length, count); // Keep the method records live through the heap sample.
const digest = createHash('sha256').update(JSON.stringify(emitted)).digest('hex');
methods = null;
const emittedWithTreeHeap = await heap();
const weakTree = new WeakRef(tree);
nodes = null;
tree = null;
const emittedHeap = await heap();
const treeCollected = weakTree.deref() === undefined;
emitted = null;
const releasedHeap = await heap();
console.log(
  JSON.stringify({
    language,
    declarations: count,
    digest,
    extractionMs,
    treeCollected,
    heapBytes: { emptyHeap, treeHeap, liveHeap, emittedWithTreeHeap, emittedHeap, releasedHeap },
    extractionRetainedBytes: liveHeap - treeHeap,
    emittedRetainedBytes: emittedHeap - emptyHeap,
    releasedDeltaBytes: releasedHeap - emptyHeap,
    processMaxRssMiB: process.resourceUsage().maxRSS / 1024,
    note: 'Fresh process; forced-GC JS heap, not native or worker heap. Extraction time excludes parse/GC. Peak RSS is for this probe only. Compare repeated same-runtime runs.',
  }),
);
