import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadRPackageConfig } from '../../src/core/ingestion/languages/r/package-config.js';
import { createTempDirPool } from '../helpers/temp-dir-pool.js';

// Regression tests for fork #8: export()/exportClasses()/exportMethods()/S3method()/
// exportPattern() must be read from the whole NAMESPACE text (wrapped, quoted,
// backticked, commented, CRLF), not line by line. Everything goes through the
// public loader, `loadRPackageConfig`, with synthetic NAMESPACE files.
describe('loadRPackageConfig -> RNamespaceInfo exports (fork #8)', () => {
  const pool = createTempDirPool('gn-r-nsx-');

  const load = async (namespace: string) => {
    const root = pool.dir();
    fs.writeFileSync(path.join(root, 'DESCRIPTION'), 'Package: rootpkg\n');
    fs.writeFileSync(path.join(root, 'NAMESPACE'), namespace);
    const config = await loadRPackageConfig(root);
    const info = config?.namespaceInfoByPackageDir.get('');
    return {
      names: [...(info?.namedExports ?? [])].sort(),
      patterns: info?.exportPatterns ?? [],
    };
  };

  describe('single-line forms (unchanged)', () => {
    it('reads export, exportClasses, exportMethods, S3method and exportPattern', async () => {
      const { names, patterns } = await load(
        [
          'export(a, b)',
          'exportClasses(K)',
          'exportMethods(show)',
          'S3method(print, foo)',
          'exportPattern("^x")',
        ].join('\n') + '\n',
      );
      expect(names).toEqual(['K', 'a', 'b', 'print.foo', 'show']);
      expect(patterns.map((p) => p.source)).toEqual(['^x']);
    });

    it('strips quotes from names and ignores full-line comments and blank lines', async () => {
      const { names } = await load('# export(gone)\n\nexport("q1", \'q2\', bare)\n');
      expect(names).toEqual(['bare', 'q1', 'q2']);
    });

    it('does not export from a conditional directive', async () => {
      const { names } = await load('if (cond) export(hidden)\nexport(shown)\n');
      expect(names).toEqual(['shown']);
    });
  });

  describe('wrapped directives', () => {
    it('reads export() wrapped over several lines', async () => {
      const { names } = await load('export(alpha,\n  beta,\n\n  gamma\n)\n');
      expect(names).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('reads a directive with the head and opening paren on separate lines', async () => {
      const { names } = await load('export\n(\n  alpha\n)\n');
      expect(names).toEqual(['alpha']);
    });

    it('reads exportClasses/exportMethods wrapped over several lines', async () => {
      const { names } = await load('exportClasses(\n  K1,\n  K2)\nexportMethods(m1,\n  m2)\n');
      expect(names).toEqual(['K1', 'K2', 'm1', 'm2']);
    });

    it('reads a wrapped S3method()', async () => {
      const { names } = await load('S3method(\n  print,\n  foo\n)\nS3method(summary,\n  bar)\n');
      expect(names).toEqual(['print.foo', 'summary.bar']);
    });

    it('reads a wrapped exportPattern()', async () => {
      const { patterns } = await load('exportPattern(\n  "^pub_"\n)\n');
      expect(patterns.map((p) => p.source)).toEqual(['^pub_']);
    });

    it('tolerates a trailing comma inside a wrapped export()', async () => {
      const { names } = await load('export(a,\n  b,\n  )\n');
      expect(names).toEqual(['a', 'b']);
    });
  });

  describe('quoting', () => {
    it('reads double-, single- and backtick-quoted export names', async () => {
      const { names } = await load('export("dq", \'sq\', `bt`, `%+%`, .dot)\n');
      expect(names).toEqual(['%+%', '.dot', 'bt', 'dq', 'sq']);
    });

    it('keeps a comma, paren or # inside a quoted name', async () => {
      const { names } = await load('export("a,b", `c(d)`, "e#f")\n');
      expect(names).toEqual(['a,b', 'c(d)', 'e#f']);
    });

    it('reads quoted S3method arguments, including operator generics', async () => {
      const { names } = await load('S3method("[", foo)\nS3method(`$`, "bar")\n');
      expect(names).toEqual(['$.bar', '[.foo']);
    });

    it('accepts the optional third S3method() argument', async () => {
      const { names } = await load('S3method(print, foo, print_foo_impl)\n');
      expect(names).toEqual(['print.foo']);
    });
  });

  describe('comments and line endings', () => {
    it('ignores a trailing comment after a directive', async () => {
      const { names } = await load('export(a) # export(hidden)\nexport(b)\n');
      expect(names).toEqual(['a', 'b']);
    });

    it('ignores comments inside a wrapped directive', async () => {
      const { names } = await load('export(a, # first\n  # export(hidden)\n  b)\n');
      expect(names).toEqual(['a', 'b']);
    });

    it('is CRLF-safe for wrapped and single-line directives', async () => {
      const { names, patterns } = await load(
        'export(a,\r\n  b)\r\nS3method(print,\r\n  foo)\r\nexportPattern("^z")\r\nexportClasses(K)\r\n',
      );
      expect(names).toEqual(['K', 'a', 'b', 'print.foo']);
      expect(patterns.map((p) => p.source)).toEqual(['^z']);
    });
  });

  describe('exportPattern string arguments are R-unescaped', () => {
    it('turns the R string "\\\\." into the regex \\.', async () => {
      const { patterns } = await load('exportPattern("^a\\\\.b$")\n');
      expect(patterns).toHaveLength(1);
      expect(patterns[0].source).toBe('^a\\.b$');
      expect(patterns[0].test('a.b')).toBe(true);
      expect(patterns[0].test('axb')).toBe(false);
    });

    it('unescapes quotes and the common control escapes', async () => {
      const { patterns } = await load(
        'exportPattern("^a\\"b")\nexportPattern(\'^c\\\'d\')\nexportPattern("^e\\tf")\nexportPattern("^g\\nh")\n',
      );
      // RegExp#source re-escapes a line terminator, so compare behaviour for those two.
      expect(patterns.map((p) => p.test('a"b'))).toEqual([true, false, false, false]);
      expect(patterns[1].test("c'd")).toBe(true);
      expect(patterns[2].test('e\tf')).toBe(true);
      expect(patterns[3].test('g\nh')).toBe(true);
    });

    it('unescapes \\\\ to one backslash and leaves POSIX classes working', async () => {
      const { patterns } = await load('exportPattern("^[[:alpha:]]+\\\\.R$")\n');
      expect(patterns).toHaveLength(1);
      expect(patterns[0].test('tidy.R')).toBe(true);
      expect(patterns[0].test('tidyXR')).toBe(false);
    });

    it('accepts several patterns in one exportPattern() call', async () => {
      const { patterns } = await load('exportPattern("^a",\n  "^b")\n');
      expect(patterns.map((p) => p.source)).toEqual(['^a', '^b']);
    });

    it('keeps a ) or # inside a pattern string', async () => {
      const { patterns } = await load('exportPattern("^(a|b)#")\n');
      expect(patterns.map((p) => p.source)).toEqual(['^(a|b)#']);
    });

    it('drops an empty or non-string pattern argument without throwing', async () => {
      const { patterns } = await load(
        'exportPattern("")\nexportPattern(bare)\nexportPattern("^ok")\n',
      );
      expect(patterns.map((p) => p.source)).toEqual(['^ok']);
    });
  });

  describe('realistic shapes', () => {
    it('parses a 10-directive NAMESPACE where 5 directives wrap (aggregate shape)', async () => {
      const ns = [
        '# Generated by roxygen2: do not edit by hand',
        '',
        'S3method(print,scorecard)',
        'S3method(summary,',
        '  scorecard)',
        'export(build_card)',
        'export(',
        '  rank_scores,',
        '  clip_scores,',
        '  normalise_scores',
        ')',
        'exportClasses(',
        '  ScoreCard,',
        '  ScoreBand)',
        'exportMethods(show)',
        'exportPattern("^tidy_")',
        'importFrom(dplyr,',
        '  mutate,',
        '  filter)',
        'importFrom(stats, sd)',
        'export(last_one)',
      ].join('\n');
      const { names, patterns } = await load(ns + '\n');
      expect(names).toEqual([
        'ScoreBand',
        'ScoreCard',
        'build_card',
        'clip_scores',
        'last_one',
        'normalise_scores',
        'print.scorecard',
        'rank_scores',
        'show',
        'summary.scorecard',
      ]);
      expect(patterns.map((p) => p.source)).toEqual(['^tidy_']);
    });

    it('keeps directives parsed before a garbled one and never throws', async () => {
      const { names } = await load('export(a)\nexport(b, "unterminated\n');
      expect(names).toEqual(['a']);
    });

    // Resynchronisation rule: a garbled or unbalanced directive is discarded and
    // scanning resumes at the next line that begins at column 0 with
    // `identifier(`. Quoted strings never span lines.
    describe('resynchronises after a malformed directive', () => {
      it('keeps valid directives on both sides of an unbalanced paren', async () => {
        const { names } = await load('export(a)\nexport(b, c\nexport(d)\nS3method(print, e)\n');
        expect(names).toEqual(['a', 'd', 'print.e']);
      });

      it('keeps directives after an unterminated quote instead of swallowing them', async () => {
        const { names, patterns } = await load(
          'export(a)\nexport(b, "c)\nexport("d")\nexportPattern("^p_")\nexportClasses(E)\n',
        );
        expect(names).toEqual(['E', 'a', 'd']);
        expect(patterns.map((p) => p.source)).toEqual(['^p_']);
      });

      it('recovers from a garbled exportPattern, S3method and stray characters', async () => {
        const { names, patterns } = await load(
          'export(a)\nexportPattern("^broken\n@@ ;; S3method(x\nS3method(print, ok)\nexportPattern("^good")\n',
        );
        expect(names).toEqual(['a', 'print.ok']);
        expect(patterns.map((p) => p.source)).toEqual(['^good']);
      });

      it('drops a garbled directive at the end of file and a garbled first directive', async () => {
        expect((await load('export(a)\nexport(b, "c\n')).names).toEqual(['a']);
        expect((await load('export(a, "b\nexport(c)\n')).names).toEqual(['c']);
      });

      it('survives several garbled directives, CRLF and comments', async () => {
        const src = [
          '# export(hidden, "never',
          'export(a',
          'export(b)',
          'export(c, "d)',
          'exportMethods(m)',
          'export(',
          'export(f)',
        ].join('\r\n');
        expect((await load(src)).names).toEqual(['b', 'f', 'm']);
      });

      it('resumes only at column 0 and recovers after a garbled conditional body', async () => {
        expect((await load('export(a\n  export(b)\nexport(c)\n')).names).toEqual(['c']);
        expect((await load('if (TRUE) export(a\nexport(b)\n')).names).toEqual(['b']);
      });

      it('always makes forward progress on many garbled lines and still finds the tail', async () => {
        const garbled = Array.from({ length: 3000 }, () => 'export(a, "x').join('\n');
        expect((await load(garbled + '\nexport(last)\n')).names).toEqual(['last']);
      });
    });

    it('never throws on garbage input', async () => {
      for (const src of ['', ')))((( ,,, """ \'\'\' ```', 'export(', 'S3method(', '{ { {']) {
        await expect(load(src)).resolves.toEqual({ names: [], patterns: [] });
      }
    });
  });
});
