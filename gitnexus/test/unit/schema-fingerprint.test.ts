/**
 * #2798 — SCHEMA_FINGERPRINT, the derived half of the incremental reuse gate.
 *
 * `INCREMENTAL_SCHEMA_VERSION` is hand-picked and has to PREDICT whether an
 * on-disk database was created from this build's DDL. It has clashed exactly
 * with a concurrently-merged branch twice, and the gate is a strict `===`, so
 * such an index reads as current while its tables physically cannot hold the
 * edges this build emits. The fingerprint derives that fact instead.
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
  EMBEDDING_SCHEMA,
} from '../../src/core/lbug/schema.js';

const digest = (input: string): string =>
  createHash('sha256').update(input).digest('hex').slice(0, 12);

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

  it('is stable across repeated evaluation (no per-call randomness)', () => {
    expect(digest([...NODE_SCHEMA_QUERIES, ...REL_SCHEMA_QUERIES].join('\n'))).toBe(
      SCHEMA_FINGERPRINT,
    );
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
