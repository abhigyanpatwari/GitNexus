/**
 * PDG FU-C (U-C1) — CALL_SUMMARY relation-type posture — plus the index-reuse
 * gates that decide whether an existing index may be topped up incrementally
 * (U-C5, #2798).
 *
 * CALL_SUMMARY is an INTERNAL PDG-engine edge: like the taint substrate edges
 * (TAINTED / TAINT_PATH / CDG / REACHING_DEF / CFG) it must stay OUT of
 * `VALID_RELATION_TYPES` so it never enters impact-style symbol-space traversal,
 * and the impact relType allowlists (local-backend.ts ~:4373 / ~:5674) that gate
 * on `VALID_RELATION_TYPES` therefore never surface it.
 *
 * The reuse gates below are split by what each one can SEE, and that split is
 * the point of this file:
 *
 *   • `SCHEMA_FINGERPRINT` (lbug/schema.ts) is a digest of the node + relation
 *     DDL. It fires exactly when a table shape changes — and is structurally
 *     blind to everything else.
 *   • the analyzer runner-identity receipt (analyzer-identity.ts) hashes the
 *     analyzer BUILD, so it — and only it — covers SEMANTIC changes that touch
 *     no DDL: node-id formats, wire formats, resolution tiers, emit ordering.
 *
 * That second gate became load-bearing in #2798. The hand-incremented
 * `INCREMENTAL_SCHEMA_VERSION` it replaced was bumped ~35 times, and roughly 30
 * of those bumps changed NO DDL — they were semantic. A DDL digest cannot fire
 * on any of them. The runner-identity receipt is their only remaining cover, so
 * this file names that split instead of leaving it implicit: it owns the
 * DDL-blind half (the fingerprint below) plus a source anchor proving
 * run-analyze.ts still consults the receipt. The receipt predicate's own
 * behaviour is asserted against the real function in analyzer-identity.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  VALID_RELATION_TYPES,
  EPISTEMIC_HERITAGE_RELATION_TYPES,
  EPISTEMIC_CONSUMER_RELATION_TYPES,
} from '../../src/mcp/local/local-backend.js';
import {
  schemaFingerprintMismatch,
  NODE_SCHEMA_QUERIES,
  REL_SCHEMA_QUERIES,
  SCHEMA_FINGERPRINT,
} from '../../src/core/lbug/schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const runAnalyzeSource = readFileSync(path.join(repoRoot, 'src', 'core', 'run-analyze.ts'), 'utf8');

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

describe('incremental reuse gate — schema fingerprint (U-C5, #2798)', () => {
  // Calls the real predicate the production gates call. Before #2798 this file
  // pinned `expect(INCREMENTAL_SCHEMA_VERSION).toBe(35)`, a literal that failed
  // CI on every bump by design; a digest has no literal to pin, so what is
  // pinned instead is the decision the digest drives.
  it.each([
    { stamped: SCHEMA_FINGERPRINT, mismatch: false, why: "this build's own DDL" },
    { stamped: 'a0b1c2d3e4f5', mismatch: true, why: 'a well-formed digest from another build' },
    { stamped: undefined, mismatch: true, why: 'an index predating the field' },
    { stamped: '', mismatch: true, why: 'an empty stamp' },
  ])('treats $why as mismatch=$mismatch', ({ stamped, mismatch }) => {
    expect(schemaFingerprintMismatch(stamped)).toBe(mismatch);
  });

  it('is a digest of the node+relation DDL and of nothing else', () => {
    // Pins the INPUT SET, not the algorithm: the fingerprint is a pure function
    // of the DDL, which is why it cannot fire on a semantic change (see the
    // runner-identity describe below) and why EMBEDDING_SCHEMA — whose FLOAT[N]
    // width comes from GITNEXUS_EMBEDDING_DIMS at module load — must stay out,
    // or the same build under different env would disagree with itself.
    // schema-fingerprint.test.ts owns the digest's other properties.
    expect(SCHEMA_FINGERPRINT).toBe(
      createHash('sha256')
        .update([...NODE_SCHEMA_QUERIES, ...REL_SCHEMA_QUERIES].join('\n'))
        .digest('hex')
        .slice(0, 12),
    );
  });
});

describe('semantic and id-shape changes ride the runner-identity receipt (#2798/#3041)', () => {
  it('run-analyze.ts still forces a full rebuild when the stamped runner identity differs', () => {
    // The invariant the INCREMENTAL_SCHEMA_VERSION ladder used to backstop. It
    // is implicit nowhere else: no other gate observes analyzer code that emits
    // no DDL. Deleting this block silently re-opens same-commit top-ups across
    // an analyzer that changed how the graph is shaped.
    //
    // Source-anchored on purpose: the wiring has no extracted predicate to call,
    // so the only way to assert the gate still exists is to read run-analyze.ts.
    // The predicate's OWN behaviour — a moved build digest with unmoved DDL, an
    // absent/null/legacy/malformed receipt, an alternate diagnostic entrypoint —
    // is asserted against the real function in analyzer-identity.test.ts.
    expect(runAnalyzeSource).toMatch(
      /!analyzerRunnerIdentitiesEqual\(\s*existingMeta\.runnerIdentity,\s*runnerIdentity,?\s*\)[\s\S]{0,900}?options = \{ \.\.\.options, force: true \};/,
    );
  });
});
