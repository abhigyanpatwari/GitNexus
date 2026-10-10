/** Backend regressions for #3486; retain preview/apply fidelity from #2605. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import fsPromises from 'fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../src/core/search/bm25-index.js', () => ({
  searchFTSFromLbug: vi.fn().mockResolvedValue({ results: [], ftsAvailable: true }),
}));
vi.mock('../../src/mcp/core/embedder.js', () => ({
  embedQuery: vi.fn().mockResolvedValue([]),
  getEmbeddingDims: vi.fn().mockReturnValue(384),
}));

// No text discovery is permitted, even when rg is installed on the host.
const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(() => {
    throw new Error('rg unavailable');
  }),
}));
vi.mock('child_process', async (importActual) => ({
  ...(await importActual<typeof import('child_process')>()),
  execFileSync: execFileSyncMock,
}));

import { LocalBackend } from '../../src/mcp/local/local-backend.js';

const { graphRows } = vi.hoisted(() => ({ graphRows: [] as Record<string, unknown>[] }));
vi.mock('../../src/core/lbug/pool-adapter.js', async (importActual) => ({
  ...(await importActual<typeof import('../../src/core/lbug/pool-adapter.js')>()),
  executeQuery: vi.fn(async () => graphRows),
  executeParameterized: vi.fn(async () => [{ filePath: 'src/caller.ts' }]),
}));

const SOURCE = `export class Writer {
  close() {}
}
export class Other {
  close() {}
}
export function run(writer: Writer, other: Other) {
  const hooks = { close: () => writer.close() }; writer.close(); other.close();
  // close should remain in this comment.
  const title = 'close';
  return { hooks, title };
}
`;
const CALLER = `import { Writer } from './writer.js';
export function caller(writer: Writer) { writer.close(); }
`;

function stubbedBackend(symbol: Record<string, unknown> = {}) {
  const backend = new LocalBackend();
  vi.spyOn(backend as any, 'ensureInitialized').mockResolvedValue(undefined);
  vi.spyOn(backend as any, 'context').mockResolvedValue({
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
  });
  return backend;
}

const callRename = (backend: LocalBackend, repoPath: string, params = {}) =>
  (backend as any).rename(
    { repoPath },
    {
      symbol_name: 'close',
      new_name: 'closeWriter',
      ...params,
    },
  );

describe('semantic rename reports exact applied occurrences (#3486, #2605)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    execFileSyncMock.mockClear();
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
        endLine: 11,
      },
      {
        id: 'Function:src/caller.ts:caller',
        name: 'caller',
        filePath: 'src/caller.ts',
        startLine: 1,
        endLine: 1,
      },
    );
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-3486-backend-'));
    await fs.mkdir(path.join(tmpDir, 'src'));
    await fs.writeFile(path.join(tmpDir, 'src/writer.ts'), SOURCE);
    await fs.writeFile(path.join(tmpDir, 'src/caller.ts'), CALLER);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('previews bound occurrences, including callers absent from graph incoming files', async () => {
    const result = await callRename(stubbedBackend(), tmpDir);
    expect(result, JSON.stringify(result)).toMatchObject({
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
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(tmpDir, 'src/writer.ts'), 'utf8')).toBe(SOURCE);
  });

  it('applies only displayed spans, preserving unrelated same-line keys and symbols', async () => {
    const backend = stubbedBackend();
    const preview = await callRename(backend, tmpDir);
    const result = await callRename(backend, tmpDir, { dry_run: false });
    expect(result, JSON.stringify(result)).toMatchObject({
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
    expect(result, JSON.stringify(result)).toMatchObject({ applied: false, status: 'error' });
    expect(await fs.readFile(path.join(tmpDir, 'src/lib.rs'), 'utf8')).toBe(rust);
  });

  it('rejects malformed dry_run instead of treating it as an apply request', async () => {
    const result = await callRename(stubbedBackend(), tmpDir, { dry_run: 0 });
    expect(result.error).toMatch(/dry_run/);
    expect(result.applied).toBe(false);
    expect(await fs.readFile(path.join(tmpDir, 'src/writer.ts'), 'utf8')).toBe(SOURCE);
  });

  it('reports only the files and occurrences whose writes landed', async () => {
    const originalRename = fsPromises.rename.bind(fsPromises);
    vi.spyOn(fsPromises, 'rename').mockImplementation(async (source, destination) => {
      if (String(destination).endsWith(`${path.sep}writer.ts`)) throw new Error('EACCES');
      return originalRename(source, destination);
    });
    const result = await callRename(stubbedBackend(), tmpDir, { dry_run: false });
    expect(result, JSON.stringify(result)).toMatchObject({
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
