/**
 * Regression tests for the provider-driven resolveEnclosingOwner hook.
 *
 * Verifies that:
 * 1. findEnclosingClassInfo delegates to the resolveEnclosingOwner hook
 * 2. Ruby's resolveEnclosingOwner correctly remaps singleton_class → class/module
 * 3. The hook returns null to skip containers (keep walking up)
 * 4. Without the hook, the generic behavior is preserved
 */
import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import Ruby from 'tree-sitter-ruby';
import { findEnclosingClassInfo } from '../../src/core/ingestion/utils/ast-helpers.js';
import { rubyProvider } from '../../src/core/ingestion/languages/ruby.js';

let Kotlin: unknown;
try {
  Kotlin = require('tree-sitter-kotlin');
} catch {
  // Kotlin grammar may not be installed
}

const parser = new Parser();

const parseRuby = (code: string) => {
  parser.setLanguage(Ruby);
  return parser.parse(code);
};

const parseKotlin = (code: string) => {
  parser.setLanguage(Kotlin as Parser.Language);
  return parser.parse(code);
};

// ---------------------------------------------------------------------------
// Ruby resolveEnclosingOwner hook
// ---------------------------------------------------------------------------

describe('Ruby resolveEnclosingOwner', () => {
  it('remaps singleton_class to enclosing class for findEnclosingClassInfo', () => {
    const tree = parseRuby(`
class Animal
  class << self
    def from_habitat(habitat)
    end
  end
end
    `);
    // Navigate to the method node inside singleton_class
    const classNode = tree.rootNode.child(0)!;
    const bodyStmt = classNode.namedChildren.find((c) => c.type === 'body_statement')!;
    const singletonClass = bodyStmt.namedChildren.find((c) => c.type === 'singleton_class')!;
    const innerBody = singletonClass.namedChildren.find((c) => c.type === 'body_statement')!;
    const methodNode = innerBody.namedChildren.find((c) => c.type === 'method')!;

    const info = findEnclosingClassInfo(
      methodNode,
      'animal.rb',
      rubyProvider.resolveEnclosingOwner,
    );

    expect(info).not.toBeNull();
    expect(info!.className).toBe('Animal');
    expect(info!.classId).toContain('Animal');
  });

  it('remaps singleton_class inside module to enclosing module', () => {
    const tree = parseRuby(`
module Helpers
  class << self
    def greet
    end
  end
end
    `);
    const moduleNode = tree.rootNode.child(0)!;
    const bodyStmt = moduleNode.namedChildren.find((c) => c.type === 'body_statement')!;
    const singletonClass = bodyStmt.namedChildren.find((c) => c.type === 'singleton_class')!;
    const innerBody = singletonClass.namedChildren.find((c) => c.type === 'body_statement')!;
    const methodNode = innerBody.namedChildren.find((c) => c.type === 'method')!;

    const info = findEnclosingClassInfo(
      methodNode,
      'helpers.rb',
      rubyProvider.resolveEnclosingOwner,
    );

    expect(info).not.toBeNull();
    expect(info!.className).toBe('Helpers');
    expect(info!.classId).toContain('Module');
  });

  it('returns null for file-level singleton_class without enclosing class', () => {
    const tree = parseRuby(`
class << self
  def orphan
  end
end
    `);
    const singletonClass = tree.rootNode.child(0)!;
    const innerBody = singletonClass.namedChildren.find((c) => c.type === 'body_statement')!;
    const methodNode = innerBody.namedChildren.find((c) => c.type === 'method')!;

    const info = findEnclosingClassInfo(
      methodNode,
      'orphan.rb',
      rubyProvider.resolveEnclosingOwner,
    );

    // No enclosing class/module — should return null
    expect(info).toBeNull();
  });

  it('non-singleton containers pass through unchanged', () => {
    const tree = parseRuby(`
class Dog
  def bark
  end
end
    `);
    const classNode = tree.rootNode.child(0)!;
    const bodyStmt = classNode.namedChildren.find((c) => c.type === 'body_statement')!;
    const methodNode = bodyStmt.namedChildren.find((c) => c.type === 'method')!;

    const info = findEnclosingClassInfo(methodNode, 'dog.rb', rubyProvider.resolveEnclosingOwner);

    expect(info).not.toBeNull();
    expect(info!.className).toBe('Dog');
  });
});

// ---------------------------------------------------------------------------
// Kotlin: findEnclosingClassInfo without resolveEnclosingOwner
// ---------------------------------------------------------------------------

describe('Kotlin enclosing owner resolution (no resolveEnclosingOwner needed)', () => {
  (Kotlin ? it : it.skip)('companion_object methods resolve to the companion object name', () => {
    const tree = parseKotlin(`
        class UserService {
          companion object Factory {
            fun create(): UserService = UserService()
          }
        }
      `);
    // Navigate to the function_declaration inside companion object
    const classNode = tree.rootNode.child(0)!;
    const classBody = classNode.namedChild(1)!;
    const companion = classBody.namedChild(0)!;
    const companionBody = companion.namedChildren.find((c) => c.type === 'class_body')!;
    const funcDecl = companionBody.namedChildren.find((c) => c.type === 'function_declaration')!;

    const info = findEnclosingClassInfo(funcDecl, 'service.kt');

    expect(info).not.toBeNull();
    // companion_object is a valid CLASS_CONTAINER_TYPES — its name resolves via generic logic
    expect(info!.className).toBe('Factory');
  });

  (Kotlin ? it : it.skip)('object_declaration methods resolve to the object name', () => {
    const tree = parseKotlin(`
        object Singleton {
          fun instance(): Singleton = Singleton()
        }
      `);
    const objDecl = tree.rootNode.child(0)!;
    const objBody = objDecl.namedChildren.find((c) => c.type === 'class_body')!;
    const funcDecl = objBody.namedChildren.find((c) => c.type === 'function_declaration')!;

    const info = findEnclosingClassInfo(funcDecl, 'singleton.kt');

    expect(info).not.toBeNull();
    expect(info!.className).toBe('Singleton');
  });
});

// ---------------------------------------------------------------------------
// Future-proofing: invariants of the resolveEnclosingOwner hook contract
// ---------------------------------------------------------------------------
//
// A future provider implementer might:
//   (a) Return a non-container node by mistake (e.g. a raw identifier).
//   (b) Return `current` (identity), expecting "use this container as-is".
//
// Neither case must produce an infinite loop. These tests pin the contract.

describe('findEnclosingClassInfo: hook contract guards', () => {
  it('handles a hook that returns a non-container node without infinite-looping', () => {
    // Ruby: class Outer { class Inner { def foo } }
    // Hook will redirect from `Inner` (a CLASS_CONTAINER_TYPES node) to a
    // raw `identifier`/`constant` node, which is NOT in CLASS_CONTAINER_TYPES.
    const tree = parseRuby(`
class Outer
  class Inner
    def foo
    end
  end
end
    `);

    const outerClass = tree.rootNode.child(0)!;
    const outerBody = outerClass.namedChildren.find((c) => c.type === 'body_statement')!;
    const innerClass = outerBody.namedChildren.find((c) => c.type === 'class')!;
    const innerBody = innerClass.namedChildren.find((c) => c.type === 'body_statement')!;
    const methodNode = innerBody.namedChildren.find((c) => c.type === 'method')!;

    let calls = 0;
    const start = Date.now();
    // Resolve-hook returns a non-container child node (the class name identifier/constant).
    // Per the documented contract, the walk must not infinite-loop: after the hook
    // remaps, the next iteration sees a non-container node and continues walking
    // up via `current = current.parent` at the end of the loop body.
    const info = findEnclosingClassInfo(methodNode, 'nested.rb', (node) => {
      calls += 1;
      // Bail out if the contract is broken — fail fast rather than hang the suite.
      if (calls > 50) throw new Error('hook called too many times — possible infinite loop');
      // Always redirect to the class's name node (a 'constant' in tree-sitter-ruby),
      // which is NOT in CLASS_CONTAINER_TYPES.
      const nameNode = node.childForFieldName?.('name');
      return nameNode ?? node;
    });
    const elapsed = Date.now() - start;

    // Must complete quickly — no hang.
    expect(elapsed).toBeLessThan(1000);
    // Hook was exercised.
    expect(calls).toBeGreaterThan(0);
    // The function should return null (no resolvable container) rather than loop.
    // It should NOT throw, and behavior is well-defined.
    expect(info === null || (info && typeof info.className === 'string')).toBe(true);
  });

  it('handles a hook that returns the input node (identity) without infinite-looping', () => {
    // Identity return is the documented "use this container as-is" branch.
    // The existing `resolved === current` short-circuit must keep the algorithm
    // moving forward (no re-evaluation), and the container is used directly.
    const tree = parseRuby(`
class Wolf
  def howl
  end
end
    `);
    const classNode = tree.rootNode.child(0)!;
    const bodyStmt = classNode.namedChildren.find((c) => c.type === 'body_statement')!;
    const methodNode = bodyStmt.namedChildren.find((c) => c.type === 'method')!;

    let calls = 0;
    const start = Date.now();
    const info = findEnclosingClassInfo(methodNode, 'wolf.rb', (node) => {
      calls += 1;
      if (calls > 50) throw new Error('hook called too many times — possible infinite loop');
      return node; // identity — equivalent to "no remap"
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);
    expect(info).not.toBeNull();
    expect(info!.className).toBe('Wolf');
    // Hook should be called exactly once per CLASS_CONTAINER_TYPES node visited
    // (here: just `class Wolf`). If the identity branch re-entered the hook, calls > 1.
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Generic behavior: no hook → container used as-is
// ---------------------------------------------------------------------------

describe('findEnclosingClassInfo without resolveEnclosingOwner', () => {
  it('returns the first matching container without any remapping', () => {
    const tree = parseRuby(`
class Dog
  def bark
  end
end
    `);
    const classNode = tree.rootNode.child(0)!;
    const bodyStmt = classNode.namedChildren.find((c) => c.type === 'body_statement')!;
    const methodNode = bodyStmt.namedChildren.find((c) => c.type === 'method')!;

    // Without the hook, generic behavior applies
    const info = findEnclosingClassInfo(methodNode, 'dog.rb');

    expect(info).not.toBeNull();
    expect(info!.className).toBe('Dog');
  });
});
