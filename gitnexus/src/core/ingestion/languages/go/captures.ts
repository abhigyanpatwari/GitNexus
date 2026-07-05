import type { Capture, CaptureMatch } from 'gitnexus-shared';
import {
  nodeToCapture,
  syntheticCapture,
  walkNamedTree,
  type SyntaxNode,
} from '../../utils/ast-helpers.js';
import { getGoParser, getGoScopeQuery } from './query.js';
import { recordGoCacheHit, recordGoCacheMiss } from './cache-stats.js';
import { computeGoCallArity, computeGoDeclarationArity } from './arity-metadata.js';
import { splitGoImportStatement } from './import-decomposer.js';
import { synthesizeGoReceiverBinding } from './receiver-binding.js';
import { synthesizeGoTypeBindings, extractSimpleTypeNameText } from './type-binding.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';

export function emitGoScopeCaptures(
  sourceText: string,
  _filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  let tree = cachedTree as ReturnType<ReturnType<typeof getGoParser>['parse']> | undefined;
  if (tree === undefined) {
    tree = parseSourceSafe(getGoParser(), sourceText, undefined, {
      bufferSize: getTreeSitterBufferSize(sourceText),
    });
    recordGoCacheMiss();
  } else {
    recordGoCacheHit();
  }

  const rawMatches = getGoScopeQuery().matches(tree.rootNode);
  const out: CaptureMatch[] = [];

  for (const m of rawMatches) {
    const grouped: Record<string, Capture> = {};
    // Parallel tag -> captured SyntaxNode map. The tree-sitter query already
    // hands us the matched node as `c.node`; keeping it here lets us derive the
    // anchor/relative node by walking LOCALLY (parent chain / own subtree)
    // instead of re-walking from tree.rootNode (the O(matches x rootChildren)
    // hotpath that made #1848's 250-struct DAO file take ~10s). The captured
    // node either IS the node the old findNodeAtRange re-derived, or is a close
    // relative reachable by a bounded local walk.
    const nodeMap: Record<string, SyntaxNode> = {};
    for (const c of m.captures) {
      const tag = '@' + c.name;
      if (tag.startsWith('@_')) continue; // skip anonymous captures
      grouped[tag] = nodeToCapture(tag, c.node);
      nodeMap[tag] = c.node;
    }
    if (Object.keys(grouped).length === 0) continue;

    if (grouped['@import.statement'] !== undefined) {
      // The captured node is the `import_spec`; the original code preferred its
      // enclosing `import_declaration` ONLY when that ancestor shares the exact
      // same range (which never happens — the declaration always includes the
      // `import` keyword prefix — so it falls back to the import_spec itself).
      // Replicate that exactly via a local ancestor walk, never from root.
      const importNode = resolveImportNode(nodeMap['@import.statement']!);
      if (importNode !== null) {
        out.push(...splitGoImportStatement(importNode));
        continue;
      }
    }

    if (grouped['@scope.function'] !== undefined) {
      // @scope.function captures function_declaration | method_declaration |
      // func_literal. The original looked for a function_declaration or
      // method_declaration at the captured range; the captured node IS that
      // node for the first two, and a func_literal never coincides in range
      // with either, so the lookup yields null for func_literal.
      const scopeNode = nodeMap['@scope.function']!;
      const fnNode =
        scopeNode.type === 'function_declaration' || scopeNode.type === 'method_declaration'
          ? scopeNode
          : null;
      if (fnNode !== null) {
        const receiver = synthesizeGoReceiverBinding(fnNode);
        if (receiver !== null) out.push(receiver);
      }
    }

    if (isRawMultiAssignTypeBinding(nodeMap)) continue;

    normalizeGenericConstructorCapture(nodeMap, grouped);

    const declAnchorNode = nodeMap['@declaration.function'] ?? nodeMap['@declaration.method'];
    if (declAnchorNode !== undefined) {
      // @declaration.function / @declaration.method are captured directly on
      // the function_declaration / method_declaration node.
      const fnNode =
        declAnchorNode.type === 'function_declaration' ||
        declAnchorNode.type === 'method_declaration' ||
        declAnchorNode.type === 'method_elem'
          ? declAnchorNode
          : null;
      if (fnNode !== null) {
        const arity = computeGoDeclarationArity(fnNode);
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
        if (arity.returnType !== undefined) {
          grouped['@declaration.return-type'] = syntheticCapture(
            '@declaration.return-type',
            fnNode,
            arity.returnType,
          );
        }
      }
      out.push(grouped);
      continue;
    }

    // @reference.call.free / .member are captured on the call_expression;
    // @reference.call.constructor on the composite_literal. The captured node
    // IS the node the old findNodeAtRange re-derived for each, so use it.
    const callNode =
      nodeMap['@reference.call.free'] ??
      nodeMap['@reference.call.member'] ??
      nodeMap['@reference.call.constructor'];
    if (callNode !== undefined && grouped['@reference.arity'] === undefined) {
      if (callNode.type === 'call_expression' || callNode.type === 'composite_literal') {
        grouped['@reference.arity'] = syntheticCapture(
          '@reference.arity',
          callNode,
          String(computeGoCallArity(callNode)),
        );
      }
    }

    out.push(grouped);
  }

  // Layer on type-binding synthesis (new/make/qualified composite literal)
  const synthesized = synthesizeGoTypeBindings(tree.rootNode);
  out.push(...synthesized);

  // Synthesize typeBindings for struct fields so compound receiver
  // resolution (`user.Address.Save()`) can walk field types.
  for (const match of out) {
    if (match['@declaration.field'] === undefined) continue;
    const nameCap = match['@declaration.name'];
    const typeCap = match['@declaration.field-type'];
    if (nameCap === undefined || typeCap === undefined) continue;
    // Create a synthetic @type-binding.field match using the field
    // name and its declared type from the @declaration.field-type capture.
    // This lands in the Class scope's typeBindings (via pass4 positioning).
    out.push({
      '@type-binding.field': typeCap,
      '@type-binding.name': nameCap,
      '@type-binding.type': {
        name: '@type-binding.type',
        text: typeCap.text,
        range: { ...typeCap.range },
      },
    });
  }

  out.push(...synthesizeGoInheritanceReferences(tree.rootNode));

  return out;
}

/**
 * Synthesize `@reference.inherits` captures for Go struct embedding so the
 * registry-primary scope-resolution path emits inheritance edges (mirrors C#
 * `synthesizeCsharpInheritanceReferences` / C++ `emitCppInheritanceCaptures`).
 * Without this, Go embedding edges came only from the legacy heritage-capture
 * leg (removed in #942), which is dropped for registry-primary languages in the
 * worker pipeline (issue #1951).
 *
 * Scope EXACTLY matches the legacy Go heritage query + its `shouldSkipExtends`
 * hook (`heritage-extractors/configs/go.ts`), whose supertype alternation is
 * `[(type_identifier) (qualified_type) (generic_type)]` (see `goHeritageShapes`)
 * matched against BOTH struct embedding and interface-in-interface embedding:
 *
 *   struct:    (struct_type (field_declaration_list
 *                (field_declaration type: <base>)))   — anonymous (no `name`) field
 *   interface: (interface_type (type_elem <base>))    — single-element type_elem
 *
 * i.e. an embedded (anonymous) field inside a struct, or an embedded type inside
 * an interface. Named struct fields (`Breed string`) are skipped because their
 * `field_declaration` carries a `name` field; multi-operand interface type-sets
 * (`int | float64`) are skipped because their `type_elem` has >1 named child —
 * both matching the legacy `shouldSkipExtends` filter.
 *
 * The base shapes covered (issue #1951 — these were previously DROPPED by the
 * registry-primary synth, so production silently omitted their edges even though
 * the legacy heritage leg, config-driven since #1940, captured them):
 *   - bare `type_identifier`  (`Base`)                       → the node itself
 *   - `qualified_type`        (`pkg.Base`)                    → `name:` tail
 *   - `generic_type`          (`Box[T]`)                      → `type:` base
 *   - pointer embeds          (`*Base`, `*pkg.Base`, …)       → the `*` is an
 *     unnamed token, so `field_declaration.type` already points at the inner
 *     shape above; no `pointer_type` unwrap is needed in this grammar version.
 *
 * The captured `@reference.name` is reduced to its bare simple identifier so the
 * V1 simple-name `findClassBindingInScope` contract keeps holding — `pkg.Base`
 * → `Base`, `Box[T]` → `Box`. {@link goEmbedBaseNameNode} returns the node whose
 * `.text` EQUALS `normalizeSupertypeName(base)` for every shape (verified by
 * real-parse), so this synth stays at parity with the legacy leg's reduction.
 * For a bare `type_identifier` it returns the same node, keeping the simple-base
 * path byte-identical.
 *
 * The EXTENDS-vs-IMPLEMENTS split is decided downstream from the resolved
 * target's symbol kind (`preEmitInheritanceEdges`): an embedded struct resolves
 * to EXTENDS, an embedded interface to IMPLEMENTS.
 */
function synthesizeGoInheritanceReferences(root: SyntaxNode): CaptureMatch[] {
  const out: CaptureMatch[] = [];
  walkNamedTree(root, (node) => {
    if (node.type !== 'type_declaration') return;
    for (const spec of node.namedChildren) {
      if (spec.type !== 'type_spec') continue;
      const typeNode = spec.childForFieldName('type');
      if (typeNode === null) continue;
      if (typeNode.type === 'struct_type') {
        const fieldList = findNamedChildOfType(typeNode, 'field_declaration_list');
        if (fieldList === null) continue;
        for (const field of fieldList.namedChildren) {
          if (field.type !== 'field_declaration') continue;
          // Embedded (anonymous) field: no `name` field. Named fields are
          // skipped (legacy `shouldSkipExtends`).
          if (field.childForFieldName('name') !== null) continue;
          // `field.type` is the embedded base — bare/qualified/generic, with any
          // `*` pointer marker as an unnamed sibling token (already unwrapped).
          emitGoEmbedInheritance(field.childForFieldName('type'), out);
        }
      } else if (typeNode.type === 'interface_type') {
        for (const elem of typeNode.namedChildren) {
          // Only `type_elem` (an embedded type); `method_elem` is a method, not
          // an embed. Multi-operand type-sets (`int | float64`) parse as a
          // `type_elem` with >1 named child — skip them (legacy
          // `shouldSkipExtends`); a single-element `type_elem` is the embed.
          if (elem.type !== 'type_elem' || elem.namedChildCount !== 1) continue;
          emitGoEmbedInheritance(elem.namedChild(0), out);
        }
      }
    }
  });
  return out;
}

/**
 * Emit one `@reference.inherits` / `@reference.name` match for a Go embed base
 * node, reducing the name to its bare simple identifier. No-ops when `baseNode`
 * is null or not one of the embed shapes.
 */
function emitGoEmbedInheritance(baseNode: SyntaxNode | null, out: CaptureMatch[]): void {
  if (baseNode === null) return;
  const nameNode = goEmbedBaseNameNode(baseNode);
  if (nameNode === null) return;
  out.push({
    '@reference.inherits': nodeToCapture('@reference.inherits', baseNode),
    '@reference.name': nodeToCapture('@reference.name', nameNode),
  });
}

/**
 * Reduce a Go embed base node to its trailing bare `type_identifier`, matching
 * the node shapes the legacy heritage query accepted (`goHeritageShapes`) and
 * the reduction `normalizeSupertypeName` performs (verified by real-parse to
 * yield an identical `.text` for each shape):
 *   - `type_identifier`                          → the node itself (`Base`)
 *   - `qualified_type` name: (type_identifier)   → the trailing `name:` id
 *                                                  (`pkg.Base` → `Base`)
 *   - `generic_type` type: <any of the above>    → recurse into `type:`
 *                                                  (`Box[T]` → `Box`)
 * Any other node type returns null (no edge), keeping this emitter at parity
 * with the legacy leg.
 */
function goEmbedBaseNameNode(node: SyntaxNode): SyntaxNode | null {
  if (node.type === 'type_identifier') return node;
  if (node.type === 'qualified_type') {
    const name = node.childForFieldName('name');
    return name !== null ? goEmbedBaseNameNode(name) : null;
  }
  if (node.type === 'generic_type') {
    const inner = node.childForFieldName('type');
    return inner !== null ? goEmbedBaseNameNode(inner) : null;
  }
  return null;
}

/** First named child of `node` matching `type`, else null. */
function findNamedChildOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (const child of node.namedChildren) {
    if (child.type === type) return child;
  }
  return null;
}

/**
 * Resolve the node passed to `splitGoImportStatement` for an @import.statement
 * match. The capture is on the `import_spec`; the original preferred an
 * `import_declaration` at the SAME range, else the import_spec. An
 * import_declaration always includes the `import` keyword and so never shares
 * the spec's exact range — the only candidate is an ancestor, and it can only
 * match when ranges coincide. Walk the parent chain (bounded, local) for an
 * import_declaration whose range equals the spec's; otherwise return the spec.
 */
function resolveImportNode(importSpec: SyntaxNode): SyntaxNode {
  let current: SyntaxNode | null = importSpec.parent;
  while (current !== null) {
    if (current.type === 'import_declaration') {
      if (nodeRangeEquals(current, importSpec)) return current;
      break;
    }
    // import_spec is nested at most under import_declaration ->
    // import_spec_list -> import_spec; stop once we leave the import subtree.
    if (current.type !== 'import_spec_list') break;
    current = current.parent;
  }
  return importSpec;
}

/** True iff two nodes occupy the exact same source range. */
function nodeRangeEquals(a: SyntaxNode, b: SyntaxNode): boolean {
  return (
    a.startPosition.row === b.startPosition.row &&
    a.startPosition.column === b.startPosition.column &&
    a.endPosition.row === b.endPosition.row &&
    a.endPosition.column === b.endPosition.column
  );
}

function normalizeGenericConstructorCapture(
  nodeMap: Record<string, SyntaxNode>,
  grouped: Record<string, Capture>,
): void {
  const typeNode =
    grouped['@type-binding.constructor'] !== undefined ? nodeMap['@type-binding.type'] : undefined;
  if (typeNode !== undefined && typeNode.type === 'generic_type') {
    const base = typeNode.childForFieldName('type');
    if (base !== null) {
      grouped['@type-binding.type'] = syntheticCapture(
        '@type-binding.type',
        base,
        extractSimpleTypeNameText(base),
      );
    }
  }

  const referenceNode =
    grouped['@reference.call.constructor'] !== undefined ? nodeMap['@reference.name'] : undefined;
  if (referenceNode !== undefined && referenceNode.type === 'generic_type') {
    const base = referenceNode.childForFieldName('type');
    if (base !== null) {
      grouped['@reference.name'] = syntheticCapture(
        '@reference.name',
        base,
        extractSimpleTypeNameText(base),
      );
    }
  }
}

function isRawMultiAssignTypeBinding(nodeMap: Record<string, SyntaxNode>): boolean {
  const anchor =
    nodeMap['@type-binding.constructor'] ??
    nodeMap['@type-binding.call-return'] ??
    nodeMap['@type-binding.assertion'];
  if (anchor === undefined) return false;

  // These tags are captured directly ON the short_var_declaration, so the
  // captured node IS what the original findNodeAtRange(root, range,
  // 'short_var_declaration') re-derived. The var_declaration (var-form)
  // variants — @type-binding.assertion (`var x = e.(T)`) and
  // @type-binding.call-return (`var x = Func()`) — anchor on a var_declaration
  // instead; the old range+type lookup found no short_var_declaration at that
  // range and returned null -> false, which this type guard reproduces exactly.
  if (anchor.type !== 'short_var_declaration') return false;
  const node = anchor;
  const lhs = node.childForFieldName('left');
  const rhs = node.childForFieldName('right');
  if (lhs === null) return false;
  if (rhs === null) return false;
  return (
    lhs.namedChildren.filter((c) => c.type === 'identifier').length >= 2 &&
    rhs.namedChildren.length >= 2
  );
}
