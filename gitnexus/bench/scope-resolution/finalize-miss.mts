/** Isolate a terminal import miss beside an unrelated wildcard chain (#3695). */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { finalize, type FinalizeFile, type FinalizeHooks } from 'gitnexus-shared';

const count = Number(process.argv[2] ?? 500);
assert.ok(Number.isSafeInteger(count) && count >= 2, 'Expected a file count >= 2');
const files: FinalizeFile[] = Array.from({ length: count }, (_, i) => ({
  filePath: `chain/${i}.java`,
  moduleScope: `scope:${i}`,
  localDefs: Array.from({ length: 4 }, (_, j) => ({
    nodeId: `def:${i}_${j}`,
    filePath: `chain/${i}.java`,
    type: 'Class',
    qualifiedName: `p.C${i}_${j}`,
  })),
  parsedImports: i + 1 < count ? [{ kind: 'wildcard', targetRaw: `chain/${i + 1}.java` }] : [],
}));
files.push({
  filePath: 'leaf.java',
  moduleScope: 'scope:leaf',
  localDefs: [{ nodeId: 'def:Leaf', filePath: 'leaf.java', type: 'Class', qualifiedName: 'Leaf' }],
  parsedImports: [],
});
files.push({
  filePath: 'consumer.java',
  moduleScope: 'scope:consumer',
  localDefs: [],
  parsedImports: [
    { kind: 'named', localName: 'absent', importedName: 'absent', targetRaw: 'leaf.java' },
  ],
});
const paths = new Set(files.map((file) => file.filePath));
const hooks: FinalizeHooks = {
  resolveImportTarget: (target) => (paths.has(target) ? target : null),
  expandsWildcardTo: () => [],
  mergeBindings: (existing, incoming) => [...existing, ...incoming],
};
global.gc?.();
const heapBefore = process.memoryUsage().heapUsed;
const start = performance.now();
const result = finalize({ files, workspaceIndex: undefined }, hooks);
const elapsedMs = performance.now() - start;
const heapAfter = process.memoryUsage().heapUsed;
const peakRss = process.resourceUsage().maxRSS * 1024;
const edges = result.imports.get('scope:consumer');
assert.equal(edges?.length, 1);
assert.equal(edges[0].linkStatus, 'unresolved');
assert.equal(result.stats.totalFiles, count + 2);
assert.equal(result.stats.totalEdges, count);
assert.equal(result.bindings.size, count + 2);
const serialized = JSON.stringify({
  imports: [...result.imports],
  bindings: [...result.bindings].map(([scope, bindings]) => [scope, [...bindings]]),
  sccs: result.sccs,
  stats: result.stats,
});
console.log(
  JSON.stringify({
    count,
    elapsedMs,
    heapBefore,
    heapAfter,
    heapDelta: heapAfter - heapBefore,
    peakRss,
    files: result.stats.totalFiles,
    edges: result.stats.totalEdges,
    fingerprint: createHash('sha256').update(serialized).digest('hex'),
  }),
);
