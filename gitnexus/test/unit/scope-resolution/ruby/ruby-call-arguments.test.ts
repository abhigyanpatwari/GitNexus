/**
 * A Ruby call's callable-flow arguments are its own `arguments` field.
 *
 * The shared callable-flow pass reads a call's arguments from its argument
 * list and, when the call has none, used to search the call's whole subtree
 * for one. A Ruby call that takes only a block (`run_with do … end`,
 * `items.each { … }`) has no list of its own, so the search entered the block
 * and took the first nested call's list: `run_with do helper(cb) end` recorded
 * `cb` as `run_with`'s argument 0. The nested call keeps its own fact.
 */
import { describe, expect, it } from 'vitest';
import { emitRubyScopeCaptures } from '../../../../src/core/ingestion/languages/ruby/captures.js';

/** `callee(index)=source` for every callable-flow argument fact in `source`. */
function argumentFacts(source: string): string[] {
  return emitRubyScopeCaptures(source, 'host.rb')
    .filter((m) => m['@callable-flow.argument'] !== undefined)
    .map(
      (m) =>
        `${m['@callable-flow.direct-callee-name']?.text ?? '?'}(${
          m['@callable-flow.parameter-index']?.text
        })=${m['@callable-flow.source']?.text}`,
    )
    .sort();
}

const HOST = (body: string): string =>
  `class Host\n  def run_with(x = nil)\n    x.call\n  end\n\n  def target; end\n\n  def m\n    cb = method(:target)\n${body}  end\nend\n`;

describe('Ruby callable flow: a call passes only its own arguments', () => {
  it.each([
    ['do block', '    run_with do\n      helper(cb)\n    end\n'],
    ['brace block', '    run_with { helper(cb) }\n'],
    ['block on a member call', '    [1].each do |i|\n      helper(cb)\n    end\n'],
  ])('%s: the nested call keeps its argument, the outer call gets none', (_label, body) => {
    expect(argumentFacts(HOST(body))).toEqual(['helper(0)=cb']);
  });

  it('a call with its own list and a block still passes that list', () => {
    expect(argumentFacts(HOST('    run_with(cb) do\n      helper(cb)\n    end\n'))).toEqual([
      'helper(0)=cb',
      'run_with(0)=cb',
    ]);
  });

  it.each([
    ['cb.call { helper(x) }', '0'],
    ['cb.call(x) { helper(x) }', '1'],
  ])('counts only the callable invocation arguments in %s', (call, arity) => {
    const invokes = emitRubyScopeCaptures(`def m(cb, x)\n${call}\nend`, 'host.rb').filter(
      (match) => match['@callable-flow.invoke'] !== undefined,
    );
    expect(
      invokes.map((match) => [
        match['@callable-flow.callee']?.text,
        match['@callable-flow.arity']?.text,
      ]),
    ).toEqual([['cb', arity]]);
  });

  it.each(['', '(cb)'])('preserves a block-taking receiver chain with arguments %s', (args) => {
    const source = `def m(factory, cb)\nfactory.build${args} { helper(cb) }.run\nend`;
    const chains = emitRubyScopeCaptures(source, 'host.rb').filter(
      (match) => match['@reference.receiver-chain'] !== undefined,
    );
    expect(
      chains.map((match) => [
        match['@reference.name']?.text,
        match['@reference.receiver-chain']?.text,
      ]),
    ).toEqual([['run', '2|factory|cbuild']]);
    expect(argumentFacts(source)).toEqual(args ? ['?(0)=cb', 'helper(0)=cb'] : ['helper(0)=cb']);
  });
});
