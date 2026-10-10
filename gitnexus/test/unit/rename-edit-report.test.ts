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
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-3486-backend-'));
    await fs.mkdir(path.join(tmpDir, 'src'));
    await fs.writeFile(
      path.join(tmpDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' },
        include: ['src/**/*.ts'],
      }),
    );
    await fs.writeFile(path.join(tmpDir, 'src/writer.ts'), SOURCE);
    await fs.writeFile(path.join(tmpDir, 'src/caller.ts'), CALLER);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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
    expect(result).toMatchObject({ status: 'success', applied: true, total_edits: 4 });
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

  it('refuses unsupported languages without changing the target', async () => {
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
    expect(result).toMatchObject({ applied: false, planning_status: 'unsupported' });
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
