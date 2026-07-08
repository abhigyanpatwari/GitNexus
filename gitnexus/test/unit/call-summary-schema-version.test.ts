/**
 * PDG FU-C (U-C1 / U-C5) — CALL_SUMMARY relation-type posture + the v3→4
 * incremental reuse gate.
 *
 * CALL_SUMMARY is an INTERNAL PDG-engine edge: like the taint substrate edges
 * (TAINTED / TAINT_PATH / CDG / REACHING_DEF / CFG) it must stay OUT of
 * `VALID_RELATION_TYPES` so it never enters impact-style symbol-space traversal,
 * and the impact relType allowlists (local-backend.ts ~:4373 / ~:5674) that gate
 * on `VALID_RELATION_TYPES` therefore never surface it. The v4 bump forces a
 * full re-analyze on a pre-v4 index (which has no CALL_SUMMARY edges, so an
 * incremental top-up would silently under-report return-value ascent).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  VALID_RELATION_TYPES,
  EPISTEMIC_HERITAGE_RELATION_TYPES,
  EPISTEMIC_CONSUMER_RELATION_TYPES,
} from '../../src/mcp/local/local-backend.js';
import { INCREMENTAL_SCHEMA_VERSION } from '../../src/storage/repo-manager.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

describe('CALL_SUMMARY relation-type exclusion (U-C1)', () => {
  it('is NOT in VALID_RELATION_TYPES (never enters impact symbol-space traversal)', () => {
    expect(VALID_RELATION_TYPES.has('CALL_SUMMARY')).toBe(false);
  });

  it('shares the internal-PDG-edge exclusion posture with the taint substrate edges', () => {
    // The whole PDG/taint substrate stays out of the impact allowlist.
    expect(VALID_RELATION_TYPES.has('TAINT_PATH')).toBe(false);
    expect(VALID_RELATION_TYPES.has('TAINTED')).toBe(false);
    expect(VALID_RELATION_TYPES.has('REACHING_DEF')).toBe(false);
    expect(VALID_RELATION_TYPES.has('CFG')).toBe(false);
    expect(VALID_RELATION_TYPES.has('CDG')).toBe(false);
    // Sanity floor: the public callgraph edges ARE in the allowlist.
    expect(VALID_RELATION_TYPES.has('CALLS')).toBe(true);
  });

  it('is absent from the epistemic-boundary relation sets', () => {
    expect(EPISTEMIC_HERITAGE_RELATION_TYPES).not.toContain('CALL_SUMMARY');
    expect(EPISTEMIC_CONSUMER_RELATION_TYPES).not.toContain('CALL_SUMMARY');
  });

  it('is absent from the impact relType default allowlists in local-backend (the ~:4373/~:5674 filters)', () => {
    // The two impact relType filters first intersect with VALID_RELATION_TYPES
    // (above) and otherwise fall back to a hardcoded public-edge default list.
    // Assert CALL_SUMMARY appears in NEITHER default list's source text, so it
    // can never be the relType an impact traversal walks.
    const src = readFileSync(
      path.join(repoRoot, 'src', 'mcp', 'local', 'local-backend.ts'),
      'utf8',
    );
    // Every default relType array literal in the impact filters.
    const defaultLists = src.match(/\[\s*\n\s*'CALLS',[\s\S]*?\]/g) ?? [];
    expect(defaultLists.length).toBeGreaterThan(0);
    for (const list of defaultLists) {
      expect(list).not.toContain('CALL_SUMMARY');
    }
  });

  it('the /api/graph relationship projection does not special-case (allow OR block) CALL_SUMMARY', () => {
    // The /api/graph relationship query (api.ts GRAPH_RELATIONSHIP_QUERY) is an
    // unfiltered MATCH used for visualization, not an impact surface — it must
    // not name CALL_SUMMARY in either direction (no bespoke allow/deny clause).
    const api = readFileSync(path.join(repoRoot, 'src', 'server', 'api.ts'), 'utf8');
    expect(api).not.toContain('CALL_SUMMARY');
  });
});

describe('CALL_SUMMARY incremental reuse gate (U-C5)', () => {
  it('INCREMENTAL_SCHEMA_VERSION is bumped to 6 (uniform 0-based line storage re-index window)', () => {
    expect(INCREMENTAL_SCHEMA_VERSION).toBe(6);
  });

  it('a pre-current stamp fails the `=== INCREMENTAL_SCHEMA_VERSION` reuse gate → forces full re-analyze', () => {
    // The reuse gate at run-analyze.ts:920 is exactly this strict equality on
    // the persisted `existingMeta.schemaVersion` (a plain number, possibly
    // absent on a legacy stamp). Replicate it as a typed predicate.
    const passesReuseGate = (stampedSchemaVersion: number | undefined): boolean =>
      stampedSchemaVersion === INCREMENTAL_SCHEMA_VERSION;
    // A pre-v4 (v3) index has no CALL_SUMMARY edges → must NOT reuse.
    expect(passesReuseGate(3)).toBe(false);
    // A pre-v5 (v4) index predates the multi-verb Route identity change → its
    // persisted Route nodes use the old url-only ids, so an incremental top-up
    // would strand them → must NOT reuse.
    expect(passesReuseGate(4)).toBe(false);
    // A legacy stamp with no schemaVersion at all is likewise rejected.
    expect(passesReuseGate(undefined)).toBe(false);
    // A pre-v6 (v5) index predates the uniform 0-based line-storage flip → its
    // COBOL/JCL/markdown/scope rows are still 1-based, so an incremental top-up
    // would mix bases → must NOT reuse.
    expect(passesReuseGate(5)).toBe(false);
    // A current-version stamp passes the gate (incremental top-up eligible).
    expect(passesReuseGate(6)).toBe(true);
  });
});
