/**
 * Compare guard-free CFG collection with another source checkout.
 * Run with --expose-gc --import tsx; both checkouts need installed dependencies.
 * Parsing, serialization, and correctness checks stay outside the timed region.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    baseline: { type: 'string' },
    candidate: { type: 'string' },
    workload: { type: 'string', default: 'arguments' },
    pairs: { type: 'string', default: '15' },
    out: { type: 'string' },
    check: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});
if (values.help) {
  console.log(`Usage: node --expose-gc --import tsx bench/cfg/compare-guard-overhead.mjs
  --baseline /path/to/reference/gitnexus [--candidate /path/to/current/gitnexus]
  [--workload arguments|transitive|direct] [--pairs 15] [--out result.json] [--check]

--check requires at least five pairs, samples >=100ms, and <=5% median overhead.
Exact legacy facts, function coverage, and value forwarding are always checked.`);
  process.exit(0);
}
if (!values.baseline || !global.gc) throw new Error('Supply --baseline and run with --expose-gc');
const pairs = Number(values.pairs);
if (!Number.isSafeInteger(pairs) || pairs < 1)
  throw new Error('--pairs must be a positive integer');
if (!['arguments', 'transitive', 'direct'].includes(values.workload)) {
  throw new Error('Unknown workload');
}
const candidate = path.resolve(
  values.candidate ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'),
);
const baseline = path.resolve(values.baseline);
const require = createRequire(path.join(candidate, 'package.json'));
const Parser = require('tree-sitter');
const grammar = require('tree-sitter-typescript').typescript;
const load = (root, relative) =>
  import(pathToFileURL(path.join(root, 'src/core/ingestion', relative)).href);
const versions = [];
for (const root of [baseline, candidate]) {
  const { collectFunctionCfgs } = await load(root, 'cfg/collect.ts');
  const { createTypeScriptCfgVisitor } = await load(root, 'cfg/visitors/typescript.ts');
  versions.push({ collect: collectFunctionCfgs, visitor: createTypeScriptCfgVisitor() });
}
const count = 4000;
const source = Array.from({ length: count }, (_, i) => {
  if (values.workload === 'arguments') {
    return `function f${i}(x:string){ const y="prefix "+x; return consume${i}(y); }`;
  }
  if (values.workload === 'direct') {
    return `function f${i}(x:string){ return consume${i}("prefix "+x); }`;
  }
  return `function f${i}(x:string){ const a="prefix "+x; const b=a+" suffix"; return consume${i}(b); }`;
}).join('');
const parser = new Parser();
parser.setLanguage(grammar);
const tree = parser.parse(source, undefined, { bufferSize: 1024 * 1024 });
const collect = (version) => version.collect(tree.rootNode, version.visitor, 'perf.ts', 0).cfgs;
for (let rep = 0; rep < 3; rep++) for (const version of versions) collect(version);

const median = (numbers) => [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)];
const samples = [[], []];
const heaps = [[], []];
const bytes = [];
for (let rep = 0; rep < pairs; rep++) {
  for (const index of rep % 2 ? [1, 0] : [0, 1]) {
    global.gc();
    const before = process.memoryUsage().heapUsed;
    const start = process.hrtime.bigint();
    const cfgs = collect(versions[index]);
    samples[index].push(Number(process.hrtime.bigint() - start) / 1e6);
    heaps[index].push(process.memoryUsage().heapUsed - before);
    bytes[index] = Buffer.byteLength(JSON.stringify(cfgs));
  }
}

// Gather outputs separately; do not retain previous CFG arrays during timing.
const outputs = versions.map(collect);
const legacy = (cfgs) =>
  JSON.stringify(cfgs, (key, value) =>
    ['refinement', 'refinementSafe', 'primitiveBindings'].includes(key) ? undefined : value,
  );
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const { createFunctionRefinement } = await load(candidate, 'taint/guard-refinement.ts');
const expectedParts = [
  { kind: 'literal', value: 'prefix ' },
  { kind: 'input' },
  ...(values.workload === 'transitive' ? [{ kind: 'literal', value: ' suffix' }] : []),
];
const flatten = (effect) => (effect?.kind === 'concat' ? effect.parts.flatMap(flatten) : [effect]);
let effects = 0;
for (const cfg of outputs[1]) {
  const refinement = createFunctionRefinement(cfg);
  for (const block of cfg.blocks) {
    for (
      let statementIndex = 0;
      statementIndex < (block.statements?.length ?? 0);
      statementIndex++
    ) {
      const statement = block.statements[statementIndex];
      for (let site = 0; site < (statement.sites?.length ?? 0); site++) {
        if (!statement.sites[site].callee?.startsWith('consume')) continue;
        const effect = refinement.argument(block.index, statementIndex, site, 0, 0);
        if (
          effect?.kind === 'concat' &&
          JSON.stringify(flatten(effect)) === JSON.stringify(expectedParts) &&
          refinement.defaultShell(block.index, statementIndex, site)
        )
          effects++;
      }
    }
  }
}
const medians = samples.map(median);
const result = {
  workload: values.workload,
  pairs,
  time_overhead_pct: (medians[1] / medians[0] - 1) * 100,
  serialized_overhead_pct: (bytes[1] / bytes[0] - 1) * 100,
  legacy_equal: hash(legacy(outputs[0])) === hash(legacy(outputs[1])) ? 1 : 0,
  functions_complete: outputs[1].length === count ? 1 : 0,
  forwarding_complete: effects === count ? 1 : 0,
  samples_ms: samples,
  medians_ms: medians,
  bytes,
  // An after-collection heap delta is diagnostic; it is not peak heap.
  heap_growth_medians: heaps.map(median),
  base_hash: hash(legacy(outputs[0])),
  source_hashes: [baseline, candidate].map((root) =>
    hash(fs.readFileSync(path.join(root, 'src/core/ingestion/cfg/visitors/typescript-harvest.ts'))),
  ),
};
const json = JSON.stringify(result, null, 2) + '\n';
if (values.out) fs.writeFileSync(values.out, json);
console.log(json);
if (!result.legacy_equal || !result.functions_complete || !result.forwarding_complete) {
  process.exitCode = 1;
}
if (
  values.check &&
  (pairs < 5 || samples.flat().some((ms) => ms < 100) || result.time_overhead_pct > 5)
) {
  process.exitCode = 1;
}
