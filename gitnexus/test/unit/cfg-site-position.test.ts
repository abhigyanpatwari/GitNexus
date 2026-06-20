import { describe, it, expect } from 'vitest';
import type { FunctionCfg, SiteRecord } from '../../src/core/ingestion/cfg/types.js';
import { cfgOf } from '../helpers/ts-cfg-harness.js';
import { allSites } from '../helpers/cfg-harness.js';

/**
 * U1 (#2227 follow-up plan) — `SiteRecord.at` call-site anchor position.
 *
 * Each call/new `SiteRecord` is stamped with `at: [line (1-based), col
 * (0-based)]`, recorded by the worker harvester at the call/new node where it
 * reads the callee. A downstream unit joins each site to its resolved callee id
 * by EXACT position, so `at` MUST be the SAME anchor the CALLS-edge resolution
 * keys on (plan KTD7).
 *
 * ANCHOR ALIGNMENT (verified against the scope-extractor): the CALLS `atRange`
 * is `nodeToCapture('@reference.call.*', node).range` where the `@reference.call`
 * anchor is the WHOLE call/new EXPRESSION node (the callee identifier / member
 * property is the `@reference.name` SUB-tag, excluded from the anchor by
 * `anchorCaptureFor` + `KNOWN_SUB_TAGS`; `atRange: anchor.range` at
 * scope-extractor.ts:1030). The harvester's `visitCall`/`visitNew` receives that
 * exact `call_expression`/`new_expression` node and records its `startPosition`,
 * so `at` == the CALLS atRange for every call shape:
 *   - bare call `foo(x)`        → `at` == the bare callee/call-expr start.
 *   - member call `arr.map(x)`  → `at` == the call-expr start, i.e. the receiver
 *                                  `arr`'s position (where `@reference.call.member`
 *                                  anchors), NOT the `.map` property token.
 *   - chained call `a.b.c(x)`   → `at` == the outer call-expr start (`a`).
 *
 * Member-read sites carry no `at` (the resolved-id join only consumes call/new).
 */

/** The call/new sites of `cfg`, in (block, statement, site) order. */
function callSites(cfg: FunctionCfg): SiteRecord[] {
  return allSites(cfg).filter((s) => s.kind === 'call' || s.kind === 'new');
}

/** The single call/new site whose dotted callee path is `callee` (throws otherwise). */
function siteByCallee(cfg: FunctionCfg, callee: string): SiteRecord {
  const matches = callSites(cfg).filter((s) => s.callee === callee);
  if (matches.length !== 1) {
    throw new Error(`expected exactly 1 call site with callee ${callee}, got ${matches.length}`);
  }
  return matches[0];
}

describe('SiteRecord.at — call-site anchor position (U1)', () => {
  it('a bare call `foo(x)` carries `at` of the callee/call-expr anchor', () => {
    // `function f(x) { foo(x); }` — `foo(` starts at column 16 on line 1; for a
    // bare call the call-expression start and the callee identifier coincide, so
    // this is the anchor the CALLS `@reference.call.free` resolution keys on.
    const cfg = cfgOf(`function f(x) { foo(x); }`);
    expect(siteByCallee(cfg, 'foo')).toMatchObject({ kind: 'call', at: [1, 16] });
  });

  it('a member call `arr.map(...)` carries `at` of the resolved-reference anchor (the call-expr / receiver start)', () => {
    // `function f(arr) { arr.map(x => x); }` — `arr.map(...)` is one
    // `call_expression` starting at `arr` (column 18). The CALLS
    // `@reference.call.member` anchor is that whole call_expression, so `at`
    // records the receiver/call-expr start, NOT the `.map` property token (which
    // is only the `@reference.name` sub-tag — plan KTD7).
    const cfg = cfgOf(`function f(arr) { arr.map(x => x); }`);
    expect(siteByCallee(cfg, 'arr.map')).toMatchObject({ kind: 'call', at: [1, 18] });
  });

  it('a chained call `a.b.c(x)` carries `at` of the outer call-expr start (the chain root)', () => {
    // `a.b.c(x)` is one call_expression starting at the chain root `a` (column
    // 19); the `@reference.call.member` anchor and the harvested `at` both land
    // there — the outer call-expr start, not the `.c` property token.
    const cfg = cfgOf(`function f(a, x) { a.b.c(x); }`);
    expect(siteByCallee(cfg, 'a.b.c')).toMatchObject({ kind: 'call', at: [1, 19] });
  });

  it('an argument-position call on a LATER line carries that call`s own line, not the statement head line', () => {
    //   line 2: outer(
    //   line 3:   inner(a)
    //   line 4: );
    // The whole call statement begins on line 2, but the inner argument-position
    // call begins on line 3 — its `SiteRecord.at` line MUST be 3 (the inner
    // call's line). This is the core bug the position field fixes: a
    // statement-line join would mis-attribute `inner`'s resolved id to line 2.
    const cfg = cfgOf(`function f(a, b) {\n  outer(\n    inner(a)\n  );\n}`);
    const outer = siteByCallee(cfg, 'outer');
    const inner = siteByCallee(cfg, 'inner');
    expect(outer).toMatchObject({ kind: 'call', at: [2, 2] });
    expect(inner).toMatchObject({ kind: 'call', at: [3, 4] });
    // The inner call's `at` line is the INNER call's line, distinct from the
    // statement head — assert the inequality unconditionally.
    expect(inner.at?.[0]).toBe(3);
    expect(inner.at?.[0]).not.toBe(outer.at?.[0]);
  });

  it('a `new` site carries `at` of the new-expression anchor', () => {
    // `new User(x)` — `new` starts at column 16; the harvester records the
    // new_expression start, matching `@reference.call.constructor`'s anchor.
    const cfg = cfgOf(`function f(x) { const u = new User(x); return u; }`);
    expect(siteByCallee(cfg, 'User')).toMatchObject({ kind: 'new', at: [1, 26] });
  });

  it('a nested closure `arr.map(x => foo(x))` records ONLY the outer `arr.map` site — `foo` is excluded', () => {
    // The harvester does not record sites inside nested functions (types.ts:150),
    // so `foo(x)` inside the arrow produces NO top-level SiteRecord here. The
    // block's only call site is the outer `arr.map`, carrying its own `at`.
    const cfg = cfgOf(`function f(arr) { arr.map(x => foo(x)); }`);
    const sites = callSites(cfg);
    // Exactly one call site, and it is the outer member call — not `foo`.
    expect(sites).toHaveLength(1);
    expect(sites.map((s) => s.callee)).toEqual(['arr.map']);
    expect(siteByCallee(cfg, 'arr.map')).toMatchObject({ kind: 'call', at: [1, 18] });
    // `foo` produces no site at this level (nested-fn exclusion preserved).
    expect(sites.some((s) => s.callee === 'foo')).toBe(false);
  });

  it('member-read sites carry no `at` (the id join only consumes call/new)', () => {
    // `sink(req.body)` — `req.body` is a value-position member-read site; only
    // the `sink(...)` call site needs an anchor for the resolved-id join.
    const cfg = cfgOf(`function f(req) { sink(req.body); }`);
    const memberReads = allSites(cfg).filter((s) => s.kind === 'member-read');
    expect(memberReads.length).toBeGreaterThan(0);
    // No member-read site carries `at` (omit-when-absent for non-call sites).
    expect(memberReads.every((s) => s.at === undefined)).toBe(true);
    // The enclosing call site does carry one.
    expect(siteByCallee(cfg, 'sink')).toMatchObject({ kind: 'call', at: [1, 18] });
  });
});
