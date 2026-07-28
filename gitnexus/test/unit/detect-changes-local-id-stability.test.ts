/**
 * #2699 consumer audit — `detect_changes` must not key on node ids.
 *
 * #2695/#2714 gave function-local CALLABLES position-bearing ids
 * (`Function:x.ts:run.save@3:2`). That raised a specific worry for this
 * consumer: an id containing `@row:col` changes whenever the declaration
 * MOVES, even when the code is byte-identical, so an id-keyed
 * `detect_changes` would report churn for every edit above a local.
 *
 * The worry is unfounded, and this file pins why. `detect_changes` maps diff
 * hunks to symbols by LINE-RANGE OVERLAP — it matches `n.startLine`/`n.endLine`
 * against the hunk bounds and merely REPORTS `n.id`. Node identity never
 * participates in the match, so a position-bearing id cannot inflate
 * `changed_count`.
 *
 * These are structural (source-grep) assertions, in the same idiom as
 * `detect-changes-worktree.test.ts`: they prove the query still has the shape
 * the audit verified, and would fail loudly if someone switched the mapping to
 * id equality. They do NOT execute the query — the behavioural coverage for
 * detect_changes lives in the MCP integration suites.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendSrc = readFileSync(
  path.join(__dirname, '../../src/mcp/local/local-backend.ts'),
  'utf-8',
);

/** The hunk→symbol query, isolated so the assertions below can't match text elsewhere. */
const symbolQuery = (): string => {
  const start = backendSrc.indexOf('const symbolQuery = `');
  expect(start, 'symbolQuery template not found — update this test').toBeGreaterThan(-1);
  const from = backendSrc.indexOf('`', start) + 1;
  const to = backendSrc.indexOf('`', from);
  return backendSrc.slice(from, to);
};

describe('#2699 audit — detect_changes maps hunks to symbols by position, not id', () => {
  it('matches on startLine/endLine, so a moved local cannot register as churn', () => {
    const q = symbolQuery();

    expect(q).toContain('n.startLine IS NOT NULL');
    expect(q).toContain('n.endLine IS NOT NULL');
  });

  it('never matches a symbol by node id', () => {
    // The guard that matters. `n.id` may be SELECTED (it is reported back to
    // the caller) but must not appear in a WHERE-side equality against a
    // parameter — that would reintroduce the id-churn failure mode.
    const q = symbolQuery();
    const whereClause = q.slice(q.indexOf('WHERE'), q.indexOf('RETURN'));

    expect(whereClause).not.toMatch(/n\.id\s*=/);
    expect(whereClause).not.toMatch(/n\.id\s+IN\b/);
  });

  it('still excludes BasicBlock rows by id prefix (#2082 U7)', () => {
    // The one legitimate id-shaped predicate: a PREFIX filter that drops
    // nameless PDG substrate. Pinned so the assertion above cannot be
    // satisfied by deleting this exclusion.
    const q = symbolQuery();

    expect(q).toContain("NOT n.id STARTS WITH 'BasicBlock:'");
  });

  it('reports the id rather than matching on it', () => {
    const q = symbolQuery();

    expect(q.slice(q.indexOf('RETURN'))).toContain('n.id AS id');
  });
});
