/**
 * The Go rename provider refuses to unexport a symbol another package uses
 * (`goRenameProvider.checkOccurrence`, see `rename-go-visibility.test.ts`), so
 * the planner normally stops before it edits anything. These cases switch that
 * provider gate OFF and ask the OTHER line of defence on its own: the
 * re-resolution pass that re-runs scope resolution over the rewritten sources
 * and certifies that every written binding still denotes what it denoted.
 *
 * That pass used to certify the unsafe rewrite. A namespace-qualified lookup
 * treated every module-scope declaration of the target package as a public
 * member, so `api.target` re-resolved to the very declaration `api.Target`
 * named, the binding looked unchanged, and a program that no longer compiles
 * was accepted. `ScopeResolver.isNamespaceMemberVisible` (Go: an identifier is
 * exported only with an uppercase first letter) closes that.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { goRenameProvider } from '../../src/core/ingestion/languages/go/rename.js';
import { renameSymbol } from '../../src/mcp/local/rename/rename-plan.js';

const MODULE = 'module example.com/renamefixture\n\ngo 1.22\n';
const IMPORT = 'import "example.com/renamefixture/api"';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

/** Go packages are directories, so unlike the flat shared helper this writes subdirectories. */
async function indexTree(
  files: Record<string, string>,
  name: string,
  kind: string,
  targetFile: string,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rename-go-reresolution-'));
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

/** The provider gate answers "no issue" for every occurrence: only re-resolution remains. */
function disableProviderVisibilityGate(): void {
  vi.spyOn(goRenameProvider, 'checkOccurrence').mockReturnValue(undefined);
}

describe('Go rename re-resolution refuses to certify an unexport on its own', () => {
  it.each([
    [
      'a function called through a package qualifier',
      'Target',
      'Function',
      'target',
      {
        'api/api.go': 'package api\n\nfunc Target(value int) int { return value + 1 }\n',
        'main.go': `package main\n\n${IMPORT}\n\nfunc run(value int) int { return api.Target(value) }\n\nfunc main() { _ = run(1) }\n`,
      },
    ],
    [
      'a package variable read through a package qualifier',
      'Counter',
      'Variable',
      'counter',
      {
        'api/api.go': 'package api\n\nvar Counter = 3\n',
        'main.go': `package main\n\n${IMPORT}\n\nvar seen = api.Counter\n\nfunc main() { _ = seen }\n`,
      },
    ],
    [
      'a function called by bare name through a dot import',
      'Target',
      'Function',
      'target',
      {
        'api/api.go': 'package api\n\nfunc Target(value int) int { return value + 1 }\n',
        'main.go': `package main\n\nimport . "example.com/renamefixture/api"\n\nfunc run(value int) int { return Target(value) }\n\nfunc main() { _ = run(1) }\n`,
      },
    ],
    [
      'a function called through an aliased import',
      'Target',
      'Function',
      'target',
      {
        'api/api.go': 'package api\n\nfunc Target(value int) int { return value + 1 }\n',
        'main.go': `package main\n\nimport shim "example.com/renamefixture/api"\n\nfunc run(value int) int { return shim.Target(value) }\n\nfunc main() { _ = run(1) }\n`,
      },
    ],
    [
      'a function called by an external test package of the same directory',
      'Target',
      'Function',
      'target',
      {
        'api/api.go': 'package api\n\nfunc Target(value int) int { return value + 1 }\n',
        'api/api_test.go': `package api_test\n\nimport "testing"\n\n${IMPORT}\n\nfunc TestTarget(t *testing.T) { _ = api.Target(1) }\n`,
      },
    ],
  ])(
    'with the provider gate off, %s is still refused by re-resolution',
    async (_label, name, kind, newName, files) => {
      disableProviderVisibilityGate();
      const { root, nodes, symbol, tree } = await indexTree(files, name, kind, 'api/api.go');
      for (const dry_run of [true, false]) {
        const result = await renameSymbol(root, symbol, { new_name: newName, dry_run }, nodes);
        expect(result, JSON.stringify(result)).toMatchObject({
          status: 'error',
          code: 'name_collision',
          applied: false,
          total_edits: 0,
        });
        expect(result.error).toContain('changes a source binding');
      }
      for (const [file, content] of Object.entries(tree))
        expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(content);
    },
    60000,
  );
});

describe('Go rename re-resolution still certifies safe renames with the provider gate off', () => {
  it.each([
    [
      'an exported function renamed to another exported name across packages',
      'Renamed',
      {
        'api/api.go': 'package api\n\nfunc Target(value int) int { return value + 1 }\n',
        'main.go': `package main\n\n${IMPORT}\n\nfunc run(value int) int { return api.Target(value) }\n\nfunc main() { _ = run(1) }\n`,
      },
      {
        'api/api.go': 'package api\n\nfunc Renamed(value int) int { return value + 1 }\n',
        'main.go': `package main\n\n${IMPORT}\n\nfunc run(value int) int { return api.Renamed(value) }\n\nfunc main() { _ = run(1) }\n`,
      },
    ],
    [
      'an exported function unexported when every user shares its package',
      'target',
      {
        'api/api.go': 'package api\n\nfunc Target(value int) int { return value + 1 }\n',
        'api/other.go':
          'package api\n\nfunc Twice(value int) int { return Target(Target(value)) }\n',
      },
      {
        'api/api.go': 'package api\n\nfunc target(value int) int { return value + 1 }\n',
        'api/other.go':
          'package api\n\nfunc Twice(value int) int { return target(target(value)) }\n',
      },
    ],
  ])(
    'with the provider gate off, %s is applied',
    async (_label, newName, files, expected) => {
      disableProviderVisibilityGate();
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
