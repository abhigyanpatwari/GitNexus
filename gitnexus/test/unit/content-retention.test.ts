import { afterEach, describe, expect, it } from 'vitest';
import {
  applyContentRetention,
  contentRetentionFromEnvironment,
  contentRetentionFromMeta,
  contentRetentionMismatch,
  ftsProfileForContentRetention,
} from '../../src/core/content-retention.js';
import { getFtsIndexes } from '../../src/core/search/fts-schema.js';
import { buildTestGraph } from '../helpers/test-graph.js';

const savedRetention = process.env.GITNEXUS_CONTENT_RETENTION;

afterEach(() => {
  if (savedRetention === undefined) delete process.env.GITNEXUS_CONTENT_RETENTION;
  else process.env.GITNEXUS_CONTENT_RETENTION = savedRetention;
});

const contentGraph = () =>
  buildTestGraph([
    {
      id: 'File:src/index.ts',
      label: 'File',
      name: 'index.ts',
      filePath: 'src/index.ts',
      extra: { content: 'const retainedFileText = true;' },
    },
    {
      id: 'Function:src/index.ts:run:1',
      label: 'Function',
      name: 'run',
      filePath: 'src/index.ts',
      startLine: 1,
      endLine: 3,
      extra: {
        content: 'function run() { return retainedSymbolText; }',
        description: 'source comment',
      },
    },
    {
      id: 'BasicBlock:src/index.ts:run:1:0',
      label: 'BasicBlock',
      name: 'block',
      filePath: 'src/index.ts',
      startLine: 1,
      endLine: 1,
      extra: { text: 'return retainedBlockText;', description: 'block annotation' },
    },
  ]);

describe('content retention profiles', () => {
  it('uses full when the environment is absent or blank and rejects explicit invalid values', () => {
    delete process.env.GITNEXUS_CONTENT_RETENTION;
    expect(contentRetentionFromEnvironment()).toBe('full');
    process.env.GITNEXUS_CONTENT_RETENTION = '  ';
    expect(contentRetentionFromEnvironment()).toBe('full');
    process.env.GITNEXUS_CONTENT_RETENTION = 'archive';
    expect(() => contentRetentionFromEnvironment()).toThrow(/GITNEXUS_CONTENT_RETENTION/);
  });

  it('keeps every existing text field in the full profile', () => {
    const graph = contentGraph();
    applyContentRetention(graph, 'full');

    expect(graph.getNode('File:src/index.ts')?.properties.content).toContain('retainedFileText');
    expect(graph.getNode('Function:src/index.ts:run:1')?.properties.content).toContain(
      'retainedSymbolText',
    );
    expect(graph.getNode('BasicBlock:src/index.ts:run:1:0')?.properties.text).toContain(
      'retainedBlockText',
    );
  });

  it('removes file text but preserves symbol spans in the symbol profile', () => {
    const graph = contentGraph();
    applyContentRetention(graph, 'symbol');

    expect(graph.getNode('File:src/index.ts')?.properties.content).toBeUndefined();
    expect(graph.getNode('Function:src/index.ts:run:1')?.properties.content).toContain(
      'retainedSymbolText',
    );
    expect(graph.getNode('Function:src/index.ts:run:1')?.properties.description).toBe(
      'source comment',
    );
  });

  it('removes every source-derived text field in the none profile', () => {
    const graph = contentGraph();
    applyContentRetention(graph, 'none');

    for (const node of graph.nodes) {
      expect(node.properties.content).toBeUndefined();
      expect(node.properties.description).toBeUndefined();
    }
    expect(graph.getNode('BasicBlock:src/index.ts:run:1:0')?.properties.text).toBeUndefined();
  });

  it('treats legacy metadata as full and forces a rebuild for changed retention metadata', () => {
    expect(contentRetentionFromMeta({})).toBe('full');
    expect(contentRetentionMismatch({}, 'full')).toBe(false);
    expect(contentRetentionMismatch({}, 'symbol')).toBe(true);
    expect(
      contentRetentionMismatch(
        {
          contentRetention: 'symbol',
          contentRetentionSchemaVersion: 1,
          ftsProfile: 'symbol-no-file-content',
        },
        'symbol',
      ),
    ).toBe(false);
    expect(
      contentRetentionMismatch(
        {
          contentRetention: 'symbol',
          contentRetentionSchemaVersion: 2,
          ftsProfile: 'symbol-no-file-content',
        },
        'symbol',
      ),
    ).toBe(true);
  });

  it('selects FTS columns that never require discarded text', () => {
    expect(ftsProfileForContentRetention('full')).toBe('full');
    expect(ftsProfileForContentRetention('symbol')).toBe('symbol-no-file-content');
    expect(ftsProfileForContentRetention('none')).toBe('name-only');
    expect(getFtsIndexes('full').find((index) => index.table === 'File')?.properties).toEqual([
      'name',
      'content',
    ]);
    expect(
      getFtsIndexes('symbol-no-file-content').find((index) => index.table === 'File')?.properties,
    ).toEqual(['name']);
    expect(getFtsIndexes('name-only').every((index) => index.properties.length === 1)).toBe(true);
  });
});
