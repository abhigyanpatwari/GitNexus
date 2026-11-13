/**
 * Java on-demand import workload for #3695; run in a fresh process with --expose-gc.
 *
 *   node --expose-gc --import tsx bench/scope-resolution/wildcard-java.mts 700 700 --check
 *
 * `importers` files each write `import big.*;` over a package of `packageFiles`
 * files and use one of its types. The relation has importers x packageFiles
 * pairs; the pass must not hold anything per pair.
 */
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { SupportedLanguages, type ImportVisibility } from 'gitnexus-shared';
import { parseFilesWithWorkers } from '../../test/helpers/worker-parse.js';
import { SCOPE_RESOLVERS } from '../../src/core/ingestion/scope-resolution/pipeline/registry.js';
import { runScopeResolution } from '../../src/core/ingestion/scope-resolution/pipeline/run.js';

const { values, positionals } = parseArgs({
  options: { check: { type: 'boolean', default: false } },
  allowPositionals: true,
});
assert.ok(positionals.length <= 2, 'Expected importer and package file counts');
const importers = Number(positionals[0] ?? 700);
const packageFiles = Number(positionals[1] ?? 700);
assert.ok([importers, packageFiles].every((value) => Number.isSafeInteger(value) && value > 0));
if (values.check) {
  assert.deepEqual([importers, packageFiles], [700, 700], '--check requires the baseline workload');
}
assert.ok(typeof global.gc === 'function', 'Run with --expose-gc');
const RETAINED_BUDGET_BYTES = 16 * 1024 * 1024;
const liveHeap = (): number => {
  global.gc!();
  global.gc!();
  return process.memoryUsage().heapUsed;
};

const files = [
  ...Array.from({ length: packageFiles }, (_, i) => ({
    path: `src/big/T${i}.java`,
    content: `package big;\npublic class T${i} { public void run() {} }\n`,
  })),
  ...Array.from({ length: importers }, (_, j) => ({
    path: `src/app/U${j}.java`,
    content: `package app;\nimport big.*;\npublic class U${j} { void go(T${j % packageFiles} t) { t.run(); } }\n`,
  })),
];
const parsed = await parseFilesWithWorkers(files, { poolSize: 1 });
assert.equal(parsed.data.parsedFiles.length, files.length, 'Scope extraction omitted files');

const heapBefore = liveHeap();
const started = performance.now();
// Held past the pass on purpose: what the pass keeps for its readers is what is measured.
let imports: ImportVisibility | undefined;
runScopeResolution(
  {
    graph: parsed.graph,
    model: parsed.model,
    files,
    preExtractedParsedFiles: new Map(parsed.data.parsedFiles.map((file) => [file.filePath, file])),
    onResolved: (result) => {
      imports = result.indexes.imports;
    },
  },
  SCOPE_RESOLVERS.get(SupportedLanguages.Java)!,
);
const resolveMs = performance.now() - started;
const retainedBytes = liveHeap() - heapBefore;
assert.ok(imports !== undefined, 'The pass reported no resolution indexes');

let wildcardEdges = 0;
let wildcardTargets = 0;
for (const scope of imports.scopes()) {
  for (const edge of imports.edgesAt(scope) ?? [])
    if (edge.kind === 'wildcard-expanded') wildcardEdges++;
  imports.forEachTarget(scope, (_targetFile, via) => {
    if (via.kind === 'wildcard-expanded') wildcardTargets++;
  });
}
const nodes = [...parsed.graph.iterNodes()].map((n) => JSON.stringify(n));
const edges = [...parsed.graph.iterRelationships()].map((e) => JSON.stringify(e));
const result = {
  importers,
  packageFiles,
  pairs: importers * packageFiles,
  wildcardTargets,
  wildcardEdges,
  importEdges: [...parsed.graph.iterRelationshipsByType('IMPORTS')].length,
  calls: [...parsed.graph.iterRelationshipsByType('CALLS')].length,
  retainedBytes,
  resolveMs,
  peakRssBytes: process.resourceUsage().maxRSS * 1024,
  nodes: nodes.length,
  edges: edges.length,
  fingerprint: createHash('sha256')
    .update([...nodes, ...edges].sort().join('\n'))
    .digest('hex'),
};
console.log('WILDCARD_RESULT', JSON.stringify(result));

// Every importer still reaches every package file, however that is stored.
assert.equal(wildcardTargets, importers * packageFiles, 'A wildcard lost package files');
assert.equal(result.importEdges, importers, 'Each importer uses one package type');
assert.equal(result.calls, importers, 'Each importer calls one method');
if (values.check) {
  assert.equal(wildcardEdges, 0, 'A wildcard import was stored as one edge per package file');
  // Reviewed with one edge per package file and with groups: the same graph,
  // 2,800 nodes and 4,200 relationships.
  assert.equal(
    result.fingerprint,
    'aa89cadc417ee27912cf64f1c18110e327ffd545d81aa3f1857aa1f23ac2e3b0',
    'Wildcard Java graph differs from the reviewed baseline',
  );
  // Measured 4.3 MiB with groups and 54.5 MiB with one edge per package file
  // (490,000 pairs). The budget sits between them with room for the runtime.
  assert.ok(
    retainedBytes <= RETAINED_BUDGET_BYTES,
    `The pass retained ${retainedBytes} bytes for ${result.pairs} import pairs (budget ${RETAINED_BUDGET_BYTES})`,
  );
}
