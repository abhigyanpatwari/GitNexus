import { runInSequence } from '../../../test/helpers/run-in-sequence.mjs';
import assert from 'node:assert/strict';
import { globSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipelineFromRepo } from '../../../dist/core/ingestion/pipeline.js';
import { compareCodeUnits, compareReports } from '../compare.mjs';
import { gitNexusCallReport } from '../gitnexus-report.mjs';
import { writeConversionMatrix } from './conversion-matrix.mjs';
import { javacReports, qualifiedJavacReport, selectedJavacCalls } from './javac-report.mjs';
import {
  compareConstructors,
  compareImplementations,
  compareJavaStructure,
  javaTypeIdentity,
} from './structure.mjs';

const root = fileURLToPath(new URL('../../../test/fixtures/', import.meta.url));
const corpus = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));

function assertJavacCounts(fixture, ref) {
  if (fixture.rejectedConstructors) {
    assert.deepEqual(
      ref.rejectedConstructors.map((site) => site.status).sort(compareCodeUnits),
      [...fixture.rejectedConstructors].sort(compareCodeUnits),
      'javac constructor rejections',
    );
  }
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
}

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

const generated = mkdtempSync(path.join(tmpdir(), 'gitnexus-java-conversion-'));
try {
  const expectedSites = writeConversionMatrix(generated);
  fixtures.push({ name: 'overload-conversion-matrix', dir: generated, sites: 100 });
  const references = javacReports(fixtures);
  let totalSites = 0;
  let totalBinarySites = 0;
  let totalMemberReferences = 0;
  const failures = [];
  await runInSequence(fixtures.entries(), async ([i, fixture]) => {
    try {
      const ref = qualifiedJavacReport(references[i]);
      assertJavacCounts(fixture, ref);
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
      if (fixture.constructors) compareConstructors(ref, pipeline, javaTypeIdentity);
      if (fixture.implementations !== undefined)
        compareImplementations(ref.implementations, pipeline.graph, fixture.implementations);
      const { names, sites, binarySites } = selectedJavacCalls(ref, fixture.families);
      const actual = gitNexusCallReport(pipeline, {
        names,
        ambiguousReasons: ['member-lookup-ambiguous', 'overload-ambiguous'],
        excludeEdgeReasons: ['interface-dispatch'],
        typeCaller: javaTypeIdentity,
      });
      for (const site of actual.sites) {
        if (site.status === 'overload-inapplicable') site.status = 'inapplicable';
      }
      if (sites.length || ref.edges.length) {
        try {
          compareReports({ ...ref, sites }, actual);
        } catch (error) {
          if (error.constructor !== Error) throw error;
          differences.push(...error.message.split('\n'));
        }
      } else {
        assert.deepEqual(actual.sites, [], 'Unexpected call-site outcomes');
        assert.deepEqual(actual.edges, [], 'Unexpected call edges');
      }
      if (differences.length) throw new Error(differences.join('\n'));
      totalSites += ref.sites.length;
      totalBinarySites += binarySites.length;
      totalMemberReferences += ref.memberReferences.length;
      console.log(
        `${fixture.name}: ${ref.sites.length} call sites, ${ref.memberReferences.length} member references, ${ref.heritage.length} source heritage edges`,
      );
    } catch (error) {
      failures.push(new Error(fixture.name, { cause: error }));
    }
  });
  if (failures.length)
    throw new AggregateError(failures, `${failures.length} Java conformance fixtures failed`);
  console.log(
    `${fixtures.length} Java fixtures, ${totalSites} source call sites, ${totalBinarySites} binary call sites, ${totalMemberReferences} member references`,
  );
} finally {
  rmSync(generated, { recursive: true, force: true });
}
