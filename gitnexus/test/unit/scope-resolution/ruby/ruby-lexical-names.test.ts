/**
 * RUBY-03 — what Ruby publishes for the receiver walk to stop on.
 *
 * A scope that declares parameters carries `@scope.lexical-names`: the names it
 * binds, typed or not. Each binder lands on the scope that declares it — a
 * block's `|…|` names (block locals included) on that block, a stabby lambda's
 * `->(…)` names on its body block (the parameter list sits outside the body),
 * a method's parameters on the method — and never on the enclosing body. A
 * scope that declares no parameter carries no capture.
 */
import { describe, expect, it } from 'vitest';
import type { CaptureMatch } from 'gitnexus-shared';
import { emitRubyScopeCaptures } from '../../../../src/core/ingestion/languages/ruby/index.js';

const SOURCE = `class Svc
  def run(user, *rest, key:, opt: 1, **kw, &blk)
    items.each do |item, (a, b); tmp|
      [1].each { |inner| inner }
    end
    check = ->(x, y = 2) { x }
    bare = -> z { z }
    loose = lambda { |w| w }
    nothing = -> { 1 }
    items.map { _1 }
    items.map { it }
  end

  def self.build(cfg)
    cfg
  end

  def none
    [1].each { 2 }
  end
end
`;

/** `startLine:startCol-endLine:endCol` of a capture. */
const span = (match: CaptureMatch, tag: string): string => {
  const r = match[tag]?.range;
  return r === undefined ? `<no ${tag}>` : `${r.startLine}:${r.startCol}-${r.endLine}:${r.endCol}`;
};

/** Every function or block scope, keyed `kind span`, with the names it lists. */
function scopeNames(matches: readonly CaptureMatch[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const match of matches) {
    const tag = ['@scope.function', '@scope.block'].find((t) => match[t] !== undefined);
    if (tag === undefined) continue;
    const raw = match['@scope.lexical-names']?.text;
    out[`${tag.slice('@scope.'.length)} ${span(match, tag)}`] =
      raw === undefined ? [] : (JSON.parse(raw) as string[]);
  }
  return out;
}

describe('Ruby lexical names (RUBY-03)', () => {
  it('preserves callable .() and .call invocations while dropping the false name() invocation', () => {
    const matches = emitRubyScopeCaptures(
      'class Host; def run(f); f.(); f.call; f(); end; end',
      'calls.rb',
    );
    expect(
      matches
        .filter((match) => match['@callable-flow.invoke'])
        .map((match) => match['@callable-flow.invoke']?.text),
    ).toEqual(['f.()', 'f.call']);
    const call = matches.find((match) => match['@reference.call.member']?.text === 'f()');
    expect(call?.['@reference.receiver']?.text).toBe('self');
    expect(call?.['@reference.arity']?.text).toBe('0');
  });

  it('lambda defaults claim only referenced names declared before the expression', () => {
    const matches = emitRubyScopeCaptures(
      'def run(user)\n  f = ->(x = user.save, user: nil, y: user.save) { user.save }\nend\n',
      'defaults.rb',
    );
    expect(
      matches
        .filter((match) => match['@scope.block'])
        .map((match) => [
          match['@scope.block']?.text,
          JSON.parse(match['@scope.lexical-names']?.text ?? '[]'),
        ]),
    ).toEqual([
      ['user.save', ['user']],
      ['{ user.save }', ['x', 'user', 'y']],
    ]);
  });

  it('each scope lists the parameters IT declares; nested blocks keep their own', () => {
    expect(scopeNames(emitRubyScopeCaptures(SOURCE, 'svc.rb'))).toEqual({
      // a method: positional, splat, keyword, optional keyword, double splat, block
      'function 2:2-12:5': ['user', 'rest', 'key', 'opt', 'kw', 'blk'],
      // do … end: positional, destructured, block local — not the inner block's name
      'block 3:15-5:7': ['item', 'a', 'b', 'tmp'],
      'block 4:15-4:32': ['inner'],
      // a stabby lambda's parameters bind on its body block
      'block 6:25-6:30': ['x', 'y'],
      'block 7:16-7:21': ['z'],
      // lambda { |w| … } is an ordinary block
      'block 8:19-8:28': ['w'],
      // no declared parameter: numbered and `it` parameters are not declared
      // names (the grammar has no node for them), so nothing is listed
      'block 9:17-9:22': [],
      'block 10:14-10:20': [],
      'block 11:14-11:20': [],
      // a singleton method
      'function 14:2-16:5': ['cfg'],
      'function 18:2-20:5': [],
      'block 19:13-19:18': [],
    });
  });
});
