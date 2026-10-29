/** #3695: retained overhead for ordinary calls with no indirect invocations.
 * Run: node --expose-gc --import tsx bench/scope-resolution/call-signature-memory.mts 500000
 * Compare in fresh processes on each revision; heap figures exclude the input.
 */
import assert from 'node:assert/strict';
import type { ParsedFile, ScopeId } from 'gitnexus-shared';
import { collectDeferredIndirectCollection } from '../../src/core/ingestion/scope-resolution/passes/callable-value-flow.js';

const total = Number(process.argv[2] ?? 500_000);
assert.ok(Number.isSafeInteger(total) && total > 0);
assert.ok(global.gc, 'Run with --expose-gc to measure retained heap');
const callsPerFile = 1_000;
const files: ParsedFile[] = Array.from({ length: Math.ceil(total / callsPerFile) }, (_, file) => ({
  filePath: `src/main/java/example/services/Service${file}.java`,
  moduleScope: `scope:${file}` as ScopeId,
  scopes: [],
  localDefs: [],
  parsedImports: [],
  callableFlowSites: [],
  referenceSites: Array.from(
    { length: Math.min(callsPerFile, total - file * callsPerFile) },
    (_, line) => ({
      kind: 'call',
      name: 'save',
      inScope: `file${file}:method${line}` as ScopeId,
      atRange: { startLine: line + 1, startCol: 4, endLine: line + 1, endCol: 16 },
      arity: 0,
    }),
  ),
}));
global.gc();
const before = process.memoryUsage().heapUsed;
const started = performance.now();
const result = collectDeferredIndirectCollection(files);
const elapsedMs = performance.now() - started;
const after = process.memoryUsage().heapUsed;
global.gc();
const retained = process.memoryUsage().heapUsed;
assert.equal(result.sites.size, 0);
console.log(
  JSON.stringify({
    totalCallSites: total,
    signaturesAllocated: result.callSignaturesBySite.size,
    elapsedMs,
    endpointHeapGrowthMiB: (after - before) / 2 ** 20,
    retainedHeapGrowthMiB: (retained - before) / 2 ** 20,
    peakRssMiB: process.resourceUsage().maxRSS / 1024,
    inputStillLive: files.reduce((n, file) => n + file.referenceSites.length, 0),
  }),
);
