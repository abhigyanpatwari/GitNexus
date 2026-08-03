/**
 * #2798 — SCHEMA_FINGERPRINT, the derived half of the incremental reuse gate.
 *
 * The replaced `INCREMENTAL_SCHEMA_VERSION` was hand-picked and had to PREDICT whether an
 * on-disk database was created from this build's DDL. It clashed exactly
 * with a concurrently-merged branch twice, and the gate was a strict `===`, so
 * such an index read as current while its tables physically could not hold the
 * edges the build emitted. The fingerprint derives that fact instead, and is now
 * the only schema gate.
 *
 * These tests pin the three properties the gate depends on:
 *   1. it covers the DDL that is actually executed (input-set pinning);
 *   2. it is a function of CODE, never of the environment;
 *   3. it moves when any covered DDL string moves.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  NODE_SCHEMA_QUERIES,
  REL_SCHEMA_QUERIES,
  SCHEMA_FINGERPRINT,
  SCHEMA_QUERIES,
  EMBEDDING_SCHEMA,
} from '../../src/core/lbug/schema.js';

const digest = (input: string): string =>
  createHash('sha256').update(input).digest('hex').slice(0, 12);

/**
 * The relationship the gate depends on, as a pure function so the tests below
 * can run it over BOTH the real arrays and a synthetic regression.
 *
 * Returns the executed DDL statements that are neither part of the
 * fingerprint's input nor a documented exclusion — i.e. the statements the gate
 * is blind to. Empty means the digest covers everything that runs.
 */
const ddlNotCoveredByFingerprint = (
  executed: readonly string[],
  fingerprintInput: readonly string[],
  documentedExclusions: readonly string[],
): string[] => {
  const covered = new Set<string>([...fingerprintInput, ...documentedExclusions]);
  return executed.filter((ddl) => !covered.has(ddl));
};

describe('SCHEMA_FINGERPRINT (#2798)', () => {
  it('is a 12-char lowercase hex digest, matching the taintModelVersion shape', () => {
    expect(SCHEMA_FINGERPRINT).toMatch(/^[0-9a-f]{12}$/);
  });

  it('covers exactly the node + relation DDL this build creates', () => {
    // Recomputed from the exported lists rather than hardcoded, so the
    // assertion pins the INPUT SET, not a literal. Adding a table to
    // NODE_SCHEMA_QUERIES (or a FROM/TO pair to RELATION_SCHEMA) without the
    // fingerprint moving becomes impossible.
    expect(SCHEMA_FINGERPRINT).toBe(
      digest([...NODE_SCHEMA_QUERIES, ...REL_SCHEMA_QUERIES].join('\n')),
    );
  });

  it('covers every DDL statement init executes, bar the one documented exclusion', () => {
    // The assertion above pins the digest to its INPUT lists. This one pins those
    // lists to SCHEMA_QUERIES — the array `runSchemaCreationQueries`
    // (lbug-adapter.ts) iterates, i.e. the DDL that actually runs against the
    // database. Without it a FOURTH member could join SCHEMA_QUERIES, go
    // un-fingerprinted, and reproduce the #2798 failure exactly: the gate reads a
    // stale index as current, `runSchemaCreationQueries` suppresses 'already
    // exists' while never creating the new table, and every edge that table
    // should hold is swallowed by `fallbackRelationshipInserts`' bare `catch` —
    // a wrong graph, not an error.
    //
    // EMBEDDING_SCHEMA is the single permitted exclusion, and it is DELIBERATE:
    // its `FLOAT[N]` width comes from GITNEXUS_EMBEDDING_DIMS at module load, so
    // folding it in would make the digest a function of the ENVIRONMENT and make
    // two runs of one build thrash full rebuilds. Do not "fix" this by adding it
    // to the fingerprint input — passing it here as a NAMED exclusion is what
    // keeps it an explicit decision rather than an oversight.
    //
    // Membership-based rather than a positional `toEqual` of the three spreads:
    // ORDER inside the fingerprint input is already pinned by the digest
    // assertion above, so a reordering fails there, on the property it actually
    // breaks. What this case is precise about is COVERAGE, in both directions.
    const fingerprintInput = [...NODE_SCHEMA_QUERIES, ...REL_SCHEMA_QUERIES];

    expect(
      ddlNotCoveredByFingerprint(SCHEMA_QUERIES, fingerprintInput, [EMBEDDING_SCHEMA]),
    ).toEqual([]);

    // The exclusion is real on both sides: EMBEDDING_SCHEMA does run, and it is
    // genuinely outside the digest — so the allowance above is not vacuous.
    expect(SCHEMA_QUERIES).toContain(EMBEDDING_SCHEMA);
    expect(fingerprintInput).not.toContain(EMBEDDING_SCHEMA);

    // Reverse direction: nothing is fingerprinted that init does not execute, so
    // the digest cannot move for DDL that never reaches the database.
    expect(ddlNotCoveredByFingerprint(fingerprintInput, SCHEMA_QUERIES, [])).toEqual([]);
  });

  it('would flag a fourth SCHEMA_QUERIES member that the digest does not cover', () => {
    // Discrimination proof for the case above, pinned in CI rather than checked
    // by hand once: the same predicate, over the same real fingerprint input,
    // must NOT stay silent when SCHEMA_QUERIES grows a member. If a future
    // refactor makes `ddlNotCoveredByFingerprint` vacuous, this fails even
    // though the positive case would still pass.
    const fourthMember = '\nCREATE NODE TABLE Probe (\n  id STRING,\n  PRIMARY KEY (id)\n)';
    const withFourthMember = [...SCHEMA_QUERIES, fourthMember];

    expect(
      ddlNotCoveredByFingerprint(
        withFourthMember,
        [...NODE_SCHEMA_QUERIES, ...REL_SCHEMA_QUERIES],
        [EMBEDDING_SCHEMA],
      ),
    ).toEqual([fourthMember]);
  });

  it('does not fold in EMBEDDING_SCHEMA, whose width is environment-derived', () => {
    // EMBEDDING_SCHEMA carries FLOAT[GITNEXUS_EMBEDDING_DIMS]. Including it
    // would make the fingerprint a function of the environment: the same build
    // under two dims values would disagree and thrash full rebuilds. Proven by
    // construction — appending it changes the digest, so its absence from
    // SCHEMA_FINGERPRINT is load-bearing rather than incidental.
    const withEmbedding = digest(
      [...NODE_SCHEMA_QUERIES, ...REL_SCHEMA_QUERIES, EMBEDDING_SCHEMA].join('\n'),
    );
    expect(withEmbedding).not.toBe(SCHEMA_FINGERPRINT);
  });

  it('moves when a relation FROM/TO pair is added', () => {
    // The #2798 failure shape: v32, v33 and #2781 each added pairs, and #2793
    // regenerated the whole block. Any such change must alter the digest even
    // when the version integer does not.
    const withExtraPair = digest(
      [
        ...NODE_SCHEMA_QUERIES,
        ...REL_SCHEMA_QUERIES.map((ddl) =>
          ddl.replace('  type STRING,', '  FROM `Record` TO `Tool`,\n  type STRING,'),
        ),
      ].join('\n'),
    );
    expect(withExtraPair).not.toBe(SCHEMA_FINGERPRINT);
  });

  it('moves when a node table gains a column', () => {
    const withExtraColumn = digest(
      [
        ...NODE_SCHEMA_QUERIES.map((ddl) =>
          ddl.replace('  id STRING,', '  id STRING,\n  probe STRING,'),
        ),
        ...REL_SCHEMA_QUERIES,
      ].join('\n'),
    );
    expect(withExtraColumn).not.toBe(SCHEMA_FINGERPRINT);
  });
});
