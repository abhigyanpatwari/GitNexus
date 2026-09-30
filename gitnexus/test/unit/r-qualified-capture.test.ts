/**
 * R scope query: `@reference.qualified-name` on `pkg::fn()` / `pkg:::fn()` calls (fork #7, R1).
 *
 * The free-call qualified hook fires only when a site carries `rawQualifiedName`, which the
 * scope extractor copies from the `@reference.qualified-name` capture. Cached files cannot be
 * re-read, hence the capture (and a SCHEMA_BUMP) rather than re-parsing at resolve time.
 *
 * Each form asserts the call, its name and the whole `namespace_operator` text together,
 * so a form that fails to parse or loses its name capture cannot pass.
 */
import { describe, expect, it } from 'vitest';
import { emitRScopeCaptures } from '../../src/core/ingestion/languages/r/captures.js';

type Tags = Record<string, string>;

function callMatches(source: string): Tags[] {
  return emitRScopeCaptures(source, 'fixture.R')
    .map((m) => Object.fromEntries(Object.entries(m).map(([tag, cap]) => [tag, cap.text])) as Tags)
    .filter((t) => t['@reference.call.free'] !== undefined && t['@reference.name'] !== undefined);
}

/** The single `@reference.name === name` call match in `source`. */
function only(source: string, name: string): Tags {
  const found = callMatches(source).filter((t) => t['@reference.name'] === name);
  if (found.length !== 1) throw new Error(`expected one match for ${name}, got ${found.length}`);
  return found[0];
}

const FORMS: readonly {
  readonly label: string;
  readonly source: string;
  readonly written: string;
}[] = [
  { label: 'pkg::f', source: 'run <- function(d) pkg::f(d)', written: 'pkg::f' },
  { label: 'pkg:::f', source: 'run <- function(d) pkg:::f(d)', written: 'pkg:::f' },
  { label: 'spaced pkg ::: f', source: 'run <- function(d) pkg ::: f(d)', written: 'pkg ::: f' },
  { label: 'spaced pkg :: f', source: 'run <- function(d) pkg  ::  f(d)', written: 'pkg  ::  f' },
  { label: 'quoted "pkg"::f', source: 'run <- function(d) "pkg"::f(d)', written: '"pkg"::f' },
  { label: "quoted 'pkg'::f", source: "run <- function(d) 'pkg'::f(d)", written: "'pkg'::f" },
  { label: 'backticked `pkg`::f', source: 'run <- function(d) `pkg`::f(d)', written: '`pkg`::f' },
];

describe('R query: qualified-name capture on namespace_operator calls', () => {
  for (const form of FORMS) {
    describe(form.label, () => {
      it('captures the whole namespace_operator text as @reference.qualified-name', () => {
        const t = only(form.source, 'f');
        expect(t['@reference.name']).toBe('f');
        expect(t['@reference.call.free']).toBe(form.written + '(d)');
        expect(t['@reference.qualified-name']).toBe(form.written);
      });
    });
  }

  describe('unqualified and non-namespace calls carry no qualified name (stay green after R1)', () => {
    it('a bare call f(x)', () => {
      const t = only('run <- function(d) f(d)', 'f');
      expect(t['@reference.qualified-name']).toBeUndefined();
    });

    it('a member call obj$f(x) is not a free call', () => {
      expect(callMatches('run <- function(o) o$f(1)')).toEqual([]);
    });
  });
});
