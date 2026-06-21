import type { Capture, CaptureMatch } from 'gitnexus-shared';
import {
  findChild,
  nodeIfType,
  nodeToCapture,
  syntheticCapture,
  walkNamedTree,
  type SyntaxNode,
} from '../../utils/ast-helpers.js';
import { getRubyParser, getRubyScopeQuery } from './query.js';
import { recordRubyCacheHit, recordRubyCacheMiss } from './cache-stats.js';
import { synthesizeRubyReceiverBinding, findEnclosingClassOrModule } from './receiver-binding.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import { splitQualifiedName } from '../../utils/qualified-name.js';
import { encodeMarker } from '../../utils/heritage-marker.js';

const FUNCTION_NODE_TYPES = ['method', 'singleton_method'] as const;
const HERITAGE_CALL_NAMES: ReadonlySet<string> = new Set(['include', 'extend', 'prepend']);
const ATTR_CALL_NAMES: ReadonlySet<string> = new Set([
  'attr_accessor',
  'attr_reader',
  'attr_writer',
]);

/**
 * Build the full `.`-joined qualified owner name for a heritage/attr call by
 * walking ALL enclosing class/module ancestors (not just the immediate one),
 * so a same-tail nested owner (`module Outer; class Inner`) is keyed by its
 * full path `Outer.Inner` instead of the bare tail `Inner` — which otherwise
 * collapses both same-tail owners onto one `__heritage__`/`__property__` marker
 * key (last-wins) and cross-wires their mixin / attr_accessor edges (#1982).
 * Handles the compact `class Outer::Inner` form (name is a `scope_resolution`)
 * via the shared normalizer, so the marker owner byte-matches the resolution
 * def's `qualifiedName`. Returns undefined when there is no enclosing class/module.
 */
function buildEnclosingQualifiedName(callNode: SyntaxNode): string | undefined {
  const segments: string[] = [];
  let current: SyntaxNode | null = callNode.parent;
  while (current !== null) {
    if (current.type === 'class' || current.type === 'module') {
      const nameNode = current.childForFieldName('name');
      if (nameNode !== null) segments.unshift(...splitQualifiedName(nameNode.text));
    }
    // Stop at the file root — nothing above `program` contributes a Ruby
    // class/module scope segment (#1982 perf; avoids walking to the very top
    // for every heritage/attr call).
    if (current.type === 'program') break;
    current = current.parent;
  }
  return segments.length > 0 ? segments.join('.') : undefined;
}

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
    // Parallel tag -> captured SyntaxNode map. The query already hands us each
    // matched node as c.node, so anchors are used directly (via nodeIfType)
    // instead of re-deriving them with findNodeAtRange(tree.rootNode, ...) per
    // match — the O(matches x rootChildren) root-walk fixed for go #1915 /
    // python #1918, mirrored here.
    const nodeMap: Record<string, SyntaxNode> = {};
    for (const c of m.captures) {
      const tag = '@' + c.name;
      if (tag.startsWith('@_')) continue;
      grouped[tag] = nodeToCapture(tag, c.node);
      nodeMap[tag] = c.node;
    }
    if (Object.keys(grouped).length === 0) continue;

    // Decompose require/require_relative/load into import captures
    if (grouped['@import.statement'] !== undefined) {
      const anchor = grouped['@import.statement']!;
      const callNode = nodeIfType(nodeMap['@import.statement'], 'call');
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
      const fnNode = nodeIfType(nodeMap['@scope.function'], ...FUNCTION_NODE_TYPES);
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
      const fnNode = nodeIfType(nodeMap['@declaration.function'], ...FUNCTION_NODE_TYPES);
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
        const callNode = nodeIfType(nodeMap['@reference.call.free'], 'call');
        if (callNode !== null) {
          const ownerName = buildEnclosingQualifiedName(callNode);
          if (ownerName) {
            const argList = callNode.childForFieldName('arguments');
            if (argList !== null) {
              for (let ai = 0; ai < argList.namedChildCount; ai++) {
                const arg = argList.namedChild(ai);
                if (arg !== null && (arg.type === 'constant' || arg.type === 'scope_resolution')) {
                  // Normalize a qualified mixin arg (`Outer::Mixin`) to its dotted
                  // form (`Outer.Mixin`) BEFORE embedding it in the ':'-delimited
                  // __heritage__ marker: the raw `::` collides with the marker's `:`
                  // field separator and emitRubyMixinEdges mis-splits it, dropping
                  // the edge (#1982). The dotted form also matches the mixin def's
                  // qualifiedName key for resolution. Simple names are unchanged.
                  const mixinName = splitQualifiedName(arg.text).join('.');
                  out.push({
                    '@import.statement': grouped['@reference.call.free']!,
                    '@import.kind': syntheticCapture('@import.kind', callNode, 'namespace'),
                    '@import.source': syntheticCapture(
                      '@import.source',
                      callNode,
                      encodeMarker('heritage', [callName, mixinName, ownerName]),
                    ),
                    '@import.name': syntheticCapture('@import.name', callNode, mixinName),
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
      // Also emit @declaration.property captures so each property ends up in
      // localDefs and gets reconciled into model.fields, enabling write-access
      // resolution via receiver-bound-calls (Case 4 → findOwnedMember).
      if (ATTR_CALL_NAMES.has(callName)) {
        const callNode = nodeIfType(nodeMap['@reference.call.free'], 'call');
        if (callNode !== null) {
          const ownerName = buildEnclosingQualifiedName(callNode);
          if (ownerName) {
            const argList = callNode.childForFieldName('arguments');
            if (argList !== null) {
              for (let ai = 0; ai < argList.namedChildCount; ai++) {
                const arg = argList.namedChild(ai);
                if (arg !== null && arg.type === 'simple_symbol') {
                  const propName = arg.text.replace(/^:/, '');
                  out.push({
                    '@import.statement': grouped['@reference.call.free']!,
                    '@import.kind': syntheticCapture('@import.kind', callNode, 'namespace'),
                    '@import.source': syntheticCapture(
                      '@import.source',
                      callNode,
                      encodeMarker('property', [callName, propName, ownerName]),
                    ),
                    '@import.name': syntheticCapture('@import.name', callNode, propName),
                  });
                  // Emit a property declaration so the property flows into
                  // localDefs → model.fields for receiver-bound write access.
                  out.push({
                    '@declaration.property': syntheticCapture(
                      '@declaration.property',
                      arg,
                      propName,
                    ),
                    '@declaration.name': syntheticCapture('@declaration.name', arg, propName),
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
      const callNode = nodeIfType(nodeMap[callTag], 'call');
      if (callNode !== null) {
        const arity = computeRubyCallArity(callNode);
        grouped['@reference.arity'] = syntheticCapture('@reference.arity', callNode, String(arity));
      }
    }

    out.push(grouped);
  }

  // Second pass: member-call-return type bindings
  // Synthesize compound type bindings for `x = recv.method(...)` assignments.
  // The query-level @type-binding.call-return pattern only captures free calls
  // (!receiver). For member calls we need `x → recv.method()` so the compound
  // receiver resolver can chain-follow through the receiver's class scope.
  for (const assignNode of tree.rootNode.descendantsOfType('assignment')) {
    const left = assignNode.childForFieldName('left');
    const right = assignNode.childForFieldName('right');
    if (left === null || right === null) continue;
    if (left.type !== 'identifier' && left.type !== 'constant') continue;
    if (right.type !== 'call') continue;
    const recvNode = right.childForFieldName('receiver');
    const methodNode = right.childForFieldName('method');
    if (recvNode === null || methodNode === null) continue;
    // Skip .new calls — already handled by the constructor-inference query patterns
    if (methodNode.text === 'new') continue;
    const compoundName = `${recvNode.text}.${methodNode.text}()`;
    out.push({
      '@type-binding.call-return': syntheticCapture(
        '@type-binding.call-return',
        assignNode,
        assignNode.text,
      ),
      '@type-binding.name': syntheticCapture('@type-binding.name', assignNode, left.text),
      '@type-binding.type': syntheticCapture('@type-binding.type', assignNode, compoundName),
    });
  }

  // Third pass: YARD comment annotations (@param, @return, @type)
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
      } else if (typeName) {
        // YARD @return before attr_accessor/attr_reader/attr_writer: the
        // comment precedes a `call` node (not a method). Extract the
        // property name from the attr call's arguments and bind it to
        // the annotated return type. This enables field-type chains
        // like `user.address.save → Address#save`.
        const attrNode = findFollowingAttrCall(comment);
        if (attrNode !== null) {
          const argList = attrNode.childForFieldName('arguments');
          if (argList !== null) {
            for (let ai = 0; ai < argList.namedChildCount; ai++) {
              const arg = argList.namedChild(ai);
              if (arg !== null && arg.type === 'simple_symbol') {
                const propName = arg.text.replace(/^:/, '');
                out.push({
                  '@type-binding.return': syntheticCapture('@type-binding.return', attrNode, text),
                  '@type-binding.name': syntheticCapture('@type-binding.name', attrNode, propName),
                  '@type-binding.type': syntheticCapture(
                    '@type-binding.type',
                    attrNode,
                    normalizeYardType(typeName),
                  ),
                });
              }
            }
          }
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

  // Fourth pass: constructor-return inference for methods.
  // When a method's body ends with `ClassName.new(...)`, synthesize a
  // return-type binding `methodName → ClassName` on the method node.
  // This enables cross-file return-type propagation for factory methods
  // like `def self.get_user; User.new; end` → `get_user → User`.
  // Keys of methods that already got a return binding from the YARD pass above,
  // precomputed once. The previous `out.some(...)` per method was
  // O(methods x out.length) ~ O(n^2); this makes the dedup O(1) per method.
  // Key = `<name>:<return-binding startLine>`, matching the old AND condition.
  //
  // Snapshot-vs-live note (PR #1918 tri-review P3): the old `out.some` was
  // evaluated LIVE, so it also saw constructor-return bindings this very loop
  // pushed in earlier iterations. That made the old code suppress the 2nd of
  // two same-named methods one source row apart whose bodies both end in
  // `Const.new` (the 1st's pushed binding startLine == the 2nd's row via the
  // 1-based/0-based offset below). The snapshot is built from the YARD pass
  // only, so it no longer cross-suppresses — both bindings are emitted, which
  // is the intended behavior (the cross-suppression was unintended). This
  // corner is absent from fixtures, so the capture fingerprint is unchanged;
  // ruby-captures-golden.test.ts pins it explicitly.
  const yardReturnKeys = new Set<string>();
  for (const m of out) {
    const ret = m['@type-binding.return'];
    const name = m['@type-binding.name'];
    if (ret !== undefined && name !== undefined) {
      yardReturnKeys.add(`${name.text}:${ret.range.startLine}`);
    }
  }
  for (const methodNode of [
    ...tree.rootNode.descendantsOfType('method'),
    ...tree.rootNode.descendantsOfType('singleton_method'),
  ]) {
    const methodName = methodNode.childForFieldName('name')?.text;
    if (methodName === undefined) continue;
    // Skip if a YARD @return already created a return binding for this method.
    if (yardReturnKeys.has(`${methodName}:${methodNode.startPosition.row}`)) {
      continue;
    }
    const body = methodNode.childForFieldName('body');
    if (body === null) continue;
    // Find the last expression in the method body
    const lastChild = body.namedChildCount > 0 ? body.namedChild(body.namedChildCount - 1) : null;
    if (lastChild === null) continue;
    // Check if the last expression is a `ClassName.new(...)` call
    if (lastChild.type === 'call') {
      const recv = lastChild.childForFieldName('receiver');
      const meth = lastChild.childForFieldName('method');
      if (
        recv !== null &&
        meth !== null &&
        meth.text === 'new' &&
        (recv.type === 'constant' || recv.type === 'scope_resolution')
      ) {
        out.push({
          '@type-binding.return': syntheticCapture(
            '@type-binding.return',
            methodNode,
            `constructor-return: ${recv.text}.new`,
          ),
          '@type-binding.name': syntheticCapture('@type-binding.name', methodNode, methodName),
          '@type-binding.type': syntheticCapture('@type-binding.type', methodNode, recv.text),
        });
      }
    }
  }

  // Fifth pass: superclass inheritance (`class Foo < Bar`).
  // Emit `@reference.inherits` captures so the registry-primary scope-
  // resolution path produces EXTENDS edges (issue #1951). This mirrors the
  // C#/C++ inheritance synthesis: Ruby's superclass edges previously came
  // only from the legacy heritage-capture query (removed in #942), which the
  // worker pipeline drops for registry-primary languages → 0 inheritance edges
  // in worker mode. Mixins (include/extend/prepend) are NOT touched here — they
  // flow through `emitHeritageEdges` (the `__heritage__:` import path above),
  // an independent lane that stays intact when the legacy heritage leg is gated off.
  out.push(...synthesizeRubySuperclassReferences(tree.rootNode));

  return out;
}

/**
 * Synthesize `@reference.inherits` captures from Ruby `class Foo < Bar`
 * superclass declarations so the shared `preEmitInheritanceEdges` pass can
 * resolve the base to a Class def and emit an EXTENDS edge.
 *
 * Scope is `class` nodes whose `superclass` field holds either a bare
 * `constant` base (`class D < Super`) or a qualified/scoped
 * `scope_resolution` base (`class C < Outer::Super`, `class E < A::B::C`) —
 * exactly the two shapes the config-driven legacy heritage alternation
 * captured (heritage-extractors/configs/ruby.ts
 * `rubyHeritageShapes: ['constant', 'scope_resolution']`). In prose: the
 * legacy query matched a `class` whose name is a `constant` and whose
 * `superclass` is either a `constant` or a `scope_resolution`, capturing the
 * superclass constant as the inherited base.
 *
 * Previously this pass emitted only for a direct `(constant)` child, so the
 * production registry-primary path silently dropped `Outer::Super`
 * superclasses while the legacy heritage leg captured them — the exact
 * EXTENDS/IMPLEMENTS-drop bug of #1951.
 *
 * THE PARITY CONTRACT: the `@reference.name` bare text must equal the legacy
 * leg's `normalizeSupertypeName(baseNode)` reduction. For a `scope_resolution`
 * (`Outer::Super`, `A::B::C`) the normalizer recurses into the `name:` field
 * and returns the trailing `constant` (`Super` / `C`); this synth mirrors that
 * by reading the same `name:` tail. A bare `constant` is unchanged
 * (byte-identical to the prior emission). `module` nodes are excluded (no
 * superclass field). Mixins (include/extend/prepend) are untouched — they flow
 * through the `__heritage__:` import lane above.
 *
 * Edge type (EXTENDS vs IMPLEMENTS) is decided downstream from the resolved
 * target's symbol kind — this pass only emits `@reference.inherits`.
 */
function synthesizeRubySuperclassReferences(root: SyntaxNode): CaptureMatch[] {
  const out: CaptureMatch[] = [];
  walkNamedTree(root, (node) => {
    if (node.type !== 'class') return;
    const superclass = node.childForFieldName('superclass');
    if (superclass === null) return;
    const baseNode = extractRubySuperclassBaseNode(superclass);
    if (baseNode === null) return;
    out.push({
      '@reference.inherits': nodeToCapture('@reference.inherits', baseNode),
      '@reference.name': nodeToCapture('@reference.name', baseNode),
    });
  });
  return out;
}

/**
 * Reduce a Ruby `superclass` node to the bare `constant` the resolver should
 * look up, at parity with the legacy heritage leg's
 * `normalizeSupertypeName(baseNode)`:
 *
 *   - direct `(constant)` child (`class D < Super`)       → that constant
 *     (unchanged from the original emission — kept byte-identical)
 *   - `(scope_resolution)` child (`class C < Outer::Super`,
 *     `class E < A::B::C`)                                → the trailing
 *     `name:` constant (`Super` / `C`)
 *
 * A `scope_resolution` nests qualifier-first, name-last
 * (`scope: (...) name: (constant)`), so the `name:` field is always the
 * trailing simple identifier — the same tail `normalizeSupertypeName` reaches
 * by recursing through its `name` field. Any other shape returns null (no
 * edge), keeping this emitter at parity with the legacy alternation
 * (`['constant', 'scope_resolution']`).
 */
function extractRubySuperclassBaseNode(superclass: SyntaxNode): SyntaxNode | null {
  const directConstant = findChild(superclass, 'constant');
  if (directConstant !== null) return directConstant;
  const scoped = findChild(superclass, 'scope_resolution');
  if (scoped !== null) {
    const tail = scoped.childForFieldName('name');
    if (tail !== null && tail.type === 'constant') return tail;
  }
  return null;
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
 * Walk forward from a comment node, skipping consecutive comments,
 * and return the next `call` node whose method is attr_accessor /
 * attr_reader / attr_writer (if any). Used to attach YARD `@return`
 * annotations to property declarations.
 */
function findFollowingAttrCall(commentNode: SyntaxNode): SyntaxNode | null {
  let sibling = commentNode.nextNamedSibling;
  while (sibling !== null && sibling.type === 'comment') {
    sibling = sibling.nextNamedSibling;
  }
  if (sibling === null) return null;
  if (sibling.type === 'call') {
    const methodNode = sibling.childForFieldName('method');
    if (methodNode !== null && ATTR_CALL_NAMES.has(methodNode.text)) {
      return sibling;
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
