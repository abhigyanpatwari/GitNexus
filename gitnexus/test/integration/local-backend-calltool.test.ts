/**
 * P0 Integration Tests: Local Backend — callTool dispatch
 *
 * Tests the full LocalBackend.callTool() dispatch with a real LadybugDB
 * instance, verifying cypher, context, impact, and query tools work
 * end-to-end against seeded graph data with FTS indexes.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import {
  LOCAL_BACKEND_SEED_DATA,
  LOCAL_BACKEND_FTS_INDEXES,
} from '../fixtures/local-backend-seed.js';

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  findSiblingClones: vi.fn().mockResolvedValue([]),
}));

// ─── Block 2: callTool dispatch tests ────────────────────────────────

withTestLbugDB(
  'local-backend-calltool',
  (handle) => {
    describe('callTool dispatch with real DB', () => {
      let backend: LocalBackend;

      beforeAll(async () => {
        // backend is created in afterSetup and attached to the handle
        const ext = handle as typeof handle & { _backend?: LocalBackend };
        if (!ext._backend) {
          throw new Error(
            'LocalBackend not initialized — afterSetup did not attach _backend to handle',
          );
        }
        backend = ext._backend;
      });

      it('cypher tool returns function names', async () => {
        const result = await backend.callTool('cypher', {
          query: 'MATCH (n:Function) RETURN n.name AS name ORDER BY n.name',
        });
        // cypher tool wraps results as markdown
        expect(result).toHaveProperty('markdown');
        expect(result).toHaveProperty('row_count');
        expect(result.row_count).toBeGreaterThanOrEqual(3);
        expect(result.markdown).toContain('login');
        expect(result.markdown).toContain('validate');
        expect(result.markdown).toContain('hash');
      });

      it('cypher no-match write probe returns read-only error or empty rows', async () => {
        const result = await backend.callTool('cypher', {
          query:
            "MATCH (n:Function) WHERE n.name = '__missing__' SET n.name = 'x' RETURN n.name AS name",
        });
        if (result?.error) {
          expect(result.error).toMatch(/write operations|read-only/i);
          return;
        }
        expect(result).toEqual([]);
      });

      it('context tool returns symbol info with callers and callees', async () => {
        const result = await backend.callTool('context', { name: 'login' });
        expect(result).not.toHaveProperty('error');
        expect(result.status).toBe('found');
        // Should have the symbol identity
        expect(result.symbol).toBeDefined();
        expect(result.symbol.name).toBe('login');
        expect(result.symbol.filePath).toBe('src/auth.ts');
        // login calls validate and hash — should appear in outgoing.calls
        expect(result.outgoing).toBeDefined();
        expect(result.outgoing.calls).toBeDefined();
        expect(result.outgoing.calls.length).toBeGreaterThanOrEqual(2);
        const calleeNames = result.outgoing.calls.map((c: any) => c.name);
        expect(calleeNames).toContain('validate');
        expect(calleeNames).toContain('hash');
      });

      it('impact tool returns upstream dependents', async () => {
        const result = await backend.callTool('impact', {
          target: 'validate',
          direction: 'upstream',
        });
        expect(result).not.toHaveProperty('error');
        // validate is called by login, so login should appear at depth 1
        expect(result.impactedCount).toBeGreaterThanOrEqual(1);
        expect(result.byDepth).toBeDefined();
        const directDeps = result.byDepth[1] || result.byDepth['1'] || [];
        expect(directDeps.length).toBeGreaterThanOrEqual(1);
        const depNames = directDeps.map((d: any) => d.name);
        expect(depNames).toContain('login');
      });

      it('query tool returns results for keyword search', async () => {
        const result = await backend.callTool('query', { query: 'login' });
        expect(result).not.toHaveProperty('error');
        expect(result).toHaveProperty('processes');
        expect(result).toHaveProperty('definitions');
        expect(result.processes.map((p: any) => p.id)).toContain('proc:login-flow');
        expect(result.process_symbols.map((s: any) => s.id)).toContain('func:login');

        // #553: query response carries per-phase timing metadata.
        expect(result.timing).toBeDefined();
        expect(typeof result.timing.wall).toBe('number');
        expect(result.timing.wall).toBeGreaterThanOrEqual(0);
        // At least one of the search phases must have fired for any
        // non-error response — bm25 and/or vector always runs.
        expect(result.timing.bm25 ?? result.timing.vector).toBeGreaterThanOrEqual(0);

        // Success path (FTS present + Process/Community tables exist): no degraded
        // signal. Guards R6 — the response shape stays byte-identical when nothing
        // fails (the `warning`/`partial` fields appear only on degradation).
        expect(result).not.toHaveProperty('warning');
        expect(result).not.toHaveProperty('partial');
      });

      // #2175: end-to-end proof that the renamed parameters work against a real
      // index (Claude Code drops a tool arg named exactly "query").
      it('query tool returns results via the new search_query param (#2175)', async () => {
        const result = await backend.callTool('query', { search_query: 'login' });
        expect(result).not.toHaveProperty('error');
        expect(result).toHaveProperty('processes');
        expect(result.processes.map((p: any) => p.id)).toContain('proc:login-flow');
        expect(result.process_symbols.map((s: any) => s.id)).toContain('func:login');
      });

      it('cypher tool executes via the new statement param (#2175)', async () => {
        const result = await backend.callTool('cypher', {
          statement: 'MATCH (n:Function) RETURN n.name AS name ORDER BY n.name',
        });
        expect(result).toHaveProperty('markdown');
        expect(result).toHaveProperty('row_count');
        expect(result.row_count).toBeGreaterThanOrEqual(3);
        expect(result.markdown).toContain('login');
      });

      // PR #222 port: the query tool batches per-symbol process/cohesion/content
      // lookups (N+1 → 2-3 `WHERE n.id IN $nodeIds` queries). These assertions
      // guard the batch-adaptation hazards that a naive cherry-pick would break:
      // (1) each symbol keeps ITS OWN community (the per-node first-row pick that
      //     replaced the per-symbol `LIMIT 1`), and (2) content maps to the right
      //     node — both depend on the +1 positional-index shift after prepending
      //     `n.id AS nodeId`. func:login is MEMBER_OF comm:auth ("Authentication");
      //     func:validate has no community, so it must NOT inherit login's.
      it('query batches per-symbol enrichment without cross-assigning community/content', async () => {
        const findSym = (res: any, id: string) =>
          (res.process_symbols ?? []).find((s: any) => s.id === id) ??
          (res.definitions ?? []).find((s: any) => s.id === id);

        const loginRes = await backend.callTool('query', {
          query: 'login',
          include_content: true,
        });
        expect(loginRes).not.toHaveProperty('error');
        const login = findSym(loginRes, 'func:login');
        expect(login).toBeDefined();
        // Community correctly associated to its own node (not dropped, not leaked).
        expect(login.module).toBe('Authentication');
        // Content correctly mapped to its own node (positional [1] after nodeId).
        expect(login.content).toBe('function login() {}');

        const validateRes = await backend.callTool('query', {
          query: 'validate',
          include_content: true,
        });
        expect(validateRes).not.toHaveProperty('error');
        const validate = findSym(validateRes, 'func:validate');
        expect(validate).toBeDefined();
        // validate has no MEMBER_OF edge — a flat batched `LIMIT 1` would have
        // leaked some other node's community onto it. It must have none.
        expect(validate.module).toBeUndefined();
        expect(validate.content).toBe('function validate() {}');
      });

      // PR #222 port: a symbol in MULTIPLE processes is what fully exercises the
      // +1 positional shift in the batched STEP_IN_PROCESS aggregation — with a
      // single process row, `row.pid ?? row[1]` succeeds whether the shift is
      // right or wrong. func:validate is a step in BOTH proc:login-flow (step 2)
      // and proc:beta-flow (step 3), so both rows for the one node must be parsed
      // (pid=row[1], step=row[6]); an off-by-one would drop a process or mis-pair
      // pid↔step. Also pins process ranking (totalScore via the regroup-by-nodeId).
      it('query batches a multi-process symbol and ranks processes (positional shift across rows)', async () => {
        const res = await backend.callTool('query', { query: 'validate' });
        expect(res).not.toHaveProperty('error');
        const processIds = (res.processes ?? []).map((p: any) => p.id);
        // Both of validate's processes must appear — both STEP_IN_PROCESS rows
        // were parsed and grouped by the correct pid (row[1]).
        expect(processIds).toContain('proc:login-flow');
        expect(processIds).toContain('proc:beta-flow');

        // process_symbols dedups by id, so validate appears once carrying the
        // pid+step of its top-ranked process — they must come from the SAME
        // shifted row: login-flow⇒step 2, beta-flow⇒step 3.
        const v = (res.process_symbols ?? []).find((s: any) => s.id === 'func:validate');
        expect(v).toBeDefined();
        expect(v.step_index).toBe(v.process_id === 'proc:beta-flow' ? 3 : 2);

        // Ranking: 'login' surfaces proc:login-flow as the top process.
        const loginRes = await backend.callTool('query', { query: 'login' });
        expect((loginRes.processes ?? [])[0]?.id).toBe('proc:login-flow');
      });

      it('tool_map returns per-tool flows without cross-attributing same-file tools', async () => {
        const result = await backend.callTool('tool_map', {});
        expect(result).not.toHaveProperty('error');

        const tools = new Map(result.tools.map((tool: any) => [tool.name, tool]));
        expect(tools.get('alpha')?.description).toBe('Calls chain A.');
        expect(tools.get('beta')?.description).toBe('Calls chain B.');
        expect(tools.get('alpha')?.flows).toEqual(['AlphaFlow']);
        expect(tools.get('beta')?.flows).toEqual(['BetaFlow']);
      });

      it('unknown tool throws', async () => {
        await expect(backend.callTool('nonexistent_tool', {})).rejects.toThrow(/unknown tool/i);
      });
    });

    describe('impact tool relationTypes filtering', () => {
      let backend: LocalBackend;

      beforeAll(async () => {
        const ext = handle as typeof handle & { _backend?: LocalBackend };
        if (!ext._backend) {
          throw new Error(
            'LocalBackend not initialized — afterSetup did not attach _backend to handle',
          );
        }
        backend = ext._backend;
      });

      it('filters by HAS_METHOD only', async () => {
        const result = await backend.callTool('impact', {
          target: 'AuthService',
          direction: 'downstream',
          relationTypes: ['HAS_METHOD'],
        });
        expect(result).not.toHaveProperty('error');
        expect(result.impactedCount).toBeGreaterThanOrEqual(1);
        const d1 = result.byDepth[1] || result.byDepth['1'] || [];
        const names = d1.map((d: any) => d.name);
        expect(names).toContain('authenticate');
        // Should NOT include CALLS-reachable symbols like validate/hash
        expect(names).not.toContain('validate');
        expect(names).not.toContain('hash');
      });

      it('filters by OVERRIDES only', async () => {
        // The seed has two Method nodes named 'authenticate' (AuthService's
        // override and BaseService's base). Per #470, `impact` now returns
        // a ranked-ambiguous response when the target name hits multiple
        // symbols, so we must disambiguate with file_path to get the
        // AuthService override (the one with the outgoing METHOD_OVERRIDES
        // edge we want to follow downstream).
        const result = await backend.callTool('impact', {
          target: 'authenticate',
          file_path: 'src/auth.ts',
          direction: 'downstream',
          relationTypes: ['METHOD_OVERRIDES'],
        });
        expect(result).not.toHaveProperty('error');
        expect(result.status).not.toBe('ambiguous');
        // AuthService.authenticate overrides BaseService.authenticate
        expect(result.impactedCount).toBeGreaterThanOrEqual(1);
        const d1 = result.byDepth[1] || result.byDepth['1'] || [];
        const names = d1.map((d: any) => d.name);
        expect(names).toContain('authenticate');
      });

      it('expands legacy OVERRIDES to include METHOD_OVERRIDES (dual-read)', async () => {
        // Pass the LEGACY alias 'OVERRIDES' — impactByUid should flatMap-expand
        // it to ['OVERRIDES', 'METHOD_OVERRIDES'] so the METHOD_OVERRIDES edge
        // between BaseService.authenticate and AuthService.authenticate is found.
        // file_path hint disambiguates the two 'authenticate' methods per #470.
        const result = await backend.callTool('impact', {
          target: 'authenticate',
          file_path: 'src/auth.ts',
          direction: 'downstream',
          relationTypes: ['OVERRIDES'],
        });
        expect(result).not.toHaveProperty('error');
        expect(result.status).not.toBe('ambiguous');
        expect(result.impactedCount).toBeGreaterThanOrEqual(1);
        const d1 = result.byDepth[1] || result.byDepth['1'] || [];
        const names = d1.map((d: any) => d.name);
        expect(names).toContain('authenticate');
      });

      it('does not return HAS_METHOD results when filtering by CALLS only', async () => {
        const result = await backend.callTool('impact', {
          target: 'AuthService',
          direction: 'downstream',
          relationTypes: ['CALLS'],
        });
        expect(result).not.toHaveProperty('error');
        // AuthService has no outgoing CALLS edges, only HAS_METHOD
        expect(result.impactedCount).toBe(0);
      });
    });

    describe('tool parameter edge cases', () => {
      let backend: LocalBackend;

      beforeAll(async () => {
        const ext = handle as typeof handle & { _backend?: LocalBackend };
        if (!ext._backend) {
          throw new Error(
            'LocalBackend not initialized — afterSetup did not attach _backend to handle',
          );
        }
        backend = ext._backend;
      });

      it('context tool returns error for nonexistent symbol', async () => {
        const result = await backend.callTool('context', { name: 'nonexistent_xyz_symbol_999' });
        expect(result).toHaveProperty('error');
        expect(result.error).toMatch(/not found/i);
      });

      it('query tool returns error for empty query', async () => {
        const result = await backend.callTool('query', { query: '' });
        expect(result).toHaveProperty('error');
        expect(result.error).toMatch(/required/i);
      });

      it('query tool returns error for missing query param', async () => {
        const result = await backend.callTool('query', {});
        expect(result).toHaveProperty('error');
      });

      it('cypher tool returns error for invalid Cypher syntax', async () => {
        const result = await backend.callTool('cypher', {
          query: 'THIS IS NOT VALID CYPHER AT ALL',
        });
        expect(result).toHaveProperty('error');
      });

      it('context tool returns error when no name or uid provided', async () => {
        const result = await backend.callTool('context', {});
        expect(result).toHaveProperty('error');
        expect(result.error).toMatch(/required/i);
      });

      // ─── impact error handling tests (#321) ───────────────────────────
      // Verify that impact() returns structured JSON instead of crashing

      it('impact tool returns structured error for unknown symbol', async () => {
        const result = await backend.callTool('impact', {
          target: 'nonexistent_symbol_xyz_999',
          direction: 'upstream',
        });
        // Must return structured JSON, not throw
        expect(result).toBeDefined();
        // Should have either an error field (not found) or impactedCount 0
        // Either outcome is valid — the key is it doesn't crash
        if (result.error) {
          expect(typeof result.error).toBe('string');
        } else {
          expect(result.impactedCount).toBe(0);
        }
      });

      it('impact error response has consistent target shape', async () => {
        const result = await backend.callTool('impact', {
          target: 'nonexistent_symbol_xyz_999',
          direction: 'downstream',
        });
        // When an error is returned, target must be an object (not raw string)
        // so downstream API consumers can safely access result.target.name
        if (result.error && result.target !== undefined) {
          expect(typeof result.target).toBe('object');
          expect(result.target).not.toBeNull();
        }
      });

      it('impact partial results: traversalComplete flag when depth fails', async () => {
        // Even if traversal fails at some depth, partial results should be returned
        // and partial:true should only be set when some results were collected
        const result = await backend.callTool('impact', {
          target: 'validate',
          direction: 'upstream',
          maxDepth: 10, // Large depth to trigger multi-level traversal
        });
        // Should succeed (validate exists in seed data)
        expect(result).not.toHaveProperty('error');
        if (result.partial) {
          // If partial, must still have some results
          expect(result.impactedCount).toBeGreaterThan(0);
        }
      });
    });

    // ─── impact disambiguation + label-scoped resolution (#1907) ─────────
    // Covers the disambiguation surface the CLI --uid/--file/--kind flags
    // wire through to, and guards the label-scoped resolver against the
    // binder failure that motivated the fix.
    describe('impact disambiguation (#1907)', () => {
      let backend: LocalBackend;

      beforeAll(async () => {
        const ext = handle as typeof handle & { _backend?: LocalBackend };
        if (!ext._backend) {
          throw new Error(
            'LocalBackend not initialized — afterSetup did not attach _backend to handle',
          );
        }
        backend = ext._backend;
      });

      it('reports an ambiguous target with disambiguation guidance', async () => {
        // Two Methods named 'authenticate' (AuthService + BaseService).
        const result = await backend.callTool('impact', {
          target: 'authenticate',
          direction: 'upstream',
        });
        expect(result).not.toHaveProperty('error');
        expect(result.status).toBe('ambiguous');
        expect(result.message).toMatch(/disambiguate/i);
        const uids = (result.candidates ?? []).map((c: any) => c.uid);
        expect(uids).toContain('method:AuthService.authenticate');
        expect(uids).toContain('method:BaseService.authenticate');
      });

      it('resolves the ambiguous target via target_uid (the --uid flag path)', async () => {
        const result = await backend.callTool('impact', {
          target: 'authenticate',
          target_uid: 'method:BaseService.authenticate',
          direction: 'upstream',
        });
        expect(result).not.toHaveProperty('error');
        expect(result.status).not.toBe('ambiguous');
        // target_uid selects the exact symbol, bypassing the name ranker.
        expect(result.target?.id).toBe('method:BaseService.authenticate');
        expect(result.target?.filePath).toBe('src/base.ts');
      });

      it('resolves the ambiguous target via file_path (the --file flag path)', async () => {
        const result = await backend.callTool('impact', {
          target: 'authenticate',
          file_path: 'src/base.ts',
          direction: 'upstream',
        });
        expect(result).not.toHaveProperty('error');
        expect(result.status).not.toBe('ambiguous');
        expect(result.target?.id).toBe('method:BaseService.authenticate');
      });

      it('does not crash when a name collides across symbol and non-symbol labels', async () => {
        // 'alpha' exists as both a Function and a Tool sharing src/tools.py.
        // The Tool node table has no startLine/endLine columns, so the
        // resolver's `RETURN n.startLine` projection only binds because the
        // candidate set also contains a label that *does* have those columns
        // (lenient multi-table binding). This guards that the disambiguation
        // path keeps tolerating non-symbol node types — and would catch a
        // future naive label-scoping that reintroduces the #1907 binder error
        // ("Cannot find property … for n") by matching property-poor tables
        // in isolation.
        const result = await backend.callTool('impact', {
          target: 'alpha',
          direction: 'upstream',
        });
        expect(result).not.toHaveProperty('error');
        expect(result.status).toBe('ambiguous');
        const uids = (result.candidates ?? []).map((c: any) => c.uid);
        expect(uids).toContain('func:alpha');
        expect(uids).toContain('Tool:alpha');
      });

      it('context resolves the same cross-label collision without crashing', async () => {
        const result = await backend.callTool('context', { name: 'alpha' });
        expect(result).not.toHaveProperty('error');
        expect(result.status).toBe('ambiguous');
        const uids = (result.candidates ?? []).map((c: any) => c.uid);
        expect(uids).toContain('func:alpha');
        // Assert the non-symbol Tool node stays in the candidate set, not just
        // that nothing crashed — a regression that silently dropped Tool from
        // the lenient-binding match would otherwise pass the non-crash check.
        expect(uids).toContain('Tool:alpha');
      });

      it('ranks the kind-matching candidate first when kind is supplied (the --kind flag path)', async () => {
        // 'alpha' is both a Function (func:alpha) and a Tool (Tool:alpha).
        // kind only adds +0.20 in scoreCandidate, so 0.50 + 0.20 = 0.70 stays
        // below the 0.95 confident-resolution threshold — the response is still
        // ambiguous. What kind buys is ranking: the Function is promoted above
        // the non-matching Tool. This exercises the scoreCandidate kind branch
        // against a real DB rather than only through the mocked CLI unit test.
        const result = await backend.callTool('impact', {
          target: 'alpha',
          kind: 'Function',
          direction: 'upstream',
        });
        expect(result).not.toHaveProperty('error');
        expect(result.status).toBe('ambiguous');
        const candidates = result.candidates ?? [];
        expect(candidates[0]?.uid).toBe('func:alpha');
        expect(candidates[0]?.kind).toBe('Function');
        const tool = candidates.find((c: any) => c.uid === 'Tool:alpha');
        expect(candidates[0]?.score).toBeGreaterThan(tool?.score);
      });
    });
  },
  {
    seed: LOCAL_BACKEND_SEED_DATA,
    ftsIndexes: LOCAL_BACKEND_FTS_INDEXES,
    poolAdapter: true,
    afterSetup: async (handle) => {
      // Configure listRegisteredRepos mock with handle values
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'test-repo',
          path: '/test/repo',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc123',
          stats: { files: 2, nodes: 3, communities: 1, processes: 1 },
        },
      ]);

      const backend = new LocalBackend();
      await backend.init();
      // Stash backend on handle so tests can access it
      (handle as any)._backend = backend;
    },
  },
);

// ─── impact BFS bound parameters (#1907 review F5) ───────────────────────
// Isolated DB (not the shared seed) with a frontier node whose id contains a
// single quote. Under the old string-interpolated query this id had to be
// hand-escaped; the parameterized query (executeParameterized with bound
// $frontierIds/$relTypes) carries it as data. Guards that a quote-bearing id
// traverses without a Prepare/parser error, and that a no-caller symbol
// returns an empty result rather than erroring.
withTestLbugDB(
  'local-backend-impact-param',
  (handle) => {
    describe('impact BFS bound parameters (#1907 F5)', () => {
      let backend: LocalBackend;

      beforeAll(() => {
        const ext = handle as typeof handle & { _backend?: LocalBackend };
        if (!ext._backend) {
          throw new Error('LocalBackend not initialized — afterSetup did not attach _backend');
        }
        backend = ext._backend;
      });

      it('traverses a caller whose id contains a single quote without a query error', async () => {
        const result = await backend.callTool('impact', { target: 'sink', direction: 'upstream' });
        expect(result).not.toHaveProperty('error');
        const d1 = result.byDepth?.[1] || result.byDepth?.['1'] || [];
        const callerIds = d1.map((d: any) => d.uid ?? d.id);
        expect(callerIds).toContain("func:o'd");
      });

      it('returns an empty result (not an error) for a symbol with no callers', async () => {
        const result = await backend.callTool('impact', {
          target: 'sink',
          direction: 'downstream',
        });
        expect(result).not.toHaveProperty('error');
        expect(result.impactedCount).toBe(0);
      });
    });
  },
  {
    seed: [
      `CREATE (a:Function {id: "func:o'd", name: 'odd', filePath: 'src/q.ts', startLine: 1, endLine: 3, isExported: true, content: 'function odd() {}', description: 'caller with a quote in its id'})`,
      `CREATE (b:Function {id: 'func:sink', name: 'sink', filePath: 'src/q.ts', startLine: 5, endLine: 8, isExported: true, content: 'function sink() {}', description: 'callee'})`,
      `MATCH (a:Function), (b:Function) WHERE a.id = "func:o'd" AND b.id = 'func:sink'
       CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 1.0, reason: 'direct', step: 0}]->(b)`,
    ],
    poolAdapter: true,
    afterSetup: async (handle) => {
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'param-repo',
          path: '/param/repo',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc123',
          stats: { files: 1, nodes: 2, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as any)._backend = backend;
    },
  },
);
