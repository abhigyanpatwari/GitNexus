/**
 * End-to-end Laravel route → controller-method CALLS-edge resolution.
 *
 * This is the authoritative format gate for the RING4-2 follow-up (PR #2033
 * tri-review, Codex F1 + ce-adversarial): the route extractor normalizes the
 * routes-file `use`/`::class` FQN with `normalizeQualifiedName`, and the emitter
 * resolves it via `lookupClassByQualifiedName` against the dot-joined key the
 * structure phase's `buildQualifiedName` actually stores. The unit tests use a
 * hand-built model and cannot catch a dot-vs-backslash format mismatch; only
 * this real-parse test can — if the FQN normalization is wrong, the admin route
 * edge below is silently dropped (qualified lookup misses → short-name fallback
 * sees two `OrderController`s → skip).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';

describe('Laravel route → controller qualified resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    // Force the worker path — Laravel route extraction runs in the worker
    // (the sequential fallback does not extract routes), so a small fixture
    // must lower the worker thresholds to exercise route resolution.
    result = await runPipelineFromRepo(path.join(FIXTURES, 'laravel-route-resolution'), () => {}, {
      workerThresholdsForTest: { minFiles: 1, minBytes: 1 },
    });
  }, 60000);

  const routeCalls = () =>
    getRelationships(result, 'CALLS').filter((e) => e.rel.reason === 'laravel-route');

  it('resolves a globally-duplicated short name to the use-imported (public) controller', () => {
    const edges = routeCalls().filter(
      (e) =>
        e.target === 'index' &&
        e.targetFilePath.endsWith('app/Http/Controllers/OrderController.php'),
    );
    expect(edges.length).toBeGreaterThanOrEqual(1);
  });

  it('resolves an aliased same-short-name controller to the admin controller (disambiguation gate)', () => {
    // The make-or-break assertion: if normalizeQualifiedName(FQN) did not match
    // the registry key, this edge would not exist (skip on ambiguity).
    const edges = routeCalls().filter(
      (e) => e.target === 'index' && e.targetFilePath.endsWith('app/Admin/OrderController.php'),
    );
    expect(edges.length).toBeGreaterThanOrEqual(1);
  });

  it('resolves an aliased uniquely-named controller (PhotoController) to its list method', () => {
    const edges = routeCalls().filter(
      (e) =>
        e.target === 'list' &&
        e.targetFilePath.endsWith('app/Http/Controllers/PhotoController.php'),
    );
    expect(edges.length).toBeGreaterThanOrEqual(1);
  });

  it('never targets the wrong same-short-name controller', () => {
    // Each OrderController route resolves to exactly one of the two files — the
    // admin route must not target the public controller's method, nor vice versa.
    // (Asserted implicitly by the two file-scoped assertions above both holding;
    // here we confirm both distinct targets are present, proving the route map
    // disambiguated rather than collapsing to one.)
    const orderTargets = new Set(
      routeCalls()
        .filter((e) => e.target === 'index')
        .map((e) => e.targetFilePath.replace(/^.*\/(app\/.*)$/, '$1')),
    );
    expect(orderTargets.has('app/Http/Controllers/OrderController.php')).toBe(true);
    expect(orderTargets.has('app/Admin/OrderController.php')).toBe(true);
  });
});
