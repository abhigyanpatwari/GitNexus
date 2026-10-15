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
        name: 'gitnexus-semantic',
        scope: 'indexed-repository',
        languages: ['typescript'],
        limitations: [],
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

  it.each([{ start: -1 }, { start: 0.5 }, { length: 0 }, { length: 9 }, { old_text: 'wrong' }])(
    'refuses invalid edit spans before any write: %j',
    async (invalid) => {
      const p = await plan({ 'a.ts': 'close()', 'b.ts': 'close()' });
      Object.assign(p.edits[1], invalid);
      for (const dryRun of [true, false]) {
        expect(await executeRenamePlan(root, p, dryRun)).toMatchObject({
          status: 'error',
          code: 'invalid_edit',
          planning_status: 'blocked',
          application_status: 'not_started',
          applied: false,
          total_edits: 0,
          files_affected: 0,
          changes: [],
        });
        expect(await fs.readFile(path.join(root, 'a.ts'), 'utf8')).toBe('close()');
        expect(await fs.readFile(path.join(root, 'b.ts'), 'utf8')).toBe('close()');
      }
    },
  );

  it('refuses two paths to the same physical source before any write', async () => {
    const p = await plan({ 'a.ts': 'close()' });
    await fs.symlink(
      root,
      path.join(root, 'alias'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    p.edits.push({ ...p.edits[0], file_path: 'alias/a.ts' });
    p.snapshots.set(path.join(root, 'alias/a.ts'), 'close()');
    for (const dryRun of [true, false]) {
      expect(await executeRenamePlan(root, p, dryRun)).toMatchObject({
        status: 'error',
        code: 'duplicate_file',
        planning_status: 'blocked',
        application_status: 'not_started',
        applied: false,
        total_edits: 0,
        files_affected: 0,
        changes: [],
      });
      expect(await fs.readFile(path.join(root, 'a.ts'), 'utf8')).toBe('close()');
    }
  });

  it('accepts landed outputs while applying an ordinary multi-file plan', async () => {
    const p = await plan({ 'a.ts': 'close()', 'b.ts': 'close()' });
    expect(await executeRenamePlan(root, p, false)).toMatchObject({
      status: 'success',
      applied: true,
      application_status: 'applied',
      total_edits: 2,
      files_affected: 2,
    });
    expect(await fs.readFile(path.join(root, 'a.ts'), 'utf8')).toBe('finish()');
    expect(await fs.readFile(path.join(root, 'b.ts'), 'utf8')).toBe('finish()');
    expect((await fs.readdir(root)).sort()).toEqual(['a.ts', 'b.ts']);
  });

  it.each([0, 1])(
    'blocks installation when an unedited snapshot changes while staging file %i',
    async (changeAt) => {
      const p = await plan({ 'a.ts': 'close()', 'b.ts': 'close()', 'c.ts': '// no references' });
      p.edits.pop();
      const original = fs.writeFile.bind(fs);
      let calls = 0;
      vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
        await original(...args);
        if (calls++ === changeAt) await original(path.join(root, 'c.ts'), 'close();');
      });
      expect(await executeRenamePlan(root, p, false)).toMatchObject({
        status: changeAt ? 'partial' : 'error',
        applied: changeAt > 0,
        application_status: changeAt ? 'partial' : 'failed',
        code: 'source_changed',
        total_edits: changeAt,
        files_affected: changeAt,
        failed_files: changeAt ? ['b.ts'] : ['a.ts'],
        unattempted_files: changeAt ? [] : ['b.ts'],
      });
      expect(await fs.readFile(path.join(root, 'a.ts'), 'utf8')).toBe(
        changeAt ? 'finish()' : 'close()',
      );
      expect(await fs.readFile(path.join(root, 'b.ts'), 'utf8')).toBe('close()');
      expect(await fs.readFile(path.join(root, 'c.ts'), 'utf8')).toBe('close();');
      expect((await fs.readdir(root)).sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    },
  );

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

  const writeFailures: {
    failAt: number;
    landed: string[];
    failed: string[];
    unattempted: string[];
  }[] = [
    { failAt: 0, landed: [], failed: ['a.ts'], unattempted: ['b.ts', 'c.ts'] },
    { failAt: 1, landed: ['a.ts'], failed: ['b.ts'], unattempted: ['c.ts'] },
    { failAt: 2, landed: ['a.ts', 'b.ts'], failed: ['c.ts'], unattempted: [] },
  ];

  it.each(writeFailures)(
    'separates landed, failed and never-attempted files when writing file $failAt fails',
    async ({ failAt, landed, failed, unattempted }) => {
      const p = await plan({ 'a.ts': 'close()', 'b.ts': 'close()', 'c.ts': 'close()' });
      const original = fs.writeFile.bind(fs);
      let calls = 0;
      vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
        if (calls++ === failAt) {
          await original(args[0], String(args[1]).slice(0, 3), args[2]);
          throw new Error('disk full');
        }
        return original(...args);
      });
      const result = await executeRenamePlan(root, p, false);
      expect(result).toMatchObject({
        status: failAt ? 'partial' : 'error',
        applied: failAt > 0,
        application_status: failAt ? 'partial' : 'failed',
        code: 'write_failed',
        total_edits: failAt,
        files_affected: failAt,
        failed_files: failed,
        unattempted_files: unattempted,
      });
      expect(result.changes.map((change) => change.file_path)).toEqual(landed);
      expect(result.error).toContain('failed_files and unattempted_files');
      expect(result.error).toContain('not transactional');
      for (const file of ['a.ts', 'b.ts', 'c.ts'])
        expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(
          landed.includes(file) ? 'finish()' : 'close()',
        );
      expect((await fs.readdir(root)).sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    },
  );

  it.each(['a.ts', 'b.ts'])(
    'reports a race in %s after an earlier write as partial',
    async (changedFile) => {
      const p = await plan({ 'a.ts': 'close()', 'b.ts': 'close()' });
      const original = fs.rename.bind(fs);
      vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
        await original(...args);
        if (String(args[1]).endsWith('a.ts'))
          await fs.writeFile(path.join(root, changedFile), 'user edit');
      });
      expect(await executeRenamePlan(root, p, false)).toMatchObject({
        status: 'partial',
        applied: true,
        application_status: 'partial',
        code: 'source_changed',
        total_edits: 1,
        failed_files: ['b.ts'],
        unattempted_files: [],
      });
      expect(await fs.readFile(path.join(root, changedFile), 'utf8')).toBe('user edit');
      if (changedFile === 'a.ts')
        expect(await fs.readFile(path.join(root, 'b.ts'), 'utf8')).toBe('close()');
      expect((await fs.readdir(root)).sort()).toEqual(['a.ts', 'b.ts']);
    },
  );

  it('blocks a destination changed while staging its replacement', async () => {
    const p = await plan({ 'a.ts': 'close()' });
    const original = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      await original(...args);
      await original(path.join(root, 'a.ts'), 'user edit');
    });
    expect(await executeRenamePlan(root, p, false)).toMatchObject({
      status: 'error',
      applied: false,
      code: 'source_changed',
      total_edits: 0,
    });
    expect(await fs.readFile(path.join(root, 'a.ts'), 'utf8')).toBe('user edit');
    expect(await fs.readdir(root)).toEqual(['a.ts']);
  });

  it('preserves a destination edited during the final scan of unedited sources', async () => {
    const p = await plan({ 'a.ts': 'close()', 'z.ts': '// no references' });
    p.edits.pop();
    const destination = path.join(root, 'a.ts');
    const original = fs.readFile.bind(fs);
    let evidenceReads = 0;
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      const contents = await original(...args);
      if (args[0] === path.join(root, 'z.ts') && ++evidenceReads === 2)
        await fs.writeFile(destination, 'user edit');
      return contents;
    });

    expect(await executeRenamePlan(root, p, false)).toMatchObject({
      status: 'error',
      applied: false,
      application_status: 'failed',
      code: 'source_changed',
      total_edits: 0,
      failed_files: ['a.ts'],
      unattempted_files: [],
    });
    expect(await fs.readFile(destination, 'utf8')).toBe('user edit');
    expect((await fs.readdir(root)).sort()).toEqual(['a.ts', 'z.ts']);
  });

  it('preserves the destination mode after replacement', async () => {
    const p = await plan({ 'a.ts': 'close()' });
    await fs.chmod(path.join(root, 'a.ts'), 0o750);
    const mode = (await fs.stat(path.join(root, 'a.ts'))).mode;
    expect(await executeRenamePlan(root, p, false)).toMatchObject({ applied: true });
    expect((await fs.stat(path.join(root, 'a.ts'))).mode).toBe(mode);
  });
});
