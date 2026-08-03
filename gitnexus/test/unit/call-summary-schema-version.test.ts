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
 * this file names that invariant instead of leaving it implicit.
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

/**
 * SEAM NOTE — read before "improving" the source-text assertions below.
 *
 * run-analyze.ts exports no reuse-gate predicate: both fingerprint gates are
 * inline expressions inside `runFullAnalysis` (a ~2300-line function), so there
 * is nothing importable to call. A local `const passesReuseGate = (f) => f ===
 * SCHEMA_FINGERPRINT` would assert that `===` behaves like `===` and would keep
 * passing after the production gate was deleted — that is not a test.
 *
 * The behavioural coverage therefore lives in
 * test/unit/incremental-orchestration.test.ts, which drives real `runFullAnalysis`
 * runs over a fixture repo for the differing-fingerprint and absent-fingerprint
 * cases. It is not duplicated here.
 *
 * What is left for this file is the forcing function that the deleted
 * `expect(INCREMENTAL_SCHEMA_VERSION).toBe(35)` literal pin used to provide:
 * something that fails loudly if a gate is removed. These assertions are
 * source-anchored (the same technique the CALL_SUMMARY block above already uses
 * for local-backend.ts / api.ts). They prove the gate EXISTS and compares
 * against the real production values — not that it behaves correctly. Deleting
 * either gate from run-analyze.ts fails this file.
 *
 * The clean fix, if run-analyze.ts is ever in scope: export a
 * `schemaFingerprintMismatch(existingMeta)` predicate next to the existing
 * `pdgModeMismatch` / `cjkSegmentationModeMismatch` exports and call it here.
 */
const REUSE_GATE_SITES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  {
    name: 'imports the DDL digest itself (the gates compare against schema.ts, not a local copy)',
    pattern: /import \{ SCHEMA_FINGERPRINT \} from '\.\/lbug\/schema\.js';/,
  },
  {
    name: 'pre-fast-path force gate: a differing OR absent stamp forces a full re-analyze',
    pattern:
      /if \(existingMeta && existingMeta\.schemaFingerprint !== SCHEMA_FINGERPRINT\) \{[\s\S]{0,800}?options = \{ \.\.\.options, force: true \};/,
  },
  {
    name: "isIncremental eligibility conjunct: a top-up requires this build's DDL",
    pattern:
      /const isIncremental =[\s\S]{0,600}?existingMeta\.schemaFingerprint === SCHEMA_FINGERPRINT &&/,
  },
];

describe('incremental reuse gate — schema fingerprint (U-C5, #2798)', () => {
  it.each(REUSE_GATE_SITES)('run-analyze.ts still $name', ({ pattern }) => {
    expect(runAnalyzeSource).toMatch(pattern);
  });

  it('the fingerprint is a digest of the node+relation DDL and of nothing else', () => {
    // Pins the INPUT SET, not the algorithm: the fingerprint is a pure function
    // of the DDL, which is precisely why it cannot fire on a semantic change
    // (see the runner-identity describe below) and why EMBEDDING_SCHEMA — whose
    // FLOAT[N] width comes from GITNEXUS_EMBEDDING_DIMS at module load — must
    // stay out of it, or the same build under different env would disagree with
    // itself and force alternating full rebuilds.
    //
    // Folding any new input into the digest fails here BY DESIGN: that is the
    // moment to confirm the input is code-derived and environment-free.
    const ddlOnly = createHash('sha256')
      .update([...NODE_SCHEMA_QUERIES, ...REL_SCHEMA_QUERIES].join('\n'))
      .digest('hex')
      .slice(0, 12);
    expect(SCHEMA_FINGERPRINT).toBe(ddlOnly);
    expect(SCHEMA_FINGERPRINT).toMatch(/^[0-9a-f]{12}$/);
  });
});

const sha256 = (seed: string): string =>
  `sha256:${createHash('sha256').update(seed).digest('hex')}`;

/** A well-formed schema-v4 receipt, exactly as a successful run stamps it. */
const BASELINE_RECEIPT: AnalyzerRunnerIdentity = {
  schemaVersion: 4,
  runtime: {
    executablePath: '/usr/bin/node',
    version: 'v22.0.0',
    platform: 'linux',
    architecture: 'x64',
    modulesAbi: '127',
    libc: 'glibc',
  },
  cliVersion: '1.0.0',
  invokedArtifact: { path: '/opt/gitnexus/dist/cli/index.js', digest: sha256('cli-entrypoint') },
  build: {
    kind: 'distribution',
    rootPath: '/opt/gitnexus/dist',
    canonicalization: 'gitnexus-analyzer-build-v2',
    digest: sha256('analyzer-build-A'),
  },
  dependencyRuntime: {
    manifestPath: '/opt/gitnexus/package.json',
    lockfilePath: '/opt/gitnexus/package-lock.json',
    canonicalization: 'gitnexus-analyzer-dependency-runtime-v4',
    packageCount: 12,
    artifactCount: 3,
    digest: sha256('dependency-runtime-A'),
  },
};

/**
 * `indexed` is the receipt read off an existing index; the current run always
 * presents BASELINE_RECEIPT. `reusable: false` means "force a full rebuild".
 */
const RUNNER_IDENTITY_CASES: ReadonlyArray<{
  name: string;
  indexed: unknown;
  reusable: boolean;
}> = [
  {
    name: 'a byte-identical receipt reuses the index',
    indexed: structuredClone(BASELINE_RECEIPT),
    reusable: true,
  },
  {
    name: 'a different diagnostic entrypoint (CLI vs analyze worker) is NOT staleness',
    indexed: {
      ...structuredClone(BASELINE_RECEIPT),
      invokedArtifact: {
        path: '/opt/gitnexus/dist/server/analyze-worker.js',
        digest: sha256('worker-entrypoint'),
      },
    },
    reusable: true,
  },
  {
    // THE #2798 INVARIANT. Node ids, wire formats and resolution tiers live in
    // analyzer code, not in DDL: SCHEMA_FINGERPRINT is unchanged across such an
    // edit, and this receipt is the only gate that moves. Each of the ~30
    // no-DDL INCREMENTAL_SCHEMA_VERSION bumps #2798 deleted looked like this.
    name: 'a semantic-only analyzer change (build digest moves, DDL does not) forces a rebuild',
    indexed: {
      ...structuredClone(BASELINE_RECEIPT),
      build: { ...BASELINE_RECEIPT.build, digest: sha256('analyzer-build-B') },
    },
    reusable: false,
  },
  {
    name: 'a dependency/native-runtime change forces a rebuild',
    indexed: {
      ...structuredClone(BASELINE_RECEIPT),
      dependencyRuntime: {
        ...BASELINE_RECEIPT.dependencyRuntime,
        digest: sha256('dependency-runtime-B'),
      },
    },
    reusable: false,
  },
  {
    name: 'a different runtime ABI forces a rebuild',
    indexed: {
      ...structuredClone(BASELINE_RECEIPT),
      runtime: { ...BASELINE_RECEIPT.runtime, modulesAbi: '115' },
    },
    reusable: false,
  },
  {
    // Fail-closed, same posture as an absent schemaFingerprint: an index whose
    // provenance is unknown is never grandfathered into a top-up.
    name: 'an absent receipt (index predates the field) forces a rebuild',
    indexed: undefined,
    reusable: false,
  },
  { name: 'a null receipt forces a rebuild', indexed: null, reusable: false },
  {
    name: 'a legacy schema-v3 receipt forces a rebuild',
    indexed: { ...structuredClone(BASELINE_RECEIPT), schemaVersion: 3 },
    reusable: false,
  },
  {
    name: 'a malformed receipt (build section missing) forces a rebuild',
    indexed: { ...structuredClone(BASELINE_RECEIPT), build: undefined },
    reusable: false,
  },
  {
    name: 'a receipt with a non-digest build hash forces a rebuild',
    indexed: {
      ...structuredClone(BASELINE_RECEIPT),
      build: { ...BASELINE_RECEIPT.build, digest: 'not-a-sha256' },
    },
    reusable: false,
  },
];
