import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EvidenceCollector,
  EVIDENCE_COLLECTOR_VERSION,
  type EvidenceGraphReader,
} from '../../src/core/wiki/document/evidence-collector.js';
import { createEvidenceId, createEvidenceRef } from '../../src/core/wiki/document/evidence.js';

describe('wiki EvidenceCollector', () => {
  let repoPath: string;
  let graph: EvidenceGraphReader;

  beforeEach(async () => {
    repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-evidence-'));
    await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
    await fs.mkdir(path.join(repoPath, 'test'), { recursive: true });
    await fs.mkdir(path.join(repoPath, 'docs'), { recursive: true });
    await fs.writeFile(path.join(repoPath, 'src', 'core.ts'), 'export function run() {}\n');
    await fs.writeFile(path.join(repoPath, 'package.json'), '{"name":"fixture"}\n');
    await fs.writeFile(path.join(repoPath, 'test', 'core.test.ts'), 'test("run", () => {})\n');
    await fs.writeFile(path.join(repoPath, 'docs', 'architecture.md'), '# Architecture\n');

    graph = {
      getAllFiles: vi
        .fn()
        .mockResolvedValue([
          'src/core.ts',
          'package.json',
          'test/core.test.ts',
          'docs/architecture.md',
        ]),
      getFilesWithExports: vi
        .fn()
        .mockResolvedValue([
          { filePath: 'src/core.ts', symbols: [{ name: 'run', type: 'Function' }] },
        ]),
      getIntraModuleCallEdges: vi.fn().mockResolvedValue([
        {
          fromFile: 'src/core.ts',
          fromName: 'run',
          toFile: 'src/core.ts',
          toName: 'helper',
        },
      ]),
      getInterModuleCallEdges: vi.fn().mockResolvedValue({
        incoming: [],
        outgoing: [
          {
            fromFile: 'src/core.ts',
            fromName: 'run',
            toFile: 'src/io.ts',
            toName: 'write',
          },
        ],
      }),
      getProcessesForFiles: vi.fn().mockResolvedValue([
        {
          id: 'process-core',
          label: 'Core flow',
          type: 'intra_community',
          stepCount: 1,
          steps: [{ step: 1, name: 'run', filePath: 'src/core.ts', type: 'Function' }],
        },
      ]),
      getAllProcesses: vi.fn().mockResolvedValue([
        {
          id: 'process-repository',
          label: 'Repository flow',
          type: 'cross_community',
          stepCount: 1,
          steps: [{ step: 1, name: 'run', filePath: 'src/core.ts', type: 'Function' }],
        },
      ]),
    };
  });

  afterEach(async () => {
    await fs.rm(repoPath, { recursive: true, force: true });
  });

  it('collects source, config, test, existing-doc, symbol, call, and process evidence', async () => {
    const collector = new EvidenceCollector(repoPath, graph, { maxExcerptChars: 100 });
    const bundle = await collector.collect({
      sourceCommit: 'abc123',
      moduleFiles: { Core: ['src/core.ts'] },
      limitations: ['graph process discovery is lower-bound'],
    });

    expect(EVIDENCE_COLLECTOR_VERSION).toBe(1);
    expect(bundle).toMatchObject({
      schemaVersion: 1,
      repoPath,
      sourceCommit: 'abc123',
      conflicts: [],
      limitations: ['graph process discovery is lower-bound'],
    });
    expect(new Set(bundle.repository.map((item) => item.kind))).toEqual(
      new Set(['file', 'config', 'test', 'existing-doc', 'symbol', 'process']),
    );
    expect(new Set(bundle.modules.Core.map((item) => item.kind))).toEqual(
      new Set(['file', 'symbol', 'relation', 'process']),
    );
    expect(bundle.repository.find((item) => item.kind === 'file')?.excerpt).toContain(
      'export function run',
    );
    expect(graph.getIntraModuleCallEdges).toHaveBeenCalledWith(['src/core.ts']);
    expect(graph.getProcessesForFiles).toHaveBeenCalledWith(['src/core.ts'], 20);
  });

  it('assigns stable ids, deduplicates repeated graph facts, and applies item budgets', async () => {
    (graph.getAllProcesses as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'same-process',
        label: 'Same process',
        type: 'flow',
        stepCount: 0,
        steps: [],
      },
      {
        id: 'same-process',
        label: 'Same process',
        type: 'flow',
        stepCount: 0,
        steps: [],
      },
    ]);
    const collector = new EvidenceCollector(repoPath, graph, {
      maxRepositoryItems: 3,
      maxModuleItems: 2,
    });
    const input = { sourceCommit: 'abc123', moduleFiles: { Core: ['src/core.ts'] } };

    const first = await collector.collect(input);
    const second = await collector.collect(input);

    expect(first.repository).toHaveLength(3);
    expect(first.modules.Core).toHaveLength(2);
    expect(first.repository.map((item) => item.id)).toEqual(
      second.repository.map((item) => item.id),
    );
    expect(new Set(first.repository.map((item) => item.id)).size).toBe(first.repository.length);
  });

  it('does not read graph paths that escape the repository', async () => {
    (graph.getAllFiles as ReturnType<typeof vi.fn>).mockResolvedValue(['../secret.txt']);
    const collector = new EvidenceCollector(repoPath, graph);

    const bundle = await collector.collect({ sourceCommit: 'abc123', moduleFiles: {} });

    const escaped = bundle.repository.find((item) => item.filePath === '../secret.txt');
    expect(escaped).toMatchObject({
      kind: 'file',
      status: 'missing',
      filePath: '../secret.txt',
    });
    expect(escaped?.excerpt).toBeUndefined();
  });

  it('derives ids only from deterministic source identity fields', () => {
    const identity = {
      kind: 'line' as const,
      filePath: 'src/core.ts',
      symbol: 'run',
      lineStart: 10,
      lineEnd: 12,
    };
    expect(createEvidenceId(identity)).toBe(createEvidenceId({ ...identity }));
    expect(createEvidenceId(identity)).not.toBe(createEvidenceId({ ...identity, lineEnd: 13 }));
    expect(
      createEvidenceRef({ ...identity, status: 'verified', summary: 'First summary' }).id,
    ).toBe(createEvidenceRef({ ...identity, status: 'inferred', summary: 'Changed summary' }).id);
  });
});
