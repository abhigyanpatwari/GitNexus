/**
 * The parse-chunk merge through the real pipeline and the real worker, without
 * a parse cache: the graph must not depend on the worker count.
 *
 * With one worker a chunk is one job, and a job parses its `.ts` files before
 * its `.tsx` files, so the chunk reaches the merge out of path order. With one
 * file per job it arrives in path order. Two files that declare the same route
 * are the tie: the file first in path order owns it in both runs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after as afterAll, before as beforeAll, describe, it } from 'node:test';
import { expect } from 'expect';

import { runPipelineFromRepo } from '../../../../src/core/ingestion/pipeline.js';
import { parseCacheBucketId } from '../../../../src/storage/parse-cache.js';

const TSX_FILE = 'src/a0.tsx';

/** A `.ts` path that sorts after {@link TSX_FILE} and shares its parse chunk. */
function tsFileInTheSameChunk(): string {
  const bucket = parseCacheBucketId(TSX_FILE);
  const candidates = Array.from({ length: 4096 }, (_, index) => `src/b${index}.ts`);
  const match = candidates.find((candidate) => parseCacheBucketId(candidate) === bucket);
  if (match === undefined) throw new Error(`No .ts path shares a chunk with ${TSX_FILE}`);
  return match;
}

const TS_FILE = tsFileInTheSameChunk();

const routeFile = (handler: string, tail: string): string =>
  [
    "import express from 'express';",
    '',
    'const app = express();',
    '',
    `export function ${handler}(req: unknown, res: { json(value: unknown): void }): void {`,
    '  res.json({ ok: true });',
    '}',
    '',
    `app.get('/shared', ${handler});`,
    tail,
    '',
  ].join('\n');

interface GraphDump {
  routeOwners: string[];
  nodes: string[];
  relationships: string[];
}

async function analyze(repoDir: string, workerPoolSize: number): Promise<GraphDump> {
  const result = await runPipelineFromRepo(repoDir, () => {}, {
    workerPoolSize,
    skipGraphPhases: true,
  });
  const nodes = [...result.graph.iterNodes()];
  return {
    routeOwners: nodes
      .filter((node) => node.label === 'Route')
      .map((node) => `${String(node.properties.name)} @ ${String(node.properties.filePath)}`),
    nodes: nodes.map((node) => `${node.label} ${node.id} @ ${String(node.properties.filePath)}`),
    relationships: [...result.graph.iterRelationships()].map(
      (relationship) =>
        `${relationship.type} ${relationship.sourceId} -> ${relationship.targetId} (${relationship.reason})`,
    ),
  };
}

describe('parse-chunk merge order through the pipeline', () => {
  let repoDir: string;
  let oneJobPerChunk: GraphDump;
  let oneFilePerJob: GraphDump;

  beforeAll(
    async () => {
      repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-merge-order-'));
      fs.mkdirSync(path.join(repoDir, 'src'));
      fs.writeFileSync(
        path.join(repoDir, TSX_FILE),
        routeFile('handleSharedInTsx', 'export const View = () => <div />;'),
      );
      fs.writeFileSync(
        path.join(repoDir, TS_FILE),
        routeFile('handleSharedInTs', 'export const loaded = true;'),
      );
      oneJobPerChunk = await analyze(repoDir, 1);
      oneFilePerJob = await analyze(repoDir, 2);
    },
    { timeout: 120_000 },
  );

  afterAll(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('gives a route two files declare to the file first in path order at one worker', () => {
    expect(oneJobPerChunk.routeOwners).toEqual([`/shared @ ${TSX_FILE}`]);
  });

  it('gives the same route the same owner with one file per job', () => {
    expect(oneFilePerJob.routeOwners).toEqual([`/shared @ ${TSX_FILE}`]);
  });

  it('inserts the same nodes in the same order at either worker count', () => {
    expect(oneJobPerChunk.nodes).toEqual(oneFilePerJob.nodes);
  });

  it('inserts the same relationships in the same order at either worker count', () => {
    expect(oneJobPerChunk.relationships).toEqual(oneFilePerJob.relationships);
  });
});
