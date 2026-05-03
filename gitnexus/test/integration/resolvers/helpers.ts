/**
 * Shared test helpers for language resolution integration tests.
 */
import path from 'path';
import { it as vitestIt } from 'vitest';
import { runPipelineFromRepo } from '../../../src/core/ingestion/pipeline.js';
import type { PipelineOptions } from '../../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../../src/types/pipeline.js';
import type { GraphRelationship } from 'gitnexus-shared';

const LEGACY_RESOLVER_PARITY_EXPECTED_FAILURES: Readonly<Record<string, ReadonlySet<string>>> = {
  csharp: new Set([
    'emits the using-import edge App/Program.cs -> Models/User.cs through the scope-resolution path',
  ]),
  python: new Set([
    // Suffix-fallback lex tiebreak depends on the registry-primary
    // resolver's deterministic sort. The legacy resolver returns the
    // first match in `Set` iteration order, which is insertion-order
    // dependent and not aligned with this guarantee. Backporting the
    // sort to legacy is out of scope.
    'picks the lexicographically smaller path on equal-depth ties',
    'binds the call to alpha/services/sync.py, not omega',
    'lex tiebreak still picks alpha/services/sync.py with reversed file-write order',
  ]),
};

type ResolverParityEnv = Readonly<Record<string, string | undefined>>;
type VitestIt = typeof vitestIt;
type CallableIt = (name: string, ...args: unknown[]) => unknown;

export function resolverParityFlagName(languageSlug: string): string {
  return `REGISTRY_PRIMARY_${languageSlug.toUpperCase().replace(/-/g, '_')}`;
}

export function isLegacyResolverParityRun(
  languageSlug: string,
  env: ResolverParityEnv = process.env,
): boolean {
  const value = env[resolverParityFlagName(languageSlug)]?.trim().toLowerCase();
  return value === '0' || value === 'false' || value === 'no';
}

export function isLegacyResolverParityExpectedFailure(
  languageSlug: string,
  testName: string,
  env: ResolverParityEnv = process.env,
): boolean {
  if (!isLegacyResolverParityRun(languageSlug, env)) return false;
  return LEGACY_RESOLVER_PARITY_EXPECTED_FAILURES[languageSlug]?.has(testName) ?? false;
}

export function createResolverParityIt(languageSlug: string): VitestIt {
  const wrapped = ((name: string, ...args: unknown[]) => {
    const runner = isLegacyResolverParityExpectedFailure(languageSlug, name)
      ? vitestIt.skip
      : vitestIt;
    return (runner as unknown as CallableIt)(name, ...args);
  }) as VitestIt;

  Object.assign(wrapped, vitestIt);
  return wrapped;
}

export const FIXTURES = path.resolve(__dirname, '..', '..', 'fixtures', 'lang-resolution');
export const CROSS_FILE_FIXTURES = path.resolve(
  __dirname,
  '..',
  '..',
  'fixtures',
  'cross-file-binding',
);

export type RelEdge = {
  source: string;
  target: string;
  sourceLabel: string;
  targetLabel: string;
  sourceFilePath: string;
  targetFilePath: string;
  rel: GraphRelationship;
};

export function getRelationships(result: PipelineResult, type: string): RelEdge[] {
  const edges: RelEdge[] = [];
  for (const rel of result.graph.iterRelationships()) {
    if (rel.type === type) {
      const sourceNode = result.graph.getNode(rel.sourceId);
      const targetNode = result.graph.getNode(rel.targetId);
      edges.push({
        source: sourceNode?.properties.name ?? rel.sourceId,
        target: targetNode?.properties.name ?? rel.targetId,
        sourceLabel: sourceNode?.label ?? 'unknown',
        targetLabel: targetNode?.label ?? 'unknown',
        sourceFilePath: sourceNode?.properties.filePath ?? '',
        targetFilePath: targetNode?.properties.filePath ?? '',
        rel,
      });
    }
  }
  return edges;
}

export function getNodesByLabel(result: PipelineResult, label: string): string[] {
  const names: string[] = [];
  result.graph.forEachNode((n) => {
    if (n.label === label) names.push(n.properties.name);
  });
  return names.sort();
}

export function edgeSet(edges: Array<{ source: string; target: string }>): string[] {
  return edges.map((e) => `${e.source} → ${e.target}`).sort();
}

/** Get graph nodes by label with full properties (for parameterTypes assertions). */
export function getNodesByLabelFull(
  result: PipelineResult,
  label: string,
): Array<{ name: string; properties: Record<string, any> }> {
  const nodes: Array<{ name: string; properties: Record<string, any> }> = [];
  result.graph.forEachNode((n) => {
    if (n.label === label) nodes.push({ name: n.properties.name, properties: n.properties });
  });
  return nodes.sort((a, b) => a.name.localeCompare(b.name));
}

// Tests can pass { skipGraphPhases: true } as third arg for faster runs
// (skips MRO, community detection, and process extraction).
export { runPipelineFromRepo };
export type { PipelineOptions, PipelineResult };
