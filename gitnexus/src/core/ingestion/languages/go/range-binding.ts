import type { ParsedFile, Scope, TypeRef } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { getGoParser } from './query.js';
import { getTreeSitterBufferSize } from '../../constants.js';

export function populateGoRangeBindings(
  parsedFiles: readonly ParsedFile[],
  _indexes: ScopeResolutionIndexes,
  ctx: {
    readonly fileContents: ReadonlyMap<string, string>;
    readonly treeCache?: { get(filePath: string): unknown };
  },
): void {
  const parser = getGoParser();

  for (const parsed of parsedFiles) {
    const sourceText = ctx.fileContents.get(parsed.filePath);
    if (sourceText === undefined) continue;

    const cachedTree = ctx.treeCache?.get(parsed.filePath);
    const tree =
      (cachedTree as ReturnType<typeof parser.parse> | undefined) ??
      parser.parse(sourceText, undefined, {
        bufferSize: getTreeSitterBufferSize(sourceText),
      });
    const moduleScope = parsed.scopes.find((s) => s.kind === 'Module');
    if (moduleScope === undefined) continue;

    const scopeMap = new Map(parsed.scopes.map((s) => [s.id, s]));

    for (const rangeNode of tree.rootNode.descendantsOfType('for_statement')) {
      const rangeClause = rangeNode.namedChildren.find((c) => c.type === 'range_clause');
      if (rangeClause === undefined) continue;

      const left = rangeClause.namedChildren.find((c) => c.type === 'expression_list');
      if (left === undefined) continue;

      const rangeExpr = rangeClause.namedChildren.find(
        (c, idx) => c.type !== 'expression_list' && idx > rangeClause.namedChildren.indexOf(left),
      );
      if (rangeExpr === undefined) continue;

      // Identify the value variable (skip the `_` discard if present)
      const idents = left.namedChildren.filter((c) => c.type === 'identifier');
      let valueVar: string | null = null;
      if (idents.length >= 2) {
        valueVar = idents[1].text; // for _, v := range ...
      } else if (idents.length === 1) {
        valueVar = idents[0].text; // for v := range ...
      }

      if (valueVar === null || valueVar === '_') continue;

      // Resolve range expression type
      let elementType: string | null = null;

      if (rangeExpr.type === 'identifier') {
        // Look up the identifier's type in scope typeBindings (V1: module scope only)
        const binding = moduleScope.typeBindings.get(rangeExpr.text);
        if (binding !== null && binding !== undefined) {
          elementType = extractElementType(binding);
        }
      } else if (rangeExpr.type === 'call_expression') {
        const fnNode = rangeExpr.childForFieldName('function');
        if (fnNode !== null) {
          const fnName =
            fnNode.type === 'selector_expression'
              ? fnNode.childForFieldName('field')?.text
              : fnNode.text;
          if (fnName !== undefined) {
            const binding = moduleScope.typeBindings.get(fnName);
            if (binding !== null && binding !== undefined) {
              elementType = extractElementType(binding);
            }
          }
        }
      }

      if (elementType !== null && valueVar !== null) {
        // Inject type binding for the range variable onto the enclosing function scope
        const functionScope = findEnclosingFunctionScope(rangeNode, scopeMap);
        const targetScope = functionScope ?? moduleScope;
        const mutable = targetScope.typeBindings as Map<string, TypeRef>;
        mutable.set(valueVar, {
          rawName: elementType,
          declaredAtScope: targetScope.id,
          source: 'annotation',
        });
      }
    }
  }
}

function extractElementType(binding: TypeRef): string | null {
  const raw = binding.rawName;
  const mapMatch = raw.match(/^map\[[^\]]+\]\s*(.+)$/);
  if (mapMatch) return mapMatch[1].trim();
  if (raw.startsWith('[]')) return raw.slice(2).trim();
  const arrMatch = raw.match(/^\[\d+\](.+)$/);
  if (arrMatch) return arrMatch[1].trim();
  return raw;
}

function findEnclosingFunctionScope(
  node: unknown,
  scopeMap: ReadonlyMap<string, Scope>,
): Scope | null {
  const tsNode = node as {
    readonly parent: unknown;
    readonly type: string;
    readonly startPosition: { readonly row: number; readonly column: number };
  };
  // Walk up the AST to find the enclosing function or method declaration.
  let current: typeof tsNode | null = tsNode;
  while (current !== null) {
    if (current.type === 'function_declaration' || current.type === 'method_declaration') {
      // Match by source position: the scope whose range starts at the
      // same line/column as the tree-sitter node.
      for (const scope of scopeMap.values()) {
        if (
          scope.kind === 'Function' &&
          scope.range.startLine === current.startPosition.row &&
          scope.range.startCol === current.startPosition.column
        ) {
          return scope;
        }
      }
      break;
    }
    current = (current.parent as typeof tsNode) ?? null;
  }
  return null;
}
