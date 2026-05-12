/**
 * `emitScopeCaptures` for PHP (RFC #909 Ring 3 LANG-php).
 *
 * Drives the PHP scope query against tree-sitter-php and groups raw
 * matches into `CaptureMatch[]` for the central extractor. Layers two
 * synthesized streams on top:
 *
 *   1. **Decomposed use declarations** — each `namespace_use_declaration`
 *      is re-emitted with `@import.kind/source/name/alias` markers so
 *      `interpretPhpImport` can recover the ParsedImport shape without
 *      re-parsing raw text. Grouped uses fan out to one match per clause.
 *
 *   2. **Receiver-binding synthesis** — `$this` and `parent` type-bindings
 *      are synthesized on every non-static method entry. PHP's grammar
 *      does not express "implicit receiver of a non-static class method"
 *      via a clean `.scm` pattern, so we walk up the AST in code.
 *
 *   3. **Arity metadata synthesis** — `@declaration.parameter-count` /
 *      `@declaration.required-parameter-count` / `@declaration.parameter-types`
 *      are synthesized on function-like declarations so the registry can
 *      narrow overloads.
 *
 *   4. **PHPDoc synthesis** — @param and @return annotations in comment
 *      nodes preceding method/function declarations are extracted and emitted
 *      as `@type-binding.parameter` and `@type-binding.return` matches.
 *
 *   5. **Foreach loop synthesis** — `foreach ($users as $user)` emits
 *      a `@type-binding.alias` match binding the loop variable to the
 *      element type of the iterable (resolved from PHPDoc or scopeEnv).
 *
 * Pure given the input source text. No I/O, no globals consulted.
 */

import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { findNodeAtRange, nodeToCapture, syntheticCapture } from '../../utils/ast-helpers.js';
import { splitNamespaceUseDeclaration } from './import-decomposer.js';
import { computePhpArityMetadata } from './arity-metadata.js';
import { synthesizePhpReceiverBinding } from './receiver-binding.js';
import { getPhpParser, getPhpScopeQuery } from './query.js';
import { recordCacheHit, recordCacheMiss } from './cache-stats.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';

type SyntaxNode = ReturnType<ReturnType<typeof getPhpParser>['parse']>['rootNode'];

/** Declaration anchors that carry function-like arity metadata. */
const FUNCTION_DECL_TAGS = ['@declaration.method', '@declaration.function'] as const;

/** tree-sitter-php node types that the method extractor accepts. */
const FUNCTION_NODE_TYPES = [
  'method_declaration',
  'function_definition',
  'anonymous_function',
  'arrow_function',
] as const;

export function emitPhpScopeCaptures(
  sourceText: string,
  _filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  // Skip the parse when the caller already produced a Tree for this source.
  // The cachedTree parameter is typed as `unknown` at the LanguageProvider
  // contract layer; cast here at the use site.
  let tree = cachedTree as ReturnType<ReturnType<typeof getPhpParser>['parse']> | undefined;
  if (tree === undefined) {
    tree = parseSourceSafe(getPhpParser(), sourceText, undefined, {
      bufferSize: getTreeSitterBufferSize(sourceText),
    });
    recordCacheMiss();
  } else {
    recordCacheHit();
  }

  const rawMatches = getPhpScopeQuery().matches(tree.rootNode);
  const out: CaptureMatch[] = [];

  // Pre-scan: collect anchor node IDs of property_declaration nodes already
  // matched by the typed @declaration.property pattern (query.ts ~lines 95–98).
  // The untyped @declaration.variable catch-all (query.ts ~lines 101–103) is
  // intentionally loose — it has no `type:` constraint, so tree-sitter also
  // matches it against typed property declarations and emits a second capture
  // for the same property_declaration anchor. Graph-level def-id collision
  // currently masks the duplicate at the node-emit layer, but the catch-all
  // capture still flows through scope-binding / name-keyed registries with a
  // `$`-prefixed name that the typed branch's `$`-strip never normalizes —
  // a known vector for receiver-binding lookup pollution. The two patterns
  // produce separate rawMatches entries with separate `grouped` maps, so the
  // dedup has to be cross-match: build the set here, then skip
  // @declaration.variable matches whose anchor is in it (loop below).
  const typedPropertyAnchorIds = new Set<number>();
  for (const m of rawMatches) {
    for (const c of m.captures) {
      if (c.name === 'declaration.property') {
        typedPropertyAnchorIds.add(c.node.id);
        break;
      }
    }
  }

  for (const m of rawMatches) {
    // Group captures by their tag name. Tree-sitter strips the leading
    // `@`; we put it back so the central extractor's prefix lookups work.
    const grouped: Record<string, Capture> = {};
    for (const c of m.captures) {
      const tag = '@' + c.name;
      grouped[tag] = nodeToCapture(tag, c.node);
    }
    if (Object.keys(grouped).length === 0) continue;

    // Cross-match dedup for the typed-property double-match described above:
    // skip @declaration.variable matches whose anchor was already captured as
    // @declaration.property in an earlier match.
    if (grouped['@declaration.variable'] !== undefined) {
      const varCap = m.captures.find((c) => c.name === 'declaration.variable');
      if (varCap !== undefined && typedPropertyAnchorIds.has(varCap.node.id)) continue;
    }

    // Normalize PHP property declarations: strip leading `$` from
    // `@declaration.name` for @declaration.property matches. PHP stores
    // field names WITHOUT the `$` sigil in the graph so that member access
    // lookups like `$user->address` can find the property named `address`
    // (not `$address`). `@type-binding.annotation` already strips `$` in
    // `interpretPhpTypeBinding`; this mirrors that for the declaration side.
    //
    // Only applies to `@declaration.property` — typed class properties and
    // constructor-promoted parameters. Untyped `@declaration.variable` keeps
    // its `$` prefix (those defs are Variable type and not in the field
    // registry, so their name doesn't affect member lookup).
    if (
      grouped['@declaration.property'] !== undefined &&
      grouped['@declaration.name'] !== undefined
    ) {
      const nameCap = grouped['@declaration.name'];
      if (nameCap.text.startsWith('$')) {
        grouped['@declaration.name'] = { ...nameCap, text: nameCap.text.slice(1) };
      }
    }

    // Normalize PHP receiver expressions so the compound-receiver resolver
    // can walk chains expressed with `->` (PHP) as if they used `.` (the
    // resolver's canonical separator). Without this, `$user->address->save()`
    // has receiver text `$user->address` — the resolver sees no `.` separator,
    // treats it as a bare identifier, and cannot walk field types.
    //
    // Transformation applied to `@reference.receiver` captures:
    //   1. Replace `->` with `.`           ($user->address → $user.address)
    //   2. Strip leading `$` from each segment ($user.address → user.address)
    //   3. Strip trailing `?` on null-safe receivers ($user? → user)
    //
    // This is a PHP-local normalization — no shared pipeline code is changed.
    if (grouped['@reference.receiver'] !== undefined) {
      const recvCap = grouped['@reference.receiver']!;
      const normalized = normalizePhpReceiver(recvCap.text);
      if (normalized !== recvCap.text) {
        grouped['@reference.receiver'] = { ...recvCap, text: normalized };
      }
    }

    // Normalize static property write: strip leading `$` from `@reference.name`
    // so `User::$count` resolves to property `count` (stored without `$` in graph).
    if (grouped['@reference.write.static'] !== undefined) {
      const nameCap = grouped['@reference.name'];
      if (nameCap !== undefined && nameCap.text.startsWith('$')) {
        grouped['@reference.name'] = {
          ...nameCap,
          text: nameCap.text.slice(1),
        };
      }
      // Re-tag as @reference.write.member so downstream passes see a uniform write kind.
      grouped['@reference.write.member'] = grouped['@reference.write.static']!;
      delete grouped['@reference.write.static'];
    }

    // Decompose each `namespace_use_declaration` so `interpretPhpImport`
    // sees the kind/source/name/alias markers it consumes.
    if (grouped['@import.statement'] !== undefined) {
      const stmtCapture = grouped['@import.statement'];
      const stmtNode = findNodeAtRange(
        tree.rootNode,
        stmtCapture.range,
        'namespace_use_declaration',
      );
      if (stmtNode !== null) {
        const decomposed = splitNamespaceUseDeclaration(stmtNode);
        if (decomposed.length > 0) {
          for (const d of decomposed) out.push(d);
          continue;
        }
      }
      // Defensive fallback: emit the raw match.
      out.push(grouped);
      continue;
    }

    // Synthesize `$this` / `parent` receiver type-bindings on every
    // non-static method-like. Mirrors C#'s `this` / `base` synthesis.
    if (grouped['@scope.function'] !== undefined) {
      out.push(grouped);
      const anchor = grouped['@scope.function']!;
      const fnNode = findFunctionNode(tree.rootNode, anchor.range);
      if (fnNode !== null) {
        for (const synth of synthesizePhpReceiverBinding(fnNode)) {
          out.push(synth);
        }
        // Synthesize PHPDoc @param and @return type bindings for this fn.
        for (const synth of synthesizePhpDocBindings(fnNode)) {
          out.push(synth);
        }
        // Synthesize foreach loop variable bindings inside this fn body.
        for (const synth of synthesizeForeachBindings(fnNode)) {
          out.push(synth);
        }
      }
      continue;
    }

    // Synthesize arity metadata on function-like declarations so the
    // registry can narrow overloads.
    const declTag = FUNCTION_DECL_TAGS.find((t) => grouped[t] !== undefined);
    if (declTag !== undefined) {
      const anchor = grouped[declTag]!;
      const fnNode = findFunctionNode(tree.rootNode, anchor.range);
      if (fnNode !== null) {
        const arity = computePhpArityMetadata(fnNode);
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

    // Synthesize `@reference.arity` on every call site so the registry's
    // arity filter can narrow overloads. Count the `argument` children of
    // the backing `arguments` node. Mirrors C#'s pattern (csharp/captures.ts
    // lines 149-186). PHP needs this for arity-based dispatch (Cluster H).
    const callTag = (
      ['@reference.call.free', '@reference.call.member', '@reference.call.constructor'] as const
    ).find((t) => grouped[t] !== undefined);
    if (callTag !== undefined && grouped['@reference.arity'] === undefined) {
      const anchor = grouped[callTag]!;
      const callNode =
        findNodeAtRange(tree.rootNode, anchor.range, 'function_call_expression') ??
        findNodeAtRange(tree.rootNode, anchor.range, 'member_call_expression') ??
        findNodeAtRange(tree.rootNode, anchor.range, 'nullsafe_member_call_expression') ??
        findNodeAtRange(tree.rootNode, anchor.range, 'scoped_call_expression') ??
        findNodeAtRange(tree.rootNode, anchor.range, 'object_creation_expression');
      if (callNode !== null) {
        const argList = callNode.childForFieldName('arguments');
        const args: SyntaxNode[] = [];
        if (argList !== null) {
          for (let i = 0; i < argList.namedChildCount; i++) {
            const child = argList.namedChild(i);
            if (child !== null && child.type === 'argument') args.push(child);
          }
        }
        grouped['@reference.arity'] = syntheticCapture(
          '@reference.arity',
          callNode,
          String(args.length),
        );
        // Infer argument types from literal nodes for type-based narrowing.
        // Non-literal arguments emit empty string ("unknown" = any-match).
        const argTypes = args.map((arg) => inferPhpArgType(arg));
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

/** Find the first PHP function-like node at the given range. */
function findFunctionNode(rootNode: SyntaxNode, range: Capture['range']): SyntaxNode | null {
  for (const nodeType of FUNCTION_NODE_TYPES) {
    const n = findNodeAtRange(rootNode, range, nodeType);
    if (n !== null) return n as SyntaxNode;
  }
  return null;
}

// ─── PHP receiver normalization ──────────────────────────────────────────────

/**
 * Normalize a PHP receiver expression so the language-agnostic
 * compound-receiver resolver (which splits on `.`) can walk field-type chains.
 *
 * The compound-receiver resolver:
 *   - splits on `.` to get chain segments
 *   - looks up the first segment in `typeBindings` (keyed with `$` for variables)
 *   - walks subsequent segments as field names (stored without `$` in the graph)
 *
 * Transformation:
 *   1. Replace `->` and `?->` with `.` so the resolver's splitter works
 *   2. Strip any bare `?` fragment left by null-safe chain ends
 *   3. Strip `$` from all segments EXCEPT the first (which is a variable
 *      and must keep `$` for typeBindings lookup — e.g. `$user → User`)
 *
 * Examples:
 *   `$user`                 → `$user`         (bare variable — unchanged)
 *   `$user->address`        → `$user.address`
 *   `$user->address->city`  → `$user.address.city`
 *   `$user?`                → `$user`         (null-safe trailing `?` stripped)
 *   `$this`                 → `$this`         (receiverBinding uses `$this`)
 *   `parent`                → `parent`        (super-receiver check)
 */
function normalizePhpReceiver(raw: string): string {
  // Keep `$this`, `parent`, and `self` as-is.
  if (raw === '$this' || raw === 'parent' || raw === 'self') return raw;

  // Replace `?->` (null-safe) and plain `->` with `.`.
  let text = raw.replace(/\?->/g, '.').replace(/->/g, '.');
  // Strip a trailing `?` (null-safe fragment on the last object node).
  text = text.replace(/\?$/, '');
  // Collapse any doubled dots from `?->` where `?` was on its own.
  text = text.replace(/\.{2,}/g, '.');
  // Strip trailing dot.
  text = text.replace(/\.$/, '');

  // Split on `.` and strip `$` from all segments EXCEPT the first.
  // The first segment is a PHP variable (typeBinding key includes `$`).
  // Subsequent segments are property/method names (stored without `$`).
  const segments = text.split('.');
  for (let i = 1; i < segments.length; i++) {
    const s = segments[i];
    if (s !== undefined && s.startsWith('$')) segments[i] = s.slice(1);
  }
  return segments.join('.');
}

// ─── PHP argument type inference ─────────────────────────────────────────────

/**
 * Infer the PHP type of a call argument from its literal shape.
 * Returns an empty string for non-literals (treated as "unknown" = any-match).
 * Mirrors C#'s `inferArgType` helper.
 */
function inferPhpArgType(argNode: SyntaxNode): string {
  // argument node wraps the actual expression
  const expr = argNode.firstNamedChild ?? argNode;
  switch (expr.type) {
    case 'integer':
      return 'int';
    case 'float':
      return 'float';
    case 'string':
    case 'encapsed_string':
    case 'heredoc':
    case 'nowdoc':
      return 'string';
    case 'boolean':
    case 'true':
    case 'false':
      return 'bool';
    case 'null':
      return 'null';
    default:
      return '';
  }
}

// ─── PHPDoc synthesis ─────────────────────────────────────────────────────────

/** PHP 8+ attribute_list nodes that appear between PHPDoc and method. */
const SKIP_SIBLING_TYPES = new Set(['attribute_list', 'attribute', 'comment']);

/** Regex for PHPDoc @param: standard `@param Type $name` */
const PHPDOC_PARAM_RE = /@param\s+(\S+)\s+\$(\w+)/g;
/** Regex for PHPDoc @param: alternate `@param $name Type` */
const PHPDOC_PARAM_ALT_RE = /@param\s+\$(\w+)\s+(\S+)/g;
/** Regex for PHPDoc @return: `@return Type` */
const PHPDOC_RETURN_RE = /@return\s+(\S+)/;

/**
 * Normalize a PHP type string to a simple class name for binding purposes.
 * Returns null for primitives or uninformative types.
 * Mirrors `normalizePhpType` in `interpret.ts` but operates on raw PHPDoc strings.
 */
function normalizePhpDocType(raw: string): string | null {
  let type = raw.trim();
  // Strip nullable prefix
  if (type.startsWith('?')) type = type.slice(1).trim();
  // Strip array suffix: User[] → User
  if (type.endsWith('[]')) type = type.slice(0, -2).trim();
  // Strip union with null/false/void
  if (type.includes('|')) {
    const parts = type
      .split('|')
      .map((p) => p.trim())
      .filter((p) => p !== 'null' && p !== 'false' && p !== 'void' && p !== 'mixed' && p !== '');
    if (parts.length !== 1) return null;
    type = parts[0];
  }
  // Strip intersection: take first part
  if (type.includes('&')) {
    const first = type.split('&')[0].trim();
    if (first === '') return null;
    type = first;
  }
  // Strip generic wrapper: Collection<User> → User
  const genericMatch = type.match(/^\w[\w\\]*\s*<([^,<>]+)>$/);
  if (genericMatch) {
    type = genericMatch[1].trim();
    // Strip array suffix again inside generic
    if (type.endsWith('[]')) type = type.slice(0, -2).trim();
  }
  // Strip namespace qualifier: \App\Models\User → User
  if (type.includes('\\')) {
    const segs = type.split('\\').filter(Boolean);
    type = segs[segs.length - 1] ?? type;
  }
  // Reject primitives
  if (PHP_PRIMITIVES.has(type.toLowerCase())) return null;
  // Must be a simple identifier
  if (!/^\w+$/.test(type)) return null;
  return type;
}

const PHP_PRIMITIVES = new Set([
  'int',
  'integer',
  'float',
  'double',
  'string',
  'bool',
  'boolean',
  'array',
  'object',
  'callable',
  'iterable',
  'null',
  'void',
  'never',
  'mixed',
  'false',
  'true',
  'self',
  'static',
  'parent',
]);

/**
 * Collect comment text from siblings immediately before `fnNode`.
 * Skips PHP 8+ attribute_list nodes.
 */
function collectPrecedingComments(fnNode: SyntaxNode): string {
  const texts: string[] = [];
  let sibling = fnNode.previousSibling;
  while (sibling !== null) {
    if (sibling.type === 'comment') {
      texts.unshift(sibling.text);
    } else if (sibling.isNamed && !SKIP_SIBLING_TYPES.has(sibling.type)) {
      break;
    }
    sibling = sibling.previousSibling;
  }
  return texts.join('\n');
}

/**
 * Synthesize PHPDoc @param and @return type-binding captures for a
 * method_declaration or function_definition node.
 *
 * PHPDoc @param Type $name → `@type-binding.parameter` match (anchored at fn body/return_type).
 * PHPDoc @return Type → `@type-binding.return` match (anchored at fn name).
 */
function synthesizePhpDocBindings(fnNode: SyntaxNode): CaptureMatch[] {
  if (fnNode.type !== 'method_declaration' && fnNode.type !== 'function_definition') return [];

  const commentBlock = collectPrecedingComments(fnNode);
  if (commentBlock === '') return [];

  const out: CaptureMatch[] = [];

  // Anchor for parameter type-bindings: the function body (or return_type as fallback).
  // The binding must be inside the function scope so it's visible to body statements.
  const bodyNode = fnNode.childForFieldName('body');
  const anchorNode = bodyNode ?? fnNode;

  // ── @param annotations ────────────────────────────────────────────────────
  PHPDOC_PARAM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  const seenParams = new Set<string>();

  while ((m = PHPDOC_PARAM_RE.exec(commentBlock)) !== null) {
    const rawType = m[1];
    const paramName = '$' + m[2];
    const typeName = normalizePhpDocType(rawType);
    if (typeName === null) continue;
    seenParams.add(paramName);
    out.push({
      '@type-binding.parameter': nodeToCapture('@type-binding.parameter', anchorNode),
      '@type-binding.name': syntheticCapture('@type-binding.name', anchorNode, paramName),
      '@type-binding.type': syntheticCapture('@type-binding.type', anchorNode, typeName),
    });
  }

  // Also check alternate PHPDoc order: @param $name Type
  PHPDOC_PARAM_ALT_RE.lastIndex = 0;
  while ((m = PHPDOC_PARAM_ALT_RE.exec(commentBlock)) !== null) {
    const paramName = '$' + m[1];
    if (seenParams.has(paramName)) continue; // standard format takes priority
    const rawType = m[2];
    const typeName = normalizePhpDocType(rawType);
    if (typeName === null) continue;
    out.push({
      '@type-binding.parameter': nodeToCapture('@type-binding.parameter', anchorNode),
      '@type-binding.name': syntheticCapture('@type-binding.name', anchorNode, paramName),
      '@type-binding.type': syntheticCapture('@type-binding.type', anchorNode, typeName),
    });
  }

  // ── @return annotation ────────────────────────────────────────────────────
  const returnMatch = PHPDOC_RETURN_RE.exec(commentBlock);
  if (returnMatch !== null) {
    const rawType = returnMatch[1];
    const typeName = normalizePhpDocType(rawType);
    if (typeName !== null) {
      // @return bindings must be anchored at the method name and hoisted to Module scope
      // by phpBindingScopeFor (which checks for @type-binding.return presence).
      // Use the function_definition/method_declaration node itself as the anchor — it
      // coincides with the innermost scope's range, so auto-hoist kicks in.
      const nameNode = fnNode.childForFieldName('name') ?? fnNode;
      out.push({
        '@type-binding.return': nodeToCapture('@type-binding.return', fnNode),
        '@type-binding.name': syntheticCapture('@type-binding.name', nameNode, nameNode.text),
        '@type-binding.type': syntheticCapture('@type-binding.type', nameNode, typeName),
      });
    }
  }

  return out;
}

// ─── Foreach synthesis ───────────────────────────────────────────────────────

/**
 * Walk all `foreach_statement` nodes inside `fnNode` and synthesize
 * `@type-binding.alias` captures binding the loop variable to the
 * element type of the iterable.
 *
 * Supports:
 *   - `foreach ($users as $user)` — simple iterable variable
 *   - `foreach ($users as $k => $user)` — key→value pair
 *   - `foreach ($this->users as $user)` — member access iterable
 *   - `foreach (getUsers() as $user)` — NOT yet supported (needs return type)
 *
 * The element type is resolved by:
 *   1. Looking up the iterable name in PHPDoc @param bindings already
 *      collected for this function (passed via typeBindingsByName).
 *   2. Direct resolution when iterable's env type IS the element type
 *      (because PHPDoc normalizes `User[]` → `User` already).
 */
function synthesizeForeachBindings(fnNode: SyntaxNode): CaptureMatch[] {
  if (
    fnNode.type !== 'method_declaration' &&
    fnNode.type !== 'function_definition' &&
    fnNode.type !== 'anonymous_function' &&
    fnNode.type !== 'arrow_function'
  ) {
    return [];
  }

  const out: CaptureMatch[] = [];

  // Build a mini type map from the function's PHPDoc @param annotations.
  // This is re-parsed here (not cached from synthesizePhpDocBindings) for simplicity;
  // the cost is negligible given the small comment sizes.
  const commentBlock = collectPrecedingComments(fnNode);
  const paramTypeMap = buildParamTypeMap(commentBlock);

  // Walk the function body for foreach_statement nodes.
  const bodyNode = fnNode.childForFieldName('body');
  if (bodyNode === null) return [];
  collectForeachBindings(bodyNode, fnNode, paramTypeMap, out);

  return out;
}

/** Build a map of `$paramName → elementTypeName` from PHPDoc @param in a comment block. */
function buildParamTypeMap(commentBlock: string): Map<string, string> {
  const map = new Map<string, string>();
  if (commentBlock === '') return map;

  PHPDOC_PARAM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PHPDOC_PARAM_RE.exec(commentBlock)) !== null) {
    const rawType = m[1];
    const paramName = '$' + m[2];
    const typeName = normalizePhpDocType(rawType);
    if (typeName !== null) map.set(paramName, typeName);
  }
  PHPDOC_PARAM_ALT_RE.lastIndex = 0;
  while ((m = PHPDOC_PARAM_ALT_RE.exec(commentBlock)) !== null) {
    const paramName = '$' + m[1];
    if (map.has(paramName)) continue;
    const rawType = m[2];
    const typeName = normalizePhpDocType(rawType);
    if (typeName !== null) map.set(paramName, typeName);
  }
  return map;
}

/**
 * Walk a subtree and collect foreach_statement bindings.
 * Recursively descends into all child nodes.
 */
function collectForeachBindings(
  node: SyntaxNode,
  fnNode: SyntaxNode,
  paramTypeMap: Map<string, string>,
  out: CaptureMatch[],
): void {
  if (node.type === 'foreach_statement') {
    const synth = synthesizeSingleForeach(node, fnNode, paramTypeMap);
    if (synth !== null) out.push(synth);
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child !== null) {
      collectForeachBindings(child, fnNode, paramTypeMap, out);
    }
  }
}

/**
 * Synthesize a single `@type-binding.alias` match for a `foreach_statement`.
 *
 * AST structure for foreach_statement (tree-sitter-php):
 *   foreach ( <iterable> as <value_or_pair> ) <body>
 * Named children (excluding body): first = iterable, second = value or pair.
 */
function synthesizeSingleForeach(
  foreachNode: SyntaxNode,
  fnNode: SyntaxNode,
  paramTypeMap: Map<string, string>,
): CaptureMatch | null {
  // Collect non-body named children: [iterable, value_or_pair]
  const bodyNode = foreachNode.childForFieldName('body');
  const children: SyntaxNode[] = [];
  for (let i = 0; i < foreachNode.namedChildCount; i++) {
    const child = foreachNode.namedChild(i);
    if (child !== null && child !== bodyNode) children.push(child);
  }
  if (children.length < 2) return null;

  const iterableNode = children[0];
  const valueOrPair = children[1];

  // Determine the loop variable node
  let loopVarNode: SyntaxNode;
  if (valueOrPair.type === 'pair') {
    // $key => $value — use the last named child of the pair
    const lastChild = valueOrPair.namedChild(valueOrPair.namedChildCount - 1);
    if (lastChild === null) return null;
    loopVarNode =
      lastChild.type === 'by_ref' ? (lastChild.firstNamedChild ?? lastChild) : lastChild;
  } else {
    loopVarNode =
      valueOrPair.type === 'by_ref' ? (valueOrPair.firstNamedChild ?? valueOrPair) : valueOrPair;
  }

  // Loop variable must be a variable_name
  if (loopVarNode.type !== 'variable_name') return null;
  const loopVarName = loopVarNode.text; // e.g. '$user'

  // Resolve the element type from the iterable
  let elementType: string | null = null;

  if (iterableNode.type === 'variable_name') {
    // foreach ($users as $user) — look up $users in param map
    const iterableName = iterableNode.text; // e.g. '$users'
    elementType = paramTypeMap.get(iterableName) ?? null;
  } else if (iterableNode.type === 'member_access_expression') {
    // foreach ($this->users as $user) — property name is the field
    const propNameNode = iterableNode.childForFieldName('name');
    if (propNameNode !== null) {
      // Property stored with $ prefix in paramTypeMap (rare for $this->prop patterns)
      // Try both with and without $ prefix
      const propKey = '$' + propNameNode.text;
      elementType = paramTypeMap.get(propKey) ?? null;
      if (elementType === null) {
        // Try to find the property type from the enclosing class
        elementType = findClassPropertyElementType(iterableNode, fnNode);
      }
    }
  } else if (iterableNode.type === 'function_call_expression') {
    // foreach (getUsers() as $user) — use the function name as a type alias.
    // The function's @return annotation produces a @type-binding.return binding
    // in the Module scope (e.g. getUsers → User). The scope-extractor's
    // followChainedRef will resolve $user → getUsers → User.
    const funcNode = iterableNode.childForFieldName('function');
    if (funcNode !== null && funcNode.type === 'name') {
      elementType = funcNode.text; // e.g. 'getUsers' — chain will be resolved later
    }
  } else if (iterableNode.type === 'member_call_expression') {
    // foreach ($this->getUsers() as $user) — use the method name as a type alias.
    const methodNameNode = iterableNode.childForFieldName('name');
    if (methodNameNode !== null) {
      elementType = methodNameNode.text; // e.g. 'getUsers'
    }
  }

  if (elementType === null) return null;

  // Anchor the binding inside the foreach body so it's scoped to the loop.
  const anchorNode = bodyNode ?? foreachNode;

  return {
    '@type-binding.alias': nodeToCapture('@type-binding.alias', anchorNode),
    '@type-binding.name': syntheticCapture('@type-binding.name', anchorNode, loopVarName),
    '@type-binding.type': syntheticCapture('@type-binding.type', anchorNode, elementType),
  };
}

/**
 * Try to find the element type for `$this->property` member access by walking
 * up from the foreach to the enclosing class and scanning the property declaration.
 */
function findClassPropertyElementType(
  memberAccessNode: SyntaxNode,
  fnNode: SyntaxNode,
): string | null {
  const propNameNode = memberAccessNode.childForFieldName('name');
  if (propNameNode === null) return null;
  const propName = propNameNode.text;

  // Walk up from fnNode to find the enclosing class declaration
  let cur: SyntaxNode | null = fnNode.parent;
  while (cur !== null) {
    if (cur.type === 'class_declaration' || cur.type === 'trait_declaration') {
      break;
    }
    cur = cur.parent;
  }
  if (cur === null) return null;

  // Find the property_declaration with matching variable_name '$propName'
  const declList = cur.childForFieldName('body');
  if (declList === null) return null;

  for (let i = 0; i < declList.namedChildCount; i++) {
    const child = declList.namedChild(i);
    if (child === null || child.type !== 'property_declaration') continue;
    for (let j = 0; j < child.namedChildCount; j++) {
      const elem = child.namedChild(j);
      if (elem === null || elem.type !== 'property_element') continue;
      const varNameNode = elem.firstNamedChild;
      if (varNameNode === null || varNameNode.text !== '$' + propName) continue;
      // Found the property — get its element type from @var PHPDoc or native type
      return extractPropertyElementType(child);
    }
  }
  return null;
}

/** Regex for PHPDoc @var: `@var Type` */
const PHPDOC_VAR_RE = /@var\s+(\S+)/;

/**
 * Extract element type from a property_declaration node:
 * 1. PHPDoc @var annotation on a preceding comment sibling
 * 2. PHP 7.4+ native type field (non-array)
 */
function extractPropertyElementType(propDecl: SyntaxNode): string | null {
  // Strategy 1: PHPDoc @var on a preceding comment sibling
  let sibling = propDecl.previousSibling;
  while (sibling !== null) {
    if (sibling.type === 'comment') {
      const m = PHPDOC_VAR_RE.exec(sibling.text);
      if (m !== null) return normalizePhpDocType(m[1]);
    } else if (sibling.isNamed && !SKIP_SIBLING_TYPES.has(sibling.type)) {
      break;
    }
    sibling = sibling.previousSibling;
  }
  // Strategy 2: native type field — skip generic 'array'
  const typeNode = propDecl.childForFieldName('type');
  if (typeNode === null) return null;
  const typeName = typeNode.text.trim();
  if (typeName === 'array' || typeName === '') return null;
  return normalizePhpDocType(typeName);
}
