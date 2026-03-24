import { describe, it, expect } from 'vitest';
import { extractCSharpNamedBindings } from '../../../src/core/ingestion/named-bindings/csharp.js';
import Parser from 'tree-sitter';
import CSharp from 'tree-sitter-c-sharp';

const parser = new Parser();

/** Walk a tree depth-first and return the first node matching the given type. */
function findFirst(node: any, type: string): any | undefined {
  if (node.type === type) return node;
  for (let i = 0; i < node.childCount; i++) {
    const found = findFirst(node.child(i), type);
    if (found) return found;
  }
  return undefined;
}

const parse = (code: string) => {
  parser.setLanguage(CSharp);
  return parser.parse(code);
};

describe('extractCSharpNamedBindings', () => {
  describe('non-aliased namespace imports (known limitation)', () => {
    it('returns undefined for non-aliased namespace imports (known limitation)', () => {
      // C# using Namespace imports can't be reduced to per-symbol bindings without type
      // inference — resolution falls back to PackageMap directory matching.
      const tree = parse('using MyApp.Models;');
      const usingNode = findFirst(tree.rootNode, 'using_directive');
      expect(usingNode).toBeDefined();

      const result = extractCSharpNamedBindings(usingNode);

      expect(result).toBeUndefined();
    });

    it('returns undefined for a single-segment non-aliased import', () => {
      // C# using Namespace imports can't be reduced to per-symbol bindings without type
      // inference — resolution falls back to PackageMap directory matching.
      const tree = parse('using System;');
      const usingNode = findFirst(tree.rootNode, 'using_directive');
      expect(usingNode).toBeDefined();

      const result = extractCSharpNamedBindings(usingNode);

      expect(result).toBeUndefined();
    });
  });

  describe('aliased imports', () => {
    it('returns a binding for a simple aliased import', () => {
      const tree = parse('using Mod = MyApp.Models;');
      const usingNode = findFirst(tree.rootNode, 'using_directive');
      expect(usingNode).toBeDefined();

      const result = extractCSharpNamedBindings(usingNode);

      expect(result).toEqual([{ local: 'Mod', exported: 'Models' }]);
    });

    it('uses the last segment of the qualified name as the exported binding', () => {
      const tree = parse('using Svc = MyApp.Services.UserService;');
      const usingNode = findFirst(tree.rootNode, 'using_directive');
      expect(usingNode).toBeDefined();

      const result = extractCSharpNamedBindings(usingNode);

      expect(result).toEqual([{ local: 'Svc', exported: 'UserService' }]);
    });
  });

  describe('edge cases', () => {
    it('returns undefined when the node type is not using_directive', () => {
      // Passing a synthetic object that is not a using_directive node.
      const fakeNode = { type: 'import_declaration', namedChildCount: 0 };

      const result = extractCSharpNamedBindings(fakeNode);

      expect(result).toBeUndefined();
    });
  });
});
