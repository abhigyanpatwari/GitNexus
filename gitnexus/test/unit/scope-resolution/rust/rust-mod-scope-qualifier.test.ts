/**
 * Unit tests for the enclosing-`mod` qualifier and the module-name filter
 * (#2742, hardened by the #2745 review).
 *
 * The integration suite proves the resolution outcomes; these pin the two
 * primitives directly, including the branches a fixture cannot reach — a scoped
 * target with no enclosing `mod`, and an all-anchor qualifier.
 */
import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import Rust from 'tree-sitter-rust';
import {
  qualifyByEnclosingModScope,
  type SyntaxNode,
} from '../../../../src/core/ingestion/utils/ast-helpers.js';
import { couldNameAModule } from '../../../../src/core/ingestion/languages/rust/module-path.js';

const parser = new Parser();
parser.setLanguage(Rust as unknown as Parser.Language);

/** First node of `type` in a post-order walk — the innermost such node. */
function findNode(root: SyntaxNode, type: string): SyntaxNode {
  const stack: SyntaxNode[] = [root];
  const hits: SyntaxNode[] = [];
  while (stack.length > 0) {
    const node = stack.pop() as SyntaxNode;
    if (node.type === type) hits.push(node);
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child !== null) stack.push(child);
    }
  }
  const deepest = hits.sort((a, b) => b.startIndex - a.startIndex)[0];
  expect(deepest).toBeDefined();
  return deepest;
}

function qualify(code: string, nodeType: string, rawText: string): string {
  const tree = parser.parse(code);
  return qualifyByEnclosingModScope(findNode(tree.rootNode, nodeType), rawText);
}

describe('qualifyByEnclosingModScope', () => {
  it('leaves an item at the crate root untouched', () => {
    expect(qualify('fn dispatch() {}', 'function_item', 'dispatch')).toBe('dispatch');
  });

  it('prefixes one enclosing mod', () => {
    expect(qualify('mod inner { fn dispatch() {} }', 'function_item', 'dispatch')).toBe(
      'inner.dispatch',
    );
  });

  it('prefixes the whole chain, outermost first', () => {
    expect(
      qualify('mod outer { mod tools { fn dispatch() {} } }', 'function_item', 'dispatch'),
    ).toBe('outer.tools.dispatch');
  });

  // The reason the no-enclosing-mod case returns raw text rather than
  // normalizing: `splitQualifiedName` rewrites `::` to `.`, which would move a
  // scoped impl target's node id away from the id its owner edge emits (#1975).
  it('returns a SCOPED target verbatim when there is no enclosing mod', () => {
    expect(qualify('impl a::Inner { fn helper(&self) {} }', 'impl_item', 'a::Inner')).toBe(
      'a::Inner',
    );
  });

  it('is the identity for an unscoped name, mod or no mod', () => {
    expect(qualify('impl Inner { fn helper(&self) {} }', 'impl_item', 'Inner')).toBe('Inner');
  });
});

describe('couldNameAModule', () => {
  const known = new Set(['tools', 'inner']);

  it('accepts a qualifier whose head names a known module', () => {
    expect(couldNameAModule(['tools'], known)).toBe(true);
  });

  it('rejects a type-qualified call (`Vec::new`) whose head names no module', () => {
    expect(couldNameAModule(['Vec'], known)).toBe(false);
  });

  it('tests the first NON-anchor segment, not the anchor', () => {
    expect(couldNameAModule(['crate', 'tools'], known)).toBe(true);
    expect(couldNameAModule(['crate', 'Vec'], known)).toBe(false);
    expect(couldNameAModule(['super', 'inner'], known)).toBe(true);
  });

  // `self::f()` names the caller's own module, which is always worth trying —
  // there is no head segment to test against the name set.
  it('accepts an all-anchor qualifier', () => {
    expect(couldNameAModule(['self'], known)).toBe(true);
    expect(couldNameAModule(['crate'], known)).toBe(true);
  });

  it('accepts the macro-expansion spelling of the crate anchor', () => {
    expect(couldNameAModule(['$crate', 'tools'], known)).toBe(true);
  });
});
