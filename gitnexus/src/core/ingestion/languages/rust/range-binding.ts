import type { ParsedFile, Scope, ScopeId, TypeRef } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { getRustParser } from './query.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

/**
 * Populate type bindings for patterns and iterators that the tree-sitter
 * query can't handle (they need runtime type lookup, not just syntax).
 *
 * Covers: for-loop element types, if-let/while-let pattern bindings,
 * match arm patterns, and struct destructuring.
 *
 * Runs in Phase 2 (after propagateImportedReturnTypes) so all cross-file
 * type bindings are available for lookup.
 */
export function populateRustRangeBindings(
  parsedFiles: readonly ParsedFile[],
  _indexes: ScopeResolutionIndexes,
  ctx: {
    readonly fileContents: ReadonlyMap<string, string>;
    readonly treeCache?: { get(filePath: string): unknown };
  },
): void {
  const parser = getRustParser();
  const allReturnTypes = new Map<string, string>();
  const allFieldTypes = new Map<string, Map<string, string>>();

  for (const parsed of parsedFiles) {
    const sourceText = ctx.fileContents.get(parsed.filePath);
    if (sourceText === undefined) continue;

    const cachedTree = ctx.treeCache?.get(parsed.filePath);
    const tree =
      (cachedTree as ReturnType<typeof parser.parse> | undefined) ??
      parseSourceSafe(parser, sourceText, undefined, {
        bufferSize: getTreeSitterBufferSize(sourceText),
      });

    for (const fn of tree.rootNode.descendantsOfType('function_item')) {
      const nameNode = fn.childForFieldName('name');
      const retType = fn.childForFieldName('return_type');
      if (nameNode !== null && retType !== null) {
        const name = nameNode.text;
        if (allReturnTypes.has(name)) {
          allReturnTypes.delete(name);
        } else {
          allReturnTypes.set(name, retType.text);
        }
      }
    }

    for (const structNode of tree.rootNode.descendantsOfType('struct_item')) {
      const nameNode = structNode.childForFieldName('name');
      const body = structNode.childForFieldName('body');
      if (nameNode === null || body === null) continue;
      const fields = new Map<string, string>();
      for (const field of body.descendantsOfType('field_declaration')) {
        const fieldName = field.childForFieldName('name');
        const fieldType = field.childForFieldName('type');
        if (fieldName !== null && fieldType !== null) {
          fields.set(fieldName.text, normalizeFieldType(fieldType.text));
        }
      }
      if (fields.size > 0) {
        const name = nameNode.text;
        if (allFieldTypes.has(name)) {
          allFieldTypes.delete(name);
        } else {
          allFieldTypes.set(name, fields);
        }
      }
    }
  }

  for (const parsed of parsedFiles) {
    const sourceText = ctx.fileContents.get(parsed.filePath);
    if (sourceText === undefined) continue;

    const cachedTree = ctx.treeCache?.get(parsed.filePath);
    const tree =
      (cachedTree as ReturnType<typeof parser.parse> | undefined) ??
      parseSourceSafe(parser, sourceText, undefined, {
        bufferSize: getTreeSitterBufferSize(sourceText),
      });

    const scopeMap = new Map(parsed.scopes.map((s) => [s.id, s]));
    const moduleScope = parsed.scopes.find((s) => s.kind === 'Module');
    if (moduleScope === undefined) continue;

    processFieldTypeBindings(tree.rootNode, parsed, scopeMap);
    processIdentityMethodBindings(parsed);
    processForLoops(tree.rootNode, parsed, scopeMap, moduleScope, allReturnTypes);
    processPatternBindings(tree.rootNode, parsed, scopeMap, moduleScope);
    processStructDestructuring(tree.rootNode, parsed, scopeMap, moduleScope, allFieldTypes);
    processPendingAssignments(
      tree.rootNode,
      parsed,
      parsedFiles,
      scopeMap,
      moduleScope,
      allReturnTypes,
    );
  }
}

function processFieldTypeBindings(
  root: SyntaxNode,
  parsed: ParsedFile,
  scopeMap: ReadonlyMap<string, Scope>,
): void {
  for (const structNode of root.descendantsOfType('struct_item')) {
    const nameNode = structNode.childForFieldName('name');
    if (nameNode === null) continue;

    const structScope = findScopeForNode(structNode, parsed, scopeMap);
    if (structScope === null) continue;

    const body = structNode.childForFieldName('body');
    if (body === null) continue;

    for (const field of body.descendantsOfType('field_declaration')) {
      const fieldName = field.childForFieldName('name');
      const fieldType = field.childForFieldName('type');
      if (fieldName === null || fieldType === null) continue;

      const normalizedType = normalizeFieldType(fieldType.text);
      injectTypeBinding(structScope, fieldName.text, normalizedType);
    }
  }
}

function findScopeForNode(
  node: SyntaxNode,
  parsed: ParsedFile,
  scopeMap: ReadonlyMap<string, Scope>,
): Scope | null {
  for (const scope of parsed.scopes) {
    if (
      scope.kind === 'Class' &&
      scope.range.startLine === node.startPosition.row + 1 &&
      scope.range.startCol === node.startPosition.column
    ) {
      return scope;
    }
  }
  return null;
}

function normalizeFieldType(text: string): string {
  let t = text.trim();
  if (t.startsWith('&')) t = t.replace(/^&\s*(mut\s+)?/, '');
  const bracket = t.indexOf('<');
  if (bracket !== -1) t = t.slice(0, bracket);
  const lastColon = t.lastIndexOf('::');
  if (lastColon !== -1) t = t.slice(lastColon + 2);
  return t.trim();
}

function processForLoops(
  root: SyntaxNode,
  parsed: ParsedFile,
  scopeMap: ReadonlyMap<string, Scope>,
  moduleScope: Scope,
  allReturnTypes: ReadonlyMap<string, string>,
): void {
  for (const forNode of root.descendantsOfType('for_expression')) {
    const patternNode = forNode.childForFieldName('pattern');
    const valueNode = forNode.childForFieldName('value');
    if (patternNode === null || valueNode === null) continue;

    const varName = extractVarName(patternNode);
    if (varName === null) continue;

    const elementType = resolveIterableElementType(
      valueNode,
      parsed,
      scopeMap,
      moduleScope,
      allReturnTypes,
    );
    if (elementType === null) continue;

    const targetScope = findEnclosingFunctionScope(forNode, scopeMap) ?? moduleScope;
    injectTypeBinding(targetScope, varName, elementType);
  }
}

function processPatternBindings(
  root: SyntaxNode,
  parsed: ParsedFile,
  scopeMap: ReadonlyMap<string, Scope>,
  moduleScope: Scope,
): void {
  for (const nodeType of ['let_condition', 'match_arm'] as const) {
    for (const node of root.descendantsOfType(nodeType)) {
      const patternNode =
        nodeType === 'let_condition'
          ? node.childForFieldName('pattern')
          : (node.childForFieldName('pattern')?.firstNamedChild ?? null);
      if (patternNode === null) continue;

      if (patternNode.type === 'captured_pattern') {
        processCapturedPattern(patternNode, node, parsed, scopeMap, moduleScope);
        continue;
      }

      if (patternNode.type === 'tuple_struct_pattern') {
        processTupleStructPattern(patternNode, node, parsed, scopeMap, moduleScope);
      }
    }
  }
}

function processCapturedPattern(
  patternNode: SyntaxNode,
  contextNode: SyntaxNode,
  _parsed: ParsedFile,
  scopeMap: ReadonlyMap<string, Scope>,
  moduleScope: Scope,
): void {
  const varNode = patternNode.namedChildren.find((c) => c.type === 'identifier');
  const structPatternNode = patternNode.namedChildren.find((c) => c.type === 'struct_pattern');
  if (varNode === undefined || structPatternNode === undefined) return;

  const typeName = structPatternNode.childForFieldName('type')?.text;
  if (typeName === undefined) return;

  const targetScope = findEnclosingFunctionScope(contextNode, scopeMap) ?? moduleScope;
  injectTypeBinding(targetScope, varNode.text, typeName);
}

function processTupleStructPattern(
  patternNode: SyntaxNode,
  contextNode: SyntaxNode,
  parsed: ParsedFile,
  scopeMap: ReadonlyMap<string, Scope>,
  moduleScope: Scope,
): void {
  const wrapperNode = patternNode.childForFieldName('type');
  if (wrapperNode === null) return;
  const wrapper = wrapperNode.text;

  const wrapperIdx = patternNode.namedChildren.indexOf(wrapperNode);
  const innerIdent = patternNode.namedChildren.find(
    (c, i) => i > wrapperIdx && c.type === 'identifier',
  );
  if (innerIdent === null || innerIdent === undefined) return;
  const varName = innerIdent.text;

  let sourceVarNode: SyntaxNode | null = null;
  if (contextNode.type === 'let_condition') {
    sourceVarNode = contextNode.childForFieldName('value');
  } else {
    let matchExpr: SyntaxNode | null = contextNode.parent;
    while (matchExpr !== null && matchExpr.type !== 'match_expression') {
      matchExpr = matchExpr.parent;
    }
    sourceVarNode = matchExpr?.childForFieldName('value') ?? null;
  }
  if (sourceVarNode === null || sourceVarNode === undefined) return;

  const sourceVarName = sourceVarNode.type === 'identifier' ? sourceVarNode.text : null;
  if (sourceVarName === null) return;

  const sourceType = lookupTypeInScopes(sourceVarName, contextNode, parsed, scopeMap, moduleScope);
  if (sourceType === null) return;

  let resolvedType: string | null = null;

  if (wrapper === 'Some') {
    resolvedType = unwrapGeneric(sourceType);
  } else if (wrapper === 'Ok' || wrapper === 'Err') {
    const rawType = lookupRawParameterType(sourceVarName, contextNode);
    if (rawType !== null) {
      const argIdx = wrapper === 'Ok' ? 0 : 1;
      resolvedType = extractNthGenericArg(rawType, argIdx);
    }
    if (resolvedType === null) {
      resolvedType = wrapper === 'Ok' ? unwrapGeneric(sourceType) : null;
    }
  }

  if (resolvedType === null) return;

  const targetScope = findEnclosingFunctionScope(contextNode, scopeMap) ?? moduleScope;
  injectTypeBinding(targetScope, varName, resolvedType);
}

function processStructDestructuring(
  root: SyntaxNode,
  parsed: ParsedFile,
  scopeMap: ReadonlyMap<string, Scope>,
  moduleScope: Scope,
  allFieldTypes?: ReadonlyMap<string, Map<string, string>>,
): void {
  for (const letNode of root.descendantsOfType('let_declaration')) {
    const patternNode = letNode.childForFieldName('pattern');
    if (patternNode === null || patternNode.type !== 'struct_pattern') continue;

    const typeName = patternNode.childForFieldName('type')?.text;
    if (typeName === undefined) continue;

    const valueNode = letNode.childForFieldName('value');
    if (valueNode === null) continue;

    const targetScope = findEnclosingFunctionScope(letNode, scopeMap) ?? moduleScope;

    for (const fieldNode of patternNode.namedChildren) {
      let fieldName: string | undefined;
      if (fieldNode.type === 'field_pattern') {
        fieldName = fieldNode.childForFieldName('name')?.text;
      } else if (fieldNode.type === 'shorthand_field_pattern') {
        fieldName = fieldNode.firstNamedChild?.text;
      }
      if (fieldName === undefined) continue;

      let fieldType = lookupFieldType(typeName, fieldName, parsed, scopeMap, moduleScope);
      if (fieldType === null) {
        fieldType = allFieldTypes?.get(typeName)?.get(fieldName) ?? null;
      }
      if (fieldType !== null) {
        injectTypeBinding(targetScope, fieldName, fieldType);
      }
    }
  }
}

const IDENTITY_METHODS = ['unwrap', 'expect', 'clone', 'as_ref', 'as_mut'];

function processIdentityMethodBindings(parsed: ParsedFile): void {
  for (const scope of parsed.scopes) {
    if (scope.kind !== 'Class') continue;
    const classDef = scope.ownedDefs.find((d) => {
      const t = d.type;
      return t === 'Struct' || t === 'Enum' || t === 'Class';
    });
    if (classDef === undefined) continue;
    const name = classDef.qualifiedName?.split('.').pop();
    if (name === undefined) continue;

    for (const method of IDENTITY_METHODS) {
      if (!scope.typeBindings.has(method)) {
        (scope.typeBindings as Map<string, TypeRef>).set(method, {
          rawName: name,
          declaredAtScope: scope.id,
          source: 'return-annotation',
        });
      }
    }
  }
}

function processPendingAssignments(
  root: SyntaxNode,
  parsed: ParsedFile,
  allParsedFiles: readonly ParsedFile[],
  scopeMap: ReadonlyMap<string, Scope>,
  moduleScope: Scope,
  allReturnTypes: ReadonlyMap<string, string>,
): void {
  for (let pass = 0; pass < 3; pass++) {
    for (const letNode of root.descendantsOfType('let_declaration')) {
      const patternNode = letNode.childForFieldName('pattern');
      if (patternNode === null) continue;
      const varName = extractVarName(patternNode);
      if (varName === null) continue;

      const targetScope = findEnclosingFunctionScope(letNode, scopeMap) ?? moduleScope;
      if (targetScope.typeBindings.has(varName)) continue;

      const valueNode = letNode.childForFieldName('value');
      if (valueNode === null) continue;

      if (valueNode.type === 'identifier') {
        const rhsType = lookupTypeInScopes(valueNode.text, letNode, parsed, scopeMap, moduleScope);
        if (rhsType !== null) {
          injectTypeBinding(targetScope, varName, rhsType);
          continue;
        }
      }

      if (valueNode.type === 'field_expression') {
        const receiver = valueNode.childForFieldName('value');
        const field = valueNode.childForFieldName('field');
        if (receiver !== null && field !== null && receiver.type === 'identifier') {
          const receiverType = lookupTypeInScopes(
            receiver.text,
            letNode,
            parsed,
            scopeMap,
            moduleScope,
          );
          if (receiverType !== null) {
            const fieldType = findFieldTypeAcrossFiles(receiverType, field.text, allParsedFiles);
            if (fieldType !== null) {
              injectTypeBinding(targetScope, varName, fieldType);
            }
          }
        }
      }

      if (valueNode.type === 'call_expression') {
        const func = valueNode.childForFieldName('function');
        if (func !== null && func.type === 'field_expression') {
          const receiver = func.childForFieldName('value');
          const method = func.childForFieldName('field');
          if (receiver !== null && method !== null && receiver.type === 'identifier') {
            const receiverType = lookupTypeInScopes(
              receiver.text,
              letNode,
              parsed,
              scopeMap,
              moduleScope,
            );
            if (receiverType !== null) {
              const retType = findMethodReturnTypeAcrossFiles(
                receiverType,
                method.text,
                allParsedFiles,
              );
              if (retType !== null) {
                injectTypeBinding(targetScope, varName, retType);
              }
            }
          }
        }

        if (func !== null && func.type === 'identifier') {
          const rawReturn = allReturnTypes.get(func.text);
          if (rawReturn !== undefined) {
            injectTypeBinding(targetScope, varName, normalizeFieldType(rawReturn));
          }
        }
      }
    }
  }
}

function resolveIterableElementType(
  valueNode: SyntaxNode,
  parsed: ParsedFile,
  scopeMap: ReadonlyMap<string, Scope>,
  moduleScope: Scope,
  allReturnTypes?: ReadonlyMap<string, string>,
): string | null {
  let iterableNode = valueNode;
  if (iterableNode.type === 'reference_expression') {
    iterableNode = iterableNode.firstNamedChild ?? iterableNode;
  }

  if (iterableNode.type === 'identifier') {
    const rawType = lookupTypeInScopes(iterableNode.text, valueNode, parsed, scopeMap, moduleScope);
    if (rawType !== null) return unwrapGeneric(rawType);
  }

  if (iterableNode.type === 'call_expression') {
    const func = iterableNode.childForFieldName('function');
    if (func === null) return null;

    if (func.type === 'field_expression') {
      const receiver = func.childForFieldName('value');
      if (receiver !== null && receiver.type === 'identifier') {
        const rawType = lookupTypeInScopes(receiver.text, valueNode, parsed, scopeMap, moduleScope);
        if (rawType !== null) return unwrapGeneric(rawType);
      }
    }

    if (func.type === 'identifier') {
      const crossFileReturn = allReturnTypes?.get(func.text);
      if (crossFileReturn !== undefined) return unwrapGeneric(crossFileReturn);
      const rawReturn = lookupRawFunctionReturnType(func.text, valueNode);
      if (rawReturn !== null) return unwrapGeneric(rawReturn);
      const returnType = lookupReturnTypeInScopes(func.text, parsed, scopeMap, moduleScope);
      if (returnType !== null) return unwrapGeneric(returnType);
    }
  }

  return null;
}

function findFieldTypeAcrossFiles(
  structName: string,
  fieldName: string,
  allParsedFiles: readonly ParsedFile[],
): string | null {
  for (const pf of allParsedFiles) {
    for (const scope of pf.scopes) {
      if (scope.kind !== 'Class') continue;
      const hasDef = scope.ownedDefs.some(
        (d) => d.qualifiedName === structName || d.qualifiedName?.endsWith('.' + structName),
      );
      if (!hasDef) continue;
      const tb = scope.typeBindings.get(fieldName);
      if (tb !== undefined) return tb.rawName;
    }
  }
  return null;
}

function findMethodReturnTypeAcrossFiles(
  structName: string,
  methodName: string,
  allParsedFiles: readonly ParsedFile[],
): string | null {
  for (const pf of allParsedFiles) {
    for (const scope of pf.scopes) {
      if (scope.kind !== 'Class') continue;
      const hasDef = scope.ownedDefs.some(
        (d) => d.qualifiedName === structName || d.qualifiedName?.endsWith('.' + structName),
      );
      if (!hasDef) continue;
      const tb = scope.typeBindings.get(methodName);
      if (tb !== undefined && tb.source === 'return-annotation') return tb.rawName;
    }
  }
  return null;
}

function lookupRawFunctionReturnType(funcName: string, contextNode: SyntaxNode): string | null {
  let root: SyntaxNode = contextNode;
  while (root.parent !== null) root = root.parent;
  for (const fn of root.descendantsOfType('function_item')) {
    const nameNode = fn.childForFieldName('name');
    if (nameNode !== null && nameNode.text === funcName) {
      const retType = fn.childForFieldName('return_type');
      if (retType !== null) return retType.text;
    }
  }
  return null;
}

function lookupRawParameterType(paramName: string, contextNode: SyntaxNode): string | null {
  let current: SyntaxNode | null = contextNode;
  while (current !== null) {
    if (current.type === 'function_item') {
      const params = current.childForFieldName('parameters');
      if (params !== null) {
        for (let i = 0; i < params.namedChildCount; i++) {
          const param = params.namedChild(i);
          if (param === null || param.type !== 'parameter') continue;
          const pattern = param.childForFieldName('pattern');
          const typeNode = param.childForFieldName('type');
          if (pattern !== null && typeNode !== null && pattern.text === paramName) {
            return typeNode.text;
          }
        }
      }
      break;
    }
    current = current.parent;
  }
  return null;
}

function lookupTypeInScopes(
  name: string,
  contextNode: SyntaxNode,
  parsed: ParsedFile,
  scopeMap: ReadonlyMap<string, Scope>,
  moduleScope: Scope,
): string | null {
  const fnScope = findEnclosingFunctionScope(contextNode, scopeMap);
  if (fnScope !== null) {
    const tb = fnScope.typeBindings.get(name);
    if (tb !== undefined) return tb.rawName;
  }

  const mtb = moduleScope.typeBindings.get(name);
  if (mtb !== undefined) return mtb.rawName;

  return null;
}

function lookupReturnTypeInScopes(
  funcName: string,
  parsed: ParsedFile,
  _scopeMap: ReadonlyMap<string, Scope>,
  moduleScope: Scope,
): string | null {
  const tb = moduleScope.typeBindings.get(funcName);
  if (tb !== undefined && tb.source === 'return-annotation') return tb.rawName;

  for (const scope of parsed.scopes) {
    const stb = scope.typeBindings.get(funcName);
    if (stb !== undefined && stb.source === 'return-annotation') return stb.rawName;
  }

  return null;
}

function lookupFieldType(
  structName: string,
  fieldName: string,
  parsed: ParsedFile,
  _scopeMap: ReadonlyMap<string, Scope>,
  _moduleScope: Scope,
): string | null {
  for (const scope of parsed.scopes) {
    if (scope.kind !== 'Class') continue;
    const hasDef = scope.ownedDefs.some(
      (d) => d.qualifiedName === structName || d.qualifiedName?.endsWith('.' + structName),
    );
    if (!hasDef) continue;

    const tb = scope.typeBindings.get(fieldName);
    if (tb !== undefined) return tb.rawName;

    for (const def of scope.ownedDefs) {
      const defName = def.qualifiedName?.split('.').pop();
      if (def.type === 'Property' && defName === fieldName) {
        const tb = scope.typeBindings.get(fieldName);
        if (tb !== undefined) return tb.rawName;
      }
    }
  }
  return null;
}

function unwrapGeneric(rawType: string): string {
  const match = rawType.match(/^(?:Vec|Option|Arc|Rc|Box|Mutex|RwLock|RefCell|Cell)<(.+)>$/);
  if (match) {
    const inner = match[1].trim();
    const comma = findTopLevelComma(inner);
    return comma === -1 ? inner : inner.slice(0, comma).trim();
  }
  if (rawType.startsWith('&[') && rawType.endsWith(']')) {
    return rawType.slice(2, -1).trim();
  }
  return rawType;
}

function extractNthGenericArg(rawType: string, n: number): string | null {
  const open = rawType.indexOf('<');
  if (open === -1) return null;
  const close = rawType.lastIndexOf('>');
  if (close === -1) return null;
  const inner = rawType.slice(open + 1, close).trim();
  const args = splitTopLevelComma(inner);
  return n < args.length ? args[n].trim() : null;
}

function splitTopLevelComma(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '<') depth++;
    else if (text[i] === '>') depth--;
    else if (text[i] === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function findTopLevelComma(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '<') depth++;
    else if (text[i] === '>') depth--;
    else if (text[i] === ',' && depth === 0) return i;
  }
  return -1;
}

function extractVarName(node: SyntaxNode): string | null {
  if (node.type === 'identifier') return node.text;
  if (node.type === 'mut_pattern' || node.type === 'reference_pattern') {
    return node.firstNamedChild?.text ?? null;
  }
  return null;
}

function injectTypeBinding(scope: Scope, name: string, typeName: string): void {
  if (scope.typeBindings.has(name)) return;
  (scope.typeBindings as Map<string, TypeRef>).set(name, {
    rawName: typeName,
    declaredAtScope: scope.id,
    source: 'annotation',
  });
}

function findEnclosingFunctionScope(
  node: SyntaxNode,
  scopeMap: ReadonlyMap<ScopeId, Scope>,
): Scope | null {
  let current: SyntaxNode | null = node as SyntaxNode;
  while (current !== null) {
    if (current.type === 'function_item') {
      for (const scope of scopeMap.values()) {
        if (
          scope.kind === 'Function' &&
          scope.range.startLine === current.startPosition.row + 1 &&
          scope.range.startCol === current.startPosition.column
        ) {
          return scope;
        }
      }
      break;
    }
    current = current.parent;
  }
  return null;
}
