import assert from 'node:assert/strict';
import { existsSync, globSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipelineFromRepo } from '../../../dist/core/ingestion/pipeline.js';
import { compareCodeUnits, compareReports } from '../compare.mjs';
import { gitNexusCallReport } from '../gitnexus-report.mjs';
import { writeConversionMatrix } from './conversion-matrix.mjs';
import { javacReports, qualifiedJavacReport } from './javac-report.mjs';
import { compareConstructors, compareJavaStructure, javaTypeIdentity } from './structure.mjs';

const root = fileURLToPath(new URL('../../../test/fixtures/', import.meta.url));
const corpus = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));
const projects = globSync(
  ['compiler-conformance/java-*/**/*.java', 'lang-resolution/java-*/**/*.java'],
  { cwd: root },
).map((file) => file.replaceAll('\\', '/').split('/').slice(0, 2).join('/'));
const fixtures = [];
for (const name of [...new Set([...Object.keys(corpus), ...projects])].sort(compareCodeUnits)) {
  const config = corpus[name];
  if (config?.compilerExclusion) continue;
  fixtures.push({
    name,
    dir: path.join(root, name),
    ...(typeof config === 'number' ? { sites: config } : config),
  });
}

// Compare exact differences so a new regression and an unexpectedly fixed gap both fail CI.
function checkDifferences(fixture, differences) {
  const file = fixture.differences
    ? new URL(fixture.differences, import.meta.url)
    : path.join(fixture.dir, 'known-differences.txt');
  if ((!fixture.differences && !existsSync(file)) || process.argv.includes('--strict')) {
    if (differences.length) throw new Error(differences.join('\n'));
    return;
  }
  const expected = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#'))
    .sort(compareCodeUnits);
  assert.ok(expected.length, 'Empty known-differences file');
  differences.sort(compareCodeUnits);
  assert.deepEqual(differences, expected, 'Recorded compiler differences changed');
  console.log(fixture.name + ' known differences:\n  ' + differences.join('\n  '));
}

const generated = mkdtempSync(path.join(tmpdir(), 'gitnexus-java-conversion-'));
try {
  const expectedSites = writeConversionMatrix(generated);
  fixtures.push({ name: 'overload-conversion-matrix', dir: generated, sites: 100 });
  const references = javacReports(fixtures);
  let totalSites = 0;
  let totalMemberReferences = 0;
  const failures = [];
  for (const [i, fixture] of fixtures.entries()) {
    try {
      const ref = qualifiedJavacReport(references[i]);
      if (fixture.sites !== undefined)
        assert.equal(ref.sites.length, fixture.sites, 'javac call-site count');
      if (fixture.memberReferences !== undefined)
        assert.equal(
          ref.memberReferences.length,
          fixture.memberReferences,
          'javac member-reference count',
        );
      for (const [status, count] of Object.entries(fixture.rejections ?? {})) {
        assert.equal(
          ref.sites.filter((s) => s.status === status).length,
          count,
          'javac ' + status + ' count',
        );
      }
      if (fixture.dir === generated) {
        assert.deepEqual(
          new Set(ref.sites.map((s) => `${s.file}:${s.start}..${s.end}`)),
          expectedSites,
        );
        assert.equal(ref.sites.filter((s) => s.status === 'ambiguous').length, 2);
      }
      const pipeline = await runPipelineFromRepo(fixture.dir, () => {});
      const differences = compareJavaStructure(
        ref,
        pipeline,
        javaTypeIdentity,
        fixture.methods !== false,
      );
      if (fixture.constructors) compareConstructors(ref, pipeline.graph, javaTypeIdentity);
      const actual = gitNexusCallReport(pipeline, {
        names:
          fixture.families ??
          ref.declarations.filter((d) => d.kind === 'Method').map((d) => d.name),
        ambiguousReasons: ['member-lookup-ambiguous', 'overload-ambiguous'],
        excludeEdgeReasons: ['interface-dispatch'],
        typeCaller: javaTypeIdentity,
      });
      for (const site of actual.sites) {
        if (site.status === 'overload-inapplicable') site.status = 'inapplicable';
      }
      if (ref.sites.length || ref.edges.length) {
        try {
          compareReports(ref, actual);
        } catch (error) {
          if (error.constructor !== Error) throw error;
          differences.push(...error.message.split('\n'));
        }
      } else {
        assert.deepEqual(actual.sites, [], 'Unexpected call-site outcomes');
        assert.deepEqual(actual.edges, [], 'Unexpected call edges');
      }
      checkDifferences(fixture, differences);
      totalSites += ref.sites.length;
      totalMemberReferences += ref.memberReferences.length;
      console.log(
        `${fixture.name}: ${ref.sites.length} call sites, ${ref.memberReferences.length} member references, ${ref.heritage.length} source heritage edges`,
      );
    } catch (error) {
      failures.push(new Error(fixture.name, { cause: error }));
    }
  }
  if (failures.length)
    throw new AggregateError(failures, `${failures.length} Java conformance fixtures failed`);
  console.log(
    `${fixtures.length} Java fixtures, ${totalSites} compiler call sites, ${totalMemberReferences} member references`,
  );
} finally {
  rmSync(generated, { recursive: true, force: true });
}
