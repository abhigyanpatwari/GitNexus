import { describe, it, expect } from 'vitest';
import type { FunctionCfg, StatementFacts } from '../../../src/core/ingestion/cfg/types.js';
import { cfgOf } from '../../helpers/ts-cfg-harness.js';

// U1 (#2082 M2) — per-statement def/use harvesting. The two-phase design
// (declaration pre-scan → resolve during the CFG walk) is what makes the
// walk-order traps pass: the visitor walks finally-before-try, for-init-last,
// and do-while-condition-first, so declare-as-you-walk would mis-key common
// code. Each test pins names→binding-index agreement, not just presence.

/** All statement facts of the CFG, flattened in (block, statement) order. */
function allFacts(cfg: FunctionCfg): StatementFacts[] {
  return cfg.blocks.flatMap((b) => [...(b.statements ?? [])]);
}

/** Binding indices of every entry named `name`. */
function bindingIdxs(cfg: FunctionCfg, name: string): number[] {
  return (cfg.bindings ?? []).map((b, i) => (b.name === name ? i : -1)).filter((i) => i >= 0);
}

/** The single binding index for `name` (throws when shadowed/ambiguous). */
function bindingIdx(cfg: FunctionCfg, name: string): number {
  const idxs = bindingIdxs(cfg, name);
  if (idxs.length !== 1) throw new Error(`expected 1 binding for ${name}, got ${idxs.length}`);
  return idxs[0];
}

const defsOf = (cfg: FunctionCfg): Set<number> =>
  new Set(allFacts(cfg).flatMap((f) => [...f.defs]));
const usesOf = (cfg: FunctionCfg): Set<number> =>
  new Set(allFacts(cfg).flatMap((f) => [...f.uses]));

describe('TS/JS def/use harvest — basics', () => {
  it('declaration, reassignment, and read produce per-statement def/use facts', () => {
    const cfg = cfgOf(`function f() { let x = 1; x = 2; const y = x; }`);
    const x = bindingIdx(cfg, 'x');
    const y = bindingIdx(cfg, 'y');
    // x and y are the only declared (non-synthetic) bindings
    expect((cfg.bindings ?? []).filter((b) => !b.synthetic)).toHaveLength(2);
    // the three statements coalesce into ONE block with three fact records
    const body = cfg.blocks.find((b) => b.text.includes('let x = 1'));
    expect(body?.statements).toHaveLength(3);
    const [s0, s1, s2] = body!.statements!;
    expect([...s0.defs]).toEqual([x]);
    expect([...s1.defs]).toEqual([x]);
    expect([...s2.defs]).toEqual([y]);
    expect([...s2.uses]).toEqual([x]);
  });

  it('compound assignment and update expressions are def+use of the same binding', () => {
    const cfg = cfgOf(`function f(x, y, i) { x += y; i++; }`);
    const x = bindingIdx(cfg, 'x');
    const y = bindingIdx(cfg, 'y');
    const i = bindingIdx(cfg, 'i');
    const body = cfg.blocks.find((b) => b.text.includes('x += y'));
    const [s0, s1] = body!.statements!;
    expect([...s0.defs]).toEqual([x]);
    expect([...s0.uses]).toEqual(expect.arrayContaining([x, y]));
    expect([...s1.defs]).toEqual([i]);
    expect([...s1.uses]).toEqual([i]);
  });

  it('destructuring flattens to one def per bound name; sources are uses', () => {
    const cfg = cfgOf(`function f(obj, arr) {
      const { a, b: c, ...rest } = obj;
      let d, e;
      [d = 1, ...e] = arr;
    }`);
    const defs = defsOf(cfg);
    for (const name of ['a', 'c', 'rest', 'd', 'e']) {
      expect(defs).toContain(bindingIdx(cfg, name));
    }
    const uses = usesOf(cfg);
    expect(uses).toContain(bindingIdx(cfg, 'obj'));
    expect(uses).toContain(bindingIdx(cfg, 'arr'));
    // no spurious binding for the renamed pattern key `b`
    expect(bindingIdxs(cfg, 'b')).toHaveLength(0);
  });

  it('shadowing: inner let is a DISTINCT binding from the outer one', () => {
    const cfg = cfgOf(`function f() {
      let x = 1;
      { let x = 2; use(x); }
      use(x);
    }`);
    const xs = bindingIdxs(cfg, 'x');
    expect(xs).toHaveLength(2);
    const [outer, inner] = xs; // pre-scan is source-order: outer declared first
    const facts = allFacts(cfg);
    const useFacts = facts.filter((f) => f.uses.includes(outer) || f.uses.includes(inner));
    // inner use(x) sees the inner binding; trailing use(x) sees the outer
    expect(useFacts.some((f) => f.uses.includes(inner))).toBe(true);
    expect(useFacts.some((f) => f.uses.includes(outer))).toBe(true);
    const defFacts = facts.filter((f) => f.defs.length > 0);
    expect(defFacts.find((f) => f.defs.includes(outer))?.line).toBeLessThan(
      defFacts.find((f) => f.defs.includes(inner))!.line,
    );
  });

  it('var hoisting + multi-declaration canonicalize to ONE function-rooted binding', () => {
    const cfg = cfgOf(`function f(c) {
      use(v);
      if (c) { var v = 1; }
      var v;
    }`);
    expect(bindingIdxs(cfg, 'v')).toHaveLength(1);
    const v = bindingIdx(cfg, 'v');
    expect(usesOf(cfg)).toContain(v);
    expect(defsOf(cfg)).toContain(v);
    // canonical decl site is the FIRST declaration in source order
    expect(cfg.bindings![v].declLine).toBe(3);
  });

  it('undeclared assignment targets get one deterministic synthetic binding', () => {
    const cfg = cfgOf(`function f() { notDeclared = 1; use(notDeclared); }`);
    const idxs = bindingIdxs(cfg, 'notDeclared');
    expect(idxs).toHaveLength(1);
    const b = cfg.bindings![idxs[0]];
    expect(b.synthetic).toBe(true);
    expect(defsOf(cfg)).toContain(idxs[0]);
    expect(usesOf(cfg)).toContain(idxs[0]);
  });
});

describe('TS/JS def/use harvest — harvest sites beyond visitSeq', () => {
  it('parameters define at the ENTRY block (incl. destructured/default/rest)', () => {
    const cfg = cfgOf(`function f(a, { b }, c = a, ...rest) { body(); }`);
    const entry = cfg.blocks[cfg.entryIndex];
    expect(entry.text).toBe(''); // facts-only attach — never perturbs block text
    const entryFacts = entry.statements ?? [];
    expect(entryFacts).toHaveLength(1);
    const defs = new Set(entryFacts[0].defs);
    for (const name of ['a', 'b', 'c', 'rest']) {
      expect(defs).toContain(bindingIdx(cfg, name));
    }
    expect(entryFacts[0].uses).toContain(bindingIdx(cfg, 'a')); // default-value use
    expect(cfg.bindings![bindingIdx(cfg, 'a')].kind).toBe('param');
  });

  it('return and throw argument expressions are harvested (dedicated handler blocks)', () => {
    const cfg = cfgOf(`function f(x, y, err) {
      if (x) { return x + y; }
      throw err;
    }`);
    const retBlock = cfg.blocks.find((b) => b.text.includes('return x + y'));
    const retUses = new Set(retBlock!.statements!.flatMap((f) => [...f.uses]));
    expect(retUses).toContain(bindingIdx(cfg, 'x'));
    expect(retUses).toContain(bindingIdx(cfg, 'y'));
    const throwBlock = cfg.blocks.find((b) => b.text.includes('throw err'));
    const throwUses = new Set(throwBlock!.statements!.flatMap((f) => [...f.uses]));
    expect(throwUses).toContain(bindingIdx(cfg, 'err'));
  });

  it('expression-bodied arrow harvests params at ENTRY and body uses', () => {
    const cfg = cfgOf(`const f = (p) => p + q;`);
    const entryFacts = cfg.blocks[cfg.entryIndex].statements ?? [];
    expect(entryFacts[0]?.defs).toContain(bindingIdx(cfg, 'p'));
    const body = cfg.blocks.find((b) => b.text.includes('p + q'));
    const uses = new Set(body!.statements!.flatMap((f) => [...f.uses]));
    expect(uses).toContain(bindingIdx(cfg, 'p'));
    expect(uses).toContain(bindingIdx(cfg, 'q')); // synthetic capture
    expect(cfg.bindings![bindingIdx(cfg, 'q')].synthetic).toBe(true);
  });

  it('construct headers harvest: if/while conditions, for init/cond/incr, for-of head', () => {
    const cfg = cfgOf(`function f(n, list) {
      for (let i = 0; i < n; i++) { work(i); }
      for (const item of list) { work(item); }
      while (n > 0) { n--; }
    }`);
    const i = bindingIdx(cfg, 'i');
    const item = bindingIdx(cfg, 'item');
    const n = bindingIdx(cfg, 'n');
    const initBlock = cfg.blocks.find((b) => b.text === 'let i = 0;');
    expect(initBlock!.statements![0].defs).toContain(i);
    const condBlock = cfg.blocks.find((b) => b.text === 'i < n');
    expect(new Set(condBlock!.statements![0].uses)).toEqual(new Set([i, n]));
    const incrBlock = cfg.blocks.find((b) => b.text === 'i++');
    expect(incrBlock!.statements![0].defs).toContain(i);
    const forOfHead = cfg.blocks.find((b) => b.text.includes('item'))!;
    expect(forOfHead.statements!.some((f) => f.defs.includes(item))).toBe(true);
    expect(forOfHead.statements!.some((f) => f.uses.includes(bindingIdx(cfg, 'list')))).toBe(true);
  });

  it('catch param defines in its own facts-only block preceding the body', () => {
    const cfg = cfgOf(`function f() {
      try { risky(); } catch (e) { use(e); }
    }`);
    const e = bindingIdx(cfg, 'e');
    expect(cfg.bindings![e].kind).toBe('catch');
    // The param def gets a DEDICATED once-executed block in front of the body
    // entry — NOT prepended into the body's entry block, which can be a loop
    // header that would re-gen the def per iteration and falsely kill
    // loop-carried redefinitions of the param.
    const paramBlock = cfg.blocks.find(
      (b) => b.text === '' && (b.statements ?? []).some((f) => f.defs.includes(e)),
    );
    expect(paramBlock).toBeDefined();
    const body = cfg.blocks.find((b) => b.text.includes('use(e)'))!;
    expect(cfg.edges.some((ed) => ed.from === paramBlock!.index && ed.to === body.index)).toBe(
      true,
    );
  });

  it('catch body starting with a loop: param def does NOT re-gen on the loop header', () => {
    const cfg = cfgOf(`function f(c) {
      try { risky(); } catch (e) { while (c) { e = fix(e); } sink(e); }
    }`);
    const e = bindingIdx(cfg, 'e');
    const header = cfg.blocks.find((b) => b.text === '(c)' || b.text === 'c')!;
    // the loop header carries NO def of e — only the dedicated param block does
    expect((header.statements ?? []).some((f) => f.defs.includes(e))).toBe(false);
  });

  it('empty catch: param def lands on the synthetic handler block', () => {
    const cfg = cfgOf(`function f() { try { risky(); } catch (e) {} }`);
    const e = bindingIdx(cfg, 'e');
    const withDef = cfg.blocks.filter((b) => (b.statements ?? []).some((f) => f.defs.includes(e)));
    expect(withDef).toHaveLength(1);
    expect(withDef[0].text).toBe(''); // the synthetic empty-catch block
  });

  it('switch: discriminant and case-test uses harvest onto the dispatch block', () => {
    const cfg = cfgOf(`function f(s, sel) {
      switch (s) {
        case sel: a(); break;
        default: b();
      }
    }`);
    const dispatch = cfg.blocks.find((b) => b.text === '(s)');
    const uses = new Set(dispatch!.statements!.flatMap((f) => [...f.uses]));
    expect(uses).toContain(bindingIdx(cfg, 's'));
    expect(uses).toContain(bindingIdx(cfg, 'sel'));
  });
});

describe('TS/JS def/use harvest — exclusions (KTD4)', () => {
  it('nested function bodies are opaque: no defs/uses of captured names harvested', () => {
    const cfg = cfgOf(`function f() {
      let outer = 1;
      const g = () => { outer = 2; use(outer); };
    }`);
    const outer = bindingIdx(cfg, 'outer');
    const g = bindingIdx(cfg, 'g');
    const facts = allFacts(cfg);
    // exactly ONE def of outer (its declaration) — the nested write is invisible
    expect(facts.filter((f) => f.defs.includes(outer))).toHaveLength(1);
    expect(facts.some((f) => f.uses.includes(outer))).toBe(false);
    // the declaration of g IS a def
    expect(facts.some((f) => f.defs.includes(g))).toBe(true);
  });

  it('member/property writes are not defs; their identifiers are uses', () => {
    const cfg = cfgOf(`function f(obj, q) {
      this.x = 1;
      obj.p = q;
    }`);
    const facts = allFacts(cfg);
    const nonParamDefs = facts
      .flatMap((f) => [...f.defs])
      .filter((d) => cfg.bindings![d].kind !== 'param');
    expect(nonParamDefs).toHaveLength(0);
    const uses = usesOf(cfg);
    expect(uses).toContain(bindingIdx(cfg, 'obj'));
    expect(uses).toContain(bindingIdx(cfg, 'q'));
    expect(bindingIdxs(cfg, 'x')).toHaveLength(0); // property name never binds
    expect(bindingIdxs(cfg, 'p')).toHaveLength(0);
  });

  it('type annotations do not produce uses', () => {
    const cfg = cfgOf(`function f(v: SomeType): OtherType { const x: Wide = v; return x; }`);
    expect(bindingIdxs(cfg, 'SomeType')).toHaveLength(0);
    expect(bindingIdxs(cfg, 'OtherType')).toHaveLength(0);
    expect(bindingIdxs(cfg, 'Wide')).toHaveLength(0);
  });
});

describe('TS/JS def/use harvest — walk-order traps (two-phase pre-scan)', () => {
  it('finally walked before try body: var def and finally use share one binding', () => {
    const cfg = cfgOf(`function f() {
      try { var v = 1; } finally { use(v); }
    }`);
    expect(bindingIdxs(cfg, 'v')).toHaveLength(1);
    const v = bindingIdx(cfg, 'v');
    expect(cfg.bindings![v].synthetic).toBeUndefined();
    expect(defsOf(cfg)).toContain(v);
    expect(usesOf(cfg)).toContain(v);
  });

  it('for-init block created after body walk: init def and body use share one binding', () => {
    const cfg = cfgOf(`function f(n) {
      for (let i = 0; i < n; i++) { use(i); }
    }`);
    expect(bindingIdxs(cfg, 'i')).toHaveLength(1);
    const i = bindingIdx(cfg, 'i');
    expect(defsOf(cfg)).toContain(i);
    const bodyBlock = cfg.blocks.find((b) => b.text.includes('use(i)'));
    expect(bodyBlock!.statements!.some((f) => f.uses.includes(i))).toBe(true);
  });

  it('do-while condition created before body: body var def and condition use share one binding', () => {
    const cfg = cfgOf(`function f() {
      do { var x = step(); } while (x);
    }`);
    expect(bindingIdxs(cfg, 'x')).toHaveLength(1);
    const x = bindingIdx(cfg, 'x');
    const condBlock = cfg.blocks.find((b) => b.text === 'x' || b.text === '(x)');
    expect(condBlock!.statements!.some((f) => f.uses.includes(x))).toBe(true);
  });

  it('switch body is ONE scope: let in one case resolves in a later case', () => {
    const cfg = cfgOf(`function f(s) {
      switch (s) {
        case 1: let shared = 1; break;
        case 2: use(shared); break;
      }
    }`);
    expect(bindingIdxs(cfg, 'shared')).toHaveLength(1);
    const shared = bindingIdx(cfg, 'shared');
    expect(defsOf(cfg)).toContain(shared);
    expect(usesOf(cfg)).toContain(shared);
  });
});

describe('TS/JS def/use harvest — serialization', () => {
  it('facts survive a JSON round-trip deep-equal (worker boundary shape)', () => {
    const cfg = cfgOf(`function f(a) {
      let x = a;
      try { x += 1; } catch (e) { use(e); } finally { done(x); }
      return x;
    }`);
    const trip = JSON.parse(JSON.stringify(cfg)) as FunctionCfg;
    expect(trip).toEqual(cfg);
    expect(trip.bindings).toBeDefined();
    expect(trip.blocks.every((b) => Array.isArray(b.statements))).toBe(true);
  });

  it('binding indices in facts are always in range of the binding table', () => {
    const cfg = cfgOf(`function f(a, b) {
      const c = a + b;
      for (const k in a) { sink(k, c); }
    }`);
    const n = cfg.bindings!.length;
    for (const f of allFacts(cfg)) {
      for (const d of f.defs) (expect(d).toBeGreaterThanOrEqual(0), expect(d).toBeLessThan(n));
      for (const u of f.uses) (expect(u).toBeGreaterThanOrEqual(0), expect(u).toBeLessThan(n));
    }
  });
});

describe('TS/JS def/use harvest — review-pass regressions (#2082)', () => {
  it('class declarations harvest the name as a DEF (JS identifier and TS type_identifier)', () => {
    const cfg = cfgOf(`function f() {
      class A {}
      return new A();
    }`);
    const a = bindingIdx(cfg, 'A');
    expect(cfg.bindings![a].kind).toBe('class');
    const facts = allFacts(cfg);
    expect(facts.some((fa) => fa.defs.includes(a))).toBe(true);
    // the `new A()` use resolves to the same binding
    expect(facts.some((fa) => fa.uses.includes(a))).toBe(true);
    // and the declaration statement records NO bogus use of A
    const declFact = facts.find((fa) => fa.defs.includes(a));
    expect(declFact!.uses).not.toContain(a);
  });

  it('write-then-read in one statement (assign-and-test idiom) forms the def→use fact', async () => {
    const { computeReachingDefs } =
      await import('../../../src/core/ingestion/cfg/reaching-defs.js');
    const cfg = cfgOf(`function f(re, s) {
      let m = null;
      if ((m = re.exec(s)) && m) { sink(m); }
    }`);
    const m = bindingIdx(cfg, 'm');
    const r = computeReachingDefs(cfg);
    // the `m` read in the condition gets a fact from the SAME-statement
    // assignment (write-then-read), not only from the dead `m = null` init
    const condUses = r.facts.filter(
      (fa) => fa.bindingIdx === m && fa.def.line === fa.use.line && fa.use.line === 3,
    );
    expect(condUses.length).toBeGreaterThan(0);
  });
});

describe('TS/JS def/use harvest — conditional contexts are MAY-defs (tri-review P1)', () => {
  it('short-circuit RHS def lands in mayDefs, not defs', () => {
    const cfg = cfgOf(`function f(a) { let x = source(); if (a && (x = clean())) {} sink(x); }`);
    const x = bindingIdx(cfg, 'x');
    const cond = cfg.blocks.find((b) => b.text.includes('a && (x = clean())'))!;
    const fact = cond.statements!.find((s) => (s.mayDefs ?? []).includes(x));
    expect(fact).toBeDefined();
    expect(fact!.defs).not.toContain(x);
  });

  it('nullish lazy-init (`c ?? (c = load())`) and ternary-arm defs are may-defs', () => {
    const cfg = cfgOf(`function f(c, k) {
      const v = c ?? (c = load());
      const w = k ? (c = a()) : b();
      use(v, w, c);
    }`);
    const c = bindingIdx(cfg, 'c');
    const all = allFacts(cfg);
    expect(all.filter((s) => (s.mayDefs ?? []).includes(c))).toHaveLength(2);
    // the only MUST def of c is its ENTRY param record — neither conditional
    // assignment is a must-def
    const mustDefs = all.filter((s) => s.defs.includes(c));
    expect(mustDefs).toHaveLength(1);
    expect(mustDefs[0].line).toBe(1); // the param record
  });

  it('switch case-test defs are may-defs on the dispatch block', () => {
    const cfg = cfgOf(`function f(v) {
      let y = taint();
      switch (v) {
        case probe(): sinkA(y); break;
        case (y = 1): sinkB(); break;
      }
    }`);
    const y = bindingIdx(cfg, 'y');
    const dispatch = cfg.blocks.find((b) => b.text === '(v)')!;
    expect(dispatch.statements!.some((s) => (s.mayDefs ?? []).includes(y))).toBe(true);
    expect(dispatch.statements!.some((s) => s.defs.includes(y))).toBe(false);
  });

  it('logical-assignment operators (`x ||= v`) write conditionally — may-def, but the read is a use', () => {
    const cfg = cfgOf(`function f(x) { x ||= fallback(); use(x); }`);
    const x = bindingIdx(cfg, 'x');
    const stmt = allFacts(cfg).find((s) => (s.mayDefs ?? []).includes(x));
    expect(stmt).toBeDefined();
    expect(stmt!.defs).not.toContain(x);
    expect(stmt!.uses).toContain(x);
  });

  it('plain compound assignment (`x += 1`) stays a MUST def', () => {
    const cfg = cfgOf(`function f(x) { x += 1; }`);
    const x = bindingIdx(cfg, 'x');
    expect(allFacts(cfg).some((s) => s.defs.includes(x))).toBe(true);
  });

  it('bare `var x;` is a runtime no-op — no def fact (initialized var still defs)', () => {
    const cfg = cfgOf(`function f() { x = source(); var x; var y = 1; sink(x, y); }`);
    const x = bindingIdx(cfg, 'x');
    const y = bindingIdx(cfg, 'y');
    const defFacts = allFacts(cfg).filter((s) => s.defs.includes(x));
    expect(defFacts).toHaveLength(1); // only the assignment, never the bare declarator
    expect(allFacts(cfg).some((s) => s.defs.includes(y))).toBe(true);
  });

  it('parenthesized lvalues unwrap: `(x) += 1` and `(x)++` def+use x', () => {
    const cfg = cfgOf(`function f(x) { (x) += 1; (x)++; }`);
    const x = bindingIdx(cfg, 'x');
    const withDef = allFacts(cfg).filter((s) => s.defs.includes(x));
    expect(withDef.length).toBeGreaterThanOrEqual(2);
  });
});

// ── #2083 M3 U1 — taint-site harvest ────────────────────────────────────────

import type { SiteRecord } from '../../../src/core/ingestion/cfg/types.js';

/** All site records of the CFG, flattened in (block, statement) order. */
function allSites(cfg: FunctionCfg): SiteRecord[] {
  return allFacts(cfg).flatMap((f) => [...(f.sites ?? [])]);
}

/** The single statement fact carrying sites (throws when ambiguous). */
function siteFact(cfg: FunctionCfg, line?: number): StatementFacts {
  const withSites = allFacts(cfg).filter(
    (f) => (f.sites?.length ?? 0) > 0 && (line === undefined || f.line === line),
  );
  if (withSites.length !== 1)
    throw new Error(`expected 1 site-bearing fact, got ${withSites.length}`);
  return withSites[0];
}

describe('M3 U1 — taint-site harvest: call sites', () => {
  it('exec(a, b) → one call site mapping position 0→[a], 1→[b]', () => {
    const cfg = cfgOf(`function f(a, b) { exec(a, b); }`);
    const sites = siteFact(cfg, 1).sites!;
    expect(sites).toHaveLength(1);
    const s = sites[0];
    expect(s.kind).toBe('call');
    expect(s.callee).toBe('exec');
    expect(s.receiver).toBeUndefined();
    expect(s.args).toEqual([[bindingIdx(cfg, 'a')], [bindingIdx(cfg, 'b')]]);
    expect(s.parent).toBeUndefined();
  });

  it('child_process.exec(cmd) → dotted callee path + receiver slot', () => {
    const cfg = cfgOf(`function f(cmd) { child_process.exec(cmd); }`);
    const s = siteFact(cfg, 1).sites![0];
    expect(s.callee).toBe('child_process.exec');
    expect(s.receiver).toBe(bindingIdx(cfg, 'child_process'));
    expect(s.args).toEqual([[bindingIdx(cfg, 'cmd')]]);
    // chain-length-1 callee: the access IS the callee — no member-read site
    expect(siteFact(cfg, 1).sites).toHaveLength(1);
    // and the receiver use is recorded exactly once (no double-record)
    expect(
      siteFact(cfg, 1).uses.filter((u) => u === bindingIdx(cfg, 'child_process')),
    ).toHaveLength(1);
  });

  it('const r = f(x) → resultDefs carries r', () => {
    const cfg = cfgOf(`function g(x) { const r = f(x); }`);
    const s = siteFact(cfg, 1).sites![0];
    expect(s.resultDefs).toEqual([bindingIdx(cfg, 'r')]);
    expect(s.args).toEqual([[bindingIdx(cfg, 'x')]]);
  });

  it('exec(escape(x)) → inner site is first-class with parent link + occurrence tagging', () => {
    const cfg = cfgOf(`function f(x) { exec(escape(x)); }`);
    const sites = siteFact(cfg, 1).sites!;
    expect(sites).toHaveLength(2);
    const execIdx = sites.findIndex((s) => s.callee === 'exec');
    const escapeIdx = sites.findIndex((s) => s.callee === 'escape');
    expect(execIdx).toBeGreaterThanOrEqual(0);
    expect(escapeIdx).toBeGreaterThanOrEqual(0);
    const x = bindingIdx(cfg, 'x');
    // inner escape: plain occurrence, parent link to (exec, arg 0)
    expect(sites[escapeIdx].args).toEqual([[x]]);
    expect(sites[escapeIdx].parent).toEqual([execIdx, 0]);
    // outer exec: x's occurrence is via-tagged through the escape site
    expect(sites[execIdx].args).toEqual([[[x, escapeIdx]]]);
    expect(sites[execIdx].parent).toBeUndefined();
  });

  it('a bypass occurrence stays a PLAIN entry next to the via-tagged one (exec(x + escape(x)))', () => {
    const cfg = cfgOf(`function f(x) { exec(x + escape(x)); }`);
    const sites = siteFact(cfg, 1).sites!;
    const exec = sites.find((s) => s.callee === 'exec')!;
    const escapeIdx = sites.findIndex((s) => s.callee === 'escape');
    const x = bindingIdx(cfg, 'x');
    expect(exec.args![0]).toEqual([x, [x, escapeIdx]]);
  });

  it('new Function(x) → kind "new" site (new_expression case)', () => {
    const cfg = cfgOf(`function f(x) { new Function(x); }`);
    const s = siteFact(cfg, 1).sites![0];
    expect(s.kind).toBe('new');
    expect(s.callee).toBe('Function');
    expect(s.args).toEqual([[bindingIdx(cfg, 'x')]]);
  });

  it('exec(...args) → spread index recorded, args binding occurs at the position', () => {
    const cfg = cfgOf(`function f(...args) { exec(...args); }`);
    const s = siteFact(cfg, 1).sites![0];
    expect(s.spread).toBe(0);
    expect(s.args).toEqual([[bindingIdx(cfg, 'args')]]);
  });

  it('const cp = require("child_process") → requireArg literal + cp in resultDefs', () => {
    const cfg = cfgOf(`function f() { const cp = require('child_process'); }`);
    const s = siteFact(cfg, 1).sites![0];
    expect(s.callee).toBe('require');
    expect(s.requireArg).toBe('child_process');
    expect(s.resultDefs).toEqual([bindingIdx(cfg, 'cp')]);
  });

  it('per-declarator attribution: const a = t, b = escape(t) → resultDefs [b] only', () => {
    const cfg = cfgOf(`function f(t) { const a = t, b = escape(t); }`);
    const sites = siteFact(cfg, 1).sites!;
    expect(sites).toHaveLength(1);
    expect(sites[0].callee).toBe('escape');
    expect(sites[0].resultDefs).toEqual([bindingIdx(cfg, 'b')]);
  });

  it('non-top-level call gets NO resultDefs (const c = cond ? escape(b) : b keeps c taintable)', () => {
    const cfg = cfgOf(`function f(cond, b) { const c = cond ? escape(b) : b; }`);
    const sites = siteFact(cfg, 1).sites!;
    expect(sites).toHaveLength(1);
    expect(sites[0].callee).toBe('escape');
    expect(sites[0].resultDefs).toBeUndefined();
  });

  it('value wrappers unwrap for resultDefs: const b = (await escape(t))! still attaches [b]', () => {
    const cfg = cfgOf(`async function f(t) { const b = (await escape(t))!; }`);
    const s = siteFact(cfg, 1).sites![0];
    expect(s.resultDefs).toEqual([bindingIdx(cfg, 'b')]);
  });

  it('plain assignment x = f(y) attaches resultDefs [x]', () => {
    const cfg = cfgOf(`function g(y) { let x; x = f(y); }`);
    const s = siteFact(cfg, 1).sites![0];
    expect(s.resultDefs).toEqual([bindingIdx(cfg, 'x')]);
  });
});

describe('M3 U1 — taint-site harvest: member reads', () => {
  it('const b = req.body → member read {object: req, property: body} AND b in defs', () => {
    const cfg = cfgOf(`function f(req) { const b = req.body; }`);
    const fact = siteFact(cfg, 1);
    expect(fact.defs).toContain(bindingIdx(cfg, 'b'));
    expect(fact.sites).toEqual([
      { kind: 'member-read', object: bindingIdx(cfg, 'req'), property: 'body' },
    ]);
  });

  it('req?.body records identically to req.body (optional-chain normalization)', () => {
    const plain = cfgOf(`function f(req) { const b = req.body; }`);
    const optional = cfgOf(`function f(req) { const b = req?.body; }`);
    expect(siteFact(optional, 1).sites).toEqual(siteFact(plain, 1).sites);
  });

  it('req["body"] records as a member read; dynamic req[key] records NOTHING', () => {
    const literal = cfgOf(`function f(req) { const c = req["body"]; }`);
    expect(siteFact(literal, 1).sites).toEqual([
      { kind: 'member-read', object: bindingIdx(literal, 'req'), property: 'body' },
    ]);
    const dynamic = cfgOf(`function f(req, key) { const d = req[key]; }`);
    expect(allSites(dynamic)).toHaveLength(0);
    // the dynamic index is still a value use
    expect(usesOf(dynamic)).toContain(bindingIdx(dynamic, 'key'));
  });

  it('exec(req.body.toString()) → the mid-callee-chain member read IS recorded', () => {
    const cfg = cfgOf(`function f(req) { exec(req.body.toString()); }`);
    const sites = siteFact(cfg, 1).sites!;
    const read = sites.find((s) => s.kind === 'member-read');
    expect(read).toBeDefined();
    expect(read!.object).toBe(bindingIdx(cfg, 'req'));
    expect(read!.property).toBe('body');
    // the toString call site carries the full dotted path + receiver
    const ts = sites.find((s) => s.callee === 'req.body.toString');
    expect(ts).toBeDefined();
    expect(ts!.receiver).toBe(bindingIdx(cfg, 'req'));
    // and req's occurrence reaches exec's arg 0 via the toString site
    const exec = sites.find((s) => s.callee === 'exec')!;
    const tsIdx = sites.indexOf(ts!);
    expect(exec.args).toEqual([[[bindingIdx(cfg, 'req'), tsIdx]]]);
  });

  it('write-position member targets record NO member read (obj.p = q)', () => {
    const cfg = cfgOf(`function f(obj, q) { obj.p = q; }`);
    expect(allSites(cfg)).toHaveLength(0);
  });

  it('a mid-chain LOAD inside a write target IS recorded (req.body.x = v)', () => {
    const cfg = cfgOf(`function f(req, v) { req.body.x = v; }`);
    expect(siteFact(cfg, 1).sites).toEqual([
      { kind: 'member-read', object: bindingIdx(cfg, 'req'), property: 'body' },
    ]);
  });
});

describe('M3 U1 — taint-site harvest: templates, callbacks, statement granularity', () => {
  it('template-literal argument: exec(`ls ${dir}`) → dir occurs at position 0, no template flag', () => {
    const cfg = cfgOf('function f(dir) { exec(`ls ${dir}`); }');
    const s = siteFact(cfg, 1).sites![0];
    expect(s.template).toBeUndefined();
    expect(s.args).toEqual([[bindingIdx(cfg, 'dir')]]);
  });

  it('tagged template: sql`…${id}` → call site with template marker, id recorded', () => {
    const cfg = cfgOf('function f(id) { sql`select ${id}`; }');
    const s = siteFact(cfg, 1).sites![0];
    expect(s.kind).toBe('call');
    expect(s.callee).toBe('sql');
    expect(s.template).toBe(true);
    expect(s.args).toEqual([[bindingIdx(cfg, 'id')]]);
  });

  it('nested callback: arr.forEach(() => exec(y)) → inner call invisible, outer site has receiver arr', () => {
    const cfg = cfgOf(`function f(arr, y) { arr.forEach(() => exec(y)); }`);
    const sites = siteFact(cfg, 1).sites!;
    expect(sites).toHaveLength(1);
    expect(sites[0].callee).toBe('arr.forEach');
    expect(sites[0].receiver).toBe(bindingIdx(cfg, 'arr'));
    // y is invisible (nested-function opacity) — neither a use nor an occurrence
    expect(usesOf(cfg)).not.toContain(bindingIdx(cfg, 'y'));
    expect(sites[0].args).toBeUndefined();
  });

  it('two statements on one line → distinct site records on distinct StatementFacts', () => {
    const cfg = cfgOf(`function f(a, b) { exec(a); run(b); }`);
    const withSites = allFacts(cfg).filter((f) => (f.sites?.length ?? 0) > 0);
    expect(withSites).toHaveLength(2);
    expect(withSites[0].sites![0].callee).toBe('exec');
    expect(withSites[1].sites![0].callee).toBe('run');
    // site indices are PER-STATEMENT — both are index 0 of their own record
    expect(withSites[0].sites).toHaveLength(1);
    expect(withSites[1].sites).toHaveLength(1);
  });

  it('sites are omitted entirely on statements without calls or member reads', () => {
    const cfg = cfgOf(`function f() { let x = 1; x = 2; }`);
    for (const fact of allFacts(cfg)) expect(fact.sites).toBeUndefined();
  });

  it('sites survive a JSON round-trip (worker boundary shape)', () => {
    const cfg = cfgOf(`function f(req, x) { const b = req.body; exec(escape(x), b); }`);
    const trip = JSON.parse(JSON.stringify(cfg)) as FunctionCfg;
    expect(trip).toEqual(cfg);
    expect(allSites(trip).length).toBeGreaterThan(0);
  });

  it('sequence expression: only the final operand flows into the sink argument', () => {
    // `exec((log(x), 'safe'))` — the comma operator's value is the last operand
    // (`'safe'`), so exec's arg 0 must NOT carry `x` (review fix). `x` is still
    // a USE of the statement (the side-effect operand is evaluated).
    const cfg = cfgOf(`function f(x) { exec((log(x), 'safe')); }`);
    const execSite = allSites(cfg).find((s) => s.callee === 'exec')!;
    expect(execSite.args ?? [[]]).toEqual([[]]); // arg 0 has no flowing binding
    expect(siteFact(cfg, 1).uses).toContain(bindingIdx(cfg, 'x'));
  });

  it('sequence expression: a tainted final operand DOES flow into the sink', () => {
    const cfg = cfgOf(`function f(x) { exec((log('a'), x)); }`);
    const execSite = allSites(cfg).find((s) => s.callee === 'exec')!;
    expect(execSite.args).toEqual([[bindingIdx(cfg, 'x')]]);
  });
});

import {
  CallSiteFactAccumulator,
  DEFAULT_PDG_MAX_SITES_PER_STATEMENT as MAX_SITES,
} from '../../../src/core/ingestion/cfg/visitors/call-site-harvest.js';

describe('U11 — per-statement site cap (defensive bound on harvested sites[])', () => {
  it('records every site for a statement below the cap (unchanged)', () => {
    const acc = new CallSiteFactAccumulator(1);
    for (let i = 0; i < 5; i++) acc.setSiteCallee(acc.openCallSite('call'), `f${i}`);
    const facts = acc.finish();
    expect(facts.sites).toHaveLength(5);
    expect(acc.sitesTruncated).toBe(false);
    expect(facts.sites!.map((s) => s.callee)).toEqual(['f0', 'f1', 'f2', 'f3', 'f4']);
  });

  it('caps a pathological statement at exactly the limit and flags truncation', () => {
    const acc = new CallSiteFactAccumulator(1);
    const indices: number[] = [];
    for (let i = 0; i < MAX_SITES + 50; i++) {
      const idx = acc.openCallSite('call');
      acc.setSiteCallee(idx, `f${i}`);
      indices.push(idx);
    }
    const facts = acc.finish();
    // exactly the cap recorded — not the requested over-count, not unbounded
    expect(facts.sites).toHaveLength(MAX_SITES);
    expect(acc.sitesTruncated).toBe(true);
    // under-cap opens get 0..cap-1; the first over-cap open gets the -1 sentinel
    expect(indices[MAX_SITES - 1]).toBe(MAX_SITES - 1);
    expect(indices[MAX_SITES]).toBe(-1);
    // KEPT sites stay fully intact (no clobber from the dropped tail)
    expect(facts.sites![0].callee).toBe('f0');
    expect(facts.sites![MAX_SITES - 1].callee).toBe(`f${MAX_SITES - 1}`);
  });

  it('member-reads past the cap are dropped, not unbounded', () => {
    const acc = new CallSiteFactAccumulator(1);
    for (let i = 0; i < MAX_SITES; i++) acc.openCallSite('call'); // fill to the cap
    acc.addMemberRead(0, 'body'); // would-be site #cap+1
    expect(acc.finish().sites).toHaveLength(MAX_SITES);
    expect(acc.sitesTruncated).toBe(true);
  });

  it('occurrence machinery stays sound when a nested frame is cap-dropped', () => {
    const acc = new CallSiteFactAccumulator(1);
    const outer = acc.openCallSite('call'); // a KEPT outer sink site
    acc.setSiteCallee(outer, 'sink');
    acc.pushFrame(outer);
    acc.setFrameArg(0);
    // Saturate the remaining budget so the next openCallSite is cap-dropped.
    for (let i = 1; i < MAX_SITES; i++) acc.openCallSite('call');
    const nested = acc.openCallSite('call'); // over cap → -1 sentinel
    expect(nested).toBe(-1);
    acc.setSiteCallee(nested, 'dropped'); // must no-op, not throw
    acc.pushFrame(nested);
    acc.setFrameArg(0);
    acc.addUse(7); // a use inside the dropped nested call — must not crash
    acc.popFrame();
    acc.popFrame();
    const facts = acc.finish();
    expect(facts.uses).toContain(7); // still recorded statement-level
    // outer (kept) fanned the use in as a PLAIN occurrence — no dangling -1 via
    const flat = (facts.sites![outer].args ?? []).flat();
    expect(flat).toContain(7);
    expect(flat.some((e) => Array.isArray(e) && e[1] === -1)).toBe(false);
  });
});

// ── #2227 follow-up — Python call-site harvest (pilot language) ──────────────
// Drives the REAL Python CFG visitor (PythonHarvester) against real source via
// the language-agnostic harness, mirroring the TS site tests above. The `at`
// anchor is the `call` node's start position (byte-aligned with the
// `@reference.call.*` CALLS anchor so the resolved-id join lands).

import { createRequire } from 'node:module';
import { makeCfgHarness, type CfgHarness } from '../../helpers/cfg-harness.js';
import { createPythonCfgVisitor } from '../../../src/core/ingestion/cfg/visitors/python.js';

const pyGrammar = createRequire(import.meta.url)('tree-sitter-python') as Parameters<
  typeof makeCfgHarness
>[0];
const py: CfgHarness = makeCfgHarness(pyGrammar, createPythonCfgVisitor(), 'fixture.py');

describe('Python call-site harvest', () => {
  it('foo(a, b) → one call site, positions 0→[a], 1→[b], at the call node line/col', () => {
    const cfg = py.cfgOf(`def f(a, b):\n    foo(a, b)\n`);
    const sites = siteFact(cfg, 2).sites!;
    expect(sites).toHaveLength(1);
    const s = sites[0];
    expect(s.kind).toBe('call');
    expect(s.callee).toBe('foo');
    expect(s.receiver).toBeUndefined();
    expect(s.args).toEqual([[bindingIdx(cfg, 'a')], [bindingIdx(cfg, 'b')]]);
    expect(s.parent).toBeUndefined();
    // `at` is the `call` node start: line 2 (1-based), col 4 (after indent).
    expect(s.at).toEqual([2, 4]);
  });

  it('obj.method(x) → dotted callee path + receiver = obj', () => {
    const cfg = py.cfgOf(`def f(obj, x):\n    obj.method(x)\n`);
    const s = siteFact(cfg, 2).sites![0];
    expect(s.callee).toBe('obj.method');
    expect(s.receiver).toBe(bindingIdx(cfg, 'obj'));
    expect(s.args).toEqual([[bindingIdx(cfg, 'x')]]);
    // chain-length-1 callee: the access IS the callee — no member-read site
    expect(siteFact(cfg, 2).sites).toHaveLength(1);
    // and the receiver use is recorded exactly once (no double-record)
    expect(siteFact(cfg, 2).uses.filter((u) => u === bindingIdx(cfg, 'obj'))).toHaveLength(1);
    // `at` is the call node start (the receiver `obj`), col 4.
    expect(s.at).toEqual([2, 4]);
  });

  it('a.b.c() → callee path a.b.c, receiver = root a, plus a mid-chain member read', () => {
    const cfg = py.cfgOf(`def f(a):\n    a.b.c()\n`);
    const sites = siteFact(cfg, 2).sites!;
    const call = sites.find((s) => s.kind === 'call')!;
    expect(call.callee).toBe('a.b.c');
    expect(call.receiver).toBe(bindingIdx(cfg, 'a'));
    // the innermost access `a.b` (the non-callee load) is a member read
    const read = sites.find((s) => s.kind === 'member-read')!;
    expect(read.object).toBe(bindingIdx(cfg, 'a'));
    expect(read.property).toBe('b');
  });

  it("multi-line call → the site's `at` line is the call node's start line", () => {
    const cfg = py.cfgOf(`def f(a, b):\n    foo(\n        a,\n        b,\n    )\n`);
    const s = siteFact(cfg).sites![0];
    expect(s.callee).toBe('foo');
    // `call` starts on line 2 even though args span lines 3-4.
    expect(s.at![0]).toBe(2);
    expect(s.args).toEqual([[bindingIdx(cfg, 'a')], [bindingIdx(cfg, 'b')]]);
  });

  it('exec(*args) → spread index recorded, args binding occurs at the position', () => {
    const cfg = py.cfgOf(`def f(*args):\n    exec(*args)\n`);
    const s = siteFact(cfg, 2).sites![0];
    expect(s.callee).toBe('exec');
    expect(s.spread).toBe(0);
    expect(s.args).toEqual([[bindingIdx(cfg, 'args')]]);
  });

  it('two calls in one function → two distinct call sites', () => {
    const cfg = py.cfgOf(`def f(a, b):\n    foo(a)\n    bar(b)\n`);
    const calls = allSites(cfg).filter((s) => s.kind === 'call');
    expect(calls.map((s) => s.callee).sort()).toEqual(['bar', 'foo']);
  });

  it('x = f(y) → resultDefs carries x; nested escape(req.body) tags + member read', () => {
    const cfg = py.cfgOf(`def f(y):\n    x = g(y)\n`);
    const s = siteFact(cfg, 2).sites![0];
    expect(s.callee).toBe('g');
    expect(s.resultDefs).toEqual([bindingIdx(cfg, 'x')]);
    expect(s.args).toEqual([[bindingIdx(cfg, 'y')]]);
  });

  it('nested call exec(escape(x)) → inner site parent-linked, occurrence via-tagged', () => {
    const cfg = py.cfgOf(`def f(x):\n    exec(escape(x))\n`);
    const sites = siteFact(cfg, 2).sites!;
    expect(sites).toHaveLength(2);
    const execIdx = sites.findIndex((s) => s.callee === 'exec');
    const escapeIdx = sites.findIndex((s) => s.callee === 'escape');
    const x = bindingIdx(cfg, 'x');
    expect(sites[escapeIdx].args).toEqual([[x]]);
    expect(sites[escapeIdx].parent).toEqual([execIdx, 0]);
    expect(sites[execIdx].args).toEqual([[[x, escapeIdx]]]);
  });

  it('keyword argument f(k=v) → value remains a use without minting a positional slot', () => {
    const cfg = py.cfgOf(`def f(v):\n    foo(k=v)\n`);
    const s = siteFact(cfg, 2).sites![0];
    expect(s.callee).toBe('foo');
    // `k` mints no binding; `v` remains a statement use, but keyword names are
    // unavailable in SiteRecord so mapping it to positional slot 0 is unsound.
    expect(bindingIdxs(cfg, 'k')).toHaveLength(0);
    expect(usesOf(cfg)).toContain(bindingIdx(cfg, 'v'));
    expect(s.args).toBeUndefined();
  });

  it('def/use facts stay intact alongside the new sites (regression guard)', () => {
    const cfg = py.cfgOf(`def f(y):\n    x = g(y)\n    use(x)\n`);
    const x = bindingIdx(cfg, 'x');
    const y = bindingIdx(cfg, 'y');
    expect(defsOf(cfg)).toContain(x);
    expect(usesOf(cfg)).toContain(y);
    expect(usesOf(cfg)).toContain(x);
  });
});

// ── Dart call-site harvest ──────────────────────────────────────────────────
// Drives the REAL Dart CFG visitor (DartHarvester) against real source via the
// language-agnostic harness, mirroring the Python site tests above. Dart has NO
// `call_expression` node — a call is a FLAT SIBLING RUN (`identifier` +
// `selector*`); a `selector(argument_part)` is the call marker. The `at` anchor
// is byte-aligned with the Dart `@reference.call.*` CALLS anchor, which the
// scope-extractor places on the callee NAME identifier: the callee identifier
// for a free / implicit-constructor call (`foo`/`Foo`), and the METHOD-name
// identifier for a member call (`.method`'s `method`, NOT the receiver). The
// grammar is VENDORED (loaded from vendor/ like the Kotlin/Swift tests).

import { requireVendoredGrammar } from '../../../src/core/tree-sitter/vendored-grammars.js';
import { createDartCfgVisitor } from '../../../src/core/ingestion/cfg/visitors/dart.js';

const dartGrammar = requireVendoredGrammar('tree-sitter-dart') as Parameters<
  typeof makeCfgHarness
>[0];
const dart: CfgHarness = makeCfgHarness(dartGrammar, createDartCfgVisitor(), 'fixture.dart');

describe('Dart call-site harvest', () => {
  it('foo(a, b) → one call site, positions 0→[a], 1→[b], at the callee id line/col', () => {
    const cfg = dart.cfgOf(`void f(a, b) {\n  foo(a, b);\n}\n`);
    const sites = siteFact(cfg, 2).sites!;
    expect(sites).toHaveLength(1);
    const s = sites[0];
    expect(s.kind).toBe('call');
    expect(s.callee).toBe('foo');
    expect(s.receiver).toBeUndefined();
    expect(s.args).toEqual([[bindingIdx(cfg, 'a')], [bindingIdx(cfg, 'b')]]);
    expect(s.parent).toBeUndefined();
    // `at` is the callee identifier `foo`: line 2 (1-based), col 2 (after indent).
    expect(s.at).toEqual([2, 2]);
  });

  it('obj.method(x) → dotted callee path + receiver = obj, at the METHOD name', () => {
    const cfg = dart.cfgOf(`void f(obj, x) {\n  obj.method(x);\n}\n`);
    const sites = siteFact(cfg, 2).sites!;
    expect(sites).toHaveLength(1);
    const s = sites[0];
    expect(s.callee).toBe('obj.method');
    expect(s.receiver).toBe(bindingIdx(cfg, 'obj'));
    expect(s.args).toEqual([[bindingIdx(cfg, 'x')]]);
    // chain-length-1 callee: the access IS the callee — no member-read site.
    expect(siteFact(cfg, 2).uses.filter((u) => u === bindingIdx(cfg, 'obj'))).toHaveLength(1);
    // `at` is the method-name identifier `method` (col 6), NOT the receiver `obj`.
    expect(s.at).toEqual([2, 6]);
  });

  it('a.b.c() → callee path a.b.c, receiver = root a, plus a mid-chain member read', () => {
    const cfg = dart.cfgOf(`void f(a) {\n  a.b.c();\n}\n`);
    const sites = siteFact(cfg, 2).sites!;
    const call = sites.find((s) => s.kind === 'call')!;
    expect(call.callee).toBe('a.b.c');
    expect(call.receiver).toBe(bindingIdx(cfg, 'a'));
    // `at` is the call-name identifier `c` (col 6).
    expect(call.at).toEqual([2, 6]);
    // the innermost access `a.b` (the non-callee load) is a member read.
    const read = sites.find((s) => s.kind === 'member-read')!;
    expect(read.object).toBe(bindingIdx(cfg, 'a'));
    expect(read.property).toBe('b');
  });

  it("multi-line call → the site's `at` line is the callee identifier's line", () => {
    const cfg = dart.cfgOf(`void f(a, b) {\n  foo(\n    a,\n    b,\n  );\n}\n`);
    const s = siteFact(cfg).sites![0];
    expect(s.callee).toBe('foo');
    // `foo` is on line 2 even though the args span lines 3-4.
    expect(s.at![0]).toBe(2);
    expect(s.args).toEqual([[bindingIdx(cfg, 'a')], [bindingIdx(cfg, 'b')]]);
  });

  it('two calls in one function → two distinct call sites', () => {
    const cfg = dart.cfgOf(`void f(a, b) {\n  foo(a);\n  bar(b);\n}\n`);
    const calls = allSites(cfg).filter((s) => s.kind === 'call');
    expect(calls.map((s) => s.callee).sort()).toEqual(['bar', 'foo']);
  });

  it('var x = g(y) → resultDefs carries x; arg y occurs at position 0', () => {
    const cfg = dart.cfgOf(`void f(y) {\n  var x = g(y);\n}\n`);
    const s = siteFact(cfg, 2).sites![0];
    expect(s.callee).toBe('g');
    expect(s.resultDefs).toEqual([bindingIdx(cfg, 'x')]);
    expect(s.args).toEqual([[bindingIdx(cfg, 'y')]]);
    // `at` is the callee identifier `g` (col 10, after `  var x = `).
    expect(s.at).toEqual([2, 10]);
  });

  it('nested call exec(escape(x)) → inner site parent-linked, occurrence via-tagged', () => {
    const cfg = dart.cfgOf(`void f(x) {\n  exec(escape(x));\n}\n`);
    const sites = siteFact(cfg, 2).sites!;
    expect(sites).toHaveLength(2);
    const execIdx = sites.findIndex((s) => s.callee === 'exec');
    const escapeIdx = sites.findIndex((s) => s.callee === 'escape');
    const x = bindingIdx(cfg, 'x');
    expect(sites[escapeIdx].args).toEqual([[x]]);
    expect(sites[escapeIdx].parent).toEqual([execIdx, 0]);
    expect(sites[execIdx].args).toEqual([[[x, escapeIdx]]]);
  });

  it('implicit constructor Foo(1) → kind call (Dart-2 implicit, structurally a free call)', () => {
    const cfg = dart.cfgOf(`void f() {\n  var x = Foo(1);\n}\n`);
    const s = siteFact(cfg, 2).sites![0];
    expect(s.kind).toBe('call');
    expect(s.callee).toBe('Foo');
    expect(s.resultDefs).toEqual([bindingIdx(cfg, 'x')]);
    // anchored on the callee identifier `Foo` (col 10) — matches
    // `@reference.call.constructor`, which the resolution keys on the same node.
    expect(s.at).toEqual([2, 10]);
  });

  it('new Foo(1) → kind new (the only single-node call shape Dart has)', () => {
    const cfg = dart.cfgOf(`void f() {\n  var x = new Foo(1);\n}\n`);
    const s = siteFact(cfg, 2).sites![0];
    expect(s.kind).toBe('new');
    expect(s.callee).toBe('Foo');
    expect(s.resultDefs).toEqual([bindingIdx(cfg, 'x')]);
    // the type identifier `Foo` is a type, not a scalar binding — no use of it.
    expect(bindingIdxs(cfg, 'Foo')).toHaveLength(0);
  });

  it('named argument foo(k: v) → only the value v is an occurrence (key is not a use)', () => {
    const cfg = dart.cfgOf(`void f(v) {\n  foo(k: v);\n}\n`);
    const s = siteFact(cfg, 2).sites![0];
    expect(s.callee).toBe('foo');
    // `k` mints no binding; `v` occurs at position 0.
    expect(bindingIdxs(cfg, 'k')).toHaveLength(0);
    expect(s.args).toEqual([[bindingIdx(cfg, 'v')]]);
  });

  it('def/use facts stay intact alongside the new sites (regression guard)', () => {
    const cfg = dart.cfgOf(`void f(y) {\n  var x = g(y);\n  use(x);\n}\n`);
    const x = bindingIdx(cfg, 'x');
    const y = bindingIdx(cfg, 'y');
    // the binding table + def/use are coherent: x is defined, y and x are used.
    expect(defsOf(cfg)).toContain(x);
    expect(usesOf(cfg)).toContain(y);
    expect(usesOf(cfg)).toContain(x);
    expect(cfg.bindings![y].kind).toBe('param');
  });
});

// ── Kotlin call-site harvest ─────────────────────────────────────────────────
// Drives the REAL Kotlin CFG visitor (KotlinHarvester) against real source via
// the language-agnostic harness, mirroring the Python / Dart site tests above.
// A Kotlin call is a `call_expression` whose last child is a `call_suffix`
// (holding `value_arguments` / a trailing `annotated_lambda`); the callee is the
// preceding `simple_identifier` (free) or `navigation_expression` (member /
// chained / safe-call). Kotlin has no `new` — constructor calls are ordinary
// `call_expression`s (`kind: 'call'`). The `at` anchor is byte-aligned with the
// Kotlin `@reference.call.free/.member` CALLS anchor, which the scope query
// places on the WHOLE `call_expression` node (the Go/Python whole-call model,
// NOT Dart's callee-name model) — so for a member/chained call `at` starts at the
// RECEIVER, exactly where the CALLS anchor starts. The grammar is VENDORED
// (loaded from vendor/ like the Dart/Swift tests).

import { createKotlinCfgVisitor } from '../../../src/core/ingestion/cfg/visitors/kotlin.js';

const kotlinGrammar = requireVendoredGrammar('tree-sitter-kotlin') as Parameters<
  typeof makeCfgHarness
>[0];
const kotlin: CfgHarness = makeCfgHarness(kotlinGrammar, createKotlinCfgVisitor(), 'fixture.kt');

describe('Kotlin call-site harvest', () => {
  it('foo(a, b) → one call site, positions 0→[a], 1→[b], at the call_expression line/col', () => {
    const cfg = kotlin.cfgOf(`fun f(a: Int, b: Int) {\n    foo(a, b)\n}\n`);
    const sites = siteFact(cfg, 2).sites!;
    expect(sites).toHaveLength(1);
    const s = sites[0];
    expect(s.kind).toBe('call');
    expect(s.callee).toBe('foo');
    expect(s.receiver).toBeUndefined();
    expect(s.args).toEqual([[bindingIdx(cfg, 'a')], [bindingIdx(cfg, 'b')]]);
    expect(s.parent).toBeUndefined();
    // `at` is the `call_expression` node start: line 2 (1-based), col 4 (indent).
    expect(s.at).toEqual([2, 4]);
  });

  it('obj.method(x) → dotted callee path + receiver = obj, at the call_expression start', () => {
    const cfg = kotlin.cfgOf(`fun f(obj: Foo, x: Int) {\n    obj.method(x)\n}\n`);
    const sites = siteFact(cfg, 2).sites!;
    expect(sites).toHaveLength(1);
    const s = sites[0];
    expect(s.callee).toBe('obj.method');
    expect(s.receiver).toBe(bindingIdx(cfg, 'obj'));
    expect(s.args).toEqual([[bindingIdx(cfg, 'x')]]);
    // chain-length-1 callee: the access IS the callee — no member-read site.
    expect(siteFact(cfg, 2).uses.filter((u) => u === bindingIdx(cfg, 'obj'))).toHaveLength(1);
    // `at` is the call_expression start (the receiver `obj`), col 4 — NOT the
    // method name. The Kotlin CALLS anchor keys on the same call_expression node.
    expect(s.at).toEqual([2, 4]);
  });

  it('a.b.c() → callee path a.b.c, receiver = root a, plus a mid-chain member read', () => {
    const cfg = kotlin.cfgOf(`fun f(a: Foo) {\n    a.b.c()\n}\n`);
    const sites = siteFact(cfg, 2).sites!;
    const call = sites.find((s) => s.kind === 'call')!;
    expect(call.callee).toBe('a.b.c');
    expect(call.receiver).toBe(bindingIdx(cfg, 'a'));
    // `at` is the whole call_expression start (the root `a`), col 4.
    expect(call.at).toEqual([2, 4]);
    // the innermost access `a.b` (the non-callee load) is a member read.
    const read = sites.find((s) => s.kind === 'member-read')!;
    expect(read.object).toBe(bindingIdx(cfg, 'a'));
    expect(read.property).toBe('b');
  });

  it('a?.b() safe-call → still a call site (callee a.b, receiver = a)', () => {
    const cfg = kotlin.cfgOf(`fun f(a: Foo?) {\n    a?.b()\n}\n`);
    const sites = siteFact(cfg, 2).sites!;
    const call = sites.find((s) => s.kind === 'call')!;
    expect(call.kind).toBe('call');
    expect(call.callee).toBe('a.b');
    expect(call.receiver).toBe(bindingIdx(cfg, 'a'));
    expect(call.at).toEqual([2, 4]);
  });

  it("multi-line call → the site's `at` line is the call_expression's start line", () => {
    const cfg = kotlin.cfgOf(
      `fun f(a: Int, b: Int) {\n    foo(\n        a,\n        b\n    )\n}\n`,
    );
    const s = siteFact(cfg).sites![0];
    expect(s.callee).toBe('foo');
    // `call_expression` starts on line 2 even though the args span lines 3-4.
    expect(s.at![0]).toBe(2);
    expect(s.at![1]).toBe(4);
    expect(s.args).toEqual([[bindingIdx(cfg, 'a')], [bindingIdx(cfg, 'b')]]);
  });

  it('two calls in one function → two distinct call sites', () => {
    const cfg = kotlin.cfgOf(`fun f(a: Int, b: Int) {\n    foo(a)\n    bar(b)\n}\n`);
    const calls = allSites(cfg).filter((s) => s.kind === 'call');
    expect(calls.map((s) => s.callee).sort()).toEqual(['bar', 'foo']);
  });

  it('val x = g(y) → resultDefs carries x; arg y occurs at position 0', () => {
    const cfg = kotlin.cfgOf(`fun f(y: Int) {\n    val x = g(y)\n}\n`);
    const s = siteFact(cfg, 2).sites![0];
    expect(s.callee).toBe('g');
    expect(s.resultDefs).toEqual([bindingIdx(cfg, 'x')]);
    expect(s.args).toEqual([[bindingIdx(cfg, 'y')]]);
    // `at` is the call_expression start `g` (col 12, after `    val x = `).
    expect(s.at).toEqual([2, 12]);
  });

  it('x = g(y) assignment → resultDefs carries x (plain = scalar lvalue)', () => {
    const cfg = kotlin.cfgOf(`fun f(y: Int) {\n    var x = 0\n    x = g(y)\n}\n`);
    const s = siteFact(cfg, 3).sites![0];
    expect(s.callee).toBe('g');
    expect(s.resultDefs).toEqual([bindingIdx(cfg, 'x')]);
    expect(s.args).toEqual([[bindingIdx(cfg, 'y')]]);
  });

  it('nested call exec(escape(x)) → inner site parent-linked, occurrence via-tagged', () => {
    const cfg = kotlin.cfgOf(`fun f(x: Int) {\n    exec(escape(x))\n}\n`);
    const sites = siteFact(cfg, 2).sites!;
    expect(sites).toHaveLength(2);
    const execIdx = sites.findIndex((s) => s.callee === 'exec');
    const escapeIdx = sites.findIndex((s) => s.callee === 'escape');
    const x = bindingIdx(cfg, 'x');
    expect(sites[escapeIdx].args).toEqual([[x]]);
    expect(sites[escapeIdx].parent).toEqual([execIdx, 0]);
    expect(sites[execIdx].args).toEqual([[[x, escapeIdx]]]);
  });

  it('exec(*args) → spread index recorded, args binding occurs at the position', () => {
    const cfg = kotlin.cfgOf(`fun f(args: IntArray) {\n    exec(*args)\n}\n`);
    const s = siteFact(cfg, 2).sites![0];
    expect(s.callee).toBe('exec');
    expect(s.spread).toBe(0);
    expect(s.args).toEqual([[bindingIdx(cfg, 'args')]]);
  });

  it('named argument foo(k = v) → only the value v is an occurrence (name is not a use)', () => {
    const cfg = kotlin.cfgOf(`fun f(v: Int) {\n    foo(k = v)\n}\n`);
    const s = siteFact(cfg, 2).sites![0];
    expect(s.callee).toBe('foo');
    // `k` mints no binding; `v` occurs at position 0.
    expect(bindingIdxs(cfg, 'k')).toHaveLength(0);
    expect(s.args).toEqual([[bindingIdx(cfg, 'v')]]);
  });

  it('req.body value read → a member-read site (no call), object = req', () => {
    const cfg = kotlin.cfgOf(`fun f(req: Req) {\n    val b = req.body\n}\n`);
    const sites = siteFact(cfg, 2).sites!;
    const read = sites.find((s) => s.kind === 'member-read')!;
    expect(read.object).toBe(bindingIdx(cfg, 'req'));
    expect(read.property).toBe('body');
    expect(sites.filter((s) => s.kind === 'call')).toHaveLength(0);
  });

  it('def/use facts stay intact alongside the new sites (regression guard)', () => {
    const cfg = kotlin.cfgOf(`fun f(y: Int) {\n    val x = g(y)\n    use(x)\n}\n`);
    const x = bindingIdx(cfg, 'x');
    const y = bindingIdx(cfg, 'y');
    // the binding table + def/use are coherent: x is defined, y and x are used.
    expect(defsOf(cfg)).toContain(x);
    expect(usesOf(cfg)).toContain(y);
    expect(usesOf(cfg)).toContain(x);
    expect(cfg.bindings![y].kind).toBe('param');
  });
});

// ── Ruby call-site harvest ───────────────────────────────────────────────────
// Drives the REAL Ruby CFG visitor (RubyHarvester) against real source via the
// language-agnostic harness, mirroring the Python / Kotlin site tests above.
// EVERY Ruby call is a single `call` node (fields receiver?/method/arguments?):
// a free call `foo(a)`, an implicit-receiver paren-less command `puts x` /
// `attr_accessor :x`, a member call `obj.method(x)`, a safe-call `obj&.m()`, and
// a chained `a.b.c` (nested `call` receivers) are all `call` nodes — there is NO
// `command` node in this grammar. Ruby has no `new` (`Foo.new` is a member call),
// so every site is `kind: 'call'`. A receiver-only no-args `call` (`obj.field`)
// is grammatically a member call and the CALLS query tags it
// `@reference.call.member`, so it is a call site (NOT a member-read). The `at`
// anchor is byte-aligned with the Ruby `@reference.call.free/.member` CALLS
// anchor, which the scope query places on the WHOLE `call` node (the Go/Python/
// Kotlin whole-call model) — so for a member/chained call `at` starts at the
// RECEIVER. The grammar is loaded via `require` (like Python).

import { createRubyCfgVisitor } from '../../../src/core/ingestion/cfg/visitors/ruby.js';

const rubyGrammar = createRequire(import.meta.url)('tree-sitter-ruby') as Parameters<
  typeof makeCfgHarness
>[0];
const ruby: CfgHarness = makeCfgHarness(rubyGrammar, createRubyCfgVisitor(), 'fixture.rb');

describe('Ruby call-site harvest', () => {
  it('foo(a, b) → one call site, positions 0→[a], 1→[b], at the call node line/col', () => {
    const cfg = ruby.cfgOf(`def f(a, b)\n  foo(a, b)\nend\n`);
    const sites = siteFact(cfg, 2).sites!;
    expect(sites).toHaveLength(1);
    const s = sites[0];
    expect(s.kind).toBe('call');
    expect(s.callee).toBe('foo');
    expect(s.receiver).toBeUndefined();
    expect(s.args).toEqual([[bindingIdx(cfg, 'a')], [bindingIdx(cfg, 'b')]]);
    expect(s.parent).toBeUndefined();
    // `at` is the `call` node start: line 2 (1-based), col 2 (after `  ` indent).
    expect(s.at).toEqual([2, 2]);
  });

  it('obj.method(x) → dotted callee path + receiver = obj, at the call node start', () => {
    const cfg = ruby.cfgOf(`def f(obj, x)\n  obj.method(x)\nend\n`);
    const sites = siteFact(cfg, 2).sites!;
    expect(sites).toHaveLength(1);
    const s = sites[0];
    expect(s.callee).toBe('obj.method');
    expect(s.receiver).toBe(bindingIdx(cfg, 'obj'));
    expect(s.args).toEqual([[bindingIdx(cfg, 'x')]]);
    // the receiver use is recorded exactly once (no double-record).
    expect(siteFact(cfg, 2).uses.filter((u) => u === bindingIdx(cfg, 'obj'))).toHaveLength(1);
    // `at` is the call node start (the receiver `obj`), col 2 — NOT the method
    // name. The Ruby CALLS anchor keys on the same whole `call` node.
    expect(s.at).toEqual([2, 2]);
  });

  it('a.b.c chained → callee path a.b.c, receiver = root a, plus a mid-chain member read', () => {
    const cfg = ruby.cfgOf(`def f(a)\n  a.b.c\nend\n`);
    const sites = siteFact(cfg, 2).sites!;
    const call = sites.find((s) => s.kind === 'call')!;
    expect(call.callee).toBe('a.b.c');
    expect(call.receiver).toBe(bindingIdx(cfg, 'a'));
    // `at` is the whole `call` node start (the root `a`), col 2.
    expect(call.at).toEqual([2, 2]);
    // the innermost access `a.b` (the non-callee load) is a member read.
    const read = sites.find((s) => s.kind === 'member-read')!;
    expect(read.object).toBe(bindingIdx(cfg, 'a'));
    expect(read.property).toBe('b');
  });

  it('implicit-receiver paren-less command puts x → site callee `puts`, arg x at position 0', () => {
    const cfg = ruby.cfgOf(`def f(x)\n  puts x\nend\n`);
    const sites = siteFact(cfg, 2).sites!;
    expect(sites).toHaveLength(1);
    const s = sites[0];
    expect(s.kind).toBe('call');
    expect(s.callee).toBe('puts');
    expect(s.receiver).toBeUndefined();
    expect(s.args).toEqual([[bindingIdx(cfg, 'x')]]);
    expect(s.at).toEqual([2, 2]);
  });

  it('attr_accessor :x command → site callee `attr_accessor` (symbol key is not an occurrence)', () => {
    const cfg = ruby.cfgOf(`def f\n  attr_accessor :x\nend\n`);
    const s = siteFact(cfg, 2).sites![0];
    expect(s.callee).toBe('attr_accessor');
    // the `:x` symbol argument mints no binding and is not a value occurrence.
    expect(bindingIdxs(cfg, 'x')).toHaveLength(0);
    expect(s.args).toBeUndefined();
  });

  it('obj&.m() safe-navigation → still a call site (callee obj.m, receiver = obj)', () => {
    const cfg = ruby.cfgOf(`def f(obj)\n  obj&.m()\nend\n`);
    const s = siteFact(cfg, 2).sites!.find((x) => x.kind === 'call')!;
    expect(s.kind).toBe('call');
    expect(s.callee).toBe('obj.m');
    expect(s.receiver).toBe(bindingIdx(cfg, 'obj'));
    expect(s.at).toEqual([2, 2]);
  });

  it('obj.field (no-arg member) → harvested as a call site (matches @reference.call.member)', () => {
    const cfg = ruby.cfgOf(`def f(obj)\n  y = obj.field\nend\n`);
    const sites = siteFact(cfg, 2).sites!;
    const call = sites.find((s) => s.kind === 'call')!;
    expect(call.callee).toBe('obj.field');
    expect(call.receiver).toBe(bindingIdx(cfg, 'obj'));
    // a single-access receiver is the callee itself — no separate member-read.
    expect(sites.filter((s) => s.kind === 'member-read')).toHaveLength(0);
  });

  it("multi-line call → the site's `at` line is the call node's start line", () => {
    const cfg = ruby.cfgOf(`def f(a, b)\n  foo(\n    a,\n    b,\n  )\nend\n`);
    const s = siteFact(cfg).sites![0];
    expect(s.callee).toBe('foo');
    // `call` starts on line 2 even though the args span lines 3-4.
    expect(s.at![0]).toBe(2);
    expect(s.at![1]).toBe(2);
    expect(s.args).toEqual([[bindingIdx(cfg, 'a')], [bindingIdx(cfg, 'b')]]);
  });

  it('two calls in one function → two distinct call sites', () => {
    const cfg = ruby.cfgOf(`def f(a, b)\n  foo(a)\n  bar(b)\nend\n`);
    const calls = allSites(cfg).filter((s) => s.kind === 'call');
    expect(calls.map((s) => s.callee).sort()).toEqual(['bar', 'foo']);
  });

  it('x = g(y) → resultDefs carries x; arg y occurs at position 0', () => {
    const cfg = ruby.cfgOf(`def f(y)\n  x = g(y)\nend\n`);
    const s = siteFact(cfg, 2).sites![0];
    expect(s.callee).toBe('g');
    expect(s.resultDefs).toEqual([bindingIdx(cfg, 'x')]);
    expect(s.args).toEqual([[bindingIdx(cfg, 'y')]]);
    // `at` is the `call` node start `g` (col 6, after `  x = `).
    expect(s.at).toEqual([2, 6]);
  });

  it('nested call exec(escape(x)) → inner site parent-linked, occurrence via-tagged', () => {
    const cfg = ruby.cfgOf(`def f(x)\n  exec(escape(x))\nend\n`);
    const sites = siteFact(cfg, 2).sites!;
    expect(sites).toHaveLength(2);
    const execIdx = sites.findIndex((s) => s.callee === 'exec');
    const escapeIdx = sites.findIndex((s) => s.callee === 'escape');
    const x = bindingIdx(cfg, 'x');
    expect(sites[escapeIdx].args).toEqual([[x]]);
    expect(sites[escapeIdx].parent).toEqual([execIdx, 0]);
    expect(sites[execIdx].args).toEqual([[[x, escapeIdx]]]);
  });

  it('exec(*xs) → spread index recorded, xs binding occurs at the position', () => {
    const cfg = ruby.cfgOf(`def f(xs)\n  exec(*xs)\nend\n`);
    const s = siteFact(cfg, 2).sites![0];
    expect(s.callee).toBe('exec');
    expect(s.spread).toBe(0);
    expect(s.args).toEqual([[bindingIdx(cfg, 'xs')]]);
  });

  it('keyword argument foo(k: v) → only the value v is an occurrence (key is not a use)', () => {
    const cfg = ruby.cfgOf(`def f(v)\n  foo(k: v)\nend\n`);
    const s = siteFact(cfg, 2).sites![0];
    expect(s.callee).toBe('foo');
    // `k` mints no binding; `v` occurs at position 0.
    expect(bindingIdxs(cfg, 'k')).toHaveLength(0);
    expect(s.args).toEqual([[bindingIdx(cfg, 'v')]]);
  });

  it('a do/{} block argument is opaque — not an arg occurrence (one site for the call)', () => {
    const cfg = ruby.cfgOf(`def f(xs)\n  xs.map { |i| g(i) }\nend\n`);
    // the outer `xs.map` is one call site anchored on line 2; the block body's
    // `g(i)` is the block's OWN CFG (opaque), so it is NOT an argument occurrence
    // of `xs.map` (filter by the call's `at` line, not the function-relative one).
    const onLine2 = allSites(cfg).filter((s) => (s.at?.[0] ?? -1) === 2);
    expect(onLine2).toHaveLength(1);
    expect(onLine2[0].callee).toBe('xs.map');
    expect(onLine2[0].receiver).toBe(bindingIdx(cfg, 'xs'));
    expect(onLine2[0].args).toBeUndefined();
  });

  it('def/use facts stay intact alongside the new sites (regression guard)', () => {
    const cfg = ruby.cfgOf(`def f(y)\n  x = g(y)\n  use(x)\nend\n`);
    const x = bindingIdx(cfg, 'x');
    const y = bindingIdx(cfg, 'y');
    // the binding table + def/use are coherent: x is defined, y and x are used.
    expect(defsOf(cfg)).toContain(x);
    expect(usesOf(cfg)).toContain(y);
    expect(usesOf(cfg)).toContain(x);
    expect(cfg.bindings![y].kind).toBe('param');
  });

  it('block param def/use are unchanged by the site harvest (block-handling regression)', () => {
    const blk = ruby.cfgsOf(`def f(xs)\n  xs.map { |item| item * 2 }\nend\n`)[1];
    const item = bindingIdx(blk, 'item');
    expect(defsOf(blk)).toContain(item);
    expect(usesOf(blk)).toContain(item);
  });
});

// ── Swift call-site harvest ──────────────────────────────────────────────────
// Drives the REAL Swift CFG visitor (SwiftHarvester) against real source via the
// language-agnostic harness, mirroring the Kotlin / Dart site tests above. A
// Swift call is a `call_expression` whose last child is a `call_suffix` (holding
// `value_arguments` / a trailing closure `lambda_literal`); the callee is the
// preceding `simple_identifier` (free / init) or `navigation_expression` (member
// / chained / optional-chain). Swift has no `new` — an init call `Foo(...)` is an
// ordinary `call_expression` (`kind: 'call'`). The `at` anchor is byte-aligned
// with the Swift `@reference.call.free/.member/.constructor` CALLS anchor, which
// the scope query places on the WHOLE `call_expression` node (the Kotlin/Go/
// Python whole-call model, NOT Dart's callee-name model) — so for a member /
// chained call `at` starts at the RECEIVER, exactly where the CALLS anchor
// starts. The grammar is VENDORED (loaded from vendor/ like the Dart/Kotlin
// tests). Each `at` below was confirmed byte-equal to the real
// `getSwiftScopeQuery` `@reference.call.*` atRange.

import { createSwiftCfgVisitor } from '../../../src/core/ingestion/cfg/visitors/swift.js';

const swiftGrammar = requireVendoredGrammar('tree-sitter-swift') as Parameters<
  typeof makeCfgHarness
>[0];
const swift: CfgHarness = makeCfgHarness(swiftGrammar, createSwiftCfgVisitor(), 'fixture.swift');

describe('Swift call-site harvest', () => {
  it('foo(a, b) → one call site, positions 0→[a], 1→[b], at the call_expression line/col', () => {
    const cfg = swift.cfgOf(`func f(a: Int, b: Int) {\n    foo(a, b)\n}\n`);
    const sites = siteFact(cfg, 2).sites!;
    expect(sites).toHaveLength(1);
    const s = sites[0];
    expect(s.kind).toBe('call');
    expect(s.callee).toBe('foo');
    expect(s.receiver).toBeUndefined();
    expect(s.args).toEqual([[bindingIdx(cfg, 'a')], [bindingIdx(cfg, 'b')]]);
    expect(s.parent).toBeUndefined();
    // `at` is the `call_expression` node start: line 2 (1-based), col 4 (indent).
    expect(s.at).toEqual([2, 4]);
  });

  it('obj.method(x) → dotted callee path + receiver = obj, at the call_expression start', () => {
    const cfg = swift.cfgOf(`func f(obj: Foo, x: Int) {\n    obj.method(x)\n}\n`);
    const sites = siteFact(cfg, 2).sites!;
    expect(sites).toHaveLength(1);
    const s = sites[0];
    expect(s.callee).toBe('obj.method');
    expect(s.receiver).toBe(bindingIdx(cfg, 'obj'));
    expect(s.args).toEqual([[bindingIdx(cfg, 'x')]]);
    // chain-length-1 callee: the access IS the callee — no member-read site, and
    // the receiver use is recorded exactly once.
    expect(siteFact(cfg, 2).uses.filter((u) => u === bindingIdx(cfg, 'obj'))).toHaveLength(1);
    // `at` is the call_expression start (the receiver `obj`), col 4 — NOT the
    // method name. The Swift CALLS anchor keys on the same call_expression node.
    expect(s.at).toEqual([2, 4]);
  });

  it('a.b.c() → callee path a.b.c, receiver = root a, plus a mid-chain member read', () => {
    const cfg = swift.cfgOf(`func f(a: Foo) {\n    a.b.c()\n}\n`);
    const sites = siteFact(cfg, 2).sites!;
    const call = sites.find((s) => s.kind === 'call')!;
    expect(call.callee).toBe('a.b.c');
    expect(call.receiver).toBe(bindingIdx(cfg, 'a'));
    // `at` is the whole call_expression start (the root `a`), col 4.
    expect(call.at).toEqual([2, 4]);
    // the innermost access `a.b` (the non-callee load) is a member read.
    const read = sites.find((s) => s.kind === 'member-read')!;
    expect(read.object).toBe(bindingIdx(cfg, 'a'));
    expect(read.property).toBe('b');
  });

  it('a?.b() optional-chain call → still a call site (callee a.b, receiver = a)', () => {
    const cfg = swift.cfgOf(`func f(a: Foo?) {\n    a?.b()\n}\n`);
    const sites = siteFact(cfg, 2).sites!;
    const call = sites.find((s) => s.kind === 'call')!;
    expect(call.kind).toBe('call');
    expect(call.callee).toBe('a.b');
    expect(call.receiver).toBe(bindingIdx(cfg, 'a'));
    expect(call.at).toEqual([2, 4]);
  });

  it('trailing closure xs.map { … } → one site for xs.map; the closure body is not an arg', () => {
    const cfg = swift.cfgOf(`func f(xs: [Int]) {\n    xs.map { x in x + 1 }\n}\n`);
    const sites = siteFact(cfg, 2).sites!;
    const call = sites.find((s) => s.kind === 'call')!;
    expect(call.callee).toBe('xs.map');
    expect(call.receiver).toBe(bindingIdx(cfg, 'xs'));
    // The trailing closure is a nested function body (opaque) — NOT an argument
    // occurrence, so the site records no args.
    expect(call.args).toBeUndefined();
    expect(call.at).toEqual([2, 4]);
    // the closure param `x` is invisible here (opaque nested scope).
    expect(bindingIdxs(cfg, 'x')).toHaveLength(0);
  });

  it("multi-line call → the site's `at` line is the call_expression's start line", () => {
    const cfg = swift.cfgOf(
      `func f(a: Int, b: Int) {\n    foo(\n        a,\n        b\n    )\n}\n`,
    );
    const s = siteFact(cfg).sites![0];
    expect(s.callee).toBe('foo');
    // `call_expression` starts on line 2 even though the args span lines 3-4.
    expect(s.at![0]).toBe(2);
    expect(s.at![1]).toBe(4);
    expect(s.args).toEqual([[bindingIdx(cfg, 'a')], [bindingIdx(cfg, 'b')]]);
  });

  it('two calls in one function → two distinct call sites', () => {
    const cfg = swift.cfgOf(`func f(a: Int, b: Int) {\n    foo(a)\n    bar(b)\n}\n`);
    const calls = allSites(cfg).filter((s) => s.kind === 'call');
    expect(calls.map((s) => s.callee).sort()).toEqual(['bar', 'foo']);
  });

  it('let x = g(y) → resultDefs carries x; arg y occurs at position 0', () => {
    const cfg = swift.cfgOf(`func f(y: Int) {\n    let x = g(y)\n}\n`);
    const s = siteFact(cfg, 2).sites![0];
    expect(s.callee).toBe('g');
    expect(s.resultDefs).toEqual([bindingIdx(cfg, 'x')]);
    expect(s.args).toEqual([[bindingIdx(cfg, 'y')]]);
    // `at` is the call_expression start `g` (col 12, after `    let x = `).
    expect(s.at).toEqual([2, 12]);
  });

  it('x = g(y) assignment → resultDefs carries x (plain = scalar lvalue)', () => {
    const cfg = swift.cfgOf(`func f(y: Int) {\n    var x = 0\n    x = g(y)\n}\n`);
    const s = siteFact(cfg, 3).sites![0];
    expect(s.callee).toBe('g');
    expect(s.resultDefs).toEqual([bindingIdx(cfg, 'x')]);
    expect(s.args).toEqual([[bindingIdx(cfg, 'y')]]);
  });

  it('init call let u = User(name: n) → kind call (Swift has no `new`)', () => {
    const cfg = swift.cfgOf(`func f(n: String) {\n    let u = User(name: n)\n}\n`);
    const s = siteFact(cfg, 2).sites![0];
    expect(s.kind).toBe('call');
    expect(s.callee).toBe('User');
    expect(s.resultDefs).toEqual([bindingIdx(cfg, 'u')]);
    // the labeled value `n` occurs at position 0 (the `name:` label is dropped).
    expect(s.args).toEqual([[bindingIdx(cfg, 'n')]]);
    // anchored on the call_expression start `User` (col 12) — matches the Swift
    // `@reference.call.constructor` anchor on the same node.
    expect(s.at).toEqual([2, 12]);
  });

  it('nested call exec(escape(x)) → inner site parent-linked, occurrence via-tagged', () => {
    const cfg = swift.cfgOf(`func f(x: Int) {\n    exec(escape(x))\n}\n`);
    const sites = siteFact(cfg, 2).sites!;
    expect(sites).toHaveLength(2);
    const execIdx = sites.findIndex((s) => s.callee === 'exec');
    const escapeIdx = sites.findIndex((s) => s.callee === 'escape');
    const x = bindingIdx(cfg, 'x');
    expect(sites[escapeIdx].args).toEqual([[x]]);
    expect(sites[escapeIdx].parent).toEqual([execIdx, 0]);
    expect(sites[execIdx].args).toEqual([[[x, escapeIdx]]]);
  });

  it('labeled argument foo(name: v) → only the value v is an occurrence (label is not a use)', () => {
    const cfg = swift.cfgOf(`func f(v: Int) {\n    foo(name: v)\n}\n`);
    const s = siteFact(cfg, 2).sites![0];
    expect(s.callee).toBe('foo');
    // `name` mints no binding; `v` occurs at position 0.
    expect(bindingIdxs(cfg, 'name')).toHaveLength(0);
    expect(s.args).toEqual([[bindingIdx(cfg, 'v')]]);
  });

  it('let b = req.body value read → a member-read site (no call), object = req', () => {
    const cfg = swift.cfgOf(`func f(req: Req) {\n    let b = req.body\n}\n`);
    const sites = siteFact(cfg, 2).sites!;
    const read = sites.find((s) => s.kind === 'member-read')!;
    expect(read.object).toBe(bindingIdx(cfg, 'req'));
    expect(read.property).toBe('body');
    expect(sites.filter((s) => s.kind === 'call')).toHaveLength(0);
  });

  it('def/use facts stay intact alongside the new sites (regression guard)', () => {
    const cfg = swift.cfgOf(`func f(y: Int) {\n    let x = g(y)\n    use(x)\n}\n`);
    const x = bindingIdx(cfg, 'x');
    const y = bindingIdx(cfg, 'y');
    // the binding table + def/use are coherent: x is defined, y and x are used.
    expect(defsOf(cfg)).toContain(x);
    expect(usesOf(cfg)).toContain(y);
    expect(usesOf(cfg)).toContain(x);
    expect(cfg.bindings![y].kind).toBe('param');
  });
});

// ── Rust call-site harvest ───────────────────────────────────────────────────
// Drives the REAL Rust CFG visitor (RustHarvester) against real source via the
// language-agnostic harness, mirroring the Swift / Kotlin / Python site tests
// above. Rust has ONE call node, `call_expression { function, arguments }`, whose
// `function` takes three shapes: a bare `identifier` (free `foo(x)`), a
// `field_expression` (method `a.method(x)` — `.` access, dotted callee + root
// receiver), and a `scoped_identifier` (path `Foo::bar(x)` / `a::b::c(x)` — the
// `::` segments joined with `.` so the LEAF is the tail, `Foo::bar` ⇒ leaf
// `bar`, matching the CALLS `@reference.name` tail capture AND calleesOfBlock's
// `lastIndexOf('.')` leaf rule). The turbofish `foo::<T>(x)` (`generic_function`)
// unwraps to the same site as `foo(x)`. Macros (`println!(…)`) are
// `macro_invocation`, NOT `call_expression`, and are tagged `@reference.macro`
// (a disjoint namespace) — NOT a call — so the harvester records NO site for
// them (its arg idents still walk for uses). Rust has no `new` — every site is
// `kind: 'call'`. The `at` anchor is byte-aligned with the Rust
// `@reference.call.free/.member/.constructor` CALLS anchor, which the scope query
// (captures.ts) places on the WHOLE `call_expression` node (the Swift/Go/Python/
// Kotlin whole-call model, NOT Dart's callee-name model) — so for a member /
// chained / path call `at` starts at the call's head segment (the receiver
// `a` / the path head `Foo`), exactly where the CALLS anchor starts. Each `at`
// below was confirmed byte-equal to the real `emitRustScopeCaptures`
// `@reference.call.*` atRange. The grammar is loaded the same way the Rust
// visitor test loads it (createRequire('tree-sitter-rust')).

import { createRustCfgVisitor } from '../../../src/core/ingestion/cfg/visitors/rust.js';

const rustGrammar = createRequire(import.meta.url)('tree-sitter-rust') as Parameters<
  typeof makeCfgHarness
>[0];
const rust: CfgHarness = makeCfgHarness(rustGrammar, createRustCfgVisitor(), 'fixture.rs');

describe('Rust call-site harvest', () => {
  it('foo(a, b) → one call site, positions 0→[a], 1→[b], at the call_expression line/col', () => {
    const cfg = rust.cfgOf(`fn f(a: i32, b: i32) {\n    foo(a, b);\n}\n`);
    const sites = siteFact(cfg, 2).sites!;
    expect(sites).toHaveLength(1);
    const s = sites[0];
    expect(s.kind).toBe('call');
    expect(s.callee).toBe('foo');
    expect(s.receiver).toBeUndefined();
    expect(s.args).toEqual([[bindingIdx(cfg, 'a')], [bindingIdx(cfg, 'b')]]);
    expect(s.parent).toBeUndefined();
    // `at` is the `call_expression` node start: line 2 (1-based), col 4 (indent),
    // byte-equal to the Rust `@reference.call.free` atRange [2,4].
    expect(s.at).toEqual([2, 4]);
  });

  it('a.method(x) → dotted callee path + receiver = a, at the call_expression start', () => {
    const cfg = rust.cfgOf(`fn f(a: Foo, x: i32) {\n    a.method(x);\n}\n`);
    const sites = siteFact(cfg, 2).sites!;
    expect(sites).toHaveLength(1);
    const s = sites[0];
    expect(s.callee).toBe('a.method');
    expect(s.receiver).toBe(bindingIdx(cfg, 'a'));
    expect(s.args).toEqual([[bindingIdx(cfg, 'x')]]);
    // chain-length-1 callee: the access IS the callee — no member-read site, and
    // the receiver use is recorded exactly once.
    expect(siteFact(cfg, 2).uses.filter((u) => u === bindingIdx(cfg, 'a'))).toHaveLength(1);
    // `at` is the call_expression start (the receiver `a`), col 4 — NOT the method
    // name. The Rust `@reference.call.member` anchor keys on the same node ([2,4]).
    expect(s.at).toEqual([2, 4]);
  });

  it('a.b.c() → callee path a.b.c, receiver = root a, plus a mid-chain member read', () => {
    const cfg = rust.cfgOf(`fn f(a: Foo) {\n    a.b.c();\n}\n`);
    const sites = siteFact(cfg, 2).sites!;
    const call = sites.find((s) => s.kind === 'call')!;
    expect(call.callee).toBe('a.b.c');
    expect(call.receiver).toBe(bindingIdx(cfg, 'a'));
    // `at` is the whole call_expression start (the root `a`), col 4.
    expect(call.at).toEqual([2, 4]);
    // the innermost access `a.b` (the non-callee load) is a member read.
    const read = sites.find((s) => s.kind === 'member-read')!;
    expect(read.object).toBe(bindingIdx(cfg, 'a'));
    expect(read.property).toBe('b');
  });

  it('Foo::bar(x) path call → callee Foo.bar (leaf bar), no receiver (Foo is a type)', () => {
    const cfg = rust.cfgOf(`fn f(x: i32) {\n    Foo::bar(x);\n}\n`);
    const sites = siteFact(cfg, 2).sites!;
    expect(sites).toHaveLength(1);
    const s = sites[0];
    expect(s.kind).toBe('call');
    // `::` joined with `.` so the leaf (after last `.`) is the tail `bar` — the
    // SAME leaf the CALLS `@reference.name` tail-identifier capture produces, so
    // calleesOfBlock's `lastIndexOf('.')` slice yields `bar` and the name-fallback
    // stays correct.
    expect(s.callee).toBe('Foo.bar');
    expect(s.callee!.slice(s.callee!.lastIndexOf('.') + 1)).toBe('bar');
    // `Foo` is a type/module head — no value binding — so no receiver.
    expect(s.receiver).toBeUndefined();
    expect(s.args).toEqual([[bindingIdx(cfg, 'x')]]);
    // anchored on the call_expression start (`Foo`, col 4) — matches the Rust
    // `@reference.call.free` atRange [2,4] for the scoped form.
    expect(s.at).toEqual([2, 4]);
  });

  it('a::b::c(x) path call with a LOCAL head → callee a.b.c (leaf c), receiver = a', () => {
    const cfg = rust.cfgOf(`fn f(a: A, x: i32) {\n    a::b::c(x);\n}\n`);
    const s = siteFact(cfg, 2).sites![0];
    // multi-segment scoped path → joined with `.`; leaf after last `.` is `c`.
    expect(s.callee).toBe('a.b.c');
    expect(s.callee!.slice(s.callee!.lastIndexOf('.') + 1)).toBe('c');
    // the head segment `a` IS a bound local (a param), so it is the receiver.
    expect(s.receiver).toBe(bindingIdx(cfg, 'a'));
    expect(s.args).toEqual([[bindingIdx(cfg, 'x')]]);
    expect(s.at).toEqual([2, 4]);
  });

  it('turbofish foo::<T>(x) → unwraps generic_function to the same site as foo(x)', () => {
    const cfg = rust.cfgOf(`fn f(x: i32) {\n    foo::<T>(x);\n}\n`);
    const s = siteFact(cfg, 2).sites![0];
    expect(s.callee).toBe('foo');
    expect(s.args).toEqual([[bindingIdx(cfg, 'x')]]);
    expect(s.at).toEqual([2, 4]);
  });

  it('chained a.b().c() → two distinct call sites (inner a.b, outer call-rooted)', () => {
    const cfg = rust.cfgOf(`fn f(a: Foo) {\n    a.b().c();\n}\n`);
    const calls = siteFact(cfg, 2).sites!.filter((s) => s.kind === 'call');
    expect(calls).toHaveLength(2);
    // the inner `a.b()` is a member call with receiver = root a.
    const inner = calls.find((s) => s.callee === 'a.b')!;
    expect(inner.receiver).toBe(bindingIdx(cfg, 'a'));
    // the outer `(a.b()).c()` is rooted on a CALL result — no static callee path /
    // receiver — but it is still its own call site, anchored on the same line.
    const outer = calls.find((s) => s.callee === undefined)!;
    expect(outer.kind).toBe('call');
    expect(outer.receiver).toBeUndefined();
    expect(outer.at).toEqual([2, 4]);
  });

  it("multi-line call → the site's `at` line is the call_expression's start line", () => {
    const cfg = rust.cfgOf(`fn f(a: i32, b: i32) {\n    foo(\n        a,\n        b,\n    );\n}\n`);
    const s = siteFact(cfg).sites![0];
    expect(s.callee).toBe('foo');
    // `call_expression` starts on line 2 even though the args span lines 3-4.
    expect(s.at![0]).toBe(2);
    expect(s.at![1]).toBe(4);
    expect(s.args).toEqual([[bindingIdx(cfg, 'a')], [bindingIdx(cfg, 'b')]]);
  });

  it('two calls in one function → two distinct call sites', () => {
    const cfg = rust.cfgOf(`fn f(a: i32, b: i32) {\n    foo(a);\n    bar(b);\n}\n`);
    const calls = allSites(cfg).filter((s) => s.kind === 'call');
    expect(calls.map((s) => s.callee).sort()).toEqual(['bar', 'foo']);
  });

  it('let r = g(x) → resultDefs carries r; arg x occurs at position 0', () => {
    const cfg = rust.cfgOf(`fn f(x: i32) {\n    let r = g(x);\n}\n`);
    const s = siteFact(cfg, 2).sites![0];
    expect(s.callee).toBe('g');
    expect(s.resultDefs).toEqual([bindingIdx(cfg, 'r')]);
    expect(s.args).toEqual([[bindingIdx(cfg, 'x')]]);
    // `at` is the call_expression start `g` (col 12, after `    let r = `).
    expect(s.at).toEqual([2, 12]);
  });

  it('r = g(x) plain assignment → resultDefs carries r (scalar lvalue)', () => {
    const cfg = rust.cfgOf(`fn f(x: i32) {\n    let mut r = 0;\n    r = g(x);\n}\n`);
    const s = siteFact(cfg, 3).sites![0];
    expect(s.callee).toBe('g');
    expect(s.resultDefs).toEqual([bindingIdx(cfg, 'r')]);
    expect(s.args).toEqual([[bindingIdx(cfg, 'x')]]);
  });

  it('foo(x)? try-call → still one call site (the ? wraps the call_expression)', () => {
    const cfg = rust.cfgOf(`fn f(x: i32) -> Result<(), ()> {\n    foo(x)?;\n    Ok(())\n}\n`);
    const s = siteFact(cfg, 2).sites![0];
    expect(s.callee).toBe('foo');
    expect(s.args).toEqual([[bindingIdx(cfg, 'x')]]);
    expect(s.at).toEqual([2, 4]);
  });

  it('nested call exec(escape(x)) → inner site parent-linked, occurrence via-tagged', () => {
    const cfg = rust.cfgOf(`fn f(x: i32) {\n    exec(escape(x));\n}\n`);
    const sites = siteFact(cfg, 2).sites!;
    expect(sites).toHaveLength(2);
    const execIdx = sites.findIndex((s) => s.callee === 'exec');
    const escapeIdx = sites.findIndex((s) => s.callee === 'escape');
    const x = bindingIdx(cfg, 'x');
    expect(sites[escapeIdx].args).toEqual([[x]]);
    expect(sites[escapeIdx].parent).toEqual([execIdx, 0]);
    expect(sites[execIdx].args).toEqual([[[x, escapeIdx]]]);
  });

  it('println!(...) macro → NO call site recorded (disjoint @reference.macro namespace)', () => {
    const cfg = rust.cfgOf(`fn f(x: i32) {\n    println!("{}", x);\n}\n`);
    // A macro is not a call_expression and is resolved via the MacroRegistry, NOT
    // CALLS — so the harvester records no site (no spurious `println` callee), but
    // the macro's argument identifier `x` still walks for a use.
    expect(allSites(cfg)).toHaveLength(0);
    expect(usesOf(cfg)).toContain(bindingIdx(cfg, 'x'));
  });

  it('a.b field read (no call) → a member-read site, object = a', () => {
    const cfg = rust.cfgOf(`fn f(a: Foo) {\n    let _v = a.b;\n}\n`);
    const sites = siteFact(cfg, 2).sites!;
    const read = sites.find((s) => s.kind === 'member-read')!;
    expect(read.object).toBe(bindingIdx(cfg, 'a'));
    expect(read.property).toBe('b');
    expect(sites.filter((s) => s.kind === 'call')).toHaveLength(0);
  });

  it('def/use facts stay intact alongside the new sites (regression guard)', () => {
    const cfg = rust.cfgOf(`fn f(y: i32) {\n    let x = g(y);\n    use(x);\n}\n`);
    const x = bindingIdx(cfg, 'x');
    const y = bindingIdx(cfg, 'y');
    // the binding table + def/use are coherent: x is defined, y and x are used.
    expect(defsOf(cfg)).toContain(x);
    expect(usesOf(cfg)).toContain(y);
    expect(usesOf(cfg)).toContain(x);
    expect(cfg.bindings![y].kind).toBe('param');
  });

  // ── struct-literal constructors (U4) ──────────────────────────────────────
  // A struct literal `Point { x: 1 }` is a `struct_expression`, NOT a
  // `call_expression`; the Rust CALLS query tags it `@reference.call.constructor`,
  // so the harvester records a `kind: 'new'` site whose callee leaf is the struct
  // TYPE tail (so the resolved constructor id joins into `calleeIds`). The `at` is
  // the `struct_expression` start — byte-equal to the
  // `@reference.call.constructor` atRange (verified byte-exact for plain / scoped /
  // turbofish forms; all anchor on col 12 after `    let p = `).

  it('let p = Point { x: 1, y: 2 } → one kind:new site, callee Point, at the struct_expression start', () => {
    const cfg = rust.cfgOf(`fn f() {\n    let p = Point { x: 1, y: 2 };\n}\n`);
    const sites = siteFact(cfg, 2).sites!;
    const newSites = sites.filter((s) => s.kind === 'new');
    expect(newSites).toHaveLength(1);
    const s = newSites[0];
    expect(s.kind).toBe('new');
    expect(s.callee).toBe('Point');
    // a bare type head is no value binding ⇒ no receiver.
    expect(s.receiver).toBeUndefined();
    // `at` is the `struct_expression` start (col 12, after `    let p = `), byte-equal
    // to the Rust `@reference.call.constructor` atRange [2,12].
    expect(s.at).toEqual([2, 12]);
  });

  it('scoped mymod::Point { x: 1 } → callee path mymod.Point whose leaf is Point', () => {
    const cfg = rust.cfgOf(`fn f() {\n    let p = mymod::Point { x: 1 };\n}\n`);
    const s = siteFact(cfg, 2).sites!.find((x) => x.kind === 'new')!;
    // `::` joined with `.` so the leaf (after last `.`) is the tail `Point` — the
    // SAME tail the CALLS `@reference.name` capture resolves, so calleesOfBlock's
    // `lastIndexOf('.')` slice yields `Point`.
    expect(s.callee).toBe('mymod.Point');
    expect(s.callee!.slice(s.callee!.lastIndexOf('.') + 1)).toBe('Point');
    expect(s.receiver).toBeUndefined();
    expect(s.at).toEqual([2, 12]);
  });

  it('turbofish Foo::<i32> { x: 1 } → callee Foo (turbofish args dropped), at the struct start', () => {
    const cfg = rust.cfgOf(`fn f() {\n    let p = Foo::<i32> { x: 1 };\n}\n`);
    const s = siteFact(cfg, 2).sites!.find((x) => x.kind === 'new')!;
    expect(s.callee).toBe('Foo');
    expect(s.at).toEqual([2, 12]);
  });

  it('Point { x: f() } → the struct site PLUS the inner f() call site, x value recorded', () => {
    const cfg = rust.cfgOf(`fn f(y: i32) {\n    let p = Point { x: f(), y };\n}\n`);
    const sites = siteFact(cfg, 2).sites!;
    const structSite = sites.find((s) => s.kind === 'new')!;
    const callSite = sites.find((s) => s.kind === 'call')!;
    // the struct site is recorded as a constructor, the inner `f()` as its own call.
    expect(structSite.callee).toBe('Point');
    expect(callSite.callee).toBe('f');
    // the inner `f()` is the value of field `x` (position 0) — parent-linked to the
    // struct site, so the field value is tracked, not the field NAME.
    const structIdx = sites.indexOf(structSite);
    expect(callSite.parent).toEqual([structIdx, 0]);
    // the shorthand field `y` (position 1) records the local `y` as a value use.
    expect(structSite.args).toEqual([[], [bindingIdx(cfg, 'y')]]);
    expect(usesOf(cfg)).toContain(bindingIdx(cfg, 'y'));
  });

  it('struct literal def/use facts stay intact (regression guard)', () => {
    const cfg = rust.cfgOf(`fn f(a: i32) {\n    let p = Point { x: a };\n}\n`);
    const a = bindingIdx(cfg, 'a');
    const p = bindingIdx(cfg, 'p');
    // `p` is defined by the `let`; `a` (the field value) is used; field name `x` is not.
    expect(defsOf(cfg)).toContain(p);
    expect(usesOf(cfg)).toContain(a);
    expect(cfg.bindings!.map((b) => b.name)).not.toContain('x');
  });
});
