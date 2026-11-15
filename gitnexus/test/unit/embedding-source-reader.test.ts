import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EmbeddingSourceReader,
  needsEmbeddingSource,
  type EmbeddingSourceContext,
} from '../../src/core/embeddings/source-reader.js';
import type { EmbeddableNode } from '../../src/core/embeddings/types.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const node = (filePath = 'sample.py', startLine = 1, endLine = 3): EmbeddableNode => ({
  id: `Function:${filePath}:sample`,
  name: 'sample',
  label: 'Function',
  filePath,
  content: 'FTS content',
  startLine,
  endLine,
});
let temp: string;
let root: string;
let source: EmbeddingSourceContext;
beforeEach(async () => {
  temp = await mkdtemp(path.join(tmpdir(), 'gn-embedding-source-'));
  root = path.join(temp, 'repo');
  await mkdir(root);
  source = { repoPath: root, fileHashes: new Map(), contentRetention: 'full' };
});
afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});
async function file(name: string, text: string) {
  await writeFile(path.join(root, name), text);
  (source.fileHashes as Map<string, string>).set(name, digest(text));
}

describe('original embedding source', () => {
  it('releases cached sources even when admission disables caching on a cache hit', async () => {
    const text = 'class Sample { value = 1; }';
    await file('sample.ts', text);
    const reader = new EmbeddingSourceReader(source);
    const indexed = node('sample.ts', 0, 0);
    expect(await reader.read(indexed)).toBe(text);
    expect(await reader.read(indexed, async () => reader.disableCache())).toBe(text);
    await unlink(path.join(root, 'sample.ts'));
    await expect(reader.read(indexed)).rejects.toThrow('Embedding source unavailable');
  });

  it('admits source bytes before reading, including cached files', async () => {
    await file('sample.py', 'source');
    const reader = new EmbeddingSourceReader(source);
    const admit = vi.fn(async (): Promise<void> => {
      throw new Error('budget exhausted');
    });
    await expect(reader.read(node('sample.py', 0, 0), admit)).rejects.toThrow('budget exhausted');
    expect(admit).toHaveBeenCalledWith(6);
    admit.mockImplementation(async () => {});
    expect(await reader.read(node('sample.py', 0, 0), admit)).toBe('source');
    await unlink(path.join(root, 'sample.py'));
    expect(await reader.read(node('sample.py', 0, 0), admit)).toBe('source');
    expect(admit).toHaveBeenCalledTimes(3);
  });

  it('rejects growth after admission instead of reading beyond the reservation', async () => {
    await file('sample.py', 'source');
    const reader = new EmbeddingSourceReader(source);
    await expect(
      reader.read(node('sample.py', 0, 0), async () => {
        await writeFile(path.join(root, 'sample.py'), 'source grew');
      }),
    ).rejects.toThrow('source size changed');
  });

  it('honors the job-specific cache allowance', async () => {
    await file('sample.py', 'source');
    const reader = new EmbeddingSourceReader(source, 8);
    expect(await reader.read(node('sample.py', 0, 0))).toBe('source');
    await unlink(path.join(root, 'sample.py'));
    await expect(reader.read(node('sample.py', 0, 0))).rejects.toThrow(
      'Embedding source unavailable',
    );
  });
  it('retains indentation, Unicode and exact zero-based inclusive CRLF lines', async () => {
    const text = '# prefix\r\ndef sample():\r\n    value = "雪😀"\r\n    return value\r\n# suffix';
    await file('sample.py', text);
    const reader = new EmbeddingSourceReader(source);
    expect(await reader.read(node())).toBe(
      'def sample():\r\n    value = "雪😀"\r\n    return value\r',
    );
    // The verified per-run snapshot serves another symbol without re-reading.
    await unlink(path.join(root, 'sample.py'));
    expect(await reader.read(node('sample.py', 2, 2))).toBe('    value = "雪😀"\r');
  });

  it('recovers source beyond the persisted snippet cap, even with a larger chunk budget', async () => {
    const text = `function sample() {\n${' '.repeat(6000)}return "TAIL";\n}`;
    await file('sample.ts', text);
    const original = {
      ...node('sample.ts', 0, 2),
      content: `${text.slice(0, 5000)} ... [truncated]`,
    };
    expect(needsEmbeddingSource(original, { chunkSize: 10000 })).toBe(true);
    expect(await new EmbeddingSourceReader(source).read(original)).toBe(text);
  });

  it('does not select complete short callables for source reads', () => {
    expect(needsEmbeddingSource(node(), {})).toBe(false);
    expect(needsEmbeddingSource({ ...node(), label: 'Class' }, {})).toBe(true);
  });

  it('reconstructs notebook Python from the indexed JSON line range', async () => {
    const python = [
      'class Sample:\n',
      '    field = 42\n',
      '    def run(self):\n',
      '        return field\n',
    ];
    const text = JSON.stringify(
      {
        cells: [{ cell_type: 'code', source: python }],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      },
      null,
      2,
    );
    await file('sample.ipynb', text);
    const lines = text.split('\n');
    const start = lines.findIndex((line) => line.includes('class Sample:'));
    const end = lines.findIndex((line) => line.includes('return field'));
    expect(await new EmbeddingSourceReader(source).read(node('sample.ipynb', start, end))).toBe(
      python.join('').trimEnd(),
    );
  });

  it('rejects a checkout that differs from the indexed fingerprint', async () => {
    await file('sample.py', 'old\nsource');
    await writeFile(path.join(root, 'sample.py'), 'new\nsource');
    await expect(new EmbeddingSourceReader(source).read(node('sample.py', 0, 1))).rejects.toThrow(
      'differs from the indexed snapshot',
    );
  });

  it('rejects missing fingerprints and invalid or out-of-file ranges', async () => {
    await expect(new EmbeddingSourceReader(source).read(node())).rejects.toThrow(
      'no file fingerprint',
    );
    await file('sample.py', 'x');
    const reader = new EmbeddingSourceReader(source);
    await expect(reader.read(node('sample.py', -1, 0))).rejects.toThrow(
      'invalid indexed source range',
    );
    await expect(reader.read(node('sample.py', 0, 2))).rejects.toThrow('exceeds the indexed file');
  });

  it.each(['symbol', 'none'] as const)(
    'does not read checkout content under %s retention',
    async (retention) => {
      source.contentRetention = retention;
      source.repoPath = path.join(temp, 'missing');
      await expect(new EmbeddingSourceReader(source).read(node())).rejects.toThrow(
        'requires full content retention',
      );
    },
  );

  it('rejects traversal and a symlink to a matching file outside the repository', async () => {
    const text = 'outside';
    await writeFile(path.join(temp, 'outside.py'), text);
    await symlink(path.join(temp, 'outside.py'), path.join(root, 'link.py'));
    source.fileHashes = { '../outside.py': digest(text), 'link.py': digest(text) };
    const reader = new EmbeddingSourceReader(source);
    await expect(reader.read(node('../outside.py', 0, 0))).rejects.toThrow(
      'not repository-relative',
    );
    await expect(reader.read(node('link.py', 0, 0))).rejects.toThrow('leaves the repository');
  });

  it('evicts old files instead of retaining an unbounded repository', async () => {
    const reader = new EmbeddingSourceReader(source);
    for (let i = 0; i < 65; i++) {
      await file(`${i}.py`, String(i));
      expect(await reader.read(node(`${i}.py`, 0, 0))).toBe(String(i));
    }
    await unlink(path.join(root, '0.py'));
    await expect(reader.read(node('0.py', 0, 0))).rejects.toThrow('Embedding source unavailable');
  });

  it('does not retain a file exceeding the byte budget', async () => {
    await file('large.py', 'x'.repeat(9 * 1024 * 1024));
    const reader = new EmbeddingSourceReader(source);
    expect((await reader.read(node('large.py', 0, 0))).length).toBe(9 * 1024 * 1024);
    await unlink(path.join(root, 'large.py'));
    await expect(reader.read(node('large.py', 0, 0))).rejects.toThrow(
      'Embedding source unavailable',
    );
  });
});
