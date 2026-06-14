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
