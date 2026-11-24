import { compareCodeUnits } from '../compare.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runPipelineFromRepo } from '../../../dist/core/ingestion/pipeline.js';
import { checkLargePackage } from './large-packages.mjs';
import { checkRecoveredCalls } from './recovered-calls.mjs';
import { checkLocalClaims } from './local-claims.mjs';
import { checkWorkerOrder } from './worker-order.mjs';
import { checkImportStorage } from './import-storage.mjs';
import { checkCalls, checkRelationships } from './resolution-facts.mjs';

const [input, output] = process.argv.slice(2);
const batch = JSON.parse(readFileSync(input, 'utf8'));
const contracts = {
  'graph-contracts': () => import('./graph-contracts.mjs').then((m) => m.checkGraphContracts()),
  'lombok-contracts': () => import('./lombok-contracts.mjs').then((m) => m.checkLombokContracts()),
  'overload-contracts': () =>
    import('./overload-contracts.mjs').then((m) => m.checkOverloadContracts()),
};
if (batch.contract) {
  await contracts[batch.contract]();
  console.log(batch.contract + ' passed');
}
let checks = 0;
const failures = [];
for (const { dir, ref, spec } of batch.projects ?? []) {
  ref.methods = new Map(ref.methods);
  try {
    assert.ok(ref.complete, 'Incomplete javac project');
    assert.deepEqual(ref.diagnostics, spec.diagnostics, 'JDK 21 diagnosis changed');
    if (spec.localClaims) {
      checkLocalClaims(path.join(dir, spec.localClaims));
      checks++;
      continue;
    }
    if (spec.workerOrder) {
      await checkWorkerOrder(dir, ref, spec.workerOrder);
      checks += 2;
      continue;
    }
    if (spec.onDemand) {
      await checkImportStorage(dir, ref, spec.onDemand);
      checks += 2;
      continue;
    }
    const { graph } = await runPipelineFromRepo(dir, () => {});
    if (spec.sourceMethods !== undefined) {
      checkRecoveredCalls(graph, ref, spec);
      checks += spec.sourceMethods + 1;
      continue;
    }
    if (spec.largePackage) {
      checks += checkLargePackage(graph, ref, spec.largePackage);
      continue;
    }
    for (const [file, expected] of Object.entries(spec.synthetic ?? {})) {
      const ids = [...graph.iterNodes()]
        .filter((n) => n.properties.filePath === file && n.properties.synthetic === 'lombok')
        .map((n) => n.id)
        .sort(compareCodeUnits);
      assert.deepEqual(ids, expected, 'Lombok accessors in ' + file);
      checks++;
    }
    for (const id of spec.nodes ?? []) assert.ok(graph.getNode(id), 'Missing node ' + id);
    for (const call of spec.calls ?? []) checkCalls(graph, ref, call);
    for (const relation of spec.relationships ?? []) checkRelationships(graph, relation);
    checks +=
      (spec.nodes?.length ?? 0) + (spec.calls?.length ?? 0) + (spec.relationships?.length ?? 0);
  } catch (error) {
    failures.push(new Error(path.basename(dir), { cause: error }));
  }
}
if (failures.length) throw new AggregateError(failures, 'Java resolution conformance failed');
writeFileSync(output, JSON.stringify(checks));
