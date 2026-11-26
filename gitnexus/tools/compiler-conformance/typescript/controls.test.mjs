import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compareReports } from '../compare.mjs';
import { compilerReport } from './compiler-report.mjs';
import { runtimeCalls } from './runtime-calls.mjs';
import { withWorkspacePackages } from './workspace.mjs';

const root = fileURLToPath(
  new URL('../../../test/fixtures/compiler-conformance/typescript-bindings/', import.meta.url),
);
const facts = compilerReport(root);

test('dropping an arrow from a class type parameter default changes its compiler facts', () => {
  const project = path.resolve(root, '../typescript-literal-type-parameters');
  const expected = compilerReport(project).CLASS_TYPE_PARAMETERS;
  assert.equal(expected.edges.length, 1);
  const [edge] = expected.edges;
  const parameters = JSON.parse(edge.to);
  const callback = parameters.find(([name]) => name === 'Callback');
  assert.deepEqual(callback, ['Callback', '(value: Pair) => void', '(value: Pair) => void']);
  callback[2] = '(value: Pair) =';
  assert.throws(
    () =>
      compareReports(expected, {
        ...expected,
        edges: [{ ...edge, to: JSON.stringify(parameters) }],
      }),
    /Missing from actual/,
  );
});

test('quoted, escaped and numeric methods use the same property key across declarations', (t) => {
  const project = mkdtempSync(path.join(tmpdir(), 'gitnexus-ts-method-keys-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  writeFileSync(
    path.join(project, 'keys.ts'),
    String.raw`class Base { 'read-value'() {} 100() {} }
class Derived extends Base { ["read\u002dvalue"]() {} 1e2() {} }
function invoke(value: Derived) { value['read-value'](); value[100](); }
`,
  );
  const report = compilerReport(project, [], true);
  const targets = (relation) => report[relation].edges.map(({ to }) => to).sort();
  assert.deepEqual(targets('METHOD_OVERRIDES'), ['keys.ts#1:0.100', 'keys.ts#1:0.read-value']);
  assert.deepEqual(targets('CALLS'), ['keys.ts#2:0.100', 'keys.ts#2:0.read-value']);
  assert.deepEqual(targets('HAS_METHOD'), [
    'keys.ts#1:0.100',
    'keys.ts#1:0.read-value',
    'keys.ts#2:0.100',
    'keys.ts#2:0.read-value',
  ]);
});

test('constructors with the same class name resolve in their own namespaces', () => {
  const calls = compilerReport(path.resolve(root, '../typescript-namespace-constructors')).CALLS;
  const [localA, localB, qualifiedA, qualifiedB] = calls.sites;
  assert.equal(calls.sites.length, 4);
  assert.notEqual(localA.target, localB.target);
  assert.equal(qualifiedA.target, localA.target);
  assert.equal(qualifiedB.target, localB.target);
  const sites = [localA, localB, qualifiedA, { ...qualifiedB, target: qualifiedA.target }];
  assert.throws(() => compareReports(calls, { ...calls, sites }), /Missing from/);
});

test('a diamond keeps both implementation contracts and the method selected on its derived interface', () => {
  const report = compilerReport(path.resolve(root, '../typescript-interface-contracts'));
  const inherited = 'index.ts#1:Reader.read';
  const specialized = 'index.ts#4:TextReader.read';
  const contracts = report.METHOD_IMPLEMENTS;
  assert.deepEqual(new Set(contracts.edges.map(({ to }) => to)), new Set([inherited, specialized]));
  const edges = contracts.edges.filter(({ to }) => to !== inherited);
  assert.throws(() => compareReports(contracts, { ...contracts, edges }), /Missing from actual/);
  const overrides = report.METHOD_OVERRIDES;
  const selected = overrides.edges.find(({ from }) => from === 'index.ts#8:Joined');
  assert.equal(selected?.to, specialized);
  const wrong = overrides.edges.map((edge) =>
    edge === selected ? { ...edge, to: inherited } : edge,
  );
  assert.throws(
    () => compareReports(overrides, { ...overrides, edges: wrong }),
    /Missing from actual/,
  );
});

test('workspace package links survive asynchronous readers and are cleaned up on rejection', async () => {
  const project = path.resolve(root, '../typescript-named-over-star');
  let scratch;
  await assert.rejects(
    withWorkspacePackages(project, async (directory) => {
      scratch = directory;
      await Promise.resolve();
      const manifest = JSON.parse(
        readFileSync(path.join(directory, 'node_modules/@x/ui/package.json'), 'utf8'),
      );
      assert.equal(manifest.name, '@x/ui');
      throw new Error('reader rejected');
    }),
    /reader rejected/,
  );
  assert.notEqual(scratch, project);
  assert.equal(existsSync(scratch), false);
});

test('callback assignments retain each possible source declaration at the same invocation', () => {
  const report = compilerReport(
    path.resolve(root, '../typescript-callback-assignment'),
  ).CALLBACK_TARGETS;
  assert.deepEqual(
    new Set(report.sites.map((site) => site.target)),
    new Set(['index.ts#1:0', 'index.ts#2:0', 'index.ts#3:0']),
  );
  assert.equal(new Set(report.sites.map((site) => site.start)).size, 1);
  const sites = report.sites.filter((site) => site.target !== 'index.ts#3:0');
  assert.throws(() => compareReports(report, { ...report, sites }), /Missing from/);
});

test('invoked parameters with the same name retain their own declarations and types', () => {
  const report = compilerReport(
    path.resolve(root, '../typescript-parameter-calls'),
  ).PARAMETER_CALLS;
  assert.equal(report.sites.length, 2);
  const [numbers, strings] = report.sites;
  const [numberDeclaration, numberType] = JSON.parse(numbers.target);
  const [stringDeclaration, stringType] = JSON.parse(strings.target);
  assert.notEqual(numberDeclaration, stringDeclaration);
  assert.notEqual(numberType, stringType);
  for (const wrong of [
    [stringDeclaration, numberType],
    [numberDeclaration, stringType],
  ]) {
    const sites = [{ ...numbers, target: JSON.stringify(wrong) }, strings];
    assert.throws(() => compareReports(report, { ...report, sites }), /Missing from actual/);
  }
});

test('the compiler identifies an anonymous default class in its heritage and overrides', () => {
  const project = path.resolve(root, '../../typescript-class-declarations/anonymous-default');
  const report = compilerReport(project, [], true);
  assert.deepEqual(report.EXTENDS.edges, [{ from: 'main.ts#5:15', to: 'main.ts#1:7' }]);
  assert.deepEqual(report.METHOD_OVERRIDES.edges, [
    { from: 'main.ts#5:15', to: 'main.ts#1:7.run' },
  ]);
  assert.ok(report.DECLARATIONS.edges.some(({ to }) => to === 'Class:default@main.ts#5:15'));
});

test('a same-named callback in another module fails the concrete target comparison', () => {
  const project = path.resolve(root, '../../typescript-callable-flow/imported');
  const report = compilerReport(project).CALLBACK_TARGETS;
  assert.equal(report.sites.length, 1);
  const [call] = report.sites;
  assert.equal(call.file, 'wrapper.ts');
  assert.equal(call.target, 'target.ts#1:7');
  const sites = [{ ...call, target: 'decoy.ts#1:7' }];
  assert.throws(() => compareReports(report, { ...report, sites }), /Missing from actual/);
});

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

test('property writes retain their declaration and complete assignment span', () => {
  const project = 'lang-resolution/ts-write-access';
  const fixture = fileURLToPath(new URL('../../../test/fixtures/' + project, import.meta.url));
  const diagnostics = JSON.parse(
    readFileSync(new URL('./diagnostics.json', import.meta.url), 'utf8'),
  );
  const { PROPERTY_WRITES: writes, PROPERTY_READS: reads } = compilerReport(
    fixture,
    diagnostics[project],
    false,
    { propertyAccess: true },
  );
  assert.equal(reads.sites.length, 0);
  assert.equal(writes.sites.length, 2);
  const [first, second] = writes.sites;
  assert.notEqual(first.target, second.target);
  for (const changed of [
    { ...first, target: second.target },
    { ...first, end: '5:11' },
  ]) {
    assert.throws(
      () => compareReports(writes, { ...writes, sites: [changed, second] }),
      /Missing from actual/,
    );
  }
});

test('same-line local classes retain distinct construction and method targets', () => {
  const calls = compilerReport(path.resolve(root, '../typescript-local-classes')).CALLS;
  const left = 'index.ts#2:25';
  const right = 'index.ts#2:97';
  for (const suffix of ['', '.act']) {
    const leftEdge = calls.edges.find(({ to }) => to === left + suffix);
    const rightEdge = calls.edges.find(({ to }) => to === right + suffix);
    assert.ok(leftEdge && rightEdge);
    const swapped = calls.edges.map((edge) =>
      edge === leftEdge
        ? { ...edge, to: rightEdge.to }
        : edge === rightEdge
          ? { ...edge, to: leftEdge.to }
          : edge,
    );
    assert.throws(() => compareReports(calls, { ...calls, edges: swapped }), /Missing from actual/);
  }
});

test('a class property read and a same-named block local resolve to separate declarations', () => {
  const project = path.resolve(root, '../typescript-block-shadowing');
  const { PROPERTY_READS: fields, VARIABLE_READS: locals } = compilerReport(project, [], false, {
    propertyAccess: true,
  });
  const field = fields.sites.find((site) => site.file === 'box.ts');
  const local = locals.sites.find((site) => site.file === 'box.ts');
  assert.ok(field && local);
  assert.notEqual(field.target, local.target);
  const wrong = fields.sites.map((site) =>
    site === field ? { ...site, target: local.target } : site,
  );
  assert.throws(() => compareReports(fields, { ...fields, sites: wrong }), /Missing from actual/);
});
