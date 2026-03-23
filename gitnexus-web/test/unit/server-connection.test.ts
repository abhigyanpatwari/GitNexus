import { describe, expect, it } from 'vitest';
import { normalizeServerUrl, extractFileContents } from '../../src/services/server-connection';
import type { GraphNode } from '../../src/core/graph/types';

describe('normalizeServerUrl', () => {
  it('adds http:// to localhost', () => {
    expect(normalizeServerUrl('localhost:4747')).toBe('http://localhost:4747/api');
  });

  it('adds http:// to 127.0.0.1', () => {
    expect(normalizeServerUrl('127.0.0.1:4747')).toBe('http://127.0.0.1:4747/api');
  });

  it('adds https:// to non-local hosts', () => {
    expect(normalizeServerUrl('example.com')).toBe('https://example.com/api');
  });

  it('strips trailing slashes', () => {
    expect(normalizeServerUrl('http://localhost:4747/')).toBe('http://localhost:4747/api');
    expect(normalizeServerUrl('http://localhost:4747///')).toBe('http://localhost:4747/api');
  });

  it('does not double-append /api', () => {
    expect(normalizeServerUrl('http://localhost:4747/api')).toBe('http://localhost:4747/api');
  });

  it('trims whitespace', () => {
    expect(normalizeServerUrl('  localhost:4747  ')).toBe('http://localhost:4747/api');
  });

  it('preserves existing https://', () => {
    expect(normalizeServerUrl('https://gitnexus.example.com')).toBe('https://gitnexus.example.com/api');
  });
});

describe('extractFileContents', () => {
  it('extracts content from File nodes', () => {
    const nodes: GraphNode[] = [
      {
        id: 'File:src/index.ts',
        label: 'File',
        properties: { name: 'index.ts', filePath: 'src/index.ts', content: 'console.log("hello")' } as any,
      },
    ];
    const result = extractFileContents(nodes);
    expect(result['src/index.ts']).toBe('console.log("hello")');
  });

  it('ignores non-File nodes', () => {
    const nodes: GraphNode[] = [
      {
        id: 'Function:main',
        label: 'Function',
        properties: { name: 'main', filePath: 'src/index.ts', content: 'fn body' } as any,
      },
    ];
    const result = extractFileContents(nodes);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('ignores File nodes without content', () => {
    const nodes: GraphNode[] = [
      {
        id: 'File:src/empty.ts',
        label: 'File',
        properties: { name: 'empty.ts', filePath: 'src/empty.ts' },
      },
    ];
    const result = extractFileContents(nodes);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('returns empty object for empty input', () => {
    expect(extractFileContents([])).toEqual({});
  });
});
