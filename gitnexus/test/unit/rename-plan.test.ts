import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeRenamePlan, type RenamePlan } from '../../src/mcp/local/rename/rename-plan.js';

describe('exact rename plan application', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'rename-plan-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function plan(files: Record<string, string>): Promise<RenamePlan> {
    for (const [name, text] of Object.entries(files))
      await fs.writeFile(path.join(root, name), text);
    return {
      symbol: { name: 'close', filePath: 'a.ts', startLine: 1 },
      new_name: 'finish',
      coverage: {
        name: 'typescript',
        version: '5.9.3',
        scope: 'project',
        tsconfig_path: 'tsconfig.json',
        source_file_count: Object.keys(files).length,
      },
      snapshots: new Map(
        Object.entries(files).map(([file, text]) => [path.join(root, file), text]),
      ),
      edits: Object.entries(files).flatMap(([file_path, text]) => {
        const start = text.indexOf('close');
        return [{ file_path, start, length: 5, old_text: 'close', new_text: 'finish' }];
      }),
    };
  }

  it('counts occurrences on one line and preserves unrelated keys, CRLF and UTF-16 offsets', async () => {
    const text = '// 🐈\r\nconst hooks = { close: () => writer.close() }; writer.close();\r\n';
    const p = await plan({ 'a.ts': text });
    const starts = [text.indexOf('writer.close') + 7, text.lastIndexOf('writer.close') + 7];
    p.edits = starts.map((start) => ({
      file_path: 'a.ts',
      start,
      length: 5,
      old_text: 'close',
      new_text: 'complete',
    }));
    const preview = await executeRenamePlan(root, p, true);
    expect(preview).toMatchObject({
      status: 'success',
      applied: false,
      application_status: 'not_requested',
      total_edits: 2,
      semantic_edits: 2,
    });
    expect(preview.changes[0].edits.map((e) => e.line)).toEqual([2, 2]);
    expect(await fs.readFile(path.join(root, 'a.ts'), 'utf8')).toBe(text);
    const applied = await executeRenamePlan(root, p, false);
    expect(applied).toMatchObject({
      status: 'success',
      applied: true,
      application_status: 'applied',
      total_edits: 2,
    });
    expect(await fs.readFile(path.join(root, 'a.ts'), 'utf8')).toBe(
      '// 🐈\r\nconst hooks = { close: () => writer.complete() }; writer.complete();\r\n',
    );
  });

  it('deduplicates identical ranges while retaining full affix replacements', async () => {
    const p = await plan({ 'a.ts': 'export { close };\nconst obj = { close };' });
    p.edits[0].new_text = 'finish as close';
    p.edits.push({ ...p.edits[0] });
    const start = p.snapshots.get(path.join(root, 'a.ts'))!.lastIndexOf('close');
    p.edits.push({
      file_path: 'a.ts',
      start,
      length: 5,
      old_text: 'close',
      new_text: 'close: finish',
    });
    expect(await executeRenamePlan(root, p, false)).toMatchObject({
      total_edits: 2,
      semantic_edits: 2,
    });
    expect(await fs.readFile(path.join(root, 'a.ts'), 'utf8')).toBe(
      'export { finish as close };\nconst obj = { close: finish };',
    );
  });

  it.each(['overlap', 'unexpected text', 'stale snapshot'] as const)(
    'blocks all writes on %s',
    async (failure) => {
      const p = await plan({ 'a.ts': 'close()', 'b.ts': 'close()' });
      if (failure === 'overlap')
        p.edits.push({ ...p.edits[0], start: 2, length: 3, old_text: 'ose' });
      if (failure === 'unexpected text') p.edits[1].old_text = 'wrong';
      if (failure === 'stale snapshot') await fs.writeFile(path.join(root, 'b.ts'), 'close(1)');
      const result = await executeRenamePlan(root, p, false);
      expect(result).toMatchObject({
        status: 'error',
        planning_status: 'blocked',
        applied: false,
        application_status: 'not_started',
        total_edits: 0,
      });
      expect(await fs.readFile(path.join(root, 'a.ts'), 'utf8')).toBe('close()');
    },
  );

  it('checks snapshots of unedited project files too', async () => {
    const p = await plan({ 'a.ts': 'close()', 'b.ts': 'close()' });
    p.edits.pop();
    await fs.writeFile(path.join(root, 'b.ts'), 'changed binding');
    expect(await executeRenamePlan(root, p, false)).toMatchObject({
      planning_status: 'blocked',
      total_edits: 0,
    });
    expect(await fs.readFile(path.join(root, 'a.ts'), 'utf8')).toBe('close()');
  });

  it('rejects lexical traversal and symlink escapes', async () => {
    const p = await plan({ 'a.ts': 'close()' });
    p.edits[0].file_path = '../outside.ts';
    expect(await executeRenamePlan(root, p, false)).toMatchObject({ planning_status: 'blocked' });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'rename-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'b.ts'), 'close()');
      // Directory junctions exercise the same escape without Windows symlink privileges.
      await fs.symlink(
        outside,
        path.join(root, 'link'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      p.edits[0].file_path = 'link/b.ts';
      p.snapshots.set(path.join(root, 'link/b.ts'), 'close()');
      expect(await executeRenamePlan(root, p, false)).toMatchObject({ planning_status: 'blocked' });
      expect(await fs.readFile(path.join(outside, 'b.ts'), 'utf8')).toBe('close()');
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it.each([0, 1])('reports exactly landed edits when writing file %i fails', async (failAt) => {
    const p = await plan({ 'a.ts': 'close()', 'b.ts': 'close()' });
    const original = fs.writeFile.bind(fs);
    let calls = 0;
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      if (calls++ === failAt) throw new Error('disk full');
      return original(...args);
    });
    const result = await executeRenamePlan(root, p, false);
    expect(result).toMatchObject({
      status: 'partial',
      applied: failAt > 0,
      application_status: failAt ? 'partial' : 'failed',
      total_edits: failAt,
      files_affected: failAt,
    });
    expect(result.failed_files).toContain(failAt ? 'b.ts' : 'a.ts');
    expect(await fs.readFile(path.join(root, 'a.ts'), 'utf8')).toBe(
      failAt ? 'finish()' : 'close()',
    );
    expect(await fs.readFile(path.join(root, 'b.ts'), 'utf8')).toBe('close()');
  });

  it('reports a race after an earlier write as partial', async () => {
    const p = await plan({ 'a.ts': 'close()', 'b.ts': 'close()' });
    const original = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      await original(...args);
      if (String(args[0]).endsWith('a.ts')) await original(path.join(root, 'b.ts'), 'user edit');
    });
    expect(await executeRenamePlan(root, p, false)).toMatchObject({
      status: 'partial',
      applied: true,
      total_edits: 1,
      failed_files: ['b.ts'],
    });
    expect(await fs.readFile(path.join(root, 'b.ts'), 'utf8')).toBe('user edit');
  });
});
