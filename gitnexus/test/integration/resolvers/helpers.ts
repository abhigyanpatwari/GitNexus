/**
 * Shared test helpers for language resolution integration tests.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'path';
import { afterAll, beforeAll } from 'vitest';
import { runPipelineFromRepo } from '../../../src/core/ingestion/pipeline.js';
import type { PipelineOptions } from '../../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../../src/types/pipeline.js';
import { getRelationships, writeFixtureRepo } from '../../helpers/resolution-graph.js';
import type { ReferenceKind } from 'gitnexus-shared';

export const FIXTURES = path.resolve(__dirname, '..', '..', 'fixtures', 'lang-resolution');
export const CROSS_FILE_FIXTURES = path.resolve(
  __dirname,
  '..',
  '..',
  'fixtures',
  'cross-file-binding',
);

export {
  findDanglingEdges,
  getNodesByLabel,
  getNodesByLabelFull,
  writeFixtureRepo,
  getRelationships,
  type RelEdge,
} from '../../helpers/resolution-graph.js';

/**
 * Materialize `files` in a temp repo, run the pipeline once for the enclosing
 * `describe`, and remove the repo after it. Returns the accessor for the result.
 */
export function useFixture(prefix: string, files: Record<string, string>): () => PipelineResult {
  let root = '';
  let result: PipelineResult | undefined;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), `gitnexus-${prefix}-`));
    writeFixtureRepo(root, files);
    result = await runPipelineFromRepo(root, () => {});
  }, 60000);
  afterAll(() => {
    if (root !== '') fs.rmSync(root, { recursive: true, force: true });
  });
  return () => {
    if (result === undefined) throw new Error('pipeline did not run');
    return result;
  };
}

export function getResolutionOutcomes(result: PipelineResult) {
  return result.resolutionOutcomes ?? [];
}

/** File, 1-based start line, column, member name, and reference kind. */
export type OutcomeSite = readonly [
  filePath: string,
  line: number,
  col: number,
  name: string,
  kind: ReferenceKind,
];

/**
 * Reasons recorded for the requested kind and member at this start position.
 *
 * A call and a read can share both their member name and start position.
 */
export function suppressionReasonsAt(
  result: PipelineResult,
  [filePath, line, col, name, siteKind]: OutcomeSite,
): string[] {
  return getResolutionOutcomes(result)
    .flatMap((outcome) =>
      outcome.kind === 'suppressed' &&
      outcome.filePath === filePath &&
      outcome.range.startLine === line &&
      outcome.range.startCol === col &&
      outcome.name === name &&
      outcome.siteKind === siteKind
        ? [outcome.reason]
        : [],
    )
    .sort();
}

/**
 * True when an `ACCESSES` edge `sourceId -> targetId` was emitted for the site
 * at `line:col`. The name-inference and return-shape passes key each edge id by
 * the site position, which is what ties the edge to one site rather than to any
 * access between the same two nodes.
 */
export function hasAccessesAtSite(
  result: PipelineResult,
  sourceId: string,
  targetId: string,
  line: number,
  col: number,
): boolean {
  const sitePattern = new RegExp(`^:(?:read:|write:)?${line}:${col}(?::\\d+:\\d+)?$`);
  return getRelationships(result, 'ACCESSES').some(
    (edge) =>
      edge.rel.sourceId === sourceId &&
      edge.rel.targetId === targetId &&
      sitePattern.test(edge.rel.id.slice(edge.rel.id.lastIndexOf(targetId) + targetId.length)),
  );
}

/**
 * Every node a single fixture file contributed, as sorted `Label:name` and
 * `Label:qualifiedName` strings — for exact `toEqual` assertions on the whole
 * file's output rather than spot checks.
 */
export function getNodesForFile(
  result: PipelineResult,
  filePathSuffix: string,
): { names: string[]; labelled: string[]; qualified: string[] } {
  const names: string[] = [];
  const labelled: string[] = [];
  const qualified: string[] = [];
  result.graph.forEachNode((n) => {
    if (!String(n.properties.filePath ?? '').endsWith(filePathSuffix)) return;
    const name = n.properties.name;
    names.push(name);
    labelled.push(`${n.label}:${name}`);
    qualified.push(`${n.label}:${String(n.properties.qualifiedName ?? name)}`);
  });
  return { names: names.sort(), labelled: labelled.sort(), qualified: qualified.sort() };
}

export function edgeSet(edges: Array<{ source: string; target: string }>): string[] {
  return edges.map((e) => `${e.source} → ${e.target}`).sort();
}

// Tests can pass { skipGraphPhases: true } as third arg for faster runs
// (skips MRO, community detection, and process extraction).
export { runPipelineFromRepo };
export type { PipelineOptions, PipelineResult };
