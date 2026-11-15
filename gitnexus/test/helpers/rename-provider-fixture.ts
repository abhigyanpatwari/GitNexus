import { afterEach, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { renameSymbol } from '../../src/mcp/local/rename/rename-plan.js';

export function createRenameFixtureHelpers() {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  async function fixture(
    files: Record<string, string>,
    name = 'target',
    kind = 'Function',
    targetFile?: string,
  ) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rename-native-'));
    roots.push(root);
    await Promise.all(
      Object.entries(files).map(([file, content]) => fs.writeFile(path.join(root, file), content)),
    );
    const result = await runPipelineFromRepo(root, () => undefined, {
      workerPoolSize: 1,
      skipGraphPhases: true,
    });
    const nodes = [...result.graph.iterNodes()];
    const target = nodes.find(
      (node) =>
        node.properties.name === name &&
        node.label === kind &&
        (!targetFile || node.properties.filePath === targetFile),
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
    return { root, nodes, symbol };
  }

  async function expectRename(
    files: Record<string, string>,
    expected: Record<string, string>,
    name = 'target',
    kind = 'Function',
    newName = 'renamed',
    targetFile?: string,
  ) {
    const { root, nodes, symbol } = await fixture(files, name, kind, targetFile);
    const preview = await renameSymbol(root, symbol, { new_name: newName, dry_run: true }, nodes);
    expect(preview, JSON.stringify(preview)).toMatchObject({ status: 'success', applied: false });
    for (const [file, content] of Object.entries(files))
      expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(content);
    const applied = await renameSymbol(root, symbol, { new_name: newName, dry_run: false }, nodes);
    expect(applied, JSON.stringify(applied)).toMatchObject({
      status: 'success',
      applied: true,
      changes: preview.changes,
    });
    for (const [file, content] of Object.entries(expected))
      expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(content);
  }
  return { fixture, expectRename };
}
