/**
 * Integration Tests: MCP `explain` tool (#2083 M3 U6)
 *
 * End-to-end against a REAL LadybugDB: the pdg-repo fixture is indexed by the
 * real pipeline with `--pdg` (workers — requires `node scripts/build.js`), the
 * resulting BasicBlock nodes + TAINTED/SANITIZES edges and the fixture's
 * Function symbols are persisted into the test DB, and `explain` is exercised
 * through the full `callTool` dispatch:
 *
 * - anchorless enumerate (≥1 finding, decoded hops, deterministic order)
 * - anchored by file and by symbol (line-span granularity)
 * - sanitized-only function → zero TAINTED findings (its safety evidence is
 *   the SANITIZES edge, not part of explain's response)
 * - unknown symbol → context()-style not-found
 * - a repo WITHOUT the taint layer → the "no taint layer" note, not an error
 *
 * Seeding via the real emit output (not hand-written rows) pins the format
 * compatibility between U4's write path and U6's read path — id template,
 * `;<kind>` reason header, hop encoding.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos, loadMeta } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { decodeTaintPath } from '../../src/core/ingestion/taint/path-codec.js';

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/repo-manager.js')>();
  return {
    ...actual,
    listRegisteredRepos: vi.fn().mockResolvedValue([]),
    cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
    findSiblingClones: vi.fn().mockResolvedValue([]),
    // No meta.json exists for the seeded test DB — explain's meta probe must
    // degrade to the TAINTED-row existence probe (the seeded-DB reality).
    loadMeta: vi.fn().mockResolvedValue(null),
  };
});

const FIXTURE = path.join(__dirname, 'cfg', 'fixtures', 'pdg-repo');

describe('TS/JS taint model sink disambiguation — real pipeline', () => {
  it('emits findings only for the intended imported/receiver-conventional sinks', async () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-taint-disambig-'));
    try {
      fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(repoDir, 'src', 'app.ts'),
        `import { execFile as childExecFile, spawnSync } from 'node:child_process';

function execFile(cmd: string, args: string[]) {
  return { cmd, args };
}

export function handle(req: any, db: any, map: Map<string, string>, task: any, res: any, out: any) {
  const value = req.body;
  childExecFile('git', [value]);
  spawnSync(value, []);
  execFile(value, [value]);
  db.run(value);
  map.get(value);
  task.run(value);
  res.render(value, {});
  out.render(value, {});
}
`,
      );

      const result = await runPipelineFromRepo(repoDir, () => {}, { pdg: true });
      const findings = [...result.graph.iterRelationships()]
        .filter((rel) => rel.type === 'TAINTED')
        .map((rel) => {
          const sink = result.graph.getNode(rel.targetId);
          const decoded = decodeTaintPath(rel.reason);
          if (!decoded.ok) {
            throw new Error(`invalid TAINTED reason for ${rel.id}: ${decoded.error}`);
          }
          return {
            kind: decoded.kind,
            sinkLine: decoded.hops.at(-1)?.line,
            sinkText: String(sink?.properties.text ?? ''),
          };
        });

      expect(findings.map((f) => f.kind).sort()).toEqual([
        'command-injection',
        'command-injection',
        'sql-injection',
        'xss',
      ]);
      const findingSites = findings
        .map((f) => `${f.kind}@${f.sinkLine}`)
        .sort((a, b) => Number(a.split('@')[1]) - Number(b.split('@')[1]));
      expect(findingSites).toEqual([
        'command-injection@9',
        'command-injection@10',
        'sql-injection@12',
        'xss@15',
      ]);
      expect(findings.map((f) => f.sinkLine).sort((a, b) => Number(a) - Number(b))).not.toContain(
        11,
      );
      expect(findings.map((f) => f.sinkLine).sort((a, b) => Number(a) - Number(b))).not.toContain(
        13,
      );
      expect(findings.map((f) => f.sinkLine).sort((a, b) => Number(a) - Number(b))).not.toContain(
        14,
      );
      expect(findings.map((f) => f.sinkLine).sort((a, b) => Number(a) - Number(b))).not.toContain(
        16,
      );
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

// ─── Block 1: a --pdg index with real taint findings ─────────────────

withTestLbugDB(
  'taint-explain',
  (handle) => {
    describe('explain tool against a --pdg index', () => {
      let backend: LocalBackend;

      beforeAll(() => {
        const ext = handle as typeof handle & { _backend?: LocalBackend };
        if (!ext._backend) {
          throw new Error(
            'LocalBackend not initialized — afterSetup did not attach _backend to handle',
          );
        }
        backend = ext._backend;
      });

      it('anchorless explain enumerates the persisted findings with decoded hops', async () => {
        const result = await backend.callTool('explain', {});
        expect(result).not.toHaveProperty('error');
        expect(result.totalFindings).toBeGreaterThanOrEqual(1);
        expect(result.findings.length).toBeGreaterThanOrEqual(1);
        expect(result.truncated).toBeUndefined();
        // The vulnerable flow: req.body → cmd → exec(cmd) in vuln.ts.
        const vuln = result.findings.find((f: any) => f.file.endsWith('vuln.ts'));
        expect(vuln).toBeDefined();
        expect(vuln.sinkKind).toBe('command-injection');
        expect(vuln.functionLine).toBe(9); // runUserCommand's start line
        // Ordered hops with the variable carried on each hop (AC3): seed def
        // (cmd @ const line 10) → sink use (cmd @ exec line 11).
        expect(vuln.hops.map((h: any) => `${h.variable}@${h.line}`)).toEqual(['cmd@10', 'cmd@11']);
        expect(vuln.source).toEqual({ variable: 'cmd', line: 10 });
        expect(vuln.sink).toEqual({ line: 11 });
        expect(vuln.pathIncomplete).toBeUndefined();
        // The intra-procedural contract caveat reaches the consumer.
        expect(result.note).toMatch(/intra-procedural/i);
      });

      it('anchorless enumerate is deterministic across calls', async () => {
        const a = await backend.callTool('explain', {});
        const b = await backend.callTool('explain', {});
        expect(a).toEqual(b);
      });

      it('anchored by file path returns the finding (suffix match accepted)', async () => {
        for (const target of ['vuln.ts']) {
          const result = await backend.callTool('explain', { target });
          expect(result).not.toHaveProperty('error');
          expect(result.anchor).toEqual({ file: target });
          expect(result.findings.length).toBeGreaterThanOrEqual(1);
          for (const f of result.findings) expect(f.file.endsWith('vuln.ts')).toBe(true);
        }
      });

      it('anchored by an unrelated file returns zero findings (repo HAS the layer — no note about it)', async () => {
        const result = await backend.callTool('explain', { target: 'sample.ts' });
        expect(result).not.toHaveProperty('error');
        expect(result.findings).toEqual([]);
        expect(result.totalFindings).toBe(0);
        // The repo has TAINTED rows, so the "no taint layer" hint must NOT fire.
        expect(result.note ?? '').not.toMatch(/no taint layer/i);
      });

      it('anchored by the vulnerable function name returns full hop detail', async () => {
        const result = await backend.callTool('explain', { target: 'runUserCommand' });
        expect(result).not.toHaveProperty('error');
        expect(result.anchor.symbol).toBe('runUserCommand');
        expect(result.findings).toHaveLength(1);
        expect(result.totalFindings).toBe(1);
        const f = result.findings[0];
        expect(f.sinkKind).toBe('command-injection');
        expect(f.hops.map((h: any) => h.variable)).toEqual(['cmd', 'cmd']);
      });

      it('the sanitized-only function returns no TAINTED finding', async () => {
        const result = await backend.callTool('explain', { target: 'sendEncoded' });
        expect(result).not.toHaveProperty('error');
        expect(result.anchor.symbol).toBe('sendEncoded');
        expect(result.findings).toEqual([]);
        expect(result.totalFindings).toBe(0);
      });

      it('an unknown symbol target mirrors context() not-found semantics', async () => {
        const result = await backend.callTool('explain', { target: 'nonexistentTaintFn999' });
        expect(result).toHaveProperty('error');
        expect(result.error).toMatch(/not found/i);
      });

      it('a dotted symbol name resolves as a symbol, not a silent file miss', async () => {
        // Regression: `Class.method` was classified as a file (the `.method`
        // extension-like suffix) and returned a silent empty file-anchored
        // result. It must now route to symbol resolution — here, not-found.
        const result = await backend.callTool('explain', { target: 'UserController.create' });
        expect(result).toHaveProperty('error');
        expect(result.error).toMatch(/not found/i);
        // Must NOT be a silent file-anchored empty result.
        expect(result.anchor).toBeUndefined();
      });

      it('a dotted symbol whose tail looks bare still resolves as a symbol', async () => {
        // `runUserCommand` is a real fixture symbol; a dotted lead-in that does
        // not match any symbol confirms the symbol branch (not file routing).
        const result = await backend.callTool('explain', { target: 'Service.runUserCommand' });
        expect(result).toHaveProperty('error');
        expect(result.error).toMatch(/not found/i);
      });

      it('rejects an out-of-bounds limit with a clear error', async () => {
        // Includes the non-integer / non-finite / non-numeric cases the
        // interpolated `LIMIT ${limit}` depends on the guard rejecting.
        for (const limit of [0, -1, 1.5, 10_000, NaN, Infinity, -Infinity, '50']) {
          const result = await backend.callTool('explain', { limit });
          expect(result).toHaveProperty('error');
          expect(result.error).toMatch(/limit/i);
        }
      });

      it('limit pages the enumerate and reports truncation honestly', async () => {
        const all = await backend.callTool('explain', {});
        const page = await backend.callTool('explain', { limit: 1 });
        expect(page.findings).toHaveLength(Math.min(1, all.totalFindings));
        expect(page.totalFindings).toBe(all.totalFindings);
        if (all.totalFindings > 1) {
          expect(page.truncated).toBe(true);
          // Deterministic order: the page is a prefix of the full enumerate.
          expect(page.findings[0]).toEqual(all.findings[0]);
        }
      });
    });
  },
  {
    poolAdapter: true,
    afterSetup: async (handle) => {
      // 1. Index the pdg-repo fixture with the REAL pipeline (--pdg on).
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-explain-'));
      try {
        fs.cpSync(FIXTURE, repoDir, { recursive: true });
        const pipelineResult = await runPipelineFromRepo(repoDir, () => {}, { pdg: true });

        // 2. Persist the emit output into the test DB: BasicBlock nodes,
        //    TAINTED/SANITIZES edges, and the Function symbols (for the
        //    symbol-anchored path through resolveSymbolCandidates).
        const adapter = await import('../../src/core/lbug/lbug-adapter.js');
        const nodes: Array<{ label: string; props: Record<string, unknown> }> = [];
        pipelineResult.graph.forEachNode((n) => {
          if (n.label === 'BasicBlock') {
            nodes.push({
              label: 'BasicBlock',
              props: {
                id: n.id,
                filePath: n.properties.filePath ?? '',
                startLine: n.properties.startLine ?? 0,
                endLine: n.properties.endLine ?? 0,
                text: n.properties.text ?? '',
              },
            });
          } else if (n.label === 'Function') {
            nodes.push({
              label: 'Function',
              props: {
                id: n.id,
                name: n.properties.name ?? '',
                filePath: n.properties.filePath ?? '',
                startLine: n.properties.startLine ?? 0,
                endLine: n.properties.endLine ?? 0,
              },
            });
          }
        });
        for (const node of nodes) {
          const assignments = Object.keys(node.props)
            .map((k) => `${k}: $${k}`)
            .join(', ');
          await adapter.executePrepared(
            `CREATE (n:${node.label} {${assignments}})`,
            node.props as Record<string, any>,
          );
        }
        let taintEdges = 0;
        for (const rel of pipelineResult.graph.iterRelationships()) {
          if (rel.type !== 'TAINTED' && rel.type !== 'SANITIZES') continue;
          await adapter.executePrepared(
            `MATCH (a:BasicBlock {id: $src}), (b:BasicBlock {id: $dst})
             CREATE (a)-[:CodeRelation {type: '${rel.type}', confidence: $confidence, reason: $reason, step: 0}]->(b)`,
            {
              src: rel.sourceId,
              dst: rel.targetId,
              confidence: rel.confidence ?? 1.0,
              reason: rel.reason ?? '',
            },
          );
          taintEdges++;
        }
        if (taintEdges === 0) {
          throw new Error('fixture produced no TAINTED/SANITIZES edges — taint emit regressed?');
        }
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }

      // 3. Register the test DB and boot the backend (calltool harness shape).
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'taint-repo',
          path: '/taint/repo',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc123',
          stats: { files: 2, nodes: 4, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as any)._backend = backend;
    },
  },
);

// ─── Block 2: a repo indexed WITHOUT --pdg ───────────────────────────

withTestLbugDB(
  'taint-explain-nopdg',
  (handle) => {
    describe('explain tool without a taint layer', () => {
      let backend: LocalBackend;

      beforeAll(() => {
        const ext = handle as typeof handle & { _backend?: LocalBackend };
        if (!ext._backend) {
          throw new Error(
            'LocalBackend not initialized — afterSetup did not attach _backend to handle',
          );
        }
        backend = ext._backend;
      });

      it('returns the no-taint-layer note via the row-existence probe (meta unreadable)', async () => {
        const result = await backend.callTool('explain', {});
        expect(result).not.toHaveProperty('error');
        expect(result.findings).toEqual([]);
        expect(result.totalFindings).toBe(0);
        expect(result.note).toMatch(/no taint layer/i);
        expect(result.note).toContain('--pdg');
      });

      it('an anchored call also reports the missing layer, not a bogus empty result', async () => {
        const result = await backend.callTool('explain', { target: 'plain.ts' });
        expect(result).not.toHaveProperty('error');
        expect(result.findings).toEqual([]);
        expect(result.note).toMatch(/no taint layer/i);
      });

      it('returns the note via the RepoMeta.pdg probe when meta is readable but unstamped', async () => {
        // A readable meta WITHOUT a pdg stamp short-circuits before any
        // block-space query (the #2099 F1 presence ≡ layer-exists contract).
        vi.mocked(loadMeta).mockResolvedValueOnce({} as any);
        const result = await backend.callTool('explain', {});
        expect(result.findings).toEqual([]);
        expect(result.totalFindings).toBe(0);
        expect(result.note).toMatch(/no taint layer/i);
      });

      it('an M1/M2-era pdg stamp (no taintModelVersion) reports the missing taint layer', async () => {
        // The pdg stamp exists (BasicBlock/REACHING_DEF were recorded) but
        // taint never ran — no taintModelVersion. The taint-layer probe must
        // gate on taintModelVersion, not generic pdg presence, so this surfaces
        // the actionable "run analyze" hint instead of a bare empty result.
        vi.mocked(loadMeta).mockResolvedValueOnce({
          pdg: { mode: 'on', maxFunctionLines: 2000 },
        } as any);
        const result = await backend.callTool('explain', {});
        expect(result.findings).toEqual([]);
        expect(result.totalFindings).toBe(0);
        expect(result.note).toMatch(/no taint layer/i);
      });
    });
  },
  {
    seed: [
      `CREATE (fn:Function {id: 'func:plainFn', name: 'plainFn', filePath: 'src/plain.ts', startLine: 1, endLine: 5, isExported: true, content: 'function plainFn() {}', description: 'no taint layer here'})`,
    ],
    poolAdapter: true,
    afterSetup: async (handle) => {
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'plain-repo',
          path: '/plain/repo',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'def456',
          stats: { files: 1, nodes: 1, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as any)._backend = backend;
    },
  },
);

// ─── Block 3: interprocedural TAINT_PATH findings (#2084 M4 U7) ───────
//
// Seeds the cross-file interproc-repo fixture's emit output (Function nodes +
// TAINT_PATH edges) into a real DB and proves `explain` surfaces the
// cross-function findings (marked `interprocedural: true`) with decoded
// function-level hops + the sink kind.

const INTERPROC_FIXTURE = path.join(__dirname, 'cfg', 'fixtures', 'interproc-repo');

withTestLbugDB(
  'taint-explain-interproc',
  (handle) => {
    describe('explain tool — cross-function TAINT_PATH findings', () => {
      let backend: LocalBackend;
      beforeAll(() => {
        const ext = handle as typeof handle & { _backend?: LocalBackend };
        if (!ext._backend) throw new Error('LocalBackend not initialized');
        backend = ext._backend;
      });

      it('anchorless enumerate includes interprocedural findings', async () => {
        const res = (await backend.callTool('explain', {})) as {
          findings: Array<Record<string, unknown>>;
        };
        const ip = res.findings.filter((f) => f.interprocedural === true);
        expect(ip.length).toBeGreaterThan(0);
        // handle → runIt, command-injection, with function-level hops.
        const hr = ip.find(
          (f) =>
            (f.source as { function?: string })?.function === 'handle' &&
            (f.sink as { function?: string })?.function === 'runIt',
        );
        expect(hr, 'expected an interprocedural handle → runIt finding').toBeDefined();
        expect(hr!.sinkKind).toBe('command-injection');
        expect(Array.isArray(hr!.hops)).toBe(true);
        expect((hr!.hops as unknown[]).length).toBeGreaterThan(0);
      });

      it('symbol-anchored on the sink function surfaces the cross-function finding', async () => {
        const res = (await backend.callTool('explain', { target: 'runIt' })) as {
          findings: Array<Record<string, unknown>>;
        };
        const ip = res.findings.filter((f) => f.interprocedural === true);
        expect(ip.some((f) => (f.sink as { function?: string })?.function === 'runIt')).toBe(true);
      });

      it('totalFindings counts the full interproc layer and truncated is set on overflow (#2084 review P2-4)', async () => {
        // The fixture yields multiple interproc findings; limit:1 must page to 1
        // while totalFindings reports the true (un-capped) count and truncated is set.
        const full = (await backend.callTool('explain', {})) as {
          findings: unknown[];
          totalFindings: number;
        };
        const ipFull = full.findings.filter((f: any) => f.interprocedural === true).length;
        expect(ipFull).toBeGreaterThan(1);

        const paged = (await backend.callTool('explain', { limit: 1 })) as {
          findings: unknown[];
          totalFindings: number;
          truncated?: boolean;
        };
        expect(paged.findings.length).toBe(1);
        expect(paged.truncated).toBe(true);
        // totalFindings reflects the real interproc total, not the 1-row slice.
        expect(paged.totalFindings).toBeGreaterThanOrEqual(ipFull);
      });
    });
  },
  {
    poolAdapter: true,
    afterSetup: async (handle) => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-explain-ip-'));
      try {
        fs.cpSync(INTERPROC_FIXTURE, repoDir, { recursive: true });
        const pipelineResult = await runPipelineFromRepo(repoDir, () => {}, { pdg: true });
        const adapter = await import('../../src/core/lbug/lbug-adapter.js');

        // Persist Function/Method nodes (TAINT_PATH endpoints).
        const seenIds = new Set<string>();
        pipelineResult.graph.forEachNode((n) => {
          if (n.label !== 'Function' && n.label !== 'Method') return;
          if (seenIds.has(n.id)) return;
          seenIds.add(n.id);
        });
        for (const n of pipelineResult.graph.iterNodes()) {
          if (n.label !== 'Function' && n.label !== 'Method') continue;
          await adapter.executePrepared(
            `CREATE (x:${n.label} {id: $id, name: $name, filePath: $filePath, startLine: $startLine, endLine: $endLine})`,
            {
              id: n.id,
              name: n.properties.name ?? '',
              filePath: n.properties.filePath ?? '',
              startLine: n.properties.startLine ?? 0,
              endLine: n.properties.endLine ?? 0,
            },
          );
        }
        let tpEdges = 0;
        for (const rel of pipelineResult.graph.iterRelationships()) {
          if (rel.type !== 'TAINT_PATH') continue;
          await adapter.executePrepared(
            // The fixture's endpoints are all top-level Function nodes; Kuzu
            // rejects an untyped node match in a rel CREATE (read MATCH is fine).
            `MATCH (a:Function {id: $src}), (b:Function {id: $dst})
             CREATE (a)-[:CodeRelation {type: 'TAINT_PATH', confidence: $confidence, reason: $reason, step: 0}]->(b)`,
            {
              src: rel.sourceId,
              dst: rel.targetId,
              confidence: rel.confidence ?? 0.6,
              reason: rel.reason ?? '',
            },
          );
          tpEdges++;
        }
        if (tpEdges === 0) {
          throw new Error('interproc fixture produced no TAINT_PATH edges — fixpoint regressed?');
        }
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'interproc-repo',
          path: '/interproc/repo',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'ip0001',
          stats: { files: 2, nodes: 4, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as any)._backend = backend;
    },
  },
);

// ─── Block 4: symbol-anchor window correctness (#2188 _explainImpl off-by-one) ──
//
// Hand-seeded with controlled line numbers (no parser dependency). `tailFn`
// occupies 0-based symbol lines 10–14, so its BasicBlocks land on 1-based lines
// 11–15 and the correct anchor window is [symStart+1, symEnd+1] = [11,15]. The
// pre-fix _explainImpl used [symStart, symEnd] = [10,14], which both DROPPED a
// taint source on the function's final line (1-based 15) and LEAKED a neighbor's
// block on the line directly above (1-based 10). One query proves both bounds —
// and FAILS on the pre-fix window (it would return the line-10 neighbor instead).

withTestLbugDB(
  'taint-explain-anchor-window',
  (handle) => {
    describe('explain symbol anchoring (#2188 [symStart+1, symEnd+1] window)', () => {
      let backend: LocalBackend;
      beforeAll(() => {
        const ext = handle as typeof handle & { _backend?: LocalBackend };
        if (!ext._backend) throw new Error('LocalBackend not initialized');
        backend = ext._backend;
      });

      it('includes the final-line taint source and excludes the neighbor-above block', async () => {
        const result = (await backend.callTool('explain', { target: 'tailFn' })) as {
          findings: Array<{ source?: { line?: number } }>;
          error?: string;
        };
        expect(result).not.toHaveProperty('error');
        // Only tailFn's own final-line (1-based 15) taint source survives; the
        // neighbor's line-10 block is below the [11,15] window (lower-bound +1).
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0].source?.line).toBe(15);
        expect(result.findings.some((f) => f.source?.line === 10)).toBe(false);
      });
    });
  },
  {
    poolAdapter: true,
    afterSetup: async (handle) => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      // tailFn: 0-based span 10–14 ⇒ 1-based blocks on 11–15, window [11,15].
      await adapter.executePrepared(
        `CREATE (fn:Function {id: 'func:tailFn', name: 'tailFn', filePath: 'anchor.ts', startLine: 10, endLine: 14, isExported: true, content: 'function tailFn() {}', description: 'anchor-window regression'})`,
        {},
      );
      const block = (id: string, startLine: number, text: string) =>
        adapter.executePrepared(
          `CREATE (b:BasicBlock {id: $id, filePath: 'anchor.ts', startLine: $startLine, endLine: $startLine, text: $text})`,
          { id, startLine, text },
        );
      // tailFn's source/sink on its FINAL line (1-based 15 = endLine 14 + 1).
      await block('BasicBlock:anchor.ts:11:0:5', 15, 'const x = req.body;');
      await block('BasicBlock:anchor.ts:11:0:6', 15, 'exec(x);');
      // a neighbor function's block on the line directly ABOVE tailFn (1-based 10).
      await block('BasicBlock:anchor.ts:9:0:0', 10, 'const y = other();');
      await block('BasicBlock:anchor.ts:9:0:1', 10, 'use(y);');
      const tainted = (src: string, dst: string, reason: string) =>
        adapter.executePrepared(
          `MATCH (a:BasicBlock {id: $src}), (b:BasicBlock {id: $dst})
           CREATE (a)-[:CodeRelation {type: 'TAINTED', confidence: 1.0, reason: $reason, step: 0}]->(b)`,
          { src, dst, reason },
        );
      await tainted('BasicBlock:anchor.ts:11:0:5', 'BasicBlock:anchor.ts:11:0:6', 'tail');
      await tainted('BasicBlock:anchor.ts:9:0:0', 'BasicBlock:anchor.ts:9:0:1', 'neighbor');

      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'anchor-repo',
          path: '/anchor/repo',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'aw0001',
          stats: { files: 1, nodes: 5, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as any)._backend = backend;
    },
  },
);
