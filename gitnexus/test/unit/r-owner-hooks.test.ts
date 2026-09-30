import { describe, it, expect, beforeAll } from 'vitest';
import { SupportedLanguages } from 'gitnexus-shared';
import { createParserForLanguage } from '../../src/core/tree-sitter/parser-loader.js';
import type { SyntaxNode } from '../../src/core/ingestion/utils/ast-helpers.js';
import { rResolveMemberOwnerNode } from '../../src/core/ingestion/languages/r/owner-hooks.js';
import { rProvider } from '../../src/core/ingestion/languages/r.js';
import { getProvider } from '../../src/core/ingestion/languages/index.js';

// Fork #19, step 5: R's member-owner node is found through
// `LanguageProvider.resolveMemberOwnerNode`, not a `language === R` branch in the worker.
// R classes are calls/assignments, not syntactic containers, so the hook returns the R6
// `binary_operator` or the `setRefClass(...)` call that owns a member.

const SOURCE = `Foo <- R6::R6Class("Foo", public = list(n = 1, bar = function() 1))
Acc <- setRefClass("Acc", fields = list(a = "numeric"), methods = list(m = function() 1))
setMethod("area", "Circle", function(shape) 1)
plain <- function(x) x
`;

let root: SyntaxNode;

const walk = (n: SyntaxNode, visit: (n: SyntaxNode) => void): void => {
  visit(n);
  for (let i = 0; i < n.namedChildCount; i++) {
    const child = n.namedChild(i);
    if (child) walk(child, visit);
  }
};

const find = (pred: (n: SyntaxNode) => boolean): SyntaxNode => {
  let hit: SyntaxNode | undefined;
  walk(root, (n) => {
    if (hit === undefined && pred(n)) hit = n;
  });
  if (hit === undefined) throw new Error('fixture node not found');
  return hit;
};

const fnDefinitionOn = (row: number): SyntaxNode =>
  find((n) => n.type === 'function_definition' && n.startPosition.row === row);

beforeAll(async () => {
  const parser = await createParserForLanguage(SupportedLanguages.R);
  root = parser.parse(SOURCE).rootNode as unknown as SyntaxNode;
});

describe('rResolveMemberOwnerNode', () => {
  it('resolves an R6 method to the enclosing `Foo <- R6Class(...)` binary_operator', () => {
    const owner = rResolveMemberOwnerNode(fnDefinitionOn(0));
    expect(owner?.type).toBe('binary_operator');
    expect(owner?.childForFieldName('lhs')?.text).toBe('Foo');
  });

  it('resolves an R6 field to the same binary_operator', () => {
    const field = find((n) => n.type === 'argument' && n.childForFieldName('name')?.text === 'n');
    const owner = rResolveMemberOwnerNode(field);
    expect(owner?.type).toBe('binary_operator');
    expect(owner?.childForFieldName('lhs')?.text).toBe('Foo');
  });

  it('resolves a RefClass method to the `setRefClass(...)` call', () => {
    const owner = rResolveMemberOwnerNode(fnDefinitionOn(1));
    expect(owner?.type).toBe('call');
    expect(owner?.childForFieldName('function')?.text).toBe('setRefClass');
  });

  it('returns null for a top-level function', () => {
    expect(rResolveMemberOwnerNode(fnDefinitionOn(3))).toBeNull();
  });

  it('returns null for a setMethod(...) call (its owner arrives via ownerNameHint, not a node)', () => {
    const call = find(
      (n) => n.type === 'call' && n.childForFieldName('function')?.text === 'setMethod',
    );
    expect(rResolveMemberOwnerNode(call)).toBeNull();
    expect(rResolveMemberOwnerNode(fnDefinitionOn(2))).toBeNull();
  });
});

describe('resolveMemberOwnerNode provider wiring', () => {
  it('is registered on the R provider', () => {
    expect(rProvider.resolveMemberOwnerNode).toBe(rResolveMemberOwnerNode);
    expect(getProvider(SupportedLanguages.R).resolveMemberOwnerNode).toBe(rResolveMemberOwnerNode);
  });

  it('is left undefined on other providers', () => {
    for (const lang of [
      SupportedLanguages.Python,
      SupportedLanguages.TypeScript,
      SupportedLanguages.Java,
      SupportedLanguages.Zig,
    ]) {
      expect(getProvider(lang).resolveMemberOwnerNode).toBeUndefined();
    }
  });
});
