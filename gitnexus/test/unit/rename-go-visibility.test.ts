import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { hidesExportFromPackage } from '../../src/core/ingestion/languages/go/rename.js';
import { renameSymbol } from '../../src/mcp/local/rename/rename-plan.js';

const API = 'package api\n\nfunc Target(value int) int { return value + 1 }\n';
const MODULE = 'module example.com/renamefixture\n\ngo 1.22\n';
const IMPORT = 'import "example.com/renamefixture/api"';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

/** Go packages are directories, so unlike the flat shared helper this writes subdirectories. */
async function indexTree(
  files: Record<string, string>,
  name: string,
  kind: string,
  targetFile: string,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rename-go-visibility-'));
  roots.push(root);
  const tree = { 'go.mod': MODULE, ...files };
  for (const [file, content] of Object.entries(tree)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  }
  const result = await runPipelineFromRepo(root, () => undefined, {
    workerPoolSize: 1,
    skipGraphPhases: true,
  });
  const nodes = [...result.graph.iterNodes()];
  const target = nodes.find(
    (node) =>
      node.properties.name === name &&
      node.label === kind &&
      node.properties.filePath === targetFile,
  );
  expect(target, JSON.stringify(nodes.filter((node) => node.label !== 'File'))).toBeDefined();
  const symbol = {
    uid: target!.id,
    name: target!.properties.name,
    filePath: target!.properties.filePath,
    startLine: target!.properties.startLine! + 1,
    endLine: target!.properties.endLine! + 1,
    kind: target!.label,
  };
  return { root, nodes, symbol, tree };
}

describe('Go export rule (spec: first code point has Unicode category Lu)', () => {
  const declaring = { path: 'api/api.go', content: 'package api\n' };
  const importer = { path: 'main.go', content: 'package main\n' };

  it.each([
    ['Target', 'target'],
    ['Ünicode', 'ünicode'],
    ['Σigma', 'σigma'],
    ['Target', '_target'],
    ['Ünicode', '日本'],
    ['Target', 'ǅtitle'],
    ['Target', 'Ⅷnumeral'],
    ['\u{1D400}name', 'name'],
  ])('hides %s from another package when renamed to %s', (oldName, newName) => {
    expect(hidesExportFromPackage({ oldName, newName, declaring, user: importer })).toBe(true);
  });

  it.each([
    ['Target', 'Renamed'],
    ['Target', 'Ünicode'],
    ['target', 'Renamed'],
    ['target', 'renamed'],
    ['日本', '中文'],
    ['日本', 'Ünicode'],
    ['ǅtitle', 'renamed'],
    ['Ⅷnumeral', 'renamed'],
    ['_target', 'Renamed'],
    ['Target', '\u{1D400}name'],
  ])('keeps %s visible to another package when renamed to %s', (oldName, newName) => {
    expect(hidesExportFromPackage({ oldName, newName, declaring, user: importer })).toBe(false);
  });

  it.each([
    [
      'another file of the same package',
      declaring,
      { path: 'api/other.go', content: 'package api\n' },
    ],
    ['a same-package test file', declaring, { path: 'api/api_test.go', content: 'package api\n' }],
    ['the declaring file itself', declaring, declaring],
    [
      'the declaring file even with no readable clause',
      { path: 'api/api.go', content: 'not a package clause\n' },
      { path: 'api/api.go', content: 'not a package clause\n' },
    ],
  ])('allows unexporting for a use in %s', (_label, home, user) => {
    expect(
      hidesExportFromPackage({ oldName: 'Target', newName: 'target', declaring: home, user }),
    ).toBe(false);
  });

  it.each([
    ['an external test package in the same directory', 'api/api_test.go', 'package api_test\n'],
    ['another directory', 'other/api.go', 'package api\n'],
    ['a file with no readable package clause', 'api/broken.go', 'func broken() {}\n'],
    ['a clause that follows a leading comment', 'api/c.go', '/* package api */\npackage main\n'],
  ])('refuses unexporting for a use in %s', (_label, userPath, content) => {
    expect(
      hidesExportFromPackage({
        oldName: 'Target',
        newName: 'target',
        declaring,
        user: { path: userPath, content },
      }),
    ).toBe(true);
  });

  it('cannot prove the package when the declaring source is unavailable', () => {
    expect(
      hidesExportFromPackage({
        oldName: 'Target',
        newName: 'target',
        declaring: undefined,
        user: importer,
      }),
    ).toBe(true);
  });
});

describe('Go rename refuses to unexport symbols other packages use', () => {
  it.each([
    [
      'a constant',
      'Limit',
      'Const',
      'limit',
      {
        'api/api.go': 'package api\n\nconst Limit = 3\n',
        'main.go': `package main\n\n${IMPORT}\n\nvar bound = api.Limit\n\nfunc main() { _ = bound }\n`,
      },
    ],
    [
      'a package variable',
      'Counter',
      'Variable',
      'counter',
      {
        'api/api.go': 'package api\n\nvar Counter = 3\n',
        'main.go': `package main\n\n${IMPORT}\n\nvar seen = api.Counter\n\nfunc main() { _ = seen }\n`,
      },
    ],
    [
      'a function used through a dot import',
      'Target',
      'Function',
      'target',
      {
        'api/api.go': API,
        'main.go': `package main\n\nimport . "example.com/renamefixture/api"\n\nfunc run(value int) int { return Target(value) }\n\nfunc main() { _ = run(1) }\n`,
      },
    ],
    [
      'a function used by an external test package in the same directory',
      'Target',
      'Function',
      'target',
      {
        'api/api.go': API,
        'api/api_test.go': `package api_test\n\nimport "testing"\n\n${IMPORT}\n\nfunc TestTarget(t *testing.T) { _ = api.Target(1) }\n`,
      },
    ],
  ])(
    '%s',
    async (_label, name, kind, newName, files) => {
      const { root, nodes, symbol, tree } = await indexTree(files, name, kind, 'api/api.go');
      for (const dry_run of [true, false]) {
        const result = await renameSymbol(root, symbol, { new_name: newName, dry_run }, nodes);
        expect(result, JSON.stringify(result)).toMatchObject({
          status: 'error',
          code: 'invalid_name',
          planning_status: 'blocked',
          applied: false,
          total_edits: 0,
        });
        expect(result.error).toContain('outside its declaring package');
      }
      for (const [file, content] of Object.entries(tree))
        expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(content);
    },
    60000,
  );
});

describe('Go rename keeps visibility-preserving and package-local renames', () => {
  it.each([
    [
      'exported to exported across packages',
      'Renamed',
      {
        'api/api.go': API,
        'main.go': `package main\n\n${IMPORT}\n\nfunc run(value int) int { return api.Target(value) }\n\nfunc main() { _ = run(1) }\n`,
      },
      {
        'api/api.go': 'package api\n\nfunc Renamed(value int) int { return value + 1 }\n',
        'main.go': `package main\n\n${IMPORT}\n\nfunc run(value int) int { return api.Renamed(value) }\n\nfunc main() { _ = run(1) }\n`,
      },
    ],
    [
      'exported to unexported when a same-package test file is the only other user',
      'target',
      {
        'api/api.go': API,
        'api/api_test.go':
          'package api\n\nimport "testing"\n\nfunc TestTarget(t *testing.T) { _ = Target(1) }\n',
      },
      {
        'api/api.go': 'package api\n\nfunc target(value int) int { return value + 1 }\n',
        'api/api_test.go':
          'package api\n\nimport "testing"\n\nfunc TestTarget(t *testing.T) { _ = target(1) }\n',
      },
    ],
  ])(
    '%s',
    async (_label, newName, files, expected) => {
      const { root, nodes, symbol } = await indexTree(files, 'Target', 'Function', 'api/api.go');
      const preview = await renameSymbol(root, symbol, { new_name: newName, dry_run: true }, nodes);
      expect(preview, JSON.stringify(preview)).toMatchObject({ status: 'success', applied: false });
      const applied = await renameSymbol(
        root,
        symbol,
        { new_name: newName, dry_run: false },
        nodes,
      );
      expect(applied, JSON.stringify(applied)).toMatchObject({
        status: 'success',
        applied: true,
        changes: preview.changes,
      });
      for (const [file, content] of Object.entries(expected))
        expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(content);
    },
    60000,
  );
});
