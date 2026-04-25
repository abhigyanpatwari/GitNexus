/**
 * `emitScopeCaptures` for C#.
 *
 * Drives the C# scope query against tree-sitter-c-sharp and groups raw
 * matches into `CaptureMatch[]` for the central extractor. Layers one
 * synthesized stream on top today:
 *
 *   1. **Decomposed using directives** — each `using_directive` is
 *      re-emitted with `@import.kind/source/name/alias` markers so
 *      `interpretCsharpImport` can recover the ParsedImport shape
 *      without re-parsing raw text (see `import-decomposer.ts`).
 *
 * Receiver-binding synthesis (`this` / `base` type anchors) and arity
 * metadata synthesis (Unit 5) layer on top later.
 *
 * Pure given the input source text. No I/O, no globals consulted.
 */

import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { findNodeAtRange, nodeToCapture, syntheticCapture } from '../../utils/ast-helpers.js';
import { splitUsingDirective } from './import-decomposer.js';
import { computeCsharpArityMetadata } from './arity-metadata.js';
import { synthesizeCsharpReceiverBinding } from './receiver-binding.js';
import { getCsharpParser, getCsharpScopeQuery } from './query.js';
import { recordCacheHit, recordCacheMiss } from './cache-stats.js';

/** Declaration anchors that carry function-like arity metadata. */
const FUNCTION_DECL_TAGS = [
  '@declaration.method',
  '@declaration.constructor',
  '@declaration.function',
] as const;

/** tree-sitter-c-sharp node types that the method extractor accepts. */
const FUNCTION_NODE_TYPES = [
  'method_declaration',
  'constructor_declaration',
  'destructor_declaration',
  'operator_declaration',
  'conversion_operator_declaration',
  'local_function_statement',
] as const;

export function emitCsharpScopeCaptures(
  sourceText: string,
  _filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  // Skip the parse when the caller (parse phase's scopeTreeCache)
  // already produced a Tree for this source. Cache miss = re-parse,
  // same as before. The cachedTree parameter is typed as `unknown` at
  // the LanguageProvider contract layer; cast here at the use site.
  let tree = cachedTree as ReturnType<ReturnType<typeof getCsharpParser>['parse']> | undefined;
  if (tree === undefined) {
    tree = getCsharpParser().parse(sourceText);
    recordCacheMiss();
  } else {
    recordCacheHit();
  }

  const rawMatches = getCsharpScopeQuery().matches(tree.rootNode);
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

    // Decompose each `using_directive` so `interpretCsharpImport` sees
    // the kind/source/name/alias markers it consumes. Raw query match
    // only carries the @import.statement anchor.
    if (grouped['@import.statement'] !== undefined) {
      const stmtCapture = grouped['@import.statement'];
      const stmtNode = findNodeAtRange(tree.rootNode, stmtCapture.range, 'using_directive');
      if (stmtNode !== null) {
        const decomposed = splitUsingDirective(stmtNode);
        if (decomposed !== null) {
          out.push(decomposed);
          continue;
        }
      }
      // Defensive fallback: emit the raw match so the extractor at
      // least sees an anchor, even without markers.
      out.push(grouped);
      continue;
    }

    // Synthesize `this` / `base` receiver type-bindings on every
    // instance method-like. Tree-sitter can't cleanly express "the
    // implicit receiver of a non-static member of a class/struct/
    // record/interface" via a static `.scm` pattern, so we walk up
    // the AST in code. Mirrors Python's `self`/`cls` synthesis on
    // `@scope.function` matches.
    if (grouped['@scope.function'] !== undefined) {
      out.push(grouped);
      const anchor = grouped['@scope.function']!;
      const fnNode = findFunctionNode(tree.rootNode, anchor.range);
      if (fnNode !== null) {
        for (const synth of synthesizeCsharpReceiverBinding(fnNode)) {
          out.push(synth);
        }
      }
      continue;
    }

    // Synthesize arity metadata on function-like declarations so the
    // registry can narrow overloads (C# relies heavily on this). Mirrors
    // Python's captures.ts pattern — one anchor per match, so we find
    // the first tag that matches.
    const declTag = FUNCTION_DECL_TAGS.find((t) => grouped[t] !== undefined);
    if (declTag !== undefined) {
      const anchor = grouped[declTag]!;
      const fnNode = findFunctionNode(tree.rootNode, anchor.range);
      if (fnNode !== null) {
        const arity = computeCsharpArityMetadata(fnNode);
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

    // Synthesize `@reference.arity` on every callsite so the
    // registry's arity filter can narrow overloads. Count the
    // `argument` named children of the backing `argument_list`.
    // Python doesn't synthesize this today; C# needs it because the
    // language has method overloading and the suite asserts overload
    // resolution.
    const callTag = (
      ['@reference.call.free', '@reference.call.member', '@reference.call.constructor'] as const
    ).find((t) => grouped[t] !== undefined);
    if (callTag !== undefined && grouped['@reference.arity'] === undefined) {
      const anchor = grouped[callTag]!;
      const callNode =
        findNodeAtRange(tree.rootNode, anchor.range, 'invocation_expression') ??
        findNodeAtRange(tree.rootNode, anchor.range, 'object_creation_expression');
      if (callNode !== null) {
        const argList = callNode.childForFieldName('arguments');
        const args =
          argList === null
            ? []
            : argList.namedChildren.filter((c) => c !== null && c.type === 'argument');
        grouped['@reference.arity'] = syntheticCapture(
          '@reference.arity',
          callNode,
          String(args.length),
        );

        // Infer argument types from literal nodes so overload
        // disambiguation can narrow same-arity candidates by param
        // type. Non-literal arguments emit empty string to indicate
        // "unknown" — consumers treat unknown as any-match.
        const argTypes = args.map((arg) => inferArgType(arg!));
        grouped['@reference.parameter-types'] = syntheticCapture(
          '@reference.parameter-types',
          callNode,
          JSON.stringify(argTypes),
        );
      }
    }

    out.push(grouped);

    // Synthesize primary-constructor declarations on class/record
    // declarations that carry a `parameter_list` child (C# 12 syntax
    // `public class User(string name, int age) { ... }` or
    // `public record Person(string FirstName, string LastName)`).
    // Legacy `csharpMethodConfig.extractPrimaryConstructor` runs via
    // the parse phase; the scope-resolution path needs its own emit so
    // `new User(...)` resolves to a Constructor def in memberByOwner.
    if (
      grouped['@declaration.class'] !== undefined ||
      grouped['@declaration.record'] !== undefined
    ) {
      const anchor = grouped['@declaration.class'] ?? grouped['@declaration.record']!;
      const typeNode =
        findNodeAtRange(tree.rootNode, anchor.range, 'class_declaration') ??
        findNodeAtRange(tree.rootNode, anchor.range, 'record_declaration');
      if (typeNode !== null) {
        const synth = synthesizePrimaryConstructor(typeNode);
        if (synth !== null) out.push(synth);
      }
    }
  }

  return out;
}

/** C# 12 primary constructor: `class X(a, b) { }` / `record X(a, b)`.
 *  The parameters are a bare `parameter_list` named child of the type
 *  declaration (no `constructor_declaration` node). Emit a synthetic
 *  @declaration.constructor match so the extractor creates a
 *  Constructor def in memberByOwner — free-call-fallback's
 *  `pickConstructorOrClass` then targets it for `new X(...)` calls. */
function synthesizePrimaryConstructor(typeNode: SyntaxNode): CaptureMatch | null {
  // Skip types with an explicit constructor_declaration — that would
  // create duplicate defs.
  const body = typeNode.childForFieldName('body');
  if (body !== null) {
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (child !== null && child.type === 'constructor_declaration') return null;
    }
  }
  let paramList: SyntaxNode | null = null;
  for (let i = 0; i < typeNode.namedChildCount; i++) {
    const child = typeNode.namedChild(i);
    if (child !== null && child.type === 'parameter_list') {
      paramList = child;
      break;
    }
  }
  if (paramList === null) return null;

  const nameNode = typeNode.childForFieldName('name');
  if (nameNode === null) return null;

  const paramCount = paramList.namedChildren.filter(
    (c) => c !== null && c.type === 'parameter',
  ).length;

  const m: Record<string, Capture> = {
    '@declaration.constructor': nodeToCapture('@declaration.constructor', paramList),
    '@declaration.name': syntheticCapture('@declaration.name', nameNode, nameNode.text),
    '@declaration.parameter-count': syntheticCapture(
      '@declaration.parameter-count',
      paramList,
      String(paramCount),
    ),
    '@declaration.required-parameter-count': syntheticCapture(
      '@declaration.required-parameter-count',
      paramList,
      String(paramCount),
    ),
  };
  return m;
}

type SyntaxNode = ReturnType<ReturnType<typeof getCsharpParser>['parse']>['rootNode'];

/** Infer a C# argument's static type from literal / constructor
 *  patterns. Returns `''` when the arg has no statically-derivable
 *  type (e.g. identifier — would require full type inference). */
function inferArgType(argNode: SyntaxNode): string {
  // `argument > expression` — tree-sitter-c-sharp wraps the value.
  const expr = argNode.namedChild(0);
  if (expr === null) return '';
  switch (expr.type) {
    case 'integer_literal':
      return 'int';
    case 'real_literal':
      return 'double';
    case 'string_literal':
    case 'verbatim_string_literal':
    case 'interpolated_string_expression':
    case 'raw_string_literal':
      return 'string';
    case 'character_literal':
      return 'char';
    case 'boolean_literal':
      return 'bool';
    case 'null_literal':
      return 'null';
    case 'object_creation_expression': {
      const typeNode = expr.childForFieldName('type');
      return typeNode?.text ?? '';
    }
    default:
      return '';
  }
}

/** Find the first C# function-like node at the given range. The
 *  declaration anchor range covers the whole method/constructor/etc.
 *  node, but the tag alone doesn't tell us which node type. */
function findFunctionNode(rootNode: SyntaxNode, range: Capture['range']): SyntaxNode | null {
  for (const nodeType of FUNCTION_NODE_TYPES) {
    const n = findNodeAtRange(rootNode, range, nodeType);
    if (n !== null) return n as SyntaxNode;
  }
  return null;
}
