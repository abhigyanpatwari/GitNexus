import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SupportedLanguages } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { refineRExportStatus } from '../../src/core/ingestion/languages/r/post-parse.js';
import {
  loadRPackageConfig,
  MAX_LISTED_DROPPED_PATTERNS,
  reportRExportPatternProblems,
  rExportPatternMatches,
  type RNamespaceInfo,
  type RPackageConfig,
} from '../../src/core/ingestion/languages/r/package-config.js';
import {
  compileLinearRegex,
  compileLinearRegexDetailed,
  MAX_PACKAGE_STATES,
  MAX_PACKAGE_WORK,
  MAX_SHARED_STATES,
  MAX_SHARED_WORK,
  MAX_STATES,
  MAX_TOTAL_WORK,
  SharedWorkBudget,
  type LinearRegex,
} from '../../src/core/ingestion/languages/r/linear-regex.js';
import {
  compileRExportPattern,
  compileRExportPatternDetailed,
} from '../../src/core/ingestion/languages/r/export-pattern.js';
import { _captureLogger } from '../../src/core/logger.js';
import { createTempDirPool } from '../helpers/temp-dir-pool.js';

/** A pattern that keeps hundreds of states active on a long name: exhausts a matcher fast. */
const hostile = (k: number): string => `${'a?'.repeat(500)}c${k}`;

const distinctNames = (count: number, prefix = 94): string[] =>
  Array.from({ length: count }, (_, i) => 'a'.repeat(prefix) + String(i).padStart(5, '0') + 'a');

describe('a shared work budget bounds the total across matchers', () => {
  it('is larger than one matcher budget, so a single heavy pattern is not cut earlier', () => {
    expect(MAX_SHARED_WORK).toBeGreaterThan(MAX_TOTAL_WORK);
  });

  it('charges every matcher that draws on it and stops them all once it is spent', () => {
    const budget = new SharedWorkBudget(2_000_000);
    const first = compileLinearRegex(hostile(1), budget) as LinearRegex;
    const second = compileLinearRegex(hostile(2), budget) as LinearRegex;
    const names = distinctNames(5_000);

    for (const name of names) first.test(name);
    expect(first.exhausted).toBe(true);
    // One position may overshoot the check by a closure, never by more.
    expect(budget.spent).toBeLessThanOrEqual(2_000_000 + 4 * first.stateCount);
    expect(budget.spent).toBe(first.work);

    // The second matcher never ran, yet it stops at once: no work, exhausted, false.
    const before = budget.spent;
    for (const name of names) expect(second.test(name)).toBe(false);
    expect(second.exhausted).toBe(true);
    expect(second.work).toBe(0);
    expect(budget.spent).toBe(before);
  });

  it('keeps answering names it already decided after the budget is spent', () => {
    const budget = new SharedWorkBudget(1_000_000);
    const matcher = compileLinearRegex('^foo_', budget) as LinearRegex;
    expect(matcher.test('foo_bar')).toBe(true);
    expect(matcher.test('bar')).toBe(false);
    const spender = compileLinearRegex(hostile(3), budget) as LinearRegex;
    for (const name of distinctNames(5_000)) spender.test(name);
    expect(spender.exhausted).toBe(true);
    expect(matcher.test('foo_bar')).toBe(true);
    expect(matcher.test('bar')).toBe(false);
    expect(matcher.exhausted).toBe(false);
    // A name it has not decided is read as not matching, and is reported.
    expect(matcher.test('foo_new')).toBe(false);
    expect(matcher.exhausted).toBe(true);
  });

  it('still applies the per-matcher cap with a budget that is not yet spent', () => {
    const budget = new SharedWorkBudget(10 * MAX_TOTAL_WORK);
    const matcher = compileLinearRegex(hostile(4), budget) as LinearRegex;
    for (const name of distinctNames(30_000)) matcher.test(name);
    expect(matcher.exhausted).toBe(true);
    expect(matcher.work).toBeLessThanOrEqual(MAX_TOTAL_WORK + 4 * matcher.stateCount);
    expect(budget.spent).toBe(matcher.work);
  }, 60_000);

  it('is deterministic: the same inputs spend the same work', () => {
    const run = (): number[] => {
      const budget = new SharedWorkBudget(3_000_000);
      const matchers = [hostile(5), hostile(6), '^(get|set)_'].map(
        (p) => compileLinearRegex(p, budget) as LinearRegex,
      );
      for (const name of distinctNames(2_000)) for (const m of matchers) m.test(name);
      return [...matchers.map((m) => m.work), budget.spent];
    };
    expect(run()).toEqual(run());
  });

  it('threads through compileRExportPattern', () => {
    const budget = new SharedWorkBudget(100_000);
    const m = compileRExportPattern(hostile(7), budget);
    for (const name of distinctNames(500)) m?.test(name);
    expect(m?.exhausted).toBe(true);
    expect(budget.spent).toBeLessThanOrEqual(100_000 + 4_000);
  });
});

describe('budgets nest: a package draws on its own sub-budget and on the load', () => {
  it('orders the caps: package inside load, load above one matcher', () => {
    expect(MAX_PACKAGE_WORK).toBeLessThan(MAX_SHARED_WORK);
    expect(MAX_PACKAGE_STATES).toBeLessThan(MAX_SHARED_STATES);
    expect(MAX_PACKAGE_STATES).toBeGreaterThanOrEqual(MAX_STATES);
  });

  it('charges a child to its parent, not to its sibling, and spends the parent with it', () => {
    const load = new SharedWorkBudget(1_000, 100);
    const a = load.child(600, 60);
    const b = load.child(600, 60);
    a.charge(500);
    expect([a.spent, b.spent, load.spent]).toEqual([500, 0, 500]);
    expect([a.isSpent, b.isSpent, load.isSpent]).toEqual([false, false, false]);
    a.charge(100);
    expect([a.isSpent, b.isSpent, load.isSpent]).toEqual([true, false, false]);
    b.charge(400);
    // The load is spent, and so is every package under it, whatever its own share.
    expect([a.isSpent, b.isSpent, load.isSpent]).toEqual([true, true, true]);
  });

  it('limits states by the tighter of package and load', () => {
    const load = new SharedWorkBudget(1_000, 100);
    const a = load.child(1_000, 80);
    const b = load.child(1_000, 80);
    expect(a.statesLeft).toBe(80);
    a.reserveStates(70);
    expect([a.statesLeft, b.statesLeft, load.statesLeft]).toEqual([10, 30, 30]);
    b.reserveStates(30);
    expect([a.statesLeft, b.statesLeft, load.statesLeft]).toEqual([0, 0, 0]);
  });

  it('refuses a pattern that does not fit the states left, without keeping its NFA', () => {
    const budget = new SharedWorkBudget(MAX_SHARED_WORK, 1_000);
    expect(compileLinearRegex('a'.repeat(600), budget)).not.toBeNull();
    // A pattern that fits is compiled.
    expect(compileLinearRegex('b'.repeat(200), budget)).not.toBeNull();
    const used = budget.states;
    expect(used).toBeGreaterThanOrEqual(800);
    expect(budget.statesLeft).toBeGreaterThan(0);

    const refused = compileLinearRegexDetailed('c'.repeat(600), budget);
    expect(refused.regex).toBeNull();
    expect('reason' in refused && refused.reason).toContain('allowance');
    // The refused build stopped at the allowance and kept nothing.
    expect(budget.states).toBe(used);
    // The first pattern that does not fit closes the allowance: even a tiny one is now
    // refused at once, so a remainder no pattern fits cannot make later patterns cost a
    // partial build each.
    expect(budget.statesLeft).toBe(0);
    const after = compileLinearRegexDetailed('^ok$', budget);
    expect(after.regex).toBeNull();
    expect('reason' in after && after.reason).toContain('allowance');
    expect(budget.states).toBe(used);
  });

  it('closes only the budgets whose allowance was the tight one', () => {
    const load = new SharedWorkBudget(MAX_SHARED_WORK, 1_000);
    const a = load.child(MAX_SHARED_WORK, 300);
    const b = load.child(MAX_SHARED_WORK, 800);
    expect(compileLinearRegex('x'.repeat(100), a)).not.toBeNull();
    // 300 - 101 = 199 left in `a`, which is tighter than the load's 899: only `a` closes.
    expect(compileLinearRegex('y'.repeat(400), a)).toBeNull();
    expect(a.statesLeft).toBe(0);
    expect(load.statesLeft).toBeGreaterThan(0);
    expect(compileLinearRegex('^ok$', b)).not.toBeNull();
  });

  it('threads the state allowance through compileRExportPatternDetailed', () => {
    const budget = new SharedWorkBudget(MAX_SHARED_WORK, 10);
    expect(compileRExportPatternDetailed('^[[:alpha:]]+', budget).matcher).not.toBeNull();
    const refused = compileRExportPatternDetailed('^[[:alpha:]]+_[[:digit:]]{20}', budget);
    expect(refused.matcher).toBeNull();
  });
});

describe('rExportPatternMatches stops asking matchers once the budget is spent', () => {
  const counting = (answer: boolean) => {
    const calls = { n: 0 };
    return {
      calls,
      matcher: {
        source: 'counting',
        test: () => {
          calls.n++;
          return answer;
        },
      },
    };
  };

  it('asks every matcher while the budget lasts, and answers like `some`', () => {
    const a = counting(false);
    const b = counting(true);
    const c = counting(true);
    const info = {
      exportPatterns: [a.matcher, b.matcher, c.matcher],
      exportPatternBudget: new SharedWorkBudget(),
    };
    expect(rExportPatternMatches(info, 'x')).toBe(true);
    expect([a.calls.n, b.calls.n, c.calls.n]).toEqual([1, 1, 0]);
    expect(info.exportPatternBudget.cutShort).toBe(false);
    expect(rExportPatternMatches({ exportPatterns: [a.matcher] }, 'x')).toBe(false);
  });

  it('calls no matcher after the budget is spent, however many patterns and names', () => {
    const budget = new SharedWorkBudget(1_000, 10_000_000);
    const hostileMatchers = Array.from({ length: 2_000 }, (_, i) => {
      const inner = compileLinearRegex(hostile(i), budget) as LinearRegex;
      const calls = { n: 0 };
      return {
        calls,
        matcher: {
          source: inner.source,
          test: (name: string) => {
            calls.n++;
            return inner.test(name);
          },
          get exhausted() {
            return inner.exhausted;
          },
        },
      };
    });
    const info = {
      exportPatterns: hostileMatchers.map((m) => m.matcher),
      exportPatternBudget: budget,
    };
    for (const name of distinctNames(5_000)) expect(rExportPatternMatches(info, name)).toBe(false);
    const calls = hostileMatchers.reduce((sum, m) => sum + m.calls.n, 0);
    // 10 million (pattern, name) pairs without the skip; a handful before the budget ran out.
    expect(calls).toBeLessThan(50);
    expect(budget.cutShort).toBe(true);
    expect(budget.spent).toBeLessThanOrEqual(1_000 + 4 * 16384);
  });

  it('is spent by a spent parent', () => {
    const load = new SharedWorkBudget(10);
    const pkg = load.child();
    load.charge(10);
    const probe = counting(true);
    expect(
      rExportPatternMatches({ exportPatterns: [probe.matcher], exportPatternBudget: pkg }, 'x'),
    ).toBe(false);
    expect(probe.calls.n).toBe(0);
  });
});

describe('loadRPackageConfig shares one work budget across every package it discovers', () => {
  const pool = createTempDirPool('gn-r-shared-budget-');

  const writePackage = (
    root: string,
    dir: string,
    name: string,
    patterns: readonly string[],
  ): void => {
    const pkgRoot = path.join(root, dir);
    fs.mkdirSync(path.join(pkgRoot, 'R'), { recursive: true });
    fs.writeFileSync(path.join(pkgRoot, 'DESCRIPTION'), `Package: ${name}\n`);
    fs.writeFileSync(
      path.join(pkgRoot, 'NAMESPACE'),
      patterns.map((p) => `exportPattern("${p}")`).join('\n') + '\n',
    );
  };

  const nodesFor = (names: readonly string[], file: string) => {
    const graph = createKnowledgeGraph();
    for (const name of names) {
      graph.addNode({
        id: `Function:${file}:${name}`,
        label: 'Function',
        properties: { name, filePath: file, language: SupportedLanguages.R, isExported: true },
      });
    }
    return graph;
  };

  const matchers = (config: RPackageConfig): LinearRegex[] =>
    [...config.namespaceInfoByPackageDir.values()].flatMap(
      (info) => info.exportPatterns as unknown as LinearRegex[],
    );

  const exportedNames = (graph: ReturnType<typeof createKnowledgeGraph>): string[] => {
    const out: string[] = [];
    graph.forEachNode((n) => {
      if (n.properties.isExported === true) out.push(String(n.properties.name));
    });
    return out.sort();
  };

  const captured = (run: () => void): string[] => {
    const cap = _captureLogger();
    try {
      run();
      return cap.records().map((r) => String(r.msg ?? ''));
    } finally {
      cap.restore();
    }
  };

  // Per-pattern budgets alone allow 200 patterns x 40M visits (~77 s); the shared budget
  // allows ~100M in total. The bound is asserted on the work counters below, not on wall-clock
  // time, which varies with the runner and with coverage instrumentation.
  it('bounds a NAMESPACE with 200 distinct hostile patterns', async () => {
    const root = pool.dir();
    const patterns = Array.from({ length: 200 }, (_, i) => `(a?){${600 + (i % 7) * 100}}c${i}`);
    writePackage(root, '', 'hostilepkg', patterns);
    const names = distinctNames(2_000);

    const config = await loadRPackageConfig(root);
    const graph = nodesFor(names, 'R/a.R');
    refineRExportStatus(graph, config);
    const messages = captured(() => reportRExportPatternProblems(config));

    const all = matchers(config);
    const info = config.namespaceInfoByPackageDir.get('');
    // The package's allowance of states fits only some of the 200 patterns; the others were
    // refused (listed up to a limit, the rest counted).
    expect(
      all.length +
        (info?.droppedExportPatterns?.length ?? 0) +
        (info?.omittedDroppedExportPatterns ?? 0),
    ).toBe(200);
    const total = all.reduce((sum, m) => sum + m.work, 0);
    // One package: it may spend its own share of the load's budget, no more.
    expect(total).toBeLessThanOrEqual(MAX_PACKAGE_WORK + 4 * 16384);
    // Nothing matched, so every name reads as unexported; every compiled pattern the
    // package's budget cut short is reported once.
    expect(exportedNames(graph)).toEqual([]);
    // At most MAX_LISTED_DROPPED_PATTERNS are named; the rest are summed in one line.
    expect(messages.filter((m) => m.includes('exceeded its work budget'))).toHaveLength(
      Math.min(all.length, MAX_LISTED_DROPPED_PATTERNS),
    );
    expect(messages.some((m) => m.includes('further exportPattern() arguments exceeded'))).toBe(
      all.length > MAX_LISTED_DROPPED_PATTERNS,
    );
  }, 60_000);

  it('spends the same work and drops the same patterns on every load', async () => {
    const root = pool.dir();
    writePackage(
      root,
      '',
      'detpkg',
      Array.from({ length: 40 }, (_, i) => `(a?){800}c${i}`),
    );
    const run = async (): Promise<Array<[number, boolean]>> => {
      const config = await loadRPackageConfig(root);
      refineRExportStatus(nodesFor(distinctNames(1_000), 'R/a.R'), config);
      return matchers(config).map((m) => [m.work, m.exhausted]);
    };
    expect(await run()).toEqual(await run());
  }, 60_000);

  it('spans packages: hostile patterns in several packages share the one budget', async () => {
    const root = pool.dir();
    for (let p = 0; p < 20; p++) {
      writePackage(
        root,
        `pkgs/p${p}`,
        `p${p}`,
        Array.from({ length: 5 }, (_, i) => `(a?){800}c${p}x${i}`),
      );
    }
    const config = await loadRPackageConfig(root);
    const graph = createKnowledgeGraph();
    for (let p = 0; p < 20; p++) {
      for (const name of distinctNames(500)) {
        graph.addNode({
          id: `Function:pkgs/p${p}/R/a.R:${name}`,
          label: 'Function',
          properties: {
            name,
            filePath: `pkgs/p${p}/R/a.R`,
            language: SupportedLanguages.R,
            isExported: true,
          },
        });
      }
    }
    refineRExportStatus(graph, config);
    const total = matchers(config).reduce((sum, m) => sum + m.work, 0);
    expect(matchers(config)).toHaveLength(100);
    expect(total).toBeLessThanOrEqual(MAX_SHARED_WORK + 4 * 16384);
    expect(matchers(config).some((m) => m.exhausted)).toBe(true);
  }, 60_000);

  it('does not penalise a monorepo of benign packages', async () => {
    const root = pool.dir();
    const patterns = ['^[[:alpha:]]+', '^(foo|bar)_', '\\\\.internal$'];
    const oracle = [/^[A-Za-z]+/, /^(foo|bar)_/, /\.internal$/];
    const expected: string[] = [];
    const graph = createKnowledgeGraph();
    for (let p = 0; p < 50; p++) {
      writePackage(root, `pkgs/p${p}`, `p${p}`, patterns);
      const names = [
        ...Array.from({ length: 30 }, (_, i) => `fn_${p}_${i}`),
        ...Array.from({ length: 10 }, (_, i) => `foo_${p}_${i}`),
        ...Array.from({ length: 10 }, (_, i) => `.hidden_${p}_${i}`),
        `thing${p}.internal`,
        `_private_${p}`,
      ];
      for (const name of names) {
        if (oracle.some((re) => re.test(name))) expected.push(name);
        graph.addNode({
          id: `Function:pkgs/p${p}/R/a.R:${name}`,
          label: 'Function',
          properties: {
            name,
            filePath: `pkgs/p${p}/R/a.R`,
            language: SupportedLanguages.R,
            isExported: true,
          },
        });
      }
    }
    const config = await loadRPackageConfig(root);
    refineRExportStatus(graph, config);

    expect(exportedNames(graph)).toEqual(expected.sort());
    const all = matchers(config);
    expect(all).toHaveLength(150);
    expect(all.some((m) => m.exhausted)).toBe(false);
    const total = all.reduce((sum, m) => sum + m.work, 0);
    expect(total).toBeLessThan(MAX_SHARED_WORK / 10);
    expect(captured(() => reportRExportPatternProblems(config))).toEqual([]);
  });

  const budgetOf = (info: RNamespaceInfo | undefined) => info?.exportPatternBudget;

  it('bounds a NAMESPACE of 50,000 distinct cheap patterns', async () => {
    const root = pool.dir();
    const patterns = Array.from({ length: 50_000 }, (_, i) => `^zq${i.toString(36)}_[a-z]+$`);
    writePackage(root, '', 'manypkg', patterns);
    const names = distinctNames(2_000, 30);

    const config = await loadRPackageConfig(root);
    const info = config.namespaceInfoByPackageDir.get('');
    const graph = nodesFor(names, 'R/a.R');
    refineRExportStatus(graph, config);
    const messages = captured(() => reportRExportPatternProblems(config));

    // What was compiled fits the package's allowance of states; the rest was refused
    // without being compiled, listed (a few) and counted (the rest), never 50,000 warnings.
    expect(budgetOf(info)?.states).toBeLessThanOrEqual(MAX_PACKAGE_STATES);
    expect(info?.exportPatterns.length).toBeLessThan(50_000);
    expect(info?.droppedExportPatterns).toHaveLength(MAX_LISTED_DROPPED_PATTERNS);
    expect(
      (info?.exportPatterns.length ?? 0) +
        (info?.droppedExportPatterns?.length ?? 0) +
        (info?.omittedDroppedExportPatterns ?? 0),
    ).toBe(50_000);
    expect(budgetOf(info)?.spent).toBeLessThanOrEqual(MAX_PACKAGE_WORK + 4 * 16384);
    // Warnings are bounded too: a listed few per package plus one summary line each.
    expect(messages.length).toBeLessThanOrEqual(2 * MAX_LISTED_DROPPED_PATTERNS + 4);
    expect(messages.some((m) => m.includes('further exportPattern()'))).toBe(true);
    expect(exportedNames(graph)).toEqual([]);
  }, 60_000);

  it('bounds the NFA states many packages of maximum-size patterns may keep', async () => {
    const root = pool.dir();
    // [a-z]{8000}Qk is about 8,000 states: 12 fill a package, ~60 the load.
    for (let p = 0; p < 30; p++) {
      writePackage(
        root,
        `pkgs/p${p}`,
        `p${p}`,
        Array.from({ length: 30 }, (_, i) => `[a-z]{8000}Q${p.toString(36)}${i.toString(36)}`),
      );
    }
    const config = await loadRPackageConfig(root);
    const infos = [...config.namespaceInfoByPackageDir.values()];
    expect(infos).toHaveLength(30);
    let kept = 0;
    let compiled = 0;
    for (const info of infos) {
      expect(budgetOf(info)?.states).toBeLessThanOrEqual(MAX_PACKAGE_STATES);
      for (const m of info.exportPatterns as unknown as LinearRegex[]) kept += m.stateCount;
      compiled += info.exportPatterns.length;
      // Every pattern is either compiled or dropped (and listed): none vanishes.
      expect(info.exportPatterns.length + (info.droppedExportPatterns?.length ?? 0)).toBe(30);
    }
    expect(kept).toBeLessThanOrEqual(MAX_SHARED_STATES);
    expect(kept).toBeGreaterThan(MAX_SHARED_STATES / 2);
    expect(compiled).toBeLessThan(100);
    expect(Math.max(...infos.map((i) => i.exportPatterns.length))).toBeLessThanOrEqual(12);
    const reasons = infos.flatMap((i) => (i.droppedExportPatterns ?? []).map((d) => d.reason));
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.every((r) => r.includes('allowance'))).toBe(true);
  }, 60_000);

  it('keeps the exports of benign packages after one hostile package', async () => {
    const root = pool.dir();
    // Directory order is a < b < c < d: the hostile package is processed first.
    writePackage(
      root,
      'a',
      'pa',
      Array.from({ length: 30 }, (_, i) => `(a?){${700 + (i % 5) * 100}}c${i}`),
    );
    const benign = ['b', 'c', 'd'];
    for (const dir of benign) writePackage(root, dir, `p${dir}`, ['^pub_', '^api[0-9]']);
    const config = await loadRPackageConfig(root);

    const graph = createKnowledgeGraph();
    const add = (dir: string, name: string) =>
      graph.addNode({
        id: `Function:${dir}/R/x.R:${name}`,
        label: 'Function',
        properties: {
          name,
          filePath: `${dir}/R/x.R`,
          language: SupportedLanguages.R,
          isExported: true,
        },
      });
    for (const name of distinctNames(600)) add('a', name);
    for (const dir of benign) {
      for (let i = 0; i < 40; i++) add(dir, `pub_${dir}${i}`);
      for (let i = 0; i < 10; i++) add(dir, `internal_${dir}${i}`);
    }
    refineRExportStatus(graph, config);

    const status = new Map<string, boolean>();
    graph.forEachNode((n) =>
      status.set(String(n.properties.name), n.properties.isExported === true),
    );
    // The hostile package spent its own share (30 %) and no more of the load's budget...
    const hostileBudget = budgetOf(config.namespaceInfoByPackageDir.get('a'));
    expect(hostileBudget?.isSpent).toBe(true);
    expect(hostileBudget?.cutShort).toBe(true);
    // ...so the load still has budget and the later packages are untouched.
    for (const dir of benign) {
      const b = budgetOf(config.namespaceInfoByPackageDir.get(dir));
      expect(b?.isSpent).toBe(false);
      expect(b?.cutShort).toBe(false);
      for (let i = 0; i < 40; i++)
        expect(status.get(`pub_${dir}${i}`), `pub_${dir}${i}`).toBe(true);
      for (let i = 0; i < 10; i++) expect(status.get(`internal_${dir}${i}`)).toBe(false);
    }
    // The hostile package's own names read as unexported, and it is reported pattern by pattern.
    for (const name of distinctNames(600)) expect(status.get(name)).toBe(false);
    const messages = captured(() => reportRExportPatternProblems(config));
    expect(messages).toHaveLength(30);
    expect(messages.every((m) => m.includes('R package a:'))).toBe(true);
  }, 60_000);
});
