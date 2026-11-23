import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipelineFromRepo } from '../../../dist/core/ingestion/pipeline.js';
import { compareReports } from '../compare.mjs';
import { gitNexusCallReport } from '../gitnexus-report.mjs';
import { javacReports } from './javac-report.mjs';

const fixtureRoot = fileURLToPath(new URL('../../../test/fixtures/', import.meta.url));
// Counts guard against silently losing a fixture or a call during compiler traversal.
const fixtures = [
  {
    dir: 'lang-resolution/java-overload-types',
    families: ['find', 'resolve', 'count'],
    resolved: 9,
    ambiguous: 0,
  },
  {
    dir: 'lang-resolution/java-protected-overloads',
    families: ['pick', 'staticPick'],
    resolved: 7,
    ambiguous: 0,
  },
  {
    dir: 'compiler-conformance/java-overload-conformance',
    families: ['select', 'choose'],
    resolved: 2,
    ambiguous: 1,
  },
];
const references = javacReports(
  fixtures.map(({ dir, families }) => ({ dir: path.join(fixtureRoot, dir), families })),
);
for (const [index, fixture] of fixtures.entries()) {
  const name = fixture.dir;
  const reference = references[index];
  const ambiguous = reference.sites.filter((site) => site.status === 'ambiguous').length;
  assert.equal(ambiguous, fixture.ambiguous, `${name} ambiguous sites`);
  assert.equal(reference.sites.length - ambiguous, fixture.resolved, `${name} resolved sites`);
  const result = await runPipelineFromRepo(path.join(fixtureRoot, fixture.dir), () => {});
  const observed = gitNexusCallReport(result, {
    names: fixture.families,
    ambiguousReasons: ['member-lookup-ambiguous', 'overload-ambiguous'],
  });
  compareReports(reference, { ...observed, producer: `GitNexus (${name})` });
  console.log(`${name}: ${fixture.resolved} resolved, ${ambiguous} ambiguous`);
}
