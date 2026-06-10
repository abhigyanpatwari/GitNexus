/**
 * Shared fixtures for `mode-a-engine.test.ts`.
 *
 * The engine test file is large (51 cases) and previously
 * inlined these factories per `describe` block. Centralising
 * them here:
 *
 *   - keeps the test bodies free of fixture boilerplate,
 *   - makes the default shape of a `Candidate` / `Location` /
 *     heuristic `GraphRelationship` discoverable in one place,
 *   - makes future test cases (or sibling LSP tests) cheap to
 *     compose.
 *
 * Scope: this module is consumed only by
 * `mode-a-engine.test.ts` (the unit test for
 * `src/core/ingestion/mode-a-reconciler.ts`). The factories
 * are PURE — they do not import the SUT, only its TYPE
 * definitions and the production confidence constant
 * `HEURISTIC_GLOBAL_CONFIDENCE`. The default candidate
 * shape is the one a real ingestion pipeline emits for a
 * `foo()` call in `src/a.ts` — that matches the `confirm`
 * /
correction row of the decision table.
 *
 * Factories:
 *   - `CALLABLE_LABELS`  — the production callable-label
 *     set (KD-3).
 *   - `mkCandidate(over?)`  — a trivial `Candidate`.
 *   - `mkLoc(over?)`  — a minimal `Location` shape.
 *   - `heuristicRel(sourceId, targetId, over?)`  — a
 *     standard `heuristic` `CALLS` edge at
 *     `HEURISTIC_GLOBAL_CONFIDENCE`.
 */

import {
  HEURISTIC_GLOBAL_CONFIDENCE,
  type Candidate,
  type Location,
} from '../../../src/core/ingestion/mode-a-reconciler.js';
import type { GraphRelationship } from '../../../src/core/graph/types.js';

/**
 * The production callable-label set (KD-3) — re-exported
 * directly from call-processor.ts so that every callee-gate
 * test proves the engine uses the same set the production
 * code uses, not an independently hand-copied copy.
 */
export { CALLABLE_SYMBOL_TYPES as CALLABLE_LABELS } from '../../../src/core/ingestion/call-processor.js';

/** A trivial candidate. */
export function mkCandidate(over: Partial<Candidate> = {}): Candidate {
  return {
    sourceId: 'src:1',
    calledName: 'foo',
    oldTargetId: 'Function:src/a.ts:foo',
    file: 'src/a.ts',
    line: 10,
    character: 4,
    ...over,
  };
}

/** A minimal `Location` shape. */
export function mkLoc(over: Partial<Location> = {}): Location {
  return {
    uri: 'file:///workspace/repo/src/b.ts',
    range: { start: { line: 7, character: 2 } },
    ...over,
  };
}

/**
 * A standard heuristic `global`-0.50 edge used by the
 * `confirm` / `correct` / `keep` paths. The id shape mirrors
 * what `generateId('CALLS', 'src->tgt')` produces.
 */
export function heuristicRel(
  sourceId: string,
  targetId: string,
  over: Partial<GraphRelationship> = {},
): GraphRelationship {
  return {
    id: `CALLS:${sourceId}->${targetId}`,
    sourceId,
    targetId,
    type: 'CALLS',
    confidence: HEURISTIC_GLOBAL_CONFIDENCE,
    reason: 'fuzzy-global',
    source: 'heuristic',
    ...over,
  };
}
