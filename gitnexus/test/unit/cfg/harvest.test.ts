import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import type { SyntaxNode } from '../../../src/core/ingestion/utils/ast-helpers.js';
import {
  createTypeScriptCfgVisitor,
  TS_FUNCTION_TYPES,
} from '../../../src/core/ingestion/cfg/visitors/typescript.js';
import type { FunctionCfg, StatementFacts } from '../../../src/core/ingestion/cfg/types.js';

// U1 (#2082 M2) — per-statement def/use harvesting. The two-phase design
// (declaration pre-scan → resolve during the CFG walk) is what makes the
// walk-order traps pass: the visitor walks finally-before-try, for-init-last,
// and do-while-condition-first, so declare-as-you-walk would mis-key common
// code. Each test pins names→binding-index agreement, not just presence.

const visitor = createTypeScriptCfgVisitor();

function parse(code: string): SyntaxNode {
  const parser = new Parser();
  parser.setLanguage(TypeScript.typescript);
  return parser.parse(code).rootNode;
}

function collectFunctions(root: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const stack = [root];
  while (stack.length) {
    const n = stack.pop() as SyntaxNode;
    if (TS_FUNCTION_TYPES.has(n.type)) out.push(n);
    for (let i = n.namedChildCount - 1; i >= 0; i--) {
      const c = n.namedChild(i);
      if (c) stack.push(c);
    }
  }
  return out;
}

function cfgOf(code: string, index = 0): FunctionCfg {
  const fns = collectFunctions(parse(code));
  const fn = fns[index];
  if (!fn) throw new Error(`no function at index ${index}`);
  const cfg = visitor.buildFunctionCfg(fn, 'fixture.ts');
  if (!cfg) throw new Error('buildFunctionCfg returned undefined');
  return cfg;
}

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
