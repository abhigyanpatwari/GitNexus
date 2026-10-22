import { describe, expect, it, vi } from 'vitest';
import { createGraphRAGTools, type GraphRAGBackend } from '../../src/core/llm/tools';

function readTool(content: string) {
  const readFile = vi.fn(async () => content);
  const backend: GraphRAGBackend = {
    executeQuery: async () => [],
    search: async () => [],
    grep: async () => ({ results: [], timedOut: false }),
    readFile,
  };
  const tool = createGraphRAGTools(backend).find((candidate) => candidate.name === 'read');
  if (!tool) throw new Error('Read tool is not registered');
  return { tool, readFile };
}

describe('read tool line ranges', () => {
  it('can reach a definition beyond the full-file character limit', async () => {
    const lines = Array.from({ length: 1600 }, (_, i) => `line ${i + 1} ${'x'.repeat(60)}`);
    lines[1384] = 'def late_handler():';
    const { tool } = readTool(lines.join('\n'));
    const output = await tool.invoke({ filePath: 'main.py', startLine: 1385, endLine: 1387 });
    expect(output).toBe(
      `File: main.py (lines 1385-1387 of 1600)\n\n${lines.slice(1384, 1387).join('\n')}`,
    );
    expect(output).not.toContain('line 1 ');
    expect(output).not.toContain('[truncated');
  });

  it.each([
    [{ startLine: 2 }, 'lines 2-3 of 3', 'two\nthree'],
    [{ endLine: 2 }, 'lines 1-2 of 3', 'one\ntwo'],
    [{ startLine: 3, endLine: 20 }, 'lines 3-3 of 3', 'three'],
    [{ startLine: 2, endLine: 2 }, 'lines 2-2 of 3', 'two'],
  ])('supports partial and inclusive bounds: %j', async (range, header, selected) => {
    const { tool } = readTool('one\ntwo\nthree');
    expect(await tool.invoke({ filePath: 'a.py', ...range })).toBe(
      `File: a.py (${header})\n\n${selected}`,
    );
  });

  it('preserves full-file reading when optional bounds are absent or null', async () => {
    const { tool } = readTool('one\ntwo\nthree');
    const expected = 'File: a.py (3 lines)\n\none\ntwo\nthree';
    expect(await tool.invoke({ filePath: 'a.py' })).toBe(expected);
    expect(await tool.invoke({ filePath: 'a.py', startLine: null, endLine: null })).toBe(expected);
  });

  it.each([{ startLine: 3, endLine: 2 }, { startLine: 4 }])(
    'returns actionable feedback for an empty range: %j',
    async (range) => {
      const { tool } = readTool('one\ntwo\nthree');
      const output = await tool.invoke({ filePath: 'a.py', ...range });
      expect(output).toMatch(/Invalid line range/);
      expect(output).not.toMatch(/^File:/);
    },
  );

  it.each([
    { startLine: 0 },
    { startLine: -1 },
    { startLine: 1.5 },
    { endLine: 0 },
    { endLine: -1 },
    { endLine: 2.5 },
  ])('rejects non-positive or non-integer bounds before reading: %j', async (range) => {
    const { tool, readFile } = readTool('one\ntwo\nthree');
    await expect(tool.invoke({ filePath: 'a.py', ...range })).rejects.toThrow();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('retains the character limit for oversized full-file and ranged reads', async () => {
    const { tool } = readTool('x'.repeat(60_000) + '\nlast');
    for (const range of [{}, { startLine: 1, endLine: 1 }]) {
      const output = await tool.invoke({ filePath: 'large.py', ...range });
      expect(output).toContain('truncated');
      expect(output).toContain('startLine/endLine');
      expect(output.length).toBeLessThan(50_300);
    }
  });

  it('preserves file-read error feedback', async () => {
    const { tool, readFile } = readTool('');
    readFile.mockRejectedValueOnce(new Error('404 Not found'));
    expect(await tool.invoke({ filePath: 'missing.py', startLine: 2 })).toContain(
      'File not found:',
    );
  });
});
