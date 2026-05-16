/**
 * `emitScopeCaptures` for Java.
 *
 * Drives the Java scope query against tree-sitter-java and groups raw
 * matches into `CaptureMatch[]` for the central extractor. Layers:
 *
 *   1. **Decomposed import declarations** — each `import_declaration`
 *      is re-emitted with `@import.kind/source/name` markers.
 *   2. **Receiver binding synthesis** — `this`/`super` type-bindings
 *      on instance methods.
 *   3. **Arity metadata** on method/constructor declarations.
 *   4. **Reference arity** on call sites.
 *
 * Pure given the input source text. No I/O, no globals consulted.
 */

import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { findNodeAtRange, nodeToCapture, syntheticCapture } from '../../utils/ast-helpers.js';
import { splitImportDeclaration } from './import-decomposer.js';
import { computeJavaArityMetadata } from './arity-metadata.js';
import { synthesizeJavaReceiverBinding } from './receiver-binding.js';
import { getJavaParser, getJavaScopeQuery } from './query.js';
import { recordCacheHit, recordCacheMiss } from './cache-stats.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';

/** Declaration anchors that carry function-like arity metadata. */
const FUNCTION_DECL_TAGS = ['@declaration.method', '@declaration.constructor'] as const;

/** tree-sitter-java node types that the method extractor accepts. */
const FUNCTION_NODE_TYPES = ['method_declaration', 'constructor_declaration'] as const;

/** Suppress read.member emissions when the field_access is already
 *  covered by a method_invocation (object of a call) or an
 *  assignment_expression (write target). */
function shouldEmitReadMember(memberNode: SyntaxNode): boolean {
  const parent = memberNode.parent;
  if (parent === null) return true;

  switch (parent.type) {
    case 'method_invocation':
      // Don't emit read.member when the field_access is the object of a method_invocation
      // (the method call already handles this relationship)
      return parent.childForFieldName('object')?.id !== memberNode.id;
    case 'assignment_expression':
      return parent.childForFieldName('left')?.id !== memberNode.id;
    default:
      return true;
  }
}

export function emitJavaScopeCaptures(
  sourceText: string,
  _filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  let tree = cachedTree as ReturnType<ReturnType<typeof getJavaParser>['parse']> | undefined;
  if (tree === undefined) {
    tree = parseSourceSafe(getJavaParser(), sourceText, undefined, {
      bufferSize: getTreeSitterBufferSize(sourceText),
    });
    recordCacheMiss();
  } else {
    recordCacheHit();
  }

  const rawMatches = getJavaScopeQuery().matches(tree.rootNode);
  const out: CaptureMatch[] = [];

  for (const m of rawMatches) {
    const grouped: Record<string, Capture> = {};
    for (const c of m.captures) {
      const tag = '@' + c.name;
      grouped[tag] = nodeToCapture(tag, c.node);
    }
    if (Object.keys(grouped).length === 0) continue;

    // Decompose each `import_declaration`.
    if (grouped['@import.statement'] !== undefined) {
      const stmtCapture = grouped['@import.statement'];
      const stmtNode = findNodeAtRange(tree.rootNode, stmtCapture.range, 'import_declaration');
      if (stmtNode !== null) {
        const decomposed = splitImportDeclaration(stmtNode);
        if (decomposed !== null) {
          out.push(decomposed);
          continue;
        }
      }
      out.push(grouped);
      continue;
    }

    // Skip free-call matches that are actually member calls. The query
    // matches ALL method_invocations as @reference.call.free (without
    // negation) because tree-sitter-java's query engine drops !object
    // patterns when a positive object: pattern exists for the same node
    // type. Filter here: if the match has @reference.call.free but also
    // has @reference.receiver, it's a member call — skip the free match
    // (the separate @reference.call.member match covers it).
    if (
      grouped['@reference.call.free'] !== undefined &&
      grouped['@reference.receiver'] !== undefined
    ) {
      continue;
    }

    // Filter read.member when it's a child of method_invocation or assignment.
    if (grouped['@reference.read.member'] !== undefined) {
      const anchor = grouped['@reference.read.member'];
      const memberNode = findNodeAtRange(tree.rootNode, anchor.range, 'field_access');
      if (memberNode === null || !shouldEmitReadMember(memberNode)) {
        continue;
      }
    }

    // Synthesize `this` / `super` receiver type-bindings on every
    // instance method-like.
    if (grouped['@scope.function'] !== undefined) {
      out.push(grouped);
      const anchor = grouped['@scope.function']!;
      const fnNode = findFunctionNode(tree.rootNode, anchor.range);
      if (fnNode !== null) {
        for (const synth of synthesizeJavaReceiverBinding(fnNode)) {
          out.push(synth);
        }
      }
      continue;
    }

    // Synthesize arity metadata on function-like declarations.
    const declTag = FUNCTION_DECL_TAGS.find((t) => grouped[t] !== undefined);
    if (declTag !== undefined) {
      const anchor = grouped[declTag]!;
      const fnNode = findFunctionNode(tree.rootNode, anchor.range);
      if (fnNode !== null) {
        const arity = computeJavaArityMetadata(fnNode);
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
    }

    // Synthesize `@reference.arity` on every callsite.
    const callTag = (
      ['@reference.call.free', '@reference.call.member', '@reference.call.constructor'] as const
    ).find((t) => grouped[t] !== undefined);
    if (callTag !== undefined && grouped['@reference.arity'] === undefined) {
      const anchor = grouped[callTag]!;
      const callNode =
        findNodeAtRange(tree.rootNode, anchor.range, 'method_invocation') ??
        findNodeAtRange(tree.rootNode, anchor.range, 'object_creation_expression');
      if (callNode !== null) {
        const argList = callNode.childForFieldName('arguments');
        const args =
          argList === null
            ? []
            : argList.namedChildren.filter((c) => c !== null && c.type !== 'comment');
        grouped['@reference.arity'] = syntheticCapture(
          '@reference.arity',
          callNode,
          String(args.length),
        );

        const argTypes = args.map((arg) => inferArgType(arg!));
        grouped['@reference.parameter-types'] = syntheticCapture(
          '@reference.parameter-types',
          callNode,
          JSON.stringify(argTypes),
        );
      }
    }

    out.push(grouped);
  }

  return out;
}

type SyntaxNode = ReturnType<ReturnType<typeof getJavaParser>['parse']>['rootNode'];

/** Infer a Java argument's static type from literal patterns. */
function inferArgType(argNode: SyntaxNode): string {
  switch (argNode.type) {
    case 'decimal_integer_literal':
    case 'hex_integer_literal':
    case 'octal_integer_literal':
    case 'binary_integer_literal':
      return 'int';
    case 'decimal_floating_point_literal':
    case 'hex_floating_point_literal':
      return 'double';
    case 'string_literal':
      return 'String';
    case 'character_literal':
      return 'char';
    case 'true':
    case 'false':
      return 'boolean';
    case 'null_literal':
      return 'null';
    case 'object_creation_expression': {
      const typeNode = argNode.childForFieldName('type');
      return typeNode?.text ?? '';
    }
    default:
      return '';
  }
}

/** Find the first Java function-like node at the given range. */
function findFunctionNode(rootNode: SyntaxNode, range: Capture['range']): SyntaxNode | null {
  for (const nodeType of FUNCTION_NODE_TYPES) {
    const n = findNodeAtRange(rootNode, range, nodeType);
    if (n !== null) return n as SyntaxNode;
  }
  return null;
}
