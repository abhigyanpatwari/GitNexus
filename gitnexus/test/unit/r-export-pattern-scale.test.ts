import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SupportedLanguages } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { refineRExportStatus } from '../../src/core/ingestion/languages/r/post-parse.js';
import {
  loadRPackageConfig,
  reportRExportPatternProblems,
  type RPackageConfig,
} from '../../src/core/ingestion/languages/r/package-config.js';
import {
  compileLinearRegex,
  MAX_PATTERN_LENGTH,
  MAX_STATES,
  MAX_TOTAL_WORK,
} from '../../src/core/ingestion/languages/r/linear-regex.js';
import { compileRExportPattern } from '../../src/core/ingestion/languages/r/export-pattern.js';
import { _captureLogger } from '../../src/core/logger.js';
import { createTempDirPool } from '../helpers/temp-dir-pool.js';

// Seeded generator so the corpus is the same on every run.
const rng = (seed: number) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 0x100000000;
};

/** `count` distinct identifiers of 8 to 20 characters, many sharing prefixes. */
const identifiers = (count: number, seed: number): string[] => {
  const next = rng(seed);
  const prefixes = ['get_', 'set_', 'tidy_', 'my_function_', 'read.', 'write.', ''];
  const alphabet = 'abcdefghijklmnopqrstuvwxyz_0123456789';
  const seen = new Set<string>();
  while (seen.size < count) {
    const prefix = prefixes[Math.floor(next() * prefixes.length)];
    let word = prefix;
    const length = 8 + Math.floor(next() * 12);
    while (word.length < length) word += alphabet[Math.floor(next() * alphabet.length)];
    seen.add(word);
  }
  return [...seen];
};

describe('exportPattern alternations and repeats at realistic sizes', () => {
  const pool = createTempDirPool('gn-r-scale-');

  const loadWith = async (namespace: string): Promise<RPackageConfig> => {
    const root = pool.dir();
    fs.writeFileSync(path.join(root, 'DESCRIPTION'), 'Package: scalepkg\n');
    fs.writeFileSync(path.join(root, 'NAMESPACE'), namespace);
    return loadRPackageConfig(root);
  };

  /** Run refineRExportStatus over one node per name and return the exported ones. */
  const exported = (config: RPackageConfig, names: readonly string[]): Set<string> => {
    const graph = createKnowledgeGraph();
    for (const name of names) {
      graph.addNode({
        id: `Function:R/a.R:${name}`,
        label: 'Function',
        properties: {
          name,
          filePath: 'R/a.R',
          language: SupportedLanguages.R,
          isExported: true,
        },
      });
    }
    refineRExportStatus(graph, config);
    const out = new Set<string>();
    graph.forEachNode((n) => {
      if (n.properties.isExported === true) out.add(String(n.properties.name));
    });
    return out;
  };

  for (const count of [80, 200, 500]) {
    it(`marks exactly the ${count} alternated names as exported`, async () => {
      const wanted = identifiers(count, count);
      const decoys = [
        ...wanted.map((n) => n + 'x'),
        ...wanted.map((n) => 'x' + n),
        ...wanted.map((n) => n.slice(0, -1)),
        ...identifiers(count, count + 1000).filter((n) => !wanted.includes(n)),
      ];
      const pattern = `^(${wanted.map((n) => n.replace(/\./g, '\\\\.')).join('|')})$`;
      const config = await loadWith(`exportPattern("${pattern}")\n`);

      const info = config.namespaceInfoByPackageDir.get('');
      expect(info?.exportPatterns).toHaveLength(1);
      expect(info?.droppedExportPatterns ?? []).toEqual([]);
      expect(exported(config, [...wanted, ...decoys])).toEqual(new Set(wanted));
    });
  }

  it('accepts an unanchored alternation of 500 names and agrees with RegExp', () => {
    const wanted = identifiers(500, 7);
    const source = `(${wanted.map((n) => n.replace(/\./g, '\\.')).join('|')})`;
    const matcher = compileRExportPattern(source);
    const oracle = new RegExp(source);
    expect(matcher).not.toBeNull();
    const probes = [
      ...wanted,
      ...wanted.map((n) => `pre_${n}_post`),
      ...wanted.map((n) => n.slice(1)),
      ...identifiers(300, 99),
    ];
    for (const name of probes) expect(matcher?.test(name), name).toBe(oracle.test(name));
  });

  it('accepts a bounded repeat of 2000 and applies its bounds', async () => {
    const config = await loadWith('exportPattern("^[[:alpha:]]{1,2000}$")\n');
    expect(config.namespaceInfoByPackageDir.get('')?.droppedExportPatterns ?? []).toEqual([]);
    const inside = ['a', 'Z'.repeat(1999), 'q'.repeat(2000)];
    const outside = ['q'.repeat(2001), 'a1', '_a', 'a'.repeat(1000) + '.'];
    const got = exported(config, [...inside, ...outside]);
    // Compared by length: a failure should not print 2,000-character names.
    expect([...got].map((n) => n.length).sort((a, b) => a - b)).toEqual([1, 1999, 2000]);
    expect(inside.every((n) => got.has(n))).toBe(true);
  });

  it('shares prefixes without changing what an alternation of literals matches', () => {
    const next = rng(2024);
    const pieces = ['a', 'b', 'ab', 'ba', 'abc', 'x_', '.', '', 'ab.'];
    const words = (n: number): string[] =>
      Array.from({ length: n }, () =>
        Array.from({ length: Math.floor(next() * 4) }, () => pieces[Math.floor(next() * 9)]).join(
          '',
        ),
      );
    const esc = (w: string): string => w.replace(/\./g, '\\.');
    let compared = 0;
    for (let i = 0; i < 300; i++) {
      const alternatives = words(1 + Math.floor(next() * 8)).map(esc);
      const body = alternatives.join('|');
      const wrappers = [
        `^(${body})$`,
        `(${body})`,
        `^(?:${body})`,
        `(?:${body})$`,
        `(${body})+$`,
        `\\b(${body})\\b`,
        `^x?(${body}){1,2}c?$`,
      ];
      for (const source of wrappers) {
        const matcher = compileLinearRegex(source);
        const oracle = new RegExp(source);
        expect(matcher, source).not.toBeNull();
        for (const probe of [...words(12), 'abab', 'x_ab.c', 'c', 'a b']) {
          expect(matcher?.test(probe), `${source} vs ${JSON.stringify(probe)}`).toBe(
            oracle.test(probe),
          );
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(20000);
  });

  it('keeps the caps above the sizes above and still rejects what exceeds them', () => {
    expect(MAX_STATES).toBeGreaterThanOrEqual(8000);
    expect(MAX_PATTERN_LENGTH).toBeGreaterThanOrEqual(8000);
    expect(compileLinearRegex('x'.repeat(MAX_PATTERN_LENGTH + 1))).toBeNull();
    expect(compileLinearRegex('(' + 'a{1,' + MAX_STATES + '}|b)')).toBeNull();
  });
});

describe('a dropped exportPattern is reported', () => {
  const pool = createTempDirPool('gn-r-drop-');

  const load = async (namespace: string, pkgDir = ''): Promise<RPackageConfig> => {
    const root = pool.dir();
    const dir = path.join(root, pkgDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'DESCRIPTION'), 'Package: dropped\n');
    fs.writeFileSync(path.join(dir, 'NAMESPACE'), namespace);
    return loadRPackageConfig(root);
  };

  const captured = async (run: () => Promise<void> | void): Promise<string[]> => {
    const cap = _captureLogger();
    try {
      await run();
      return cap.records().map((r) => String(r.msg ?? ''));
    } finally {
      cap.restore();
    }
  };

  it('records and warns once for a construct outside the supported subset', async () => {
    const config = await load('export(keep)\nexportPattern("^(?=a)a")\n', 'pkgs/dropped');
    const info = config.namespaceInfoByPackageDir.get('pkgs/dropped');
    expect(info?.exportPatterns).toEqual([]);
    expect(info?.droppedExportPatterns).toEqual([
      { pattern: '^(?=a)a', reason: expect.stringContaining('look-around') },
    ]);

    const messages = await captured(() => reportRExportPatternProblems(config));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('pkgs/dropped');
    expect(messages[0]).toContain('^(?=a)a');
    expect(messages[0]).toContain('look-around');
  });

  it('records and warns once for a pattern over the size cap, quoting a truncated pattern', async () => {
    const tooLong = '^[[:alpha:]]{1,' + MAX_STATES + '}$';
    const config = await load(`exportPattern("${tooLong}")\nexportPattern("${tooLong}")\n`);
    const info = config.namespaceInfoByPackageDir.get('');
    expect(info?.droppedExportPatterns).toHaveLength(1);

    const longest = '^(' + 'a'.repeat(MAX_PATTERN_LENGTH) + ')$';
    const config2 = await load(`exportPattern("${longest}")\n`);
    const messages = await captured(() => {
      reportRExportPatternProblems(config);
      reportRExportPatternProblems(config2);
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('state cap');
    expect(messages[1]).toContain(`longer than ${MAX_PATTERN_LENGTH}`);
    // The pattern is quoted, but only its first 60 characters.
    expect(messages[1]).toContain('^(' + 'a'.repeat(58) + '...');
    expect(messages[1]).not.toContain('a'.repeat(100));
  });

  it('reports an unterminated bracket or unknown POSIX class', async () => {
    const config = await load('exportPattern("^[[:nope:]]")\n');
    const messages = await captured(() => reportRExportPatternProblems(config));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('POSIX class');
  });

  it('stays silent when every pattern compiles', async () => {
    const config = await load('exportPattern("^[[:alpha:]]+")\nexportPattern("^(a|b)$")\n');
    expect(config.namespaceInfoByPackageDir.get('')?.droppedExportPatterns).toEqual([]);
    expect(await captured(() => reportRExportPatternProblems(config))).toEqual([]);
  });
});

describe('a hostile exportPattern stays within its work budget', () => {
  const HOSTILE = [
    'a?'.repeat(500) + 'c',
    'a?'.repeat(8000) + 'c',
    '[A-Za-z]{1,2000}c',
    '(' + Array.from({ length: 120 }, (_, i) => 'a'.repeat(i + 1) + 'b').join('|') + ')',
    '(a*)*(a*)*(a*)*(a*)*c',
  ];
  const distinctNames = (count: number): string[] =>
    Array.from({ length: count }, (_, i) => 'a'.repeat(94) + String(i).padStart(5, '0') + 'a');

  it('spends at most the budget however many names it is tested against', () => {
    const names = distinctNames(30_000);
    for (const source of HOSTILE) {
      const matcher = compileLinearRegex(source);
      expect(matcher, source.slice(0, 40)).not.toBeNull();
      let matched = 0;
      for (const name of names) if (matcher?.test(name)) matched++;
      expect(matched).toBe(0);
      // One position may overshoot the check by a closure, never by more.
      expect(matcher?.work, source.slice(0, 40)).toBeLessThanOrEqual(
        MAX_TOTAL_WORK + 4 * (matcher?.stateCount ?? 0),
      );
    }
  }, 60_000);

  it('reports exhaustion, answers false afterwards and does no more work', () => {
    const matcher = compileLinearRegex('a?'.repeat(500) + 'c');
    const names = distinctNames(30_000);
    for (const name of names) matcher?.test(name);
    expect(matcher?.exhausted).toBe(true);
    const spent = matcher?.work;
    expect(matcher?.test('a'.repeat(99) + 'c')).toBe(false);
    expect(matcher?.work).toBe(spent);
  }, 60_000);

  it('does not exhaust on patterns of realistic size run against many realistic names', () => {
    const names = Array.from({ length: 50_000 }, (_, i) => `obj_${i}_handler_name`);
    const wanted = identifiers(500, 3);
    const sources = [
      `^(${wanted.join('|').replace(/\./g, '\\.')})$`,
      `(${wanted.join('|').replace(/\./g, '\\.')})`,
      '^[A-Za-z]{1,2000}$',
      '^[^.]',
      '_handler',
    ];
    for (const source of sources) {
      const matcher = compileLinearRegex(source);
      for (const name of names) matcher?.test(name);
      expect(matcher?.exhausted, source.slice(0, 40)).toBe(false);
    }
  });

  it('completes the hostile set on 50,000 distinct 100-character names in a child process', () => {
    const modulePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../src/core/ingestion/languages/r/export-pattern.ts',
    );
    const script = `
      const { compileRExportPattern } = await import(${JSON.stringify(pathToFileURL(modulePath).href)});
      const names = Array.from({ length: 50000 }, (_, i) => 'a'.repeat(94) + String(i).padStart(5, '0') + 'a');
      const out = [];
      for (const p of ${JSON.stringify(HOSTILE)}) {
        const t0 = performance.now();
        const m = compileRExportPattern(p);
        let hits = 0;
        for (const n of names) if (m.test(n)) hits++;
        out.push({ hits, exhausted: m.exhausted, ms: performance.now() - t0 });
      }
      console.log('RESULT' + JSON.stringify(out));
    `;
    const res = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      { encoding: 'utf-8', timeout: 60_000 },
    );
    expect(res.error, 'hostile patterns stalled past the 60 s guard').toBeUndefined();
    expect(res.status, res.stderr).toBe(0);
    const line = res.stdout.split('\n').find((l) => l.startsWith('RESULT'));
    const rows = JSON.parse((line ?? '').slice('RESULT'.length)) as Array<{
      hits: number;
      exhausted: boolean;
      ms: number;
    }>;
    expect(rows).toHaveLength(HOSTILE.length);
    // The budget allows about 0.5 s on the development machine; this guard is generous
    // so that a slow runner does not fail it, while an unbounded matcher (minutes) does.
    for (const row of rows) {
      expect(row.hits).toBe(0);
      expect(row.ms).toBeLessThan(10_000);
    }
  }, 90_000);
});
