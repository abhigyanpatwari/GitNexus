import { describe, expect, it, vi } from 'vitest';
import { createGraphRAGTools, type GraphRAGBackend } from '../../src/core/llm/tools';

const noOpBackend: GraphRAGBackend = {
  executeQuery: async () => [],
  search: async () => [],
  grep: async () => ({ results: [], timedOut: false }),
  readFile: async () => '',
};

/** Ten-line file whose line N reads `line N`. */
const TEN_LINES = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');

function readTool(content: string) {
  const readFile = vi.fn(async () => content);
  const tool = createGraphRAGTools({ ...noOpBackend, readFile }).find(
    (candidate) => candidate.name === 'read',
  )!;
  return { tool, readFile };
}

describe('read tool line ranges (#439)', () => {
  it('reads the whole file when no range is given (unchanged)', async () => {
    const { tool, readFile } = readTool(TEN_LINES);
    const output = await tool.invoke({ filePath: 'src/a.ts' });
    expect(readFile).toHaveBeenCalledWith('src/a.ts');
    expect(output).toBe(`File: src/a.ts (10 lines)\n\n${TEN_LINES}`);
  });

  it('returns only the requested 1-indexed inclusive range', async () => {
    const { tool } = readTool(TEN_LINES);
    const output = await tool.invoke({ filePath: 'src/a.ts', startLine: 3, endLine: 5 });
    expect(output).toBe('File: src/a.ts (lines 3-5 of 10)\n\nline 3\nline 4\nline 5');
  });

  it('reads from startLine to the end when endLine is omitted', async () => {
    const { tool } = readTool(TEN_LINES);
    const output = await tool.invoke({ filePath: 'src/a.ts', startLine: 9 });
    expect(output).toBe('File: src/a.ts (lines 9-10 of 10)\n\nline 9\nline 10');
  });

  it('reads from line 1 when only endLine is given', async () => {
    const { tool } = readTool(TEN_LINES);
    const output = await tool.invoke({ filePath: 'src/a.ts', endLine: 2 });
    expect(output).toBe('File: src/a.ts (lines 1-2 of 10)\n\nline 1\nline 2');
  });

  it('treats null range values like omitted ones', async () => {
    const { tool } = readTool(TEN_LINES);
    const output = await tool.invoke({ filePath: 'src/a.ts', startLine: null, endLine: null });
    expect(output).toBe(`File: src/a.ts (10 lines)\n\n${TEN_LINES}`);
  });

  it('clamps an endLine past the end of the file', async () => {
    const { tool } = readTool(TEN_LINES);
    const output = await tool.invoke({ filePath: 'src/a.ts', startLine: 10, endLine: 500 });
    expect(output).toBe('File: src/a.ts (lines 10-10 of 10)\n\nline 10');
  });

  it('explains a startLine past the end of the file instead of returning empty content', async () => {
    const { tool } = readTool(TEN_LINES);
    const output = await tool.invoke({ filePath: 'src/a.ts', startLine: 11 });
    expect(output).toBe('File: src/a.ts has 10 lines; startLine 11 is past the end of the file.');
  });

  it('rejects an endLine before startLine', async () => {
    const { tool } = readTool(TEN_LINES);
    const output = await tool.invoke({ filePath: 'src/a.ts', startLine: 5, endLine: 3 });
    expect(output).toContain('Invalid line range');
    expect(output).toContain('endLine (3) is before startLine (5)');
  });

  it('rejects a startLine below 1', async () => {
    const { tool } = readTool(TEN_LINES);
    const output = await tool.invoke({ filePath: 'src/a.ts', startLine: 0, endLine: 3 });
    expect(output).toContain('Invalid line range');
  });

  it('reaches lines beyond the whole-file truncation point', async () => {
    // ~70k characters: a plain read truncates at 50k, a range must still reach the tail.
    const big = Array.from({ length: 7000 }, (_, i) => `line ${i + 1} `.padEnd(10, '.')).join('\n');
    const { tool } = readTool(big);

    const whole = await tool.invoke({ filePath: 'big.ts' });
    expect(whole).toContain('truncated');
    expect(whole).toContain('pass startLine/endLine');
    expect(whole).not.toContain('line 7000');

    const tail = await tool.invoke({ filePath: 'big.ts', startLine: 6999, endLine: 7000 });
    expect(tail).toMatch(/^File: big\.ts \(lines 6999-7000 of 7000\)/);
    expect(tail).toContain('line 7000');
  });
});
