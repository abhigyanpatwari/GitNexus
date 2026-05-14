import type { ParsedFile, Scope, TypeRef } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { getCppParser } from './query.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';

/**
 * Populate range-for loop variable type bindings for C++.
 *
 * Handles three patterns:
 *   1. `for (auto& user : users)` — simple range-for
 *   2. `for (auto& [key, user] : userMap)` — structured binding
 *   3. `for (auto& user : *usersPtr)` — dereference range-for
 *
 * Strategy: look up the range source variable's type in scope
 * typeBindings, extract the last template argument as the element
 * type, and inject a typeBinding for the loop variable.
 */
export function populateCppRangeBindings(
  parsedFiles: readonly ParsedFile[],
  _indexes: ScopeResolutionIndexes,
  ctx: {
    readonly fileContents: ReadonlyMap<string, string>;
    readonly treeCache?: { get(filePath: string): unknown };
  },
): void {
  const parser = getCppParser();

  for (const parsed of parsedFiles) {
    const sourceText = ctx.fileContents.get(parsed.filePath);
    if (sourceText === undefined) continue;

    const cachedTree = ctx.treeCache?.get(parsed.filePath);
    const tree =
      (cachedTree as ReturnType<typeof parser.parse> | undefined) ??
      parseSourceSafe(parser, sourceText, undefined, {
        bufferSize: getTreeSitterBufferSize(sourceText),
      });

    const moduleScope = parsed.scopes.find((s) => s.kind === 'Module');
    if (moduleScope === undefined) continue;

    const scopeMap = new Map(parsed.scopes.map((s) => [s.id, s]));

    // Build a map from parameter name → AST parameter_declaration node
    // so we can extract the un-normalized template type from the AST.
    const paramTypeMap = buildParamTemplateMap(tree.rootNode);

    for (const rangeNode of tree.rootNode.descendantsOfType('for_range_loop')) {
      // Get the declarator (loop variable)
      const declarator = rangeNode.childForFieldName('declarator');
      if (declarator === null) continue;

      // Get the range source expression (right side of ':')
      const right = rangeNode.childForFieldName('right');
      if (right === null) continue;

      // Determine the loop variable name(s) and whether this is a structured binding
      const varNames = extractLoopVarNames(declarator);
      if (varNames.length === 0) continue;

      // Determine the range source variable name (handle dereference)
      const sourceVarName = extractSourceVarName(right);
      if (sourceVarName === null) continue;

      // Look up the source variable's full template type from the AST
      // (scope typeBindings have been normalized and lost template params)
      const fullType = paramTypeMap.get(sourceVarName);
      if (fullType === undefined) continue;

      // Extract element type from the container type
      const elementType = extractCppElementType(fullType);
      if (elementType === null) continue;

      // Find the enclosing function scope
      const functionScope = findEnclosingFunctionScope(rangeNode, scopeMap);
      const targetScope = functionScope ?? moduleScope;
      const mutable = targetScope.typeBindings as Map<string, TypeRef>;

      // For structured binding [key, user], bind the last identifier to the element type
      // For simple range-for, bind the single variable
      const bindVar = varNames[varNames.length - 1];
      mutable.set(bindVar, {
        rawName: elementType,
        declaredAtScope: targetScope.id,
        source: 'annotation',
      });
    }
  }
}

/** Minimal tree-sitter node shape needed by range-binding helpers. */
interface TsNode {
  readonly type: string;
  readonly text: string;
  readonly childCount: number;
  child(index: number): TsNode | null;
  descendantsOfType(type: string): readonly TsNode[];
  childForFieldName(name: string): TsNode | null;
}

/**
 * Build a map from parameter name → full (un-normalized) type text
 * by walking the AST for all `parameter_declaration` nodes.
 *
 * This bypasses `normalizeCppTypeName` which strips template params,
 * giving us the raw `std::vector<User>` text needed for element-type
 * extraction.
 */
function buildParamTemplateMap(rootNode: TsNode): Map<string, string> {
  const map = new Map<string, string>();
  for (const paramNode of rootNode.descendantsOfType('parameter_declaration')) {
    const typeNode = paramNode.childForFieldName('type');
    if (typeNode === null) continue;

    // Extract the parameter name from the declarator subtree.
    // The declarator may be: identifier, reference_declarator > identifier,
    // or pointer_declarator > identifier.
    const declNode = paramNode.childForFieldName('declarator');
    if (declNode === null) continue;

    const idents = declNode.descendantsOfType('identifier');
    if (idents.length === 0) continue;
    const paramName = idents[idents.length - 1].text;

    // Use the full type node text (preserving template params)
    map.set(paramName, typeNode.text);
  }
  return map;
}

/**
 * Extract loop variable name(s) from the declarator node.
 * Handles both simple `identifier` and `structured_binding_declarator`.
 */
function extractLoopVarNames(declarator: TsNode): string[] {
  // The declarator is typically reference_declarator or pointer_declarator wrapping
  // either an identifier or a structured_binding_declarator.
  const structBindings = declarator.descendantsOfType('structured_binding_declarator');
  if (structBindings.length > 0) {
    // structured_binding_declarator contains identifiers like [key, user]
    const idents = structBindings[0].descendantsOfType('identifier');
    return idents.map((id) => id.text).filter((t) => t !== '_');
  }

  // Simple case: reference_declarator > identifier or just identifier
  const idents = declarator.descendantsOfType('identifier');
  if (idents.length > 0) {
    return [idents[idents.length - 1].text];
  }

  return [];
}

/**
 * Extract the source variable name from the range expression.
 * Handles plain identifiers and dereference expressions (*ptr).
 */
function extractSourceVarName(right: TsNode): string | null {
  if (right.type === 'identifier') {
    return right.text;
  }
  if (right.type === 'pointer_expression') {
    // *usersPtr → get the argument (usersPtr)
    const arg = right.childForFieldName('argument');
    if (arg !== null) return arg.text;
  }
  return null;
}

/**
 * Extract the element type from a C++ container type string.
 *
 * Examples:
 *   - `vector<User>` → `User`
 *   - `std::vector<User>` → `User`
 *   - `map<std::string, User>` → `User` (last template arg)
 *   - `map<string, User>` → `User`
 *
 * For structured bindings with maps, the last template arg is the value type.
 * For vectors/sets, the first (and only) template arg is the element type.
 */
function extractCppElementType(rawType: string): string | null {
  // Find the outermost template argument list
  const ltIdx = rawType.indexOf('<');
  if (ltIdx === -1) return null;

  // Extract the template argument string (handle nested templates)
  let depth = 0;
  let lastCommaOrStart = ltIdx + 1;
  let lastArg = '';

  for (let i = ltIdx; i < rawType.length; i++) {
    const ch = rawType[i];
    if (ch === '<') {
      depth++;
    } else if (ch === '>') {
      depth--;
      if (depth === 0) {
        lastArg = rawType.slice(lastCommaOrStart, i).trim();
        break;
      }
    } else if (ch === ',' && depth === 1) {
      lastCommaOrStart = i + 1;
    }
  }

  if (lastArg === '') return null;

  // Strip pointer/reference qualifiers and const
  let elementType = lastArg
    .replace(/^const\s+/, '')
    .replace(/\s*[*&]+\s*$/, '')
    .trim();

  // Strip namespace prefix (std::string → string)
  const lastColon = elementType.lastIndexOf('::');
  if (lastColon !== -1) {
    elementType = elementType.slice(lastColon + 2);
  }

  return elementType || null;
}

/**
 * Find the enclosing Function scope for a tree-sitter node by
 * walking up the AST and matching source positions.
 */
function findEnclosingFunctionScope(
  node: unknown,
  scopeMap: ReadonlyMap<string, Scope>,
): Scope | null {
  const tsNode = node as {
    readonly parent: unknown;
    readonly type: string;
    readonly startPosition: { readonly row: number; readonly column: number };
  };
  let current: typeof tsNode | null = tsNode;
  while (current !== null) {
    if (current.type === 'function_definition') {
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
