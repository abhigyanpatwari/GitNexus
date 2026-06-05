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
import { nodeIfType, nodeToCapture, syntheticCapture } from '../../utils/ast-helpers.js';
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
    // Parallel tag -> captured SyntaxNode map. The tree-sitter query already
    // hands us each matched node as `c.node`, so anchors resolve via a
    // type-guarded lookup (`nodeIfType`) instead of re-deriving them with
    // `findNodeAtRange(tree.rootNode, ...)` per match — the
    // O(matches × rootChildren) root-walk fixed for go #1848 / python #1918 /
    // rust/csharp #1915, mirrored here for java (#1951). Every Java scope-query
    // anchor below captures directly ON the node the old root-walk re-derived
    // (verified against JAVA_SCOPE_QUERY in query.ts), so the type check is exact.
    const nodeMap: Record<string, SyntaxNode> = {};
    for (const c of m.captures) {
      const tag = '@' + c.name;
      grouped[tag] = nodeToCapture(tag, c.node);
      nodeMap[tag] = c.node;
    }
    if (Object.keys(grouped).length === 0) continue;

    // Decompose each `import_declaration`. `@import.statement` is captured
    // directly on the `import_declaration` node.
    if (grouped['@import.statement'] !== undefined) {
      const stmtNode = nodeIfType(nodeMap['@import.statement'], 'import_declaration');
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
    // `@reference.read.member` is captured directly on the `field_access` node.
    if (grouped['@reference.read.member'] !== undefined) {
      const memberNode = nodeIfType(nodeMap['@reference.read.member'], 'field_access');
      if (memberNode === null || !shouldEmitReadMember(memberNode)) {
        continue;
      }
    }

    // Synthesize `this` / `super` receiver type-bindings on every
    // instance method-like.
    if (grouped['@scope.function'] !== undefined) {
      out.push(grouped);
      // `@scope.function` is captured directly on the method/constructor node.
      const fnNode = findFunctionNode(nodeMap['@scope.function']);
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
      // FUNCTION_DECL_TAGS (@declaration.method/.constructor) are captured
      // directly on the method/constructor node.
      const fnNode = findFunctionNode(nodeMap[declTag]);
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
      // @reference.call.free/.member are captured on the `method_invocation`;
      // @reference.call.constructor on the `object_creation_expression`. The
      // captured node IS the call node the old findNodeAtRange re-derived.
      const callNode = nodeIfType(
        nodeMap[callTag],
        'method_invocation',
        'object_creation_expression',
      );
      if (callNode !== null) {
        const argList = callNode.childForFieldName('arguments');
        // Exclude interleaved comments — tree-sitter-java emits `block_comment` /
        // `line_comment` as named children of argument_list, which would inflate
        // arity (and arity feeds call-processor symbol-ID generation). #1920
        const args =
          argList === null
            ? []
            : argList.namedChildren.filter(
                (c) => c !== null && c.type !== 'block_comment' && c.type !== 'line_comment',
              );
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

        const argNames = args.map((a) => (a!.type === 'identifier' ? a!.text : ''));
        if (argNames.some((n) => n !== '')) {
          grouped['@reference.arg-names'] = syntheticCapture(
            '@reference.arg-names',
            callNode,
            JSON.stringify(argNames),
          );
        }
      }
    }

    out.push(grouped);
  }

  return [
    ...resolveVarTypeBindings(out),
    ...synthesizeJavaInheritanceReferences(tree.rootNode),
    ...synthesizeJavaExplicitConstructorReferences(tree.rootNode),
  ];
}

/**
 * Synthesize `@reference.call.constructor` captures for explicit constructor
 * invocations — `super(...)` and `this(...)` (F38 #1928). tree-sitter-java
 * models these as `explicit_constructor_invocation` nodes, which the scope
 * query does not match, so the chained-constructor CALLS edges (subclass ctor →
 * superclass ctor; ctor → sibling overload) were silently dropped.
 *
 * The grammar gives no constructor *name* at the call site (the child is a bare
 * `(super)` / `(this)` token), so the target name is resolved structurally:
 *   - `this(...)`  → the enclosing type's own simple name (constructor symbols
 *                    are keyed by the declaring class name).
 *   - `super(...)` → the enclosing class's superclass simple-name tail (reusing
 *                    `javaBaseLookupNameNode` so qualified/generic supers reduce
 *                    to the bare class name, matching the EXTENDS synth). An
 *                    implicit `Object` super (no `superclass` field) has no
 *                    in-graph symbol, so it is skipped rather than emitting a
 *                    dangling reference.
 * Arity is attached so overloaded constructors disambiguate downstream, mirroring
 * the call-site arity synthesized for `new X(...)`.
 */
function synthesizeJavaExplicitConstructorReferences(root: SyntaxNode): CaptureMatch[] {
  const out: CaptureMatch[] = [];
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'explicit_constructor_invocation') {
      emitJavaExplicitConstructorRef(out, node);
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child !== null) stack.push(child);
    }
  }
  return out;
}

const TYPE_DECL_NODE_TYPES = new Set([
  'class_declaration',
  'enum_declaration',
  'record_declaration',
]);

function emitJavaExplicitConstructorRef(out: CaptureMatch[], node: SyntaxNode): void {
  const ctor = node.childForFieldName('constructor');
  if (ctor === null) return;

  const enclosingType = findEnclosingTypeDeclaration(node);
  if (enclosingType === null) return;

  let targetNameNode: SyntaxNode | null = null;
  if (ctor.type === 'this') {
    targetNameNode = enclosingType.childForFieldName('name');
  } else if (ctor.type === 'super') {
    // Only class_declaration carries a `superclass` field; enum/record cannot
    // declare an explicit superclass, so `super(...)` there has no resolvable
    // target symbol.
    const superclass = enclosingType.childForFieldName('superclass');
    if (superclass === null) return;
    for (const base of superclass.namedChildren) {
      if (base === null) continue;
      const nameNode = javaBaseLookupNameNode(base);
      if (nameNode !== null) {
        targetNameNode = nameNode;
        break;
      }
    }
  }
  if (targetNameNode === null) return;

  const argList = node.childForFieldName('arguments');
  const args =
    argList === null
      ? []
      : argList.namedChildren.filter(
          (c) => c !== null && c.type !== 'block_comment' && c.type !== 'line_comment',
        );

  out.push({
    '@reference.call.constructor': nodeToCapture('@reference.call.constructor', node),
    '@reference.name': nodeToCapture('@reference.name', targetNameNode),
    '@reference.arity': syntheticCapture('@reference.arity', node, String(args.length)),
  });
}

function findEnclosingTypeDeclaration(node: SyntaxNode): SyntaxNode | null {
  let cur: SyntaxNode | null = node.parent;
  while (cur !== null) {
    if (TYPE_DECL_NODE_TYPES.has(cur.type)) return cur;
    cur = cur.parent;
  }
  return null;
}

/**
 * Synthesize `@reference.inherits` captures from Java class heritage so the
 * registry-primary scope-resolution path emits EXTENDS / IMPLEMENTS edges
 * (mirrors C++ `emitCppInheritanceCaptures`). Without this, Java inheritance
 * edges came only from the legacy heritage-capture leg (removed in #942), which
 * is dropped for registry-primary languages in the worker pipeline (issue #1951).
 *
 * Scope covers `class_declaration` (`superclass` extends + `interfaces`
 * implements clauses) AND `interface_declaration` (`extends_interfaces` →
 * interface-to-interface EXTENDS), matching the legacy Java heritage query
 * (tree-sitter-queries.ts), which has a dedicated `interface_declaration
 * (extends_interfaces (type_list …))` arm. Without the interface arm the
 * registry-primary synth silently dropped every `interface IA extends IB`
 * edge while the legacy leg emitted it — the exact =0/=N parity break #1951
 * targets. Enum/record heritage stays unemitted (no legacy arm). Generic
 * bases (`extends Box<T>`, `implements IFoo<T>`) ARE emitted here: the legacy
 * heritage query was widened to capture the inner `type_identifier` of a
 * `generic_type` (tree-sitter-queries.ts), so both paths now agree on SIMPLE
 * (unqualified) generic bases — the more-correct behavior, consistent with
 * C#/Rust (#1951). Qualified bases (`a.b.Base`, `a.b.Box<T>`, `a.b.IFoo<T>`) are
 * ALSO now at parity (#1956 tri-review U2): the synth resolves them by their
 * `scoped_type_identifier` tail, and the legacy heritage query was widened
 * with matching `scoped_type_identifier` arms (plain + generic-wrapped). The
 * EXTENDS-vs-IMPLEMENTS split is decided downstream from the resolved target's
 * symbol kind (`preEmitInheritanceEdges`): a superclass resolves to a class
 * (EXTENDS), an implemented interface resolves to an interface (IMPLEMENTS).
 * An `interface IA extends IB` base resolves to an Interface too, so it is
 * emitted as IMPLEMENTS — matching the legacy `interface_declaration` arm,
 * which tagged the bases as implements (`kind: 'implements'`) and likewise
 * resolves them as interfaces. The synth therefore does not need to know the
 * declaration's own kind; it only emits inherits sites and lets the resolved
 * target decide the edge type.
 * Base names are normalized to their bare simple identifier (`Box<T>` → `Box`,
 * `java.io.Serializable` → `Serializable`) to match the V1 simple-name
 * `findClassBindingInScope` contract.
 */
function synthesizeJavaInheritanceReferences(root: SyntaxNode): CaptureMatch[] {
  const out: CaptureMatch[] = [];
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'class_declaration') {
      const superclass = node.childForFieldName('superclass');
      if (superclass !== null) {
        for (const base of superclass.namedChildren) emitJavaInheritanceBase(out, base);
      }
      const interfaces = node.childForFieldName('interfaces');
      if (interfaces !== null) {
        for (const typeList of interfaces.namedChildren) {
          if (typeList === null || typeList.type !== 'type_list') continue;
          for (const base of typeList.namedChildren) emitJavaInheritanceBase(out, base);
        }
      }
    } else if (node.type === 'interface_declaration') {
      // `interface IA extends IB, IC<T>` — the `extends_interfaces` clause is
      // NOT exposed via a tree-sitter field (unlike a class's `superclass` /
      // `interfaces`), so scan named children for it. It wraps a `type_list`
      // whose bases reuse `javaBaseLookupNameNode` (handles type_identifier /
      // generic_type / scoped_type_identifier). These resolve to Interface
      // targets, so `preEmitInheritanceEdges` emits them as IMPLEMENTS, at
      // parity with the legacy `interface_declaration` implements arm.
      for (let i = 0; i < node.namedChildCount; i++) {
        const extendsInterfaces = node.namedChild(i);
        if (extendsInterfaces === null || extendsInterfaces.type !== 'extends_interfaces') continue;
        for (const typeList of extendsInterfaces.namedChildren) {
          if (typeList === null || typeList.type !== 'type_list') continue;
          for (const base of typeList.namedChildren) emitJavaInheritanceBase(out, base);
        }
      }
    }
    // Named children only: every type/heritage node we care about is named,
    // so skipping unnamed punctuation tokens keeps the walk single-pass and
    // lighter on large files.
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child !== null) stack.push(child);
    }
  }
  return out;
}

function emitJavaInheritanceBase(out: CaptureMatch[], base: SyntaxNode | null): void {
  if (base === null) return;
  const nameNode = javaBaseLookupNameNode(base);
  if (nameNode === null) return;
  out.push({
    '@reference.inherits': nodeToCapture('@reference.inherits', base),
    '@reference.name': nodeToCapture('@reference.name', nameNode),
  });
}

/** Resolve a Java base-type node to its bare simple-name identifier node. */
function javaBaseLookupNameNode(node: SyntaxNode): SyntaxNode | null {
  switch (node.type) {
    case 'type_identifier':
      return node;
    case 'scoped_type_identifier':
      // `java.io.Serializable` → trailing `type_identifier` (`Serializable`).
      return node.lastNamedChild;
    case 'generic_type': {
      // `Box<String>` → recurse into the base type (`Box`).
      const first = node.firstNamedChild;
      return first === null ? null : javaBaseLookupNameNode(first);
    }
    default:
      return null;
  }
}

function resolveVarTypeBindings(matches: CaptureMatch[]): CaptureMatch[] {
  const returnTypes = new Map<string, string>();
  const varTypes = new Map<string, string>();
  const ambiguousReturns = new Set<string>();
  const ambiguousVars = new Set<string>();

  for (const m of matches) {
    if (
      m['@type-binding.return'] !== undefined &&
      m['@type-binding.type'] !== undefined &&
      m['@type-binding.name'] !== undefined
    ) {
      const name = m['@type-binding.name'].text;
      const type = m['@type-binding.type'].text;
      const existing = returnTypes.get(name);
      if (existing !== undefined && existing !== type) {
        ambiguousReturns.add(name);
        returnTypes.delete(name);
      } else if (!ambiguousReturns.has(name)) {
        returnTypes.set(name, type);
      }
    }
    if (
      m['@type-binding.annotation'] !== undefined &&
      m['@type-binding.type'] !== undefined &&
      m['@type-binding.name'] !== undefined
    ) {
      const name = m['@type-binding.name'].text;
      const t = m['@type-binding.type'].text;
      if (t !== 'var') {
        const existing = varTypes.get(name);
        if (existing !== undefined && existing !== t) {
          ambiguousVars.add(name);
          varTypes.delete(name);
        } else if (!ambiguousVars.has(name)) {
          varTypes.set(name, t);
        }
      }
    }
    if (
      m['@type-binding.constructor'] !== undefined &&
      m['@type-binding.type'] !== undefined &&
      m['@type-binding.name'] !== undefined
    ) {
      const name = m['@type-binding.name'].text;
      const type = m['@type-binding.type'].text;
      const existing = varTypes.get(name);
      if (existing !== undefined && existing !== type) {
        ambiguousVars.add(name);
        varTypes.delete(name);
      } else if (!ambiguousVars.has(name)) {
        varTypes.set(name, type);
      }
    }
  }

  const resolved: CaptureMatch[] = [];
  for (const m of matches) {
    if (m['@type-binding.call-result'] !== undefined && m['@type-binding.type'] !== undefined) {
      const methodName = m['@type-binding.type'].text;
      const resolvedType = returnTypes.get(methodName);
      if (resolvedType !== undefined) {
        const patched: Record<string, Capture> = { ...m };
        patched['@type-binding.type'] = { ...m['@type-binding.type']!, text: resolvedType };
        patched['@type-binding.annotation'] = m['@type-binding.call-result']!;
        delete patched['@type-binding.call-result'];
        resolved.push(patched);
        continue;
      }
    }
    if (m['@type-binding.alias'] !== undefined && m['@type-binding.type'] !== undefined) {
      const sourceName = m['@type-binding.type'].text;
      const resolvedType = varTypes.get(sourceName);
      if (resolvedType !== undefined) {
        const patched: Record<string, Capture> = { ...m };
        patched['@type-binding.type'] = { ...m['@type-binding.type']!, text: resolvedType };
        patched['@type-binding.annotation'] = m['@type-binding.alias']!;
        delete patched['@type-binding.alias'];
        resolved.push(patched);
        continue;
      }
    }
    if (m['@reference.arg-names'] !== undefined && m['@reference.parameter-types'] !== undefined) {
      try {
        const types: string[] = JSON.parse(m['@reference.parameter-types'].text);
        const names: string[] = JSON.parse(m['@reference.arg-names'].text);
        let patched = false;
        for (let i = 0; i < types.length; i++) {
          if (types[i] === '' && names[i] !== undefined && names[i] !== '') {
            const rt = varTypes.get(names[i]!);
            if (rt !== undefined) {
              types[i] = rt;
              patched = true;
            }
          }
        }
        if (patched) {
          const patchedMatch: Record<string, Capture> = { ...m };
          patchedMatch['@reference.parameter-types'] = {
            ...m['@reference.parameter-types']!,
            text: JSON.stringify(types),
          };
          delete patchedMatch['@reference.arg-names'];
          resolved.push(patchedMatch);
          continue;
        }
      } catch {
        // pass through
      }
    }
    resolved.push(m);
  }
  return resolved;
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

/**
 * Resolve a Java function-like node from a query-captured node.
 *
 * The `@scope.function` / `@declaration.method` / `@declaration.constructor`
 * anchors all capture directly on the `method_declaration` /
 * `constructor_declaration` node (per JAVA_SCOPE_QUERY), so this is a type
 * guard against `FUNCTION_NODE_TYPES` — the threaded-node equivalent of the
 * old `findNodeAtRange(tree.rootNode, range, type)` root-walk, minus the
 * O(matches × rootChildren) traversal.
 */
function findFunctionNode(node: SyntaxNode | undefined): SyntaxNode | null {
  return nodeIfType(node, ...FUNCTION_NODE_TYPES);
}
