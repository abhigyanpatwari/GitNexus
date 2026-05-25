import type { Capture, CaptureMatch } from 'gitnexus-shared';
import {
  findNodeAtRange,
  nodeToCapture,
  syntheticCapture,
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
    for (const c of m.captures) {
      const tag = '@' + c.name;
      if (tag.startsWith('@_')) continue;
      grouped[tag] = nodeToCapture(tag, c.node);
    }
    if (Object.keys(grouped).length === 0) continue;

    // Decompose use declarations into individual import captures
    if (grouped['@import.statement'] !== undefined) {
      const anchor = grouped['@import.statement']!;
      const useNode = findNodeAtRange(tree.rootNode, anchor.range, 'use_declaration');
      if (useNode !== null) {
        out.push(...splitRustUseDeclaration(useNode));
        continue;
      }
    }

    // Synthesize self receiver bindings for methods inside impl blocks
    let cachedImplLookup: { fnNode: SyntaxNode; implNode: SyntaxNode | null } | undefined;
    if (grouped['@scope.function'] !== undefined) {
      const scopeCap = grouped['@scope.function']!;
      const fnNode = findNodeAtRange(tree.rootNode, scopeCap.range, 'function_item');
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
      const fnNode = findNodeAtRange(tree.rootNode, declAnchor.range, 'function_item');
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
      const fnNode = findNodeAtRange(tree.rootNode, tbReturnAnchor.range, 'function_item');
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
    const callAnchor =
      grouped['@reference.call.free'] ??
      grouped['@reference.call.member'] ??
      grouped['@reference.call.constructor'];
    if (callAnchor !== undefined) {
      const callNode =
        findNodeAtRange(tree.rootNode, callAnchor.range, 'call_expression') ??
        findNodeAtRange(tree.rootNode, callAnchor.range, 'struct_expression');
      if (callNode !== null) {
        const arity = computeRustCallArity(callNode);
        grouped['@reference.arity'] = syntheticCapture('@reference.arity', callNode, String(arity));
      }
    }

    out.push(grouped);
  }

  return out;
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
