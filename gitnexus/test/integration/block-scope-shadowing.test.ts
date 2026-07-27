/**
 * #2699 — JS/TS `statement_block` scopes, and the false ACCESSES edges they
 * remove.
 *
 * Enabling `(statement_block) @scope.block` for TS/JS dropped 114 ACCESSES
 * edges across a 762-file corpus with `added: 0`. That looked like a
 * regression, so it was measured rather than assumed: all 274 emitting
 * reference sites behind those 114 edges were classified by re-reading the
 * source at the site. Every one of the 114 had at least one site of the form
 * `receiver.name`, and none was bare-identifier-only. (269 sites classified as
 * member reads outright; the 5 remaining were classifier artifacts — the name
 * also occurred earlier on the line, as in `a.b.declLine` for `b` — and are
 * member reads too.) So every dropped edge was a PROPERTY read
 * (`options.baseUrl`) mis-resolving to an unrelated function-local `const` of
 * the same name in the same file.
 *
 * The cause is not block-specific: `lookupCore` Step 1 walks the lexical chain
 * for every lookup, including explicit-receiver property reads, so
 * `options.baseUrl` can bind to a local `baseUrl`. Block scopes do not fix that
 * — they narrow it, by moving the local off the chain of any reference outside
 * its block. The remaining case (a local declared directly in the function
 * body) is unchanged and still mis-resolves; that is pre-existing and tracked
 * separately.
 *
 * So these tests pin the direction of the change in BOTH directions: the
 * property read must not reach the block-local, and the genuine bare read of
 * that same local must still emit its edge. Deleting the block-scope capture
 * fails the first; over-suppressing (dropping block bindings instead of
 * scoping them) fails the second.
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { DIST_WORKER_URL, distWorkerExists } from '../helpers/worker-parse.js';

vi.setConfig({ testTimeout: 90_000 });

/** `ACCESSES` edges in a one-file repo, as `source -> target` id pairs. */
const accessEdgesFor = async (filename: string, source: string): Promise<string[]> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-block-scope-'));
  try {
    fs.writeFileSync(path.join(dir, filename), source, 'utf-8');
    const result = await runPipelineFromRepo(dir, () => {}, {
      workerPoolSize: 1,
      workerUrlForTest: DIST_WORKER_URL,
      // `pruneLocalSymbols` drops inert function-local value symbols — ~94% of
      // them on a real corpus — so in a two-line fixture the `const` under test
      // is deleted before any edge can name it, and both arms return []. That
      // is why earlier synthetic attempts at this edge class all read as "no
      // difference". Keeping them is what makes the fixture discriminate.
      keepLocalValueSymbols: true,
    });
    return result.graph.relationships
      .filter((rel) => rel.type === 'ACCESSES')
      .map((rel) => `${rel.sourceId} -> ${rel.targetId}`)
      .sort();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

// The member read sits OUTSIDE the block on purpose. Inside it, the block is on
// the reference's own lexical chain and the property would bind to the local in
// either arm — so an inside-the-block fixture cannot discriminate.
const SHADOWED = [
  'export function pickBaseUrl(options: { baseUrl?: string }, fallback: string): string {',
  '  if (fallback.length > 0) {',
  '    const baseUrl = fallback.trim();',
  '    return baseUrl;',
  '  }',
  '  return options.baseUrl ?? fallback;',
  '}',
  '',
].join('\n');

const describeIfWorkerBuilt = distWorkerExists() ? describe : describe.skip;

describeIfWorkerBuilt('block scopes keep a property read off a same-named block local', () => {
  it('TypeScript: `options.baseUrl` does not ACCESS the block-local `const baseUrl`', async () => {
    const edges = await accessEdgesFor('pick.ts', SHADOWED);

    expect(edges.filter((e) => e.endsWith('baseUrl') && e.includes('pickBaseUrl'))).toEqual([]);
  });

  it('TypeScript: a real property read still resolves past a same-named block local', async () => {
    // Companion invariant, not a discriminating regression test: this edge is
    // identical in both arms. It exists because the test above only proves an
    // edge went away, which a change that dropped Block-kind bindings entirely
    // would also satisfy. Asserting the surviving edge SET — exactly one, and
    // pointing at the class property rather than the block local — is what
    // separates "correctly scoped" from "deleted".
    const edges = await accessEdgesFor(
      'box.ts',
      [
        'export class Box {',
        "  baseUrl = 'https://example.com';",
        '  pick(fallback: string): string {',
        '    if (fallback.length > 0) {',
        '      const baseUrl = fallback.trim();',
        '      return baseUrl;',
        '    }',
        '    return this.baseUrl;',
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    // Matched on the target rather than the whole id: the method node carries
    // an overload index (`Box.pick#1`) that is orthogonal to what this pins.
    expect(edges).toHaveLength(1);
    expect(edges[0]).toContain('-> Property:box.ts:Box.baseUrl');
  });
});

describeIfWorkerBuilt('a property read never resolves to a lexical binding of its own name', () => {
  // The residual half. Block scopes moved a NESTED-block local off the chain of
  // a reference outside that block, which removed 114 false edges on a 762-file
  // corpus. A local declared directly in the FUNCTION BODY stayed on the chain,
  // so `options.baseUrl` still bound to it — same defect, one scope level up,
  // and not fixable by adding more scopes.
  //
  // Fixed in `lookupCore` instead: Step 1's lexical walk is skipped when the
  // site has an explicit receiver. `recv.name` names a member of whatever
  // `recv` denotes; a binding of the bare tail name in an enclosing scope is
  // never the right answer.

  it('TypeScript: `options.baseUrl` does not ACCESS a function-body-level `const baseUrl`', async () => {
    const edges = await accessEdgesFor(
      'body.ts',
      [
        'export function pick(options: { baseUrl?: string }, fallback: string): string {',
        '  const baseUrl = fallback.trim();',
        '  if (baseUrl.length > 0) return baseUrl;',
        '  return options.baseUrl ?? fallback;',
        '}',
        '',
      ].join('\n'),
    );

    expect(edges.filter((e) => e.endsWith('baseUrl'))).toEqual([]);
  });

  it('TypeScript: a real member read still resolves through the receiver type', async () => {
    // The guard against over-suppression: skipping Step 1 must not take Steps
    // 2 and 3 with it. `this.baseUrl` has an explicit receiver too, and it
    // must still reach the class property.
    const edges = await accessEdgesFor(
      'recv.ts',
      [
        'export class Box {',
        "  baseUrl = 'https://example.com';",
        '  read(): string {',
        '    return this.baseUrl;',
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    expect(edges).toHaveLength(1);
    expect(edges[0]).toContain('-> Property:recv.ts:Box.baseUrl');
  });
});
