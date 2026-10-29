/** Dense Java workload for investigating #3695; run in a fresh process. */
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { SupportedLanguages } from 'gitnexus-shared';
import { parseFilesWithWorkers } from '../../test/helpers/worker-parse.js';
import { SCOPE_RESOLVERS } from '../../src/core/ingestion/scope-resolution/pipeline/registry.js';
import { runScopeResolution } from '../../src/core/ingestion/scope-resolution/pipeline/run.js';

const count = Number(process.argv[2] ?? 300);
const methods = Number(process.argv[3] ?? 20);
const calls = Number(process.argv[4] ?? 10);
assert.ok([count, methods, calls].every((value) => Number.isSafeInteger(value) && value > 0));
assert.ok(count >= 2, 'Use at least two files for cross-file calls');
const files = Array.from({ length: count }, (_, i) => ({
  path: `src/p${i}/Service${i}.java`,
  content: `package p${i};
import p${(i + 1) % count}.Service${(i + 1) % count};
public class Service${i} {
${Array.from(
  { length: methods },
  (_, m) => `
  public Service${i} method${m}(Service${(i + 1) % count} other) {
${Array.from({ length: calls }, (_, c) => `    var value${c} = other.method${(m + c) % methods}(this);`).join('\n')}
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
console.log(
  'DENSE_RESULT',
  JSON.stringify({
    count,
    methods,
    calls,
    resolveMs: ended - started,
    memory,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
    nodes: nodes.length,
    edges: edges.length,
    fingerprint: createHash('sha256')
      .update([...nodes, ...edges].sort().join('\n'))
      .digest('hex'),
  }),
);
