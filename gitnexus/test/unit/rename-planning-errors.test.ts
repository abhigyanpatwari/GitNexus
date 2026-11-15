import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { GraphNode } from 'gitnexus-shared';
import { _captureLogger, type LoggerCapture } from '../../src/core/logger.js';
import { typescriptRenameProvider } from '../../src/core/ingestion/languages/typescript/rename.js';
import { RenameFailure, renameSymbol } from '../../src/mcp/local/rename/rename-plan.js';

describe('rename planning diagnostics', () => {
  let root: string;
  let capture: LoggerCapture;
  const source = 'function target() {}\ntarget();\n';
  const symbol = {
    uid: 'Function:model.ts:target',
    name: 'target',
    filePath: 'model.ts',
    startLine: 1,
  };
  const nodes: GraphNode[] = [
    { id: 'File:model.ts', label: 'File', properties: { name: 'model.ts', filePath: 'model.ts' } },
    {
      id: symbol.uid,
      label: 'Function',
      properties: { name: symbol.name, filePath: symbol.filePath, startLine: 0, endLine: 0 },
    },
  ];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'rename-planning-errors-'));
    await fs.writeFile(path.join(root, symbol.filePath), source);
    capture = _captureLogger();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    capture.restore();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('logs unexpected provider failures with structured error details and preserves sources', async () => {
    const failure = new Error('provider exploded');
    vi.spyOn(typescriptRenameProvider, 'validateName').mockImplementation(() => {
      throw failure;
    });
    expect(
      await renameSymbol(root, symbol, { new_name: 'renamed', dry_run: false }, nodes),
    ).toMatchObject({
      status: 'error',
      code: 'rename_failed',
      application_status: 'not_started',
      total_edits: 0,
    });
    expect(capture.records()).toEqual([
      expect.objectContaining({
        level: 50,
        msg: 'Semantic rename planning failed',
        symbolUid: symbol.uid,
        filePath: symbol.filePath,
        err: expect.objectContaining({ message: failure.message, stack: failure.stack }),
      }),
    ]);
    expect(await fs.readFile(path.join(root, symbol.filePath), 'utf8')).toBe(source);
  });

  it('keeps expected provider refusals quiet', async () => {
    vi.spyOn(typescriptRenameProvider, 'validateName').mockImplementation(() => {
      throw new RenameFailure('unsupported_reference', 'Provider cannot prove this reference.');
    });
    expect(
      await renameSymbol(root, symbol, { new_name: 'renamed', dry_run: false }, nodes),
    ).toMatchObject({
      status: 'error',
      code: 'unsupported_reference',
      application_status: 'not_started',
      total_edits: 0,
    });
    expect(capture.records()).toEqual([]);
    expect(await fs.readFile(path.join(root, symbol.filePath), 'utf8')).toBe(source);
  });
});
