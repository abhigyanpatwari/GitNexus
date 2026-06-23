/**
 * U4 (#2083 M3) — `emitFileTaint` over REAL harvested CFGs.
 *
 * Fixtures parse real source through the worker-side TS CFG visitor (the
 * propagate.test.ts harness): CFGs and sites come from the harvest, imports
 * from the real TS capture+interpret path — the emit driver consumes exactly
 * the structures the run.ts pdg window feeds it, never hand-built mocks
 * (except the deliberate corrupted-store mutation below).
 *
 * Pinned here: KTD6 statement-level finding identity (occurrence-distinct
 * rows for `exec(req.body, req.query)`; variable-distinct rows on a shared
 * block pair), dedup-before-budget with truncate-and-warn, the zero-match
 * fast path (no solver call — asserted via the result counters), the
 * unsafe-sites skip-taint-keep-RD degradation, kills-without-findings, and
 * the decodability of every persisted `reason` via the shared path codec.
 */

import { describe, it, expect } from 'vitest';
import { cfgsOf, importsFor } from '../../helpers/ts-cfg-harness.js';
import { emitFileCfgs } from '../../../src/core/ingestion/cfg/emit.js';
import type { FunctionCfg } from '../../../src/core/ingestion/cfg/types.js';
import type { SourceSinkSanitizerSpec } from '../../../src/core/ingestion/taint/source-sink-config.js';
import {
  emitFileTaint,
  type TaintEmitLimits,
  type TaintEmitResult,
} from '../../../src/core/ingestion/taint/emit.js';
import { decodeTaintPath } from '../../../src/core/ingestion/taint/path-codec.js';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import type { KnowledgeGraph } from '../../../src/core/graph/types.js';
import type { GraphRelationship } from 'gitnexus-shared';

/** Mechanics spec (propagate.test.ts MECH): global exec sink, global escape sanitizer. */
const MECH: SourceSinkSanitizerSpec = {
  sources: [
    { kind: 'remote-input', objects: ['req'], properties: ['body', 'query', 'params', 'headers'] },
  ],
  sinks: [{ name: 'exec', kind: 'command-injection', args: [0], global: true }],
  sanitizers: [{ name: 'escape', neutralizes: ['command-injection'], global: true }],
};

/** MECH with the sink dangerous at EVERY position (`args` omitted). */
const MECH_ALL_ARGS: SourceSinkSanitizerSpec = {
  ...MECH,
  sinks: [{ name: 'exec', kind: 'command-injection', global: true }],
};

const CALL_RESULT_SOURCE_SPEC: SourceSinkSanitizerSpec = {
  sources: [
    {
      type: 'call-result',
      kind: 'remote-input',
      receivers: ['request'],
      methods: ['getParameter'],
    },
  ],
  sinks: [{ name: 'exec', kind: 'command-injection', args: [0], global: true }],
  sanitizers: [],
};

interface RunResult {
  graph: KnowledgeGraph;
  result: TaintEmitResult;
  tainted: GraphRelationship[];
  sanitizes: GraphRelationship[];
  warns: string[];
}

function run(
  code: string,
  opts: { spec?: SourceSinkSanitizerSpec; limits?: TaintEmitLimits; cfgs?: FunctionCfg[] } = {},
): RunResult {
  const graph = createKnowledgeGraph();
  const cfgs = opts.cfgs ?? cfgsOf(code);
  // Emit the M1 layer first so taint endpoints can be checked against REAL
  // persisted BasicBlock nodes (run.ts ordering).
  emitFileCfgs(graph, cfgs);
  const warns: string[] = [];
  const result = emitFileTaint(graph, cfgs, importsFor(code), opts.spec ?? MECH, opts.limits, (m) =>
    warns.push(m),
  );
  const tainted: GraphRelationship[] = [];
  const sanitizes: GraphRelationship[] = [];
  for (const rel of graph.iterRelationships()) {
    if (rel.type === 'TAINTED') tainted.push(rel);
    if (rel.type === 'SANITIZES') sanitizes.push(rel);
  }
  return { graph, result, tainted, sanitizes, warns };
}

function blockIds(graph: KnowledgeGraph): Set<string> {
  const ids = new Set<string>();
  graph.forEachNode((n) => {
    if (n.label === 'BasicBlock') ids.add(n.id);
  });
  return ids;
}

describe('emitFileTaint — happy path', () => {
  const CODE = `
function handler(req: { body: string }) {
  const cmd = req.body;
  exec(cmd);
}`;

  it('persists one TAINTED edge whose endpoints are real BasicBlock nodes', () => {
    const { graph, result, tainted } = run(CODE);
    expect(result.functionsAnalyzed).toBe(1);
    expect(result.findingsEmitted).toBe(1);
    expect(tainted).toHaveLength(1);
    const ids = blockIds(graph);
    expect(ids.has(tainted[0].sourceId)).toBe(true);
    expect(ids.has(tainted[0].targetId)).toBe(true);
    expect(tainted[0].id.startsWith('TAINTED:fixture.ts:')).toBe(true);
  });

  it('preserves the legacy member-read TAINTED edge identity', () => {
    const { tainted } = run(CODE);
    expect(tainted[0].id).toBe(
      'TAINTED:fixture.ts:2:0:command-injection:2:0.0:req:2:17:2:1.0.0:cmd:3:8:exec:body',
    );
  });

  it('persists a call-result source TAINTED edge with deterministic identity', () => {
    const { result, tainted } = run(
      `
function handler(request: { getParameter(name: string): string }) {
  const cmd = request.getParameter('cmd');
  exec(cmd);
}`,
      { spec: CALL_RESULT_SOURCE_SPEC },
    );
    expect(result.functionsAnalyzed).toBe(1);
    expect(result.findingsEmitted).toBe(1);
    expect(tainted).toHaveLength(1);
    expect(tainted[0].id).toBe(
      'TAINTED:fixture.ts:2:0:command-injection:2:0.0:call-result:cmd:3:8:request.getParameter:2:1.0.0:cmd:3:8:exec',
    );
    const decoded = decodeTaintPath(tainted[0].reason);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.kind).toBe('command-injection');
      expect(decoded.hops.map((h) => `${h.variable}@${h.line}`)).toEqual(['cmd@3', 'cmd@4']);
    }
  });

  it('the persisted reason decodes via the shared codec with ordered hops + variables', () => {
    const { tainted } = run(CODE);
    const decoded = decodeTaintPath(tainted[0].reason);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.truncated).toBe(false);
      // The finding's sinkKind rides the `;<kind>` header (the only persisted
      // channel — the edge id embedding it is not a stored column; U6 reads it).
      expect(decoded.kind).toBe('command-injection');
      // seed def (cmd @ const line) → sink use (cmd @ exec line)
      expect(decoded.hops.map((h) => `${h.variable}@${h.line}`)).toEqual(['cmd@3', 'cmd@4']);
    }
  });
});

describe('KTD6 statement-level finding identity', () => {
  it('exec(req.body, req.query) → TWO rows distinguished by occurrence', () => {
    const { result, tainted } = run(
      `
function handler(req: { body: string; query: string }) {
  exec(req.body, req.query);
}`,
      { spec: MECH_ALL_ARGS },
    );
    expect(result.findingsEmitted).toBe(2);
    expect(tainted).toHaveLength(2);
    // Same block pair — the identity (and the id) differ ONLY by occurrence.
    expect(tainted[0].sourceId).toBe(tainted[1].sourceId);
    expect(tainted[0].targetId).toBe(tainted[1].targetId);
    expect(tainted[0].id).not.toBe(tainted[1].id);
  });

  it('two findings on the same block pair with different variables → two rows', () => {
    const { result, tainted } = run(`
function handler(req: { body: string; query: string }) {
  const a = req.body;
  const b = req.query;
  exec(a);
  exec(b);
}`);
    expect(result.findingsEmitted).toBe(2);
    expect(tainted).toHaveLength(2);
    expect(new Set(tainted.map((t) => t.id)).size).toBe(2);
    const variables = tainted.map((t) => {
      const d = decodeTaintPath(t.reason);
      if (!d.ok) throw new Error(d.error);
      return d.hops[d.hops.length - 1].variable;
    });
    expect(variables.sort()).toEqual(['a', 'b']);
  });
});

describe('dedup-before-budget and the findings cap', () => {
  const FOUR_FINDINGS = `
function handler(req: { body: string; query: string }) {
  const a = req.body;
  const b = req.query;
  exec(a);
  exec(b);
  exec(a);
  exec(b);
}`;

  it('uncapped: identical (deduped) flows collapse; distinct ones all emit', () => {
    const { result, tainted } = run(FOUR_FINDINGS);
    // 4 sink statements × 1 variable each — all distinct sink points → 4 rows.
    expect(result.findingsEmitted).toBe(4);
    expect(result.findingsDropped).toBe(0);
    expect(new Set(tainted.map((t) => t.id)).size).toBe(4);
  });

  it('capped: truncates deterministically and warns naming the drop count', () => {
    const { result, tainted, warns } = run(FOUR_FINDINGS, {
      limits: { maxFindingsPerFunction: 1 },
    });
    expect(result.findingsEmitted).toBe(1);
    expect(result.findingsDropped).toBe(3);
    expect(tainted).toHaveLength(1);
    const capWarn = warns.find((w) => w.includes('findings cap'));
    expect(capWarn).toBeDefined();
    expect(capWarn).toContain('dropped 3 of 4');
    expect(result.droppedExamples).toEqual(['fixture.ts:2']);
  });
});

describe('zero-match fast path', () => {
  it('no source AND no sink: function skipped without a solver call', () => {
    const { result, tainted, sanitizes } = run(`
function pure(x: number) {
  const y = x + 1;
  return y;
}`);
    expect(result.functionsSkippedNoMatch).toBe(1);
    expect(result.functionsAnalyzed).toBe(0);
    expect(tainted).toHaveLength(0);
    expect(sanitizes).toHaveLength(0);
  });

  it('sink without source (and vice versa) also short-circuits', () => {
    const { result } = run(`
function sinkOnly(cmd: string) {
  exec(cmd);
}
function sourceOnly(req: { body: string }) {
  return req.body;
}`);
    expect(result.functionsSkippedNoMatch).toBe(2);
    expect(result.functionsAnalyzed).toBe(0);
    expect(result.findingsEmitted).toBe(0);
  });
});

describe('unsafe-sites degradation (skip-taint-keep-RD)', () => {
  const TWO_FNS = `
function corrupted(req: { body: string }) {
  exec(req.body);
}
function stillVulnerable(req: { body: string }) {
  exec(req.body);
}`;

  it('a corrupted-store site skips ONLY that function; siblings still emit', () => {
    const cfgs = JSON.parse(JSON.stringify(cfgsOf(TWO_FNS))) as FunctionCfg[];
    // Corrupt the first function's first site: out-of-range binding index.
    let mutated = false;
    outer: for (const block of cfgs[0].blocks) {
      for (const stmt of block.statements ?? []) {
        if (stmt.sites !== undefined && stmt.sites.length > 0) {
          (stmt.sites[0] as { object?: number }).object = 9999;
          mutated = true;
          break outer;
        }
      }
    }
    expect(mutated).toBe(true);

    const { result, tainted, warns } = run(TWO_FNS, { cfgs });
    expect(result.functionsSkippedUnsafeSites).toBe(1);
    expect(result.functionsAnalyzed).toBe(1);
    expect(result.findingsEmitted).toBe(1); // the sibling's finding survives
    expect(tainted).toHaveLength(1);
    expect(tainted[0].id).toContain('fixture.ts:5'); // the SECOND function
    expect(warns.some((w) => w.includes('malformed site annotations'))).toBe(true);
    expect(result.coverageGapExamples).toEqual(['fixture.ts:2']);
  });
});

describe('kills without findings', () => {
  it('a fully-sanitized flow emits SANITIZES and zero TAINTED', () => {
    const { graph, result, tainted, sanitizes } = run(`
function safe(req: { body: string }) {
  const b = escape(req.body);
  exec(b);
}`);
    expect(result.functionsAnalyzed).toBe(1);
    expect(result.findingsEmitted).toBe(0);
    expect(tainted).toHaveLength(0);
    expect(result.killsEmitted).toBe(1);
    expect(sanitizes).toHaveLength(1);
    // reason = the killed binding's plain name; endpoints are real blocks.
    expect(sanitizes[0].reason).toBe('b');
    expect(sanitizes[0].id.startsWith('SANITIZES:fixture.ts:')).toBe(true);
    const ids = blockIds(graph);
    expect(ids.has(sanitizes[0].sourceId)).toBe(true);
    expect(ids.has(sanitizes[0].targetId)).toBe(true);
  });

  it('a kill alongside a finding emits both edge kinds', () => {
    const { result } = run(`
function mixed(req: { body: string; query: string }) {
  const safe = escape(req.body);
  exec(safe);
  exec(req.query);
}`);
    expect(result.killsEmitted).toBe(1);
    expect(result.findingsEmitted).toBe(1);
  });
});

describe('hop truncation accounting', () => {
  it('maxHops=1 truncates the persisted path and counts the finding', () => {
    const { result, tainted } = run(
      `
function handler(req: { body: string }) {
  const a = req.body;
  const b = a;
  exec(b);
}`,
      { limits: { maxHops: 1 } },
    );
    expect(result.findingsEmitted).toBe(1);
    expect(result.hopsTruncatedFindings).toBe(1);
    const decoded = decodeTaintPath(tainted[0].reason);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.truncated).toBe(true); // path-incomplete, not an error
      expect(decoded.hops).toHaveLength(1); // source-side prefix
      expect(decoded.hops[0].variable).toBe('a');
    }
  });
});

describe('telemetry completeness', () => {
  it('every counter field is present (nothing dropped on the floor — the M2 lesson)', () => {
    const { result } = run(`function noop() { return 1; }`);
    expect(result).toEqual({
      functionsAnalyzed: 0,
      functionsSkippedNoMatch: 1,
      functionsSkippedUnsafeSites: 0,
      functionsCoverageGap: { truncated: 0, overflow: 0, 'no-facts': 0 },
      findingsEmitted: 0,
      killsEmitted: 0,
      findingsDropped: 0,
      hopsTruncatedFindings: 0,
      coverageGapExamples: [],
      droppedExamples: [],
    });
  });

  it('a solver coverage gap (fact limit) is counted by reason, with an example anchor', () => {
    const { result, tainted } = run(
      `
function gap(req: { body: string }) {
  const a = req.body;
  const b = a;
  const c = b;
  exec(c);
}`,
      { limits: { maxFacts: 1 } },
    );
    expect(result.functionsCoverageGap.truncated).toBe(1);
    expect(result.functionsAnalyzed).toBe(0);
    expect(tainted).toHaveLength(0); // R4: never partially analyzed
    expect(result.coverageGapExamples).toEqual(['fixture.ts:2']);
  });
});
