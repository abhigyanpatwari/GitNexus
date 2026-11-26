import assert from 'node:assert/strict';
import { expect } from 'expect';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { GraphNode } from 'gitnexus-shared';
import { renameSymbol, type RenameSymbol } from '../../src/mcp/local/rename/rename-plan.js';

export async function fixture(root: string, file: string, source: string, extra: GraphNode[] = []) {
  await fs.writeFile(path.join(root, file), source);
  return [
    { id: `File:${file}`, label: 'File', properties: { name: file, filePath: file } },
    {
      id: `Function:${file}:target`,
      label: 'Function',
      properties: { name: 'target', filePath: file, startLine: 1, endLine: 1 },
    },
    ...extra,
  ] as GraphNode[];
}

export async function expectBlockedPreviewAndApply(
  root: string,
  file: string,
  source: string,
  symbol: RenameSymbol,
  nodes: GraphNode[],
  code: string,
  newName = 'Renamed',
) {
  for (const dry_run of [true, false]) {
    const result = await renameSymbol(root, symbol, { new_name: newName, dry_run }, nodes);
    assert.partialDeepStrictEqual(result, {
      status: 'error',
      application_status: 'not_started',
      applied: false,
      total_edits: 0,
      files_affected: 0,
      changes: [],
      code,
    });
    expect(result.planning_status).not.toBe('ready');
    expect(await fs.readFile(path.join(root, file))).toEqual(Buffer.from(source));
  }
}

export async function expectSupportedPreviewAndApply(
  root: string,
  file: string,
  source: string,
  symbol: RenameSymbol,
  nodes: GraphNode[],
  expected: string,
  newName = 'Renamed',
) {
  const preview = await renameSymbol(root, symbol, { new_name: newName, dry_run: true }, nodes);
  assert.partialDeepStrictEqual(preview, { status: 'success', applied: false });
  expect(preview.total_edits).toBeGreaterThan(0);
  expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(source);
  const applied = await renameSymbol(root, symbol, { new_name: newName, dry_run: false }, nodes);
  assert.partialDeepStrictEqual(applied, {
    status: 'success',
    applied: true,
    changes: preview.changes,
  });
  expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(expected);
}
