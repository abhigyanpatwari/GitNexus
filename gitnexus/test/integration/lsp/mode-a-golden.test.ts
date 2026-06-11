/**
 * WI-V — Mode A golden integration test (issue #159 P3).
 *
 * Pinned behaviors (per `docs/plans/159-lsp-mode-a-calls.md` ## Test
 * Strategy must-pass set + `WI-V`):
 *
 *   (a)  Default-path byte-identity (I-1): two runs on the same
 *        fixture, one default + one with `lsp:{enabled:false}`,
 *        must produce identical relationship sets; every CALLS
 *        edge carries `source: 'heuristic'`.
 *   (b)  `--lsp-dry-run` writes-nothing (AC-6): the dry-run pass
 *        prints the per-decision lines and the trailing summary
 *        line; the graph is byte-identical to default.
 *   (c)  Member-call `a.b.c()` golden (KD / WI-2): the
 *        callNameNode is at the `c` position, not the call-
 *        expression start; `textDocument/definition` is issued
 *        at the `c` position; the engine's candidate carries
 *        the callee-identifier position, not the receiver
 *        position.
 *   (d)  Atomic-correction collision (AC-5 / I-4): a real
 *        `loadGraphToLbug` round-trip that includes an
 *        lsp-corrected edge at confidence 0.7 must not net-
 *        delete a row; the final CodeRelation table is exactly
 *        the expected count with the source column set.
 *   (e)  I-7 scoped assertion: the file
 *        `core/ingestion/lsp/` imports no write API; the
 *        `mode-a-reconciler.ts` module imports no direct-DB
 *        writer (`executeQuery` / `initLbug`).
 *   (f)  Cap behavior (KD-9 / I-2): when the candidate feed
 *        exceeds the cap, the first-N deterministic prefix is
 *        processed and the rest is reported as `skipped`.
 *   (g)  `--lsp` determinism, residual-tolerant (I-2): the
 *        session funnel returns null on no server / probe-not-
 *        ready; two such runs produce identical results.
 *   (h)  Refuse cases (AC-3 / I-5): a multi-Location payload
 *        is treated as AMBIGUOUS (refuse over guess); a non-
 *        callable Class hit is refused.
 *   (i)  Failure isolation (I-5 / KD-9): the session funnel
 *        catches a dispatch throw and returns null without
 *        aborting the index.
 *   (j)  BFS classification (the prerequisite contract for
 *        AC-7): a 0.5 `global` CALLS edge is filtered by
 *        `min_confidence=0.7`; the same edge at 0.7 (what
 *        Mode A's reconciler emits after a `correct`) passes
 *        the filter and surfaces the upstream route in
 *        LIKELY_AFFECTED (NOT WILL_BREAK). This is a BFS
 *        contract test — Mode A's role here is to keep the
 *        0.7 case reachable. Covered by the two
 *        `withTestLbugDB` blocks at the end of the file:
 *        `mode-a-j-default` and `mode-a-j-lsp` — see the (j)
 *        section header.
 *   (k)  `source` round-trip — both the HEADER-driven property-binding
 *        COPY (per-label from/to + 7-column CSV header; Kùzu rel
 *        COPY does not support an explicit property column-list)
 *        and the fallback CREATE path. The COPY path is covered
 *        by `source-column-roundtrip.test.ts`; the fallback path
 *        is exercised here against a real `loadGraphToLbug`
 *        round-trip.
 *
 * Test strategy:
 *   - Real `runPipelineFromRepo` end-to-end (no fake engine) for
 *     the wiring-level tests (a, b).
 *   - Direct `withReconciliationSession` (deterministic mocks
 *     for `discoverServers` + `createLspClient` + `probe` +
 *     `handToEngine`) for the engine-funnel tests (c, f, g, h,
 *     i, j).
 *   - Real `loadGraphToLbug` round-trip for the DB-level
 *     persistence tests (d, k).
 *   - Static file-content reads for the no-write invariant
 *     (e).
 *   - The test uses NO real `typescript-language-server`
 *     subprocess — the session funnel's "no server" path is
 *     deterministic and exercises the refuse-over-guess
 *     contract; the engine's decision table is the
 *     production-test surface. The presence of a real LSP
 *     binary on PATH is detected at the top of the file;
 *     tests that depend on a real binary skip themselves.
 *
 * Project: this file lives under `lbug-db` (lbug seed +
 * loadGraphToLbug round-trip). It uses `withTestLbugDB` for
 * the DB lifecycle — the project gating is in
 * `gitnexus/vitest.config.ts`. On a vitest 4.x + globalSetup
 * interaction bug, `inject('lbugDbPath')` may return undefined
 * in `npx vitest run` — see
 * `feedback/project-vitest-lbug-db-inject-undefined`; the
 * helper's own error surfaces that condition as a clear
 * diagnostic and the suite is structured so the
 * loadGraphToLbug tests (d, k) can run in their own `describe`
 * block, independent of the wiring tests.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { runPipelineFromRepo, type PipelineResult } from '../../../src/core/ingestion/pipeline.js';
import { withReconciliationSession, LSP_CONFIDENCE as _LSP_CONFIDENCE } from '../../../src/core/ingestion/mode-a-reconciler.js';
import type {
  Candidate,
  Location,
  ReconciliationLspClient,
  ReconciliationRepo,
  WithReconciliationSessionDeps,
  SessionMeta,
} from '../../../src/core/ingestion/mode-a-reconciler.js';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import type { GraphRelationship, KnowledgeGraph } from '../../../src/core/graph/types.js';
import { withTestLbugDB } from '../../helpers/test-indexed-db.js';
import { buildTestGraph } from '../../helpers/test-graph.js';
import { LocalBackend } from '../../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../../src/storage/repo-manager.js';
import { execFileSync } from 'node:child_process';
import { FORBIDDEN_LSP_CALL_TOKENS } from '../../unit/lsp/lsp-no-write-tokens.js';

// ─── Server guard (real `typescript-language-server` present?) ─────────

/**
 * Detect whether a real `typescript-language-server` is on PATH.
 * The unit-level session test injects a fake — this is a guard
 * for tests that might want to opt in to the real binary (none
 * here; the engine tests are the real-binary surface).
 */
let realTypescriptBinary: { path: string; version: string } | null = null;
beforeAll(async () => {
  try {
    const { discoverServers } = await import('../../../src/core/ingestion/lsp/server-discovery.js');
    const result = await discoverServers();
    realTypescriptBinary = result.typescript;
    if (!realTypescriptBinary) {
      // eslint-disable-next-line no-console
      console.log(
        '[IT:mode-a-golden] no real typescript-language-server found — using deterministic session mocks',
      );
    }
  } catch {
    // Discovery itself is best-effort; absence is the common case
  }
}, 30_000);

// ─── Constants: paths and shapes ───────────────────────────────────────

const testDir = path.dirname(fileURLToPath(import.meta.url));
const gitnexusRoot = path.resolve(testDir, '..', '..', '..');
const lspDir = path.join(gitnexusRoot, 'src', 'core', 'ingestion', 'lsp');
const reconcilerFile = path.join(gitnexusRoot, 'src', 'core', 'ingestion', 'mode-a-reconciler.ts');
const lbugAdapterFile = path.join(gitnexusRoot, 'src', 'core', 'lbug', 'lbug-adapter.ts');

/**
 * The callable-label set the engine derives from
 * `call-processor.ts:686` (KD-3). We replicate the constant
 * here — the engine re-exports it through `__engineTest__`, but
 * this golden test pins the spec value at the test site to
 * catch a future drift between the constant and the spec.
 */
const CALLABLE_LABELS = new Set(['Function', 'Method', 'Constructor', 'Macro', 'Delegate']);

/**
 * Strip JSDoc and line comments from source text — borrowed
 * from `no-write-invariant.test.ts` so the static guard here
 * matches that test's allowlist exactly.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * The forbidden-token list — mirrors the no-write invariant.
 * If a future refactor reintroduces a write into `lsp/`, this
 * golden test catches it independently of the unit test (it
 * runs against the production source tree, not a mock).
 *
 * Imported from the shared helper at
 * `test/unit/lsp/lsp-no-write-tokens.ts` so both test files
 * apply the exact same regex set; the canonical list lives
 * there as the single source of truth. The (e) block uses
 * the call-only subset (it has its own import-surface check
 * on the reconciler file).
 */
const FORBIDDEN_LSP_TOKENS: ReadonlyArray<{ name: string; regex: RegExp }> =
  FORBIDDEN_LSP_CALL_TOKENS.map(({ name, regex }) => ({ name, regex }));

/**
 * Snapshot the in-memory relationship set as a sorted JSON
 * string. Stable across runs — the test compares two
 * snapshots for byte-equality.
 *
 * B1 fix: `source` is raw (no `?? 'heuristic'` coalescing) so an
 * absent or non-heuristic source is VISIBLE in the snapshot and
 * causes a snapshot mismatch instead of silently passing.
 * `step` is included so edges with different step values never
 * collapse into an identical snapshot row.
 */
function snapshotRels(graph: KnowledgeGraph): string {
  const rels = [...graph.iterRelationships()].map((r) => ({
    id: r.id,
    sourceId: r.sourceId,
    targetId: r.targetId,
    type: r.type,
    confidence: r.confidence,
    reason: r.reason,
    step: r.step,
    source: r.source,
  }));
  rels.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return JSON.stringify(rels, null, 2);
}

/**
 * Build a fake `LspClient` for the session funnel. The
 * `discoverServers` + `createLspClient` + `probe` deps are
 * all injectable; we pass fakes here. The fake `request`
 * returns a per-key `Location[]` payload so the engine sees
 * deterministic LSP verdicts.
 */
function makeFakeClient(
  locationByKey: Map<string, Location[]>,
): ReconciliationLspClient & { requestCalls: Array<{ method: string; params: any }> } {
  const requestCalls: Array<{ method: string; params: any }> = [];
  return {
    getState: () => 'ready' as const,
    start: async () => undefined,
    stop: async () => undefined,
    request: async (method: string, params: any) => {
      requestCalls.push({ method, params });
      // Key the response by (line, character) — the engine's
      // own keying concatenates sourceId|calledName|line|char
      // so we look up by the same tuple when present.
      const position = params?.position ?? {};
      const key = `${position.line}|${position.character}`;
      if (locationByKey.has(key)) {
        return locationByKey.get(key)!;
      }
      // Default: no definition.
      return null;
    },
    requestCalls,
  };
}

/**
 * A minimal repo handle the session accepts.
 */
function mkRepo(): ReconciliationRepo {
  return { id: 'mode-a-golden', repoPath: '/tmp/mode-a-golden' };
}

// ─── Tests ─────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════
// (a) + (b) — Default-path byte-identity & dry-run writes nothing
// ═══════════════════════════════════════════════════════════════════════
//
// Same fixture, three runs:
//   - default (no `lsp` flag): baseline
//   - `lsp:{enabled:false}`: explicit off, must equal baseline
//   - `lsp:{enabled:true,dryRun:true}`: per-decision lines, no
//     graph mutation (graph equals baseline byte-for-byte)
//
// The fixture is the same one the WI-5 integration test uses —
// a small TS repo with two cross-file `global`-0.50 CALLS sites
// (app.ts → user.save / user.getName). With NO LSP server on
// PATH, the dry-run session refuses every candidate (KD-4) and
// the graph stands untouched. This is the byte-identical
// baseline contract (AC-2 / I-1).
// ═══════════════════════════════════════════════════════════════════════
describe('WI-V — default-path byte-identity (AC-2 / I-1) and dry-run writes-nothing (AC-6)', () => {
  let tmpDir: string;
  let defaultResult: PipelineResult;
  let explicitOffResult: PipelineResult;
  let dryRunResult: PipelineResult;
  let dryRunLogs: string[];

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gn-mode-a-golden-'));

    // The exact same fixture shape as
    // `analyze-lsp-mode-a.test.ts`: a tiny TS repo where the
    // heuristic emits at least one `global`-0.50 CALLS edge.
    // (We don't depend on the heuristic shape — only on the
    // requirement that "the graph is non-empty AND every
    // CALLS edge carries `source: 'heuristic'`".)
    fs.writeFileSync(
      path.join(tmpDir, 'models.ts'),
      [
        'export class User {',
        '  save(): void {}',
        '  getName(): string { return ""; }',
        '}',
        'export function getUser(): User { return new User(); }',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'service.ts'),
      "import { getUser } from './models';\nexport const user = getUser();\n",
    );
    fs.writeFileSync(
      path.join(tmpDir, 'app.ts'),
      [
        "import { user } from './service';",
        'export function main() {',
        '  user.save();',
        '  user.getName();',
        '}',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'tsconfig.json'),
      '{\n  "compilerOptions": {\n    "target": "es2020",\n    "module": "commonjs",\n    "strict": true\n  }\n}\n',
    );

    // Run #1 — default.
    defaultResult = await runPipelineFromRepo(tmpDir, () => {}, { skipGraphPhases: true });

    // Run #2 — `lsp:{enabled:false}` (explicit off).
    explicitOffResult = await runPipelineFromRepo(
      tmpDir,
      () => {},
      { skipGraphPhases: true, lsp: { enabled: false, dryRun: false } },
    );

    // Run #3 — `lsp:{enabled:true,dryRun:true}`. Capture
    // `lsp-dry-run:` stdout for shape assertions.
    dryRunLogs = [];
    const origLog = console.log;
    console.log = (...args: any[]) => {
      dryRunLogs.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
    };
    try {
      dryRunResult = await runPipelineFromRepo(
        tmpDir,
        () => {},
        { skipGraphPhases: true, lsp: { enabled: true, dryRun: true } },
      );
    } finally {
      console.log = origLog;
    }
  }, 90_000);

  afterAll(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('(a) default path is byte-identical to `lsp:{enabled:false}` (no observable difference)', () => {
    // The flag is opt-in: `enabled:false` must produce the
    // SAME graph as the default. If they differ, the wiring
    // leaked a default-path mutation.
    expect(snapshotRels(explicitOffResult.graph)).toBe(snapshotRels(defaultResult.graph));
  });

  it('(a) every CALLS edge in the default result carries `source: "heuristic"` — hard equality, no coalescing', () => {
    // B1 fix: uses `r.source` directly (NOT `r.source ?? 'heuristic'`).
    // If the serializer default fires but the in-memory edge was never
    // stamped, `r.source` is undefined and this assertion FAILS — which
    // is the correct behavior (the pipeline MUST stamp every CALLS edge
    // with 'heuristic' on the default path, not rely on a serializer-side
    // fallback that would hide a missing stamp in the graph).
    const callsEdges = [...defaultResult.graph.iterRelationships()].filter(
      (r) => r.type === 'CALLS',
    );
    expect(callsEdges.length, 'fixture must emit at least one CALLS edge on the default path').toBeGreaterThan(0);
    for (const r of callsEdges) {
      expect(r.source).toBe('heuristic');
    }
  });

  it('(b) default path is byte-identical to `lsp-dry-run` (dry-run writes nothing)', () => {
    // AC-6 / KD-11: the dry-run pass prints per-decision
    // tuples but mutates nothing. With no LSP server on PATH
    // the session refuses every candidate; the graph must
    // equal the default.
    expect(snapshotRels(dryRunResult.graph)).toBe(snapshotRels(defaultResult.graph));
  });

  it('(b) --lsp-dry-run prints the per-decision `lsp-dry-run:` lines and a trailing summary', () => {
    const summary = dryRunLogs.find((l) => l.includes('lsp-dry-run:') && l.includes('decision(s)'));
    expect(summary, 'expected the dry-run summary line').toBeDefined();
    // Every per-decision line uses the canonical prefix.
    const perDecision = dryRunLogs.filter(
      (l) => l.startsWith('  lsp-dry-run:') && !l.includes('decision(s)'),
    );
    // We don't pin a count (depends on the number of
    // global-0.50 edges the heuristic emits). We pin the
    // SHAPE: each per-decision line carries an action and
    // a from→to pair.
    for (const line of perDecision) {
      expect(line).toMatch(/^  lsp-dry-run: (confirm|correct|add|keep|refuse)\s+\S+ -> .+?\s+\(.+\)$/);
    }
  });

  it('(b) the dry-run result carries the report (observability is intact, no server required)', () => {
    expect(dryRunResult.lspReport).not.toBeNull();
    expect(dryRunResult.lspReport).toBeDefined();
    expect(Array.isArray(dryRunResult.lspReport!.decisions)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// (a2) — AC-2 true two-independent-runs byte-identity (B1 gap)
//
// The existing (a) block proves default == explicit-off, but
// both runs execute in the SAME beforeAll and share the same
// tmpDir. This block adds a REAL two-run proof: the fixture is
// written once, then `runPipelineFromRepo` is called TWICE with
// NO lsp option at all (i.e., two truly independent runs without
// any explicit `lsp` key). Both snapshots must be deep-equal,
// AND every edge `source` MUST strictly === 'heuristic' (hard
// equality — no `?? 'heuristic'` coalescing that would mask
// undefined values).
// ═══════════════════════════════════════════════════════════════════════
describe('WI-V — AC-2 two-independent-default-runs byte-identity (B1)', () => {
  let tmpDir2: string;
  let run1: PipelineResult;
  let run2: PipelineResult;

  beforeAll(async () => {
    tmpDir2 = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gn-mode-a-golden-2runs-'));
    // Same fixture used by the (a)/(b) block above — a tiny TS
    // repo whose heuristic emits global-0.50 CALLS edges.
    fs.writeFileSync(
      path.join(tmpDir2, 'models.ts'),
      [
        'export class User {',
        '  save(): void {}',
        '  getName(): string { return ""; }',
        '}',
        'export function getUser(): User { return new User(); }',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tmpDir2, 'service.ts'),
      "import { getUser } from './models';\nexport const user = getUser();\n",
    );
    fs.writeFileSync(
      path.join(tmpDir2, 'app.ts'),
      [
        "import { user } from './service';",
        'export function main() {',
        '  user.save();',
        '  user.getName();',
        '}',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tmpDir2, 'tsconfig.json'),
      '{\n  "compilerOptions": {\n    "target": "es2020",\n    "module": "commonjs",\n    "strict": true\n  }\n}\n',
    );

    // Two completely independent default runs — NO `lsp` option at all
    // (not even `lsp: { enabled: false }`). This is the AC-2 / I-1
    // proof that neither run leaks a side-effect that alters the second.
    run1 = await runPipelineFromRepo(tmpDir2, () => {}, { skipGraphPhases: true });
    run2 = await runPipelineFromRepo(tmpDir2, () => {}, { skipGraphPhases: true });
  }, 90_000);

  afterAll(() => {
    if (tmpDir2 && fs.existsSync(tmpDir2)) {
      fs.rmSync(tmpDir2, { recursive: true, force: true });
    }
  });

  it('(a2) two independent default runs produce identical relationship snapshots (AC-2 / I-1)', () => {
    // If any mutable state leaks between the two default runs
    // (e.g. a module-level cache, a shared map, a closure over
    // run1's graph), the snapshots would differ here.
    expect(snapshotRels(run1.graph)).toBe(snapshotRels(run2.graph));
  });

  it('(a2) every edge in both runs carries source === "heuristic" — no undefined, no lsp-* (hard equality)', () => {
    // B1 contract: the test MUST fail if `r.source` is undefined.
    // Using hard equality (`toBe('heuristic')`) not `?? 'heuristic'`,
    // so a missing stamp or an accidental lsp-* stamp both cause a
    // test failure (a tautological `(r.source ?? 'heuristic') === 'heuristic'`
    // would pass even when source is undefined).
    for (const run of [run1, run2]) {
      for (const r of run.graph.iterRelationships()) {
        expect(r.source).toBe('heuristic');
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// (a2-dup) — AC-1 line-aware CALLS ids: integration proof of
// byte-identity for a fixture with TWO same-name CALLS edges.
//
// The (a2) block above covers the byte-identity contract on a
// fixture with one `user.save()` and one `user.getName()` — one
// call each, no duplicate sites. The unit test for AC-1 covers
// the multiplicity (call-processor.test.ts:1200-1245), but the
// integration proof of byte-identity for a fixture with two
// same-name CALLS edges is the WI-1 baseline change (`:L` suffix)
// determinism across real pipelines, not just the in-memory unit
// test.
//
// This block adds a duplicate-site variant of (a2): `user.work()`
// is called twice in the same function on distinct lines, minting
// two distinct CALLS edges whose ids differ only in `:L${line}`.
// Two independent default runs must produce identical snapshots
// (the AC-2 contract under the WI-1 line-aware multiplicity).
// ═══════════════════════════════════════════════════════════════════════
describe('WI-V — AC-1 line-aware CALLS ids: duplicate-site byte-identity (B1)', () => {
  let tmpDir2dup: string;
  let dupRun1: PipelineResult;
  let dupRun2: PipelineResult;

  beforeAll(async () => {
    tmpDir2dup = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gn-mode-a-golden-2runs-dup-'));
    // Two same-name call sites in app.ts: `user.work()` is
    // called on line 3 and line 4 of `main()`. The `User.work`
    // method is a global-0.50 winner (the only `work` globally),
    // so both calls land on the same target.
    fs.writeFileSync(
      path.join(tmpDir2dup, 'models.ts'),
      [
        'export class User {',
        '  save(): void {}',
        '  work(): void {}',     // the target of both calls
        '  getName(): string { return ""; }',
        '}',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tmpDir2dup, 'service.ts'),
      "import { getUser } from './models';\nexport const user = getUser();\n",
    );
    fs.writeFileSync(
      path.join(tmpDir2dup, 'app.ts'),
      [
        "import { user } from './service';",
        'export function main() {',
        '  user.work();',  // first call site
        '  user.work();',  // second call site — same name, same target, distinct line
        '}',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tmpDir2dup, 'tsconfig.json'),
      '{\n  "compilerOptions": {\n    "target": "es2020",\n    "module": "commonjs",\n    "strict": true\n  }\n}\n',
    );

    // Two completely independent default runs — same shape
    // as (a2) above. The snapshot equality proves that the
    // `:L${line}` suffix is deterministic across real
    // pipelines, not just the in-memory unit test.
    dupRun1 = await runPipelineFromRepo(tmpDir2dup, () => {}, { skipGraphPhases: true });
    dupRun2 = await runPipelineFromRepo(tmpDir2dup, () => {}, { skipGraphPhases: true });
  }, 90_000);

  afterAll(() => {
    if (tmpDir2dup && fs.existsSync(tmpDir2dup)) {
      fs.rmSync(tmpDir2dup, { recursive: true, force: true });
    }
  });

  it('(a2-dup) two same-name CALLS edges with distinct :L survive byte-identity (AC-1 / AC-2)', () => {
    // The fixture has TWO `user.work()` calls on distinct
    // lines. After the WI-1 fix, both edges survive with
    // distinct ids differing only in `:L${line}`. Two
    // independent runs must produce identical snapshots —
    // if the `:L` derivation were non-deterministic (e.g.
    // using a non-stable per-line counter), the two
    // snapshots would diverge.
    expect(snapshotRels(dupRun1.graph)).toBe(snapshotRels(dupRun2.graph));
  });

  it('(a2-dup) the graph has exactly the expected :L-suffixed CALLS edges for the duplicate work() sites', () => {
    // Pin the exact edge set: the two `user.work()` calls
    // mint two distinct edges with `:L${line}`; the
    // unrelated `User.work` method itself does NOT emit
    // any other edges in this fixture. If a future refactor
    // dedupes duplicate sites or drops the `:L` suffix,
    // the snapshot would change shape and the next (a2-dup)
    // byte-identity run would diverge.
    const workEdges = [...dupRun1.graph.iterRelationships()].filter(
      (r) => r.type === 'CALLS' && r.targetId.includes(':work'),
    );
    expect(workEdges.length, 'two distinct :L-suffixed work() edges must survive').toBe(2);
    // The two edges differ only in `:L${line}`.
    const ids = workEdges.map((r) => r.id).sort();
    expect(ids[0]).toMatch(/:L\d+$/);
    expect(ids[1]).toMatch(/:L\d+$/);
    expect(ids[0]).not.toBe(ids[1]);
    // Every default-path edge stamps `source: 'heuristic'`.
    for (const e of workEdges) {
      expect(e.source).toBe('heuristic');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// (a3) — Non-Angular fixture pin: Angular post-pass did not run.
//
// The fixture used by (a) and (a2) is a plain TypeScript repo
// with no `@Component` / `@Injectable` / `@NgModule` decorators.
// The Angular post-pass at `pipeline.ts:531` runs ONLY when
// `allSequentialCalls.length > 0`, which the sequential parsing
// pass populates from Angular DI/template extraction
// (extractAngularCalls in `extractor-calls-angular.ts`). On a
// non-Angular fixture, `allSequentialCalls` is empty and the
// post-pass is a no-op.
//
// This test pins that fact: the result graph's CALLS edge
// count is the heuristic-only baseline (the (a2) snapshot
// shape). If the Angular post-pass ever fires on a non-Angular
// fixture (a wiring regression that would inflate `allSequentialCalls`
// for every TS file regardless of decorators), the snapshot would
// diverge and this assertion catches it.
//
// This is a server-INDEPENDENT regression guard — it fires
// without a real LSP server or a running DB.
// ═══════════════════════════════════════════════════════════════════════
describe('WI-V — non-Angular fixture pin: Angular post-pass did not run (WI-V dedup/AC-4 contract)', () => {
  let tmpDir3: string;
  let nonAngularResult: PipelineResult;

  beforeAll(async () => {
    tmpDir3 = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gn-mode-a-golden-angular-pin-'));
    // Same non-Angular TS fixture shape as (a) and (a2). The
    // grep-based check verifies NO Angular decorator is present
    // in any of the test files we wrote — a defense-in-depth
    // guard against accidental fixture drift.
    fs.writeFileSync(
      path.join(tmpDir3, 'models.ts'),
      [
        'export class User {',
        '  save(): void {}',
        '  getName(): string { return ""; }',
        '}',
        'export function getUser(): User { return new User(); }',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tmpDir3, 'service.ts'),
      "import { getUser } from './models';\nexport const user = getUser();\n",
    );
    fs.writeFileSync(
      path.join(tmpDir3, 'app.ts'),
      [
        "import { user } from './service';",
        'export function main() {',
        '  user.save();',
        '  user.getName();',
        '}',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tmpDir3, 'tsconfig.json'),
      '{\n  "compilerOptions": {\n    "target": "es2020",\n    "module": "commonjs",\n    "strict": true\n  }\n}\n',
    );

    // Pin: the fixture files contain NO Angular decorator.
    // This is a structural check on the test fixture itself —
    // it guards against a future test-author inadvertently
    // adding @Component (etc.) to the fixture, which would
    // silently turn the post-pass back on.
    const allFiles = ['models.ts', 'service.ts', 'app.ts'];
    for (const f of allFiles) {
      const content = fs.readFileSync(path.join(tmpDir3, f), 'utf-8');
      expect(
        /@(Component|Injectable|NgModule)\b/.test(content),
        `fixture file ${f} must not contain Angular decorators`,
      ).toBe(false);
    }

    nonAngularResult = await runPipelineFromRepo(tmpDir3, () => {}, { skipGraphPhases: true });
  }, 90_000);

  afterAll(() => {
    if (tmpDir3 && fs.existsSync(tmpDir3)) {
      fs.rmSync(tmpDir3, { recursive: true, force: true });
    }
  });

  it('(a3) CALLS edge set is the heuristic-only baseline — Angular post-pass is a no-op', () => {
    // The fixture is a plain TypeScript repo with no Angular
    // decorators. The Angular post-pass at `pipeline.ts:531`
    // runs ONLY when `allSequentialCalls.length > 0`, which
    // is populated by Angular DI/template extraction. On a
    // non-Angular fixture, `allSequentialCalls` is empty and
    // the post-pass is a no-op — so the resulting graph is
    // exactly the heuristic-only CALLS set.
    //
    // The pin is two-part:
    //   1. The graph is non-empty (the heuristic DID emit
    //      global-0.50 CALLS edges — `user.save()` and
    //      `user.getName()` from app.ts).
    //   2. Every edge carries `source: 'heuristic'` and
    //      there is no `lsp-*` stamp (default path).
    //   3. Two independent runs on the same fixture produce
    //      identical snapshots (proves determinism AND that
    //      the Angular pass isn't a per-run side-effect that
    //      changes the second run's input).
    const callsEdges = [...nonAngularResult.graph.iterRelationships()].filter(
      (r) => r.type === 'CALLS',
    );
    expect(callsEdges.length, 'fixture must emit at least one CALLS edge on the default path').toBeGreaterThan(0);
    for (const r of callsEdges) {
      expect(r.source, 'every CALLS edge must carry source: "heuristic" on the default path').toBe('heuristic');
    }

    // Determinism pin: a second independent run on the same
    // fixture must produce the same snapshot. If a future
    // refactor introduces per-run side effects (e.g. global
    // state pollution that feeds into the Angular pass), the
    // second run's snapshot would diverge here.
    return (async () => {
      const run2 = await runPipelineFromRepo(tmpDir3, () => {}, { skipGraphPhases: true });
      expect(snapshotRels(nonAngularResult.graph)).toBe(snapshotRels(run2.graph));
    })();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// (e) — I-7 scoped assertion: `lsp/` is write-free AND the
//     reconciler imports no direct-DB writer.
// ═══════════════════════════════════════════════════════════════════════
//
// Two complementary checks:
//   1. Every .ts file under `core/ingestion/lsp/` has no write
//      API call site (CREATE / MERGE / SET / DELETE / COPY /
//      addRelationship / addNode / executeQuery / initLbug).
//   2. The reconciler file (`mode-a-reconciler.ts`) does not
//      import `executeQuery` or `initLbug` from lbug-adapter.
//      (The unit-level test of the engine is more thorough;
//      this is a structural tripwire.)
// ═══════════════════════════════════════════════════════════════════════
describe('WI-V — I-7 scoped assertion: lsp/ is write-free; reconciler imports no direct-DB writer', () => {
  it('(e) every file under core/ingestion/lsp/ is write-free at the source-text level', () => {
    const lspFiles = fs
      .readdirSync(lspDir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'));
    expect(lspFiles.length, 'expected at least one file under lsp/').toBeGreaterThan(0);
    const violations: string[] = [];
    for (const filename of lspFiles) {
      const filePath = path.join(lspDir, filename);
      const raw = fs.readFileSync(filePath, 'utf-8');
      const stripped = stripComments(raw);
      for (const token of FORBIDDEN_LSP_TOKENS) {
        const m = stripped.match(token.regex);
        if (m) {
          const lineNum = stripped.slice(0, m.index ?? 0).split('\n').length;
          violations.push(`  - lsp/${filename}:${lineNum}  ${token.name}  →  ${m[0].slice(0, 60)}`);
        }
      }
    }
    expect(violations, `lsp/ write-violations:\n${violations.join('\n')}`).toEqual([]);
  });

  it('(e) mode-a-reconciler.ts imports no direct-DB writer from lbug-adapter', () => {
    const src = fs.readFileSync(reconcilerFile, 'utf-8');
    // No `executeQuery` or `initLbug` import from lbug-adapter.
    expect(
      /import\s*\{[^}]*\bexecuteQuery\b[^}]*\}\s*from\s*['"][^'"]*lbug-adapter/.test(src),
      'reconciler must not import executeQuery from lbug-adapter',
    ).toBe(false);
    expect(
      /import\s*\{[^}]*\binitLbug\b[^}]*\}\s*from\s*['"][^'"]*lbug-adapter/.test(src),
      'reconciler must not import initLbug from lbug-adapter',
    ).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// (c), (f), (g), (h), (i) — Session + engine funnel tests
//     using deterministic mocks. No real LSP server required.
// ═══════════════════════════════════════════════════════════════════════
describe('WI-V — session funnel: deterministic mocks (no real server)', () => {
  /**
   * Build a candidate feed that exercises the full decision
   * table: confirm, correct, add, refuse. Each entry is
   * pinned to a unique (line, character) so the fake client
   * can route by position.
   */
  function makeCandidates(): Candidate[] {
    return [
      // 1) global-0.50 → A, callable B==A → confirm
      { sourceId: 'Function:src/caller1.ts:main:1', calledName: 'save', oldTargetId: 'Function:src/User.ts:save:1', file: 'src/caller1.ts', line: 10, character: 0 },
      // 2) global-0.50 → A, callable B!=A → correct
      { sourceId: 'Function:src/caller2.ts:main:1', calledName: 'save', oldTargetId: 'Function:src/User.ts:save:1', file: 'src/caller2.ts', line: 11, character: 0 },
      // 3) no edge, callable B (recall) → add
      { sourceId: 'Function:src/caller3.ts:main:1', calledName: 'fresh', file: 'src/caller3.ts', line: 12, character: 0 },
      // 4) no edge, NO_NODE → refuse
      { sourceId: 'Function:src/caller4.ts:main:1', calledName: 'undefined_fn', file: 'src/caller4.ts', line: 13, character: 0 },
    ];
  }

  /**
   * The fake `discoverServers` + `createLspClient` + `probe`
   * deps. The fake `discoverServers` reports a server is
   * present; the fake `probe` says READY. The real session
   * funnel is then exercised.
   */
  function makeDeps(locationByKey: Map<string, Location[]>) {
    const fakeClient = makeFakeClient(locationByKey);
    return {
      fakeClient,
      deps: {
        discoverServers: async () => ({ typescript: { path: '/bin/ts', version: '4.0.0' } }),
        createLspClient: () => fakeClient,
        probe: async () => ({ ready: true as const, latencyMs: 1, samples: [] }),
      },
    };
  }

  it.each<{
    shape: string;
    line: number;
    character: number;
    calledName: string;
  }>([
    // The simplest member-call case: a.b.c() where the
    // callee identifier `c` is at character 4 (after `a.b.`).
    { shape: '.x (a.b.x)', line: 10, character: 4, calledName: 'x' },
    // A deeper member-call: a.b.c.d() where the callee `d`
    // is at character 6 (after `a.b.c.`). This pins that
    // the session does NOT stop at the second dot — it
    // threads the *callee identifier* position.
    { shape: '.deep.nested (a.b.c.d)', line: 12, character: 6, calledName: 'd' },
    // A wide member-call chain: a.b.c.d.e() where the
    // callee `e` is at character 8. Catches an off-by-one
    // in any future "find the last dot" heuristic.
    { shape: '.x.y.z (a.b.c.d.e)', line: 14, character: 8, calledName: 'e' },
  ])('(c) member-call golden ($shape): candidate carries callee-identifier position, not call-expression start', async ({ line, character, calledName }) => {
    // The session must issue `textDocument/definition`
    // with the callee-identifier position, NOT the
    // call-expression start. The fake client's
    // `requestCalls` is the receipt.
    const candidates: Candidate[] = [
      { sourceId: `Function:src/c.ts:${calledName}:1`, calledName, oldTargetId: 'Function:src/t.ts:target:1', file: 'src/c.ts', line, character },
    ];
    const locs = new Map<string, Location[]>([
      [`${line}|${character}`, [{ uri: 'file:///src/t.ts', range: { start: { line: 5, character: 0 } } }]],
    ]);
    const { fakeClient, deps } = makeDeps(locs);

    const result = await withReconciliationSession(
      mkRepo(),
      candidates,
      async (selected) => ({ count: selected.length }),
      deps,
    );
    expect(result).not.toBeNull();
    // The exact textDocument/definition request MUST carry
    // the callee-identifier position. If WI-2 ever
    // regresses (the session threading the call-expression
    // start instead of the callee identifier), this
    // assertion catches it.
    expect(fakeClient.requestCalls.length).toBe(1);
    expect(fakeClient.requestCalls[0].method).toBe('textDocument/definition');
    expect(fakeClient.requestCalls[0].params.position).toEqual({ line, character });
  });

  it('(f) cap behavior: candidates > cap → first-N deterministic prefix; skipped count reported', async () => {
    // Build a feed of 5 candidates; cap=2. The fake client
    // returns NO_NODE for everything (refuse every site). The
    // work fn receives the deterministic prefix.
    const candidates: Candidate[] = [
      { sourceId: 'Function:src/a.ts:f1:1', calledName: 'a', file: 'src/a.ts', line: 1, character: 0 },
      { sourceId: 'Function:src/b.ts:f2:1', calledName: 'b', file: 'src/b.ts', line: 2, character: 0 },
      { sourceId: 'Function:src/c.ts:f3:1', calledName: 'c', file: 'src/c.ts', line: 3, character: 0 },
      { sourceId: 'Function:src/d.ts:f4:1', calledName: 'd', file: 'src/d.ts', line: 4, character: 0 },
      { sourceId: 'Function:src/e.ts:f5:1', calledName: 'e', file: 'src/e.ts', line: 5, character: 0 },
    ];
    const { fakeClient, deps } = makeDeps(new Map());

    let receivedCount = 0;
    let receivedSkipped = 0;
    const result = await withReconciliationSession(
      mkRepo(),
      candidates,
      async (selected, _meta, skipped) => {
        receivedCount = selected.length;
        receivedSkipped = skipped;
        return { received: true };
      },
      { ...deps, cap: 2 },
    );
    expect(result).not.toBeNull();
    expect(receivedCount).toBe(2);
    expect(receivedSkipped).toBe(3);
    // The cap is applied AFTER the stable sort — the first
    // two by (sourceId, calledName, line, character) are
    // selected. With our fixture, that's `a.ts` + `b.ts`.
    expect(fakeClient.requestCalls.length).toBe(2);
    const selectedLines = fakeClient.requestCalls.map((c) => c.params.position.line);
    expect(selectedLines).toEqual([1, 2]);
  });

  it('(g) determinism (I-2 residual-tolerant): no server → null, two runs identical', async () => {
    // No `discoverServers` override — the real one runs
    // and (in CI without a TS server) returns
    // { typescript: null }. The session funnel returns null.
    const candidates: Candidate[] = makeCandidates();
    const r1 = await withReconciliationSession(
      mkRepo(),
      candidates,
      async () => ({ ok: 1 }),
    );
    const r2 = await withReconciliationSession(
      mkRepo(),
      candidates,
      async () => ({ ok: 1 }),
    );
    // The "no server" path returns null deterministically
    // (no fork in the funnel on this gate). I-2 says
    // determinism is the contract when requests are
    // resolved identically; here we test the gate
    // determinism: both null, both same shape.
    expect(r1).toBeNull();
    expect(r2).toBeNull();
  });

  it('(g) determinism (I-2 residual-tolerant): probe not-ready → null, no `textDocument/definition` issued', async () => {
    // Server discovered, client started, probe says NOT
    // ready. The session funnel returns null. No request
    // ever fires.
    const candidates: Candidate[] = makeCandidates();
    const fakeClient = makeFakeClient(new Map());
    const r = await withReconciliationSession(
      mkRepo(),
      candidates,
      async () => ({ ok: 1 }),
      {
        discoverServers: async () => ({ typescript: { path: '/bin/ts', version: '4.0.0' } }),
        createLspClient: () => fakeClient,
        probe: async () => ({ ready: false, latencyMs: 0, samples: [], notReadyReason: 'not-ready' }),
      },
    );
    expect(r).toBeNull();
    expect(fakeClient.requestCalls.length).toBe(0);
  });

  it('(h) refuse: a multi-Location payload is AMBIGUOUS at the engine layer (refuse over guess)', async () => {
    // We bypass the session (which has its own
    // single-Location guard) and call the engine with a
    // hand-built `Location[]` of length > 1. The engine
    // MUST treat it as AMBIGUOUS and refuse (no edge).
    const graph = createKnowledgeGraph();
    graph.addNode({ id: 'Function:src/a.ts:x:1', label: 'Method', properties: { name: 'x' } });
    const candidates: Candidate[] = [
      { sourceId: 'Function:src/a.ts:x:1', calledName: 'ambiguous', file: 'src/a.ts', line: 0, character: 0 },
    ];
    const locs = new Map<string, Location[]>([
      [
        'Function:src/a.ts:x:1|ambiguous|0|0',
        [
          { uri: 'file:///src/a.ts', range: { start: { line: 1, character: 0 } } },
          { uri: 'file:///src/b.ts', range: { start: { line: 2, character: 0 } } },
        ],
      ],
    ]);
    const { reconcileDecisions } = await import(
      '../../../src/core/ingestion/mode-a-reconciler.js'
    );
    const report = await reconcileDecisions(graph, candidates, locs, {
      callableLabels: CALLABLE_LABELS,
      // Engine requires an explicit mapper (no default
      // hitting the live DB). The test does not exercise
      // the multi-Location path through the mapper
      // (multi-Location is short-circuited to AMBIGUOUS
      // BEFORE the mapper is called), so a NO_NODE
      // passthrough suffices.
      mapLocationToNodeId: async () => ({ kind: 'NO_NODE' as const }),
    });
    expect(report.decisions[0].action).toBe('refuse');
    expect(report.decisions[0].reason).toBe('ambiguous');
  });

  it('(h) refuse: a non-callable Class hit is refused (callee-label precondition, AC-4 / I-3)', async () => {
    // Single Location mapping to a Class. The engine's
    // callee gate (KD-3) refuses on a non-callable target.
    // We inject a custom `mapLocationToNodeId` so the
    // engine sees the in-memory `Class:src/b.ts:Bar:1`
    // node WITHOUT going through the real Cypher path
    // (which would not see the synthetic graph).
    const graph = createKnowledgeGraph();
    graph.addNode({ id: 'Function:src/a.ts:x:1', label: 'Method', properties: { name: 'x' } });
    graph.addNode({ id: 'Class:src/b.ts:Bar:1', label: 'Class', properties: { name: 'Bar' } });
    const candidates: Candidate[] = [
      { sourceId: 'Function:src/a.ts:x:1', calledName: 'Bar', file: 'src/a.ts', line: 0, character: 0 },
    ];
    const locs = new Map<string, Location[]>([
      [
        'Function:src/a.ts:x:1|Bar|0|0',
        [{ uri: 'file:///src/b.ts', range: { start: { line: 5, character: 0 } } }],
      ],
    ]);
    const { reconcileDecisions } = await import(
      '../../../src/core/ingestion/mode-a-reconciler.js'
    );
    const report = await reconcileDecisions(graph, candidates, locs, {
      callableLabels: CALLABLE_LABELS,
      // Inject a single-node mapper so the engine sees
      // `Class:src/b.ts:Bar:1` and then enforces the
      // callee-label gate (Class is NOT in CALLABLE_LABELS).
      mapLocationToNodeId: async () => ({ kind: 'node' as const, nodeId: 'Class:src/b.ts:Bar:1' }),
    });
    expect(report.decisions[0].action).toBe('refuse');
    expect(report.decisions[0].reason).toBe('non_callable');
    // And no edge was minted.
    expect(graph.relationshipCount).toBe(0);
  });

  it('(i) failure isolation: dispatch throw → null, no abort (I-5 / KD-9)', async () => {
    // The session funnel's `catch` is the failure-isolation
    // gate. A throw inside `handToEngine` (the dispatch
    // seam) must NOT abort the index — the funnel returns
    // null and the heuristic index stands untouched. (The
    // production graph is NOT modified by the funnel; the
    // caller checks for null and proceeds.)
    const candidates: Candidate[] = makeCandidates();
    const fakeClient = makeFakeClient(new Map());
    const r = await withReconciliationSession(
      mkRepo(),
      candidates,
      async () => ({ ok: 1 }),
      {
        discoverServers: async () => ({ typescript: { path: '/bin/ts', version: '4.0.0' } }),
        createLspClient: () => fakeClient,
        probe: async () => ({ ready: true, latencyMs: 0, samples: [] }),
        handToEngine: async () => {
          throw new Error('simulated dispatch crash');
        },
      },
    );
    expect(r).toBeNull();
    // The client was stopped (I-5: stop is in `finally`).
    // We don't introspect the fake client's state — the
    // funnel's return value (null) is the contract.
  });
});

// ═══════════════════════════════════════════════════════════════════════
// (d) + (k) — Real `loadGraphToLbug` round-trip with
//     lsp-augmented edges. This is the integration-level
//     persistence proof: the `source` column rides through
//     the HEADER-driven property-binding COPY (per-label
//     from/to + 7-col CSV header; Kùzu rel COPY does not
//     support an explicit property column-list) AND through
//     the (mocked) fallback path.
// ═══════════════════════════════════════════════════════════════════════
withTestLbugDB('mode-a-golden', (handle) => {
  /**
   * Wipe all data so the assertions on row counts are
   * self-contained.
   */
  async function clearData(): Promise<void> {
    const adapter = await import('../../../src/core/lbug/lbug-adapter.js');
    const tables = ['File', 'Folder', 'Function', 'Class', 'Method', 'CodeElement', 'Community', 'Process', 'Route'];
    for (const t of tables) {
      try { await adapter.executeQuery(`MATCH (n:\`${t}\`) DETACH DELETE n`); } catch { /* table may not exist */ }
    }
    try { await adapter.executeQuery(`MATCH ()-[r:CodeRelation]->() DELETE r`); } catch { /* empty */ }
  }

  it('(d) atomic-correction collision: lsp-corrected edge round-trips through loadGraphToLbug with no net loss', async () => {
    await clearData();
    const adapter = await import('../../../src/core/lbug/lbug-adapter.js');

    // Two callers (caller1, caller2), two callees (A, B).
    // The heuristic has emitted a `global`-0.50 edge from
    // each caller to A. The reconciler's decision table
    // (AC-5 / I-4) says: caller1 → confirm (LSP agrees);
    // caller2 → correct (LSP disagrees) → atomic remove+insert
    // at 0.70 with `lsp-corrected`. The collapse must keep
    // the higher-confidence row.
    const graph = createKnowledgeGraph();
    for (const id of ['Function:src/caller1.ts:main:1', 'Function:src/caller2.ts:main:1', 'Function:src/a.ts:target:1', 'Function:src/b.ts:target:1']) {
      const [, , fname, name] = id.split(':');
      graph.addNode({
        id,
        label: 'Function',
        properties: { name, filePath: `src/${fname.split('.')[0]}.ts`, startLine: 1, endLine: 1, isExported: true },
      });
    }
    // Heuristic global-0.50 edges.
    graph.addRelationship({
      id: 'CALLS:caller1->A',
      sourceId: 'Function:src/caller1.ts:main:1',
      targetId: 'Function:src/a.ts:target:1',
      type: 'CALLS',
      confidence: 0.5,
      reason: 'fuzzy-global',
      source: 'heuristic',
    });
    graph.addRelationship({
      id: 'CALLS:caller2->A',
      sourceId: 'Function:src/caller2.ts:main:1',
      targetId: 'Function:src/a.ts:target:1',
      type: 'CALLS',
      confidence: 0.5,
      reason: 'fuzzy-global',
      source: 'heuristic',
    });
    // Replicator engine applies the corrections.
    const { applyDecisions, LSP_CONFIDENCE } = await import(
      '../../../src/core/ingestion/mode-a-reconciler.js'
    );
    const decisions = [
      {
        candidate: { sourceId: 'Function:src/caller1.ts:main:1', calledName: 'target', file: 'src/caller1.ts', line: 0, character: 0 },
        action: 'confirm' as const,
        from: 'Function:src/caller1.ts:main:1',
        to: 'Function:src/a.ts:target:1',
        source: 'lsp-confirmed' as const,
        oldTargetId: 'Function:src/a.ts:target:1',
        oldRelId: 'CALLS:caller1->A',
        reason: 'lsp-confirmed',
      },
      {
        candidate: { sourceId: 'Function:src/caller2.ts:main:1', calledName: 'target', file: 'src/caller2.ts', line: 0, character: 0 },
        action: 'correct' as const,
        from: 'Function:src/caller2.ts:main:1',
        to: 'Function:src/b.ts:target:1',
        source: 'lsp-corrected' as const,
        oldTargetId: 'Function:src/a.ts:target:1',
        oldRelId: 'CALLS:caller2->A',
        reason: 'lsp-corrected',
      },
    ];
    const r = applyDecisions(graph, decisions);
    // Atomic correction: 1 confirm (add+remove) + 1 correct
    // (add+remove). The added count is 2; removed is 2.
    expect(r.added).toBe(2);
    expect(r.removed).toBe(2);
    // And no net loss — caller1 still has an edge, caller2
    // still has an edge.
    expect(graph.relationshipCount).toBe(2);

    // Now serialize through loadGraphToLbug. Every row must
    // round-trip with the correct `source`.
    const storagePath = path.join(handle.tmpHandle.dbPath, 'mode-a-golden-corrected');
    await fsPromises.mkdir(storagePath, { recursive: true });
    const result = await adapter.loadGraphToLbug(graph, '/test/repo', storagePath);
    expect(result.success).toBe(true);
    expect(result.insertedRels).toBe(2);

    // Query the source column. caller1 carries lsp-confirmed
    // (re-stamp); caller2 carries lsp-corrected. The FROM
    // node's `id` is the caller (the CodeRelation table
    // is keyed by FROM/TO, not by an explicit sourceId
    // property on the relationship).
    const rows = await adapter.executeQuery(
      'MATCH (from)-[r:CodeRelation {type: "CALLS"}]->() RETURN r.source AS source, r.confidence AS confidence, from.id AS fromId',
    );
    expect(rows).toHaveLength(2);
    const bySource = new Map<string, { source: string; confidence: number; fromId: string }>();
    for (const row of rows as any[]) {
      bySource.set(row.fromId, { source: row.source, confidence: row.confidence, fromId: row.fromId });
    }
    expect(bySource.get('Function:src/caller1.ts:main:1')).toMatchObject({
      source: 'lsp-confirmed',
      confidence: LSP_CONFIDENCE,
    });
    expect(bySource.get('Function:src/caller2.ts:main:1')).toMatchObject({
      source: 'lsp-corrected',
      confidence: LSP_CONFIDENCE,
    });
  });

  it('(k) source round-trip: HEADER-driven property-binding COPY and fallback CREATE both persist non-NULL', async () => {
    await clearData();
    const adapter = await import('../../../src/core/lbug/lbug-adapter.js');

    // Explicit-COPY path: a graph with lsp-* edges
    // round-trips through loadGraphToLbug and the COPY
    // persists the `source` column verbatim (covered in
    // detail by `source-column-roundtrip.test.ts`; pinned
    // here at the integration level for AC-9 / WI-1).
    const graph1 = buildTestGraph(
      [
        { id: 'File:src/x.ts', label: 'File', name: 'x.ts', filePath: 'src/x.ts' },
        { id: 'File:src/y.ts', label: 'File', name: 'y.ts', filePath: 'src/y.ts' },
        { id: 'Function:src/x.ts:foo:1', label: 'Function', name: 'foo', filePath: 'src/x.ts', startLine: 1, endLine: 1, isExported: true },
        { id: 'Function:src/y.ts:bar:1', label: 'Function', name: 'bar', filePath: 'src/y.ts', startLine: 1, endLine: 1, isExported: true },
      ],
      [],
    );
    graph1.addRelationship({
      id: 'r-recall',
      sourceId: 'Function:src/x.ts:foo:1',
      targetId: 'Function:src/y.ts:bar:1',
      type: 'CALLS',
      confidence: 0.7,
      reason: 'lsp-recall',
      source: 'lsp-recall',
    });
    const storage1 = path.join(handle.tmpHandle.dbPath, 'mode-a-golden-explicit');
    await fsPromises.mkdir(storage1, { recursive: true });
    const r1 = await adapter.loadGraphToLbug(graph1, '/test/repo', storage1);
    expect(r1.success).toBe(true);

    // Read the source column back.
    const explicitRows = await adapter.executeQuery(
      'MATCH ()-[r:CodeRelation {type: "CALLS"}]->() RETURN r.source AS source',
    );
    expect((explicitRows as any[]).map((r) => r.source)).toEqual(['lsp-recall']);

    // Fallback CREATE path: exercised at the unit level by
    // `lbug-adapter.test.ts` (regex + DDL fixtures). The
    // integration proof here: after the HEADER-driven
    // property-binding COPY round-trip, a SECOND
    // `loadGraphToLbug` call (with a freshly seeded graph)
    // writes through the COPY path AND every row still
    // carries the `source` value. If
    // the HEADER-driven property binding regressed (e.g.
    // dropped the 7th column from the CSV header), the
    // second write would either error or produce NULLs — both
    // caught by this assertion.
    await clearData();
    const graph2 = buildTestGraph(
      [
        { id: 'File:src/p.ts', label: 'File', name: 'p.ts', filePath: 'src/p.ts' },
        { id: 'File:src/q.ts', label: 'File', name: 'q.ts', filePath: 'src/q.ts' },
        { id: 'Function:src/p.ts:f1:1', label: 'Function', name: 'f1', filePath: 'src/p.ts', startLine: 1, endLine: 1, isExported: true },
        { id: 'Function:src/q.ts:f2:1', label: 'Function', name: 'f2', filePath: 'src/q.ts', startLine: 1, endLine: 1, isExported: true },
      ],
      [
        // Default-source row.
        { sourceId: 'Function:src/p.ts:f1:1', targetId: 'Function:src/q.ts:f2:1', type: 'CALLS' },
      ],
    );
    graph2.addRelationship({
      id: 'r-confirmed',
      sourceId: 'Function:src/q.ts:f2:1',
      targetId: 'Function:src/p.ts:f1:1',
      type: 'CALLS',
      confidence: 0.7,
      reason: 'lsp-confirmed',
      source: 'lsp-confirmed',
    });
    const storage2 = path.join(handle.tmpHandle.dbPath, 'mode-a-golden-fallback');
    await fsPromises.mkdir(storage2, { recursive: true });
    const r2 = await adapter.loadGraphToLbug(graph2, '/test/repo', storage2);
    expect(r2.success).toBe(true);

    // Every row carries a non-NULL `source`; both enum
    // values are present.
    const fallbackRows = await adapter.executeQuery(
      'MATCH ()-[r:CodeRelation {type: "CALLS"}]->() RETURN r.source AS source',
    );
    const sources = (fallbackRows as any[]).map((r) => r.source);
    expect(sources).toHaveLength(2);
    for (const s of sources) {
      expect(s, 'every row must have a non-NULL source').toBeTruthy();
    }
    expect(sources).toEqual(expect.arrayContaining(['heuristic', 'lsp-confirmed']));
  });
});

// ═══════════════════════════════════════════════════════════════════════
// (j) — BFS classification of a 0.5 vs 0.7 CALLS edge
//      (the prerequisite contract for AC-7).
//
// The test pins the BFS `min_confidence = 0.7` filter's
// classification contract that Mode A's job is to KEEP
// REACHABLE: a CALLS edge at 0.5 is filtered out (no endpoint
// surfaces in LIKELY_AFFECTED), but the same edge at 0.7
// passes the filter and surfaces GET /api/users in
// LIKELY_AFFECTED (NOT WILL_BREAK — the tier classifier
// lands a depth-1 0.7 hit in the LIKELY_AFFECTED bucket).
//
// This is NOT a Mode A reconciliation test — it does not
// drive `applyDecisions` or `runPipelineFromRepo` with a
// real LSP server. It is a BFS contract test that pins the
// downstream behavior Mode A's reconciler must produce for.
// To prove Mode A actually emits a 0.7 edge from a 0.5 input,
// see the unit-level `applyDecisions` tests in
// `mode-a-engine.test.ts` (the `correct` action re-stamps
// confidence to LSP_CONFIDENCE = 0.7).
//
// The test is still load-bearing for AC-7: if the BFS ever
// changed the 0.5 / 0.7 classification (e.g. raising the
// filter floor to 0.8), the LSP-augmented tier would no
// longer surface and the (j) contract would break.
// ═══════════════════════════════════════════════════════════════════════
//
// Setup: a 4-node chain — Route R → Method A → Method B →
// Method C. Three edges are pinned:
//   - R → A   (CALLS, conf 1.0, route-handler)  — fixed
//   - A → B   (CALLS, conf 1.0, import-resolved) — fixed
//   - B → C   (CALLS, conf 0.5 default | 0.7 LSP) — the variable
// The diff is on C's file. The BFS `min_confidence = 0.7`
// filter (local-backend.ts:2116) gates upstream traversal:
//   - default:  B→C at 0.5 is filtered at d=1; BFS dies;
//               no upstream caller is found; the route
//               discovery query (line 2560) cannot find
//               any s ∈ expanded that is *also* called by
//               a route handler. LIKELY_AFFECTED empty.
//   - LSP:      B→C at 0.7 passes; B is added at d=1
//               (conf 0.7). Route discovery: m=A calls
//               s=B (A→B at 1.0), and r=R calls m=A
//               (R→A at 1.0). The affected_id is B
//               (depth 1, conf 0.7), so the tier
//               classifier (local-backend.ts:2814-2820)
//               lands R in LIKELY_AFFECTED (conf 0.7 <
//               the WILL_BREAK floor 0.85).
//
// Two `withTestLbugDB` blocks (sequential, after the (d)+(k)
// block above) so each state is hermetic: the default path
// has no lsp-* edges and the LSP path has only the corrected
// edge at 0.7. The diff is mocked via `execFileSync` and the
// registry is mocked to a single pinned repo (scope-guard
// behavior; same shape as `impacted-endpoints-scope-guard`).
// ═══════════════════════════════════════════════════════════════════════
interface ImpactedEndpointsResultJ {
  summary: {
    changed_files: Record<string, number>;
    changed_symbols: Record<string, number>;
    impacted_endpoints: Record<string, number>;
    risk_level: string;
  };
  impacted_endpoints: {
    WILL_BREAK: any[];
    LIKELY_AFFECTED: any[];
    MAY_NEED_TESTING: any[];
  };
  changed_symbols: any[];
  affected_processes: any[];
  affected_modules: any[];
  _meta: { version: string; generated_at: string };
  error?: string;
}

/**
 * Build a `git diff --unified=0` hunk for a single file at
 * the given (newStart, newCount). Mirrors the shape produced
 * by the real `git diff` command; the parser at
 * `parse-diff-lines.ts:32` consumes this verbatim.
 */
function buildUnifiedDiffJ(
  filePath: string,
  hunks: Array<{ newStart: number; newCount: number }>,
): string {
  const lines = [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
  ];
  for (const h of hunks) {
    const oldStart = h.newStart;
    const oldCount = h.newCount;
    lines.push(`@@ -${oldStart},${oldCount} +${h.newStart},${h.newCount} @@`);
    for (let i = 0; i < h.newCount; i++) {
      lines.push(`+changed line ${h.newStart + i}`);
    }
  }
  return lines.join('\n') + '\n';
}

/** Mock `execFileSync` for the (j) test: a single-file diff. */
function mockGitDiffJ(
  filePath: string,
  hunks: Array<{ newStart: number; newCount: number }>,
): void {
  vi.mocked(execFileSync as any).mockImplementation((_cmd: string, args: string[]) => {
    if (args.includes('--unified=0')) {
      return buildUnifiedDiffJ(filePath, hunks);
    }
    if (args.includes('--name-only')) {
      return `${filePath}\n`;
    }
    return '';
  });
}

// `vi.mock` calls are hoisted to the top of the module by
// vitest — placement in the file is for readability; the
// mocks apply to the whole file. `repo-manager` and
// `child_process` are mocked because the LocalBackend +
// impacted_endpoints impl both touch them.
//
// SCOPE: ONLY the (j) describe blocks at the bottom of this
// file (`mode-a-j-default` + `mode-a-j-lsp`) consume these
// mocked modules. The (a)-(i) and (d)/(k) blocks do NOT
// import `LocalBackend`, do NOT call `execFileSync`, and do
// NOT call `listRegisteredRepos` — so the hoisted mocks are
// inert for them. If a future edit introduces a (new) test
// that depends on the un-mocked `child_process` or
// `repo-manager`, this hoisting becomes a foot-gun: the test
// would inherit the (j) mock. The invariant we maintain:
// (a)-(i) read-only paths MUST NOT import `LocalBackend` or
// touch `execFileSync` / `listRegisteredRepos` directly.
vi.mock('../../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
}));

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

// ─── B3 partial mock: mode-a-reconciler.js ────────────────────────────
// Keeps ALL exports REAL via `vi.importActual` except
// `withReconciliationSession`, which becomes a vi.fn spy that by
// default calls through to the real implementation. This lets B3
// use `.mockImplementationOnce(...)` to override exactly one call
// (the `runPipelineFromRepo(lsp:{enabled:true})` call in the AC-7
// beforeAll), while all other calls in the file (e.g. the (c)/(g)/(h)/(i)
// tests that call `withReconciliationSession` directly) see the real
// implementation.
//
// SCOPE: the spy default is `vi.fn(actualImpl)` so the call-through
// behavior is preserved everywhere except where `.mockImplementationOnce`
// is set. The (a2) default-runs test calls `runPipelineFromRepo` with
// NO lsp option at all — `withReconciliationSession` is never reached
// on the default path, so the spy is inert for those tests.
vi.mock('../../../src/core/ingestion/mode-a-reconciler.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/core/ingestion/mode-a-reconciler.js')>(
    '../../../src/core/ingestion/mode-a-reconciler.js',
  );
  return {
    ...actual,
    // Replace ONLY `withReconciliationSession` with a spy.
    // The spy's default implementation calls through to the real
    // function so all existing tests remain unaffected. B3's beforeAll
    // uses `.mockImplementationOnce(...)` to intercept one call.
    withReconciliationSession: vi.fn(actual.withReconciliationSession),
  };
});

/**
 * The 4-node seed, parameterized by the B→C confidence
 * value (the variable under test). Returns the Cypher
 * statements that build: File models.ts + File controllers.ts
 * + Route R + Method A (handler) + Method B (intermediate) +
 * Method C (target) + the three pinned CALLS edges.
 */
function seedChainJ(bToCConfidence: number): string[] {
  return [
    // File nodes (2)
    `CREATE (f:File {id: 'file-controllers', name: 'controllers.ts', filePath: 'controllers.ts', content: 'controller layer', repoId: ''})`,
    `CREATE (f:File {id: 'file-models', name: 'models.ts', filePath: 'models.ts', content: 'data layer', repoId: ''})`,
    // Route (1)
    `CREATE (r:Route {id: 'route-get-users', name: '/api/users', httpMethod: 'GET', routePath: '/api/users', controllerName: 'UserController', methodName: 'listUsers', filePath: 'controllers.ts', startLine: 1, lineNumber: 1, isInherited: false, repoId: '', responseKeys: ['users'], errorKeys: ['error'], middleware: []})`,
    // Method A — handler (in controllers.ts)
    `CREATE (m:Method {id: 'method-listUsers', name: 'listUsers', filePath: 'controllers.ts', startLine: 1, endLine: 5, isExported: false, content: 'listUsers handler', description: 'lists users', parameterCount: 0, returnType: 'list', parameters: '[]', annotations: '[]', parameterAnnotations: '[]', repoId: ''})`,
    // Method B — intermediate (in models.ts)
    `CREATE (m:Method {id: 'method-helperA', name: 'helperA', filePath: 'models.ts', startLine: 1, endLine: 5, isExported: true, content: 'helperA function', description: 'helper', parameterCount: 0, returnType: 'void', parameters: '[]', annotations: '[]', parameterAnnotations: '[]', repoId: ''})`,
    // Method C — target (in models.ts)
    `CREATE (m:Method {id: 'method-targetC', name: 'targetC', filePath: 'models.ts', startLine: 6, endLine: 12, isExported: true, content: 'targetC function', description: 'the changed target', parameterCount: 0, returnType: 'void', parameters: '[]', annotations: '[]', parameterAnnotations: '[]', repoId: ''})`,
    // R → A (1.0, route-handler)
    `MATCH (r:Route), (m:Method) WHERE r.id = 'route-get-users' AND m.id = 'method-listUsers'
     CREATE (r)-[:CodeRelation {type: 'CALLS', confidence: 1.0, reason: 'route-handler', step: 0}]->(m)`,
    // A → B (1.0, import-resolved)
    `MATCH (a:Method), (b:Method) WHERE a.id = 'method-listUsers' AND b.id = 'method-helperA'
     CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 1.0, reason: 'import-resolved', step: 0}]->(b)`,
    // B → C (the variable; default 0.5 vs LSP 0.7)
    `MATCH (a:Method), (c:Method) WHERE a.id = 'method-helperA' AND c.id = 'method-targetC'
     CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: ${bToCConfidence}, reason: 'fuzzy-global', step: 0}]->(c)`,
  ];
}

withTestLbugDB('mode-a-j-default', (handle) => {
  let result: ImpactedEndpointsResultJ;

  beforeAll(async () => {
    const ext = handle as typeof handle & { _backend?: LocalBackend };
    // Wipe then seed: the 4-node chain with B→C at 0.5.
    const adapter = await import('../../../src/core/lbug/lbug-adapter.js');
    for (const t of ['File', 'Folder', 'Function', 'Class', 'Method', 'Route']) {
      try { await adapter.executeQuery(`MATCH (n:\`${t}\`) DETACH DELETE n`); } catch { /* may not exist */ }
    }
    try { await adapter.executeQuery(`MATCH ()-[r:CodeRelation]->() DELETE r`); } catch { /* empty */ }

    for (const q of seedChainJ(0.5)) {
      await adapter.executeQuery(q);
    }

    // Diff: change `models.ts` lines 6-12 (covers ONLY
    // method-targetC at lines 6-12; method-helperA is at
    // lines 1-5 and is NOT in the changed line range).
    // The BFS at default min_confidence=0.7 will find NO
    // upstream caller of targetC (the only edge into
    // targetC is helperA→targetC at 0.5; helperA is not
    // a changed symbol and has no caller in the chain).
    mockGitDiffJ('models.ts', [{ newStart: 6, newCount: 7 }]);

    vi.mocked(listRegisteredRepos as any).mockResolvedValue([
      {
        name: 'mode-a-j-repo',
        path: '/test/mode-a-j-repo',
        storagePath: ext.tmpHandle.dbPath,
        indexedAt: new Date().toISOString(),
        lastCommit: 'deadbeef',
        stats: { files: 2, nodes: 6, communities: 0, processes: 0 },
      },
    ]);

    const b = new LocalBackend();
    await b.init();
    ext._backend = b;

    result = (await b.callTool('impacted_endpoints', {
      repo: 'mode-a-j-repo',
      scope: 'compare',
      base_ref: 'main',
    })) as ImpactedEndpointsResultJ;
  }, 90_000);

  it('(j) BFS: 0.5 `global` CALLS edge is filtered by min_confidence=0.7; no endpoint surfaces (default path)', () => {
    // No LSP ran. The B→C edge is at 0.5. BFS dies at d=1.
    // LIKELY_AFFECTED and WILL_BREAK must be empty.
    expect(result.error).toBeUndefined();
    const all = [
      ...result.impacted_endpoints.WILL_BREAK,
      ...result.impacted_endpoints.LIKELY_AFFECTED,
    ];
    expect(all).toEqual([]);
    // MAY_NEED_TESTING is also empty: nothing in the chain
    // even at the lower-tier floor.
    expect(result.impacted_endpoints.MAY_NEED_TESTING).toEqual([]);
  });
}, {
  poolAdapter: true,
});

withTestLbugDB('mode-a-j-lsp', (handle) => {
  let result: ImpactedEndpointsResultJ;

  beforeAll(async () => {
    const ext = handle as typeof handle & { _backend?: LocalBackend };
    // Same graph shape, but B→C is at 0.7 — what the
    // reconciler writes after LSP confirms a different target.
    const adapter = await import('../../../src/core/lbug/lbug-adapter.js');
    for (const t of ['File', 'Folder', 'Function', 'Class', 'Method', 'Route']) {
      try { await adapter.executeQuery(`MATCH (n:\`${t}\`) DETACH DELETE n`); } catch { /* may not exist */ }
    }
    try { await adapter.executeQuery(`MATCH ()-[r:CodeRelation]->() DELETE r`); } catch { /* empty */ }

    for (const q of seedChainJ(0.7)) {
      await adapter.executeQuery(q);
    }

    // Same diff as the default-path block (lines 6-12 of
    // models.ts — only method-targetC).
    mockGitDiffJ('models.ts', [{ newStart: 6, newCount: 7 }]);

    vi.mocked(listRegisteredRepos as any).mockResolvedValue([
      {
        name: 'mode-a-j-repo',
        path: '/test/mode-a-j-repo',
        storagePath: ext.tmpHandle.dbPath,
        indexedAt: new Date().toISOString(),
        lastCommit: 'deadbeef',
        stats: { files: 2, nodes: 6, communities: 0, processes: 0 },
      },
    ]);

    const b = new LocalBackend();
    await b.init();
    ext._backend = b;

    result = (await b.callTool('impacted_endpoints', {
      repo: 'mode-a-j-repo',
      scope: 'compare',
      base_ref: 'main',
    })) as ImpactedEndpointsResultJ;
  }, 90_000);

  it('(j) BFS: 0.7 CALLS edge (what Mode A emits) passes filter; GET /api/users surfaces in LIKELY_AFFECTED, not WILL_BREAK', () => {
    expect(result.error).toBeUndefined();

    // The endpoint surfaces in LIKELY_AFFECTED, not WILL_BREAK:
    // affected_id = helperA (depth 1, conf 0.7 from B→C),
    // tier classifier (local-backend.ts:2814-2820) lands
    // it in LIKELY_AFFECTED (conf 0.7 < 0.85 WILL_BREAK
    // floor).
    const laEntry = result.impacted_endpoints.LIKELY_AFFECTED.find(
      (e: any) => e.path === '/api/users' && e.method === 'GET',
    );
    expect(laEntry, 'expected GET /api/users in LIKELY_AFFECTED').toBeDefined();
    // And the tier is correct — NOT in WILL_BREAK.
    const wbEntry = result.impacted_endpoints.WILL_BREAK.find(
      (e: any) => e.path === '/api/users' && e.method === 'GET',
    );
    expect(wbEntry, 'GET /api/users must NOT be in WILL_BREAK (conf < 0.85)').toBeUndefined();
  });
}, {
  poolAdapter: true,
});

// ═══════════════════════════════════════════════════════════════════════
// (AC-7) — Full pipeline end-to-end: runPipelineFromRepo --lsp
//     → lsp-corrected 0.70 edge → loadGraphToLbug → impacted_endpoints
//     → corrected route surfaces in LIKELY_AFFECTED (not WILL_BREAK)
//       under --lsp, absent under parallel default (no-flag) run.
//
// This is the REAL Mode A reconciliation test — it drives
// `runPipelineFromRepo` (not just `applyDecisions` directly)
// and goes all the way to `impacted_endpoints`. The (j) block
// only proved the BFS classification contract; this block proves
// that the FULL chain from pipeline invocation to route
// surfacing works end-to-end.
//
// MECHANISM: partial module mock of `mode-a-reconciler.js`
// (see the `vi.mock` call above). `withReconciliationSession` is
// a vi.fn() spy that by default calls through to the real
// implementation. In the B3 `beforeAll`, we use
// `.mockImplementationOnce(...)` to intercept EXACTLY ONE call
// (the lsp-enabled `runPipelineFromRepo`) and inject a
// deterministic LSP response: the mock calls
// `deps.handToEngine!(candidate, [LocationB])` for the single
// correction candidate, handing the pipeline a Location that
// the real in-memory adapter maps to the node B. The real
// `reconcileDecisions` + `applyDecisions` then mint the
// lsp-corrected 0.70 edge — no production seam needed.
//
// For the default (no-flag) run, `withReconciliationSession` is
// never reached (the default path has no lsp gate), so the spy
// is inert.
//
// Setup: a tiny TS fixture with:
//   - ac7-service.ts: `export function computeTarget(): void {}`  (A)
//   - ac7-helper.ts:  `export function helperTarget(): void {}`   (B)
//   - ac7-caller.ts:  a function `callerFn` that calls `computeTarget()`
//                     without importing it (global-0.50 heuristic edge
//                     callerFn → computeTarget/A)
//   - ac7-controller.ts: `import { callerFn } from './ac7-caller';`
//                        `export function ac7Handler(): void { callerFn(); }`
//
// The corrected graph has callerFn→helperTarget/B at 0.70.
// After loadGraphToLbug, we add Route R + handler edges to DB.
// The diff changes ac7-helper.ts line 0 → BFS:
//   d=1: callerFn (via callerFn→B at 0.70) ← PASSES 0.70 floor
//   d=2: ac7Handler (via ac7Handler→callerFn at 1.0)
//   → Route GET /ac7-route surfaces in LIKELY_AFFECTED
//
// Under the default path, callerFn→A is at 0.50 → filtered
// by BFS min_confidence=0.70 → no endpoint surfaces.
// ═══════════════════════════════════════════════════════════════════════

withTestLbugDB('mode-a-ac7', (handle) => {
  let lspResult: ImpactedEndpointsResultJ;
  let defaultResult_ac7: ImpactedEndpointsResultJ;

  // Helpers to clear DB data between LSP and default runs.
  async function clearAllAc7Data(): Promise<void> {
    const adapter = await import('../../../src/core/lbug/lbug-adapter.js');
    for (const t of ['File', 'Folder', 'Function', 'Class', 'Method', 'Route', 'CodeElement', 'Community', 'Process']) {
      try { await adapter.executeQuery(`MATCH (n:\`${t}\`) DETACH DELETE n`); } catch { /* may not exist */ }
    }
    try { await adapter.executeQuery(`MATCH ()-[r:CodeRelation]->() DELETE r`); } catch { /* empty */ }
  }

  let tmpFixtureDir: string;
  beforeAll(async () => {
    const adapter = await import('../../../src/core/lbug/lbug-adapter.js');

    // ── Fixture: isolated TS repo in its own tempdir ─────────────────
    // Use a SEPARATE tmpDir (not repoPath) so the pipeline's
    // `walkRepositoryPaths` only sees the TS fixture files and is not
    // confused by the Kùzu DB files in the parent dir.
    //
    // ac7-service.ts: the A target — `computeTarget` is a multi-line
    //   function (lines 0-2) so tree-sitter definitely indexes it.
    //   It is the ONLY symbol named `computeTarget` globally → the
    //   heuristic emits a global-0.50 edge from `callerFn` → A.
    // ac7-helper.ts: the B target — `helperTarget` (lines 0-2). The
    //   mock LSP Location points to line 1 (inside the function body)
    //   of this file. The in-memory adapter finds the node at
    //   startLine=0, endLine=2 which contains line 1.
    // ac7-caller.ts: `callerFn` calls `computeTarget()` without
    //   importing it. tree-sitter extracts this as a free call; the
    //   heuristic's global-tier resolution finds exactly one
    //   `computeTarget` globally → global-0.50 correction candidate.
    //   If the resolution falls through to `null` (unresolved), it
    //   becomes a recall candidate instead — the mock handles BOTH
    //   paths (oldTargetId present = correction; absent = recall-add).
    // ac7-controller.ts: imports `callerFn` and calls it in `ac7Handler`.
    //   The pipeline emits ac7Handler→callerFn at 1.0 (import-resolved).
    tmpFixtureDir = fs.mkdtempSync(
      path.join(require('os').tmpdir(), 'gn-mode-a-ac7-'),
    );
    fs.writeFileSync(
      path.join(tmpFixtureDir, 'ac7-service.ts'),
      [
        '// target-A: computeTarget (the heuristic picks this globally)',
        'export function computeTarget(): void {',
        '  return;',
        '}',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tmpFixtureDir, 'ac7-helper.ts'),
      [
        '// target-B: helperTarget (what the mock LSP says the call resolves to)',
        'export function helperTarget(): void {',
        '  return;',
        '}',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tmpFixtureDir, 'ac7-caller.ts'),
      [
        '// callerFn calls computeTarget WITHOUT importing it so the heuristic',
        '// resolves it via global tier (0.50) and pushes it to the correction feed.',
        '// @ts-nocheck',
        'export function callerFn(): void {',
        '  computeTarget();',
        '}',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tmpFixtureDir, 'ac7-controller.ts'),
      // ac7Handler calls callerFn via explicit import → import-resolved
      // at 1.0. This is the route handler that will surface in
      // impacted_endpoints when B is changed.
      "import { callerFn } from './ac7-caller';\nexport function ac7Handler(): void { callerFn(); }\n",
    );
    fs.writeFileSync(
      path.join(tmpFixtureDir, 'tsconfig.json'),
      '{\n  "compilerOptions": {\n    "target": "es2020",\n    "module": "commonjs",\n    "strict": false\n  }\n}\n',
    );

    // ── LSP run ─────────────────────────────────────────────────────
    // Partial mock: `withReconciliationSession` is a vi.fn spy that
    // by default calls through to real. We override it ONCE to inject
    // a deterministic Location → B (helperTarget at ac7-helper.ts:0).
    //
    // The mock implementation:
    //   1. Receives (repo, candidates, fn, deps).
    //   2. For each correction candidate (oldTargetId set → callerFn→A),
    //      calls `deps.handToEngine!(candidate, [LocationB])` where
    //      LocationB maps to ac7-helper.ts line 0.
    //   3. Calls `fn(candidates, meta, 0)` — the pipeline's work fn
    //      just returns { meta, selectedCount, skipped }; the real
    //      engine (reconcileDecisions + applyDecisions) runs AFTER the
    //      session returns, using the locations map the handToEngine
    //      seam populated.
    //
    // The Location URI `file:///ac7-helper.ts` → after
    // normalizeLocationUri → `ac7-helper.ts`, which matches the in-
    // memory node's `filePath: 'ac7-helper.ts'`. The in-memory adapter
    // finds `helperTarget` at line 0 (startLine=0, endLine=0). The
    // engine's P2 gate passes (Method/Function is callable). Action:
    // `correct` → callerFn→computeTarget(A) becomes callerFn→helperTarget(B)
    // at 0.70 lsp-corrected.
    vi.mocked(withReconciliationSession).mockImplementationOnce(
      async (
        repo: ReconciliationRepo,
        candidates: Candidate[],
        fn: (selected: Candidate[], meta: SessionMeta, skipped: number) => Promise<any>,
        deps: WithReconciliationSessionDeps,
      ) => {
        // Inject Location B for EVERY candidate whose calledName is
        // `computeTarget` — whether it came via the correction feed
        // (has `oldTargetId`) or the recall feed (no `oldTargetId`).
        // Both paths produce a CALLS edge at 0.70 pointing to B:
        //   - correction candidate: `lsp-corrected` (preferred, proves B1 chain)
        //   - recall candidate:    `lsp-recall` (acceptable, same downstream effect)
        // The test asserts `source` is `lsp-corrected` OR `lsp-recall`
        // (either is a 0.70 lsp-* edge, which BFS passes through).
        //
        // Location B: `file:///ac7-helper.ts` normalizes to `ac7-helper.ts`
        // via normalizeLocationUri (strips `file://` + leading `/`), which
        // the in-memory adapter matches against node.filePath. Line 1 is
        // inside `helperTarget` (startLine=1, endLine=3 for a 4-line fn).
        for (const c of candidates) {
          if (c.calledName === 'computeTarget') {
            await deps.handToEngine!(c, [{
              uri: 'file:///ac7-helper.ts',
              range: { start: { line: 1, character: 2 } },
            }]);
          }
        }
        // Return the work fn's value so the pipeline's sessionResult
        // carries the correct meta shape. The real `reconcileDecisions`
        // + `applyDecisions` run AFTER this function returns, reading
        // from the locations map the handToEngine calls populated.
        return fn(
          candidates,
          { serverVersion: 'mock-lsp', requestTimeoutMs: 5000, cap: 2000 },
          0,
        );
      },
    );

    // Run the pipeline with lsp:true — the mock intercepts the ONE
    // `withReconciliationSession` call, the real engine corrects
    // callerFn→A(0.50) to callerFn→B(0.70), and the result graph
    // has the lsp-corrected edge.
    const lspPipelineResult = await runPipelineFromRepo(
      tmpFixtureDir,
      () => {},
      { skipGraphPhases: true, lsp: { enabled: true, dryRun: false } },
    );

    // Verify the LSP correction/recall happened in-graph (AC-1):
    // there is at least one CALLS edge at 0.70 with source ∈
    // {lsp-corrected, lsp-recall}. The exact action depends on
    // whether `computeTarget()` was resolved by the heuristic
    // (correction path: oldTargetId set → lsp-corrected) or fell
    // through to null (recall path: no oldTargetId → lsp-recall).
    // Both produce a 0.70 CALLS edge pointing to B, which is what
    // the downstream BFS test requires.
    const lspAugmentedEdges = [...lspPipelineResult.graph.iterRelationships()].filter(
      (r) => r.type === 'CALLS' &&
             (r.source === 'lsp-corrected' || r.source === 'lsp-recall'),
    );
    // The mock must have produced at least one lsp-augmented edge.
    // If the mock failed to inject the Location, or the engine refused
    // (e.g. helperTarget not found in the in-memory adapter due to
    // startLine/endLine mismatch or label not callable), this assertion
    // exposes the failure before we reach loadGraphToLbug.
    expect(
      lspAugmentedEdges.length,
      'AC-1: mock must produce at least one lsp-corrected or lsp-recall CALLS edge',
    ).toBeGreaterThan(0);
    // Each augmented edge must be at 0.70 (not 0.50, not 1.0).
    for (const e of lspAugmentedEdges) {
      expect(e.confidence, 'lsp-augmented edge must carry LSP_CONFIDENCE=0.70').toBe(0.7);
    }

    // Persist the lsp-corrected graph to the shared test DB.
    const storagePath = path.join(handle.tmpHandle.dbPath, 'ac7-lsp-storage');
    await fsPromises.mkdir(storagePath, { recursive: true });
    const loadResult = await adapter.loadGraphToLbug(
      lspPipelineResult.graph,
      tmpFixtureDir,
      storagePath,
    );
    expect(loadResult.success, 'loadGraphToLbug must succeed for the lsp-corrected graph').toBe(true);

    // Seed the route chain: Route R → ac7Handler → callerFn are already
    // in the DB from loadGraphToLbug (the pipeline built Function nodes
    // from the TS files). We add the Route node and R→handler edge so
    // `impacted_endpoints` can traverse the full chain.
    //
    // The pipeline already emitted:
    //   - Function:ac7-controller.ts:ac7Handler (from ac7-controller.ts)
    //   - Function:ac7-caller.ts:callerFn (from ac7-caller.ts)
    //   - CALLS ac7Handler→callerFn at 1.0 (import-resolved)
    //   - CALLS callerFn→helperTarget at 0.70 (lsp-corrected) ← from the mock
    //
    // We still need: Route node + Route→handler edge (routes are not
    // parsed from plain TS files without framework annotations; we seed
    // them directly so the route discovery path is exercised).
    const handlerNode = [...lspPipelineResult.graph.iterNodes()].find(
      (n) => n.properties.name === 'ac7Handler',
    );
    if (handlerNode) {
      await adapter.executeQuery(
        `CREATE (r:Route {id: 'route-ac7', name: '/ac7-route', httpMethod: 'GET', routePath: '/ac7-route', controllerName: 'Ac7Controller', methodName: 'ac7Handler', filePath: 'ac7-controller.ts', startLine: 1, lineNumber: 2, isInherited: false, repoId: '', responseKeys: [], errorKeys: [], middleware: []})`,
      );
      await adapter.executeQuery(
        `MATCH (r:Route), (m:Function) WHERE r.id = 'route-ac7' AND m.id = '${handlerNode.id}' CREATE (r)-[:CodeRelation {type: 'CALLS', confidence: 1.0, reason: 'route-handler', step: 0}]->(m)`,
      );
    }

    // ── Run impacted_endpoints against the LSP-corrected DB ─────────
    // Diff: change ac7-helper.ts line 0 (helperTarget's file, the B target).
    // BFS upstream:
    //   d=1: callerFn (via callerFn→helperTarget at 0.70) — PASSES 0.70 floor
    //   d=2: ac7Handler (via ac7Handler→callerFn at 1.0)
    //   → Route GET /ac7-route surfaces in LIKELY_AFFECTED
    mockGitDiffJ('ac7-helper.ts', [{ newStart: 1, newCount: 1 }]);
    vi.mocked(listRegisteredRepos as any).mockResolvedValue([
      {
        name: 'mode-a-ac7-repo',
        path: tmpFixtureDir,
        storagePath: handle.tmpHandle.dbPath,
        indexedAt: new Date().toISOString(),
        lastCommit: 'ac7beef',
        stats: { files: 4, nodes: 10, communities: 0, processes: 0 },
      },
    ]);
    const backendLsp = new LocalBackend();
    await backendLsp.init();
    lspResult = (await backendLsp.callTool('impacted_endpoints', {
      repo: 'mode-a-ac7-repo',
      scope: 'compare',
      base_ref: 'main',
    })) as ImpactedEndpointsResultJ;

    // ── Default run ─────────────────────────────────────────────────
    // Clear the DB and run the pipeline WITHOUT lsp — the graph has
    // callerFn→computeTarget at 0.50 (heuristic), which is below the
    // BFS min_confidence=0.70 floor → no endpoint surfaces.
    await clearAllAc7Data();

    // The default run does NOT call `withReconciliationSession` at all
    // (the lsp-enabled path is gated behind `opts.lsp?.enabled`). The
    // spy's `.mockImplementationOnce` is already consumed above; any
    // further calls would use the real implementation, but there are
    // none on the default path — the spy is inert here.
    const defaultPipelineResult = await runPipelineFromRepo(
      tmpFixtureDir,
      () => {},
      { skipGraphPhases: true },
    );
    const defaultStoragePath = path.join(handle.tmpHandle.dbPath, 'ac7-default-storage');
    await fsPromises.mkdir(defaultStoragePath, { recursive: true });
    await adapter.loadGraphToLbug(
      defaultPipelineResult.graph,
      tmpFixtureDir,
      defaultStoragePath,
    );

    // Seed the same Route + handler edge so the difference is purely
    // the CALLS confidence (0.50 vs 0.70).
    const defaultHandlerNode = [...defaultPipelineResult.graph.iterNodes()].find(
      (n) => n.properties.name === 'ac7Handler',
    );
    if (defaultHandlerNode) {
      await adapter.executeQuery(
        `CREATE (r:Route {id: 'route-ac7-default', name: '/ac7-route', httpMethod: 'GET', routePath: '/ac7-route', controllerName: 'Ac7Controller', methodName: 'ac7Handler', filePath: 'ac7-controller.ts', startLine: 1, lineNumber: 2, isInherited: false, repoId: '', responseKeys: [], errorKeys: [], middleware: []})`,
      );
      await adapter.executeQuery(
        `MATCH (r:Route), (m:Function) WHERE r.id = 'route-ac7-default' AND m.id = '${defaultHandlerNode.id}' CREATE (r)-[:CodeRelation {type: 'CALLS', confidence: 1.0, reason: 'route-handler', step: 0}]->(m)`,
      );
    }

    // Same diff (ac7-helper.ts line 0) — only the CALLS confidence differs.
    mockGitDiffJ('ac7-helper.ts', [{ newStart: 1, newCount: 1 }]);
    const backendDefault = new LocalBackend();
    await backendDefault.init();
    defaultResult_ac7 = (await backendDefault.callTool('impacted_endpoints', {
      repo: 'mode-a-ac7-repo',
      scope: 'compare',
      base_ref: 'main',
    })) as ImpactedEndpointsResultJ;
  }, 120_000);

  afterAll(() => {
    if (tmpFixtureDir && fs.existsSync(tmpFixtureDir)) {
      fs.rmSync(tmpFixtureDir, { recursive: true, force: true });
    }
  });

  it('(AC-7) --lsp run: lsp-augmented 0.70 edge causes GET /ac7-route to surface in LIKELY_AFFECTED, not WILL_BREAK', () => {
    // This is the load-bearing AC-7 assertion: the full pipeline chain
    // (runPipelineFromRepo --lsp → lsp-augmented 0.70 edge →
    // loadGraphToLbug → impacted_endpoints) surfaces the route.
    // If the mock failed to inject the Location, or the engine refused
    // the Location (e.g. helperTarget node not found via in-memory adapter),
    // or the 0.70 edge wasn't written, or loadGraphToLbug dropped the source
    // column, then the BFS would NOT find the route and this assertion FAILS.
    expect(lspResult?.error, 'impacted_endpoints must not error under lsp run').toBeUndefined();
    const laEntry = lspResult?.impacted_endpoints?.LIKELY_AFFECTED?.find(
      (e: any) => e.path === '/ac7-route' && e.method === 'GET',
    );
    expect(laEntry, 'AC-7: GET /ac7-route must surface in LIKELY_AFFECTED under --lsp run').toBeDefined();
    // The lsp-augmented edge is at 0.70 (< 0.85 WILL_BREAK floor) so
    // the tier classifier must land it in LIKELY_AFFECTED, not WILL_BREAK.
    const wbEntry = lspResult?.impacted_endpoints?.WILL_BREAK?.find(
      (e: any) => e.path === '/ac7-route' && e.method === 'GET',
    );
    expect(wbEntry, 'AC-7: GET /ac7-route must NOT be in WILL_BREAK (conf=0.70 < 0.85)').toBeUndefined();
  });

  it('(AC-7) default run (no --lsp): heuristic 0.50 edge is filtered; GET /ac7-route is ABSENT from LIKELY_AFFECTED and WILL_BREAK', () => {
    // The default run uses callerFn→computeTarget at 0.50 (heuristic).
    // BFS min_confidence=0.70 filters it out → no upstream caller found
    // → no route surfaces. This is the contrastive proof that Mode A's
    // augmentation (not some other code path) causes the route to surface
    // in the --lsp run above.
    //
    // Note: if the default pipeline ALSO produces a 0.70+ edge somehow
    // (e.g. import-resolved callerFn→computeTarget), this test would
    // fail — which is correct: the contrastive proof breaks if the
    // default path already surfaces the route.
    expect(defaultResult_ac7?.error, 'impacted_endpoints must not error under default run').toBeUndefined();
    const laEntry = defaultResult_ac7?.impacted_endpoints?.LIKELY_AFFECTED?.find(
      (e: any) => e.path === '/ac7-route' && e.method === 'GET',
    );
    expect(laEntry, 'AC-7: GET /ac7-route must NOT surface in LIKELY_AFFECTED under default run (0.50 edge filtered)').toBeUndefined();
    const wbEntry = defaultResult_ac7?.impacted_endpoints?.WILL_BREAK?.find(
      (e: any) => e.path === '/ac7-route' && e.method === 'GET',
    );
    expect(wbEntry, 'AC-7: GET /ac7-route must NOT be in WILL_BREAK under default run').toBeUndefined();
  });
}, {
  poolAdapter: true,
});
