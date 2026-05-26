import type { Capture, CaptureMatch } from 'gitnexus-shared';
import {
  findNodeAtRange,
  nodeToCapture,
  syntheticCapture,
  type SyntaxNode,
} from '../../utils/ast-helpers.js';
import { getRubyParser, getRubyScopeQuery } from './query.js';
import { recordRubyCacheHit, recordRubyCacheMiss } from './cache-stats.js';
import { synthesizeRubyReceiverBinding, findEnclosingClassOrModule } from './receiver-binding.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';

const FUNCTION_NODE_TYPES = ['method', 'singleton_method'] as const;
const HERITAGE_CALL_NAMES: ReadonlySet<string> = new Set(['include', 'extend', 'prepend']);
const ATTR_CALL_NAMES: ReadonlySet<string> = new Set([
  'attr_accessor',
  'attr_reader',
  'attr_writer',
]);

export function emitRubyScopeCaptures(
  sourceText: string,
  _filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  let tree = cachedTree as ReturnType<ReturnType<typeof getRubyParser>['parse']> | undefined;
  if (tree === undefined) {
    try {
      tree = parseSourceSafe(getRubyParser(), sourceText, undefined, {
        bufferSize: getTreeSitterBufferSize(sourceText),
      });
    } catch (err) {
      throw scopeExtractionError('parse', _filePath, err);
    }
    recordRubyCacheMiss();
  } else {
    recordRubyCacheHit();
  }

  let rawMatches: ReturnType<ReturnType<typeof getRubyScopeQuery>['matches']>;
  try {
    rawMatches = getRubyScopeQuery().matches(tree.rootNode);
  } catch (err) {
    throw scopeExtractionError('scope query', _filePath, err);
  }

  const out: CaptureMatch[] = [];

  for (const m of rawMatches) {
    const grouped: Record<string, Capture> = {};
    for (const c of m.captures) {
      const tag = '@' + c.name;
      if (tag.startsWith('@_')) continue;
      grouped[tag] = nodeToCapture(tag, c.node);
    }
    if (Object.keys(grouped).length === 0) continue;

    // Decompose require/require_relative/load into import captures
    if (grouped['@import.statement'] !== undefined) {
      const anchor = grouped['@import.statement']!;
      const callNode = findNodeAtRange(tree.rootNode, anchor.range, 'call');
      if (callNode !== null) {
        const decomposed = decomposeRubyImport(callNode, anchor);
        if (decomposed !== null) {
          out.push(decomposed);
          continue;
        }
      }
      out.push(grouped);
      continue;
    }

    // Synthesize self receiver bindings for methods inside class/module
    if (grouped['@scope.function'] !== undefined) {
      const scopeCap = grouped['@scope.function']!;
      const fnNode = findFunctionNode(tree.rootNode, scopeCap.range);
      if (fnNode !== null) {
        const enclosingNode = findEnclosingClassOrModule(fnNode);
        const receiver = synthesizeRubyReceiverBinding(fnNode, enclosingNode);
        if (receiver !== null) out.push(receiver);
      }
      out.push(grouped);
      continue;
    }

    // Reclassify declaration.function as declaration.method + attach arity
    if (grouped['@declaration.function'] !== undefined) {
      const anchorCap = grouped['@declaration.function']!;
      const fnNode = findFunctionNode(tree.rootNode, anchorCap.range);
      if (fnNode !== null) {
        const enclosingNode = findEnclosingClassOrModule(fnNode);
        if (enclosingNode !== null) {
          const nameCap = grouped['@declaration.name'];
          delete (grouped as Record<string, Capture | undefined>)['@declaration.function'];
          grouped['@declaration.method'] = syntheticCapture(
            '@declaration.method',
            fnNode,
            fnNode.text,
          );
          if (nameCap !== undefined) {
            grouped['@declaration.name'] = nameCap;
          }
        }

        const arity = computeRubyDeclarationArity(fnNode);
        if (arity.parameterCount !== undefined) {
          grouped['@declaration.parameter-count'] = syntheticCapture(
            '@declaration.parameter-count',
            fnNode,
            String(arity.parameterCount),
          );
        }
        if (arity.requiredParameterCount !== undefined) {
          grouped['@declaration.required-parameter-count'] = syntheticCapture(
            '@declaration.required-parameter-count',
            fnNode,
            String(arity.requiredParameterCount),
          );
        }
        if (arity.parameterTypes !== undefined) {
          grouped['@declaration.parameter-types'] = syntheticCapture(
            '@declaration.parameter-types',
            fnNode,
            JSON.stringify(arity.parameterTypes),
          );
        }
      }
      out.push(grouped);
      continue;
    }

    // Intercept heritage calls (include/extend/prepend) — encode as
    // special imports so emitHeritageEdges can emit IMPLEMENTS edges.
    if (grouped['@reference.call.free'] !== undefined && grouped['@reference.name'] !== undefined) {
      const callName = grouped['@reference.name']!.text;
      if (HERITAGE_CALL_NAMES.has(callName)) {
        const callNode = findNodeAtRange(
          tree.rootNode,
          grouped['@reference.call.free']!.range,
          'call',
        );
        if (callNode !== null) {
          const enclosing = findEnclosingClassOrModule(callNode);
          const ownerName = enclosing?.childForFieldName('name')?.text;
          if (ownerName) {
            const argList = callNode.childForFieldName('arguments');
            if (argList !== null) {
              for (let ai = 0; ai < argList.namedChildCount; ai++) {
                const arg = argList.namedChild(ai);
                if (arg !== null && (arg.type === 'constant' || arg.type === 'scope_resolution')) {
                  out.push({
                    '@import.statement': grouped['@reference.call.free']!,
                    '@import.kind': syntheticCapture('@import.kind', callNode, 'namespace'),
                    '@import.source': syntheticCapture(
                      '@import.source',
                      callNode,
                      `__heritage__:${callName}:${arg.text}:${ownerName}`,
                    ),
                    '@import.name': syntheticCapture('@import.name', callNode, arg.text),
                  });
                }
              }
            }
          }
        }
        continue;
      }

      // Intercept attr_accessor/attr_reader/attr_writer — encode as special
      // imports so emitHeritageEdges can create Property nodes + HAS_PROPERTY.
      if (ATTR_CALL_NAMES.has(callName)) {
        const callNode = findNodeAtRange(
          tree.rootNode,
          grouped['@reference.call.free']!.range,
          'call',
        );
        if (callNode !== null) {
          const enclosing = findEnclosingClassOrModule(callNode);
          const ownerName = enclosing?.childForFieldName('name')?.text;
          if (ownerName) {
            const argList = callNode.childForFieldName('arguments');
            if (argList !== null) {
              for (let ai = 0; ai < argList.namedChildCount; ai++) {
                const arg = argList.namedChild(ai);
                if (arg !== null && (arg.type === 'simple_symbol' || arg.type === 'symbol')) {
                  const propName = arg.text.replace(/^:/, '');
                  out.push({
                    '@import.statement': grouped['@reference.call.free']!,
                    '@import.kind': syntheticCapture('@import.kind', callNode, 'namespace'),
                    '@import.source': syntheticCapture(
                      '@import.source',
                      callNode,
                      `__property__:${callName}:${propName}:${ownerName}`,
                    ),
                    '@import.name': syntheticCapture('@import.name', callNode, propName),
                  });
                }
              }
            }
          }
        }
        continue;
      }
    }

    // Attach call arity for call expressions
    const callTag = (['@reference.call.free', '@reference.call.member'] as const).find(
      (t) => grouped[t] !== undefined,
    );
    if (callTag !== undefined && grouped['@reference.arity'] === undefined) {
      const anchor = grouped[callTag]!;
      const callNode = findNodeAtRange(tree.rootNode, anchor.range, 'call');
      if (callNode !== null) {
        const arity = computeRubyCallArity(callNode);
        grouped['@reference.arity'] = syntheticCapture('@reference.arity', callNode, String(arity));
      }
    }

    out.push(grouped);
  }

  // Second pass: YARD comment annotations (@param, @return, @type)
  for (const comment of tree.rootNode.descendantsOfType('comment')) {
    const text = comment.text;

    // @param name [Type]
    const paramMatch = text.match(/@param\s+(\w+)\s+\[([^\]]+)\]/);
    if (paramMatch) {
      const [, paramName, typeName] = paramMatch;
      const methodNode = findFollowingMethod(comment);
      if (methodNode !== null && paramName && typeName) {
        out.push({
          '@type-binding.parameter': syntheticCapture('@type-binding.parameter', methodNode, text),
          '@type-binding.name': syntheticCapture('@type-binding.name', methodNode, paramName),
          '@type-binding.type': syntheticCapture(
            '@type-binding.type',
            methodNode,
            normalizeYardType(typeName),
          ),
        });
      }
    }

    // @param [Type] name (alternate YARD order)
    const paramAltMatch = text.match(/@param\s+\[([^\]]+)\]\s+(\w+)/);
    if (!paramMatch && paramAltMatch) {
      const [, typeName, paramName] = paramAltMatch;
      const methodNode = findFollowingMethod(comment);
      if (methodNode !== null && paramName && typeName) {
        out.push({
          '@type-binding.parameter': syntheticCapture('@type-binding.parameter', methodNode, text),
          '@type-binding.name': syntheticCapture('@type-binding.name', methodNode, paramName),
          '@type-binding.type': syntheticCapture(
            '@type-binding.type',
            methodNode,
            normalizeYardType(typeName),
          ),
        });
      }
    }

    // @return [Type]
    const returnMatch = text.match(/@return\s+\[([^\]]+)\]/);
    if (returnMatch) {
      const [, typeName] = returnMatch;
      const methodNode = findFollowingMethod(comment);
      if (methodNode !== null && typeName) {
        const methodName = methodNode.childForFieldName('name')?.text;
        if (methodName) {
          out.push({
            '@type-binding.return': syntheticCapture('@type-binding.return', methodNode, text),
            '@type-binding.name': syntheticCapture('@type-binding.name', methodNode, methodName),
            '@type-binding.type': syntheticCapture(
              '@type-binding.type',
              methodNode,
              normalizeYardType(typeName),
            ),
          });
        }
      }
    }

    // @type [Type]
    const typeMatch = text.match(/@type\s+\[([^\]]+)\]/);
    if (typeMatch) {
      const [, typeName] = typeMatch;
      const methodNode = findFollowingMethod(comment);
      if (methodNode !== null && typeName) {
        out.push({
          '@type-binding.parameter': syntheticCapture('@type-binding.parameter', methodNode, text),
          '@type-binding.name': syntheticCapture('@type-binding.name', methodNode, ''),
          '@type-binding.type': syntheticCapture(
            '@type-binding.type',
            methodNode,
            normalizeYardType(typeName),
          ),
        });
      }
    }
  }

  return out;
}

function decomposeRubyImport(callNode: SyntaxNode, anchor: Capture): CaptureMatch | null {
  const methodNode = callNode.childForFieldName('method');
  if (methodNode === null) return null;
  const methodName = methodNode.text;
  if (methodName !== 'require' && methodName !== 'require_relative' && methodName !== 'load') {
    return null;
  }

  const argsNode = callNode.childForFieldName('arguments');
  const argNode = argsNode !== null ? argsNode.namedChild(0) : callNode.namedChild(1);
  if (argNode === null) return null;

  let sourcePath: string;
  if (argNode.type === 'string') {
    const contentChild = argNode.namedChild(0);
    sourcePath =
      contentChild !== null && contentChild.type === 'string_content'
        ? contentChild.text
        : argNode.text.replace(/^['"]|['"]$/g, '');
  } else {
    return null;
  }

  if (sourcePath === '') return null;

  const segments = sourcePath.replace(/\\/g, '/').split('/');
  const lastSegment = segments[segments.length - 1]!;
  const moduleName = lastSegment.replace(/\.rb$/, '');

  return {
    '@import.statement': anchor,
    '@import.kind': syntheticCapture('@import.kind', callNode, 'wildcard'),
    '@import.source': syntheticCapture('@import.source', callNode, sourcePath),
    '@import.name': syntheticCapture('@import.name', callNode, moduleName),
  };
}

function computeRubyDeclarationArity(fnNode: SyntaxNode): {
  parameterCount?: number;
  requiredParameterCount?: number;
  parameterTypes?: string[];
} {
  const params = fnNode.childForFieldName('parameters');
  if (params === null) return { parameterCount: 0, requiredParameterCount: 0 };

  let totalCount = 0;
  let requiredCount = 0;
  const paramTypes: string[] = [];

  for (let i = 0; i < params.namedChildCount; i++) {
    const child = params.namedChild(i);
    if (child === null) continue;

    switch (child.type) {
      case 'identifier':
        totalCount++;
        requiredCount++;
        paramTypes.push('');
        break;
      case 'optional_parameter':
        totalCount++;
        paramTypes.push('');
        break;
      case 'splat_parameter':
        totalCount++;
        paramTypes.push('*args');
        break;
      case 'hash_splat_parameter':
        totalCount++;
        paramTypes.push('**kwargs');
        break;
      case 'block_parameter':
        // &block not counted in arity
        break;
      case 'keyword_parameter': {
        totalCount++;
        const hasDefault = child.childForFieldName('value') !== null;
        if (!hasDefault) requiredCount++;
        paramTypes.push('');
        break;
      }
      default:
        totalCount++;
        requiredCount++;
        paramTypes.push('');
        break;
    }
  }

  return {
    parameterCount: totalCount,
    requiredParameterCount: requiredCount,
    parameterTypes: paramTypes.length > 0 ? paramTypes : undefined,
  };
}

function computeRubyCallArity(callNode: SyntaxNode): number {
  const argList = callNode.childForFieldName('arguments');
  if (argList === null) return 0;

  let count = 0;
  for (let i = 0; i < argList.namedChildCount; i++) {
    const child = argList.namedChild(i);
    if (child !== null && child.type !== 'block') count++;
  }
  return count;
}

function findFunctionNode(rootNode: SyntaxNode, range: Capture['range']): SyntaxNode | null {
  for (const nodeType of FUNCTION_NODE_TYPES) {
    const n = findNodeAtRange(rootNode, range, nodeType);
    if (n !== null) return n;
  }
  return null;
}

function scopeExtractionError(stage: string, filePath: string, err: unknown): Error {
  const reason = err instanceof Error ? err.message : String(err);
  return new Error(
    `[ruby] tree-sitter ${stage} failed for ${filePath}: ${reason}; skipping scope extraction for this file`,
  );
}

/**
 * Walk forward from a comment node, skipping consecutive comments,
 * and return the next `method` or `singleton_method` node (if any).
 */
function findFollowingMethod(commentNode: SyntaxNode): SyntaxNode | null {
  let sibling = commentNode.nextNamedSibling;
  while (sibling !== null && sibling.type === 'comment') {
    sibling = sibling.nextNamedSibling;
  }
  if (sibling === null) return null;
  if (sibling.type === 'method' || sibling.type === 'singleton_method') return sibling;
  // In tree-sitter-ruby, YARD comments before a method inside a class body
  // are children of `class`, while the method is inside `body_statement`.
  // Walk into body_statement to find the method.
  if (sibling.type === 'body_statement') {
    const first = sibling.firstNamedChild;
    if (first !== null && (first.type === 'method' || first.type === 'singleton_method')) {
      return first;
    }
  }
  return null;
}

/**
 * Normalize a YARD type string: for single-parameter generics like
 * `Array<User>` or `Array[User]` keep the inner type; for multi-param
 * generics like `Hash<Symbol, User>` strip the generic and return the
 * outer type name only.
 */
function normalizeYardType(raw: string): string {
  const trimmed = raw.trim();

  // Check for angle-bracket generics: Type<Inner> or Type<A, B>
  const angleMatch = trimmed.match(/^(\w+)<(.+)>$/);
  if (angleMatch) {
    const inner = angleMatch[2]!;
    // Single-param generic → return the inner type
    if (!inner.includes(',')) return inner.trim();
    // Multi-param generic → return the outer type
    return angleMatch[1]!;
  }

  // Check for bracket generics: Type[Inner]  (YARD sometimes uses this)
  const bracketMatch = trimmed.match(/^(\w+)\[(.+)\]$/);
  if (bracketMatch) {
    const inner = bracketMatch[2]!;
    if (!inner.includes(',')) return inner.trim();
    return bracketMatch[1]!;
  }

  return trimmed;
}
