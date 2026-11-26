import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { expect } from 'expect';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import fsPromises from 'node:fs/promises';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as pool from '../../../../dist/core/lbug/pool-adapter.js';
const graphRows: Record<string, unknown>[] = [];
const poolMock = mock.module(
  new URL('../../../../dist/core/lbug/pool-adapter.js', import.meta.url).href,
  {
    namedExports: {
      ...pool,
      executeQuery: async () => graphRows,
      executeParameterized: async () => [{ filePath: 'src/caller.ts' }],
    },
  },
);
after(() => poolMock.restore());
const { LocalBackend } = await import('../../../../dist/mcp/local/local-backend.js');
const fixture = new URL(
  '../../../../test/fixtures/compiler-conformance/typescript-rename-reports/',
  import.meta.url,
);
const SOURCE = await fs.readFile(new URL('writer.ts', fixture), 'utf8');
const CALLER = await fs.readFile(new URL('caller.ts', fixture), 'utf8');
function stubbedBackend(symbol: Record<string, unknown> = {}) {
  const backend = new LocalBackend();
  mock.method(backend as any, 'ensureInitialized', async () => {});
  mock.method(backend as any, 'context', async () => ({
    status: 'found',
    symbol: {
      uid: 'Method:src/writer.ts:Writer.close#0',
      name: 'close',
      kind: 'Method',
      filePath: 'src/writer.ts',
      startLine: 2,
      endLine: 2,
      ...symbol,
    },
    incoming: { calls: [], imports: [], extends: [], implements: [] },
  }));
  return backend;
}

const callRename = (backend: InstanceType<typeof LocalBackend>, repoPath: string, params = {}) =>
  (backend as any).rename(
    { repoPath, lbugPath: path.join(repoPath, '.gitnexus', 'lbug') },
    {
      symbol_name: 'close',
      new_name: 'closeWriter',
      ...params,
    },
  );

describe('semantic rename reports exact applied occurrences (#3486, #2605)', () => {
  let tmpDir: string;
  let execs = 0;

  beforeEach(async () => {
    execs = 0;
    mock.method(childProcess, 'execFileSync', () => {
      execs++;
      throw new Error('rg unavailable');
    });
    syncBuiltinESMExports();
    graphRows.splice(
      0,
      graphRows.length,
      ...['src/writer.ts', 'src/caller.ts'].map((filePath) => ({
        id: `File:${filePath}`,
        name: filePath,
        filePath,
      })),
      {
        id: 'Class:src/writer.ts:Writer',
        name: 'Writer',
        filePath: 'src/writer.ts',
        startLine: 0,
        endLine: 2,
      },
      {
        id: 'Class:src/writer.ts:Other',
        name: 'Other',
        filePath: 'src/writer.ts',
        startLine: 3,
        endLine: 5,
      },
      {
        id: 'Method:src/writer.ts:Writer.close#0',
        name: 'close',
        filePath: 'src/writer.ts',
        startLine: 1,
        endLine: 1,
      },
      {
        id: 'Method:src/writer.ts:Other.close#0',
        name: 'close',
        filePath: 'src/writer.ts',
        startLine: 4,
        endLine: 4,
      },
      {
        id: 'Function:src/writer.ts:run',
        name: 'run',
        filePath: 'src/writer.ts',
        startLine: 6,
        endLine: 13,
      },
      {
        id: 'Function:src/caller.ts:caller',
        name: 'caller',
        filePath: 'src/caller.ts',
        startLine: 1,
        endLine: 4,
      },
    );
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-3486-backend-'));
    await fs.mkdir(path.join(tmpDir, '.gitnexus'));
    await fs.writeFile(
      path.join(tmpDir, '.gitnexus', 'gitnexus.json'),
      JSON.stringify({ contentRetention: 'full', indexedAt: '2024-06-01T12:00:00Z' }),
    );
    await fs.mkdir(path.join(tmpDir, 'src'));
    await fs.writeFile(path.join(tmpDir, 'src/writer.ts'), SOURCE);
    await fs.writeFile(path.join(tmpDir, 'src/caller.ts'), CALLER);
  });

  afterEach(async () => {
    mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('previews bound occurrences, including callers absent from graph incoming files', async () => {
    const result = await callRename(stubbedBackend(), tmpDir);
    expect(result).toMatchObject({
      status: 'success',
      applied: false,
      result_version: 2,
      total_edits: 4,
      semantic_edits: 4,
      graph_edits: 0,
      text_search_edits: 0,
      text_search: 'not_used',
      files_affected: 2,
      coverage: { name: 'gitnexus-semantic', scope: 'indexed-repository' },
    });
    const edits = result.changes.flatMap((change: any) => change.edits);
    expect(edits.every((edit: any) => edit.confidence === 'semantic')).toBe(true);
    expect(edits.every((edit: any) => edit.old_text === 'close')).toBe(true);
    expect(
      result.changes.find((change: any) => change.file_path === 'src/writer.ts').edits,
    ).toHaveLength(3);
    expect(execs).toBe(0);
    expect(await fs.readFile(path.join(tmpDir, 'src/writer.ts'), 'utf8')).toBe(SOURCE);
  });

  it('applies only displayed spans, preserving unrelated same-line keys and symbols', async () => {
    const backend = stubbedBackend();
    const preview = await callRename(backend, tmpDir);
    const result = await callRename(backend, tmpDir, {
      dry_run: false,
      plan_token: preview.plan_token,
    });
    expect(result).toMatchObject({
      status: 'success',
      applied: true,
      total_edits: 4,
    });
    expect(result.changes).toEqual(preview.changes);
    expect(await fs.readFile(path.join(tmpDir, 'src/writer.ts'), 'utf8')).toBe(
      SOURCE.replace('  close() {}', '  closeWriter() {}').replaceAll(
        'writer.close()',
        'writer.closeWriter()',
      ),
    );
    expect(await fs.readFile(path.join(tmpDir, 'src/caller.ts'), 'utf8')).toBe(
      CALLER.replace('writer.close()', 'writer.closeWriter()'),
    );
  });

  it('refuses targets missing from the indexed graph', async () => {
    const rust = 'fn close() {}\nfn use_it() { close(); }\n';
    await fs.writeFile(path.join(tmpDir, 'src/lib.rs'), rust);
    const backend = stubbedBackend({
      uid: 'Function:src/lib.rs:close',
      kind: 'Function',
      filePath: 'src/lib.rs',
      startLine: 1,
      endLine: 1,
    });
    const result = await callRename(backend, tmpDir, { dry_run: false });
    expect(result).toMatchObject({ applied: false, status: 'error' });
    expect(await fs.readFile(path.join(tmpDir, 'src/lib.rs'), 'utf8')).toBe(rust);
  });

  it('rejects malformed dry_run instead of treating it as an apply request', async () => {
    const result = await callRename(stubbedBackend(), tmpDir, { dry_run: 0 });
    expect(result.error).toMatch(/dry_run/);
    expect(result.applied).toBe(false);
    expect(await fs.readFile(path.join(tmpDir, 'src/writer.ts'), 'utf8')).toBe(SOURCE);
  });

  it('reports only the files and occurrences whose writes landed', async () => {
    const backend = stubbedBackend();
    const preview = await callRename(backend, tmpDir);
    const originalRename = fsPromises.rename.bind(fsPromises);
    mock.method(
      fsPromises,
      'rename',
      async (
        source: Parameters<typeof fsPromises.rename>[0],
        destination: Parameters<typeof fsPromises.rename>[1],
      ) => {
        if (String(destination).endsWith(`${path.sep}writer.ts`)) throw new Error('EACCES');
        return originalRename(source, destination);
      },
    );
    const result = await callRename(backend, tmpDir, {
      dry_run: false,
      plan_token: preview.plan_token,
    });
    expect(result).toMatchObject({
      status: 'partial',
      applied: true,
      total_edits: 1,
      semantic_edits: 1,
    });
    expect(result.failed_files).toEqual(['src/writer.ts']);
    expect(result.changes.map((change: any) => change.file_path)).toEqual(['src/caller.ts']);
    expect(await fs.readFile(path.join(tmpDir, 'src/writer.ts'), 'utf8')).toBe(SOURCE);
    expect(await fs.readFile(path.join(tmpDir, 'src/caller.ts'), 'utf8')).toContain(
      'writer.closeWriter()',
    );
  });
});
