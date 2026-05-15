import type { Capture, CaptureMatch } from 'gitnexus-shared';
import {
  findNodeAtRange,
  nodeToCapture,
  syntheticCapture,
  type SyntaxNode,
} from '../../utils/ast-helpers.js';
import { getCppParser, getCppScopeQuery } from './query.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import { splitCppInclude, splitCppUsingDecl } from './import-decomposer.js';
import { computeCppDeclarationArity, computeCppCallArity } from './arity-metadata.js';
import { markCppAnonymousNamespaceRange, markFileLocal } from './file-local-linkage.js';
import { markCppDependentBase } from './two-phase-lookup.js';
import { markCppAdlSiteArgs, markCppAdlSiteNoAdl, type CppAdlArgInfo } from './adl.js';
import { markCppInlineNamespaceRange } from './inline-namespaces.js';

export function emitCppScopeCaptures(
  sourceText: string,
  filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  let tree = cachedTree as ReturnType<ReturnType<typeof getCppParser>['parse']> | undefined;
  if (tree === undefined) {
    tree = parseSourceSafe(getCppParser(), sourceText, undefined, {
      bufferSize: getTreeSitterBufferSize(sourceText),
    });
  }

  const rawMatches = getCppScopeQuery().matches(tree.rootNode);
  const out: CaptureMatch[] = [];

  // Track ranges where typedef-struct was captured as @declaration.struct
  // so we can suppress the duplicate @declaration.typedef match.
  const structTypedefRanges = new Set<string>();

  for (const m of rawMatches) {
    const grouped: Record<string, Capture> = {};
    for (const c of m.captures) {
      const tag = '@' + c.name;
      if (tag.startsWith('@_')) continue;
      grouped[tag] = nodeToCapture(tag, c.node);
    }
    if (Object.keys(grouped).length === 0) continue;

    // ── Handle #include statements ──────────────────────────────────
    if (grouped['@import.statement'] !== undefined) {
      const anchor = grouped['@import.statement']!;
      const includeNode = findNodeAtRange(tree.rootNode, anchor.range, 'preproc_include');
      if (includeNode !== null) {
        const split = splitCppInclude(includeNode);
        if (split !== null) {
          out.push(split);
          continue;
        }
      }
    }

    // ── Handle using declarations (using namespace / using name) ────
    if (grouped['@import.using-decl'] !== undefined) {
      const anchor = grouped['@import.using-decl']!;
      const usingNode = findNodeAtRange(tree.rootNode, anchor.range, 'using_declaration');
      if (usingNode !== null) {
        const split = splitCppUsingDecl(usingNode);
        if (split !== null) {
          out.push(split);
          continue;
        }
      }
    }

    // ── Track typedef-struct ranges ─────────────────────────────────
    const structAnchor = grouped['@declaration.struct'] ?? grouped['@declaration.class'];
    if (structAnchor !== undefined) {
      const r = structAnchor.range;
      structTypedefRanges.add(`${r.startLine}:${r.startCol}:${r.endLine}:${r.endCol}`);
    }

    // Suppress @declaration.typedef if the same range was already captured
    const typedefAnchor = grouped['@declaration.typedef'];
    if (typedefAnchor !== undefined) {
      const r = typedefAnchor.range;
      const key = `${r.startLine}:${r.startCol}:${r.endLine}:${r.endCol}`;
      if (structTypedefRanges.has(key)) continue;
    }

    // ── Enrich function/method declarations with arity metadata ─────
    const declAnchor = grouped['@declaration.function'] ?? grouped['@declaration.method'];
    if (declAnchor !== undefined) {
      const fnNode =
        findNodeAtRange(tree.rootNode, declAnchor.range, 'function_definition') ??
        findNodeAtRange(tree.rootNode, declAnchor.range, 'declaration') ??
        findNodeAtRange(tree.rootNode, declAnchor.range, 'field_declaration');
      if (fnNode !== null) {
        const arity = computeCppDeclarationArity(fnNode);
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

        // Detect static storage class (file-local linkage)
        if (hasStaticStorageClass(fnNode)) {
          const nameText = grouped['@declaration.name']?.text;
          if (nameText !== undefined) {
            markFileLocal(filePath, nameText);
          }
        }

        // Detect anonymous namespace (file-local linkage)
        if (isInsideAnonymousNamespace(fnNode)) {
          const nameText = grouped['@declaration.name']?.text;
          if (nameText !== undefined) {
            markFileLocal(filePath, nameText);
          }
        }
      }
    }

    // ── Detect static variables (file-local linkage) ────────────────
    const varDeclAnchor = grouped['@declaration.variable'];
    if (varDeclAnchor !== undefined) {
      const varNode = findNodeAtRange(tree.rootNode, varDeclAnchor.range, 'declaration');
      if (varNode !== null) {
        if (hasStaticStorageClass(varNode) || isInsideAnonymousNamespace(varNode)) {
          const nameText = grouped['@declaration.name']?.text;
          if (nameText !== undefined) {
            markFileLocal(filePath, nameText);
          }
        }
      }
    }

    // ── Enrich call references with arity ───────────────────────────
    const callAnchor =
      grouped['@reference.call.free'] ??
      grouped['@reference.call.member'] ??
      grouped['@reference.call.qualified'];
    if (callAnchor !== undefined && grouped['@reference.arity'] === undefined) {
      const callNode = findNodeAtRange(tree.rootNode, callAnchor.range, 'call_expression');
      if (callNode !== null) {
        grouped['@reference.arity'] = syntheticCapture(
          '@reference.arity',
          callNode,
          String(computeCppCallArity(callNode)),
        );
      }
    }

    // ── Enrich constructor calls (new Foo()) with arity ─────────────
    const ctorCallAnchor = grouped['@reference.call.constructor'];
    if (ctorCallAnchor !== undefined && grouped['@reference.arity'] === undefined) {
      const newNode = findNodeAtRange(tree.rootNode, ctorCallAnchor.range, 'new_expression');
      if (newNode !== null) {
        grouped['@reference.arity'] = syntheticCapture(
          '@reference.arity',
          newNode,
          String(computeCppCallArity(newNode)),
        );
      }
    }

    // ── Synthesize argument types for overload narrowing ────────────
    const anyCallAnchor = callAnchor ?? ctorCallAnchor;
    if (anyCallAnchor !== undefined && grouped['@reference.parameter-types'] === undefined) {
      const cNode =
        findNodeAtRange(tree.rootNode, anyCallAnchor.range, 'call_expression') ??
        findNodeAtRange(tree.rootNode, anyCallAnchor.range, 'new_expression');
      if (cNode !== null) {
        const argTypes = inferCppCallArgTypes(cNode);
        if (argTypes !== undefined && argTypes.length > 0) {
          grouped['@reference.parameter-types'] = syntheticCapture(
            '@reference.parameter-types',
            cNode,
            JSON.stringify(argTypes),
          );
        }
      }
    }

    // ── Inline namespace detection ──────────────────────────────────
    // `inline namespace v1 { ... }` — tree-sitter-cpp exposes the
    // `inline` keyword as a child of `namespace_definition`. Record the
    // namespace's source range so `populateCppInlineNamespaceScopes`
    // (during populateOwners) can match it back to the corresponding
    // Namespace scope.
    // `@declaration.namespace` fires only for NAMED namespaces (the query
    // requires a `name: (namespace_identifier)` child). Use the unconditional
    // `@scope.namespace` capture so the anonymous-namespace branch also runs.
    const namespaceScopeAnchor = grouped['@declaration.namespace'] ?? grouped['@scope.namespace'];
    if (namespaceScopeAnchor !== undefined) {
      const nsNode = findNodeAtRange(
        tree.rootNode,
        namespaceScopeAnchor.range,
        'namespace_definition',
      );
      if (nsNode !== null) {
        // Range coords stored in the shared Range shape use 1-based
        // line numbers (see `ast-helpers.ts` rangeForNode where
        // `startPosition.row + 1` is applied). Match that convention so
        // the populators can join against `Scope.range`.
        const nsRange = {
          startLine: nsNode.startPosition.row + 1,
          startCol: nsNode.startPosition.column,
          endLine: nsNode.endPosition.row + 1,
          endCol: nsNode.endPosition.column,
        };
        if (isInlineNamespace(nsNode)) {
          markCppInlineNamespaceRange(filePath, nsRange);
        }
        // Anonymous namespace: `namespace_definition` with no `name` field.
        // Recorded so `expandCppWildcardNames` can propagate its members
        // to including TUs even though their names are also `markFileLocal`'d
        // (which blocks the global free-call fallback's cross-file path).
        if ((nsNode.childForFieldName?.('name') ?? null) === null) {
          markCppAnonymousNamespaceRange(filePath, nsRange);
        }
      }
    }

    // ── ADL (Koenig lookup) per-site recording ──────────────────────
    // Only free-call sites (no explicit receiver) participate in ADL —
    // qualified `Ns::f(s)` and member `obj.f(s)` calls bypass the
    // free-call fallback entirely (handled by receiver-bound-calls).
    if (grouped['@reference.call.free'] !== undefined) {
      const freeCallNode = findNodeAtRange(
        tree.rootNode,
        grouped['@reference.call.free']!.range,
        'call_expression',
      );
      if (freeCallNode !== null) {
        const adlAnchorRange = grouped['@reference.call.free']!.range;
        if (isParenthesizedFunctionCall(freeCallNode)) {
          markCppAdlSiteNoAdl(filePath, adlAnchorRange.startLine, adlAnchorRange.startCol);
        }
        const adlArgs = inferCppCallAdlArgs(freeCallNode);
        if (adlArgs.length > 0) {
          markCppAdlSiteArgs(filePath, adlAnchorRange.startLine, adlAnchorRange.startCol, adlArgs);
        }
      }
    }

    // ── Post-process @type-binding.assignment for auto declarations ──
    // The wildcard `type: (_)` in the @type-binding.assignment query
    // pattern matches before the more specific @type-binding.alias and
    // @type-binding.member-access patterns. When the type is `auto`
    // (placeholder_type_specifier), we re-inspect the AST to synthesize
    // the correct capture tags so interpret.ts can produce the right
    // rawTypeName for compound-receiver chain resolution.
    if (
      grouped['@type-binding.assignment'] !== undefined &&
      grouped['@type-binding.type']?.text === 'auto'
    ) {
      const anchor = grouped['@type-binding.assignment']!;
      const declNode = findNodeAtRange(tree.rootNode, anchor.range, 'declaration');
      if (declNode !== null) {
        const declarator = declNode.childForFieldName('declarator');
        if (declarator?.type === 'init_declarator') {
          const valueNode = declarator.childForFieldName('value');
          if (valueNode !== null) {
            if (valueNode.type === 'identifier') {
              // auto alias = existingVar → promote to @type-binding.alias
              grouped['@type-binding.alias'] = anchor;
              grouped['@type-binding.type'] = nodeToCapture('@type-binding.type', valueNode);
              delete grouped['@type-binding.assignment'];
            } else if (valueNode.type === 'field_expression') {
              // auto addr = user.address → promote to @type-binding.member-access
              const argNode = valueNode.childForFieldName('argument');
              const fieldNode = valueNode.childForFieldName('field');
              if (argNode !== null && fieldNode !== null) {
                grouped['@type-binding.member-access'] = anchor;
                grouped['@type-binding.member-access-receiver'] = nodeToCapture(
                  '@type-binding.member-access-receiver',
                  argNode,
                );
                grouped['@type-binding.type'] = nodeToCapture('@type-binding.type', fieldNode);
                delete grouped['@type-binding.assignment'];
              }
            } else if (valueNode.type === 'call_expression') {
              const fnNode = valueNode.childForFieldName('function');
              if (fnNode?.type === 'field_expression') {
                // auto city = addr.getCity() → promote to @type-binding.alias
                // with dotted rawName "addr.getCity" for compound-receiver
                const argNode = fnNode.childForFieldName('argument');
                const fieldNode = fnNode.childForFieldName('field');
                if (argNode !== null && fieldNode !== null) {
                  grouped['@type-binding.member-access'] = anchor;
                  grouped['@type-binding.member-access-receiver'] = nodeToCapture(
                    '@type-binding.member-access-receiver',
                    argNode,
                  );
                  grouped['@type-binding.type'] = nodeToCapture('@type-binding.type', fieldNode);
                  delete grouped['@type-binding.assignment'];
                }
              }
            }
          }
        }
      }
    }

    out.push(grouped);
  }

  // ── Emit inheritance references for scope-resolution MRO / EXTENDS ──
  // Walk every class/struct base list and synthesize `@reference.inherits`
  // captures consumed by the registry-primary graph bridge. The lookup name
  // is normalized to the bare class name so `Base<T>` / `outer::v1::Base<T>`
  // resolve through V1's simple-name `findClassBindingInScope('Base')`.
  emitCppInheritanceCaptures(tree.rootNode, out);

  // ── Detect dependent-base relationships for two-phase template lookup ──
  // Walk the tree once, finding every `template_declaration` whose
  // child is a class/struct definition with a `base_class_clause` whose
  // base names reference an in-scope template parameter. Record the
  // (className, dependentBaseName) pair so `populateCppDependentBases`
  // (called from the `populateOwners` hook) can resolve names to nodeIds
  // and the resolver can suppress unqualified-call binding to those
  // bases per ISO C++ two-phase lookup.
  detectCppDependentBases(tree.rootNode, filePath);

  return out;
}

/**
 * Walk every C++ class/struct base clause and emit `@reference.inherits`
 * captures for each base so scope resolution can resolve them into EXTENDS
 * edges. Lookup names are normalized to bare class names (`Base<T>` → `Base`,
 * `outer::v1::Base<T>` → `Base`) to match the V1 simple-name
 * `findClassBindingInScope` contract. This intentionally preserves the
 * existing scope-chain tradeoff: qualified namespace context is discarded
 * here instead of introducing a C++-only name-resolution lane in shared
 * ingestion infrastructure.
 */
function emitCppInheritanceCaptures(root: SyntaxNode, out: CaptureMatch[]): void {
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'class_specifier' || node.type === 'struct_specifier') {
      const baseClause = findChildOfType(node, ['base_class_clause']);
      if (baseClause !== null) {
        for (const base of iterBaseClasses(baseClause)) {
          const baseName = extractBaseLookupName(base);
          if (baseName.length === 0) continue;
          out.push({
            '@reference.inherits': nodeToCapture('@reference.inherits', base),
            '@reference.name': syntheticCapture('@reference.name', base, baseName),
          });
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child !== null) stack.push(child);
    }
  }
}

/**
 * Walk the AST finding every template_declaration containing a class or
 * struct definition with a dependent base. Records (className, baseName)
 * pairs into the module-level state via `markCppDependentBase`.
 *
 * A base is "dependent" when its name (typically a template_type like
 * `Base<T>`) uses a template parameter of the enclosing template_declaration.
 * Conservative bias: `typename T::U`, `decltype(...)` and template-template
 * parameter shapes are also treated as dependent.
 */
function detectCppDependentBases(root: SyntaxNode, filePath: string): void {
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'template_declaration') {
      // Collect template-parameter names declared by this declaration.
      // Inner template_declarations shadow outer ones — handled by the
      // recursive descent below (each template_declaration creates its
      // own parameter scope).
      const params = collectTemplateParameterNames(node);

      // Find the class/struct definition inside this template_declaration.
      const classNode = findChildOfType(node, ['class_specifier', 'struct_specifier']);
      if (classNode !== null) {
        const className = getTypeIdentifierName(classNode);
        if (className !== '') {
          const baseClause = findChildOfType(classNode, ['base_class_clause']);
          if (baseClause !== null) {
            for (const base of iterBaseClasses(baseClause)) {
              if (isBaseDependent(base, params)) {
                const baseName = extractBaseLookupName(base);
                if (baseName !== '') {
                  markCppDependentBase(filePath, className, baseName);
                }
              }
            }
          }
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child !== null) stack.push(child);
    }
  }
}

/** Collect simple template parameter names from a template_declaration. */
function collectTemplateParameterNames(templateDecl: SyntaxNode): Set<string> {
  const names = new Set<string>();
  const paramList = findChildOfType(templateDecl, ['template_parameter_list']);
  if (paramList === null) return names;
  for (let i = 0; i < paramList.childCount; i++) {
    const param = paramList.child(i);
    if (param === null) continue;
    if (
      param.type === 'type_parameter_declaration' ||
      param.type === 'optional_type_parameter_declaration' ||
      param.type === 'variadic_type_parameter_declaration'
    ) {
      const idNode = findFirstDescendantOfType(param, 'type_identifier');
      if (idNode !== null) names.add(idNode.text);
    } else if (
      param.type === 'parameter_declaration' ||
      param.type === 'optional_parameter_declaration' ||
      param.type === 'variadic_parameter_declaration'
    ) {
      // Non-type template parameter (e.g. `template<int N>`).
      const idNode = findFirstDescendantOfType(param, 'identifier');
      if (idNode !== null) names.add(idNode.text);
    } else if (param.type === 'template_template_parameter_declaration') {
      // template-template parameter (e.g. `template<template<class> class TT>`)
      const idNode = findFirstDescendantOfType(param, 'type_identifier');
      if (idNode !== null) names.add(idNode.text);
    }
  }
  return names;
}

/** Yield each base-class entry from a `base_class_clause`. */
function* iterBaseClasses(baseClause: SyntaxNode): IterableIterator<SyntaxNode> {
  for (let i = 0; i < baseClause.childCount; i++) {
    const child = baseClause.child(i);
    if (child === null) continue;
    // Skip ':', ',', and access_specifier nodes — the base names are
    // type_identifier, template_type, or qualified_identifier.
    if (
      child.type === 'type_identifier' ||
      child.type === 'template_type' ||
      child.type === 'qualified_identifier'
    ) {
      yield child;
    }
  }
}

/**
 * A base is dependent when:
 *   - it's a `template_type` and its argument list contains a
 *     `type_identifier` matching one of the enclosing template's params
 *     (e.g., `Base<T>` where `T` is a template parameter), OR
 *   - it contains a `typename`, `decltype`, or `template_template_parameter`
 *     shape (conservatively treated as dependent).
 *
 * Non-dependent: `Base<int>`, `ConcreteBase`, `Base<MyConcrete>` where
 * `MyConcrete` is not a template parameter.
 */
function isBaseDependent(baseNode: SyntaxNode, templateParams: Set<string>): boolean {
  if (baseNode.type !== 'template_type') {
    // Bare `type_identifier` or `qualified_identifier` bases — not
    // dependent (the base name itself doesn't reference a template
    // parameter at this level).
    return false;
  }
  // Walk all descendants of the template_argument_list looking for any
  // type_identifier matching a template parameter, or any conservative-
  // dependent shape.
  const stack: SyntaxNode[] = [baseNode];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'type_identifier' && templateParams.has(node.text)) {
      return true;
    }
    if (
      node.type === 'decltype' ||
      node.type === 'dependent_type' ||
      node.type === 'template_template_parameter_declaration'
    ) {
      return true;
    }
    if (node.type === 'qualified_identifier') {
      // `typename T::U` or `T::nested` — if any inner identifier matches
      // a template parameter, dependent.
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c !== null) stack.push(c);
      }
      continue;
    }
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c !== null) stack.push(c);
    }
  }
  return false;
}

/**
 * Recursively extract the bare lookup name of a base class node.
 * Examples: `Base` → `Base`, `Base<T>` → `Base`,
 * `outer::v1::Base<T>` → `Base`. Namespace qualifiers are intentionally
 * dropped to align with V1 scope-chain lookup everywhere else in the
 * registry-primary pipeline.
 */
function extractBaseLookupName(baseNode: SyntaxNode): string {
  if (baseNode.type === 'type_identifier' || baseNode.type === 'identifier') return baseNode.text;
  if (baseNode.type === 'template_type') {
    const nameNode = baseNode.childForFieldName('name');
    if (nameNode !== null) return extractBaseLookupName(nameNode);
    const id =
      findFirstDescendantOfType(baseNode, 'type_identifier') ??
      findFirstDescendantOfType(baseNode, 'identifier');
    if (id !== null) return id.text;
  }
  if (baseNode.type === 'qualified_identifier') {
    const nameNode = baseNode.childForFieldName('name');
    if (nameNode !== null) {
      const nested = extractBaseLookupName(nameNode);
      if (nested.length > 0) return nested;
    }
    for (let i = baseNode.childCount - 1; i >= 0; i--) {
      const child = baseNode.child(i);
      if (child === null) continue;
      const nested = extractBaseLookupName(child);
      if (nested.length > 0) return nested;
    }
  }
  return '';
}

/** Find the first direct child matching one of the given types. */
function findChildOfType(node: SyntaxNode, types: readonly string[]): SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c !== null && types.includes(c.type)) return c;
  }
  return null;
}

/** Recursive search for the first descendant of a given type. */
function findFirstDescendantOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  if (node.type === type) return node;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c === null) continue;
    const hit = findFirstDescendantOfType(c, type);
    if (hit !== null) return hit;
  }
  return null;
}

/** Get the name of a class/struct/template_type node via its `name` field. */
function getTypeIdentifierName(node: SyntaxNode): string {
  const nameNode = node.childForFieldName('name');
  if (nameNode !== null) return nameNode.text;
  const id = findFirstDescendantOfType(node, 'type_identifier');
  return id !== null ? id.text : '';
}

/**
 * Infer argument types from a call_expression or new_expression node.
 * Used for overload disambiguation by parameter types.
 *
 * Only literal types are inferred — identifiers and complex expressions
 * return empty string (unknown) so narrowOverloadCandidates treats them
 * as any-match.
 */
function inferCppCallArgTypes(node: SyntaxNode): string[] | undefined {
  const argList = node.childForFieldName('arguments');
  if (argList === null) return undefined;

  const types: string[] = [];
  for (let i = 0; i < argList.childCount; i++) {
    const child = argList.child(i);
    if (child === null) continue;
    if (child.type === ',' || child.type === '(' || child.type === ')') continue;
    const litType = inferCppLiteralType(child);
    if (litType !== '') {
      types.push(litType);
    } else if (child.type === 'identifier') {
      // Variable reference — look up declared type in enclosing scope
      types.push(lookupDeclaredTypeForIdentifier(child));
    } else {
      types.push('');
    }
  }
  return types.length > 0 ? types : undefined;
}

/**
 * Infer the canonical type name of a C++ literal AST node.
 * Returns empty string for non-literal / unknown nodes.
 */
function inferCppLiteralType(node: SyntaxNode): string {
  switch (node.type) {
    case 'number_literal': {
      const text = node.text;
      // Floating-point literals contain '.', 'e', 'E', or end with 'f'/'F'
      if (
        text.includes('.') ||
        text.includes('e') ||
        text.includes('E') ||
        text.endsWith('f') ||
        text.endsWith('F')
      ) {
        return 'double';
      }
      return 'int';
    }
    case 'string_literal':
    case 'raw_string_literal':
    case 'concatenated_string':
      return 'string';
    case 'char_literal':
      return 'char';
    case 'true':
    case 'false':
      return 'bool';
    case 'null':
    case 'nullptr':
      return 'null';
    default:
      return '';
  }
}

/**
 * Look up the declared type of a variable by scanning sibling declarations
 * in the enclosing compound_statement (function body). Handles:
 *   - `std::string result = ...` → 'string'
 *   - `int n = ...` → 'int'
 *   - `const int n = ...` → 'int'
 * Returns empty string if no declaration found or type is auto/placeholder.
 */
function lookupDeclaredTypeForIdentifier(identNode: SyntaxNode): string {
  const varName = identNode.text;
  // Walk up to the enclosing compound_statement (function body)
  let scope: SyntaxNode | null = identNode.parent;
  while (
    scope !== null &&
    scope.type !== 'compound_statement' &&
    scope.type !== 'translation_unit'
  ) {
    scope = scope.parent;
  }
  if (scope === null) return '';

  // Scan declarations in the scope for a matching variable name
  for (let i = 0; i < scope.childCount; i++) {
    const stmt = scope.child(i);
    if (stmt === null || stmt.type !== 'declaration') continue;

    const typeNode = stmt.childForFieldName('type');
    if (typeNode === null) continue;
    // Skip auto/placeholder types — those need chain-follow, not literal
    if (typeNode.type === 'placeholder_type_specifier') continue;

    // Check init_declarator children for the variable name
    const declarator = stmt.childForFieldName('declarator');
    if (declarator === null) continue;
    if (declarator.type === 'init_declarator') {
      const nameChild = declarator.childForFieldName('declarator');
      if (nameChild !== null && nameChild.text === varName) {
        return normalizeCppTypeText(typeNode.text);
      }
    } else if (declarator.text === varName) {
      return normalizeCppTypeText(typeNode.text);
    }
  }
  return '';
}

/** Normalize a type-specifier text for argument type matching.
 *  Strips qualifiers (const, volatile), namespace prefixes (std::),
 *  and pointer/reference markers. */
function normalizeCppTypeText(text: string): string {
  let t = text.trim();
  t = t.replace(/\b(const|volatile|static|extern|mutable)\b/g, '').trim();
  t = t.replace(/^.*::/, ''); // strip namespace prefix
  t = t.replace(/[*&]/g, '').trim();
  return t;
}

/**
 * Detect whether a `namespace_definition` AST node is inline.
 * Tree-sitter-cpp exposes the `inline` keyword as an anonymous child
 * node — we scan direct children for that keyword.
 */
function isInlineNamespace(nsNode: SyntaxNode): boolean {
  for (let i = 0; i < nsNode.childCount; i++) {
    const c = nsNode.child(i);
    if (c === null) continue;
    if (c.type === 'inline') return true;
    // Some grammar variants surface keywords by their text rather than
    // by a dedicated node type; check both for resilience.
    if (c.text === 'inline' && (c.type === 'storage_class_specifier' || c.type === 'inline')) {
      return true;
    }
  }
  return false;
}

/**
 * Detect `(f)(args)` shape — the call-expression's `function` field is a
 * `parenthesized_expression`. ISO C++ specifies that this form suppresses
 * ADL (`[basic.lookup.argdep]/3.1`): the parenthesized name is treated as
 * an ordinary unqualified-lookup-only callee.
 */
function isParenthesizedFunctionCall(callNode: SyntaxNode): boolean {
  const fn = callNode.childForFieldName('function');
  return fn !== null && fn.type === 'parenthesized_expression';
}

/**
 * Per-argument ADL classification: walk each argument of a free call and
 * classify its declared type for associated-namespace lookup.
 *
 * Value/pointer/reference class-typed args and template specializations
 * with explicit type arguments contribute; function pointers, primitives,
 * literals, and other unsupported shapes produce an empty result.
 *
 * Class-typed values/pointers/references (`N::S`, `N::S*`, `N::S&`) all
 * preserve the class name for associated-namespace lookup.
 * Function pointers remain excluded even when their return type names a
 * class, because the associated entity is the pointed-to function type,
 * not the return type.
 */
function inferCppCallAdlArgs(callNode: SyntaxNode): CppAdlArgInfo[] {
  const argList = callNode.childForFieldName('arguments');
  if (argList === null) return [];
  const out: CppAdlArgInfo[] = [];
  for (let i = 0; i < argList.childCount; i++) {
    const child = argList.child(i);
    if (child === null) continue;
    if (child.type === ',' || child.type === '(' || child.type === ')') continue;
    out.push(classifyAdlArg(child));
  }
  return out;
}

const ADL_TEMPLATE_RECURSION_MAX_DEPTH = 8;
const EMPTY_ADL_ARG: CppAdlArgInfo = {
  simpleClassName: '',
  templateSimpleClassName: '',
  templateNamespace: '',
  templateArgClassNames: [],
  templateArgNamespaces: [],
};

function classifyAdlArg(argNode: SyntaxNode): CppAdlArgInfo {
  // Literals and primitive-shaped expressions never have associated namespaces.
  if (
    argNode.type === 'number_literal' ||
    argNode.type === 'string_literal' ||
    argNode.type === 'raw_string_literal' ||
    argNode.type === 'char_literal' ||
    argNode.type === 'true' ||
    argNode.type === 'false' ||
    argNode.type === 'null' ||
    argNode.type === 'nullptr'
  ) {
    return EMPTY_ADL_ARG;
  }
  // Variable reference — look up its declared type (preserving pointer /
  // reference / qualified-name shape; the existing arity-narrowing helper
  // strips this info).
  if (argNode.type === 'identifier') {
    return lookupAdlIdentifierType(argNode);
  }
  // Other shapes (calls, member access, operators) — V1 unsupported.
  return EMPTY_ADL_ARG;
}

function lookupAdlIdentifierType(identNode: SyntaxNode): CppAdlArgInfo {
  const varName = identNode.text;
  let scope: SyntaxNode | null = identNode.parent;
  while (
    scope !== null &&
    scope.type !== 'compound_statement' &&
    scope.type !== 'translation_unit'
  ) {
    scope = scope.parent;
  }
  if (scope === null) return EMPTY_ADL_ARG;

  for (let i = 0; i < scope.childCount; i++) {
    const stmt = scope.child(i);
    if (stmt === null || stmt.type !== 'declaration') continue;
    const typeNode = stmt.childForFieldName('type');
    if (typeNode === null) continue;
    if (typeNode.type === 'placeholder_type_specifier') continue;

    const declarator = stmt.childForFieldName('declarator');
    if (declarator === null) continue;

    // Unwrap declarator chain to find pointer/reference markers and the
    // variable name. `init_declarator > pointer_declarator > identifier`
    // means pointer-typed; repeated pointer wrappers still count as pointer
    // typed; `init_declarator > reference_declarator > ...` (or
    // `rvalue_reference_declarator`) means reference-typed; bare
    // `init_declarator > identifier` is value.
    // Function-pointer wrappers (`pointer_declarator > function_declarator`)
    // must not contribute ADL associated namespaces.
    let isFunctionPointer = false;
    let inner: SyntaxNode = declarator;
    let nameText: string | null = null;
    let safety = 16; // bound walk depth defensively
    while (safety-- > 0) {
      if (inner.type === 'pointer_declarator') {
        if (findFirstDescendantOfType(inner, 'function_declarator') !== null) {
          isFunctionPointer = true;
          break;
        }
        const next = inner.childForFieldName('declarator');
        if (next === null) break;
        inner = next;
        continue;
      }
      if (inner.type === 'reference_declarator' || inner.type === 'rvalue_reference_declarator') {
        // reference_declarator has a single child (the inner declarator).
        let next: SyntaxNode | null = null;
        for (let j = 0; j < inner.namedChildCount; j++) {
          const c = inner.namedChild(j);
          if (c !== null) {
            next = c;
            break;
          }
        }
        if (next === null) break;
        inner = next;
        continue;
      }
      if (inner.type === 'init_declarator') {
        const next = inner.childForFieldName('declarator');
        if (next === null) break;
        inner = next;
        continue;
      }
      if (inner.type === 'function_declarator') {
        isFunctionPointer = true;
        break;
      }
      // Reached the leaf — usually `identifier`. Take its text.
      nameText = inner.text;
      break;
    }
    if (isFunctionPointer || nameText !== varName) continue;

    const simpleClassName = extractAdlSimpleTypeName(typeNode);
    const {
      templateSimpleClassName,
      templateNamespace,
      templateArgClassNames,
      templateArgNamespaces,
    } = extractAdlTemplateInfo(typeNode);
    return {
      simpleClassName,
      templateSimpleClassName,
      templateNamespace,
      templateArgClassNames,
      templateArgNamespaces,
    };
  }
  return EMPTY_ADL_ARG;
}

/** Extract the simple class-like type name from a `type:` field node.
 *  Returns '' for primitives and any other
 *  unsupported type-only shape. Function pointers are filtered at the
 *  declarator level in `lookupAdlIdentifierType`. */
function extractAdlSimpleTypeName(typeNode: SyntaxNode): string {
  if (typeNode.type === 'type_descriptor') {
    const innerType = typeNode.childForFieldName('type');
    if (innerType !== null) return extractAdlSimpleTypeName(innerType);
    for (let i = 0; i < typeNode.childCount; i++) {
      const child = typeNode.child(i);
      if (child === null) continue;
      if (
        child.type === 'type_identifier' ||
        child.type === 'qualified_identifier' ||
        child.type === 'template_type'
      ) {
        return extractAdlSimpleTypeName(child);
      }
    }
    return '';
  }
  if (typeNode.type === 'primitive_type') return '';
  if (typeNode.type === 'sized_type_specifier') return '';
  if (typeNode.type === 'type_identifier') return typeNode.text;
  if (typeNode.type === 'template_type') {
    const nameNode = typeNode.childForFieldName('name');
    if (nameNode !== null) return extractAdlSimpleTypeName(nameNode);
    const id = findFirstDescendantOfType(typeNode, 'type_identifier');
    return id !== null ? id.text : '';
  }
  if (typeNode.type === 'qualified_identifier') {
    const nameNode = typeNode.childForFieldName('name');
    if (nameNode !== null) return extractAdlSimpleTypeName(nameNode);
    const id = findFirstDescendantOfType(typeNode, 'type_identifier');
    return id !== null ? id.text : '';
  }
  // Function pointers, decltype, etc — unsupported for ADL participation.
  return '';
}

function extractAdlTypeNamespace(typeNode: SyntaxNode): string {
  if (typeNode.type === 'type_descriptor') {
    const innerType = typeNode.childForFieldName('type');
    if (innerType !== null) return extractAdlTypeNamespace(innerType);
    for (let i = 0; i < typeNode.childCount; i++) {
      const child = typeNode.child(i);
      if (child === null) continue;
      if (
        child.type === 'qualified_identifier' ||
        child.type === 'template_type' ||
        child.type === 'type_identifier'
      ) {
        return extractAdlTypeNamespace(child);
      }
    }
    return '';
  }
  if (typeNode.type === 'template_type') {
    const nameNode = typeNode.childForFieldName('name');
    return nameNode !== null ? extractAdlTypeNamespace(nameNode) : '';
  }
  if (typeNode.type === 'qualified_identifier') {
    const scope = typeNode.childForFieldName('scope');
    if (scope !== null) return normalizeCppNamespaceQName(scope.text);
    return extractNamespaceFromQualifiedText(typeNode.text);
  }
  return '';
}

function extractAdlTemplateInfo(typeNode: SyntaxNode): {
  templateSimpleClassName: string;
  templateNamespace: string;
  templateArgClassNames: string[];
  templateArgNamespaces: string[];
} {
  const templateTypeNode = findTemplateTypeNode(typeNode);
  if (templateTypeNode === null) {
    return {
      templateSimpleClassName: '',
      templateNamespace: '',
      templateArgClassNames: [],
      templateArgNamespaces: [],
    };
  }
  const templateArgClassNames: string[] = [];
  const templateArgNamespaces: string[] = [];
  collectAdlTemplateArgs(templateTypeNode, 0, templateArgClassNames, templateArgNamespaces);
  return {
    templateSimpleClassName: extractAdlSimpleTypeName(templateTypeNode),
    templateNamespace: extractAdlTypeNamespace(typeNode),
    templateArgClassNames,
    templateArgNamespaces,
  };
}

function collectAdlTemplateArgs(
  templateTypeNode: SyntaxNode,
  depth: number,
  outClassNames: string[],
  outNamespaces: string[],
): void {
  if (depth >= ADL_TEMPLATE_RECURSION_MAX_DEPTH) return;
  if (templateTypeNode.type !== 'template_type') return;

  const argList =
    templateTypeNode.childForFieldName('arguments') ??
    findChildOfType(templateTypeNode, ['template_argument_list']);
  if (argList === null) return;

  for (let i = 0; i < argList.namedChildCount; i++) {
    const arg = argList.namedChild(i);
    if (arg === null || arg.type !== 'type_descriptor') continue;
    const simpleClassName = extractAdlSimpleTypeName(arg);
    if (simpleClassName.length > 0) outClassNames.push(simpleClassName);
    const ns = extractAdlTypeNamespace(arg);
    if (ns.length > 0) outNamespaces.push(ns);

    const nestedType = arg.childForFieldName('type');
    const nestedTemplate = nestedType !== null ? findTemplateTypeNode(nestedType) : null;
    if (nestedTemplate !== null) {
      collectAdlTemplateArgs(nestedTemplate, depth + 1, outClassNames, outNamespaces);
    }
  }
}

function findTemplateTypeNode(typeNode: SyntaxNode): SyntaxNode | null {
  if (typeNode.type === 'template_type') return typeNode;
  if (typeNode.type === 'type_descriptor') {
    const innerType = typeNode.childForFieldName('type');
    if (innerType !== null) return findTemplateTypeNode(innerType);
    return null;
  }
  if (typeNode.type === 'qualified_identifier') {
    const nameNode = typeNode.childForFieldName('name');
    if (nameNode !== null) return findTemplateTypeNode(nameNode);
    return null;
  }
  return null;
}

function normalizeCppNamespaceQName(text: string): string {
  const normalized = text.replace(/^::/, '').replace(/::$/, '').replace(/::/g, '.');
  return normalized;
}

function extractNamespaceFromQualifiedText(text: string): string {
  const cleaned = text.replace(/\s+/g, '');
  const idx = cleaned.lastIndexOf('::');
  if (idx <= 0) return '';
  return normalizeCppNamespaceQName(cleaned.slice(0, idx));
}

/**
 * Check if a C++ function_definition or declaration has `static` storage class.
 */
function hasStaticStorageClass(node: SyntaxNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child !== null && child.type === 'storage_class_specifier' && child.text === 'static') {
      return true;
    }
  }
  return false;
}

/**
 * Check if a node is inside an anonymous namespace (file-local linkage in C++).
 * Anonymous namespaces have no `name` field in tree-sitter-cpp.
 */
function isInsideAnonymousNamespace(node: SyntaxNode): boolean {
  let ancestor: SyntaxNode | null = node.parent ?? null;
  while (ancestor !== null) {
    if (ancestor.type === 'namespace_definition') {
      // Anonymous namespace: has declaration_list but no name child
      const nameChild = ancestor.childForFieldName?.('name') ?? null;
      if (nameChild === null) return true;
    }
    ancestor = ancestor.parent;
  }
  return false;
}
