import type { Capture, CaptureMatch, ParameterTypeClass } from 'gitnexus-shared';
import {
  nodeIfType,
  nodeToCapture,
  syntheticCapture,
  type SyntaxNode,
} from '../../utils/ast-helpers.js';
import { getCppParser, getCppScopeQuery } from './query.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import { normalizeQualifiedName } from '../../utils/qualified-name.js';
import { splitCppInclude, splitCppUsingDecl } from './import-decomposer.js';
import {
  classifyCppParameterType,
  computeCppDeclarationArity,
  computeCppCallArity,
} from './arity-metadata.js';
import { markCppAnonymousNamespaceRange, markFileLocal } from './file-local-linkage.js';
import { markCppDependentBase, markCppDependentPackBase } from './two-phase-lookup.js';
import { markCppAdlSiteArgs, markCppAdlSiteNoAdl, type CppAdlArgInfo } from './adl.js';
import { markCppInlineNamespaceRange } from './inline-namespaces.js';
import { extractCppTemplateConstraints } from './constraint-extractor.js';
import { captureCppMemberLookupFacts } from './member-lookup.js';
import { CPP_BRACED_INIT_TYPE_PREFIX } from './conversion-rank.js';
import { logger } from '../../../logger.js';

/**
 * Per-file wall-clock budget for the capture-emit loop (#2432). A worker
 * thread stuck in this loop cannot be terminated safely (terminating a
 * thread mid-N-API call aborts the whole process with Napi::Error), so the
 * loop must bound itself: on breach we return the captures accumulated so
 * far with a warning — degraded coverage for one file, never a crash or a
 * thrown error (a throw here would make the language-group catch drop every
 * remaining file in the batch).
 *
 * `GITNEXUS_CPP_CAPTURE_BUDGET_MS`: unset/invalid/negative → 20000; explicit
 * 0 → expires immediately (deterministic test hook).
 */
const CPP_CAPTURE_BUDGET_DEFAULT_MS = 20_000;

function cppCaptureBudgetMs(): number {
  const raw = process.env.GITNEXUS_CPP_CAPTURE_BUDGET_MS;
  if (raw === undefined || raw === '') return CPP_CAPTURE_BUDGET_DEFAULT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : CPP_CAPTURE_BUDGET_DEFAULT_MS;
}

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

  // #2432: reset the per-file lookup index. The identifier-argument type
  // lookups below used to re-walk the AST per identifier (full-tree DFS in
  // isKnownEnumName, per-scope declaration scans) — O(calls × args × treeSize)
  // per file, 151s on a 194KB file that parses in 46ms. The index makes each
  // lookup O(1) after a single lazily-built pass.
  resetCppFileLookupIndex();

  // Track ranges where typedef-struct/enum was captured as its concrete type
  // so we can suppress the duplicate @declaration.typedef match.
  const concreteTypedefRanges = new Set<string>();

  // #2432: per-file deadline for the loop below (see cppCaptureBudgetMs).
  // Checked every 64 matches — post-index a single iteration is microseconds,
  // so the check granularity costs nothing and bounds the drift past the
  // deadline to well under a second.
  const budgetMs = cppCaptureBudgetMs();
  const deadline = Date.now() + budgetMs;
  let matchIndex = 0;

  for (const m of rawMatches) {
    if ((matchIndex++ & 63) === 0 && Date.now() >= deadline) {
      logger.warn(
        { filePath, budgetMs, processedMatches: matchIndex - 1, totalMatches: rawMatches.length },
        `C++ capture extraction exceeded its ${budgetMs}ms budget for ${filePath}; returning partial captures for this file (#2432).`,
      );
      break;
    }
    const grouped: Record<string, Capture> = {};
    // Parallel tag -> captured SyntaxNode map. The tree-sitter query already
    // hands us each matched node as `c.node`, so anchors resolve via a
    // type-guarded lookup (`nodeIfType`) instead of re-deriving them with
    // `findNodeAtRange(tree.rootNode, ...)` per match — the
    // O(matches × rootChildren) root-walk fixed for go #1848 / python #1918 /
    // rust/csharp #1915 / java, mirrored here for C++ (#1951). Each C++
    // scope-query anchor used below captures directly ON the node the old
    // root-walk re-derived (verified against CPP_SCOPE_QUERY in query.ts and a
    // real-parse AST probe), so the type check is exact.
    const nodeMap: Record<string, SyntaxNode> = {};
    for (const c of m.captures) {
      const tag = '@' + c.name;
      if (tag.startsWith('@_')) continue;
      grouped[tag] = nodeToCapture(tag, c.node);
      nodeMap[tag] = c.node;
    }
    if (Object.keys(grouped).length === 0) continue;

    // ── Handle #include statements ──────────────────────────────────
    // `@import.statement` is captured directly on the `preproc_include` node.
    if (grouped['@import.statement'] !== undefined) {
      const includeNode = nodeIfType(nodeMap['@import.statement'], 'preproc_include');
      if (includeNode !== null) {
        const split = splitCppInclude(includeNode);
        if (split !== null) {
          out.push(split);
          continue;
        }
      }
    }

    // ── Handle using declarations (using namespace / using name) ────
    // `@import.using-decl` is captured directly on the `using_declaration` node.
    if (grouped['@import.using-decl'] !== undefined) {
      const usingNode = nodeIfType(nodeMap['@import.using-decl'], 'using_declaration');
      if (usingNode !== null) {
        const split = splitCppUsingDecl(usingNode);
        if (split !== null) {
          out.push(split);
          continue;
        }
      }
    }

    // ── Track concrete typedef ranges ───────────────────────────────
    const concreteTypeAnchor =
      grouped['@declaration.struct'] ??
      grouped['@declaration.class'] ??
      grouped['@declaration.enum'];
    if (concreteTypeAnchor !== undefined) {
      const r = concreteTypeAnchor.range;
      concreteTypedefRanges.add(`${r.startLine}:${r.startCol}:${r.endLine}:${r.endCol}`);
    }

    // Suppress @declaration.typedef if the same range was already captured
    const typedefAnchor = grouped['@declaration.typedef'];
    if (typedefAnchor !== undefined) {
      const r = typedefAnchor.range;
      const key = `${r.startLine}:${r.startCol}:${r.endLine}:${r.endCol}`;
      if (concreteTypedefRanges.has(key)) continue;
    }

    // ── Enrich function/method declarations with arity metadata ─────
    // `@declaration.function` / `@declaration.method` capture directly on the
    // `function_definition` (definitions/templates), `declaration` (free/
    // constructor prototypes), or `field_declaration` (class-body method
    // prototypes) node — the node the old findNodeAtRange re-derived.
    const declAnchorNode = nodeMap['@declaration.function'] ?? nodeMap['@declaration.method'];
    if (declAnchorNode !== undefined) {
      const fnNode = nodeIfType(
        declAnchorNode,
        'function_definition',
        'declaration',
        'field_declaration',
      );
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
        if (arity.parameterTypeClasses !== undefined) {
          grouped['@declaration.parameter-type-classes'] = syntheticCapture(
            '@declaration.parameter-type-classes',
            fnNode,
            JSON.stringify(arity.parameterTypeClasses),
          );
        }
        const returnType = extractCppDeclarationReturnType(fnNode);
        if (returnType !== undefined) {
          grouped['@declaration.return-type'] = syntheticCapture(
            '@declaration.return-type',
            fnNode,
            returnType,
          );
        }
        if (hasExplicitSpecifier(fnNode)) {
          grouped['@declaration.is-explicit'] = syntheticCapture(
            '@declaration.is-explicit',
            fnNode,
            'true',
          );
        }
        if (hasDeletedMethodClause(fnNode, grouped['@declaration.name']?.text)) {
          grouped['@declaration.is-deleted'] = syntheticCapture(
            '@declaration.is-deleted',
            fnNode,
            'true',
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

        // SFINAE / `requires`-clause aware constraints for overload
        // narrowing (issue #1579). Walk from the enclosing
        // `template_declaration` — not the inner `function_definition` —
        // so inline method templates (`template<...> class C { template<...> void f(); }`)
        // pick up the correct outer constraint scope.
        const templateDecl = findEnclosingTemplateDeclaration(fnNode);
        if (templateDecl !== null) {
          const funcDeclarator = findFunctionDeclarator(fnNode);
          const constraints = extractCppTemplateConstraints(templateDecl, funcDeclarator);
          if (constraints !== undefined) {
            grouped['@declaration.template-constraints'] = syntheticCapture(
              '@declaration.template-constraints',
              fnNode,
              JSON.stringify(constraints),
            );
          }
        }
      }
    }

    // ── Detect static variables (file-local linkage) ────────────────
    // `@declaration.variable` is captured directly on the `declaration` node.
    if (grouped['@declaration.variable'] !== undefined) {
      const varNode = nodeIfType(nodeMap['@declaration.variable'], 'declaration');
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
    // `@reference.call.free` / `.member` capture on the `call_expression` (plain
    // / member / template calls) or on the `binary_expression` (the operator-call
    // patterns: `a + b`, `lhs << rhs`); `@reference.call.qualified` always on the
    // `call_expression`. The captured node IS the node the old findNodeAtRange
    // re-derived (verified against CPP_SCOPE_QUERY + a real-parse probe).
    const callAnchor =
      grouped['@reference.call.free'] ??
      grouped['@reference.call.member'] ??
      grouped['@reference.call.qualified'];
    const callAnchorNode =
      nodeMap['@reference.call.free'] ??
      nodeMap['@reference.call.member'] ??
      nodeMap['@reference.call.qualified'];
    const operatorAnchor = grouped['@reference.operator'];
    if (operatorAnchor !== undefined) {
      // When `@reference.operator` fires, the co-captured call anchor is the
      // enclosing `binary_expression` itself, so a type guard reproduces the
      // old findNodeAtRange(callAnchor.range, 'binary_expression').
      const operatorNode =
        callAnchorNode !== undefined ? nodeIfType(callAnchorNode, 'binary_expression') : null;
      if (operatorNode !== null && isPrimitiveOnlyBinaryOperator(operatorNode)) continue;
    }
    if (callAnchorNode !== undefined && grouped['@reference.arity'] === undefined) {
      const callNode = nodeIfType(callAnchorNode, 'call_expression', 'binary_expression');
      if (callNode?.type === 'call_expression') {
        grouped['@reference.arity'] = syntheticCapture(
          '@reference.arity',
          callNode,
          String(computeCppCallArity(callNode)),
        );
      } else if (callNode?.type === 'binary_expression') {
        grouped['@reference.arity'] = syntheticCapture(
          '@reference.arity',
          callNode,
          grouped['@reference.call.member'] !== undefined ? '1' : '2',
        );
      }
    }

    if (operatorAnchor !== undefined && grouped['@reference.name'] === undefined) {
      // The old code did `findNodeAtRange(tree.rootNode, operatorAnchor.range,
      // operatorAnchor.text)`, searching for a node of type `+` / `<<` at the
      // operator-token range. That token is an UNNAMED grammar node, and
      // findNodeAtRange only descends `namedChild`ren, so the search NEVER hit
      // and ALWAYS fell back to `tree.rootNode`. Use `tree.rootNode` directly to
      // preserve the exact synthetic-capture range while dropping the root-walk.
      grouped['@reference.name'] = syntheticCapture(
        '@reference.name',
        tree.rootNode,
        `operator${operatorAnchor.text}`,
      );
    }

    // ── Enrich constructor calls (new Foo()) with arity ─────────────
    // `@reference.call.constructor` is captured directly on the `new_expression`.
    const ctorCallAnchor = grouped['@reference.call.constructor'];
    const ctorCallAnchorNode = nodeMap['@reference.call.constructor'];
    if (ctorCallAnchor !== undefined && grouped['@reference.arity'] === undefined) {
      const newNode = nodeIfType(ctorCallAnchorNode, 'new_expression');
      if (newNode !== null) {
        grouped['@reference.arity'] = syntheticCapture(
          '@reference.arity',
          newNode,
          String(computeCppCallArity(newNode)),
        );
      }
    }

    // ── Synthesize argument types for overload narrowing ────────────
    // The any-call anchor is either the call/operator anchor (`call_expression`
    // / `binary_expression`) or the constructor anchor (`new_expression`); the
    // captured node IS what the old findNodeAtRange re-derived.
    const anyCallAnchor = callAnchor ?? ctorCallAnchor;
    const anyCallAnchorNode = callAnchorNode ?? ctorCallAnchorNode;
    if (anyCallAnchor !== undefined && grouped['@reference.parameter-types'] === undefined) {
      const cNode = nodeIfType(
        anyCallAnchorNode,
        'call_expression',
        'new_expression',
        'binary_expression',
      );
      if (cNode !== null) {
        const argTypes =
          cNode.type === 'binary_expression'
            ? inferCppBinaryOperatorArgTypes(cNode, grouped['@reference.call.free'] !== undefined)
            : inferCppCallArgTypes(cNode);
        if (argTypes !== undefined && argTypes.length > 0) {
          grouped['@reference.parameter-types'] = syntheticCapture(
            '@reference.parameter-types',
            cNode,
            JSON.stringify(argTypes),
          );
        }
        const argTypeClasses =
          cNode.type === 'binary_expression'
            ? inferCppBinaryOperatorArgTypeClasses(
                cNode,
                grouped['@reference.call.free'] !== undefined,
              )
            : inferCppCallArgTypeClasses(cNode);
        if (argTypeClasses !== undefined && argTypeClasses.length > 0) {
          grouped['@reference.parameter-type-classes'] = syntheticCapture(
            '@reference.parameter-type-classes',
            cNode,
            JSON.stringify(argTypeClasses),
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
    // `@declaration.namespace` and `@scope.namespace` both capture directly on
    // the `namespace_definition` node.
    const namespaceScopeAnchorNode =
      nodeMap['@declaration.namespace'] ?? nodeMap['@scope.namespace'];
    if (namespaceScopeAnchorNode !== undefined) {
      const nsNode = nodeIfType(namespaceScopeAnchorNode, 'namespace_definition');
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
      // `@reference.call.free` captures on a `call_expression` (plain/template
      // free call) or a `binary_expression` (the `lhs << rhs` operator-call
      // pattern). The old findNodeAtRange filtered to `call_expression`, so the
      // `binary_expression` case yields null here — `nodeIfType` matches exactly.
      const freeCallNode = nodeIfType(nodeMap['@reference.call.free'], 'call_expression');
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
      // `@type-binding.assignment` is captured directly on the `declaration` node.
      const declNode = nodeIfType(nodeMap['@type-binding.assignment'], 'declaration');
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
  emitCppInheritanceCaptures(tree.rootNode, out, filePath);

  // ── Detect dependent-base relationships for two-phase template lookup ──
  // Walk the tree once, finding every `template_declaration` whose
  // child is a class/struct definition with a `base_class_clause` whose
  // base names reference an in-scope template parameter. Record the
  // (className, dependentBaseName) pair so `populateCppDependentBases`
  // (called from the `populateOwners` hook) can resolve names to nodeIds
  // and the resolver can suppress unqualified-call binding to those
  // bases per ISO C++ two-phase lookup.
  detectCppDependentBases(tree.rootNode, filePath);
  captureCppMemberLookupFacts(tree.rootNode, filePath);

  return out;
}

function extractCppDeclarationReturnType(fnNode: SyntaxNode): string | undefined {
  const typeNode = fnNode.childForFieldName('type');
  if (typeNode === null) return undefined;
  const funcDeclarator = findFunctionDeclarator(fnNode);
  if (funcDeclarator !== null && isCppUnsupportedReturnTypeDeclarator(funcDeclarator)) {
    return undefined;
  }
  const typeText = typeNode.text.trim();
  if (typeText !== 'auto') return typeText.length > 0 ? typeText : undefined;
  if (funcDeclarator === null) return typeText;
  for (let i = 0; i < funcDeclarator.namedChildCount; i++) {
    const child = funcDeclarator.namedChild(i);
    if (child?.type !== 'trailing_return_type') continue;
    const typeDesc = child.firstNamedChild;
    return typeDesc?.text.trim() || typeText;
  }
  return typeText;
}

function isCppUnsupportedReturnTypeDeclarator(funcDeclarator: SyntaxNode): boolean {
  const text = funcDeclarator.text;
  return /\boperator\b/.test(text) || /(^|[(:\s])~\s*[A-Za-z_]\w*/.test(text);
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
function emitCppInheritanceCaptures(root: SyntaxNode, out: CaptureMatch[], filePath: string): void {
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'class_specifier' || node.type === 'struct_specifier') {
      const baseClause = findChildOfType(node, ['base_class_clause']);
      if (baseClause !== null) {
        for (const base of iterBaseClasses(baseClause)) {
          if (base.isPackExpansion) {
            markClassWithPackExpandedBase(filePath, node);
            continue;
          }
          const baseName = extractBaseLookupName(base.node);
          if (baseName.length === 0) continue;
          // Preserve the qualified form (`Other::Inner`, template-stripped) when the
          // source wrote one, so a same-tail nested base resolves to the matching
          // qualified node instead of the first-inserted same-tail one (#1982). The
          // bare `@reference.name` stays the V1 simple-name contract; the qualifier
          // is an additive sidecar resolution tries first (see resolveInheritanceBaseInScope).
          const qualifiedBaseName = extractQualifiedBaseName(base.node);
          out.push({
            '@reference.inherits': nodeToCapture('@reference.inherits', base.node),
            '@reference.name': syntheticCapture('@reference.name', base.node, baseName),
            ...(qualifiedBaseName.length > 0 && qualifiedBaseName !== baseName
              ? {
                  '@reference.qualified-name': syntheticCapture(
                    '@reference.qualified-name',
                    base.node,
                    qualifiedBaseName,
                  ),
                }
              : {}),
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
              if (base.isPackExpansion || isBaseDependent(base.node, params)) {
                if (base.isPackExpansion) {
                  markClassWithPackExpandedBase(filePath, classNode);
                }
                const baseName = extractBaseLookupName(base.node);
                const baseQualifier = extractBaseLookupQualifier(base.node);
                if (baseName !== '') {
                  markCppDependentBase(filePath, className, baseName, baseQualifier);
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

function markClassWithPackExpandedBase(filePath: string, classNode: SyntaxNode): void {
  const className = getTypeIdentifierName(classNode);
  if (className !== '') markCppDependentPackBase(filePath, className);
}

interface CppBaseClassEntry {
  readonly node: SyntaxNode;
  readonly isPackExpansion: boolean;
}

/** Yield each base-class entry from a `base_class_clause`. */
function* iterBaseClasses(baseClause: SyntaxNode): IterableIterator<CppBaseClassEntry> {
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
      yield { node: child, isPackExpansion: isFollowedByPackExpansion(baseClause, i) };
    }
  }
}

function isFollowedByPackExpansion(baseClause: SyntaxNode, childIndex: number): boolean {
  for (let i = childIndex + 1; i < baseClause.childCount; i++) {
    const sibling = baseClause.child(i);
    if (sibling === null) continue;
    if (sibling.type === '...' || (!sibling.isNamed && sibling.text === '...')) return true;
    if (sibling.type === ',' || sibling.type === 'access_specifier') return false;
    if (sibling.type === 'comment') continue;
    if (sibling.isNamed) return false;
  }
  return false;
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
    if (baseNode.type === 'qualified_identifier') {
      // Qualified identifier bases (e.g. `detail::Inner<T>`) may contain
      // template_type children — descend into them for template param check.
      // Fall through to the stack walk below.
    } else {
      // Bare `type_identifier` bases — not dependent.
      return false;
    }
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

/**
 * Like `extractBaseLookupName` but PRESERVES the namespace/class qualifier
 * (`Other::Inner`, `ns::v1::Base`) while stripping template arguments
 * (`ns::Base<T>` → `ns::Base`). Returns `''` for shapes it can't qualify, and
 * returns the bare name unchanged for an unqualified base (the emit site then
 * skips the sidecar capture). Powers `@reference.qualified-name` so #1982
 * resolution can pick the matching same-tail nested base via the full-path
 * QualifiedNameIndex instead of the first-inserted same-tail sibling.
 */
function extractQualifiedBaseName(baseNode: SyntaxNode): string {
  if (baseNode.type === 'template_type') {
    const nameNode = baseNode.childForFieldName('name');
    return nameNode !== null ? extractQualifiedBaseName(nameNode) : '';
  }
  if (baseNode.type === 'qualified_identifier') {
    // No template args anywhere → the raw text already IS the qualified name.
    if (!baseNode.text.includes('<')) return baseNode.text;
    // Template args present: reconstruct scope::name, recursing to strip them.
    const scopeNode = baseNode.childForFieldName('scope');
    const nameNode = baseNode.childForFieldName('name');
    const left = scopeNode !== null ? extractQualifiedBaseName(scopeNode) : '';
    const right = nameNode !== null ? extractQualifiedBaseName(nameNode) : '';
    if (left.length > 0 && right.length > 0) return `${left}::${right}`;
    return right.length > 0 ? right : left;
  }
  if (
    baseNode.type === 'namespace_identifier' ||
    baseNode.type === 'type_identifier' ||
    baseNode.type === 'identifier'
  ) {
    return baseNode.text;
  }
  return '';
}

/** Extract the syntactic namespace qualifier from a base class node.
 *  For `detail::Inner<T>`, returns `'detail'`.
 *  For unqualified bases (`Inner<T>`, `Base<int>`), returns `''`.
 *  Nested qualifiers (`a::b::Inner<T>`) return the full scope text.
 */
function extractBaseLookupQualifier(baseNode: SyntaxNode): string {
  if (baseNode.type === 'qualified_identifier') {
    const scopeNode = baseNode.childForFieldName('scope');
    if (scopeNode !== null) return scopeNode.text;
  }
  // template_type nodes may have a qualified_identifier as their name child
  if (baseNode.type === 'template_type') {
    const nameNode = baseNode.childForFieldName('name');
    if (nameNode !== null && nameNode.type === 'qualified_identifier') {
      const scopeNode = nameNode.childForFieldName('scope');
      if (scopeNode !== null) return scopeNode.text;
    }
  }
  return '';
}

/**
 * Walk parent chain from a function_definition / declaration / field_declaration
 * to find the enclosing `template_declaration`. Returns null when the function
 * isn't templated. The walk only ascends through wrapper nodes the C++
 * grammar inserts between `template_declaration` and the function — direct
 * parent in the common case, two hops for member templates whose outer
 * class is also templated (we return the INNERMOST template_declaration,
 * which carries this function's own template parameters).
 */
function findEnclosingTemplateDeclaration(fnNode: SyntaxNode): SyntaxNode | null {
  let cur: SyntaxNode | null = fnNode.parent;
  // Cap the walk — `template_declaration` is typically the immediate parent
  // or one wrapper away. Anything deeper is an inline-method-in-template
  // shape and we still want the innermost templates_declaration whose body
  // wraps `fnNode`.
  let hops = 8;
  while (cur !== null && hops-- > 0) {
    if (cur.type === 'template_declaration') return cur;
    // Don't ascend past structural boundaries that should reset template scope.
    if (cur.type === 'translation_unit') return null;
    cur = cur.parent;
  }
  return null;
}

/**
 * Locate the `function_declarator` AST node within a function definition
 * or declaration. Unwraps pointer/reference declarator wrappers. Returns
 * null when no function_declarator is found (e.g. variable declaration
 * mis-classified upstream).
 */
function findFunctionDeclarator(fnNode: SyntaxNode): SyntaxNode | null {
  const direct = fnNode.childForFieldName('declarator');
  let cur: SyntaxNode | null = direct;
  let hops = 8;
  while (cur !== null && hops-- > 0) {
    if (cur.type === 'function_declarator') return cur;
    if (cur.type === 'pointer_declarator' || cur.type === 'reference_declarator') {
      cur = cur.childForFieldName('declarator');
      continue;
    }
    break;
  }
  return findFirstDescendantOfType(fnNode, 'function_declarator');
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

function inferCppCallArgTypeClasses(node: SyntaxNode): ParameterTypeClass[] | undefined {
  const argList = node.childForFieldName('arguments');
  if (argList === null) return undefined;

  const classes: ParameterTypeClass[] = [];
  for (let i = 0; i < argList.childCount; i++) {
    const child = argList.child(i);
    if (child === null) continue;
    if (child.type === ',' || child.type === '(' || child.type === ')') continue;
    const litType = inferCppLiteralType(child);
    if (litType !== '') {
      classes.push(valueTypeClass(litType));
    } else if (child.type === 'identifier') {
      classes.push(lookupDeclaredTypeClassForIdentifier(child));
    } else {
      classes.push(unknownTypeClass('unknown'));
    }
  }
  return classes.length > 0 ? classes : undefined;
}

function inferCppBinaryOperatorArgTypes(
  node: SyntaxNode,
  includeLeftOperand: boolean,
): string[] | undefined {
  const operands = binaryOperatorOperands(node, includeLeftOperand);
  if (operands.length === 0) return undefined;
  const types = operands.map(inferCppExpressionType);
  return types.length > 0 ? types : undefined;
}

function inferCppBinaryOperatorArgTypeClasses(
  node: SyntaxNode,
  includeLeftOperand: boolean,
): ParameterTypeClass[] | undefined {
  const operands = binaryOperatorOperands(node, includeLeftOperand);
  if (operands.length === 0) return undefined;
  const classes = operands.map(inferCppExpressionTypeClass);
  return classes.length > 0 ? classes : undefined;
}

function binaryOperatorOperands(node: SyntaxNode, includeLeftOperand: boolean): SyntaxNode[] {
  const operands: SyntaxNode[] = [];
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  if (includeLeftOperand && left !== null) operands.push(left);
  if (right !== null) operands.push(right);
  return operands;
}

function isPrimitiveOnlyBinaryOperator(node: SyntaxNode): boolean {
  const operands = binaryOperatorOperands(node, true);
  return operands.length > 0 && operands.every((operand) => isBuiltinOperatorType(operand));
}

function isBuiltinOperatorType(node: SyntaxNode): boolean {
  const type = inferCppExpressionType(node);
  return (
    type === 'bool' ||
    type === 'char' ||
    type === 'double' ||
    type === 'float' ||
    type === 'int' ||
    type === 'long' ||
    type === 'short' ||
    type === 'signed' ||
    type === 'unsigned'
  );
}

function inferCppExpressionType(node: SyntaxNode): string {
  const litType = inferCppLiteralType(node);
  if (litType !== '') return litType;
  if (node.type === 'identifier') return lookupDeclaredTypeForIdentifier(node);
  return '';
}

function inferCppExpressionTypeClass(node: SyntaxNode): ParameterTypeClass {
  const litType = inferCppLiteralType(node);
  if (litType !== '') return valueTypeClass(litType);
  if (node.type === 'identifier') return lookupDeclaredTypeClassForIdentifier(node);
  return unknownTypeClass('unknown');
}

function valueTypeClass(base: string): ParameterTypeClass {
  return { base, cv: 'none', indirection: 'value', pointerDepth: 0 };
}

function unknownTypeClass(base: string): ParameterTypeClass {
  return { base, cv: 'unknown', indirection: 'unknown', pointerDepth: 0 };
}

/**
 * Infer the canonical type name of a C++ literal AST node.
 * Returns empty string for non-literal / unknown nodes.
 */
function inferCppLiteralType(node: SyntaxNode): string {
  switch (node.type) {
    case 'initializer_list':
      return inferCppBracedInitType(node);
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

function inferCppBracedInitType(node: SyntaxNode): string {
  const elementTypes: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child === null) continue;
    if (child.type === ',' || child.type === '{' || child.type === '}') continue;
    const elementType = inferCppLiteralType(child);
    if (elementType === '' || elementType.startsWith(CPP_BRACED_INIT_TYPE_PREFIX)) {
      return `${CPP_BRACED_INIT_TYPE_PREFIX}unknown:${elementTypes.length + 1}`;
    }
    elementTypes.push(elementType);
  }
  if (elementTypes.length === 0) return `${CPP_BRACED_INIT_TYPE_PREFIX}unknown:0`;
  const first = elementTypes[0];
  return elementTypes.every((type) => type === first)
    ? `${CPP_BRACED_INIT_TYPE_PREFIX}${first}:${elementTypes.length}`
    : `${CPP_BRACED_INIT_TYPE_PREFIX}unknown:${elementTypes.length}`;
}

/**
 * Per-file lookup index (#2432). Reset at the top of `emitCppScopeCaptures`
 * (the single per-file entry) and populated lazily by the lookup helpers
 * below. Everything is keyed by `SyntaxNode.id` — node WRAPPER objects are
 * recreated per access by the tree-sitter binding, so object identity (and
 * therefore WeakMap keys) would silently never hit.
 *
 * - `enumNames`: every named `enum_specifier` in the translation unit,
 *   collected by ONE root DFS on first `isKnownEnumName` query (was: one
 *   full-tree DFS per identifier argument — the #2432 hotspot).
 * - `scopeDecls`: per enclosing scope, first-declaration-wins map of
 *   variable name → `declaration` statement (position-free, matching the
 *   scan it replaces).
 * - `fnParams`: per `function_definition`/`function_declarator`, map of
 *   parameter name → `parameter_declaration` (null when the function has
 *   no parameter list, preserving the scan's early-return semantics).
 */
interface CppFileLookupIndex {
  enumNames: Set<string> | null;
  scopeDecls: Map<number, Map<string, SyntaxNode>>;
  fnParams: Map<number, Map<string, SyntaxNode> | null>;
}

let fileLookupIndex: CppFileLookupIndex = {
  enumNames: null,
  scopeDecls: new Map(),
  fnParams: new Map(),
};

function resetCppFileLookupIndex(): void {
  fileLookupIndex = { enumNames: null, scopeDecls: new Map(), fnParams: new Map() };
}

/**
 * First-declaration-wins map of the scope's `declaration` children that
 * carry a concrete (non-placeholder) type and a nameable declarator —
 * exactly the entries the replaced per-identifier scans could match.
 */
function scopeDeclarationsFor(scope: SyntaxNode): Map<string, SyntaxNode> {
  const cached = fileLookupIndex.scopeDecls.get(scope.id);
  if (cached !== undefined) return cached;
  const decls = new Map<string, SyntaxNode>();
  for (let i = 0; i < scope.childCount; i++) {
    const stmt = scope.child(i);
    if (stmt === null || stmt.type !== 'declaration') continue;
    const typeNode = stmt.childForFieldName('type');
    if (typeNode === null) continue;
    if (typeNode.type === 'placeholder_type_specifier') continue;
    const declarator = stmt.childForFieldName('declarator');
    if (declarator === null) continue;
    const nameChild = declaredNameNode(declarator);
    if (nameChild === null) continue;
    const name = extractDeclaratorLeafName(nameChild);
    if (name === '' || decls.has(name)) continue;
    decls.set(name, stmt);
  }
  fileLookupIndex.scopeDecls.set(scope.id, decls);
  return decls;
}

/**
 * Look up the declared type of a variable by scanning sibling declarations
 * in the enclosing compound_statement (function body). Handles:
 *   - `std::string result = ...` → 'string'
 *   - `int n = ...` → 'int'
 *   - `const int n = ...` → 'int'
 * Returns empty string if no declaration found or type is auto/placeholder.
 *
 * Limitation: only `declaration` siblings inside the enclosing
 * `compound_statement` are inspected. Function parameters live in the
 * `function_declarator`'s `parameter_list` and are NOT resolved here, so
 *   `void run(int n) { process(n); }`
 * infers `''` for `n` and the constraint filter falls through to
 * `'unknown'` → ambiguity suppression → 0 CALLS edges. This is a
 * "degrade not lie" gap (no wrong edges, just missing ones); extending
 * the scan to `parameter_list` is tracked under #1579 as a follow-up.
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

  const paramType = lookupFunctionParameterType(scope, varName);
  if (paramType !== '') return paramType;

  // Indexed scope-declaration lookup (#2432; was a per-identifier scan).
  const stmt = scopeDeclarationsFor(scope).get(varName);
  if (stmt === undefined) return '';
  const typeNode = stmt.childForFieldName('type');
  if (typeNode === null) return '';
  return normalizeCppTypeText(typeNode.text);
}

function lookupDeclaredTypeClassForIdentifier(identNode: SyntaxNode): ParameterTypeClass {
  const varName = identNode.text;
  let scope: SyntaxNode | null = identNode.parent;
  while (
    scope !== null &&
    scope.type !== 'compound_statement' &&
    scope.type !== 'translation_unit'
  ) {
    scope = scope.parent;
  }
  if (scope === null) return unknownTypeClass('unknown');

  const paramTypeClass = lookupFunctionParameterTypeClass(scope, varName, identNode);
  if (paramTypeClass !== undefined) return paramTypeClass;

  // Indexed scope-declaration lookup (#2432; was a per-identifier scan).
  const stmt = scopeDeclarationsFor(scope).get(varName);
  if (stmt === undefined) return unknownTypeClass('unknown');
  const typeNode = stmt.childForFieldName('type');
  const declarator = stmt.childForFieldName('declarator');
  const nameChild = declarator !== null ? declaredNameNode(declarator) : null;
  if (typeNode === null || nameChild === null) return unknownTypeClass('unknown');

  const typeClass = classifyCppParameterType(
    typeNode.text,
    nameChild.text,
    stmt.text.replace(/;\s*$/, ''),
  );
  if (isKnownEnumName(identNode, typeClass.base)) {
    return { ...typeClass, base: `enum:${typeClass.base}` };
  }
  return typeClass;
}

function lookupFunctionParameterType(scope: SyntaxNode, varName: string): string {
  const param = findEnclosingFunctionParameter(scope, varName);
  if (param === null) return '';
  const typeNode = param.childForFieldName('type');
  if (typeNode === null) return '';
  return normalizeCppTypeText(typeNode.text);
}

function lookupFunctionParameterTypeClass(
  scope: SyntaxNode,
  varName: string,
  identNode: SyntaxNode,
): ParameterTypeClass | undefined {
  const param = findEnclosingFunctionParameter(scope, varName);
  if (param === null) return undefined;
  const typeNode = param.childForFieldName('type');
  if (typeNode === null) return undefined;
  const declarator = param.childForFieldName('declarator');
  if (declarator === null) return undefined;
  const typeClass = classifyCppParameterType(typeNode.text, declarator.text, param.text);
  if (isKnownEnumName(identNode, typeClass.base)) {
    return { ...typeClass, base: `enum:${typeClass.base}` };
  }
  return typeClass;
}

function findEnclosingFunctionParameter(scope: SyntaxNode, varName: string): SyntaxNode | null {
  let node: SyntaxNode | null = scope.parent;
  while (node !== null) {
    if (node.type === 'function_definition' || node.type === 'function_declarator') {
      return enclosingFunctionParametersFor(node)?.get(varName) ?? null;
    }
    node = node.parent;
  }
  return null;
}

/**
 * First-wins map of a function's `parameter_declaration`s by declarator
 * leaf name (#2432; was a per-identifier scan). `null` when the function
 * has no parameter list — the caller returns null without walking further
 * up, preserving the replaced scan's early-return.
 */
function enclosingFunctionParametersFor(fnNode: SyntaxNode): Map<string, SyntaxNode> | null {
  const cached = fileLookupIndex.fnParams.get(fnNode.id);
  if (cached !== undefined) return cached;
  const fnDecl =
    fnNode.type === 'function_declarator'
      ? fnNode
      : findFirstDescendantOfType(fnNode, 'function_declarator');
  const params = fnDecl?.childForFieldName('parameters') ?? null;
  let index: Map<string, SyntaxNode> | null = null;
  if (params !== null) {
    index = new Map();
    for (let i = 0; i < params.namedChildCount; i++) {
      const param = params.namedChild(i);
      if (param === null || param.type !== 'parameter_declaration') continue;
      const declarator = param.childForFieldName('declarator');
      if (declarator === null) continue;
      const name = extractDeclaratorLeafName(declarator);
      if (name === '' || index.has(name)) continue;
      index.set(name, param);
    }
  }
  fileLookupIndex.fnParams.set(fnNode.id, index);
  return index;
}

function declaredNameNode(declarator: SyntaxNode): SyntaxNode | null {
  if (declarator.type !== 'init_declarator') return declarator;
  for (let i = 0; i < declarator.namedChildCount; i++) {
    const child = declarator.namedChild(i);
    if (child === null) continue;
    if (child.type === 'identifier') return child;
    if (child.type.endsWith('_declarator')) return child;
  }
  return declarator.childForFieldName('declarator');
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

function isKnownEnumName(node: SyntaxNode, typeName: string): boolean {
  if (typeName === '' || typeName === 'unknown') return false;
  // One full-tree DFS per FILE (lazy), not per identifier argument — the
  // per-identifier walk here was the dominant cost of #2432 (87s of a 151s
  // extraction on a file that parses in 46ms).
  if (fileLookupIndex.enumNames === null) {
    let root: SyntaxNode = node;
    while (root.parent !== null) root = root.parent;
    const names = new Set<string>();
    const stack: SyntaxNode[] = [root];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur.type === 'enum_specifier') {
        const name = cur.childForFieldName('name');
        if (name !== null) names.add(name.text);
      }
      for (let i = 0; i < cur.childCount; i++) {
        const child = cur.child(i);
        if (child !== null) stack.push(child);
      }
    }
    fileLookupIndex.enumNames = names;
  }
  return fileLookupIndex.enumNames.has(typeName);
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
  // Qualified expression (a::b) — may be a function, variable, enum value,
  // or static member. Record as a potential function reference; resolution
  // time verifies via workspace lookup that a Function/Method with this simple
  // name exists in the extracted namespace before contributing to the set.
  if (argNode.type === 'qualified_identifier') {
    return {
      simpleClassName: '',
      templateSimpleClassName: '',
      templateNamespace: '',
      templateArgClassNames: [],
      templateArgNamespaces: [],
      functionRefText: argNode.text,
    };
  }
  // Variable reference — look up its declared type (preserving pointer /
  // reference / qualified-name shape; the existing arity-narrowing helper
  // strips this info).
  if (argNode.type === 'identifier') {
    const result = lookupAdlIdentifierType(argNode);
    if (result === null) {
      // Not found in the local compound_statement scope — could be a
      // free-function reference (unqualified name, namespace scope).
      return {
        simpleClassName: '',
        templateSimpleClassName: '',
        templateNamespace: '',
        templateArgClassNames: [],
        templateArgNamespaces: [],
        functionRefText: argNode.text,
      };
    }
    return result;
  }
  // Other shapes (calls, member access, operators) — V1 unsupported.
  return EMPTY_ADL_ARG;
}

/**
 * Returns `true` when `varName` appears as a parameter name in the nearest
 * enclosing `function_definition` or `function_declarator` that contains
 * `identNode`. Parameters live in `parameter_list` (a sibling of the
 * `compound_statement`), so the `compound_statement`-local declaration scan
 * in `lookupAdlIdentifierType` would not find them — causing them to be
 * mistakenly classified as potential free-function references.
 *
 * In tree-sitter-cpp a `function_definition` does NOT expose `parameters`
 * as a direct named field; parameters live inside the nested
 * `function_declarator`. For `function_declarator` nodes the `parameters`
 * field IS direct. Both cases are handled below.
 */
function isIdentifierAFunctionParameter(identNode: SyntaxNode, varName: string): boolean {
  let node: SyntaxNode | null = identNode.parent;
  let safety = 64;
  while (node !== null && safety-- > 0) {
    let params: SyntaxNode | null = null;
    if (node.type === 'function_declarator') {
      // parameters is a direct field on function_declarator.
      params = node.childForFieldName('parameters');
    } else if (node.type === 'function_definition') {
      // function_definition carries parameters inside its `declarator` field
      // (which is a function_declarator). Walk through it.
      const decl = node.childForFieldName('declarator');
      if (decl !== null && decl.type === 'function_declarator') {
        params = decl.childForFieldName('parameters');
      }
    }
    if (params !== null) {
      for (let i = 0; i < params.namedChildCount; i++) {
        const param = params.namedChild(i);
        if (param === null) continue;
        const declNode = param.childForFieldName('declarator');
        if (declNode === null) continue;
        const leafName = extractDeclaratorLeafName(declNode);
        if (leafName === varName) return true;
      }
      // Only check the immediately enclosing function — do not climb further.
      break;
    }
    if (node.type === 'translation_unit') break;
    node = node.parent;
  }
  return false;
}

function lookupAdlIdentifierType(identNode: SyntaxNode): CppAdlArgInfo | null {
  const varName = identNode.text;
  let scope: SyntaxNode | null = identNode.parent;
  while (
    scope !== null &&
    scope.type !== 'compound_statement' &&
    scope.type !== 'translation_unit'
  ) {
    scope = scope.parent;
  }
  if (scope === null) return null;

  // Function parameters live in the enclosing function's `parameter_list`,
  // NOT inside the `compound_statement`, so the declaration scan below would
  // never find them and would return `null` — incorrectly triggering the
  // free-function-reference path. Check the parameter_list first.
  if (isIdentifierAFunctionParameter(identNode, varName)) {
    return EMPTY_ADL_ARG;
  }

  let foundAsLocalFunctionPointer = false;
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
          // Extract the name from within the function-pointer declarator chain
          // so `foundAsLocalFunctionPointer` can detect a matching declaration.
          nameText = extractDeclaratorLeafName(inner);
          break;
        }
        const next = inner.childForFieldName('declarator');
        if (next === null) break;
        inner = next;
        continue;
      }
      if (inner.type === 'reference_declarator') {
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
        // Extract the name from the inner declarator (e.g. `(*g)` in `void (*g)()`).
        const innerDecl = inner.childForFieldName('declarator');
        if (innerDecl !== null) nameText = extractDeclaratorLeafName(innerDecl);
        break;
      }
      // Reached the leaf — usually `identifier`. Take its text.
      nameText = inner.text;
      break;
    }
    if (nameText === varName && isFunctionPointer) {
      // Explicitly declared as a function-pointer variable — must not be
      // treated as a free-function reference by the caller.
      foundAsLocalFunctionPointer = true;
      continue;
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
  // If the identifier was found in local scope as a function-pointer variable,
  // return EMPTY_ADL_ARG so the caller does NOT treat it as a free-function
  // reference. Otherwise return null to indicate "not in local scope".
  //
  // Known limitation (Finding 4): variables whose type is a typedef/using alias
  // for a function-pointer type are NOT detected here. For example:
  //   using Callback = void (*)();
  //   Callback g;
  //   foo(g);  // `g`'s declarator is `identifier` with type `Callback`
  // The declarator has no `pointer_declarator` wrapper, so `isFunctionPointer`
  // stays false and `extractAdlSimpleTypeName` returns `"Callback"`. ADL then
  // looks for a class named `Callback`; if none exists, this degrades to
  // EMPTY_ADL_ARG (class not found → no namespace contributed). If a class
  // named `Callback` does exist, a spurious namespace contribution could occur.
  // Risk is low in practice; a future fix should resolve the typedef/alias chain.
  return foundAsLocalFunctionPointer ? EMPTY_ADL_ARG : null;
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
    if (scope !== null) return normalizeQualifiedName(scope.text);
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

function extractNamespaceFromQualifiedText(text: string): string {
  const cleaned = text.replace(/\s+/g, '');
  const idx = cleaned.lastIndexOf('::');
  if (idx <= 0) return '';
  return normalizeQualifiedName(cleaned.slice(0, idx));
}

/**
 * Walk a declarator node chain, unwrapping pointer/reference/function/
 * parenthesized wrappers, and return the text of the innermost identifier.
 * Returns `null` when no identifier is found within `safety` steps.
 * Used by `lookupAdlIdentifierType` to extract the variable name from
 * function-pointer declarator trees such as `(*g)()` in `void (*g)()`.
 */
function extractDeclaratorLeafName(node: SyntaxNode): string | null {
  let cur: SyntaxNode = node;
  let safety = 16;
  while (safety-- > 0) {
    if (
      cur.type === 'identifier' ||
      cur.type === 'type_identifier' ||
      cur.type === 'operator_name'
    ) {
      return cur.text;
    }
    // Common wrapper nodes — follow the 'declarator' field when present.
    const next =
      cur.childForFieldName('declarator') ??
      // parenthesized_declarator: single named child
      (cur.type === 'parenthesized_declarator' || cur.type.endsWith('_declarator')
        ? cur.namedChild(0)
        : null);
    if (next === null) return null;
    cur = next;
  }
  return null;
}

/**
 * Check if a C++ declaration has an `explicit` specifier. Tree-sitter-cpp
 * exposes `explicit` as a direct keyword child on constructor declarations in
 * current grammar builds; the bounded text prefix keeps this resilient across
 * small grammar shape differences without scanning whole function bodies.
 */
function hasExplicitSpecifier(node: SyntaxNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child !== null && child.text === 'explicit') return true;
  }
  return /\bexplicit\b/.test(node.text.slice(0, 128));
}

function hasDeletedMethodClause(node: SyntaxNode, callableName: string | undefined): boolean {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'delete_method_clause') return true;
    // tree-sitter-cpp 0.23 parses a deleted free-function declaration as
    // `declaration > init_declarator > delete_expression`, while class
    // members use the dedicated `delete_method_clause`.
    if (
      child?.type === 'init_declarator' &&
      child.childForFieldName('value')?.type === 'delete_expression' &&
      callableName !== undefined &&
      extractDeclaratorLeafName(child.childForFieldName('declarator') ?? child) === callableName
    ) {
      return true;
    }
  }
  return false;
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
