/**
 * U3 (#2083 M3) — pure taint propagation engine.
 *
 * Fixtures parse REAL source through the harvest + match harness (the
 * model-match.test.ts pattern): CFGs and SiteRecords come from the worker-side
 * TS CFG visitor, def→use facts from the real reaching-defs solver, and
 * matches from the real import-aware matcher — `computeTaintFlows` consumes
 * the exact structures U4 will feed it, never hand-built mocks.
 *
 * Sanitizer semantics under test (the KIND-SET exclusion model, which
 * subsumes the plan's binary kill — see propagate.ts module doc): a def
 * produced through a sanitizer is tainted-with-exclusions; a sink fires
 * unless its kind is in the taint's accumulated neutralized set. Mechanics
 * tests therefore use a custom spec whose `escape` neutralizes the test
 * sink's own kind (so "killed" scenarios read like the plan's binary
 * scenarios); the kind-set tests at the bottom exercise the real built-in
 * model where neutralization is deliberately kind-scoped.
 */

import { describe, it, expect } from 'vitest';
import { cfgOf, importsFor } from '../../helpers/ts-cfg-harness.js';
import type { FunctionCfg } from '../../../src/core/ingestion/cfg/types.js';
import {
  computeReachingDefs,
  type FunctionDefUse,
  type ReachingDefsLimits,
} from '../../../src/core/ingestion/cfg/reaching-defs.js';
import { hasTaintSafeSites } from '../../../src/core/ingestion/taint/site-safety.js';
import type { SourceSinkSanitizerSpec } from '../../../src/core/ingestion/taint/source-sink-config.js';
import { TS_JS_TAINT_MODEL } from '../../../src/core/ingestion/taint/typescript-model.js';
import {
  buildTaintImportIndex,
  matchFunctionSites,
} from '../../../src/core/ingestion/taint/match.js';
import {
  computeTaintFlows,
  type FunctionTaintResult,
  type TaintLimits,
} from '../../../src/core/ingestion/taint/propagate.js';

/** The single binding index for `name` (throws when shadowed/ambiguous). */
function bindingIdx(cfg: FunctionCfg, name: string): number {
  const idxs = (cfg.bindings ?? []).map((b, i) => (b.name === name ? i : -1)).filter((i) => i >= 0);
  if (idxs.length !== 1) throw new Error(`expected 1 binding for ${name}, got ${idxs.length}`);
  return idxs[0];
}

/**
 * Mechanics spec: a global `exec` sink and a global `escape` sanitizer that
 * neutralizes the SAME kind — so interposition/kill mechanics behave like the
 * plan's binary-kill scenarios while still flowing through the kind-set model.
 */
const MECH: SourceSinkSanitizerSpec = {
  sources: [
    {
      kind: 'remote-input',
      objects: ['req'],
      properties: ['body', 'query', 'params', 'headers'],
    },
  ],
  sinks: [{ name: 'exec', kind: 'command-injection', args: [0], global: true }],
  sanitizers: [{ name: 'escape', neutralizes: ['command-injection'], global: true }],
};

interface AnalyzeOptions {
  fnIndex?: number;
  spec?: SourceSinkSanitizerSpec;
  limits?: TaintLimits;
  factLimits?: ReachingDefsLimits;
}

function analyze(code: string, opts: AnalyzeOptions = {}): FunctionTaintResult {
  const cfg = cfgOf(code, opts.fnIndex ?? 0);
  expect(hasTaintSafeSites(cfg)).toBe(true);
  const defUse = computeReachingDefs(cfg, opts.factLimits);
  const matches = matchFunctionSites(
    cfg,
    opts.spec ?? MECH,
    buildTaintImportIndex(importsFor(code)),
  );
  return computeTaintFlows(cfg, defUse, matches, opts.limits);
}

/** Hop summaries `name@line` (`name@line*` when viaCall) for readable asserts. */
function hopSummary(r: FunctionTaintResult, findingIdx = 0): string[] {
  const f = r.findings[findingIdx];
  if (!f) throw new Error(`no finding at index ${findingIdx}`);
  return f.hops.map((h) => `${h.name}@${h.point.line}${h.viaCall ? '*' : ''}`);
}

// ── statuses and the empty case ──────────────────────────────────────────────

describe('coverage-gap statuses (R4)', () => {
  it('a truncated FunctionDefUse yields a coverage-gap result with zero findings', () => {
    const r = analyze(
      `function f(req) {
        const b = req.body;
        const c = b;
        exec(c);
      }`,
      { factLimits: { maxFacts: 1 } },
    );
    expect(r.status).toBe('coverage-gap');
    expect(r.gapReason).toBe('truncated');
    expect(r.findings).toHaveLength(0);
    expect(r.kills).toHaveLength(0);
  });

  it('a no-facts FunctionDefUse (no binding table) yields a coverage-gap result', () => {
    const cfg = cfgOf(`function f(req) { exec(req.body); }`);
    const { bindings: _bindings, ...noBindings } = cfg;
    const defUse = computeReachingDefs(noBindings as FunctionCfg);
    expect(defUse.status).toBe('no-facts');
    const matches = matchFunctionSites(cfg, MECH, buildTaintImportIndex([]));
    const r = computeTaintFlows(cfg, defUse, matches);
    expect(r.status).toBe('coverage-gap');
    expect(r.gapReason).toBe('no-facts');
    expect(r.findings).toHaveLength(0);
  });

  it('an overflow FunctionDefUse yields a coverage-gap result (contract input shape)', () => {
    const cfg = cfgOf(`function f(req) { exec(req.body); }`);
    const overflow: FunctionDefUse = {
      status: 'overflow',
      bindings: cfg.bindings ?? [],
      facts: [],
      defCount: 0,
      useCount: 0,
    };
    const matches = matchFunctionSites(cfg, MECH, buildTaintImportIndex([]));
    const r = computeTaintFlows(cfg, overflow, matches);
    expect(r.status).toBe('coverage-gap');
    expect(r.gapReason).toBe('overflow');
  });

  it('no sources and no sinks → computed, empty result', () => {
    const r = analyze(`function f(x) { const y = x; return y; }`);
    expect(r.status).toBe('computed');
    expect(r.findings).toHaveLength(0);
    expect(r.kills).toHaveLength(0);
    expect(r.droppedFindings).toBe(0);
  });
});

// ── rule (b): statement-local source→sink ────────────────────────────────────

describe('rule (b) — statement-local findings', () => {
  it('exec(req.body) → one finding with a single hop', () => {
    const r = analyze(`function f(req) {
      exec(req.body);
    }`);
    expect(r.status).toBe('computed');
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect(f.sinkKind).toBe('command-injection');
    expect(f.source.property).toBe('body');
    expect(f.source.point.line).toBe(2);
    expect(f.sink.point.line).toBe(2);
    expect(f.sink.argIndex).toBe(0);
    expect(f.hops).toHaveLength(1);
    expect(f.hops[0].name).toBe('req');
  });

  it('exec(req.body, req.query) → TWO findings distinguished by occurrence (KTD6 identity)', () => {
    const spec: SourceSinkSanitizerSpec = {
      ...MECH,
      sinks: [{ name: 'exec', kind: 'command-injection', args: [0, 1], global: true }],
    };
    const r = analyze(`function f(req) { exec(req.body, req.query); }`, { spec });
    expect(r.findings).toHaveLength(2);
    const ids = r.findings.map((f) => `${f.source.property}@arg${f.sink.argIndex}`);
    expect(ids).toEqual(['body@arg0', 'query@arg1']);
  });

  it('exec(req.body.toString()) → finding via the statement-local rule', () => {
    const r = analyze(`function f(req) { exec(req.body.toString()); }`);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].source.property).toBe('body');
  });

  it('a source read at an UNREGISTERED sink position produces no finding', () => {
    const r = analyze(`function f(req) { exec('ls', req.body); }`);
    expect(r.findings).toHaveLength(0);
  });
});

// ── rule (a): happy path and chains ──────────────────────────────────────────

describe('rule (a) — worklist over def→use facts', () => {
  it('same-block flow: const b = req.body; exec(b) → finding with hop chain', () => {
    const r = analyze(`function f(req) {
      const b = req.body;
      exec(b);
    }`);
    expect(r.findings).toHaveLength(1);
    expect(hopSummary(r)).toEqual(['b@2', 'b@3']);
    expect(r.findings[0].source.property).toBe('body');
    expect(r.findings[0].sink.point.line).toBe(3);
  });

  it('reassignment chain carries variables per hop: b@L2 → c@L3 → sink@L4', () => {
    const r = analyze(`function f(req) {
      const b = req.body;
      const c = b;
      exec(c);
    }`);
    expect(r.findings).toHaveLength(1);
    expect(hopSummary(r)).toEqual(['b@2', 'c@3', 'c@4']);
  });

  it('cross-block flow through a branch reaches the sink', () => {
    const r = analyze(`function f(req, cond) {
      const b = req.body;
      let c = '';
      if (cond) {
        c = b;
      }
      exec(c);
    }`);
    expect(r.findings).toHaveLength(1);
    expect(hopSummary(r)).toEqual(['b@2', 'c@5', 'c@7']);
  });
});

// ── sanitizer interposition and kills (KTD4 both clauses) ───────────────────

describe('sanitizers — interposition, kill locality, kind sets (mechanics spec)', () => {
  it('seed interposition: const b = escape(req.body) → no finding, SANITIZES kill on b', () => {
    const r = analyze(`function f(req) {
      const b = escape(req.body);
      exec(b);
    }`);
    expect(r.findings).toHaveLength(0);
    expect(r.kills).toHaveLength(1);
    const cfg = cfgOf(`function f(req) {
      const b = escape(req.body);
      exec(b);
    }`);
    expect(r.kills[0].bindingIdx).toBe(bindingIdx(cfg, 'b'));
    expect(r.kills[0].sanitizer.line).toBe(2);
    expect([...r.kills[0].neutralized]).toEqual(['command-injection']);
  });

  it('sink interposition: exec(escape(x)) with x tainted → no finding, kill recorded', () => {
    const r = analyze(`function f(req) {
      const x = req.body;
      exec(escape(x));
    }`);
    expect(r.findings).toHaveLength(0);
    expect(r.kills).toHaveLength(1);
    expect(r.kills[0].sanitizer.line).toBe(3);
    expect([...r.kills[0].neutralized]).toEqual(['command-injection']);
  });

  it('bypass occurrence: const c = cond ? escape(x) : x → finding (direct path bypasses)', () => {
    // The ternary's escape call deliberately gets NO resultDefs (U1) — c is
    // floor-tainted with the EMPTY exclusion set (intersection over paths:
    // the direct `x` arm contributes ∅, so ∅ ∩ {command-injection} = ∅).
    const r = analyze(`function f(req, cond) {
      const x = req.body;
      const c = cond ? escape(x) : x;
      exec(c);
    }`);
    expect(r.findings).toHaveLength(1);
    expect(r.kills).toHaveLength(0);
  });

  it('intra-statement bypass at the sink: exec(x + escape(x)) → finding (plain occurrence wins)', () => {
    const r = analyze(`function f(req) {
      const x = req.body;
      exec(x + escape(x));
    }`);
    expect(r.findings).toHaveLength(1);
    // a BYPASSED sanitizer killed nothing — no SANITIZES record
    expect(r.kills).toHaveLength(0);
  });

  it('kill locality (KTD4b): const c = escape(b); exec(b) → finding on b AND a kill on c', () => {
    const code = `function f(req) {
      const b = req.body;
      const c = escape(b);
      exec(b);
    }`;
    const r = analyze(code);
    expect(r.findings).toHaveLength(1);
    expect(hopSummary(r)).toEqual(['b@2', 'b@4']);
    expect(r.kills).toHaveLength(1);
    expect(r.kills[0].bindingIdx).toBe(bindingIdx(cfgOf(code), 'c'));
  });

  it('sanitizer self-assign: b = escape(b); exec(b) → no finding, one kill', () => {
    const r = analyze(`function f(req) {
      let b = req.body;
      b = escape(b);
      exec(b);
    }`);
    expect(r.findings).toHaveLength(0);
    expect(r.kills).toHaveLength(1);
    expect(r.kills[0].sanitizer.line).toBe(3);
  });

  it('a sanitizer reached only through a SPREAD argument does not neutralize (position unprovable)', () => {
    // `escape(...arr)` — the runtime argument positions are unknowable, so
    // claiming the sanitized position received the taint would risk a false
    // kill. Sound direction: taint flows through un-neutralized.
    const r = analyze(`function f(req) {
      const arr = [req.body];
      const b = escape(...arr);
      exec(b);
    }`);
    expect(r.findings).toHaveLength(1);
    expect(r.kills).toHaveLength(0);
  });

  it('conditional sanitizer does NOT suppress: if (cond) { b = escape(b) } exec(b) → finding', () => {
    const r = analyze(`function f(req, cond) {
      let b = req.body;
      if (cond) {
        b = escape(b);
      }
      exec(b);
    }`);
    expect(r.findings).toHaveLength(1);
    // the seed def's flow survives the may-path; the sanitized def is killed
    expect(hopSummary(r)).toEqual(['b@2', 'b@6']);
    expect(r.kills).toHaveLength(1);
  });
});

// ── loop semantics: zero-iteration pair, fixpoint termination ───────────────

describe('loops — kill keyed on the def point, monotone termination (R3)', () => {
  it('zero-iteration while: the cond-false exit carries the seed def → finding SURVIVES', () => {
    const r = analyze(`function f(req, c) {
      let x = req.body;
      while (c) {
        x = escape(x);
      }
      exec(x);
    }`);
    expect(r.findings).toHaveLength(1);
    expect(hopSummary(r)).toEqual(['x@2', 'x@6']);
    expect(r.kills).toHaveLength(1);
  });

  it('do-while: the body always runs → no finding (and escape-in-loop does not re-taint)', () => {
    const r = analyze(`function f(req, c) {
      let x = req.body;
      do {
        x = escape(x);
      } while (c);
      exec(x);
    }`);
    expect(r.findings).toHaveLength(0);
    expect(r.kills).toHaveLength(1);
  });

  it('loop self-taint terminates: x = x + t in a for loop → finding, bounded', () => {
    const r = analyze(`function f(req) {
      const t = req.body;
      let x = '';
      for (let i = 0; i < 3; i++) {
        x = x + t;
      }
      exec(x);
    }`);
    expect(r.status).toBe('computed');
    expect(r.findings).toHaveLength(1);
  });

  it('assign-and-test: if ((m = re.exec(s)) && m) exec(m) → finding (self-fact handled)', () => {
    const r = analyze(`function f(req, re) {
      const s = req.body;
      let m;
      if ((m = re.exec(s)) && m) {
        exec(m);
      }
    }`);
    expect(r.findings).toHaveLength(1);
  });
});

// ── propagate-through unmodeled calls (KTD5) ─────────────────────────────────

describe('propagate-through — unmodeled calls and receivers, viaCall marks', () => {
  it('const y = helper(t); exec(y) → finding with a viaCall hop', () => {
    const r = analyze(`function f(req) {
      const t = req.body;
      const y = helper(t);
      exec(y);
    }`);
    expect(r.findings).toHaveLength(1);
    expect(hopSummary(r)).toEqual(['t@2', 'y@3*', 'y@4']);
  });

  it('receiver propagation: const cmd = t.trim(); exec(cmd) → finding (TITO)', () => {
    const r = analyze(`function f(req) {
      const t = req.body;
      const cmd = t.trim();
      exec(cmd);
    }`);
    expect(r.findings).toHaveLength(1);
    expect(hopSummary(r)).toEqual(['t@2', 'cmd@3*', 'cmd@4']);
  });

  it('tainted occurrence nested in an unmodeled call AT the sink fires: exec(helper(t))', () => {
    const r = analyze(`function f(req) {
      const t = req.body;
      exec(helper(t));
    }`);
    expect(r.findings).toHaveLength(1);
    // the sink hop records that the occurrence flowed through a call
    const sinkHop = r.findings[0].hops.at(-1);
    expect(sinkHop?.viaCall).toBe(true);
  });

  it('sanitized through-call: const y = helper(escape(x)); exec(y) → NO finding', () => {
    // Deliberate precision choice over flat-conservative (plan KTD5): the only
    // occurrence path into the unmodeled call traverses the sanitizer, so the
    // neutralization rides through the call into y's exclusion set.
    const r = analyze(`function f(req) {
      const x = req.body;
      const y = helper(escape(x));
      exec(y);
    }`);
    expect(r.findings).toHaveLength(0);
  });
});

// ── statement-coalescing precision floor ─────────────────────────────────────

describe('precision floor — multi-declarator conflation (documented FP)', () => {
  it('const a = clean(z), b = g(t); exec(a) → finding EXISTS (expected false positive)', () => {
    // PINNED FP (plan risk table): statement facts conflate declarators — `t`
    // is used by the statement and `a` is def'd by it, so `a` is floor-tainted
    // even though `t` flows only into `g(...)`. The per-declarator resultDefs
    // precision powers KILLS only (U1 note); widening it to taint attribution
    // would be an unsound narrowing of the substrate's statement granularity.
    const r = analyze(`function f(req, z) {
      const t = req.body;
      const a = clean(z), b = g(t);
      exec(a);
    }`);
    expect(r.findings).toHaveLength(1);
  });

  it('the floor never KILLS: a def in a sanitizer resultDefs with no taint inflow is floor-tainted', () => {
    // `a = escape(z)` — the tainted `t` never flows into escape, so no kill is
    // recorded for it and `a` is floor-tainted with NO exclusions (sound: a
    // kill requires evidence of flow through the sanitizer).
    const r = analyze(`function f(req, z) {
      const t = req.body;
      const a = escape(z), b = g(t);
      exec(a);
    }`);
    expect(r.findings).toHaveLength(1);
    expect(r.kills).toHaveLength(0);
  });
});

// ── sequence-expression value semantics (review fix) ────────────────────────

describe('sequence expressions — only the final operand carries taint', () => {
  it('exec((log(x), "safe")) with tainted x → NO finding (safe operand flows)', () => {
    const r = analyze(`function f(req) { const x = req.body; exec((log(x), 'safe')); }`);
    expect(r.findings).toHaveLength(0);
  });

  it('exec((log("a"), x)) with tainted x → finding (tainted final operand)', () => {
    const r = analyze(`function f(req) { const x = req.body; exec((log('a'), x)); }`);
    expect(r.findings).toHaveLength(1);
  });
});

// ── source-discriminated taint state (review fix: multi-source merge) ───────

describe('multi-source identity — distinct sources do not merge at one def', () => {
  // A spec with two source properties and a sql sanitizer, so the same-source
  // ∅-intersection case has a kind to neutralize.
  const MULTI: SourceSinkSanitizerSpec = {
    sources: [{ kind: 'remote-input', objects: ['req'], properties: ['body', 'query'] }],
    sinks: [
      { name: 'exec', kind: 'command-injection', args: [0], global: true },
      { name: 'query', kind: 'sql-injection', args: [0], anyReceiver: true },
    ],
    sanitizers: [{ name: 'escape', neutralizes: ['sql-injection'], global: true }],
  };

  it('cond ? req.body : req.query into one var → TWO findings (one per source)', () => {
    const r = analyze(`function f(req, cond) { const x = cond ? req.body : req.query; exec(x); }`, {
      spec: MULTI,
    });
    expect(r.findings).toHaveLength(2);
    const props = r.findings.map((f) => f.source.property).sort();
    expect(props).toEqual(['body', 'query']);
  });

  it('req.body + req.query into one var → TWO findings', () => {
    const r = analyze(`function f(req) { const x = req.body + req.query; exec(x); }`, {
      spec: MULTI,
    });
    expect(r.findings).toHaveLength(2);
  });

  it('same-source two-path flow → ONE finding (one root source occurrence)', () => {
    // `req.body` is read ONCE (one source occurrence → one root identity); the
    // single tainted `x` then flows two ways into `c`. Both paths share the
    // same source discriminator, so they converge on one state for `c` and
    // produce exactly one finding — the source dimension must not split a
    // single source occurrence by downstream path.
    const r = analyze(
      `function f(req, cond) { const x = req.body; const c = cond ? id(x) : x; db.query(c); }`,
      { spec: MULTI },
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].sinkKind).toBe('sql-injection');
  });

  it('one source re-derived into one sink var → ONE finding, no doubling', () => {
    // A single source reaching a single sink binding via a re-derived path
    // dedups to one finding (findingsByIdentity); the source dimension in the
    // state key must not split this same-source flow.
    const r = analyze(`function f(req, cond) { let x = req.body; if (cond) { x = x; } exec(x); }`, {
      spec: MULTI,
    });
    expect(r.findings).toHaveLength(1);
  });

  it('two sources through a loop back-edge terminate with TWO findings', () => {
    const r = analyze(
      `function f(req, n) { let x = req.body; for (let i = 0; i < n; i++) { x = x + req.query; } exec(x); }`,
      { spec: MULTI },
    );
    expect(r.status).toBe('computed');
    expect(r.findings).toHaveLength(2);
  });
});

// ── kind-set exclusion model (real built-in model) ──────────────────────────

describe('kind-set exclusions — sanitizers neutralize their kinds only', () => {
  it('escape(req.body) → res.send(b) suppressed (xss neutralized) BUT db.query(b) fires (sql not)', () => {
    const r = analyze(
      `import { escape } from 'validator';
function f(req, db, res) {
  const b = escape(req.body);
  db.query(b);
  res.send(b);
}`,
      { spec: TS_JS_TAINT_MODEL },
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].sinkKind).toBe('sql-injection');
    expect(r.findings[0].sink.point.line).toBe(4);
    // the seed kill is still recorded with the kinds escape neutralizes
    expect(r.kills).toHaveLength(1);
    expect([...r.kills[0].neutralized]).toEqual(['xss']);
  });

  it('kind-incompatible sink interposition: exec(path.basename(t)) → finding SURVIVES', () => {
    // basename strips directories, not shell metacharacters — a kind-blind
    // kill here would be a suppressed live command injection (the forbidden
    // false-negative direction).
    const r = analyze(
      `import { exec } from 'child_process';
import path from 'path';
function f(req) {
  const t = req.body;
  exec(path.basename(t));
}`,
      { spec: TS_JS_TAINT_MODEL },
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].sinkKind).toBe('command-injection');
  });

  it('kind-compatible def interposition: const safe = path.basename(t); readFileSync(safe) → suppressed', () => {
    const r = analyze(
      `import path from 'path';
import { readFileSync } from 'fs';
function f(req) {
  const t = req.body;
  const safe = path.basename(t);
  readFileSync(safe);
}`,
      { spec: TS_JS_TAINT_MODEL },
    );
    expect(r.findings).toHaveLength(0);
    expect(r.kills).toHaveLength(1);
    expect([...r.kills[0].neutralized]).toEqual(['path-traversal']);
  });

  it('the same basename-cleaned def still fires a command-injection sink', () => {
    const r = analyze(
      `import { exec } from 'child_process';
import path from 'path';
function f(req) {
  const t = req.body;
  const safe = path.basename(t);
  exec(safe);
}`,
      { spec: TS_JS_TAINT_MODEL },
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].sinkKind).toBe('command-injection');
  });

  it('exclusions intersect over derivations: a less-neutralized re-derivation re-opens the sink', () => {
    // y is first derived through escape ({xss} excluded), then re-derived
    // through the direct assignment (∅) — the intersection is ∅, so the
    // xss sink must fire. Guards the monotone shrink/re-enqueue discipline.
    const r = analyze(
      `import { escape } from 'validator';
function f(req, cond, res) {
  const b = req.body;
  let y = escape(b);
  if (cond) {
    y = b;
  }
  res.send(y);
}`,
      { spec: TS_JS_TAINT_MODEL },
    );
    // two defs of y reach the sink: the escaped one (suppressed for xss) and
    // the raw one (fires) — one finding from the raw def's flow
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].sinkKind).toBe('xss');
  });
});

// ── caps and determinism ─────────────────────────────────────────────────────

describe('caps — deterministic truncation (R6 substrate)', () => {
  const manyFindings = `function f(req) {
    exec(req.body);
    exec(req.query);
    exec(req.params);
    exec(req.headers);
  }`;

  it('maxFindingsPerFunction truncates deterministically and counts the drop', () => {
    const r = analyze(manyFindings, { limits: { maxFindingsPerFunction: 2 } });
    expect(r.findings).toHaveLength(2);
    expect(r.droppedFindings).toBe(2);
    // deterministic prefix of the sorted order: statement order
    expect(r.findings.map((f) => f.source.property)).toEqual(['body', 'query']);
  });

  it('without a cap all findings emit and droppedFindings is 0', () => {
    const r = analyze(manyFindings);
    expect(r.findings).toHaveLength(4);
    expect(r.droppedFindings).toBe(0);
  });

  it('maxHops truncates the hop chain and flags it', () => {
    const r = analyze(
      `function f(req) {
      const a = req.body;
      const b = a;
      const c = b;
      exec(c);
    }`,
      { limits: { maxHops: 2 } },
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].hops).toHaveLength(2);
    expect(r.findings[0].hopsTruncated).toBe(true);
    expect(hopSummary(r)).toEqual(['a@2', 'b@3']);
  });

  it('results are deterministic across repeated runs', () => {
    const code = `function f(req, cond) {
      let x = req.body;
      const y = helper(x);
      if (cond) {
        x = escape(x);
      }
      exec(x);
      exec(y);
      exec(req.query);
    }`;
    const a = analyze(code);
    const b = analyze(code);
    expect(JSON.parse(JSON.stringify(a))).toEqual(JSON.parse(JSON.stringify(b)));
  });
});
