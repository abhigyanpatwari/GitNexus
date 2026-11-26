import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compareReports } from '../compare.mjs';
import { compilerReport } from './compiler-report.mjs';
import { runtimeCalls } from './runtime-calls.mjs';

const root = fileURLToPath(
  new URL('../../../test/fixtures/compiler-conformance/typescript-bindings/', import.meta.url),
);
const facts = compilerReport(root);

test('a JSX member and the function it invokes have different declarations at the same site', () => {
  const fixture = 'lang-resolution/typescript-jsx-as-call';
  const diagnostics = JSON.parse(
    readFileSync(new URL('./diagnostics.json', import.meta.url), 'utf8'),
  );
  const project = fileURLToPath(new URL('../../../test/fixtures/' + fixture, import.meta.url));
  const report = compilerReport(project, diagnostics[fixture]);
  assert.equal(report.CALLABLE_PROPERTIES.sites.length, 1);
  const [property] = report.CALLABLE_PROPERTIES.sites;
  const invocation = report.CALLS.sites.find(
    (site) =>
      site.file === property.file && site.start === property.start && site.end === property.end,
  );
  assert.ok(invocation);
  assert.notEqual(property.target, invocation.target);
  assert.throws(
    () => compareReports({ sites: [property] }, { sites: [invocation] }),
    /Missing from actual/,
  );
});

test('swapping the two unchecked save calls disagrees with ECMAScript dispatch', () => {
  const fixture = fileURLToPath(
    new URL(
      '../../../test/fixtures/lang-resolution/typescript-double-cast-inference/',
      import.meta.url,
    ),
  );
  const runtime = { unchecked: [], methods: [] };
  compilerReport(fixture, ['src/app.ts:9:7 TS2339'], false, { runtime });
  const trace = runtimeCalls(fixture, runtime);
  assert.equal(trace.sites.length, 2);
  const [user, repo] = trace.sites;
  assert.notEqual(user.target, repo.target);
  const swapped = [
    { ...user, target: repo.target },
    { ...repo, target: user.target },
  ];
  assert.throws(() => compareReports(trace, { ...trace, sites: swapped }), /Missing from actual/);
});

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

test('a returned string selects the first applicable overload across files', () => {
  const fixture = fileURLToPath(
    new URL(
      '../../../test/fixtures/compiler-conformance/typescript-overload-results/',
      import.meta.url,
    ),
  );
  const calls = compilerReport(fixture).CALLS;
  const selected = calls.sites.find((site) => site.file === 'consumer.ts' && site.start === '21:2');
  assert.ok(selected);
  assert.equal(selected.target, 'consumer.ts#11:2');
  for (const target of ['consumer.ts#10:2', 'consumer.ts#12:2']) {
    const mutated = calls.sites.map((site) => (site === selected ? { ...site, target } : site));
    assert.throws(() => compareReports(calls, { ...calls, sites: mutated }), /Missing from actual/);
  }
});
