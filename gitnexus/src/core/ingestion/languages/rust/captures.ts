import type { Capture, CaptureMatch } from 'gitnexus-shared';
import {
  nodeIfType,
  nodeToCapture,
  syntheticCapture,
  walkNamedTree,
  type SyntaxNode,
} from '../../utils/ast-helpers.js';
import { getRustParser, getRustScopeQuery } from './query.js';
import { recordRustCacheHit, recordRustCacheMiss } from './cache-stats.js';
import { splitRustUseDeclaration } from './import-decomposer.js';
import { synthesizeRustReceiverBinding } from './receiver-binding.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';

export function emitRustScopeCaptures(
  sourceText: string,
  _filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  let tree = cachedTree as ReturnType<ReturnType<typeof getRustParser>['parse']> | undefined;
  if (tree === undefined) {
    tree = parseSourceSafe(getRustParser(), sourceText, undefined, {
      bufferSize: getTreeSitterBufferSize(sourceText),
    });
    recordRustCacheMiss();
  } else {
    recordRustCacheHit();
  }

  const rawMatches = getRustScopeQuery().matches(tree.rootNode);
  const out: CaptureMatch[] = [];

  for (const m of rawMatches) {
    const grouped: Record<string, Capture> = {};
    // Parallel tag -> captured SyntaxNode map: the query hands us each matched
    // node as c.node, so anchors resolve via a type-guarded lookup (nodeIfType)
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

    // Decompose use declarations into individual import captures
    if (grouped['@import.statement'] !== undefined) {
      const useNode = nodeIfType(nodeMap['@import.statement'], 'use_declaration');
      if (useNode !== null) {
        out.push(...splitRustUseDeclaration(useNode));
        continue;
      }
    }

    // Synthesize self receiver bindings for methods inside impl blocks
    let cachedImplLookup: { fnNode: SyntaxNode; implNode: SyntaxNode | null } | undefined;
    if (grouped['@scope.function'] !== undefined) {
      const fnNode = nodeIfType(nodeMap['@scope.function'], 'function_item');
      if (fnNode !== null) {
        const implNode = findEnclosingImpl(fnNode);
        cachedImplLookup = { fnNode, implNode };
        const receiver = synthesizeRustReceiverBinding(fnNode, implNode);
        if (receiver !== null) out.push(receiver);
      }
    }

    // Attach declaration arity for functions/methods
    const declAnchor = grouped['@declaration.function'];
    if (declAnchor !== undefined) {
      const fnNode = nodeIfType(nodeMap['@declaration.function'], 'function_item');
      if (fnNode !== null) {
        const implNode =
          cachedImplLookup?.fnNode === fnNode
            ? cachedImplLookup.implNode
            : findEnclosingImpl(fnNode);
        const traitNode = implNode === null ? findEnclosingTrait(fnNode) : null;
        // Reclassify as method if inside an impl block or trait definition
        if (implNode !== null || traitNode !== null) {
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

        const arity = computeRustDeclarationArity(fnNode);
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
      }
    }

    // Hoist return-type bindings from impl block functions to module level.
    // The auto-hoist in the scope-extractor places a type binding whose
    // anchor matches its innermost scope on the parent scope. By using the
    // impl_item node as the anchor (which matches the impl's Class scope),
    // the binding lands on the Module scope — making it visible to the
    // compound receiver's hoistTypeBindingsToModule walk.
    if (
      grouped['@type-binding.return'] !== undefined &&
      grouped['@type-binding.name'] !== undefined
    ) {
      const tbReturnAnchor = grouped['@type-binding.return']!;
      const fnNode = nodeIfType(nodeMap['@type-binding.return'], 'function_item');
      if (fnNode !== null) {
        const implNode = findEnclosingImpl(fnNode);
        if (implNode !== null) {
          out.push({
            '@type-binding.name': syntheticCapture(
              '@type-binding.name',
              implNode,
              grouped['@type-binding.name']!.text,
            ),
            '@type-binding.type': syntheticCapture(
              '@type-binding.type',
              implNode,
              grouped['@type-binding.type']!.text,
            ),
            '@type-binding.return': syntheticCapture(
              '@type-binding.return',
              implNode,
              tbReturnAnchor.text,
            ),
          });
        }
      }
    }

    // Attach call arity for call expressions
    const callAnchorNode =
      nodeMap['@reference.call.free'] ??
      nodeMap['@reference.call.member'] ??
      nodeMap['@reference.call.constructor'];
    if (callAnchorNode !== undefined) {
      const callNode = nodeIfType(callAnchorNode, 'call_expression', 'struct_expression');
      if (callNode !== null) {
        const arity = computeRustCallArity(callNode);
        grouped['@reference.arity'] = syntheticCapture('@reference.arity', callNode, String(arity));
      }
    }

    out.push(grouped);
  }

  out.push(...synthesizeRustInheritanceReferences(tree.rootNode));

  return out;
}

/**
 * Synthesize `@reference.inherits` captures from Rust trait `impl` blocks so
 * the registry-primary scope-resolution path can emit the IMPLEMENTS edge for
 * `impl Trait for Struct` (mirrors the legacy heritage-capture leg, removed in
 * #942, which the worker pipeline drops for registry-primary languages — #1951).
 *
 * Rust inheritance is structurally unlike a base list on a type declaration:
 * the relationship lives on `impl_item { trait: T, type: S }`, meaning
 * `S IMPLEMENTS T`. The shared `preEmitInheritanceEdges` derives an edge's
 * SOURCE from the enclosing *class* def of the `@reference.inherits` site, but
 * an `impl_item` scope owns no class-like def (the struct `S` is declared
 * elsewhere as a `struct_item`), so `findEnclosingClassDef` returns undefined
 * and that pass emits nothing for these sites (it still marks them handled,
 * suppressing the generic reference bridge). The real IMPLEMENTS edge is
 * therefore emitted by `rustScopeResolver.emitHeritageEdges`, which reads these
 * sites back from `parsedFiles[*].referenceSites`.
 *
 * To carry both ends of the relationship through a single reference site we
 * encode: `@reference.name` = the trait `T` (becomes `site.name`, the IMPLEMENTS
 * target) and `@reference.receiver` = the struct `S` (becomes
 * `site.explicitReceiver.name`, the IMPLEMENTS source).
 *
 * Parity is intentionally pinned to the legacy heritage query's `impl_item`
 * patterns: both `trait:` and `type:` normalize to the base's trailing bare
 * `type_identifier` — directly, via a `scoped_type_identifier`'s `name:` tail
 * (`crate::traits::Drawable` → `Drawable`; KTD-1 tail resolution), or through a
 * `generic_type`'s `type:` field (which may itself be either). Inherent impls
 * (`impl S {}`, no `trait:` field) still emit nothing.
 */
function synthesizeRustInheritanceReferences(root: SyntaxNode): CaptureMatch[] {
  const out: CaptureMatch[] = [];
  walkNamedTree(root, (node) => {
    if (node.type !== 'impl_item') return;
    const traitField = node.childForFieldName('trait');
    const typeField = node.childForFieldName('type');
    if (traitField === null || typeField === null) return;
    const traitName = bareTypeIdentifier(traitField);
    const structName = bareTypeIdentifier(typeField);
    if (traitName === null || structName === null) return;
    out.push({
      '@reference.inherits': nodeToCapture('@reference.inherits', traitName),
      '@reference.name': nodeToCapture('@reference.name', traitName),
      '@reference.receiver': syntheticCapture('@reference.receiver', structName, structName.text),
    });
  });
  return out;
}

/**
 * Normalize a `trait:` / `type:` impl_item field to the base's trailing bare
 * `type_identifier`, matching exactly the node shapes the legacy heritage
 * query accepted (kept at parity — see the `impl_item` heritage arm in
 * tree-sitter-queries.ts):
 *   - `type_identifier`                                  → the node itself
 *   - `scoped_type_identifier name: (type_identifier)`   → the trailing `name:` id
 *     (`crate::traits::Drawable` → `Drawable`; KTD-1 tail resolution — the
 *     simple name then resolves scope-aware via `emitRustTraitImplEdges`)
 *   - `generic_type type: <any of the above>`            → recurse into `type:`
 *     (covers `Box<T>` and `m::Wrapped<T>`)
 * Any other node type returns null (no edge), keeping this emitter at parity
 * with the legacy query.
 */
function bareTypeIdentifier(node: SyntaxNode): SyntaxNode | null {
  if (node.type === 'type_identifier') return node;
  if (node.type === 'scoped_type_identifier') {
    const tail = node.childForFieldName('name');
    return tail !== null && tail.type === 'type_identifier' ? tail : null;
  }
  if (node.type === 'generic_type') {
    const inner = node.childForFieldName('type');
    return inner !== null ? bareTypeIdentifier(inner) : null;
  }
  return null;
}

function findEnclosingImpl(node: SyntaxNode): SyntaxNode | null {
  let current: SyntaxNode | null = node.parent;
  while (current !== null) {
    if (current.type === 'impl_item') return current;
    if (current.type === 'source_file' || current.type === 'mod_item') return null;
    current = current.parent;
  }
  return null;
}

function findEnclosingTrait(node: SyntaxNode): SyntaxNode | null {
  let current: SyntaxNode | null = node.parent;
  while (current !== null) {
    if (current.type === 'trait_item') return current;
    if (current.type === 'source_file' || current.type === 'mod_item') return null;
    current = current.parent;
  }
  return null;
}

function computeRustDeclarationArity(fnNode: SyntaxNode): {
  parameterCount?: number;
  requiredParameterCount?: number;
} {
  const params = fnNode.childForFieldName('parameters');
  if (params === null) return {};

  let count = 0;
  for (let i = 0; i < params.namedChildCount; i++) {
    const child = params.namedChild(i);
    if (child === null) continue;
    if (child.type === 'self_parameter') continue;
    if (child.type === 'parameter') count++;
  }
  // Rust has no default parameters or overloading
  return { parameterCount: count, requiredParameterCount: count };
}

function computeRustCallArity(callNode: SyntaxNode): number {
  if (callNode.type === 'struct_expression') {
    const body = callNode.childForFieldName('body');
    if (body === null) return 0;
    let count = 0;
    for (let i = 0; i < body.namedChildCount; i++) {
      const t = body.namedChild(i)?.type;
      if (t === 'field_initializer' || t === 'shorthand_field_initializer') count++;
    }
    return count;
  }

  const args = callNode.childForFieldName('arguments');
  if (args === null) return 0;

  let count = 0;
  for (let i = 0; i < args.namedChildCount; i++) {
    const child = args.namedChild(i);
    if (child !== null) count++;
  }
  return count;
}
