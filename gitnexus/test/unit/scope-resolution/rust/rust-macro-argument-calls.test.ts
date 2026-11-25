/**
 * Calls written in macro arguments (#1388). tree-sitter leaves those arguments
 * as a flat `token_tree`, so these pin which ones become call references, where
 * they are positioned, and which spellings are deliberately left alone.
 */
import { describe, it, expect } from 'vitest';
import type { CaptureMatch, Range } from 'gitnexus-shared';
import { emitRustScopeCaptures } from '../../../../src/core/ingestion/languages/rust/index.js';

const CALL_TAGS = [
  '@reference.call.free',
  '@reference.call.member',
  '@reference.call.constructor',
] as const;

function callMatches(source: string): CaptureMatch[] {
  return emitRustScopeCaptures(source, 'src/lib.rs').filter((match) =>
    CALL_TAGS.some((tag) => match[tag] !== undefined),
  );
}

/** The source text a range points at, so a shifted position cannot pass. */
function textAt(source: string, range: Range): string {
  const lines = source.split('\n').slice(range.startLine - 1, range.endLine);
  const last = lines.length - 1;
  lines[last] = lines[last]!.slice(0, range.endCol);
  lines[0] = lines[0]!.slice(range.startCol);
  return lines.join('\n');
}

function calls(body: string): string[] {
  const source = `fn caller() { ${body} }`;
  return callMatches(source)
    .map((match) => {
      const anchor = CALL_TAGS.map((tag) => match[tag]).find((capture) => capture !== undefined)!;
      return textAt(source, anchor.range);
    })
    .sort();
}

describe('Rust calls in macro arguments', () => {
  it.each([
    ['println!("{}", helper(1));', ['helper(1)']],
    ['format!("{x}", x = helper());', ['helper()']],
    ['let v = vec![first(), second()];', ['first()', 'second()']],
    ['let v = vec![filler(); size()];', ['filler()', 'size()']],
    ['assert_eq!(left(), right(), "{}", detail());', ['detail()', 'left()', 'right()']],
    ['log::warn!("{}", utils::describe(code));', ['utils::describe(code)']],
    ['println!("{}", self.repo.load());', ['self.repo.load()']],
    ['println!("{}", items.drain(..).count());', ['items.drain(..)', 'items.drain(..).count()']],
    ['custom!(first(), [second()]);', ['first()', 'second()']],
    ['println!("{}", format!("{}", vec![deep()].len()));', ['deep()', 'vec![deep()].len()']],
    ['let v = vec![Point { x: 1 }];', ['Point { x: 1 }']],
  ])('captures the calls in %s', (body, expected) => {
    expect(calls(body)).toEqual(expected);
  });

  it.each([
    ['brace-delimited invocations', 'items! { fn made() { helper() } }'],
    ['argument lists that are not expressions', 'log::info!(target: "net", "{}", helper());'],
    ['stringify!', 'let s = stringify!(helper());'],
    ['cfg!', 'let on = cfg!(all(unix, not(windows)));'],
    ['quote!', 'let t = quote!(helper());'],
    ['a stringify! nested in another macro', 'println!("{}", stringify!(helper()));'],
    ['a macro_rules body', 'macro_rules! m { () => { helper() }; }'],
    ['wildcard patterns', 'custom!(value, Some(_));'],
    ['rest patterns', 'custom!(value, Shape::Circle(..));'],
    ['a closure parameter being called', 'custom!(|helper| helper());'],
    ['a name bound outside a nested macro', 'custom!(|helper| format!("{}", wrap!([helper()])));'],
  ])('captures nothing from %s', (_label, body) => {
    expect(calls(body)).toEqual([]);
  });

  it('drops a method call on a closure parameter but keeps the call around it', () => {
    expect(calls('assert!(all(|item| item.ready()));')).toEqual(['all(|item| item.ready())']);
  });

  it('keeps the scrutinee of matches! and drops its pattern', () => {
    expect(calls('let hit = matches!(classify(x), Kind::Leaf(depth));')).toEqual(['classify(x)']);
  });

  it('keeps calls around a name the arguments bind', () => {
    expect(calls('assert!(rows().iter().all(|row| check(row)));')).toEqual([
      'check(row)',
      'rows()',
      'rows().iter()',
      'rows().iter().all(|row| check(row))',
    ]);
  });

  it('positions calls in the file, across lines and after non-ASCII text', () => {
    const source = [
      'fn caller() {',
      '    g_printerr!("héllo ✓ {}", same_line(),',
      '        next_line(',
      '            nested_line()),',
      '    );',
      '    outer!("é", inner!("✓", innermost()));',
      '}',
    ].join('\n');
    const ranges = Object.fromEntries(
      callMatches(source).map((match) => {
        const name = match['@reference.name']!;
        expect(textAt(source, name.range)).toBe(name.text);
        return [name.text, match['@reference.call.free']!.range];
      }),
    );
    expect(ranges).toEqual({
      same_line: { startLine: 2, startCol: 30, endLine: 2, endCol: 41 },
      next_line: { startLine: 3, startCol: 8, endLine: 4, endCol: 26 },
      nested_line: { startLine: 4, startCol: 12, endLine: 4, endCol: 25 },
      innermost: { startLine: 6, startCol: 28, endLine: 6, endCol: 39 },
    });
  });

  it('records arity and the receiver like any other call', () => {
    const [match] = callMatches('fn caller() { println!("{}", self.repo.load(1, 2)); }');
    expect(match!['@reference.receiver']!.text).toBe('self.repo');
    expect(match!['@reference.name']!.text).toBe('load');
    expect(match!['@reference.arity']!.text).toBe('2');
  });

  it('stops re-parsing past the nesting limit', () => {
    const nest = (depth: number): string =>
      depth === 0 ? 'bottom()' : `wrap!([${nest(depth - 1)}])`;
    expect(calls(`${nest(8)};`)).toEqual(['bottom()']);
    expect(calls(`${nest(9)};`)).toEqual([]);
  });
});
