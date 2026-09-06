/**
 * `emitScopeCaptures` for JavaScript.
 *
 * Adapts `emitTsScopeCaptures` for the JavaScript grammar:
 *
 *   1. **JS grammar** — uses `tree-sitter-javascript` instead of
 *      `tree-sitter-typescript`. The JS scope query is a subset of the
 *      TypeScript one (TypeScript-only node types dropped).
 *
 *   2. **CJS `require()` decomposition** — `const { X } = require('./m')`
 *      and `const X = require('./m')` are walked in a post-query pass and
 *      synthesized as `@import.kind/name/alias/source` markers so that
 *      `interpretJsImport` can recover a `ParsedImport` using the same
 *      shape as the TypeScript ESM decomposer.
 *
 *   3. **JSDoc type bindings** — JavaScript has no static type annotations
 *      so `@type-binding.parameter` / `@type-binding.return` must be
 *      inferred from leading JSDoc comments. A lightweight regex scanner
 *      (`parseJsDocParams` / `parseJsDocReturn`) extracts `@param {T} n`
 *      and `@returns {T}` tags and emits synthetic captures positioned on
 *      the annotated function node. `@type {T}` on a class FIELD is the same
 *      story one level down — it is the only way JavaScript can declare a
 *      field's type at all — and emits `@type-binding.class-field` (#2833).
 *
 *   4. **Shared synthesis passes** — destructuring, for-of map-tuple, and
 *      instanceof narrowing passes are duplicated from `typescript/captures.ts`
 *      (they are pure AST operations with no grammar-specific logic).
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
import { collectEsmExportEvidence, esmExportVerdict } from '../../ts-js-export-marker.js';
import { splitImportStatement } from '../typescript/import-decomposer.js';
import { getJsParser, getJsScopeQuery, jsCachedTreeMatchesGrammar } from './query.js';
import { computeTsArityMetadata } from '../typescript/arity-metadata.js';
import { synthesizeTsReceiverBinding } from '../typescript/receiver-binding.js';
import { isArrayMethodCallbackArrow } from '../typescript/array-callback.js';
import { isStaticClassFieldBinding } from '../typescript/captures.js';
import { reducesToContainedType } from '../typescript/interpret.js';

/** JavaScript's spelling of a class-field declaration — the TypeScript grammar
 *  calls the same construct `public_field_definition`. Named here, not in the
 *  shared predicate, so each literal is checked against the grammar of the file
 *  it lives in (`grammar-literal-validation`). */
const JS_CLASS_FIELD_DEFINITION_TYPES: ReadonlySet<string> = new Set(['field_definition']);
import { hasKeyword } from '../../field-extractors/configs/helpers.js';
import { synthesizeCjsModuleExports } from '../typescript/cjs-module-exports.js';
import {
  isShadowedCjsExportAssignment,
  isUnexportedMemberAssignmentValue,
  isUndeclarableThisMemberValue,
} from '../typescript/cjs-export-assignment.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import { synthesizeCallableFlowCaptures } from '../../utils/callable-flow-captures.js';
import { synthesizeReceiverChainCapture } from '../../utils/receiver-chain-captures.js';
import {
  deriveDefaultExportHocName,
  isBlockedDefaultExportHoc,
  isDefaultExportHocFunctionNode,
} from '../../ts-js-hoc-utils.js';

/** JS function-like node types that may carry a synthesized `this` binding.
 *  Kept in sync with the `@scope.function` patterns in `query.ts`. */
export const FUNCTION_NODE_TYPES = [
  'method_definition',
  'arrow_function',
  'function_expression',
  'function_declaration',
  'generator_function_declaration',
  // The EXPRESSION form (`const g = function* () {}`) — see the matching note
  // in `typescript/captures.ts`.
  'generator_function',
] as const;

/** Nodes whose `statement_block` child is their BODY, not a nested block. */
const JS_FUNCTION_BODY_OWNER_TYPES: ReadonlySet<string> = new Set(FUNCTION_NODE_TYPES);

/** Direct-child node types that create a BINDING in their enclosing block.
 *  `variable_declaration` (`var`) is deliberately absent: it hoists past the
 *  block to the function, so a block containing only `var` binds nothing. */
const BLOCK_BINDING_CHILD_TYPES: ReadonlySet<string> = new Set([
  'lexical_declaration',
  'class_declaration',
  'function_declaration',
  'generator_function_declaration',
]);

/** True when `block` directly declares a name, i.e. it is a real environment
 *  record rather than punctuation. A block that binds nothing is transparent to
 *  every scope-chain walk — a lookup finds nothing in it and continues to the
 *  parent — so emitting a scope for it costs tree size and walk depth and buys
 *  exactly nothing. Only DIRECT children count: a declaration in a nested block
 *  belongs to that block, which gets its own scope by the same rule. */
const blockDeclaresBinding = (block: SyntaxNode): boolean => {
  for (let i = 0; i < block.namedChildCount; i++) {
    const child = block.namedChild(i);
    if (child !== null && BLOCK_BINDING_CHILD_TYPES.has(child.type)) return true;
  }
  return false;
};

/** Declaration anchors that carry function-like arity metadata. */
const FUNCTION_DECL_TAGS = ['@declaration.method', '@declaration.function'] as const;

/** Callsite anchors that should carry `@reference.arity` + param types. */
const CALL_TAGS = [
  '@reference.call.free',
  '@reference.call.member',
  '@reference.call.constructor',
] as const;

const JS_CALLABLE_CAPTURE_OPTIONS = {
  functionNodeTypes: new Set<string>(FUNCTION_NODE_TYPES),
  callNodeTypes: new Set(['call_expression']),
  parameterListNodeTypes: new Set(['formal_parameters', 'arguments']),
  parameterNodeTypes: new Set(['identifier', 'rest_pattern', 'assignment_pattern']),
  bindingNodeTypes: new Set(['variable_declarator']),
  assignmentNodeTypes: new Set(['assignment_expression', 'augmented_assignment_expression']),
  identifierNodeTypes: new Set([
    'identifier',
    'property_identifier',
    'shorthand_property_identifier_pattern',
    'private_property_identifier',
  ]),
} as const;

function pickFirstDefined(grouped: CaptureMatch, tags: readonly string[]): Capture | undefined {
  for (const tag of tags) {
    const cap = grouped[tag];
    if (cap !== undefined) return cap;
  }
  return undefined;
}

function pickFirstNode(
  groupedNodes: Record<string, SyntaxNode | undefined>,
  tags: readonly string[],
): SyntaxNode | undefined {
  for (const tag of tags) {
    const node = groupedNodes[tag];
    if (node !== undefined) return node;
  }
  return undefined;
}

/** Walks the parent chain from `node` (inclusive), returning the first node
 *  whose type matches, or null. Faster than `findNodeAtRange` when the caller
 *  already holds the anchor node — avoids re-scanning the tree from the root. */
function findSelfOrAncestorOfType(node: SyntaxNode | undefined, type: string): SyntaxNode | null {
  if (node === undefined) return null;
  let current: SyntaxNode | null = node;
  while (current !== null) {
    if (current.type === type) return current;
    current = current.parent;
  }
  return null;
}

/** Walks the parent chain from `node` (inclusive), returning the first node
 *  whose type is in the set, or null. Plural form of {@link findSelfOrAncestorOfType}. */
function findSelfOrAncestorOfTypes(
  node: SyntaxNode | undefined,
  types: readonly string[],
): SyntaxNode | null {
  if (node === undefined) return null;
  let current: SyntaxNode | null = node;
  while (current !== null) {
    if (types.includes(current.type)) return current;
    current = current.parent;
  }
  return null;
}

/** Filter `@reference.read.member` in non-read contexts (same logic as TS). */
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
    case 'jsx_self_closing_element':
    case 'jsx_opening_element':
      return parent.childForFieldName('name')?.id !== memberNode.id;
    default:
      return true;
  }
}

/** Find the first JS function-like node at the given range.
 *  Prefers the threaded anchor node (walk up its parent chain) so the common
 *  case avoids a root re-scan; falls back to a range scan from root only when
 *  the anchor isn't a function-like (or isn't supplied). */
function findFunctionNode(
  rootNode: SyntaxNode,
  range: Capture['range'],
  anchorNode?: SyntaxNode,
): SyntaxNode | null {
  const fromAnchor = findSelfOrAncestorOfTypes(anchorNode, FUNCTION_NODE_TYPES);
  if (fromAnchor !== null) return fromAnchor;
  for (const nodeType of FUNCTION_NODE_TYPES) {
    const n = findNodeAtRange(rootNode, range, nodeType);
    if (n !== null) return n;
  }
  return null;
}

/** Infer a callsite argument's static type from literal shapes. */
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

// ─── CJS require() decomposition ─────────────────────────────────────────

/**
 * Walk the AST and synthesize `@import.*` captures for CJS `require()` calls:
 *
 *   - `const { X, Y } = require('./m')` → one match per destructured name,
 *     `@import.kind = 'named'`, `@import.name = X / Y`.
 *   - `const X = require('./m')` → `@import.kind = 'namespace'`,
 *     `@import.alias = X` (the whole module is bound to X).
 *   - `require('./m')` as a bare expression-statement → side-effect.
 *
 * CJS named-alias form (`const { X: alias } = require('./m')`) emits
 * `@import.kind = 'named-alias'` with `@import.name = X` and
 * `@import.alias = alias`.
 *
 * The synthesized markers are identical to those produced by
 * `splitImportStatement` for ESM, so `interpretJsImport` can delegate
 * unchanged to `interpretTsImport` for all cases.
 */
function synthesizeCjsImports(root: SyntaxNode, out: CaptureMatch[]): void {
  const stack: SyntaxNode[] = [root];
  for (;;) {
    const node = stack.pop();
    if (node === undefined) break;
    for (const child of node.namedChildren) {
      if (child !== null) stack.push(child);
    }

    if (node.type !== 'call_expression') continue;

    // Require call: function must be bare identifier "require".
    const fn = node.childForFieldName('function');
    if (fn === null || fn.type !== 'identifier' || fn.text !== 'require') continue;

    const argsNode = node.childForFieldName('arguments');
    if (argsNode === null) continue;

    // Source must be a string literal.
    const firstArg = argsNode.namedChild(0);
    if (firstArg === null || firstArg.type !== 'string') continue;
    const rawSource = firstArg.text; // includes surrounding quotes
    const source = firstArg.namedChild(0)?.text ?? rawSource.slice(1, -1);

    const parent = node.parent;

    // Case 1: const { X } = require('./m') OR const X = require('./m')
    if (parent?.type === 'variable_declarator') {
      const nameNode = parent.childForFieldName('name');
      if (nameNode === null) continue;

      if (nameNode.type === 'object_pattern') {
        // Destructured: emit one match per specifier.
        for (const field of nameNode.namedChildren) {
          if (field === null) continue;
          if (field.type === 'shorthand_property_identifier_pattern') {
            const name = field.text;
            out.push({
              '@import.statement': syntheticCapture('@import.statement', node, rawSource),
              '@import.kind': syntheticCapture('@import.kind', node, 'named'),
              '@import.name': syntheticCapture('@import.name', field, name),
              '@import.source': syntheticCapture('@import.source', firstArg, source),
            });
          } else if (field.type === 'pair_pattern') {
            const key = field.childForFieldName('key');
            const value = field.childForFieldName('value');
            if (key === null || value === null || value.type !== 'identifier') continue;
            out.push({
              '@import.statement': syntheticCapture('@import.statement', node, rawSource),
              '@import.kind': syntheticCapture('@import.kind', node, 'named-alias'),
              '@import.name': syntheticCapture('@import.name', key, key.text),
              '@import.alias': syntheticCapture('@import.alias', value, value.text),
              '@import.source': syntheticCapture('@import.source', firstArg, source),
            });
          }
        }
      } else if (nameNode.type === 'identifier') {
        // Namespace-style: const X = require('./m') → bind whole module to X.
        out.push({
          '@import.statement': syntheticCapture('@import.statement', node, rawSource),
          '@import.kind': syntheticCapture('@import.kind', node, 'namespace'),
          '@import.alias': syntheticCapture('@import.alias', nameNode, nameNode.text),
          '@import.source': syntheticCapture('@import.source', firstArg, source),
        });
      }
      continue;
    }

    // Case 2: bare require('./m') — side-effect import.
    if (parent?.type === 'expression_statement') {
      out.push({
        '@import.statement': syntheticCapture('@import.statement', node, rawSource),
        '@import.kind': syntheticCapture('@import.kind', node, 'side-effect'),
        '@import.source': syntheticCapture('@import.source', firstArg, source),
      });
    }
  }
}

// ─── JSDoc type binding synthesis ────────────────────────────────────────

interface JsDocParam {
  readonly name: string;
  readonly type: string;
}

/** Extract `@param {Type} name` entries from a JSDoc comment block. */
function parseJsDocParams(text: string): readonly JsDocParam[] {
  const results: JsDocParam[] = [];
  // Match @param {Type} name or @param {Type} [name] (optional)
  const re = /@param\s+\{([^}]+)\}\s+\[?(\w+)\]?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    results.push({ type: m[1].trim(), name: m[2].trim() });
  }
  return results;
}

/** Extract `@returns {Type}` or `@return {Type}` from a JSDoc comment. */
function parseJsDocReturn(text: string): string | null {
  const m = /@returns?\s+\{([^}]+)\}/.exec(text);
  return m ? m[1].trim() : null;
}

/** Extract `@type {Type}` from a JSDoc comment (variable-level annotation). */
function parseJsDocType(text: string): string | null {
  const m = /@type\s+\{([^}]+)\}/.exec(text);
  return m ? m[1].trim() : null;
}

/**
 * A type REFERENCE, possibly qualified, generic, or unioned:
 * `Repo`, `Repo<User>`, `models.Repo`, `Handler<Req, Res>`, `Repo|null`,
 * `Repo<User> | null`.
 *
 * Applied only to a string already capped by {@link JSDOC_TYPE_MAX_LENGTH}:
 * the union and generic groups both nest quantifiers, so an unbounded
 * non-matching input is a backtracking hazard, and a docblock's `{…}` payload
 * is attacker-shaped text (it is whatever the file says).
 *
 * JSDoc's `{…}` payload is free text and carries shapes that are not
 * references at all — record types (`{{a: number}}`), function types
 * (`{function(string): void}`), the any-type `{*}`, parenthesized unions
 * (`{(Repo|Other)}`). None of those name a class, so a field annotated with
 * one is DECLINED rather than bound to whatever substring survives
 * normalization. (`parseJsDocType`'s `[^}]+` also truncates a record type at
 * its first `}`, which this rejects too.)
 */
/** Longest `@type {…}` payload considered. A type REFERENCE that names a class
 *  is far shorter; past this the string is a structural type or generated
 *  noise, which this pass declines anyway, and the cap is what keeps
 *  {@link JSDOC_TYPE_REFERENCE_RE}'s nested quantifiers off an unbounded
 *  input. */
const JSDOC_TYPE_MAX_LENGTH = 200;

const JSDOC_TYPE_REFERENCE_RE =
  /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\s*<[\w$.,<>\s]*>)?(?:\s*\|\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\s*<[\w$.,<>\s]*>)?)*$/;

/**
 * The spelling a JSDoc `@type` should bind a class FIELD to, or `null` to
 * decline.
 *
 * The as-written spelling is returned, NOT a reduced one: `interpretJsTypeBinding`
 * carries `Repo<User>` through to `TypeRef.rawName` untouched (user generics are
 * not on `stripGeneric`'s wrapper list), and `resolveClassBindingForName` erases
 * the arguments to `Repo` at lookup time. That is the same erasure every other
 * language in #2833 relies on, so generics need no code here — verified, not
 * assumed, by the capture probe in that issue.
 *
 * Two declines:
 *   - `reducesToContainedType` — the container spellings whose interpretation
 *     would yield the ELEMENT (`Repo[]`, `Array<Repo>`, `Promise<Repo>`). See
 *     that predicate for why a field must not take its element's type.
 *   - anything that is not a type reference (see JSDOC_TYPE_REFERENCE_RE).
 *
 * The leading `?` / `!` nullability sigils are JSDoc-specific decoration with no
 * bearing on which class is named, so they are peeled first — `{?Repo}` binds
 * `Repo` exactly as `{Repo|null}` does.
 */
function jsDocFieldTypeSpelling(rawType: string): string | null {
  const spelling = rawType
    .trim()
    .replace(/^[?!]+/, '')
    .trim();
  if (spelling === '' || spelling.length > JSDOC_TYPE_MAX_LENGTH) return null;
  if (reducesToContainedType(spelling)) return null;
  if (!JSDOC_TYPE_REFERENCE_RE.test(spelling)) return null;
  return spelling;
}

/**
 * The identifier a JSDoc `@type` may bind a `field_definition` to, or `null` if
 * this field takes no docblock binding at all (#2833).
 *
 * Two refusals, and both are cheaper to answer than the docblock search they
 * gate, which is why they run before it:
 *
 *   - `static` fields are dropped, exactly as the query-driven annotation path
 *     drops them in `emitJsScopeCaptures` — a static member belongs to the class
 *     object and would silently RETYPE an instance field of the same name. The
 *     full cost of that trade, measured, is in `isStaticClassFieldBinding`
 *     (#2807). Re-checked here because the synthesis pass runs outside the
 *     match loop that applies it.
 *   - a name that is not a plain identifier (a computed key, a string key)
 *     names nothing `this.x` could look up.
 *
 * The JavaScript grammar names a field's name `property:`, not `name:`. `#priv`
 * arrives as `private_property_identifier`; TypeScript binds those under their
 * `#`-prefixed spelling, which is how `this.#priv` looks it up.
 */
function jsDocBindableFieldName(node: SyntaxNode): SyntaxNode | null {
  if (isStaticClassFieldBinding(node, JS_CLASS_FIELD_DEFINITION_TYPES)) return null;
  const nameNode = node.childForFieldName('property');
  if (
    nameNode === null ||
    (nameNode.type !== 'property_identifier' && nameNode.type !== 'private_property_identifier')
  ) {
    return null;
  }
  return nameNode;
}

/**
 * Emit the class-FIELD type binding a JSDoc `@type {T}` block declares (#2833).
 *
 * JavaScript has no type annotations, so a docblock is the only way a field
 * can declare one — and measured before this branch, `/** @type {Repo<User>} *​/
 * repo;` bound NOTHING, taking down the non-generic control (`{Plain}`) with
 * it. TypeScript's equivalent `repo: Repo<User>` has always bound, via the
 * `@type-binding.annotation` rule on `public_field_definition`; this reaches the
 * same DESTINATION from the docblock — an annotation-strength binding on the
 * enclosing Class scope, which is the only place `typeOfMemberOnClass` reads a
 * field's type — so the compound-receiver resolver finds it the way it always
 * has. No resolution-side change. See the tag note on the emit below for why
 * the marker is `class-field` rather than `annotation`.
 */
function emitJsDocFieldBinding(
  docComment: string,
  nameNode: SyntaxNode,
  out: CaptureMatch[],
): void {
  const rawType = parseJsDocType(docComment);
  const spelling = rawType === null ? null : jsDocFieldTypeSpelling(rawType);
  if (spelling === null) return;
  out.push({
    '@type-binding.name': syntheticCapture('@type-binding.name', nameNode, nameNode.text),
    '@type-binding.type': syntheticCapture('@type-binding.type', nameNode, spelling),
    // `class-field`, not `annotation`: this is the JS provider's own
    // marker for a binding that must be HOISTED to the enclosing Class
    // scope, which is where `typeOfMemberOnClass` reads a field's type.
    // `jsBindingScopeFor` does that walk; `interpretJsTypeBinding` then
    // remaps the tag to `annotation` so the source strength is the same
    // as TypeScript's `repo: Repo<User>`. Measured: with `annotation`
    // the binding lands on the innermost scope and the field never
    // types — the same shape `synthesizeConstructorFieldBindings` needs
    // for `this.p = new Outer()`.
    '@type-binding.class-field': syntheticCapture('@type-binding.class-field', nameNode, '1'),
  });
}

/**
 * Walk the AST and synthesize `@type-binding.*` captures from JSDoc
 * comments immediately preceding function declarations / expressions and class
 * field definitions.
 *
 * Only `/** … *​/` block comments are scanned. Line comments (`//`) are
 * intentionally excluded — JSDoc lives in block comments.
 *
 * Emits:
 *   - `@type-binding.parameter` for each `@param {T} n` tag.
 *   - `@type-binding.return` for `@returns {T}` / `@return {T}`.
 *   - `@type-binding.annotation` for `@type {T}` on `let`/`const`/`var`
 *     declarations — covers the common `/** @type {User} *​/ const u = …`
 *     pattern (ECMA-262 §14.3.1/§14.3.2 variable declarations).
 *   - `@type-binding.class-field` for `@type {T}` on a `field_definition`
 *     (#2833) — see {@link emitJsDocFieldBinding}.
 *
 * The binding is anchored on the function node so `tsBindingScopeFor`
 * can hoist method return-type bindings to Module scope (matching the
 * TypeScript path where `hoistTypeBindingsToModule: true`).
 *
 * `field_definition` is a node kind of THIS walk rather than a pass of its own,
 * even though a field's anchor and name are the field itself while every other
 * branch keys off a function-like anchor. A separate pass would be a ninth
 * full-tree traversal of `emitJsScopeCaptures`, and measured on
 * `dist/core/ingestion/workers/parse-worker.js` (2.4k lines, 17.3k nodes) one
 * `namedChildren` walk costs 14.3 ms against 7.5 ms to PARSE the whole file —
 * `node.namedChildren` materializes a fresh array of node wrappers across the
 * N-API boundary at every node. The two node kinds share this walk's preceding-
 * comment search and nothing else, so the branch below returns as soon as it
 * has emitted.
 */
function synthesizeJsDocBindings(root: SyntaxNode, out: CaptureMatch[]): void {
  const stack: SyntaxNode[] = [root];
  for (;;) {
    const node = stack.pop();
    if (node === undefined) break;
    for (const child of node.namedChildren) {
      if (child !== null) stack.push(child);
    }

    const isFnDecl =
      node.type === 'function_declaration' || node.type === 'generator_function_declaration';
    const isMethodDef = node.type === 'method_definition';
    // Also check lexical_declaration containing an arrow/fn-expression
    const isLexDecl = node.type === 'lexical_declaration' || node.type === 'variable_declaration';
    const isFieldDef = node.type === 'field_definition';

    if (!isFnDecl && !isMethodDef && !isLexDecl && !isFieldDef) continue;

    // Non-null exactly for a field that can carry a binding, so it doubles as
    // the branch selector inside the comment search below. Answered before that
    // search because an unbindable field has no reason to look for a docblock.
    const fieldNameNode = isFieldDef ? jsDocBindableFieldName(node) : null;
    if (isFieldDef && fieldNameNode === null) continue;

    // For `export function foo() { ... }`, the JSDoc comment precedes the
    // wrapping export_statement, not the inner function_declaration.
    // Walk up to the export_statement so the preceding-sibling search finds it.
    const lookupNode =
      (isFnDecl || isLexDecl) && node.parent?.type === 'export_statement' ? node.parent : node;

    // Find the preceding sibling comment.
    let sibling = lookupNode.previousNamedSibling;
    while (sibling !== null && sibling.type === 'comment') {
      const text = sibling.text;
      if (text.startsWith('/**')) {
        // A field's docblock declares its own type and nothing else — `@param` /
        // `@returns` on a field name no callable — so this branch does not fall
        // through to the function-like tags below.
        if (fieldNameNode !== null) {
          emitJsDocFieldBinding(text, fieldNameNode, out);
          break;
        }

        // Found a JSDoc block.
        const params = parseJsDocParams(text);
        const retType = parseJsDocReturn(text);
        const varType = isLexDecl ? parseJsDocType(text) : null;

        // Determine the anchor node (the function-like node, for hoisting).
        const anchor = node;

        for (const p of params) {
          out.push({
            '@type-binding.name': syntheticCapture('@type-binding.name', anchor, p.name),
            '@type-binding.type': syntheticCapture('@type-binding.type', anchor, p.type),
            '@type-binding.parameter': syntheticCapture('@type-binding.parameter', anchor, '1'),
          });
        }

        if (retType !== null) {
          // For named functions, use the function name as the binding name so
          // `hoistTypeBindingsToModule` knows which function's return type this is.
          let fnName: string | null = null;
          if (isFnDecl) {
            fnName = node.childForFieldName('name')?.text ?? null;
          } else if (isMethodDef) {
            // method_definition uses `name:` field for the method name
            const nameNode = node.childForFieldName('name');
            if (nameNode?.type === 'property_identifier') fnName = nameNode.text;
          } else if (isLexDecl) {
            const declarator = node.namedChild(0);
            const nameNode = declarator?.childForFieldName('name');
            if (nameNode?.type === 'identifier') fnName = nameNode.text;
          }
          if (fnName !== null) {
            out.push({
              '@type-binding.name': syntheticCapture('@type-binding.name', anchor, fnName),
              '@type-binding.type': syntheticCapture('@type-binding.type', anchor, retType),
              '@type-binding.return': syntheticCapture('@type-binding.return', anchor, '1'),
            });
          }
        }

        // @type {T} on let/const/var: `/** @type {User} */ const u = getUser()`.
        // Emits annotation-strength binding (source = 'annotation') so it
        // overrides any weaker constructor/alias inference on the same name.
        if (varType !== null) {
          for (const declarator of node.namedChildren) {
            if (declarator === null || declarator.type !== 'variable_declarator') continue;
            const nameNode = declarator.childForFieldName('name');
            if (nameNode === null || nameNode.type !== 'identifier') continue;
            out.push({
              '@type-binding.name': syntheticCapture('@type-binding.name', nameNode, nameNode.text),
              '@type-binding.type': syntheticCapture('@type-binding.type', nameNode, varType),
              '@type-binding.annotation': syntheticCapture(
                '@type-binding.annotation',
                nameNode,
                '1',
              ),
            });
          }
        }

        break;
      }
      sibling = sibling.previousNamedSibling;
    }
  }
}

// ─── Destructuring / for-of / instanceof (shared with TS captures) ───────

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
        const key = fieldNode.childForFieldName('key');
        const value = fieldNode.childForFieldName('value');
        if (key === null || value === null || value.type !== 'identifier') continue;
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
    if (right.type !== 'identifier') continue;
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

// ─── Constructor field type bindings ─────────────────────────────────────

/**
 * Synthesize class-scope type bindings from `this.X = new Y()` assignments
 * inside constructor method bodies.  Covers the traditional ES5+ OOP pattern:
 *
 *   class User {
 *     constructor() {
 *       /** @type {Address} *\/
 *       this.address = new Address();
 *     }
 *   }
 *
 * The emitted `@type-binding.class-field` is hoisted to the Class scope by
 * `tsBindingScopeFor` so that compound-receiver resolution can look up
 * `User.address → Address` when resolving `user.address.save()`.
 *
 * Type source priority:
 *   1. JSDoc `@type {T}` comment immediately preceding the statement
 *   2. `new Y()` constructor inference
 */
function synthesizeConstructorFieldBindings(root: SyntaxNode, out: CaptureMatch[]): void {
  const stack: SyntaxNode[] = [root];
  for (;;) {
    const node = stack.pop();
    if (node === undefined) break;
    for (const child of node.namedChildren) {
      if (child !== null) stack.push(child);
    }
    // Only process constructor method definitions
    if (node.type !== 'method_definition') continue;
    // …and only a CLASS's. An object literal's members are `method_definition`
    // too, so `{ constructor() { this.p = new Alien(); } }` reached here and
    // typed a field on whatever class the hoist walked up to — an object
    // literal's `this` is the literal, never that class's instance (#2807).
    // TypeScript's sibling pattern carries the same constraint in its query
    // nesting; the two must not read one source differently.
    if (node.parent?.type !== 'class_body') continue;
    const nameNode = node.childForFieldName('name');
    if (nameNode?.text !== 'constructor') continue;
    // `static constructor() {}` is legal JavaScript — the reserved-name rule
    // applies to instance methods only — and its `this` is the CLASS object, so
    // `this.p = new Alien()` there writes a static property and must not type
    // the instance field `p`. TypeScript's sibling guard (`isStaticMethodThis`)
    // already drops this shape; without the same test here `.js` and `.ts` read
    // one source differently. `hasKeyword` skips the `name` field, so a method
    // named `static` cannot false-positive.
    if (hasKeyword(node, 'static')) continue;

    const body = node.childForFieldName('body');
    if (body === null) continue;

    for (const stmt of body.namedChildren) {
      if (stmt === null || stmt.type !== 'expression_statement') continue;
      const expr = stmt.namedChild(0);
      if (expr === null || expr.type !== 'assignment_expression') continue;

      const left = expr.childForFieldName('left');
      const right = expr.childForFieldName('right');
      if (left === null || right === null) continue;
      if (left.type !== 'member_expression') continue;

      const obj = left.childForFieldName('object');
      const prop = left.childForFieldName('property');
      if (obj === null || prop === null) continue;
      if (obj.text !== 'this' || prop.type !== 'property_identifier') continue;

      const fieldName = prop.text;

      // Prefer JSDoc @type annotation on the preceding sibling comment.
      let typeName: string | null = null;
      const prevSib: SyntaxNode | null = stmt.previousNamedSibling;
      if (prevSib !== null && prevSib.type === 'comment') {
        const m = /@type\s*\{([^}]+)\}/.exec(prevSib.text);
        if (m?.[1]) typeName = m[1].trim();
      }
      // Fall back to constructor inference from `new Y()`.
      if (typeName === null && right.type === 'new_expression') {
        const ctor = right.childForFieldName('constructor');
        if (ctor !== null && ctor.type === 'identifier') typeName = ctor.text;
      }
      if (typeName === null) continue;

      out.push({
        '@type-binding.name': syntheticCapture('@type-binding.name', prop, fieldName),
        '@type-binding.type': syntheticCapture('@type-binding.type', prop, typeName),
        // Anchor: positioned inside the constructor body so tsBindingScopeFor
        // can walk up from the Function (constructor) scope to the Class scope.
        '@type-binding.class-field': syntheticCapture('@type-binding.class-field', stmt, '1'),
      });
    }
  }
}

// ─── Inheritance references (EXTENDS) ────────────────────────────────────

/**
 * Synthesize `@reference.inherits` captures from JavaScript class heritage so
 * the registry-primary scope-resolution path emits EXTENDS edges (mirrors C#
 * `synthesizeCsharpInheritanceReferences` / C++ `emitCppInheritanceCaptures`).
 * Without this, JS inheritance edges came only from the legacy heritage-capture
 * leg (removed in #942), which the worker pipeline drops for registry-primary
 * languages, yielding 0 inheritance edges in worker mode (issue #1951).
 *
 * Scope is intentionally limited to a `class_declaration`'s `class_heritage`
 * base, matching the legacy JavaScript heritage query's class scope and its
 * supertype shape descriptor (`javascriptHeritageShapes`:
 * `['identifier', 'member_expression']`). JavaScript classes have a single
 * `extends` base and no `implements`, so every emission is an EXTENDS (decided
 * downstream from the resolved target's symbol kind in
 * `preEmitInheritanceEdges`).
 *
 * Bases handled (at parity with the legacy heritage leg, #1951):
 *   - `(identifier)` base (`extends Base`) — bare simple name.
 *   - `(member_expression)` base (`extends ns.Base`, `extends a.b.Base`) —
 *     qualified; reduced to its trailing `property_identifier` (`Base`) so the
 *     V1 `findClassBindingInScope` simple-name contract holds. This mirrors the
 *     TypeScript `terminalTsTypeNameNode` member_expression arm.
 *
 * Deliberately NOT emitted (preserving parity with the legacy query, incl. the
 * #1943 HOC behavior):
 *   - `class` EXPRESSION nodes (legacy captures `class_declaration` only).
 *   - `call_expression` / HOC bases (`extends withFoo(Bar)`) — not a legacy
 *     heritage shape; left to the normal call-resolution path.
 *
 * The `@reference.name` bare-name text emitted for each base equals
 * `normalizeSupertypeName(base)` (the legacy leg's reduction): `Base` → `Base`,
 * `ns.Base` → `Base`, `a.b.Base` → `Base` — keeping the two legs at parity.
 */
function synthesizeJsInheritanceReferences(root: SyntaxNode, out: CaptureMatch[]): void {
  const stack: SyntaxNode[] = [root];
  for (;;) {
    const node = stack.pop();
    if (node === undefined) break;
    for (const child of node.namedChildren) {
      if (child !== null) stack.push(child);
    }

    if (node.type !== 'class_declaration') continue;

    // Find the `class_heritage` child (holds the single `extends` base).
    let heritage: SyntaxNode | null = null;
    for (const child of node.namedChildren) {
      if (child !== null && child.type === 'class_heritage') {
        heritage = child;
        break;
      }
    }
    if (heritage === null) continue;

    // Emit for `(identifier)` and `(member_expression)` bases — matching the
    // legacy heritage shape descriptor (`call_expression` HOC bases excluded).
    for (const base of heritage.namedChildren) {
      if (base === null) continue;
      const nameNode = terminalJsHeritageNameNode(base);
      if (nameNode === null) continue;
      out.push({
        '@reference.inherits': nodeToCapture('@reference.inherits', base),
        '@reference.name': nodeToCapture('@reference.name', nameNode),
      });
    }
  }
}

/** Resolve a JavaScript heritage base node to its bare simple-identifier node.
 *  `Base` (identifier) → `Base`, `ns.Base` / `a.b.Base` (member_expression) →
 *  the trailing `property_identifier` `Base`. Mirrors the TypeScript
 *  `terminalTsTypeNameNode` member_expression arm. Returns null for any other
 *  shape (e.g. `call_expression` HOC bases), which is then skipped — keeping
 *  parity with the legacy `javascriptHeritageShapes` descriptor and
 *  `normalizeSupertypeName`'s reduction of each shape. */
function terminalJsHeritageNameNode(node: SyntaxNode): SyntaxNode | null {
  switch (node.type) {
    case 'identifier':
    // `extends ns.Base` parses as a member_expression whose tail is a
    // `property_identifier` (not an identifier) — treat it as a leaf name.
    case 'property_identifier':
      return node;
    case 'member_expression': {
      // Qualified `ns.Base` / `a.b.Base` → tail identifier `Base`.
      const tail = node.lastNamedChild;
      return tail === null ? null : terminalJsHeritageNameNode(tail);
    }
    default:
      return null;
  }
}

// ─── Main emitter ──────────────────────────────────────────────────────────

export function emitJsScopeCaptures(
  sourceText: string,
  filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  let tree = cachedTree as ReturnType<ReturnType<typeof getJsParser>['parse']> | undefined;
  if (tree !== undefined && !jsCachedTreeMatchesGrammar(tree)) {
    tree = undefined;
  }
  if (tree === undefined) {
    tree = parseSourceSafe(getJsParser(filePath), sourceText, undefined, {
      bufferSize: getTreeSitterBufferSize(sourceText),
    });
  }

  const rawMatches = getJsScopeQuery(filePath).matches(tree.rootNode);
  // Export evidence, read once per file (see `ts-js-export-marker.ts`).
  const exportEvidence = collectEsmExportEvidence(tree.rootNode, filePath);
  const out: CaptureMatch[] = [];

  for (const m of rawMatches) {
    const grouped: Record<string, Capture> = {};
    // Parallel tag -> captured SyntaxNode map. The query hands us each matched
    // node as c.node, so anchors resolve by walking up from the captured node
    // (findSelfOrAncestorOfType[s]) instead of re-deriving them with
    // findNodeAtRange(tree.rootNode, ...) per match — the O(matches x N)
    // root-walk fixed for go #1915 / python #1918 / csharp, mirrored here
    // (mirrors typescript/captures.ts groupedNodes).
    const groupedNodes: Record<string, SyntaxNode> = {};
    for (const c of m.captures) {
      const tag = '@' + c.name;
      grouped[tag] = nodeToCapture(tag, c.node);
      groupedNodes[tag] = c.node;
    }
    if (Object.keys(grouped).length === 0) continue;

    // Decompose ESM import_statement / re-export export_statement.
    if (grouped['@import.statement'] !== undefined) {
      const stmtCapture = grouped['@import.statement'];
      const stmtNode =
        findSelfOrAncestorOfTypes(groupedNodes['@import.statement'], [
          'import_statement',
          'export_statement',
        ]) ??
        findNodeAtRange(tree.rootNode, stmtCapture.range, 'import_statement') ??
        findNodeAtRange(tree.rootNode, stmtCapture.range, 'export_statement');
      if (stmtNode !== null) {
        const decomposed = splitImportStatement(stmtNode);
        for (const d of decomposed) out.push(d);
      }
      continue;
    }

    // Decompose dynamic import() calls.
    if (grouped['@import.dynamic'] !== undefined) {
      const dynCapture = grouped['@import.dynamic'];
      const callNode =
        findSelfOrAncestorOfType(groupedNodes['@import.dynamic'], 'call_expression') ??
        findNodeAtRange(tree.rootNode, dynCapture.range, 'call_expression');
      if (callNode !== null) {
        const decomposed = splitImportStatement(callNode);
        for (const d of decomposed) out.push(d);
      }
      continue;
    }

    // Filter @reference.read.member false-positives.
    // See the matching filter in typescript/captures.ts: a `statement_block`
    // that IS a function body duplicates the enclosing Function scope, and
    // keeping it puts a redundant level inside every function for every
    // scope-chain walk to step through (~6% of analyze wall time, measured).
    if (grouped['@scope.block'] !== undefined) {
      const blockNode = groupedNodes['@scope.block'];
      const parentType = blockNode?.parent?.type;
      if (parentType !== undefined && JS_FUNCTION_BODY_OWNER_TYPES.has(parentType)) continue;
      if (blockNode === undefined || !blockDeclaresBinding(blockNode)) continue;
    }

    if (grouped['@reference.read.member'] !== undefined) {
      const anchor = grouped['@reference.read.member'];
      const memberNode =
        findSelfOrAncestorOfType(groupedNodes['@reference.read.member'], 'member_expression') ??
        findNodeAtRange(tree.rootNode, anchor.range, 'member_expression');
      if (memberNode === null || !shouldEmitReadMember(memberNode)) {
        continue;
      }
    }

    // A `static` class field is a member of the class object, not of instances,
    // so `static p = new Wrong()` must not retype the `p = new Right()` beside
    // it — the two land on one Class scope and the later match wins the `>=`
    // tie-break. Shared with TypeScript (`isStaticClassFieldBinding`), which is
    // where the reasoning and the grammar evidence live; the two languages read
    // the same source and must not read it differently. JavaScript has no type
    // annotations, so `field_definition` initializers are the only class-field
    // type binding its query emits and `@type-binding.constructor` is the only
    // anchor that can carry the modifier.
    if (
      isStaticClassFieldBinding(
        groupedNodes['@type-binding.constructor'],
        JS_CLASS_FIELD_DEFINITION_TYPES,
      )
    ) {
      continue;
    }

    // #1876: drop @declaration.function for array higher-order-method
    // callbacks (`const x = arr.map(a => …)`). The HOC-wrapped-arrow
    // pattern matches them, but the binding holds a value, not a callable.
    // The binding keeps its separate @declaration.const / .variable match,
    // and the arrow's own @scope.function match (a different pattern) is
    // untouched, so inner-call attribution falls through to the enclosing
    // scope instead of a phantom Function.
    const fnDeclAnchor = grouped['@declaration.function'];
    if (fnDeclAnchor !== undefined) {
      const arrowNode = findFunctionNode(
        tree.rootNode,
        fnDeclAnchor.range,
        groupedNodes['@declaration.function'],
      );
      if (arrowNode !== null && isArrayMethodCallbackArrow(arrowNode)) {
        continue;
      }
      if (arrowNode !== null && isBlockedDefaultExportHoc(arrowNode)) {
        continue;
      }
      // #2723 — see the matching filter in `typescript/captures.ts`.
      if (arrowNode !== null && isShadowedCjsExportAssignment(arrowNode, tree.rootNode)) {
        continue;
      }
      // #2723 follow-up: the member-assignment rule matches ANY identifier
      // receiver so an `exports` alias can be recognised. A receiver that is
      // not the exports object declares nothing at module scope — drop it, or
      // every `obj.handler = fn` would bind `handler` as a module symbol.
      if (arrowNode !== null && isUnexportedMemberAssignmentValue(arrowNode, tree.rootNode)) {
        continue;
      }

      // A `this.X = fn` declares a module symbol ONLY at the top level of a
      // CommonJS file, where `this` is `module.exports`. Inside a function it
      // is an instance member (a Method with an owner, no module binding), and
      // in ESM top-level `this` is undefined and exports nothing.
      if (arrowNode !== null && isUndeclarableThisMemberValue(arrowNode, tree.rootNode)) {
        continue;
      }
    }

    if (fnDeclAnchor !== undefined) {
      const fnNode = findFunctionNode(
        tree.rootNode,
        fnDeclAnchor.range,
        groupedNodes['@declaration.function'],
      );
      if (fnNode !== null && isDefaultExportHocFunctionNode(fnNode)) {
        grouped['@declaration.name'] = syntheticCapture(
          '@declaration.name',
          fnNode,
          deriveDefaultExportHocName(filePath),
        );
      }
    }

    // Synthesize arity metadata on function-like declarations.
    const declAnchor = pickFirstDefined(grouped, FUNCTION_DECL_TAGS);
    const declAnchorNode = pickFirstNode(groupedNodes, FUNCTION_DECL_TAGS);
    if (declAnchor !== undefined) {
      const fnNode = findFunctionNode(tree.rootNode, declAnchor.range, declAnchorNode);
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

    // Synthesize @reference.arity on callsites. Skip JSX element anchors: a JSX
    // component used as a call argument (e.g. `render(<Foo .../>)`) is itself a
    // @reference.call.* anchor, and the ascent below would climb into the
    // enclosing call_expression and mis-attribute that call's arity to the
    // component. A JSX component reference has no call arity here — this restores
    // the pre-#1951 range-based behavior (no call_expression at the JSX range).
    // The guard lives at this call site, not inside findSelfOrAncestorOfTypes,
    // which is also used by the import-statement and function-scope ascents.
    const callAnchor = pickFirstDefined(grouped, CALL_TAGS);
    const callAnchorNode = pickFirstNode(groupedNodes, CALL_TAGS);
    const anchorIsJsxElement =
      callAnchorNode?.type === 'jsx_self_closing_element' ||
      callAnchorNode?.type === 'jsx_opening_element';
    if (
      callAnchor !== undefined &&
      grouped['@reference.arity'] === undefined &&
      !anchorIsJsxElement
    ) {
      const callNode =
        findSelfOrAncestorOfTypes(callAnchorNode, ['call_expression', 'new_expression']) ??
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
        grouped['@reference.parameter-types'] = syntheticCapture(
          '@reference.parameter-types',
          callNode,
          JSON.stringify(args.map(inferArgType)),
        );
      }
    }

    // Structural receiver chain for a call whose receiver is itself an
    // expression, so resolution can type it by folding over structure
    // instead of re-parsing the receiver's source text. Self-gating: a
    // non-call match, an absent receiver, or a chain with no nameable base
    // all leave `grouped` untouched.
    synthesizeReceiverChainCapture(grouped, groupedNodes['@reference.receiver']);
    // `@declaration.is-exported`: a verdict for every declaration the file's
    // export surface can decide (see `ts-js-export-marker.ts`); nothing where
    // it cannot, because absence is the honest answer there.
    const declNameNode = groupedNodes['@declaration.name'];
    if (exportEvidence !== undefined && declNameNode !== undefined) {
      const verdict = esmExportVerdict(declNameNode, exportEvidence);
      if (verdict !== undefined) {
        grouped['@declaration.is-exported'] = syntheticCapture(
          '@declaration.is-exported',
          declNameNode,
          verdict ? 'true' : 'false',
        );
      }
    }
    out.push(grouped);

    // Synthesize `this` receiver type-bindings on class member functions.
    const scopeFnAnchor = grouped['@scope.function'];
    if (scopeFnAnchor !== undefined) {
      const fnNode = findFunctionNode(
        tree.rootNode,
        scopeFnAnchor.range,
        groupedNodes['@scope.function'],
      );
      if (fnNode !== null) {
        const synth = synthesizeTsReceiverBinding(fnNode);
        if (synth !== null) out.push(synth);
      }
    }
  }

  // Post-query synthesis passes.
  synthesizeCjsImports(tree.rootNode, out);
  synthesizeCjsModuleExports(tree.rootNode, filePath, out);
  synthesizeJsDocBindings(tree.rootNode, out);
  synthesizeConstructorFieldBindings(tree.rootNode, out);
  synthesizeDestructuringBindings(tree.rootNode, out);
  synthesizeForOfMapTupleBindings(tree.rootNode, out);
  synthesizeInstanceofNarrowings(tree.rootNode, out);
  synthesizeJsInheritanceReferences(tree.rootNode, out);
  out.push(...synthesizeCallableFlowCaptures(tree.rootNode, JS_CALLABLE_CAPTURE_OPTIONS));

  return out;
}
