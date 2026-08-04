/**
 * Integration test: impact() ambiguous-resolution blast radius (#2129)
 *
 * Reproduces the issue's graph shape: a small helper name (`classifyCard`)
 * exists in two files. The "real" one is called by `syncContent` (+ another
 * caller); a coincidental same-name helper elsewhere is called by `renderCard`.
 *
 * Before fix: impact("classifyCard", upstream) resolves the ambiguous bare name
 * to `impactedCount: 0` with a flat candidate list — the real caller
 * (`syncContent`) is silently dropped because it calls the *other* same-name
 * node. After fix: the ambiguous response runs a bounded summary-only BFS per
 * candidate, surfacing each one's true count + the maximum, so no real caller
 * hides behind a bare zero. The BFS / edge storage are unchanged — disambiguation
 * by uid still returns the exact caller.
 */
import { it, expect, beforeAll, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  findSiblingClones: vi.fn().mockResolvedValue([]),
}));

const SYNC_LOGIC_ID = 'Function:src/sync-logic.ts:classifyCard';
const UI_HELPERS_ID = 'Function:src/ui-helpers.ts:classifyCard';

const SEED = [
  // Two distinct functions named `classifyCard` in different files.
  `CREATE (cc1:Function {id: '${SYNC_LOGIC_ID}', name: 'classifyCard', filePath: 'src/sync-logic.ts', startLine: 1, endLine: 3, isExported: true, content: '', description: ''})`,
  `CREATE (cc2:Function {id: '${UI_HELPERS_ID}', name: 'classifyCard', filePath: 'src/ui-helpers.ts', startLine: 1, endLine: 3, isExported: true, content: '', description: ''})`,

  // Real callers of the sync-logic classifyCard (the blast radius that was lost).
  `CREATE (sc:Function {id: 'Function:src/actions.ts:syncContent', name: 'syncContent', filePath: 'src/actions.ts', startLine: 10, endLine: 120, isExported: true, content: '', description: ''})`,
  `CREATE (ss:Function {id: 'Function:src/actions.ts:scheduleSync', name: 'scheduleSync', filePath: 'src/actions.ts', startLine: 130, endLine: 160, isExported: true, content: '', description: ''})`,
  // Caller of the coincidental ui-helpers classifyCard.
  `CREATE (rc:Function {id: 'Function:src/ui-helpers.ts:renderCard', name: 'renderCard', filePath: 'src/ui-helpers.ts', startLine: 20, endLine: 40, isExported: true, content: '', description: ''})`,

  `MATCH (a:Function {id:'Function:src/actions.ts:syncContent'}), (b:Function {id:'${SYNC_LOGIC_ID}'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:0.85, reason:'direct', step:0}]->(b)`,
  `MATCH (a:Function {id:'Function:src/actions.ts:scheduleSync'}), (b:Function {id:'${SYNC_LOGIC_ID}'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:0.85, reason:'direct', step:0}]->(b)`,
  `MATCH (a:Function {id:'Function:src/ui-helpers.ts:renderCard'}), (b:Function {id:'${UI_HELPERS_ID}'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:0.85, reason:'direct', step:0}]->(b)`,

  // Two same-named non-callable consts — an ambiguity that survives the #2687
  // twin fix, used to pin that a value candidate reports a real `kind`.
  `CREATE (k1:Const {id: 'Const:src/config-a.ts:APP_CONFIG', name: 'APP_CONFIG', filePath: 'src/config-a.ts', startLine: 1, endLine: 1, content: '', description: ''})`,
  `CREATE (k2:Const {id: 'Const:src/config-b.ts:APP_CONFIG', name: 'APP_CONFIG', filePath: 'src/config-b.ts', startLine: 1, endLine: 1, content: '', description: ''})`,

  // A class and a same-named value binding in another file — the #480
  // Class/Constructor collapse must still fold onto the Class. Before the
  // enrichment widening these value candidates carried `type: ''`, which is
  // what kept the collapse gate open.
  `CREATE (rc:Class {id: 'Class:src/registry.ts:Registry', name: 'Registry', filePath: 'src/registry.ts', startLine: 1, endLine: 9, isExported: true, content: '', description: ''})`,
  `CREATE (rv:Const {id: 'Const:test/registry.test.ts:Registry', name: 'Registry', filePath: 'test/registry.test.ts', startLine: 3, endLine: 3, content: '', description: ''})`,
  `CREATE (ru:Function {id: 'Function:src/boot.ts:boot', name: 'boot', filePath: 'src/boot.ts', startLine: 1, endLine: 5, isExported: true, content: '', description: ''})`,
  `MATCH (a:Function {id:'Function:src/boot.ts:boot'}), (b:Class {id:'Class:src/registry.ts:Registry'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:0.85, reason:'direct', step:0}]->(b)`,

  // #2787 review F4 — the two shapes the Class/Interface collapse must now tell
  // apart. `Panel`: ONE Class plus its Constructor (the literal #480 case) —
  // exactly one candidate carries the label, so collapsing is a correct
  // confident answer. `Widget`: TWO Classes in different files plus a same-named
  // value binding — more than one candidate carries the label, so there is no
  // right answer to pick and the caller must be told.
  `CREATE (:Class {id: 'Class:src/panel.ts:Panel', name: 'Panel', filePath: 'src/panel.ts', startLine: 1, endLine: 12, isExported: true, content: '', description: ''})`,
  `CREATE (:Constructor {id: 'Constructor:src/panel.ts:Panel', name: 'Panel', filePath: 'src/panel.ts', startLine: 2, endLine: 4, content: '', description: ''})`,
  `CREATE (:Class {id: 'Class:src/widgets/alpha.ts:Widget', name: 'Widget', filePath: 'src/widgets/alpha.ts', startLine: 1, endLine: 20, isExported: true, content: '', description: ''})`,
  `CREATE (:Class {id: 'Class:src/widgets/beta.ts:Widget', name: 'Widget', filePath: 'src/widgets/beta.ts', startLine: 1, endLine: 20, isExported: true, content: '', description: ''})`,
  `CREATE (:Const {id: 'Const:test/widget.test.ts:Widget', name: 'Widget', filePath: 'test/widget.test.ts', startLine: 3, endLine: 3, content: '', description: ''})`,
];

withTestLbugDB(
  'impact-ambiguous-blast-radius',
  (handle) => {
    let backend: LocalBackend;
    beforeAll(() => {
      backend = (handle as any)._backend;
    });

    it('surfaces per-candidate blast radius instead of a bare impactedCount:0', async () => {
      const result = await backend.callTool('impact', {
        target: 'classifyCard',
        direction: 'upstream',
      });

      expect(result.status).toBe('ambiguous');
      expect(Array.isArray(result.candidates)).toBe(true);
      expect(result.candidates).toHaveLength(2);

      // The fix: the maximum real blast radius is hoisted to the top level so
      // the response can never be misread as "safe to refactor".
      expect(result.maxImpactedCount).toBeGreaterThanOrEqual(2);

      // Each candidate carries its own true count — the dropped caller is no
      // longer hidden behind the ambiguous zero.
      const syncLogic = result.candidates.find((c: any) =>
        String(c.filePath).includes('sync-logic'),
      );
      const uiHelpers = result.candidates.find((c: any) =>
        String(c.filePath).includes('ui-helpers'),
      );
      expect(syncLogic).toBeDefined();
      expect(uiHelpers).toBeDefined();
      expect(syncLogic.impactedCount).toBeGreaterThanOrEqual(2);
      expect(uiHelpers.impactedCount).toBeGreaterThanOrEqual(1);

      // Candidates are ranked by blast radius (most-impactful interpretation
      // first) so the dangerous one leads.
      expect(result.candidates[0].impactedCount).toBeGreaterThanOrEqual(
        result.candidates[1].impactedCount,
      );
    });

    it('reports an undetermined impactedCount, never a numeric zero (#2687)', async () => {
      const result = await backend.callTool('impact', {
        target: 'classifyCard',
        direction: 'upstream',
      });

      // #2129 hoisted maxImpactedCount so a real caller could not hide behind
      // the ambiguous zero — but the zero itself was still byte-identical to a
      // genuine "nothing depends on this". A consumer testing
      // `impactedCount === 0` got a confident all-clear without ever reading
      // `candidates[]`. `null` is undetermined and cannot be misread that way.
      expect(result).toMatchObject({ status: 'ambiguous', impactedCount: null, risk: 'UNKNOWN' });
      expect(typeof result.impactedCount).not.toBe('number');

      // The truthful signal is still present and still non-zero.
      expect(result.maxImpactedCount).toBeGreaterThanOrEqual(2);
    });

    it('reports a real kind for an ambiguous value candidate (#2687)', async () => {
      // `labels(n)[0]` comes back empty for these node types, and the label
      // enrichment UNION used to cover only Class/Interface/Function/Method/
      // Constructor — so a value candidate surfaced as `kind: ""`, which reads
      // as "unknown kind" and leaves the `kind` disambiguation hint unable to
      // filter it out.
      const result = await backend.callTool('impact', {
        target: 'APP_CONFIG',
        direction: 'upstream',
      });

      expect(result.status).toBe('ambiguous');
      expect(result.candidates.map((c: { kind: string }) => c.kind)).toEqual(['Const', 'Const']);
    });

    it('still collapses a Class against a same-named value binding (#480)', async () => {
      // Regression guard for the enrichment widening: the collapse gate keys on
      // "some candidate has an indeterminate kind". Value candidates used to
      // qualify by carrying `type: ''`; now that enrichment fills them in they
      // must be named explicitly, or this resolves to `ambiguous` and every
      // resolver-backed tool loses a previously confident answer.
      const result = await backend.callTool('impact', {
        target: 'Registry',
        direction: 'upstream',
      });

      expect(result.status).not.toBe('ambiguous');
      expect(result.target).toMatchObject({
        id: 'Class:src/registry.ts:Registry',
        type: 'Class',
      });
      expect(result.impactedCount).toBeGreaterThanOrEqual(1);
    });

    it('still collapses a lone Class against its same-named Constructor (#480, #2787 review F4)', async () => {
      // Non-regression half of the F4 fix. The collapse probe went from
      // `LIMIT 1` to `LIMIT 2` and now requires EXACTLY one row — one Class plus
      // one Constructor still yields exactly one Class row, so the confident
      // answer #480 introduced is unchanged. If this flips to `ambiguous`, the
      // uniqueness guard was made too strict and every resolver-backed tool
      // loses a previously confident resolution.
      const result = await backend.callTool('context', { name: 'Panel' });

      expect(result).toMatchObject({ status: 'found' });
      expect(result.symbol).toMatchObject({ uid: 'Class:src/panel.ts:Panel', kind: 'Class' });
    });

    it('refuses to collapse when TWO candidates carry the Class label (#2787 review F4)', async () => {
      // Collapsing returns `kind: 'ok'` — the caller never sees the scorer or
      // the ambiguity report — and it is the ONLY confident path a bare name can
      // take (scoreCandidate tops out at 0.60 without a file_path hint; the
      // confident gate needs >= 0.95). With `LIMIT 1` the probe took whichever
      // labelled row came back and answered confidently; adding `ORDER BY n.id`
      // made that wrong pick REPEATABLE rather than right — `context`/`impact`
      // would silently analyse src/widgets/alpha.ts and never mention beta.
      // `LIMIT 2` turns the second row into a uniqueness check.
      const result = await backend.callTool('context', { name: 'Widget' });

      expect(result).toMatchObject({ status: 'ambiguous' });
      expect((result.candidates as Array<{ uid: string }>).map((c) => c.uid).sort()).toEqual([
        'Class:src/widgets/alpha.ts:Widget',
        'Class:src/widgets/beta.ts:Widget',
        'Const:test/widget.test.ts:Widget',
      ]);
      // Both classes are offered, so the caller can disambiguate — the file the
      // old code silently discarded is the second entry above.
      expect(result.totalCandidates).toBe(3);
    });

    it('reports an undetermined impactedCount for an ambiguous pdg target (#2687)', async () => {
      // The pdg branch has no per-candidate fan-out, so it carries no
      // maxImpactedCount at all — a numeric zero here is even less correctable.
      const result = await backend.callTool('impact', {
        target: 'classifyCard',
        direction: 'upstream',
        mode: 'pdg',
      });

      expect(result).toMatchObject({
        status: 'ambiguous',
        mode: 'pdg',
        impactedCount: null,
        risk: 'UNKNOWN',
      });
      expect(typeof result.impactedCount).not.toBe('number');
    });

    it('disambiguation by uid returns the exact dropped caller (BFS unchanged)', async () => {
      const result = await backend.callTool('impact', {
        target: 'classifyCard',
        target_uid: SYNC_LOGIC_ID,
        direction: 'upstream',
      });

      expect(result.status).not.toBe('ambiguous');
      expect(result.impactedCount).toBeGreaterThanOrEqual(2);
      const names = Object.values(result.byDepth as Record<string, any[]>)
        .flat()
        .map((d: any) => d.name);
      expect(names).toContain('syncContent');
      expect(names).toContain('scheduleSync');
    });
  },
  {
    seed: SEED,
    poolAdapter: true,
    afterSetup: async (handle) => {
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'test-repo',
          path: '/test/repo',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc123',
          stats: { files: 5, nodes: 6, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as any)._backend = backend;
    },
  },
);

/**
 * #2787 — the resolver's LIMIT 20 window must be pinned by ORDER BY.
 *
 * 25 Functions share one name, seeded in DESCENDING id order. Without an
 * ORDER BY, LadybugDB hands back the first 20 it scans (insertion order on a
 * fixture this small, an arbitrary subset on a real index) — `collide-z25`
 * down to `collide-z06`. With `ORDER BY n.id` it returns the 20 lowest ids,
 * `collide-z01` through `collide-z20`. The two sets are disjoint on 10
 * elements, so the exact-list assertion below distinguishes them.
 *
 * `context` is the observable surface, not `impact`: it returns every resolver
 * candidate untruncated, while `impact` slices to AMBIGUOUS_MAX_CANDIDATES and
 * re-sorts by blast radius, which would hide the window difference.
 */
const COLLIDE_COUNT = 25;
const COLLIDE_IDS = Array.from(
  { length: COLLIDE_COUNT },
  (_, i) => `Function:src/z${String(i + 1).padStart(2, '0')}.ts:collide`,
);

withTestLbugDB(
  'resolver-window-ordering-2787',
  (handle) => {
    let backend: LocalBackend;
    beforeAll(() => {
      backend = (handle as any)._backend;
    });

    it('returns the 20 lowest-id candidates, not an arbitrary window (#2787)', async () => {
      const result = await backend.callTool('context', { name: 'collide' });

      expect(result.status).toBe('ambiguous');
      // 25 is the TRUE match count (a COUNT alongside the window); 20 is the
      // window. Reporting the window here claimed the cap was the total.
      expect(result).toMatchObject({ totalCandidates: COLLIDE_COUNT, candidatesTruncated: true });
      expect(result.message).toContain(`Found ${COLLIDE_COUNT} symbols`);
      expect(result.message).toContain('showing 20');
      expect((result.candidates as Array<{ uid: string }>).map((c) => c.uid)).toEqual(
        COLLIDE_IDS.slice(0, 20),
      );
    });
  },
  {
    // Descending: the highest id is inserted first, so an unordered scan that
    // follows insertion order returns exactly the wrong half.
    seed: [...COLLIDE_IDS]
      .reverse()
      .map(
        (id, i) =>
          `CREATE (:Function {id: '${id}', name: 'collide', filePath: 'src/z${String(COLLIDE_COUNT - i).padStart(2, '0')}.ts', startLine: 1, endLine: 3, isExported: true, content: '', description: ''})`,
      ),
    poolAdapter: true,
    afterSetup: async (handle) => {
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'test-repo',
          path: '/test/repo',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc123',
          stats: { files: COLLIDE_COUNT, nodes: COLLIDE_COUNT, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as any)._backend = backend;
    },
  },
);
