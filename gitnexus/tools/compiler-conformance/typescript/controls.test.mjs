import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import { SyntaxKind } from 'typescript/unstable/ast';
import { typescriptProvider } from '../../../dist/core/ingestion/languages/typescript.js';
import { extractParsedFile } from '../../../dist/core/ingestion/scope-extractor-bridge.js';
import { runPipelineFromRepo } from '../../../dist/core/ingestion/pipeline.js';
import { HeritageSubstitutions } from '../../../dist/core/ingestion/heritage-substitutions.js';
import {
  checkCommonJsForwarding,
  checkModuleValues,
  checkNodeModuleFormat,
} from './module-values.mjs';
import { compareReports } from '../compare.mjs';
import { compilerReport } from './compiler-report.mjs';
import {
  compareProject,
  compareProjects,
  comparePublishedCalls,
  publishedMethodOwners,
} from './check.mjs';
import { withWorkspacePackages } from './workspace.mjs';
import diagnostics from './diagnostics.json' with { type: 'json' };

const root = fileURLToPath(
  new URL('../../../test/fixtures/compiler-conformance/typescript-bindings/', import.meta.url),
);
const facts = compilerReport(root);

test('CommonJS loader calls match the exports of the compiled modules', checkCommonJsForwarding);
test('the published graph retains the namespace constant read and prunes function-local reads', async () => {
  const key = 'lang-resolution/typescript-namespace-const';
  const project = path.resolve(root, '../..', key);
  const expected = [];
  const { sites } = compilerReport(project, diagnostics[key], false, {
    onSourceFile(source, checker, compilerProject) {
      function visit(node) {
        if (
          node.kind === SyntaxKind.ReturnStatement &&
          node.expression?.kind === SyntaxKind.Identifier
        ) {
          const variable = checker
            .getSymbolAtLocation(node.expression)
            ?.valueDeclaration?.resolve(compilerProject);
          assert.equal(variable?.kind, SyntaxKind.VariableDeclaration);
          const owner = node.parent.parent;
          assert.equal(owner.kind, SyntaxKind.FunctionDeclaration);
          const targetFile = variable.getSourceFile();
          expected.push([
            owner.name.text,
            path.relative(project, targetFile.fileName),
            variable.name.text,
            targetFile.getLineAndCharacterOfPosition(variable.name.getStart()).line,
          ]);
        }
        node.forEachChild(visit);
      }
      visit(source);
    },
  }).VARIABLE_READS;
  assert.equal(sites.length, 1);
  const [read] = sites;
  const { graph } = await runPipelineFromRepo(project, () => {});
  const accesses = [...graph.iterRelationshipsByType('ACCESSES')];
  assert.equal(accesses.length, 1);
  const [edge] = accesses;
  assert.ok(edge.id.endsWith(':read:' + read.start + ':' + read.end));
  const reader = graph.getNode(edge.sourceId);
  const variable = graph.getNode(edge.targetId);
  assert.equal(reader.properties.filePath, read.file);
  assert.equal(variable.label, 'Const');
  assert.deepEqual(
    [
      [
        reader.properties.name,
        variable.properties.filePath,
        variable.properties.name,
        variable.properties.startLine,
      ],
    ],
    expected,
  );
});
test(
  'NodeNext package format determines whether an import-bearing file has a CommonJS default',
  checkNodeModuleFormat,
);

test('an oversized inherited type leaves other signatures resolvable', () => {
  const substitutions = new HeritageSubstitutions();
  substitutions.registerBase(
    'Child',
    'Base',
    {
      typeParameters: [{ name: 'T' }, { name: 'U' }],
    },
    ['X'.repeat(32769), 'string'],
  );
  const specialize = substitutions.forClass('Child', new Map([['Child', ['Base']]]));
  assert.equal(specialize('Base', 'first', ['Array<T>']), null);
  assert.deepEqual(specialize('Base', 'second', ['Array<U>']), ['Array<string>']);
});

test('TypeScript module-kind evidence survives serialization and is consumed once', () => {
  const parser = new Parser();
  parser.setLanguage(TypeScript.typescript);
  const assignment = 'module.exports.value = 1;';
  for (const [suffix, prefix, commonJs] of [
    ['ts', '', true],
    ['ts', 'export {}; ', false],
    ['ts', 'import "./dep"; ', false],
    ['cts', 'export {}; ', true],
    ['mts', '', false],
  ]) {
    const file = 'module.' + suffix;
    const source = prefix + assignment;
    const parsed = extractParsedFile(
      typescriptProvider,
      source,
      file,
      undefined,
      parser.parse(source),
    );
    assert.ok(parsed);
    const captureSideChannel = typescriptProvider.collectCaptureSideChannel(file);
    assert.equal(captureSideChannel, commonJs);
    assert.equal(
      JSON.parse(JSON.stringify({ ...parsed, captureSideChannel })).captureSideChannel,
      commonJs,
    );
    assert.equal(typescriptProvider.collectCaptureSideChannel(file), undefined);
  }
});

test('published calls retain the compiler target at each stored call range', () => {
  const calls = [
    { file: 'a.ts', start: '1:0', end: '1:3', caller: 'main', target: 'first' },
    { file: 'a.ts', start: '2:0', end: '2:3', caller: 'main', target: 'first' },
    { file: 'a.ts', start: '3:0', end: '3:3', caller: 'main', target: 'second' },
  ];
  comparePublishedCalls(calls, calls);
  assert.throws(() => comparePublishedCalls(calls, calls.slice(1)), /Missing published CALLS/);
  assert.throws(
    () => comparePublishedCalls(calls, [...calls, calls[0]]),
    /Duplicate published CALLS/,
  );
  const swapped = [calls[0], { ...calls[1], target: 'second' }, { ...calls[2], target: 'first' }];
  assert.throws(() => comparePublishedCalls(calls, swapped), /Unexpected published CALLS/);
  comparePublishedCalls(calls, [{ caller: 'main', target: 'first' }, calls[2]]);
  assert.throws(
    () => comparePublishedCalls(calls, [calls[0], { caller: 'main', target: 'first' }, calls[2]]),
    /Mixed located and positionless CALLS/,
  );
  assert.throws(
    () => comparePublishedCalls(calls, [...calls, { caller: 'other', target: 'first' }]),
    /Unexpected published CALLS/,
  );
});

test('an unchecked shadowed receiver cannot acquire the typed receiver’s published edge', () => {
  const key = 'compiler-conformance/typescript-shadowed-receiver';
  const project = path.resolve(root, '../..', key);
  const { publishedCalls, uncheckedMemberSites } = compilerReport(project, diagnostics[key]);
  const unchecked = uncheckedMemberSites.find(
    (site) => site.file === 'app.ts' && site.start === '6:2',
  );
  assert.ok(unchecked && !unchecked.constructedTarget);
  const typedCall = publishedCalls.find((site) => site.file === 'app.ts' && site.start === '13:2');
  assert.ok(typedCall);
  const wrong = { ...unchecked, caller: 'app.ts#5:7', target: typedCall.target };
  assert.throws(
    () => comparePublishedCalls(publishedCalls, [...publishedCalls, wrong]),
    /Unexpected published CALLS/,
  );
});

test('runtime module exports agree with the JavaScript emitted by TypeScript', checkModuleValues);

test('published calls preserve signed numeric keys with grouped operands', async () => {
  const fixture = new URL(
    '../../../test/fixtures/typescript-signed-property-keys/',
    import.meta.url,
  );
  // The checker widens these expressions to number. Node supplies their actual property keys.
  compilerReport(fileURLToPath(fixture));
  const { SignedKeys, callNegative, callPositive, callDynamic } = await import(
    new URL('keys.ts', fixture)
  );
  const runtimeKeys = [];
  const keys = new Proxy(new SignedKeys(), {
    get(target, key) {
      runtimeKeys.push(key);
      return Reflect.get(target, key);
    },
  });
  callNegative(keys);
  callPositive(keys);
  callDynamic(keys, 1);
  assert.deepEqual(runtimeKeys, ['-1', '2', '-1']);
  const { graph } = await runPipelineFromRepo(fileURLToPath(fixture), () => {});
  const calls = Array.from(graph.iterRelationshipsByType('CALLS'), ({ sourceId, targetId }) => [
    graph.getNode(sourceId).properties.name,
    graph.getNode(targetId).properties.name,
  ]).sort();
  assert.deepEqual(calls, [
    [callNegative.name, runtimeKeys[0]],
    [callPositive.name, runtimeKeys[1]],
  ]);
});

test('two stored ownership edges cannot collapse into one method owner', async () => {
  const { graph } = await runPipelineFromRepo(root, () => {});
  const [edge] = graph.iterRelationshipsByType('HAS_METHOD');
  assert.equal(publishedMethodOwners(graph).get(edge.targetId)?.id, edge.sourceId);
  graph.addRelationship({ ...edge, id: edge.id + '-duplicate' });
  assert.throws(() => publishedMethodOwners(graph), /Multiple HAS_METHOD/);
});

test('a failed compiler fixture still reports failures from later projects', async (t) => {
  const projects = [];
  for (const name of ['first', 'second']) {
    const project = mkdtempSync(path.join(tmpdir(), `gitnexus-ts-${name}-`));
    t.after(() => rmSync(project, { recursive: true, force: true }));
    writeFileSync(path.join(project, 'invalid.ts'), 'const value: string = 123;');
    projects.push(project);
  }
  await assert.rejects(compareProjects(projects, {}), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(
      error.errors.map((failure) => failure.message),
      projects.map((project) => path.basename(project)),
    );
    assert.ok(
      error.errors.every((failure) => failure.cause.message.includes('TypeScript diagnostics')),
    );
    return true;
  });
});

test('swapping a static method and a dotted instance method fails the published call comparison', async (t) => {
  const project = mkdtempSync(path.join(tmpdir(), 'gitnexus-ts-static-method-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  writeFileSync(
    path.join(project, 'keys.ts'),
    `export class C {
  static m() { return 1; }
  ['static.m']() { return 2; }
}
export function run(c: C) { C.m(); c['static.m'](); }
`,
  );
  const { CALLS, publishedCalls } = compilerReport(project);
  assert.equal(publishedCalls.length, 2);
  assert.notEqual(CALLS.sites[0].target, CALLS.sites[1].target);
  const [first, second] = publishedCalls;
  assert.throws(
    () =>
      comparePublishedCalls(publishedCalls, [
        { ...first, target: second.target },
        { ...second, target: first.target },
      ]),
    /Unexpected published CALLS/,
  );
  await compareProject(project);
});

test('a call in a returned function belongs to that function', () => {
  const project = path.resolve(root, '../typescript-local-binding-identities');
  const calls = compilerReport(project).CALLS;
  const edge = calls.edges.find(({ from }) => from === 'anon.ts#2:9');
  assert.deepEqual(edge, { from: 'anon.ts#2:9', to: 'anon.ts#3:17' });
  const edges = calls.edges.map((entry) =>
    entry === edge ? { ...entry, from: 'anon.ts#1:7' } : entry,
  );
  assert.throws(() => compareReports(calls, { ...calls, edges }), /Missing from actual/);
});

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

test('quoted, escaped and numeric methods use the same property key across declarations', async (t) => {
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
  const targets = (relation) => report[relation].edges.map(({ to }) => JSON.parse(to)).sort();
  const base = [
    ['keys.ts#1:0', false, '100'],
    ['keys.ts#1:0', false, 'read-value'],
  ];
  const derived = [
    ['keys.ts#2:0', false, '100'],
    ['keys.ts#2:0', false, 'read-value'],
  ];
  assert.deepEqual(targets('METHOD_OVERRIDES'), base);
  assert.deepEqual(targets('CALLS'), derived);
  assert.deepEqual(targets('HAS_METHOD'), [...base, ...derived]);
  await compareProject(project);
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

test('distinct qualified local classes keep their graph IDs when preceding lines move', async (t) => {
  const project = mkdtempSync(path.join(tmpdir(), 'gitnexus-ts-local-classes-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const source = ['A', 'B']
    .map(
      (owner) =>
        `export class ${owner} { build() { class Helper { run() {} } return new Helper(); } }`,
    )
    .join('\n');
  async function classIds(prefix) {
    writeFileSync(path.join(project, 'classes.ts'), prefix + source);
    const { pipeline } = await compareProject(project);
    return pipeline.graph.nodes
      .filter((node) => node.label === 'Class' && node.properties.name === 'Helper')
      .map((node) => node.id)
      .sort();
  }
  const ids = await classIds('');
  assert.equal(new Set(ids).size, 2);
  assert.deepEqual(await classIds('\n\n'), ids);
});

test('the compiler distinguishes unique symbol keys in overrides and interface contracts', (t) => {
  const project = mkdtempSync(path.join(tmpdir(), 'gitnexus-ts-symbol-keys-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  writeFileSync(
    path.join(project, 'keys.ts'),
    `declare const first: unique symbol, second: unique symbol;
interface Contract { [Symbol.iterator](): void }
class Base { [Symbol.iterator]() {} [first]() {} }
class Derived extends Base implements Contract { [Symbol.iterator]() {} [second]() {} }
`,
  );
  const facts = compilerReport(project);
  assert.deepEqual(facts.METHOD_OVERRIDES.edges, [
    { from: 'keys.ts#4:0', to: JSON.stringify(['keys.ts#3:0', false, '[Symbol.iterator]']) },
  ]);
  assert.deepEqual(facts.METHOD_IMPLEMENTS.edges, [
    { from: JSON.stringify(['keys.ts#4:0', false, '[Symbol.iterator]']), to: 'keys.ts#2:21' },
  ]);
});

test('a diamond keeps both implementation contracts and the method selected on its derived interface', () => {
  const report = compilerReport(path.resolve(root, '../typescript-interface-contracts'));
  const inherited = 'index.ts#2:2';
  const specialized = 'index.ts#5:2';
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

test('legacy baseUrl resolves the same imports as the compiler’s paths migration', async (t) => {
  const key = 'lang-resolution/typescript-pnpm-workspace-imports';
  const project = path.resolve(root, '../..', key);
  const diagnostics = JSON.parse(readFileSync(new URL('./diagnostics.json', import.meta.url)));
  const reference = compilerReport(project, diagnostics[key]).IMPORTS;
  const legacy = mkdtempSync(path.join(tmpdir(), 'gitnexus-ts-legacy-baseurl-'));
  t.after(() => rmSync(legacy, { recursive: true, force: true }));
  cpSync(project, legacy, { recursive: true });
  writeFileSync(
    path.join(legacy, 'apps/web/tsconfig.json'),
    JSON.stringify({
      compilerOptions: { baseUrl: 'src', paths: { '@ui/*': ['components/*'] } },
    }),
  );
  const { graph } = await runPipelineFromRepo(legacy, () => {});
  const edges = Array.from(graph.iterRelationshipsByType('IMPORTS'), ({ sourceId, targetId }) => ({
    from: graph.getNode(sourceId).properties.filePath,
    to: graph.getNode(targetId).properties.filePath,
  }));
  compareReports(reference, { edges, sites: [] });
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
  const project = path.resolve(root, '../typescript-anonymous-default-class');
  const report = compilerReport(project, [], true);
  assert.deepEqual(report.EXTENDS.edges, [{ from: 'base.ts#2:15', to: 'base.ts#1:7' }]);
  assert.deepEqual(report.METHOD_OVERRIDES.edges, [
    { from: 'base.ts#2:15', to: JSON.stringify(['base.ts#1:7', false, 'run']) },
  ]);
  assert.ok(report.DECLARATIONS.edges.some(({ to }) => to === 'Class:default@base.ts#2:15'));
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

test('an unchecked call and a typed call to the same method keep distinct source locations', () => {
  const project = path.resolve(root, '../../lang-resolution/ts-virtual-dispatch');
  const report = compilerReport(project, ['src/app.ts:22:9 TS2339']);
  assert.equal(report.uncheckedMemberSites.length, 1);
  const [{ file, start: uncheckedStart }] = report.uncheckedMemberSites;
  const calls = report.CALLS.sites.filter(
    (site) => site.file === file && site.target === 'src/app.ts#14:2',
  );
  assert.equal(calls.length, 1);
  assert.notEqual(calls[0].start, uncheckedStart);
  assert.throws(
    () => compareReports({ sites: calls }, { sites: [{ ...calls[0], start: uncheckedStart }] }),
    /Missing from actual/,
  );
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
  for (const [leftTarget, rightTarget] of [
    [left, right],
    [JSON.stringify([left, false, 'act']), JSON.stringify([right, false, 'act'])],
  ]) {
    const leftEdge = calls.edges.find(({ to }) => to === leftTarget);
    const rightEdge = calls.edges.find(({ to }) => to === rightTarget);
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

test('a rebound this receiver produces one call diagnostic at the compiler-rejected site', async () => {
  const directory = path.resolve(root, '../../lang-resolution/ts-dynamic-this-no-seed');
  const diagnostics = JSON.parse(
    readFileSync(new URL('./diagnostics.json', import.meta.url), 'utf8'),
  );
  const expected = diagnostics['lang-resolution/ts-dynamic-this-no-seed'];
  const reference = compilerReport(directory, expected);
  assert.equal(reference.uncheckedMemberSites.length, 1);
  const { pipeline } = await compareProject(directory, {}, expected);
  const drops = pipeline.resolutionOutcomes.filter(
    (outcome) =>
      outcome.kind === 'suppressed' &&
      outcome.reason === 'receiver-owned-but-unbound' &&
      outcome.siteKind === 'call',
  );
  assert.deepEqual(
    drops.map(({ filePath, range }) => [
      filePath,
      range.startLine + ':' + range.startCol,
      range.endLine + ':' + range.endCol,
    ]),
    reference.uncheckedMemberSites.map(({ file, start, end }) => [file, start, end]),
  );
});

test('module ownership exposes conflict candidates and marks erased file dependencies', async () => {
  const directory = path.resolve(root, '../typescript-module-ownership');
  const { graph, resolutionOutcomes } = await runPipelineFromRepo(directory, () => {});
  const conflicts = (resolutionOutcomes ?? []).filter(
    (outcome) => outcome.kind === 'reexport-ambiguous' && outcome.name === 'publish',
  );
  const candidates = ['def:left.ts#2:7:Function:publish', 'def:right.ts#1:7:Function:publish'];
  for (const barrel of ['ambiguous.ts', 'reversed.ts']) {
    const conflict = conflicts.find((outcome) => outcome.filePath === barrel);
    assert.deepEqual(conflict && [...conflict.candidateIds].sort(), candidates);
  }
  const imports = [...graph.iterRelationshipsByType('IMPORTS')];
  for (const file of ['types.ts', 'type-star.ts', 'type-namespace.ts']) {
    const edge = imports.find(
      (edge) => edge.sourceId === 'File:' + file && edge.targetId === 'File:left.ts',
    );
    assert.match(edge?.reason ?? '', /\(type-only\)/);
  }
});
