/**
 * `fetch()` call-SITE capture, independent of whether the URL is a literal
 * (#2897).
 *
 * The rule required the argument to be a string or template literal, so
 * `fetch(url)` — a variable — matched nothing. That made the R3-6 sink signal
 * absent from almost every real call: measured across this repository's own
 * TypeScript sources, 44 of 47 `fetch(` calls pass a variable, so 94% produced
 * no site and sink-terminated flows could effectively never fire.
 *
 * The URL alternation is now optional. The R3-6 sink set needs only WHERE the
 * program reaches outward, not where to; route linking still needs the URL and
 * already skips an entry whose URL normalizes to nothing, so widening the
 * capture adds sink sites without inventing a FETCHES edge.
 */
import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import {
  JAVASCRIPT_QUERIES,
  TYPESCRIPT_QUERIES,
} from '../../src/core/ingestion/tree-sitter-queries.js';

interface Site {
  readonly line: number;
  readonly url: string | undefined;
}

/** Every `route.fetch` site the query reports, with its URL when it has one. */
function fetchSites(source: string, lang: 'js' | 'ts'): Site[] {
  const parser = new Parser();
  const language = lang === 'js' ? JavaScript : TypeScript.typescript;
  parser.setLanguage(language);
  const query = new Parser.Query(language, lang === 'js' ? JAVASCRIPT_QUERIES : TYPESCRIPT_QUERIES);

  const byLine = new Map<number, Site>();
  for (const match of query.matches(parser.parse(source).rootNode)) {
    const caps = Object.fromEntries(match.captures.map((c) => [c.name, c.node]));
    const anchor = caps['route.fetch'];
    if (anchor === undefined) continue;
    const url = caps['route.url'] ?? caps['route.template_url'];
    byLine.set(anchor.startPosition.row + 1, {
      line: anchor.startPosition.row + 1,
      url: url?.text,
    });
  }
  return [...byLine.values()].sort((a, b) => a.line - b.line);
}

const SOURCE = [
  "async function literal() { return fetch('/api/literal') }", // 1
  'async function variable(url) { return fetch(url) }', // 2
  'async function template(id) { return fetch(`/api/${id}`) }', // 3
  "async function computed() { return fetch(buildUrl(), { method: 'POST' }) }", // 4
  "function notFetch() { return prefetch('/api/nope') }", // 5
].join('\n');

describe.each([
  ['JavaScript', 'js' as const],
  ['TypeScript', 'ts' as const],
])('fetch site capture — %s (#2897)', (_label, lang) => {
  it('captures a call whose URL is a VARIABLE', () => {
    // The regression case: this produced no site at all, so the function was
    // never a sink and no flow through it could terminate there.
    const variable = fetchSites(SOURCE, lang).find((s) => s.line === 2);
    expect(variable).toBeDefined();
    expect(variable!.url).toBeUndefined();
  });

  it('captures a call whose argument is a computed expression', () => {
    const computed = fetchSites(SOURCE, lang).find((s) => s.line === 4);
    expect(computed).toBeDefined();
    expect(computed!.url).toBeUndefined();
  });

  it('still captures the literal URL, unchanged', () => {
    // Asserted because route linking depends on it: widening the capture must
    // not cost the URL where one exists.
    const literal = fetchSites(SOURCE, lang).find((s) => s.line === 1);
    expect(literal?.url).toBe('/api/literal');
  });

  it('still captures a template URL, unchanged', () => {
    const template = fetchSites(SOURCE, lang).find((s) => s.line === 3);
    expect(template?.url).toContain('/api/');
  });

  it('emits exactly ONE site per call', () => {
    // An optional alternation must not make a literal call match twice — a
    // duplicate would double-count the site and, for a literal, could mint two
    // FETCHES edges.
    expect(fetchSites(SOURCE, lang).map((s) => s.line)).toEqual([1, 2, 3, 4]);
  });

  it('does not capture a different function whose name merely ends in fetch', () => {
    // `prefetch(...)` on line 5. The identifier equality is what keeps the
    // widened rule from matching anything that is not a fetch.
    expect(fetchSites(SOURCE, lang).map((s) => s.line)).not.toContain(5);
  });
});
