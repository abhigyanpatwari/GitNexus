import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { createPhpCfgVisitor } from '../../../src/core/ingestion/cfg/visitors/php.js';
import type { FunctionCfg } from '../../../src/core/ingestion/cfg/types.js';
import {
  makeCfgHarness,
  type CfgHarness,
  block,
  edgeKinds,
  reaches,
  reachable,
  bindingIdx,
  allSites,
} from '../../helpers/cfg-harness.js';
import { isExitReachableFromAllBlocks } from '../../../src/core/ingestion/cfg/post-dominators.js';
import { computeControlDependence } from '../../../src/core/ingestion/cfg/control-dependence.js';

// The PHP CfgVisitor, one hazard per test (real-parser regression, NOT
// snapshot-pinning). Each fixture's distinctive statement text (a(), step(),
// handle($e), …) lets us locate the block for a region by text and assert the
// control-flow topology around it. tree-sitter-php's runtime grammar is the
// `php_only` export (matching parser-loader.ts).

const phpGrammar = (createRequire(import.meta.url)('tree-sitter-php') as { php_only: unknown })
  .php_only as Parameters<typeof makeCfgHarness>[0];

const php: CfgHarness = makeCfgHarness(phpGrammar, createPhpCfgVisitor(), 'fixture.php');

const wrap = (body: string): string => `<?php function f($x) { ${body} }`;

const hasDef = (cfg: FunctionCfg, idx: number): boolean =>
  cfg.blocks.some((bl) => bl.statements?.some((s) => s.defs.includes(idx)));
const hasUse = (cfg: FunctionCfg, idx: number): boolean =>
  cfg.blocks.some((bl) => bl.statements?.some((s) => s.uses.includes(idx)));
const hasMayDef = (cfg: FunctionCfg, idx: number): boolean =>
  cfg.blocks.some((bl) => bl.statements?.some((s) => (s.mayDefs ?? []).includes(idx)));

describe('PHP CfgVisitor — structure', () => {
  it('straight-line body: ENTRY → block → EXIT (seq)', () => {
    const cfg = php.cfgOf(`<?php function f() { a(); b(); c(); }`);
    expect(cfg.blocks.filter((b) => b.kind === 'normal')).toHaveLength(1);
    const body = block(cfg, 'a();');
    expect(cfg.edges).toContainEqual({ from: cfg.entryIndex, to: body, kind: 'seq' });
    expect(reaches(cfg, body, cfg.exitIndex)).toBe(true);
  });

  it('empty body: ENTRY → EXIT', () => {
    const cfg = php.cfgOf(`<?php function f() {}`);
    expect(cfg.blocks).toHaveLength(2);
    expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
  });

  it('method, anonymous function, and arrow function are CFG-bearing', () => {
    const cfgs = php.cfgsOf(
      `<?php class C { public function m($a) { return $a; } }
       $clo = function ($b) { return $b; };
       $arr = fn ($c) => $c * 2;`,
    );
    // method m, the closure, and the arrow = 3 CFGs.
    expect(cfgs.length).toBeGreaterThanOrEqual(3);
    for (const cfg of cfgs) expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
  });

  it('arrow function: one block returns its expression value', () => {
    const cfgs = php.cfgsOf(`<?php $g = fn ($z) => $z * 2;`);
    const arrow = cfgs.find((c) => c.blocks.some((b) => b.text === '$z * 2'));
    expect(arrow).toBeDefined();
    const body = arrow!.blocks.find((b) => b.text === '$z * 2')!.index;
    expect(arrow!.edges).toContainEqual({ from: body, to: arrow!.exitIndex, kind: 'return' });
  });

  it('abstract method (no body) → graceful undefined, no throw', () => {
    const root = php.parse(`<?php abstract class C { abstract public function m(); }`);
    const fns = php.collectFunctions(root);
    for (const fn of fns) {
      expect(() => createPhpCfgVisitor().buildFunctionCfg(fn, 'x.php')).not.toThrow();
    }
  });
});

describe('PHP CfgVisitor — branching', () => {
  it('if / elseif / else → cond-true & cond-false; join reachable', () => {
    const cfg = php.cfgOf(
      wrap(`if ($x > 0) { pos(); } elseif ($x < 0) { neg(); } else { zero(); } after();`),
    );
    const kinds = edgeKinds(cfg);
    expect(kinds.has('cond-true')).toBe(true);
    expect(kinds.has('cond-false')).toBe(true);
    const after = block(cfg, 'after();');
    expect(reaches(cfg, block(cfg, 'pos();'), after)).toBe(true);
    expect(reaches(cfg, block(cfg, 'neg();'), after)).toBe(true);
    expect(reaches(cfg, block(cfg, 'zero();'), after)).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });

  it('alternative colon if/elseif/else (endif) is modeled like the brace form', () => {
    const cfg = php.cfgOf(
      wrap(`if ($x): pos(); elseif ($x): mid(); else: zero(); endif; after();`),
    );
    const kinds = edgeKinds(cfg);
    expect(kinds.has('cond-true')).toBe(true);
    expect(kinds.has('cond-false')).toBe(true);
    const after = block(cfg, 'after();');
    expect(reaches(cfg, block(cfg, 'pos();'), after)).toBe(true);
    expect(reaches(cfg, block(cfg, 'zero();'), after)).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });
});

describe('PHP CfgVisitor — loops', () => {
  it('for: cond-true / loop-back / cond-false; body loops back', () => {
    const cfg = php.cfgOf(wrap(`for ($i = 0; $i < $x; $i++) { body(); } after();`));
    const kinds = edgeKinds(cfg);
    expect(kinds.has('cond-true')).toBe(true);
    expect(kinds.has('loop-back')).toBe(true);
    expect(kinds.has('cond-false')).toBe(true);
    expect(reaches(cfg, block(cfg, 'body();'), block(cfg, 'after();'))).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });

  it('foreach ($it as $v): loops with cond-true / loop-back / cond-false', () => {
    const cfg = php.cfgOf(wrap(`foreach ($x as $v) { use1($v); } after();`));
    const kinds = edgeKinds(cfg);
    expect(kinds.has('cond-true')).toBe(true);
    expect(kinds.has('loop-back')).toBe(true);
    expect(kinds.has('cond-false')).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });

  it('while: cond-true / loop-back / cond-false', () => {
    const cfg = php.cfgOf(wrap(`while ($x > 0) { tick(); } after();`));
    const kinds = edgeKinds(cfg);
    expect(kinds.has('cond-true')).toBe(true);
    expect(kinds.has('loop-back')).toBe(true);
    expect(kinds.has('cond-false')).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });

  it('do-while: body runs before the test (loop-back from the condition)', () => {
    const cfg = php.cfgOf(wrap(`do { tick(); } while ($x < 3); after();`));
    const kinds = edgeKinds(cfg);
    expect(kinds.has('loop-back')).toBe(true);
    expect(kinds.has('cond-false')).toBe(true);
    // The body is the loop entry — control reaches it before the condition.
    const body = block(cfg, 'tick();');
    expect(reachable(cfg, body)).toBe(true);
    expect(reaches(cfg, body, block(cfg, 'after();'))).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });

  it('while (true) {} keeps EXIT reverse-reachable AND emits CDG > 0', () => {
    const cfg = php.cfgOf(wrap(`while (true) { if ($x) { g(); } }`));
    // The inner `if` is a real control point; assert through the production
    // post-dom/CDG passes (matching go/python/ruby/rust/vue) — CDG is only
    // computed when EXIT stays reverse-reachable, so a non-empty CDG proves the
    // structural cond-false escape edge keeps the function CDG-bearing.
    expect(edgeKinds(cfg).has('cond-false')).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
  });

  it('for (;;) {} (no condition) keeps EXIT reverse-reachable', () => {
    const cfg = php.cfgOf(wrap(`for (;;) { step(); }`));
    expect(edgeKinds(cfg).has('cond-false')).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });
});

describe('PHP CfgVisitor — switch / match', () => {
  it('switch: C-style FALLTHROUGH (a case with no break flows to the next)', () => {
    const cfg = php.cfgOf(
      wrap(
        `switch ($x) { case 1: a(); break; case 2: b(); case 3: c(); break; default: d(); } e();`,
      ),
    );
    const kinds = edgeKinds(cfg);
    expect(kinds.has('switch-case')).toBe(true);
    expect(kinds.has('fallthrough')).toBe(true);
    // case 2 (no break) falls through to case 3.
    const c2 = block(cfg, 'b();');
    const c3 = block(cfg, 'c();');
    expect(cfg.edges).toContainEqual({ from: c2, to: c3, kind: 'fallthrough' });
    // case 1's break skips case 2's body, but the switch join is reachable.
    expect(reaches(cfg, block(cfg, 'a();'), block(cfg, 'e();'))).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });

  it('switch without break: no switch-case edge is mislabeled fallthrough at the dispatch', () => {
    const cfg = php.cfgOf(wrap(`switch ($x) { case 1: a(); } after();`));
    // No default → the no-match path reaches the join directly.
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    expect(reaches(cfg, block(cfg, 'a();'), block(cfg, 'after();'))).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });

  it('value-position match assignment dispatches; target bound at the join (#2207)', () => {
    const cfg = php.cfgOf(
      wrap(`$r = match ($x) { 1, 2 => low($x), default => high() }; use_it($r);`),
    );
    // arms dispatch as switch-case, never fall through.
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    expect(edgeKinds(cfg).has('fallthrough')).toBe(false);
    // each arm rejoins and reaches the downstream use of the bound result.
    expect(reaches(cfg, block(cfg, 'low($x)'), block(cfg, 'use_it($r)'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'high()'), block(cfg, 'use_it($r)'))).toBe(true);
    const r = bindingIdx(cfg, '$r');
    expect(hasDef(cfg, r)).toBe(true);
    expect(hasUse(cfg, r)).toBe(true);
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });

  it('return match (…) models each arm as returning the result (#2207)', () => {
    const cfg = php.cfgOf(wrap(`return match ($x) { 1 => a($x), 2 => b(), default => c() };`));
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    expect(edgeKinds(cfg).has('return')).toBe(true);
    expect(reaches(cfg, block(cfg, 'a($x)'), cfg.exitIndex)).toBe(true);
    expect(reaches(cfg, block(cfg, 'c()'), cfg.exitIndex)).toBe(true);
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });

  it('single-arm match / ternary stays inline (no real control dependence)', () => {
    const oneArm = php.cfgOf(wrap(`$r = match ($x) { default => 0 }; return $r;`));
    expect(edgeKinds(oneArm).has('switch-case')).toBe(false);
    const ternary = php.cfgOf(wrap(`$r = $x > 0 ? a() : b(); return $r;`));
    expect(edgeKinds(ternary).has('switch-case')).toBe(false);
    expect(isExitReachableFromAllBlocks(ternary)).toBe(true);
  });

  it('match without `default` keeps a no-match (UnhandledMatchError) edge; EXIT reachable (#2211)', () => {
    const cfg = php.cfgOf(wrap(`$r = match ($x) { 1 => a($x), 2 => b() }; use_it($r);`));
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
    // 2 arms + the conservative no-match path = 3 switch-case successors from the dispatch.
    const dispatchIdx = block(cfg, '$x');
    expect(cfg.edges.filter((e) => e.from === dispatchIdx && e.kind === 'switch-case').length).toBe(
      3,
    );
  });
});

describe('PHP CfgVisitor — try / catch / finally', () => {
  it('try/catch/finally: throw edges to the handler; normal flow crosses finally', () => {
    const cfg = php.cfgOf(
      wrap(`try { risky(); } catch (\\E $e) { handle($e); } finally { cleanup(); } after();`),
    );
    expect(edgeKinds(cfg).has('throw')).toBe(true);
    // Body and catch both reach the finally, then after().
    const fin = block(cfg, 'cleanup();');
    expect(reaches(cfg, block(cfg, 'risky();'), fin)).toBe(true);
    expect(reaches(cfg, block(cfg, 'handle($e)'), fin)).toBe(true);
    expect(reaches(cfg, fin, block(cfg, 'after();'))).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });

  it('multi-catch type list (TypeError | ValueError) catches and reaches the join', () => {
    const cfg = php.cfgOf(
      wrap(`try { risky(); } catch (\\TypeError | \\ValueError $e) { handle($e); } after();`),
    );
    expect(edgeKinds(cfg).has('throw')).toBe(true);
    expect(reaches(cfg, block(cfg, 'handle($e)'), block(cfg, 'after();'))).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });

  it('return inside try threads through finally (finally-return completion edge)', () => {
    const cfg = php.cfgOf(
      wrap(`try { if ($x) { return early(); } body(); } finally { release(); } return tail();`),
    );
    expect(edgeKinds(cfg).has('finally-return')).toBe(true);
    // The early return's first leg goes to the finally entry, not straight to EXIT.
    const ret = block(cfg, 'return early()');
    const fin = block(cfg, 'release();');
    expect(reaches(cfg, ret, fin)).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });
});

describe('PHP CfgVisitor — break N / continue N', () => {
  it('break 2 targets the 2nd enclosing loop (escapes both)', () => {
    const cfg = php.cfgOf(
      `<?php function f() {
        while (true) {
          for ($i = 0; ; $i++) {
            if (cond()) { break 2; }
            inner();
          }
          afterInner();
        }
        afterOuter();
      }`,
    );
    expect(edgeKinds(cfg).has('break')).toBe(true);
    const brk = block(cfg, 'break 2');
    // break 2 escapes the OUTER loop → reaches afterOuter(), NOT afterInner().
    expect(reaches(cfg, brk, block(cfg, 'afterOuter();'))).toBe(true);
    expect(reaches(cfg, brk, block(cfg, 'afterInner();'))).toBe(false);
  });

  it('continue 2 targets the 2nd enclosing loop header', () => {
    const cfg = php.cfgOf(
      `<?php function f() {
        while (cond1()) {
          for ($i = 0; $i < 3; $i++) {
            if (cond2()) { continue 2; }
            inner();
          }
        }
        done();
      }`,
    );
    expect(edgeKinds(cfg).has('continue')).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });

  it('bare break targets the nearest loop', () => {
    const cfg = php.cfgOf(wrap(`while ($x) { if ($x) { break; } step(); } after();`));
    expect(edgeKinds(cfg).has('break')).toBe(true);
    expect(reaches(cfg, block(cfg, 'break;'), block(cfg, 'after();'))).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });
});

describe('PHP CfgVisitor — def/use harvest', () => {
  it('$x = $a defines $x and uses $a', () => {
    const cfg = php.cfgOf(`<?php function f($a) { $x = $a; }`);
    expect(hasDef(cfg, bindingIdx(cfg, '$x'))).toBe(true);
    expect(hasUse(cfg, bindingIdx(cfg, '$a'))).toBe(true);
  });

  it('[$a, $b] = f() and list($c, $d) = g() define all targets', () => {
    const cfg = php.cfgOf(`<?php function f() { [$a, $b] = h(); list($c, $d) = g(); }`);
    for (const name of ['$a', '$b', '$c', '$d']) {
      expect(hasDef(cfg, bindingIdx(cfg, name))).toBe(true);
    }
  });

  it('foreach ($it as $k => $v) defines both $k and $v', () => {
    const cfg = php.cfgOf(`<?php function f($it) { foreach ($it as $k => $v) { use1($k, $v); } }`);
    expect(hasDef(cfg, bindingIdx(cfg, '$k'))).toBe(true);
    expect(hasDef(cfg, bindingIdx(cfg, '$v'))).toBe(true);
    expect(hasUse(cfg, bindingIdx(cfg, '$it'))).toBe(true);
  });

  it('catch (T $e) defines the exception variable', () => {
    const cfg = php.cfgOf(`<?php function f() { try { r(); } catch (\\E $e) { log($e); } }`);
    expect(hasDef(cfg, bindingIdx(cfg, '$e'))).toBe(true);
  });

  it('parameters (incl. default, variadic, by-ref) are ENTRY defs', () => {
    const cfg = php.cfgOf(`<?php function f($a, $b = 1, &$c, ...$rest) { use1($a); }`);
    for (const name of ['$a', '$b', '$c', '$rest']) {
      expect(hasDef(cfg, bindingIdx(cfg, name))).toBe(true);
    }
  });

  it('conditional def (right of &&) is a may-def, not a must-def', () => {
    const cfg = php.cfgOf(`<?php function f($a) { $r = $a && ($x = load()); }`);
    const x = bindingIdx(cfg, '$x');
    expect(hasMayDef(cfg, x)).toBe(true);
    expect(hasDef(cfg, x)).toBe(false);
  });

  it('property write ($o->p = v) is NOT a scalar def — $o is a use only', () => {
    // $o is a local (not a param) so the only def site that could exist is the
    // member-write itself — which must NOT count as a scalar def.
    const cfg = php.cfgOf(`<?php function f() { $o = make(); $o->prop = compute(); }`);
    expect(hasUse(cfg, bindingIdx(cfg, '$o'))).toBe(true);
    // The member-write defines no scalar binding for `prop` — it never appears
    // as a binding name in the table.
    expect((cfg.bindings ?? []).some((b) => b.name === 'prop' || b.name === '$prop')).toBe(false);
  });

  it('closure use ($b, &$c) captures bind in the closure body', () => {
    const cfgs = php.cfgsOf(
      `<?php function outer($b) { return function ($a) use ($b, &$c) { return $a + $b + $c; }; }`,
    );
    const closure = cfgs.find((c) => (c.bindings ?? []).some((bd) => bd.name === '$a'));
    expect(closure).toBeDefined();
    expect((closure!.bindings ?? []).some((bd) => bd.name === '$b')).toBe(true);
    expect((closure!.bindings ?? []).some((bd) => bd.name === '$c')).toBe(true);
  });
});

describe('PHP CfgVisitor — taint-site substrate', () => {
  it('records a call site with a callee path for a function call', () => {
    const cfg = php.cfgOf(`<?php function f($req) { exec($req); }`);
    const sites = allSites(cfg);
    expect(sites.some((s) => s.kind === 'call' && s.callee === 'exec')).toBe(true);
  });

  it('records a member-call receiver + callee (db->query)', () => {
    const cfg = php.cfgOf(`<?php function f($req) { $db->query($req); }`);
    const sites = allSites(cfg);
    const call = sites.find((s) => s.kind === 'call' && (s.callee ?? '').endsWith('query'));
    expect(call).toBeDefined();
    expect(call!.receiver).toBe(bindingIdx(cfg, '$db'));
  });

  it('nested sanitizer call exec(escape($req)) is via-tagged for interposition', () => {
    const cfg = php.cfgOf(`<?php function f($req) { exec(escape($req)); }`);
    const sites = allSites(cfg);
    expect(sites.some((s) => s.callee === 'exec')).toBe(true);
    expect(sites.some((s) => s.callee === 'escape')).toBe(true);
  });
});

describe('PHP CfgVisitor — robustness', () => {
  it('unmodeled / malformed body shape → graceful partial CFG, never throws', () => {
    // Deeply nested + a syntax-error tail. The visitor must not throw out.
    const root = php.parse(`<?php function f($x) { if ($x) { while (true) { @@@ } } }`);
    const fns = php.collectFunctions(root);
    for (const fn of fns) {
      expect(() => createPhpCfgVisitor().buildFunctionCfg(fn, 'x.php')).not.toThrow();
    }
  });

  it('goto / named label are modeled as straight-line blocks (no crash)', () => {
    const cfg = php.cfgOf(`<?php function f() { start(); goto end; end: done(); }`);
    expect(reachable(cfg, block(cfg, 'done()'))).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });

  it('a truncated value-position match never throws out of the carrier path (R4) (#2211)', () => {
    const root = php.parse(`<?php function f($x){ $r = match ($x) { 1 => a(`);
    for (const fn of php.collectFunctions(root)) {
      expect(() => createPhpCfgVisitor().buildFunctionCfg(fn, 'x.php')).not.toThrow();
    }
  });
});
