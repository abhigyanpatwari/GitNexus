import assert from 'node:assert/strict';
import test from 'node:test';
import { javaFixtureUses } from './check-fixture-ownership.mjs';

test('detects Java filesystem reads and writes through imports, path variables, and templates', () => {
  const uses = javaFixtureUses(
    [
      "import * as files from 'node:fs/promises';",
      "import { readFileSync as readSource } from 'node:fs';",
      "import { join as joinPath } from 'node:path';",
      "const project = '/tmp/project';",
      "const source = joinPath(project, 'src', 'Main.java');",
      "await files.writeFile(source, 'class Main {}');",
      'readSource(`/tmp/${project}/Main.java`);',
    ].join('\n'),
  );
  assert.deepEqual(
    uses.map(({ method, line }) => [method, line]),
    [
      ['writeFile', 6],
      ['readFileSync', 7],
    ],
  );
});

test('detects a Java source map passed to the fixture helper, including spreads and local aliases', () => {
  const result = javaFixtureUses(`
    import { useFixture as analyzeFixture } from '../resolvers/helpers.js';
    const sources = { 'model/Entity.java': 'class Entity {}' };
    analyzeFixture('entity', { ...sources });
  `);
  assert.deepEqual(
    result.map(({ method, path }) => [method, path]),
    [['useFixture', 'model/Entity.java']],
  );
});

test('recognizes a filesystem import only outside the scope of a parameter shadowing it', () => {
  const uses = javaFixtureUses(`
    import fs from 'node:fs';
    import { readFileSync as read } from 'node:fs';
    function inspect(fs) { fs.readFileSync('fixtures/java/Virtual.java'); }
    const inspectRead = ({ read }) => read('Virtual.java');
    function localWriter(fs, path) { fs.writeFileSync(path, ''); }
    localWriter(inMemory, 'Virtual.java');
    read('OnDisk.java');
  `);
  assert.deepEqual(
    uses.map(({ path }) => path),
    ['OnDisk.java'],
  );
});

test('detects compiler-fixture projects through a directory, URL, or imported fixture root', () => {
  for (const source of [
    "import path from 'node:path'; const p = path.join(root, 'compiler-conformance', 'java-arrays');",
    "const p = new URL('../fixtures/java-resolution/arrays', import.meta.url);",
    "import path from 'node:path'; import { FIXTURES } from '../helpers.js'; path.join(FIXTURES, 'java-calls');",
  ])
    assert.ok(javaFixtureUses(source).length, source);
});

test('allows graph metadata, mocked paths, and file-backed projects in other languages', () => {
  const source = `
    import fs from 'node:fs';
    import { useFixture } from '../helpers.js';
    const locations = ['src/Main.java', 'Class:Example.java:Example'];
    const virtual = { 'Example.java': 'class Example {}' };
    checkGraphLocations(virtual, locations);
    expect(report.languageForPath('Empty.java')).toBe('java');
    fs.writeFileSync('real.rs', 'fn main() {}');
    useFixture('swift-module', { 'Model.swift': 'struct Model {}' });
  `;
  assert.deepEqual(javaFixtureUses(source), []);
  assert.deepEqual(
    javaFixtureUses("import fs from 'node:fs'; vi.mock('node:fs'); fs.readFileSync('Mock.java');"),
    [],
  );
});

test('follows a local writer and rename fixture factory while leaving virtual map helpers alone', () => {
  const source = `
    import { writeFile } from 'node:fs/promises';
    import { createRenameFixtureHelpers } from '../helpers/rename-provider-fixture.js';
    const { expectRename: rename } = createRenameFixtureHelpers();
    async function writeFixture(root, name, contents) { await writeFile(root + '/' + name, contents); }
    const stage = (root, name) => writeFixture(root, name, 'class T {}');
    stage('/tmp/repo', 'T.java');
    rename({ 'Car.java': 'class Car {}' }, 'Car', 'Vehicle');
    const inMemory = (files) => Object.keys(files);
    inMemory({ 'Metadata.java': [] });
  `;
  assert.deepEqual(
    javaFixtureUses(source).map(({ method }) => method),
    ['stage', 'rename'],
  );
});
