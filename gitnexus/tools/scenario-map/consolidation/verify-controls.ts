/** Acceptance check against fresh pipeline controls; run after scenario-map plan. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ConsolidationReport } from './report.js';

const file = process.argv[2];
assert(
  file,
  'usage: node --import tsx tools/scenario-map/consolidation/verify-controls.ts <consolidation.json>',
);
const report = JSON.parse(readFileSync(file, 'utf8')) as ConsolidationReport;
const groups = new Map(report.groups.map((group) => [group.id, group]));
const prefix = 'test/integration/scenario-map-consolidation-inputs.test.ts#';
const positive = [
  'exact A',
  'exact B',
  'renamed fixture',
  'partial fixture and unique check',
  'different expectation',
  'equivalent Python scenario',
];
const negative = ['unrelated assertion', 'unrelated fixture'];
const names = [...positive, ...negative];
for (const name of names)
  assert(
    report.groups.some((group) => group.tests.includes(prefix + name)),
    `missing control evidence: ${name}`,
  );
const pair = (a: string, b: string) =>
  report.opportunities.find((opportunity) => {
    const left = groups.get(opportunity.a)?.tests ?? [],
      right = groups.get(opportunity.b)?.tests ?? [];
    return (
      (left.includes(prefix + a) && right.includes(prefix + b)) ||
      (left.includes(prefix + b) && right.includes(prefix + a))
    );
  });
let found = 0,
  rejected = 0;
for (let i = 0; i < names.length; i++)
  for (let j = i + 1; j < names.length; j++) {
    const expected = positive.includes(names[i]) && positive.includes(names[j]);
    assert.equal(Boolean(pair(names[i], names[j])), expected, `${names[i]} / ${names[j]}`);
    if (expected) found++;
    else rejected++;
  }
const exact = pair('exact A', 'exact B');
assert(exact);
assert.equal(exact.fixture.kind, 'content');
assert.equal(exact.path.coverageA, 1);
assert.equal(exact.path.coverageB, 1);
assert.equal(exact.assertions.coverageA, 1);
assert.equal(exact.assertions.coverageB, 1);
// Capturing inputs is not exhaustive proof; native execution and static gaps remain visible.
assert.equal(exact.review, 'intentional-keep');
assert(
  exact.limitations.includes('native execution is not represented by JavaScript blocks') ||
    exact.limitations.includes('worker execution is not represented by parent JavaScript blocks'),
);
assert(exact.limitations.includes('fixture: runtime input coverage is not exhaustive'));
assert.notEqual(exact.kind, 'same-observed-input-path-assertions');
const partial = pair('exact A', 'partial fixture and unique check');
assert(partial);
assert.equal(partial.assertions.shared, 1);
assert.equal(partial.onlyAssertionsA.length + partial.onlyAssertionsB.length, 1);
assert(partial.fixture.unmatchedA.length + partial.fixture.unmatchedB.length > 0);
assert(partial.onlyBlocksA.length + partial.onlyBlocksB.length > 0);
const rows = pair('exact A', 'different expectation');
assert(rows);
assert.equal(rows.kind, 'parameterize-expectations');
assert.equal(rows.assertions.shared, 0);
assert.equal(pair('exact A', 'renamed fixture')?.kind, 'parameterize-fixtures');
assert.equal(
  pair('equivalent Python scenario', 'partial fixture and unique check')?.kind,
  'share-language-scenario',
);
console.log(
  JSON.stringify({
    positivePairsFound: found,
    negativePairsRejected: rejected,
    uniqueEvidencePreserved: true,
    scope: 'eight fresh pipeline controls',
  }),
);
