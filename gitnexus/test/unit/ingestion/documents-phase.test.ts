import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import * as walker from '../../../src/core/ingestion/filesystem-walker.js';
import { documentsPhase } from '../../../src/core/ingestion/pipeline-phases/documents.js';
import type { StructureOutput } from '../../../src/core/ingestion/pipeline-phases/structure.js';
import type { PipelineContext } from '../../../src/core/ingestion/pipeline-phases/types.js';
import { generateId } from '../../../src/lib/utils.js';
import { createTempDir } from '../../helpers/test-db.js';

describe('document phase read batching', () => {
  let fixture: Awaited<ReturnType<typeof createTempDir>>;
  let ctx: PipelineContext;

  beforeEach(async () => {
    fixture = await createTempDir();
    ctx = {
      repoPath: fixture.dbPath,
      graph: createKnowledgeGraph(),
      onProgress: () => {},
      pipelineStart: Date.now(),
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fixture.cleanup();
  });

  function structure(paths: string[]) {
    const output: StructureOutput = {
      scannedFiles: paths.map((file) => ({ path: file, size: 128 })),
      allPaths: paths,
      allPathSet: new Set(paths),
      totalFiles: paths.length,
    };
    for (const file of paths.filter((file) => file !== 'excluded.xaml')) {
      ctx.graph.addNode({
        id: generateId('File', file),
        label: 'File',
        properties: { name: file, filePath: file },
      });
    }
    return new Map([['structure', { phaseName: 'structure', output, durationMs: 0 }]]);
  }

  it('reads bounded concurrent batches and preserves exact output across failures', async () => {
    const files = Array.from({ length: 65 }, (_, i) => `View${i}.XAML`);
    for (const [i, file] of files.entries()) {
      await fs.writeFile(
        path.join(fixture.dbPath, file),
        `<Grid xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" x:Name="View${i}" />`,
      );
    }
    await fs.writeFile(path.join(fixture.dbPath, 'broken.xaml'), '<Grid><Button></Grid>');
    const read = vi.spyOn(walker, 'readFileContents');
    const readFile = fs.readFile;
    let activeReads = 0;
    let peakReads = 0;
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      activeReads++;
      peakReads = Math.max(peakReads, activeReads);
      try {
        return await readFile(...args);
      } finally {
        activeReads--;
      }
    });
    const result = await documentsPhase.execute(
      ctx,
      structure([...files, 'broken.xaml', 'missing.xaml', 'excluded.xaml', 'note.txt']),
    );

    expect(read.mock.calls.map(([, paths]) => paths.length)).toEqual([32, 32, 3]);
    expect(read.mock.calls.flatMap(([, paths]) => paths)).toEqual([
      ...files,
      'broken.xaml',
      'missing.xaml',
    ]);
    expect(peakReads).toBeGreaterThan(1);
    expect(peakReads).toBeLessThanOrEqual(walker.READ_CONCURRENCY);
    expect(activeReads).toBe(0);
    expect(result).toEqual({ sections: 65, failures: 1 });
    const sections = [...ctx.graph.iterNodes()].filter((node) => node.label === 'Section');
    expect(sections.map((node) => node.properties.name).sort()).toEqual(
      Array.from({ length: 65 }, (_, i) => `View${i}`).sort(),
    );
    expect([...ctx.graph.iterRelationships()].map((edge) => edge.targetId).sort()).toEqual(
      sections.map((node) => node.id).sort(),
    );
    for (const node of sections) {
      const fileId = generateId('File', node.properties.filePath!);
      expect([...ctx.graph.iterRelationships()]).toContainEqual({
        id: generateId('CONTAINS', `${fileId}->${node.id}`),
        type: 'CONTAINS',
        sourceId: fileId,
        targetId: node.id,
        confidence: 1,
        reason: 'document-declaration',
      });
    }
  });

  it('does not invoke the reader when no eligible document file remains', async () => {
    const read = vi.spyOn(walker, 'readFileContents');
    expect(await documentsPhase.execute(ctx, structure(['note.txt', 'excluded.xaml']))).toEqual({
      sections: 0,
      failures: 0,
    });
    expect(read).not.toHaveBeenCalled();
  });
});
