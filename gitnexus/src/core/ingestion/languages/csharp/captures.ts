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
import {
  nodeIfType,
  nodeToCapture,
  syntheticCapture,
  walkNamedTree,
} from '../../utils/ast-helpers.js';
import { splitUsingDirective } from './import-decomposer.js';
import { computeCsharpArityMetadata } from './arity-metadata.js';
import { synthesizeCsharpReceiverBinding } from './receiver-binding.js';
import { getCsharpParser, getCsharpScopeQuery } from './query.js';
import { recordCacheHit, recordCacheMiss } from './cache-stats.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';

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

const BUILTIN_TYPE_NAMES = new Set([
  'bool',
  'byte',
  'char',
  'decimal',
  'double',
  'float',
  'int',
  'long',
  'object',
  'sbyte',
  'short',
  'string',
  'uint',
  'ulong',
  'ushort',
  'void',
]);

function shouldEmitReadMember(memberNode: SyntaxNode): boolean {
  const parent = memberNode.parent;
  if (parent === null) return true;

  switch (parent.type) {
    case 'invocation_expression':
      return parent.childForFieldName('function')?.id !== memberNode.id;
    case 'assignment_expression':
      return parent.childForFieldName('left')?.id !== memberNode.id;
    default:
      return true;
  }
}

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
    tree = parseSourceSafe(getCsharpParser(), sourceText, undefined, {
      bufferSize: getTreeSitterBufferSize(sourceText),
    });
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
    // Parallel tag -> captured SyntaxNode map: the query hands us each matched
    // node as c.node, so anchors resolve via a type-guarded lookup (nodeIfType)
    // instead of re-deriving them with findNodeAtRange(tree.rootNode, ...) per
    // match — the O(matches x rootChildren) root-walk fixed for go #1915 /
    // python #1918, mirrored here.
    const nodeMap: Record<string, SyntaxNode> = {};
    for (const c of m.captures) {
      const tag = '@' + c.name;
      grouped[tag] = nodeToCapture(tag, c.node);
      nodeMap[tag] = c.node;
    }
    if (Object.keys(grouped).length === 0) continue;

    // Decompose each `using_directive` so `interpretCsharpImport` sees
    // the kind/source/name/alias markers it consumes. Raw query match
    // only carries the @import.statement anchor.
    if (grouped['@import.statement'] !== undefined) {
      const stmtNode = nodeIfType(nodeMap['@import.statement'], 'using_directive');
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

    if (grouped['@reference.read.member'] !== undefined) {
      const memberNode = nodeIfType(nodeMap['@reference.read.member'], 'member_access_expression');
      if (memberNode === null || !shouldEmitReadMember(memberNode)) {
        continue;
      }
    }

    // Synthesize `this` / `base` receiver type-bindings on every
    // instance method-like. Tree-sitter can't cleanly express "the
    // implicit receiver of a non-static member of a class/struct/
    // record/interface" via a static `.scm` pattern, so we walk up
    // the AST in code. Mirrors Python's `self`/`cls` synthesis on
    // `@scope.function` matches.
    if (grouped['@scope.function'] !== undefined) {
      out.push(grouped);
      const fnNode = nodeIfType(nodeMap['@scope.function'], ...FUNCTION_NODE_TYPES);
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
      const fnNode = nodeIfType(nodeMap[declTag], ...FUNCTION_NODE_TYPES);
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
      const callNode = nodeIfType(
        nodeMap[callTag],
        'invocation_expression',
        'object_creation_expression',
      );
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
      const typeNode = nodeIfType(
        nodeMap['@declaration.class'] ?? nodeMap['@declaration.record'],
        'class_declaration',
        'record_declaration',
      );
      if (typeNode !== null) {
        const synth = synthesizePrimaryConstructor(typeNode);
        if (synth !== null) out.push(synth);
      }
    }
  }

  out.push(...synthesizeGenericTypeArgumentReferences(tree.rootNode));
  out.push(...synthesizeCsharpInheritanceReferences(tree.rootNode));

  return out;
}

/**
 * Synthesize `@reference.inherits` captures from C# base lists so the
 * registry-primary scope-resolution path emits EXTENDS / IMPLEMENTS edges
 * (mirrors C++ `emitCppInheritanceCaptures`). Without this, C# inheritance
 * edges came only from the legacy `@heritage.*` path, which is dropped for
 * registry-primary languages in the worker pipeline (issue #1951).
 *
 * Scope covers every `base_list`-bearing declaration the legacy `@heritage`
 * leg matches: `class_declaration`, `interface_declaration`,
 * `record_declaration`, and `struct_declaration`. Records and structs were
 * dropped before (#1951): a `record R(...) : Base(args), IFoo` or
 * `struct S : IFoo, ns.IBar` produced no registry-primary inheritance edge
 * even though the legacy heritage query covered them. The
 * EXTENDS-vs-IMPLEMENTS split is decided downstream from the resolved target's
 * symbol kind (`preEmitInheritanceEdges`), so all bases are emitted with the
 * same `inherits` kind here; the base lookup name is normalized to its bare
 * simple identifier (`IRepository<T>` → `IRepository`, `A.B.IFace` → `IFace`,
 * `Base(args)` primary-ctor base → `Base`, `MyAlias::Foo` → `Foo`) to match
 * the V1 simple-name `findClassBindingInScope` contract — exactly the bare
 * text `normalizeSupertypeName` (supertype-alternation.ts) reduces each shape
 * to on the legacy leg.
 */
function synthesizeCsharpInheritanceReferences(root: SyntaxNode): CaptureMatch[] {
  const out: CaptureMatch[] = [];
  walkNamedTree(root, (node) => {
    if (
      node.type !== 'class_declaration' &&
      node.type !== 'interface_declaration' &&
      node.type !== 'record_declaration' &&
      node.type !== 'struct_declaration'
    ) {
      return;
    }
    const baseList = findNamedChild(node, 'base_list');
    if (baseList === null) return;
    for (const base of baseList.namedChildren) {
      if (base === null) continue;
      const nameNode = terminalTypeNameNode(base);
      if (nameNode === null) continue;
      if (BUILTIN_TYPE_NAMES.has(nameNode.text)) continue;
      out.push({
        '@reference.inherits': nodeToCapture('@reference.inherits', base),
        '@reference.name': nodeToCapture('@reference.name', nameNode),
      });
    }
  });
  return out;
}

function synthesizeGenericTypeArgumentReferences(root: SyntaxNode): CaptureMatch[] {
  const out: CaptureMatch[] = [];
  // Treat all generic type arguments as static type references, including
  // declaration signatures and call-site generic instantiations.
  walkNamedTree(root, (node) => {
    if (node.type !== 'generic_name') return;
    const args = findNamedChild(node, 'type_argument_list');
    if (args === null) return;

    for (const arg of args.namedChildren) {
      if (arg === null) continue;
      const nameNode = terminalTypeNameNode(arg);
      if (nameNode === null) continue;
      if (BUILTIN_TYPE_NAMES.has(nameNode.text)) continue;
      out.push({
        '@reference.type': nodeToCapture('@reference.type', nameNode),
        '@reference.name': nodeToCapture('@reference.name', nameNode),
      });
    }
  });
  return out;
}

function terminalTypeNameNode(node: SyntaxNode): SyntaxNode | null {
  switch (node.type) {
    case 'identifier':
      return node;
    case 'nullable_type':
      return node.firstNamedChild === null ? null : terminalTypeNameNode(node.firstNamedChild);
    case 'qualified_name': {
      // `A.B.Base` -> tail identifier `Base`; `A.B.Base<T>` -> the tail is a
      // `generic_name`, so recurse to drop the type arguments and reach the
      // bare base identifier (#1951).
      const tail = node.lastNamedChild;
      return tail === null ? null : terminalTypeNameNode(tail);
    }
    case 'alias_qualified_name': {
      // `MyAlias::Foo` / `global::IDisposable` -> the `name` field is the bare
      // identifier (the `alias` is the qualifier). Mirrors
      // normalizeSupertypeName's `name`-field reduction for this shape (#1951).
      const name = node.childForFieldName('name');
      return name === null ? null : terminalTypeNameNode(name);
    }
    case 'primary_constructor_base_type': {
      // record base with a constructor call: `Base(args)` / `pkg.Base(id)` /
      // `Box<int>(id)`. The `type` field holds the supertype (identifier /
      // qualified_name / generic_name); the trailing argument_list is dropped.
      // Mirrors normalizeSupertypeName's `type`-field reduction (#1951).
      const type = node.childForFieldName('type');
      return type === null ? null : terminalTypeNameNode(type);
    }
    case 'generic_name':
      // generic_name has no `name` field (verified by real parse, #1920); the
      // base identifier is the first named child.
      return node.firstNamedChild;
    default:
      return null;
  }
}

function findNamedChild(node: SyntaxNode, type: string): SyntaxNode | null {
  for (const child of node.namedChildren) {
    if (child !== null && child.type === type) return child;
  }
  return null;
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
