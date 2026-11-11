/**
 * RUBY-02 review round 2 — parameters bind LEFT-TO-RIGHT for a bare read.
 *
 * `rubyBareNameIsLocalRead` decides whether a bare identifier statement reads
 * a parameter or local (no CALLS edge) or calls a method. Ruby registers a
 * parameter as the parser passes its NAME, so a read inside parameter k's
 * default sees the parameters declared before k and k itself (a circular
 * reference, nil), never a later one. Verified on Ruby 2.6:
 *
 *   def later(x = …target…, target: nil)   → calls the method
 *   def earlier(target = nil, x = …target…) → reads the parameter
 *   def selfname(target = …target…)         → reads the nil local
 *
 * The helper is pinned DIRECTLY on parsed trees here because the statement
 * pattern `(body_statement (identifier))` reaches a default expression only
 * through a `do` block or lambda body nested in it: `x = begin; target; end`
 * is never captured, so no edge can be lost or gained for that spelling and
 * the rule is unobservable through the graph. The `do`-block spelling IS
 * captured, and the integration test pins its edges. Each "later" case here
 * flips with the position check removed (`boundAt < readStart` → `true`).
 */
import { describe, it, expect } from 'vitest';
import type Parser from 'tree-sitter';
import { getRubyParser } from '../../../../src/core/ingestion/languages/ruby/query.js';
import {
  emitRubyScopeCaptures,
  rubyBareNameIsLocalRead,
  type RubyScopeBindings,
} from '../../../../src/core/ingestion/languages/ruby/captures.js';

type SyntaxNode = Parser.SyntaxNode;

/** Every `target` identifier in statement position (not a declaration name). */
function targetReads(source: string): SyntaxNode[] {
  const tree = getRubyParser().parse(source);
  const reads: SyntaxNode[] = [];
  const walk = (node: SyntaxNode): void => {
    if (
      node.type === 'identifier' &&
      node.text === 'target' &&
      node.parent !== null &&
      ['begin', 'body_statement', 'block_body'].includes(node.parent.type)
    ) {
      reads.push(node);
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child !== null) walk(child);
    }
  };
  walk(tree.rootNode);
  return reads;
}

/** The helper's verdict for the single `target` read in `source`. */
function readsLocal(source: string): boolean {
  const reads = targetReads(source);
  expect(reads).toHaveLength(1);
  const cache = new Map<number, RubyScopeBindings>();
  return rubyBareNameIsLocalRead(reads[0]!, cache);
}

/** Whether the provider emits a bare-call capture for `target` in `source`. */
function captured(source: string): boolean {
  return emitRubyScopeCaptures(source, 'order.rb').some(
    (m) => m['@reference.call.free'] !== undefined && m['@reference.name']?.text === 'target',
  );
}

describe('Ruby bare read: parameters bind left-to-right (RUBY-02 round 2)', () => {
  it.each([
    [
      'method default, later positional',
      'def run(x = begin; target; end, target: nil)\n  x\nend\n',
    ],
    ['method default, later keyword', 'def run(x: begin; target; end, target: nil)\n  x\nend\n'],
    [
      'block default, later block param',
      'def run\n  [1].map { |a = begin; target; end, target| a }\nend\n',
    ],
    [
      'lambda default, later lambda param',
      'l = ->(x = begin; target; end, target: nil) do x end\n',
    ],
    [
      'method default via do block, later keyword',
      'def run(x = [1].each do |a| target end, target: nil)\n  x\nend\n',
    ],
  ])('%s: a default reading a parameter declared AFTER it is a call', (_name, source) => {
    expect(readsLocal(source)).toBe(false);
  });

  it.each([
    [
      'method default, earlier positional',
      'def run(target = nil, x = begin; target; end)\n  x\nend\n',
    ],
    ['method default, earlier keyword', 'def run(target: nil, x: begin; target; end)\n  x\nend\n'],
    [
      'method default, its own name (nil local)',
      'def run(target = begin; target; end)\n  x = target\nend\n',
    ],
    [
      'block default, earlier block param',
      'def run\n  [1].map { |target, a = begin; target; end| a }\nend\n',
    ],
    [
      'method default via do block, earlier positional',
      'def run(target = nil, x = [1].each do |a| target end)\n  x\nend\n',
    ],
    ['body read of a parameter', 'def run(target)\n  target\nend\n'],
  ])('%s: a default reading an earlier parameter (or its own name) is a read', (_name, source) => {
    expect(readsLocal(source)).toBe(true);
  });

  it.each([
    ['rightward =>', 'def run\n  [1].each do |a| target end => target\nend\n'],
    ['rightward in', 'def run\n  [1].each do |a| target end in target\nend\n'],
  ])(
    '%s: a read inside the matched value precedes the pattern binding, so it is a call',
    (_name, source) => {
      // Ruby 3 parses the value before the pattern declares anything; the
      // binding is registered at the pattern node, not at the expression's
      // start (cubic round 2).
      expect(readsLocal(source)).toBe(false);
    },
  );

  it('an earlier multiple-assignment target is parsed before a later target declares the name', () => {
    // A name binds where it is WRITTEN, not at the assignment's start
    // (cubic round 3).
    expect(
      readsLocal('def run\n  arr = []\n  arr[[1].map do |x| target end], target = [], 1\nend\n'),
    ).toBe(false);
  });

  it('a read after a multiple assignment that binds the name is a read', () => {
    expect(readsLocal('def run\n  a, target = 1, 2\n  target\nend\n')).toBe(true);
  });

  describe('header expressions bind the enclosing scope (round 5)', () => {
    it.each([
      ['singleton receiver', 'def (target = Object.new).run\n  target\nend\n'],
      ['superclass expression', 'class Sub < (target = Object).class\n  target\nend\n'],
      ['class << value', 'class << (target = Object.new)\n  target\nend\n'],
    ])('%s: an assignment in the header does not bind the body read (call)', (_name, src) => {
      expect(readsLocal(src)).toBe(false);
    });

    it('the header assignment binds a later read in the ENCLOSING scope', () => {
      expect(readsLocal('def outer\n  def (target = Object.new).run\n  end\n  target\nend\n')).toBe(
        true,
      );
    });

    it.each([
      [
        'singleton receiver',
        'def outer(target)\n  def ([1].each do target end).inner\n  end\nend\n',
      ],
      ['class << value', 'def outer(target)\n  class << ([1].each do target end)\n  end\nend\n'],
      [
        'superclass expression (program-level local)',
        'target = 1\nclass Foo < ([1].each do target end)\nend\n',
      ],
    ])(
      '%s: a read inside a scope HEADER is answered by the enclosing scope (read)',
      (_name, src) => {
        expect(readsLocal(src)).toBe(true);
      },
    );

    it('a header read with no enclosing binding is still a call, and a bare header name is not a binding site', () => {
      expect(
        readsLocal('def outer(other)\n  def ([1].each do target end).inner\n  end\nend\n'),
      ).toBe(false);
      const src = 'def outer\n  class << make_base\n  end\n  make_base\nend\n';
      const reads = targetReads(src.replace(/make_base/g, 'target'));
      expect(reads).toHaveLength(1);
      expect(rubyBareNameIsLocalRead(reads[0]!, new Map())).toBe(false);
    });
  });

  describe('BEGIN / END bodies and pattern expression parts (round 5)', () => {
    it('a BEGIN / END body is its own scope: its assignment does not bind the method body', () => {
      expect(readsLocal('def run\n  BEGIN { target = 1 }\n  target\nend\n')).toBe(false);
      expect(readsLocal('def run\n  END { target = 1 }\n  target\nend\n')).toBe(false);
    });

    it.each([
      ['string interpolation', 'def run(v)\n  case v\n  in "x#{target}"\n  end\n  target\nend\n'],
      ['regex interpolation', 'def run(v)\n  case v\n  in /#{target}/\n  end\n  target\nend\n'],
      ['symbol interpolation', 'def run(v)\n  case v\n  in :"s#{target}"\n  end\n  target\nend\n'],
      ['subshell interpolation', 'def run(v)\n  case v\n  in `c#{target}`\n  end\n  target\nend\n'],
      [
        'keyword value interpolation',
        'def run(v)\n  case v\n  in {k: "#{target}"}\n  end\n  target\nend\n',
      ],
      [
        'lambda pattern parameter',
        'def run(v)\n  case v\n  in ->(target) { 0 }\n  end\n  target\nend\n',
      ],
      ['pinned expression', 'def run(v)\n  case v\n  in ^(target)\n  end\n  target\nend\n'],
      ['pinned variable', 'def run(v)\n  case v\n  in ^target\n  end\n  target\nend\n'],
    ])('%s: an expression part of a pattern is not a binding position (call)', (_name, src) => {
      expect(readsLocal(src)).toBe(false);
    });

    it.each([
      ['identifier', 'def run(v)\n  case v\n  in target\n  end\n  target\nend\n'],
      [
        'const array pattern argument',
        'def run(v)\n  case v\n  in Other(target)\n  end\n  target\nend\n',
      ],
      [
        'const hash pattern value',
        'def run(v)\n  case v\n  in Other(k: target)\n  end\n  target\nend\n',
      ],
      ['hash shorthand', 'def run(v)\n  case v\n  in {target:}\n  end\n  target\nend\n'],
      ['find pattern', 'def run(v)\n  case v\n  in [*, target, *]\n  end\n  target\nend\n'],
      ['splat', 'def run(v)\n  case v\n  in [1, *target]\n  end\n  target\nend\n'],
      ['alternative', 'def run(v)\n  case v\n  in nil | target\n  end\n  target\nend\n'],
      ['parenthesized', 'def run(v)\n  case v\n  in (target)\n  end\n  target\nend\n'],
      ['as pattern', 'def run(v)\n  case v\n  in [1] => target\n  end\n  target\nend\n'],
    ])('%s: a true pattern binding position binds (read)', (_name, src) => {
      expect(readsLocal(src)).toBe(true);
    });
  });

  it('a read AFTER a rightward pattern binding is a read', () => {
    expect(readsLocal('def run(v)\n  v => target\n  target\nend\n')).toBe(true);
  });

  it('the statement pattern never captures a `begin … end` default, so that spelling has no edge either way', () => {
    expect(captured('def run(x = begin; target; end, target: nil)\n  x\nend\n')).toBe(false);
    expect(captured('def run(target = nil, x = begin; target; end)\n  x\nend\n')).toBe(false);
  });

  it('a `do` block inside a default IS captured, and only the later-parameter read survives as a call', () => {
    expect(captured('def run(x = [1].each do |a| target end, target: nil)\n  x\nend\n')).toBe(true);
    expect(captured('def run(target = nil, x = [1].each do |a| target end)\n  x\nend\n')).toBe(
      false,
    );
  });
});
