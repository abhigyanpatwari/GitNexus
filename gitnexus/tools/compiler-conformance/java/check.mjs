import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipelineFromRepo } from '../../../dist/core/ingestion/pipeline.js';
import { compareReports } from '../compare.mjs';
import { gitNexusCallReport } from '../gitnexus-report.mjs';
import { writeConversionMatrix } from './conversion-matrix.mjs';
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
const matrixDir = mkdtempSync(path.join(tmpdir(), 'gitnexus-java-conversion-'));
try {
  const batch = fixtures.map((fixture) => ({
    ...fixture,
    name: fixture.dir,
    dir: path.join(fixtureRoot, fixture.dir),
  }));
  batch.push({
    name: 'overload-conversion-matrix',
    dir: matrixDir,
    families: ['pick'],
    resolved: 98,
    ambiguous: 2,
    expectedSites: writeConversionMatrix(matrixDir),
  });
  const references = javacReports(batch);
  for (const [index, fixture] of batch.entries()) {
    const { name } = fixture;
    const reference = references[index];
    if (fixture.expectedSites) {
      const covered = reference.sites.map(({ file, start, end }) => `${file}:${start}..${end}`);
      assert.deepEqual(new Set(covered), fixture.expectedSites, `${name} generated call ranges`);
    }
    const ambiguous = reference.sites.filter((site) => site.status === 'ambiguous').length;
    assert.equal(ambiguous, fixture.ambiguous, `${name} ambiguous sites`);
    assert.equal(reference.sites.length - ambiguous, fixture.resolved, `${name} resolved sites`);
    const result = await runPipelineFromRepo(fixture.dir, () => {});
    const observed = gitNexusCallReport(result, {
      names: fixture.families,
      ambiguousReasons: ['member-lookup-ambiguous', 'overload-ambiguous'],
    });
    compareReports(reference, { ...observed, producer: `GitNexus (${name})` });
    console.log(`${name}: ${fixture.resolved} resolved, ${ambiguous} ambiguous`);
  }
} finally {
  rmSync(matrixDir, { recursive: true, force: true });
}
