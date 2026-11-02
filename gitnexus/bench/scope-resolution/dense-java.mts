/** Dense Java workload for investigating #3695; run in a fresh process. */
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { SupportedLanguages } from 'gitnexus-shared';
import { parseFilesWithWorkers } from '../../test/helpers/worker-parse.js';
import { SCOPE_RESOLVERS } from '../../src/core/ingestion/scope-resolution/pipeline/registry.js';
import { runScopeResolution } from '../../src/core/ingestion/scope-resolution/pipeline/run.js';

const { values, positionals } = parseArgs({
  options: { check: { type: 'boolean', default: false } },
  allowPositionals: true,
});
assert.ok(positionals.length <= 3, 'Expected file, method and call counts');
const count = Number(positionals[0] ?? 300);
const methods = Number(positionals[1] ?? 20);
const calls = Number(positionals[2] ?? 10);
assert.ok([count, methods, calls].every((value) => Number.isSafeInteger(value) && value > 0));
assert.ok(count >= 2, 'Use at least two files for cross-file calls');
if (values.check) {
  assert.deepEqual(
    [count, methods, calls],
    [300, 20, 10],
    '--check requires the baseline workload',
  );
}
// Each receiver takes the next class in the ring; null keeps calls type-correct.
const files = Array.from({ length: count }, (_, i) => ({
  path: `src/p${i}/Service${i}.java`,
  content: `package p${i};
import p${(i + 1) % count}.Service${(i + 1) % count};
public class Service${i} {
${Array.from(
  { length: methods },
  (_, m) => `
  public Service${i} method${m}(Service${(i + 1) % count} other) {
${Array.from({ length: calls }, (_, c) => `    var value${c} = other.method${(m + c) % methods}(null);`).join('\n')}
    return this;
  }`,
).join('\n')}
}`,
}));
const parsed = await parseFilesWithWorkers(files, { poolSize: 1 });
const counts: Record<string, number> = {};
for (const file of parsed.data.parsedFiles) {
  for (const fact of file.callableFlowSites ?? []) counts[fact.kind] = (counts[fact.kind] ?? 0) + 1;
  counts.callResults = (counts.callResults ?? 0) + (file.callResultAssignmentSites?.length ?? 0);
}
console.log(
  'DENSE_INPUT',
  JSON.stringify({ files: files.length, counts, memory: process.memoryUsage() }),
);
const started = performance.now();
runScopeResolution(
  {
    graph: parsed.graph,
    model: parsed.model,
    files,
    preExtractedParsedFiles: new Map(parsed.data.parsedFiles.map((file) => [file.filePath, file])),
  },
  SCOPE_RESOLVERS.get(SupportedLanguages.Java)!,
);
const ended = performance.now();
const memory = process.memoryUsage();
assert.equal(parsed.data.parsedFiles.length, files.length, 'Scope extraction omitted files');
assert.ok([...parsed.graph.iterRelationshipsByType('CALLS')].length > 0, 'No calls resolved');
const nodes = [...parsed.graph.iterNodes()].map((n) => JSON.stringify(n));
const edges = [...parsed.graph.iterRelationships()].map((e) => JSON.stringify(e));
const peakRssBytes = process.resourceUsage().maxRSS * 1024;
const fingerprint = createHash('sha256')
  .update([...nodes, ...edges].sort().join('\n'))
  .digest('hex');
console.log(
  'DENSE_RESULT',
  JSON.stringify({
    count,
    methods,
    calls,
    resolveMs: ended - started,
    memory,
    peakRssBytes,
    nodes: nodes.length,
    edges: edges.length,
    fingerprint,
  }),
);
if (values.check) {
  // Reviewed before/after #3695: 66,300 nodes and 126,600 relationships.
  assert.equal(
    fingerprint,
    '3209302e91e7023328464540ec7d0ac72ac03bf49fa73303817a56ed3d415ef5',
    'Dense Java graph differs from the reviewed baseline',
  );
}
