/**
 * Unit tests for `maybeRewriteRubyBareCallToSelf` — the self-inference helper
 * that rewrites Ruby bare-identifier calls inside class/module bodies into
 * `self`-receiver member calls (plan 005 DAG / Ruby `inferImplicitReceiver`).
 *
 * The helper is pure: given the call name, callForm, AST node, enclosing
 * class, and a minimal provider shape, it returns a rewrite suggestion or
 * null. These tests pin each gate + branch so regressions surface at unit
 * level rather than through the Ruby integration fixtures.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import Parser from 'tree-sitter';
import Ruby from 'tree-sitter-ruby';
import { maybeRewriteRubyBareCallToSelf } from '../../src/core/ingestion/utils/ruby-self-call.js';
import type { LanguageProvider } from '../../src/core/ingestion/language-provider.js';
import type { SyntaxNode } from '../../src/core/ingestion/utils/ast-helpers.js';

const parser = new Parser();

beforeAll(() => {
  parser.setLanguage(Ruby as unknown as Parser.Language);
});

function parseRuby(src: string): SyntaxNode {
  return parser.parse(src).rootNode;
}

/** Find the first identifier node whose `text` matches `name` (DFS, pre-order). */
function findIdentifier(root: SyntaxNode, name: string): SyntaxNode | null {
  const stack: SyntaxNode[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === 'identifier' && node.text === name) return node;
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.child(i);
      if (child) stack.push(child);
    }
  }
  return null;
}

/** Minimal provider stub matching the helper's structural expectations. */
const rubyProviderStub: Pick<LanguageProvider, 'isBuiltInName' | 'mroStrategy'> = {
  isBuiltInName: (name: string) =>
    new Set(['puts', 'p', 'raise', 'require', 'include', 'extend', 'prepend', 'attr_accessor']).has(
      name,
    ),
  mroStrategy: 'ruby-mixin',
};

const nonRubyProviderStub: Pick<LanguageProvider, 'isBuiltInName' | 'mroStrategy'> = {
  isBuiltInName: () => false,
  mroStrategy: 'first-wins',
};

describe('maybeRewriteRubyBareCallToSelf', () => {
  it('rewrites bare call inside instance method → self-receiver member call', () => {
    const root = parseRuby(`
class Account
  def call_greet
    greet
  end
end
`);
    const call = findIdentifier(root, 'greet')!;
    expect(call).not.toBeNull();

    const rewrite = maybeRewriteRubyBareCallToSelf(
      'greet',
      'free',
      call,
      'Account',
      rubyProviderStub,
    );
    expect(rewrite).toEqual({
      callForm: 'member',
      receiverName: 'self',
      receiverTypeName: 'Account',
      dispatchKind: 'instance',
    });
  });

  it('accepts `callForm === undefined` (body_statement bare identifier captures)', () => {
    // Ruby body-statement captures produce callForm === undefined because the
    // @call node IS the @call.name node. The helper must accept both undefined
    // and 'free'.
    const root = parseRuby(`
class Account
  def work
    helper
  end
end
`);
    const call = findIdentifier(root, 'helper')!;

    const rewrite = maybeRewriteRubyBareCallToSelf(
      'helper',
      undefined,
      call,
      'Account',
      rubyProviderStub,
    );
    expect(rewrite?.callForm).toBe('member');
    expect(rewrite?.receiverTypeName).toBe('Account');
  });

  it('flags singleton dispatch for calls inside `def self.foo` bodies', () => {
    const root = parseRuby(`
class Account
  def self.factory
    log("building")
  end
end
`);
    const call = findIdentifier(root, 'log')!;

    const rewrite = maybeRewriteRubyBareCallToSelf(
      'log',
      'free',
      call,
      'Account',
      rubyProviderStub,
    );
    expect(rewrite?.dispatchKind).toBe('singleton');
    expect(rewrite?.receiverTypeName).toBe('Account');
  });

  it('flags singleton dispatch for calls inside `class << self` body', () => {
    const root = parseRuby(`
class Account
  class << self
    def factory
      log("msg")
    end
  end
end
`);
    const call = findIdentifier(root, 'log')!;

    const rewrite = maybeRewriteRubyBareCallToSelf(
      'log',
      'free',
      call,
      'Account',
      rubyProviderStub,
    );
    expect(rewrite?.dispatchKind).toBe('singleton');
  });

  it('returns null for Kernel built-in methods (puts)', () => {
    const root = parseRuby(`
class Account
  def greet
    puts "hi"
  end
end
`);
    const call = findIdentifier(root, 'puts')!;

    const rewrite = maybeRewriteRubyBareCallToSelf(
      'puts',
      'free',
      call,
      'Account',
      rubyProviderStub,
    );
    expect(rewrite).toBeNull();
  });

  it('returns null for `super` keyword', () => {
    const root = parseRuby(`
class Account
  def save
    super
  end
end
`);
    const call = findIdentifier(root, 'super') ?? root;

    const rewrite = maybeRewriteRubyBareCallToSelf(
      'super',
      'free',
      call,
      'Account',
      rubyProviderStub,
    );
    expect(rewrite).toBeNull();
  });

  it('returns null at file-level (no enclosing class)', () => {
    const root = parseRuby(`
some_top_level_call
`);
    const call = findIdentifier(root, 'some_top_level_call')!;

    const rewrite = maybeRewriteRubyBareCallToSelf(
      'some_top_level_call',
      'free',
      call,
      null,
      rubyProviderStub,
    );
    expect(rewrite).toBeNull();
  });

  it('returns null when callForm is already member (explicit receiver present)', () => {
    const root = parseRuby(`
class Account
  def greet
    self.say_hello
  end
end
`);
    const call = findIdentifier(root, 'say_hello')!;

    const rewrite = maybeRewriteRubyBareCallToSelf(
      'say_hello',
      'member',
      call,
      'Account',
      rubyProviderStub,
    );
    expect(rewrite).toBeNull();
  });

  it('returns null when callForm is constructor', () => {
    const root = parseRuby(`
class Account
  def build
    Account.new
  end
end
`);
    const call = findIdentifier(root, 'new')!;

    const rewrite = maybeRewriteRubyBareCallToSelf(
      'new',
      'constructor',
      call,
      'Account',
      rubyProviderStub,
    );
    expect(rewrite).toBeNull();
  });

  it('returns null for non-Ruby providers (mroStrategy !== ruby-mixin)', () => {
    const root = parseRuby(`
class Account
  def greet
    some_call
  end
end
`);
    const call = findIdentifier(root, 'some_call')!;

    const rewrite = maybeRewriteRubyBareCallToSelf(
      'some_call',
      'free',
      call,
      'Account',
      nonRubyProviderStub,
    );
    expect(rewrite).toBeNull();
  });

  it('uses module name as receiverTypeName for calls inside module body', () => {
    const root = parseRuby(`
module Helpers
  def format
    capitalize
  end
end
`);
    const call = findIdentifier(root, 'capitalize')!;

    const rewrite = maybeRewriteRubyBareCallToSelf(
      'capitalize',
      'free',
      call,
      'Helpers',
      rubyProviderStub,
    );
    expect(rewrite).toEqual({
      callForm: 'member',
      receiverName: 'self',
      receiverTypeName: 'Helpers',
      dispatchKind: 'instance',
    });
  });

  it('terminates walk at enclosing class/module (does not walk past into outer scopes)', () => {
    // `outer_call` is inside `Inner#work`; Inner is nested inside Outer.
    // Enclosing class is Inner — the helper should return dispatchKind='instance'
    // without escaping to Outer's singleton methods (if any existed).
    const root = parseRuby(`
module Outer
  class Inner
    def work
      outer_call
    end
  end
end
`);
    const call = findIdentifier(root, 'outer_call')!;

    const rewrite = maybeRewriteRubyBareCallToSelf(
      'outer_call',
      'free',
      call,
      'Inner',
      rubyProviderStub,
    );
    expect(rewrite?.dispatchKind).toBe('instance');
    expect(rewrite?.receiverTypeName).toBe('Inner');
  });
});
