/**
 * `emitScopeCaptures` for TypeScript.
 *
 * Drives the TypeScript scope query against tree-sitter-typescript and groups
 * raw matches into `CaptureMatch[]` for the central extractor. Layers
 * synthesized streams on top:
 *
 *   1. **Import decomposition** — each `import_statement` / re-export is
 *      re-emitted with `@import.kind/source/name/alias/typeOnly` markers so
 *      `interpretTsImport` can recover the `ParsedImport` shape without
 *      re-parsing raw text (see `import-decomposer.ts`). Unit 2 adds this;
 *      until then, raw `@import.statement` matches flow through as-is.
 *   2. **Dynamic imports** — `import('./m')` is re-emitted as a
 *      decomposed `@import.statement` with `@import.kind=dynamic` so the
 *      central extractor treats it uniformly with static imports.
 *   3. **Function-decl arity metadata** (Unit 5) — `@declaration.parameter-count`
 *      / `@declaration.required-parameter-count` / `@declaration.parameter-types`
 *      synthesized onto function-like declarations so the registry can narrow
 *      overloads.
 *   4. **Callsite arity metadata** (Unit 5) — `@reference.arity` /
 *      `@reference.parameter-types` on every callsite.
 *   5. **Receiver-binding synthesis** (Unit 3) — `this` type anchors on
 *      instance methods, with arrow-function lexical-this walk-up.
 *
 * Pure given the input source text. No I/O, no globals consulted.
 */

import type { Capture, CaptureMatch } from 'gitnexus-shared';
import {
  findNodeAtRange,
  nodeToCapture,
  syntheticCapture,
  type SyntaxNode,
} from '../../utils/ast-helpers.js';
import { splitImportStatement } from './import-decomposer.js';
import { getTsParser, getTsScopeQuery, tsCachedTreeMatchesGrammar } from './query.js';
import { recordCacheHit, recordCacheMiss } from './cache-stats.js';
import { synthesizeTsReceiverBinding } from './receiver-binding.js';
import { computeTsArityMetadata } from './arity-metadata.js';
import { getTreeSitterBufferSize } from '../../constants.js';

/** tree-sitter-typescript node types for function-like scopes that may
 *  carry a synthesized `this` binding. Kept in sync with the
 *  `@scope.function` patterns in `query.ts`. */
const FUNCTION_NODE_TYPES = [
  'method_definition',
  'method_signature',
  'abstract_method_signature',
  'arrow_function',
  'function_expression',
  'function_declaration',
  'generator_function_declaration',
  'function_signature',
] as const;

/** Declaration anchors that carry function-like arity metadata. */
const FUNCTION_DECL_TAGS = ['@declaration.method', '@declaration.function'] as const;

/** Callsite anchors that should carry `@reference.arity` + param types. */
const CALL_TAGS = [
  '@reference.call.free',
  '@reference.call.member',
  '@reference.call.constructor',
] as const;

function pickFirstDefined(grouped: CaptureMatch, tags: readonly string[]): Capture | undefined {
  for (const tag of tags) {
    const cap = grouped[tag];
    if (cap !== undefined) return cap;
  }
  return undefined;
}

/**
 * Drop `@reference.read.member` matches whose underlying `member_expression`
 * is NOT actually a read context:
 *
 *   1. The member_expression is the `function:` of a `call_expression`
 *      (it's a call, already captured as `@reference.call.member`).
 *   2. The member_expression is the `constructor:` of a `new_expression`
 *      (already captured as `@reference.call.constructor.qualified`).
 *   3. The member_expression is the `left:` of an `assignment_expression` /
 *      `augmented_assignment_expression` (it's a write, already captured
 *      as `@reference.write.member`).
 *   4. The member_expression is the `function:` of an `await_expression`
 *      being called (handled by the member-call capture).
 *
 * Returns `true` when the capture should be kept as a read reference,
 * `false` when it should be dropped.
 */
function shouldEmitReadMember(memberNode: SyntaxNode): boolean {
  const parent = memberNode.parent;
  if (parent === null) return true;
  switch (parent.type) {
    case 'call_expression':
      return parent.childForFieldName('function')?.id !== memberNode.id;
    case 'new_expression':
      return parent.childForFieldName('constructor')?.id !== memberNode.id;
    case 'assignment_expression':
    case 'augmented_assignment_expression':
      return parent.childForFieldName('left')?.id !== memberNode.id;
    default:
      return true;
  }
}

export function emitTsScopeCaptures(
  sourceText: string,
  filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  // Skip the parse when the caller (parse phase's scopeTreeCache) already
  // produced a Tree for this source. Cache miss = re-parse, same as before.
  // The cachedTree parameter is typed as `unknown` at the LanguageProvider
  // contract layer; cast here at the use site.
  //
  // Grammar selection: `.tsx` files are parsed with the TSX grammar,
  // `.ts` files with the TypeScript grammar. The two grammars have
  // separate node-type id spaces, so a Query compiled against one
  // cannot match a Tree produced by the other. We validate the cached
  // tree's grammar against the file extension and fall back to a
  // fresh parse if they disagree (e.g. a worker-mode parse landed
  // with the wrong grammar pinned).
  let tree = cachedTree as ReturnType<ReturnType<typeof getTsParser>['parse']> | undefined;
  if (tree !== undefined && !tsCachedTreeMatchesGrammar(tree, filePath)) {
    tree = undefined;
  }
  if (tree === undefined) {
    tree = getTsParser(filePath).parse(sourceText, undefined, {
      bufferSize: getTreeSitterBufferSize(sourceText),
    });
    recordCacheMiss();
  } else {
    recordCacheHit();
  }

  const rawMatches = getTsScopeQuery(filePath).matches(tree.rootNode);
  const out: CaptureMatch[] = [];

  for (const m of rawMatches) {
    // Group captures by their tag name. Tree-sitter strips the leading
    // `@`; we put it back so the central extractor's prefix lookups
    // (`@scope.`, `@declaration.`, …) work.
    const grouped: Record<string, Capture> = {};
    for (const c of m.captures) {
      const tag = '@' + c.name;
      grouped[tag] = nodeToCapture(tag, c.node);
    }
    if (Object.keys(grouped).length === 0) continue;

    // Decompose each `import_statement` / re-export `export_statement`
    // so `interpretTsImport` sees the kind/source/name/alias markers
    // it consumes. The raw query anchor carries only @import.statement.
    // Side-effect imports emit a non-binding marker so finalize can keep
    // the file-level dependency.
    if (grouped['@import.statement'] !== undefined) {
      const stmtCapture = grouped['@import.statement'];
      const stmtNode =
        findNodeAtRange(tree.rootNode, stmtCapture.range, 'import_statement') ??
        findNodeAtRange(tree.rootNode, stmtCapture.range, 'export_statement');
      if (stmtNode !== null) {
        const decomposed = splitImportStatement(stmtNode);
        for (const d of decomposed) out.push(d);
      }
      // If decomposition yielded nothing (malformed/bare anchor), drop
      // the match. Emitting a bare
      // @import.statement without kind/source would confuse the
      // central extractor.
      continue;
    }

    // Dynamic imports — decompose via the same path. `@import.dynamic`
    // is anchored on a `call_expression`, which the decomposer's
    // `splitDynamicImport` branch consumes.
    if (grouped['@import.dynamic'] !== undefined) {
      const dynCapture = grouped['@import.dynamic'];
      const callNode = findNodeAtRange(tree.rootNode, dynCapture.range, 'call_expression');
      if (callNode !== null) {
        const decomposed = splitImportStatement(callNode);
        for (const d of decomposed) out.push(d);
      }
      continue;
    }

    // Filter out `@reference.read.member` matches whose AST parent tells
    // us they are actually calls / writes / constructor invocations. The
    // tree-sitter pattern is context-free and matches every member_expression;
    // we rely on this emit-side filter so the query stays simple.
    if (grouped['@reference.read.member'] !== undefined) {
      const anchor = grouped['@reference.read.member'];
      const memberNode = findNodeAtRange(tree.rootNode, anchor.range, 'member_expression');
      if (memberNode === null || !shouldEmitReadMember(memberNode)) {
        continue;
      }
    }

    // Synthesize arity metadata on function-like declaration anchors
    // before pushing the match. The registry uses these to narrow
    // overloads — TypeScript supports overload signatures via
    // function_signature, so `parameterTypes` is populated when
    // available.
    const declAnchor = pickFirstDefined(grouped, FUNCTION_DECL_TAGS);
    if (declAnchor !== undefined) {
      const fnNode = findFunctionNode(tree.rootNode, declAnchor.range);
      if (fnNode !== null) {
        const arity = computeTsArityMetadata(fnNode);
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

    // Synthesize `@reference.arity` on every callsite so the registry's
    // arity filter can narrow overloads. Count the `argument` named
    // children of the backing `arguments` node. TypeScript constructor
    // calls use `new_expression`; regular calls use `call_expression`.
    const callAnchor = pickFirstDefined(grouped, CALL_TAGS);
    if (callAnchor !== undefined && grouped['@reference.arity'] === undefined) {
      const callNode =
        findNodeAtRange(tree.rootNode, callAnchor.range, 'call_expression') ??
        findNodeAtRange(tree.rootNode, callAnchor.range, 'new_expression');
      if (callNode !== null) {
        const argList = callNode.childForFieldName('arguments');
        const args: SyntaxNode[] =
          argList === null
            ? []
            : argList.namedChildren.filter(
                (c): c is SyntaxNode => c !== null && c.type !== 'comment',
              );
        grouped['@reference.arity'] = syntheticCapture(
          '@reference.arity',
          callNode,
          String(args.length),
        );

        const argTypes = args.map((arg) => inferArgType(arg));
        grouped['@reference.parameter-types'] = syntheticCapture(
          '@reference.parameter-types',
          callNode,
          JSON.stringify(argTypes),
        );
      }
    }

    out.push(grouped);

    // Synthesize `this` receiver type-bindings on every function-like
    // scope that is structurally a class member. `receiver-binding.ts`
    // handles the walk-up (method, method_signature, abstract
    // signature, arrow/function-expression assigned to a class field).
    // Arrow functions nested inside method bodies rely on scope-chain
    // lookup instead of synthesis — covered by `tsReceiverBinding`.
    const scopeFnAnchor = grouped['@scope.function'];
    if (scopeFnAnchor !== undefined) {
      const fnNode = findFunctionNode(tree.rootNode, scopeFnAnchor.range);
      if (fnNode !== null) {
        const synth = synthesizeTsReceiverBinding(fnNode);
        if (synth !== null) out.push(synth);
      }
    }
  }

  // Synthesize object-destructuring type bindings. The tree-sitter query
  // alone can't express "give me the field NAME and the RHS identifier
  // together" in a way that produces usable @type-binding.name /
  // @type-binding.type captures, so we walk `variable_declarator` nodes
  // whose `name:` is an `object_pattern` and synthesize per-field
  // bindings keyed to the receiver-path `rhsName.fieldName`. The
  // compound-receiver resolver's Case 3b then walks that path when the
  // destructured local is used as a receiver (e.g. `address.save()`).
  synthesizeDestructuringBindings(tree.rootNode, out);
  synthesizeForOfMapTupleBindings(tree.rootNode, out);
  synthesizeInstanceofNarrowings(tree.rootNode, out);

  return out;
}

/**
 * Walk the AST and synthesize type-binding captures for object
 * destructuring of the form `const { field } = rhs` or
 * `const { field: alias } = rhs`. Pushes one synthetic CaptureMatch
 * per destructured identifier with:
 *
 *   - `@type-binding.name` → the local identifier
 *   - `@type-binding.type` → the compound path `rhs.field`
 *   - `@type-binding.destructured` anchor
 *
 * Only fires when the RHS is a bare identifier — more complex RHS
 * shapes (call_expression, member_expression) resolve via the normal
 * type-alias + chain-follow paths on the RHS first, then the field
 * walk catches the destructured identifier on a second fixpoint pass.
 * Left as a follow-up optimization.
 */
function synthesizeDestructuringBindings(root: SyntaxNode, out: CaptureMatch[]): void {
  const stack: SyntaxNode[] = [root];
  for (;;) {
    const node = stack.pop();
    if (node === undefined) break;
    for (const child of node.namedChildren) {
      if (child !== null) stack.push(child);
    }
    if (node.type !== 'variable_declarator') continue;
    const nameNode = node.childForFieldName('name');
    const valueNode = node.childForFieldName('value');
    if (nameNode === null || valueNode === null) continue;
    if (nameNode.type !== 'object_pattern') continue;
    if (valueNode.type !== 'identifier') continue;
    const rhsName = valueNode.text;
    for (const fieldNode of nameNode.namedChildren) {
      if (fieldNode === null) continue;
      if (fieldNode.type === 'shorthand_property_identifier_pattern') {
        // `const { address } = user`
        const localName = fieldNode.text;
        out.push({
          '@type-binding.name': syntheticCapture('@type-binding.name', fieldNode, localName),
          '@type-binding.type': syntheticCapture(
            '@type-binding.type',
            fieldNode,
            `${rhsName}.${localName}`,
          ),
          '@type-binding.destructured': syntheticCapture(
            '@type-binding.destructured',
            fieldNode,
            fieldNode.text,
          ),
        });
      } else if (fieldNode.type === 'pair_pattern') {
        // `const { address: addr } = user`
        const key = fieldNode.childForFieldName('key');
        const value = fieldNode.childForFieldName('value');
        if (key === null || value === null) continue;
        if (value.type !== 'identifier') continue;
        const fieldName = key.text;
        const localName = value.text;
        out.push({
          '@type-binding.name': syntheticCapture('@type-binding.name', value, localName),
          '@type-binding.type': syntheticCapture(
            '@type-binding.type',
            fieldNode,
            `${rhsName}.${fieldName}`,
          ),
          '@type-binding.destructured': syntheticCapture(
            '@type-binding.destructured',
            fieldNode,
            fieldNode.text,
          ),
        });
      }
    }
  }
}

/**
 * `for (const [k, v] of mapId)` over a `Map<K,V>` — synthesize per-slot
 * type bindings so `v` resolves like a `Map` iterator tuple element.
 * Uses sentinel `__MAP_TUPLE_i__:rhs` consumed by compound-receiver.
 */
function synthesizeForOfMapTupleBindings(root: SyntaxNode, out: CaptureMatch[]): void {
  const stack: SyntaxNode[] = [root];
  for (;;) {
    const node = stack.pop();
    if (node === undefined) break;
    for (const child of node.namedChildren) {
      if (child !== null) stack.push(child);
    }
    if (node.type !== 'for_in_statement') continue;
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');
    if (left === null || right === null) continue;
    if (left.type !== 'array_pattern' || right.type !== 'identifier') continue;
    const rhs = right.text;
    let slot = 0;
    for (const child of left.namedChildren) {
      if (child === null || child.type !== 'identifier') continue;
      const localName = child.text;
      out.push({
        '@type-binding.name': syntheticCapture('@type-binding.name', child, localName),
        '@type-binding.type': syntheticCapture(
          '@type-binding.type',
          child,
          `__MAP_TUPLE_${slot}__:${rhs}`,
        ),
        '@type-binding.map-tuple-entry': syntheticCapture(
          '@type-binding.map-tuple-entry',
          child,
          String(slot),
        ),
      });
      slot++;
    }
  }
}

/**
 * `if (x instanceof User) { x.save() }` — synthesize a `User` type binding
 * for `x` anchored in the consequence block so scope-chain lookup inside
 * the then-branch sees the narrowed type.
 *
 * **Known limitation:** the LHS must be a bare `identifier` and the RHS
 * an `identifier`/`type_identifier`. Member-expression LHS such as
 * `if (user.address instanceof Address)` is intentionally NOT synthesized
 * — narrowing a property-access target requires a stable storage key
 * the binding layer can hold, which member chains don't supply. Field-
 * type resolution covers the common case for those receivers via
 * declared types instead.
 */
function synthesizeInstanceofNarrowings(root: SyntaxNode, out: CaptureMatch[]): void {
  const stack: SyntaxNode[] = [root];
  for (;;) {
    const node = stack.pop();
    if (node === undefined) break;
    for (const child of node.namedChildren) {
      if (child !== null) stack.push(child);
    }
    if (node.type !== 'if_statement') continue;
    const cond = node.childForFieldName('condition');
    if (cond === null) continue;
    const inner = cond.type === 'parenthesized_expression' ? cond.namedChildren[0] : cond;
    if (inner === null || inner.type !== 'binary_expression') continue;
    const op = inner.childForFieldName('operator');
    const left = inner.childForFieldName('left');
    const right = inner.childForFieldName('right');
    if (op === null || left === null || right === null) continue;
    if (op.type !== 'instanceof') continue;
    if (left.type !== 'identifier') continue;
    if (right.type !== 'identifier' && right.type !== 'type_identifier') continue;
    const varName = left.text;
    const typeName = right.text;
    const cons = node.childForFieldName('consequence');
    if (cons === null) continue;
    out.push({
      '@type-binding.name': syntheticCapture('@type-binding.name', cons, varName),
      '@type-binding.type': syntheticCapture('@type-binding.type', right, typeName),
      '@type-binding.instanceof-narrow': syntheticCapture(
        '@type-binding.instanceof-narrow',
        cons,
        '1',
      ),
    });
  }
}

/** Infer a TypeScript argument expression's static type from literal
 *  shapes. Returns `''` when the arg has no statically-derivable type
 *  (identifiers, member accesses, etc.) — consumers treat unknown as
 *  any-match during overload narrowing. */
function inferArgType(argNode: SyntaxNode): string {
  switch (argNode.type) {
    case 'number':
      return 'number';
    case 'string':
    case 'template_string':
      return 'string';
    case 'true':
    case 'false':
      return 'boolean';
    case 'null':
      return 'null';
    case 'undefined':
      return 'undefined';
    case 'array':
      return 'Array';
    case 'object':
      return 'object';
    case 'regex':
      return 'RegExp';
    case 'new_expression': {
      const ctor = argNode.childForFieldName('constructor');
      return ctor?.text ?? '';
    }
    default:
      return '';
  }
}

/** Find the first TypeScript function-like node at the given range.
 *  The `@scope.function` anchor range covers the whole node, but the
 *  tag alone doesn't identify which node type among the many TS
 *  function-likes. */
function findFunctionNode(rootNode: SyntaxNode, range: Capture['range']): SyntaxNode | null {
  for (const nodeType of FUNCTION_NODE_TYPES) {
    const n = findNodeAtRange(rootNode, range, nodeType);
    if (n !== null) return n;
  }
  return null;
}
