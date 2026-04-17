/**
 * Extraction-phase helper: derive the canonical node ID of a function/method
 * that lexically encloses an arbitrary AST node, using ONLY the AST plus
 * `LanguageProvider` hooks. No `ResolutionContext`, no SymbolTable, no graph
 * lookup — this is pure extraction.
 *
 * Used by:
 *   - `parse-worker.ts` during call-site / assignment-site extraction (worker
 *     path), to populate `ExtractedCall.sourceId` / `ExtractedAssignment.sourceId`.
 *   - `call-processor.ts` during the sequential call resolution loop, to
 *     compute the same `sourceId` for in-process call extraction. The resolver
 *     does not maintain its own AST-based enclosing-function logic — it
 *     delegates here so the extraction step stays the single source of truth.
 *
 * The constructed ID matches the one produced by the definition phase
 * (qualified name + `#arity` + optional `~typeTag`/`!const`) by reusing the
 * same `MethodExtractor` and tagging utilities.
 *
 * Caches (`classIdCache`, `functionIdCache`, `methodInfoCache`) are per-module
 * so each consumer (worker thread or main thread) gets its own instance.
 * Callers MUST invoke {@link clearEnclosingFunctionCaches} between files to
 * avoid stale `SyntaxNode`/`startIndex` collisions across parses.
 */
import type Parser from 'tree-sitter';
import { generateId } from '../../../lib/utils.js';
import { getLanguageFromFilename } from 'gitnexus-shared';
import type { NodeLabel } from 'gitnexus-shared';
import {
  FUNCTION_NODE_TYPES,
  findEnclosingClassInfo,
  findEnclosingOwnerNode,
  type EnclosingClassInfo,
  genericFuncName,
  inferFunctionLabel,
} from './ast-helpers.js';
import { typeTagForId, constTagForId, buildCollisionGroups } from './method-props.js';
import type { MethodInfo, MethodExtractorContext } from '../method-types.js';
import type { LanguageProvider } from '../language-provider.js';

type SyntaxNode = Parser.SyntaxNode;

// ============================================================================
// Per-module caches — cleared between files via clearEnclosingFunctionCaches().
// ============================================================================

const classIdCache = new Map<SyntaxNode, EnclosingClassInfo | null>();
const functionIdCache = new Map<SyntaxNode, string | null>();
const methodInfoCache = new Map<number, Map<string, MethodInfo>>();

export const clearEnclosingFunctionCaches = (): void => {
  classIdCache.clear();
  functionIdCache.clear();
  methodInfoCache.clear();
};

// ============================================================================
// Helpers shared by the worker path and the sequential path.
// ============================================================================

/**
 * Get (or extract and cache) method info for a class node.
 * Returns a "name:line" → MethodInfo map, or undefined if the provider has no
 * method extractor or the class yielded no methods. Keyed by `name:line` to
 * support overloaded methods (Java/Kotlin).
 */
export function getMethodInfo(
  classNode: SyntaxNode,
  provider: LanguageProvider,
  context: MethodExtractorContext,
): Map<string, MethodInfo> | undefined {
  if (!provider.methodExtractor) return undefined;

  const cacheKey = classNode.startIndex;
  let cached = methodInfoCache.get(cacheKey);
  if (cached) return cached;

  const result = provider.methodExtractor.extract(classNode, context);
  if (!result?.methods?.length) return undefined;

  cached = new Map<string, MethodInfo>();
  for (const method of result.methods) {
    cached.set(`${method.name}:${method.line}`, method);
  }
  methodInfoCache.set(cacheKey, cached);
  return cached;
}

/** Cached wrapper for findEnclosingClassInfo — avoids repeated parent walks. */
export const cachedFindEnclosingClassInfo = (
  node: SyntaxNode,
  filePath: string,
  resolveEnclosingOwner?: (node: SyntaxNode) => SyntaxNode | null,
): EnclosingClassInfo | null => {
  const cached = classIdCache.get(node);
  if (cached !== undefined) return cached;

  const result = findEnclosingClassInfo(node, filePath, resolveEnclosingOwner);
  classIdCache.set(node, result);
  return result;
};

/**
 * Find the C++ class/struct that owns a method whose declarator is a
 * qualified_identifier (`Foo::bar`). Used when `findEnclosingOwnerNode` walks
 * past the class because the method body is defined out-of-class.
 */
export function findClassNodeByQualifiedName(node: SyntaxNode): SyntaxNode | null {
  const declarator = node.childForFieldName('declarator');
  if (!declarator) return null;

  // Find the function_declarator, recursively unwrapping pointer_declarator /
  // reference_declarator chains (e.g. int** Foo::bar() has
  // pointer_declarator → pointer_declarator → function_declarator).
  let funcDecl: SyntaxNode | null = null;
  if (declarator.type === 'function_declarator') {
    funcDecl = declarator;
  } else {
    let current: SyntaxNode | null = declarator;
    while (current && !funcDecl) {
      for (let i = 0; i < current.namedChildCount; i++) {
        const child = current.namedChild(i);
        if (child?.type === 'function_declarator') {
          funcDecl = child;
          break;
        }
      }
      if (!funcDecl) {
        const next = current.namedChildren.find(
          (c) => c.type === 'pointer_declarator' || c.type === 'reference_declarator',
        );
        current = next ?? null;
      }
    }
  }
  if (!funcDecl) return null;

  // Check if the inner declarator is a qualified_identifier (Foo::bar)
  const innerDecl = funcDecl.childForFieldName('declarator');
  if (!innerDecl || innerDecl.type !== 'qualified_identifier') return null;

  const scope = innerDecl.childForFieldName('scope');
  if (!scope) return null;
  const className = scope.text;

  // Search the file for a matching class/struct specifier, including inside
  // namespace_definition blocks (the majority of production C++ uses namespaces).
  const root = node.tree.rootNode;
  const classTypes = new Set(['class_specifier', 'struct_specifier']);
  const searchIn = (parent: SyntaxNode): SyntaxNode | null => {
    for (let i = 0; i < parent.namedChildCount; i++) {
      const child = parent.namedChild(i);
      if (!child) continue;
      if (classTypes.has(child.type)) {
        const nameNode = child.childForFieldName('name');
        if (nameNode?.text === className) return child;
      }
      // Recurse into namespace blocks
      if (child.type === 'namespace_definition') {
        const found = searchIn(child);
        if (found) return found;
      }
    }
    return null;
  };
  return searchIn(root);
}

// ============================================================================
// Enclosing function ID — pure AST extraction.
// ============================================================================

/**
 * Walk up the AST from `node` to find the lexically enclosing function/method
 * and return its `generateId`, or `null` if `node` is at module/file level.
 * Applies `provider.labelOverride` so the constructed label matches the
 * definition phase (single source of truth for IDs).
 *
 * EXTRACTION-ONLY. Does not consult the SymbolTable or any resolution context.
 * The resulting ID is canonical (mirrors definition-phase ID generation
 * including arity and type-tag), so the resolver never needs to do its own
 * AST-based ID construction — it just calls this helper.
 */
export const extractEnclosingFunctionId = (
  node: SyntaxNode,
  filePath: string,
  provider: LanguageProvider,
): string | null => {
  const cached = functionIdCache.get(node);
  if (cached !== undefined) return cached;

  let current = node.parent;
  while (current) {
    if (FUNCTION_NODE_TYPES.has(current.type)) {
      const efnResult = provider.methodExtractor?.extractFunctionName?.(current);
      const funcName = efnResult?.funcName ?? genericFuncName(current);
      const label = efnResult?.label ?? inferFunctionLabel(current.type);
      if (funcName) {
        // Apply labelOverride so label matches definition phase (e.g., Kotlin Function→Method).
        // null means "skip as definition" — keep original label for scope identification.
        let finalLabel = label;
        if (provider.labelOverride) {
          const override = provider.labelOverride(current, label);
          if (override !== null) finalLabel = override;
        }
        // Qualify with enclosing class to match definition-phase node IDs
        const classInfo = cachedFindEnclosingClassInfo(
          current,
          filePath,
          provider.resolveEnclosingOwner,
        );
        const qualifiedName = classInfo ? `${classInfo.className}.${funcName}` : funcName;
        // Include #<arity> suffix to match definition-phase Method/Constructor IDs.
        // Use the same MethodExtractor (getMethodInfo) as the definition phase.
        // When same-arity collisions exist, also append ~type1,type2.
        let arity: number | undefined;
        let encTypeTag = '';
        if (finalLabel === 'Method' || finalLabel === 'Constructor') {
          const encLang = getLanguageFromFilename(filePath);
          const classNode =
            findEnclosingOwnerNode(current) ?? findClassNodeByQualifiedName(current);
          let info: MethodInfo | undefined;
          if (classNode && encLang) {
            const methodMap = getMethodInfo(classNode, provider, {
              filePath,
              language: encLang,
            });
            const defLine = current.startPosition.row + 1;
            info = methodMap?.get(`${funcName}:${defLine}`);
            if (info) {
              arity = info.parameters.some((p) => p.isVariadic)
                ? undefined
                : info.parameters.length;
              if (methodMap && arity !== undefined) {
                const g = buildCollisionGroups(methodMap);
                encTypeTag =
                  typeTagForId(methodMap, funcName, arity, info, encLang, g) +
                  constTagForId(methodMap, funcName, arity, info, g);
              }
            }
          }
          // Fallback: top-level methods without an enclosing class (e.g. Ruby
          // top-level `def`, Go top-level methods). Mirrors definition-phase
          // behavior in parsing-processor.ts where extractFromNode is used
          // when class-based extraction yields nothing.
          if (!info && provider.methodExtractor?.extractFromNode && encLang) {
            const nodeInfo = provider.methodExtractor.extractFromNode(current, {
              filePath,
              language: encLang,
            });
            if (nodeInfo) {
              arity = nodeInfo.parameters.some((p) => p.isVariadic)
                ? undefined
                : nodeInfo.parameters.length;
            }
          }
        }
        const arityTag = arity !== undefined ? `#${arity}${encTypeTag}` : '';
        const result = generateId(finalLabel, `${filePath}:${qualifiedName}${arityTag}`);
        functionIdCache.set(node, result);
        return result;
      }
    }

    // Language-specific enclosing function resolution (e.g., Dart where
    // function_body is a sibling of function_signature, not a child).
    if (provider.enclosingFunctionFinder) {
      const customResult = provider.enclosingFunctionFinder(current);
      if (customResult) {
        let finalLabel: NodeLabel = customResult.label;
        if (provider.labelOverride) {
          const override = provider.labelOverride(current.previousSibling, finalLabel);
          if (override !== null) finalLabel = override;
        }
        // Qualify custom result with enclosing class
        const classInfo = cachedFindEnclosingClassInfo(
          current.previousSibling ?? current,
          filePath,
          provider.resolveEnclosingOwner,
        );
        const qualifiedName = classInfo
          ? `${classInfo.className}.${customResult.funcName}`
          : customResult.funcName;
        // Include #<arity> suffix to match definition-phase Method/Constructor IDs.
        // When same-arity collisions exist, also append ~type1,type2.
        const sigNode = current.previousSibling ?? current;
        let arity2: number | undefined;
        let encTypeTag2 = '';
        if (finalLabel === 'Method' || finalLabel === 'Constructor') {
          const encLang2 = getLanguageFromFilename(filePath);
          const classNode2 =
            findEnclosingOwnerNode(sigNode) ?? findClassNodeByQualifiedName(sigNode);
          let info2: MethodInfo | undefined;
          if (classNode2 && encLang2) {
            const methodMap2 = getMethodInfo(classNode2, provider, {
              filePath,
              language: encLang2,
            });
            const defLine2 = sigNode.startPosition.row + 1;
            info2 = methodMap2?.get(`${customResult.funcName}:${defLine2}`);
            if (info2) {
              arity2 = info2.parameters.some((p) => p.isVariadic)
                ? undefined
                : info2.parameters.length;
              if (methodMap2 && arity2 !== undefined) {
                const g2 = buildCollisionGroups(methodMap2);
                encTypeTag2 =
                  typeTagForId(methodMap2, customResult.funcName, arity2, info2, encLang2, g2) +
                  constTagForId(methodMap2, customResult.funcName, arity2, info2, g2);
              }
            }
          }
          // Fallback for top-level methods without an enclosing class.
          if (!info2 && provider.methodExtractor?.extractFromNode && encLang2) {
            const nodeInfo = provider.methodExtractor.extractFromNode(sigNode, {
              filePath,
              language: encLang2,
            });
            if (nodeInfo) {
              arity2 = nodeInfo.parameters.some((p) => p.isVariadic)
                ? undefined
                : nodeInfo.parameters.length;
            }
          }
        }
        const arityTag2 = arity2 !== undefined ? `#${arity2}${encTypeTag2}` : '';
        const result = generateId(finalLabel, `${filePath}:${qualifiedName}${arityTag2}`);
        functionIdCache.set(node, result);
        return result;
      }
    }

    current = current.parent;
  }
  functionIdCache.set(node, null);
  return null;
};
