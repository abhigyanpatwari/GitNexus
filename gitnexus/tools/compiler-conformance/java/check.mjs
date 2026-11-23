import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipelineFromRepo } from '../../../dist/core/ingestion/pipeline.js';

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
const oracle = fileURLToPath(new URL('./OverloadOracle.java', import.meta.url));
const output = execFileSync(
  'java',
  [oracle, ...fixtures.flatMap(({ dir, families }) => [dir, families.join(',')])],
  { encoding: 'utf8', cwd: fixtureRoot },
);
const sites = output
  .trimEnd()
  .split(/\r?\n/)
  .map((row) => {
    const [fixture, file, start, end, name, caller, target, signature] = row.split('\t');
    assert.ok(signature, `Malformed compiler output: ${row}`);
    return { fixture, file, start, end, name, caller, target, signature };
  });

function graphDeclaration(node) {
  const { filePath, startLine, startColumn, name } = node.properties;
  return `def:${filePath}#${startLine + 1}:${startColumn}:Method:${name}`;
}

function siteTargets(outcomes, site) {
  const targets = new Set();
  for (const outcome of outcomes) {
    const { range } = outcome;
    if (
      outcome.filePath !== site.file ||
      outcome.name !== site.name ||
      !range ||
      `${range.startLine}:${range.startCol}` !== site.start ||
      `${range.endLine}:${range.endCol}` !== site.end
    )
      continue;
    if (outcome.kind === 'resolved') targets.add(outcome.targetId);
    else if (outcome.kind === 'suppressed' && outcome.siteKind === 'call') {
      const ambiguous = ['member-lookup-ambiguous', 'overload-ambiguous'].includes(outcome.reason);
      targets.add(ambiguous ? 'ambiguous' : `suppressed (${outcome.reason})`);
    } else if (outcome.kind === 'fallback-guessed') {
      targets.add(`guessed ${outcome.targetId}`);
    }
  }
  return [...targets];
}

for (const fixture of fixtures) {
  const name = path.basename(fixture.dir);
  const expected = sites.filter((site) => site.fixture === name);
  const ambiguous = expected.filter((site) => site.target === 'ambiguous').length;
  assert.equal(ambiguous, fixture.ambiguous, `${name} ambiguous sites`);
  assert.equal(expected.length - ambiguous, fixture.resolved, `${name} resolved sites`);
  const result = await runPipelineFromRepo(path.join(fixtureRoot, fixture.dir), () => {});
  const expectedEdges = new Set();
  for (const site of expected) {
    const actual = siteTargets(result.resolutionOutcomes, site);
    const location = `${site.fixture}/${site.file}:${site.start} ${site.name}`;
    assert.deepEqual(
      actual,
      [site.target],
      `${location}\njavac: ${site.signature} (${site.target})\nGitNexus: ${actual.join(', ') || 'no target recorded'}`,
    );
    if (site.target !== 'ambiguous') expectedEdges.add(`${site.caller} -> ${site.target}`);
  }
  // CALLS aggregates repeated caller/target pairs. Compare the public graph too,
  // so a correct site-level suppression cannot conceal a fabricated edge.
  const actualEdges = new Set();
  for (const edge of result.graph.iterRelationshipsByType('CALLS')) {
    const target = result.graph.getNode(edge.targetId);
    if (target?.label === 'Method' && fixture.families.includes(target.properties.name)) {
      actualEdges.add(
        `${graphDeclaration(result.graph.getNode(edge.sourceId))} -> ${graphDeclaration(target)}`,
      );
    }
  }
  assert.deepEqual(actualEdges, expectedEdges, `${name} emitted CALLS`);
  console.log(`${name}: ${fixture.resolved} resolved, ${ambiguous} ambiguous`);
}
