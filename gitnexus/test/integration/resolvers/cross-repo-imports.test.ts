/**
 * Issue #50: cross-repo IMPORTS edges / external File nodes.
 *
 * When a CrossRepoRegistry is provided to the pipeline, an import that resolves
 * to no LOCAL file but whose package maps to an indexed dependency repo creates
 * a phantom external File node (isExternal:true) + a CROSS_IMPORTS edge. WITHOUT
 * a registry, ingestion is byte-identical to today (zero external nodes/edges).
 *
 * The registry is duck-typed here (only findDepRepo is used by the cross-repo
 * branch) so the test exercises the real pipeline wiring without manifests/IO.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import type { CrossRepoRegistry } from '../../../src/core/ingestion/cross-repo-registry.js';
import {
  FIXTURES, getRelationships, getNodesByLabelFull, runPipelineFromRepo, type PipelineResult,
} from './helpers.js';

const CONSUMER = path.join(FIXTURES, 'cross-repo-consumer');

/** A registry that resolves any `com.acme.*` package to the indexed dep repo. */
const acmeRegistry = {
  findDepRepo: (prefix: string): string | null =>
    prefix.includes('acme') ? 'acme-lib' : null,
} as unknown as CrossRepoRegistry;

/** A registry that resolves nothing (negative case). */
const emptyRegistry = {
  findDepRepo: (): string | null => null,
} as unknown as CrossRepoRegistry;

describe('cross-repo import edges (#50)', () => {
  describe('with a registry that maps the dependency', () => {
    let result: PipelineResult;
    beforeAll(async () => {
      result = await runPipelineFromRepo(CONSUMER, () => {}, { crossRepoRegistry: acmeRegistry });
    }, 60000);

    it('creates an external File node for the dependency import', () => {
      const external = getNodesByLabelFull(result, 'File').filter(n => n.properties.isExternal === true);
      expect(external.length).toBe(1);
      expect(external[0].properties.name).toBe('com.acme.lib.Foo');
      expect(external[0].properties.repoId).toBe('acme-lib');
    });

    it('creates a CROSS_IMPORTS edge from the consumer file to the external node', () => {
      const edges = getRelationships(result, 'CROSS_IMPORTS');
      expect(edges.length).toBe(1);
      expect(edges[0].targetLabel).toBe('File');
      expect(edges[0].target).toBe('com.acme.lib.Foo');
    });
  });

  describe('regression guard — NO registry → byte-identical (no external nodes)', () => {
    let result: PipelineResult;
    beforeAll(async () => {
      result = await runPipelineFromRepo(CONSUMER, () => {});
    }, 60000);

    it('creates zero external File nodes', () => {
      const external = getNodesByLabelFull(result, 'File').filter(n => n.properties.isExternal === true);
      expect(external.length).toBe(0);
    });

    it('creates zero CROSS_IMPORTS edges', () => {
      expect(getRelationships(result, 'CROSS_IMPORTS').length).toBe(0);
    });
  });

  describe('negative — registry present but dependency not declared', () => {
    let result: PipelineResult;
    beforeAll(async () => {
      result = await runPipelineFromRepo(CONSUMER, () => {}, { crossRepoRegistry: emptyRegistry });
    }, 60000);

    it('does not fire (no external nodes/edges)', () => {
      const external = getNodesByLabelFull(result, 'File').filter(n => n.properties.isExternal === true);
      expect(external.length).toBe(0);
      expect(getRelationships(result, 'CROSS_IMPORTS').length).toBe(0);
    });
  });
});
