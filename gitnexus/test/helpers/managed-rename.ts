import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { renameSymbol } from '../../src/mcp/local/rename/rename-plan.js';

export function managedRename(roots: string[]) {
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
    assert.notEqual(
      target,
      undefined,
      JSON.stringify(nodes.filter((node) => node.label !== 'File')),
    );
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
    assert.partialDeepStrictEqual(
      preview,
      { status: 'success', applied: false },
      JSON.stringify(preview),
    );
    for (const [file, content] of Object.entries(files))
      assert.equal(await fs.readFile(path.join(root, file), 'utf8'), content);
    const applied = await renameSymbol(root, symbol, { new_name: newName, dry_run: false }, nodes);
    assert.partialDeepStrictEqual(
      applied,
      {
        status: 'success',
        applied: true,
        changes: preview.changes,
      },
      JSON.stringify(applied),
    );
    for (const [file, content] of Object.entries(expected))
      assert.equal(await fs.readFile(path.join(root, file), 'utf8'), content);
  }
  return { fixture, expectRename };
}
