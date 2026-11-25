import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compareReports } from '../compare.mjs';
import { compilerReport } from './compiler-report.mjs';

const root = fileURLToPath(
  new URL('../../../test/fixtures/compiler-conformance/typescript-bindings/', import.meta.url),
);
const facts = compilerReport(root);

test('the checker distinguishes derived, super and unrelated methods with the same spelling', () => {
  assert.equal(facts.CALLS.sites.length, 3);
  assert.equal(new Set(facts.CALLS.sites.map((site) => site.target)).size, 3);
  const observed = structuredClone(facts.CALLS);
  [observed.sites[0].target, observed.sites[1].target] = [
    observed.sites[1].target,
    observed.sites[0].target,
  ];
  assert.throws(() => compareReports(facts.CALLS, observed), /Missing from actual/);
});

test('type references carry the compiled source declaration', () => {
  assert.equal(facts.USES.sites.length, 2);
  const observed = structuredClone(facts.USES);
  observed.sites[0].target = observed.sites[1].target;
  assert.throws(() => compareReports(facts.USES, observed), /Missing from actual/);
});

test('a method with the same name in a different parent is a different override', () => {
  assert.equal(facts.METHOD_IMPLEMENTS.edges.length, 1);
  assert.equal(facts.METHOD_OVERRIDES.edges.length, 1);
  const observed = structuredClone(facts.METHOD_OVERRIDES);
  observed.edges[0].to = facts.METHOD_IMPLEMENTS.edges[0].to;
  assert.throws(() => compareReports(facts.METHOD_OVERRIDES, observed), /Missing from actual/);
});

test('a local variable and an imported alias of the same name resolve to distinct declarations', () => {
  const fixture = fileURLToPath(
    new URL(
      '../../../test/fixtures/compiler-conformance/typescript-variable-reads/',
      import.meta.url,
    ),
  );
  const reads = compilerReport(fixture).VARIABLE_READS;
  assert.equal(reads.sites.length, 3);
  assert.equal(new Set(reads.sites.map((site) => site.target)).size, 3);
  const wrong = structuredClone(reads);
  wrong.sites[2].target = wrong.sites[0].target;
  assert.throws(() => compareReports(reads, wrong), /Missing from actual/);
});
