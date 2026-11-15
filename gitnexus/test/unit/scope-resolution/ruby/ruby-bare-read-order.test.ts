/**
 * RUBY-04 — the bare-read helper, pinned directly on parsed trees.
 *
 * `rubyBareNameIsLocalRead` decides whether a bare identifier statement reads
 * a parameter or local (no CALLS edge) or calls a method. Ruby registers a
 * parameter as the parser passes its NAME, so a read inside parameter k's
 * default sees the parameters declared before k and k itself (a circular
 * reference, nil), never a later one. Checked on CRuby 2.6:
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
 *
 * The rest of the file pins where a name binds: header expressions bind the
 * enclosing scope, `BEGIN` / `END` bodies share it, only pattern binding
 * positions bind (not a hash argument that tree-sitter-ruby parses as a
 * pattern match), and a read inside a heredoc body is placed at its opener.
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

/** Every `name` identifier in statement position (not a declaration name). */
function targetReads(source: string, name = 'target'): SyntaxNode[] {
  const tree = getRubyParser().parse(source);
  const reads: SyntaxNode[] = [];
  const walk = (node: SyntaxNode): void => {
    if (
      node.type === 'identifier' &&
      node.text === name &&
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

/** The helper's verdict for the single `name` read in `source`. */
function readsLocal(source: string, name = 'target'): boolean {
  const reads = targetReads(source, name);
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

describe('Ruby bare read: where a parameter or local binds (RUBY-04)', () => {
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
      // start.
      expect(readsLocal(source)).toBe(false);
    },
  );

  it('an earlier multiple-assignment target is parsed before a later target declares the name', () => {
    // A name binds where it is WRITTEN, not at the assignment's start.
    expect(
      readsLocal('def run\n  arr = []\n  arr[[1].map do |x| target end], target = [], 1\nend\n'),
    ).toBe(false);
  });

  it('a read after a multiple assignment that binds the name is a read', () => {
    expect(readsLocal('def run\n  a, target = 1, 2\n  target\nend\n')).toBe(true);
  });

  describe('header expressions bind the enclosing scope', () => {
    it.each([
      ['singleton receiver', 'def (target = Object.new).run\n  target\nend\n'],
      ['superclass expression', 'class Sub < (target = Object).class\n  target\nend\n'],
      ['class << value', 'class << (target = Object.new)\n  target\nend\n'],
      ['class name expression', 'class (target = Object)::Inner\n  target\nend\n'],
      ['module name expression', 'module (target = Object)::Inner\n  target\nend\n'],
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
      [
        'class name expression (program-level local)',
        'target = 1\nclass ([1].each do target end; Object)::Foo\nend\n',
      ],
      [
        'module name expression (program-level local)',
        'target = 1\nmodule ([1].each do target end; Object)::Foo\nend\n',
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

  describe('BEGIN / END bodies share the enclosing scope', () => {
    it.each([
      ['END assignment binds the method body', 'def run\n  END { target = 1 }\n  target\nend\n'],
      [
        'END body read sees the method parameter',
        'def run(target)\n  END { [1].each do\n    target\n  end }\nend\n',
      ],
      [
        'top-level BEGIN assignment binds a later do-block read',
        'BEGIN { target = 1 }\n[1].each do\n  target\nend\n',
      ],
    ])('%s (read)', (_name, src) => {
      expect(readsLocal(src)).toBe(true);
    });
  });

  describe('pattern expression parts and hash arguments', () => {
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
    ])('%s: an expression part of a pattern is not a binding position (call)', (_name, src) => {
      expect(readsLocal(src)).toBe(false);
    });

    it.each([
      ['call argument', 'def run(s, x)\n  s.put !x => target\n  target\nend\n'],
      ['parenthesized call argument', 'def run(s, x)\n  s.put(!x => target)\n  target\nend\n'],
      ['argument after a symbol', 'def run(s, x)\n  s.put :a, -x => target\n  target\nend\n'],
      ['double unary', 'def run(s, x)\n  s.put !!x => target\n  target\nend\n'],
      ['array literal element', 'def run(x)\n  [!x => target]\n  target\nend\n'],
      ['subscript argument', 'def run(s, x)\n  s[!x => target]\n  target\nend\n'],
      ['yield argument', 'def run(x)\n  yield !x => target\n  target\nend\n'],
    ])(
      '%s: a hash argument whose key starts with a unary operator binds nothing (call)',
      (_name, src) => {
        // tree-sitter-ruby parses it as `unary (match_pattern …)`; Ruby reads
        // `{ !x => target }`.
        expect(readsLocal(src)).toBe(false);
      },
    );

    it('the statement `!x => target` is a pattern match and binds (read)', () => {
      expect(readsLocal('def run(x)\n  !x => target\n  target\nend\n')).toBe(true);
      expect(readsLocal('def run(x)\n  !x in target\n  target\nend\n')).toBe(true);
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
      ['quoted hash shorthand', 'def run(v)\n  case v\n  in {"target":}\n  end\n  target\nend\n'],
      ['find pattern', 'def run(v)\n  case v\n  in [*, target, *]\n  end\n  target\nend\n'],
      ['splat', 'def run(v)\n  case v\n  in [1, *target]\n  end\n  target\nend\n'],
      ['parenthesized', 'def run(v)\n  case v\n  in (target)\n  end\n  target\nend\n'],
      ['as pattern', 'def run(v)\n  case v\n  in [1] => target\n  end\n  target\nend\n'],
    ])('%s: a true pattern binding position binds (read)', (_name, src) => {
      expect(readsLocal(src)).toBe(true);
    });

    it('an `_`-prefixed name in an alternative pattern binds (read)', () => {
      // Only `_`-prefixed names may bind inside an alternative pattern.
      expect(
        readsLocal('def run(v)\n  case v\n  in nil | _target\n  end\n  _target\nend\n', '_target'),
      ).toBe(true);
    });
  });

  describe('a heredoc body is parsed at its opener', () => {
    it.each([
      [
        'a nested method closed on the opener line cannot see the outer parameter',
        'def outer(target)\n  def inner; foo(<<~A); end\n#{[1].each do; target; end}\nA\nend\n',
        false,
      ],
      [
        'an assignment in a closed nested method does not leak',
        'def outer\n  def inner; foo(<<~A); end\n#{target = 1}\nA\ntarget\nend\n',
        false,
      ],
      [
        'an assignment in a closed block does not leak',
        'def outer\n  foo do; puts <<~A; end\n#{target = 1}\nA\ntarget\nend\n',
        false,
      ],
      [
        'a closed block parameter remains visible to its body',
        'def run\n  foo do |target|; puts <<~A; end\n#{[1].each do; target; end}\nA\nend\n',
        true,
      ],
      [
        'a default in a closed method sees its own parameter',
        'def run(target = <<~A); end\n#{[1].each do; target; end}\nA\n',
        true,
      ],
      [
        'a later opener-line read sees the body binding',
        'def run\n  foo(<<~A); [1].each do; target; end\n#{target = 1}\nA\nend\n',
        true,
      ],
      [
        'a read between openers sees the first body binding',
        'def run\nfoo(<<~A, [1].each do; target; end, <<~B)\n#{target = 1}\nA\nb\nB\nend\n',
        true,
      ],
      [
        'a read between openers cannot see the second body binding',
        'def run\nfoo(<<~A, [1].each do; target; end, <<~B)\na\nA\n#{target = 1}\nB\nend\n',
        false,
      ],
    ] as const)('%s', (_name, source, local) => {
      // Prism 2.1.0 accepts each source and classifies these statement reads.
      expect(readsLocal(source)).toBe(local);
      expect(captured(source)).toBe(!local);
    });

    // Ruby lexes a body when it reaches the body's `<<~` token, before the
    // rest of that line: a read in the body sees what was bound before the
    // token, but not an assignment later on the opener line.
    it.each([
      [
        'a parameter bound before the opener',
        'def run(target)\n  other(<<~EOS)\n    #{[1].map do\n      target\n    end}\n  EOS\nend\n',
      ],
      [
        'a local bound before the opener line',
        'def run\n  target = 1\n  other(<<~EOS)\n    #{[1].map do\n      target\n    end}\n  EOS\nend\n',
      ],
      [
        'a binding in an earlier body of the same line',
        'def run\n  foo(<<~A, <<~B)\n    #{target = 1}\n  A\n    #{[1].map do\n      target\n    end}\n  B\nend\n',
      ],
      [
        "an assignment before the second body's opener",
        'def run\n  foo(<<~A, target = 1, <<~B)\n    a\n  A\n    #{[1].map do\n      target\n    end}\n  B\nend\n',
      ],
      [
        'a binding earlier in the same body after an opener-line assignment',
        'def run\n  other(<<~EOS, target = 1)\n    #{target = 2}\n    #{[1].map do\n      target\n    end}\n  EOS\nend\n',
      ],
      [
        'a binding made by a scope inside the body',
        'def run\n  other(<<~EOS)\n    #{[1].map do |target|\n      target\n    end}\n  EOS\nend\n',
      ],
    ])('%s: the body read is a read', (_name, src) => {
      expect(readsLocal(src)).toBe(true);
    });

    it.each([
      [
        'an assignment later on the opener line',
        'def run\n  other(<<~EOS, target = 1)\n    #{[1].map do\n      target\n    end}\n  EOS\nend\n',
      ],
      [
        "an assignment after the second body's opener",
        'def run\n  foo(<<~A, <<~B, target = 1)\n    a\n  A\n    #{[1].map do\n      target\n    end}\n  B\nend\n',
      ],
    ])('%s: not yet parsed, so the body read is a call', (_name, src) => {
      expect(readsLocal(src)).toBe(false);
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
