import { makeScopeId, type Capture, type CaptureMatch } from 'gitnexus-shared';
import {
  nodeIfType,
  nodeToCapture,
  syntheticCapture,
  type SyntaxNode,
} from '../../utils/ast-helpers.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import { computeKotlinArityMetadata } from './arity-metadata.js';
import { splitKotlinImportHeader } from './import-decomposer.js';
import { recordKotlinCacheHit, recordKotlinCacheMiss } from './cache-stats.js';
import { normalizeKotlinType } from './interpret.js';
import { synthesizeKotlinReceiverBinding } from './receiver-binding.js';
import { getKotlinParser, getKotlinScopeQuery } from './query.js';
import { markCompanionScope } from './companion-scopes.js';

const FUNCTION_DECL_TAGS = ['@declaration.function'] as const;

export function emitKotlinScopeCaptures(
  sourceText: string,
  filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  let tree = cachedTree as ReturnType<ReturnType<typeof getKotlinParser>['parse']> | undefined;
  if (tree === undefined) {
    tree = parseSourceSafe(getKotlinParser(), sourceText, undefined, {
      bufferSize: getTreeSitterBufferSize(sourceText),
    });
    recordKotlinCacheMiss();
  } else {
    recordKotlinCacheHit();
  }

  const out: CaptureMatch[] = [];
  const returnTypes = collectKotlinReturnTypeTexts(tree.rootNode);
  out.push(...synthesizeKotlinLocalAssignmentBindings(tree.rootNode, returnTypes));
  out.push(...synthesizeKotlinLoopBindings(tree.rootNode, returnTypes));
  out.push(...synthesizeKotlinSmartCastBindings(tree.rootNode));
  out.push(...synthesizeKotlinLambdaBindings(tree.rootNode, returnTypes));
  out.push(...synthesizeKotlinInheritanceReferences(tree.rootNode));

  for (const match of getKotlinScopeQuery().matches(tree.rootNode)) {
    const grouped: Record<string, Capture> = {};
    // Parallel tag -> captured SyntaxNode map. The query hands us each matched
    // node as capture.node, so anchors resolve via a type-guarded lookup
    // (nodeIfType) instead of re-deriving them with
    // findNodeAtRange(tree.rootNode, ...) per match — the O(matches x N)
    // root-walk fixed for go #1915 / python #1918 / csharp, mirrored here.
    const groupedNodes: Record<string, SyntaxNode> = {};
    for (const capture of match.captures) {
      const tag = '@' + capture.name;
      grouped[tag] = nodeToCapture(tag, capture.node);
      groupedNodes[tag] = capture.node;
    }
    if (Object.keys(grouped).length === 0) continue;

    // Companion-object marker (#1756 / U4). The `@scope.companion`
    // capture is a side-channel marker — it shares its range with the
    // existing `(companion_object) @scope.class` rule, so the Class
    // scope already exists in the scope tree. Record the scope id into
    // the per-file companion-scope set so `populateCompanionMembersOn
    // EnclosingClass` (owners.ts) can identify companion scopes
    // unambiguously, regardless of whether they are anonymous, named,
    // or contain nested classes. The match itself is consumed here and
    // NOT pushed to the output — the scope-extractor would reject the
    // `companion` kind suffix anyway, but suppressing the emit keeps
    // downstream pipelines from re-processing the same range twice.
    if (grouped['@scope.companion'] !== undefined) {
      const scopeId = makeScopeId({
        filePath,
        range: grouped['@scope.companion']!.range,
        kind: 'Class',
      });
      markCompanionScope(filePath, scopeId);
      continue;
    }

    if (grouped['@import.statement'] !== undefined) {
      const importNode = nodeIfType(groupedNodes['@import.statement'], 'import_header');
      if (importNode !== null) {
        const decomposed = splitKotlinImportHeader(importNode);
        if (decomposed !== null) {
          out.push(decomposed);
          continue;
        }
      }
    }

    if (
      grouped['@reference.call.free'] !== undefined &&
      grouped['@reference.receiver'] !== undefined
    ) {
      continue;
    }

    if (grouped['@reference.read.member'] !== undefined) {
      const navNode = nodeIfType(groupedNodes['@reference.read.member'], 'navigation_expression');
      if (navNode === null || !shouldEmitReadMember(navNode)) continue;
    }

    // Virtual dispatch via constructor type (#1762). When a property
    // declaration carries BOTH an explicit type annotation AND a
    // constructor-style call value (e.g. `val animal: Animal = Dog()`),
    // suppress the annotation capture so the constructor-inferred
    // binding wins. This matches Kotlin's virtual dispatch semantics:
    // `animal.speak()` should resolve to the overriding `Dog.speak`
    // (the dynamic type), not `Animal.speak` (the static annotation).
    //
    // The annotation source has higher precedence than constructor-
    // inferred in the generic scope-extractor (see
    // `typeBindingStrength` in scope-extractor.ts), so the only way to
    // make the constructor type prevail is to drop the annotation at
    // emission time.
    if (
      grouped['@type-binding.annotation'] !== undefined &&
      grouped['@type-binding.name'] !== undefined &&
      grouped['@type-binding.type'] !== undefined
    ) {
      const propNode = nodeIfType(groupedNodes['@type-binding.annotation'], 'property_declaration');
      if (propNode !== null && propertyDeclHasConstructorValue(propNode)) {
        continue;
      }
    }

    if (grouped['@scope.function'] !== undefined) {
      out.push(grouped);
      const fnNode = nodeIfType(groupedNodes['@scope.function'], 'function_declaration');
      if (fnNode !== null) {
        out.push(...synthesizeKotlinReceiverBinding(fnNode));
      }
      continue;
    }

    const declTag = FUNCTION_DECL_TAGS.find((tag) => grouped[tag] !== undefined);
    if (declTag !== undefined) {
      const fnNode = nodeIfType(groupedNodes[declTag], 'function_declaration');
      if (fnNode !== null) {
        const arity = computeKotlinArityMetadata(fnNode);
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

    const callTag = (
      ['@reference.call.free', '@reference.call.member', '@reference.call.constructor'] as const
    ).find((tag) => grouped[tag] !== undefined);
    if (callTag !== undefined && grouped['@reference.arity'] === undefined) {
      const callNode = nodeIfType(groupedNodes[callTag], 'call_expression');
      if (callNode !== null) {
        const args = callArguments(callNode);
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

    out.push(grouped);

    const extensionFallback = extensionFreeCallFallback(grouped, groupedNodes);
    if (extensionFallback !== null) out.push(extensionFallback);
  }

  return out;
}

/**
 * Synthesize `@reference.inherits` captures from Kotlin `class_declaration`
 * delegation specifiers so the registry-primary scope-resolution path emits
 * EXTENDS / IMPLEMENTS edges (mirrors C# `synthesizeCsharpInheritanceReferences`
 * and C++ `emitCppInheritanceCaptures`). Without this, Kotlin inheritance edges
 * came only from the legacy `@heritage.*` path, which the worker pipeline drops
 * for registry-primary languages → 0 inheritance edges in worker mode (#1951).
 *
 * Scope mirrors the legacy KOTLIN_QUERIES `@heritage.extends` patterns exactly
 * (the config-driven `kotlinHeritageShapes`: `user_type`,
 * `constructor_invocation`, `explicit_delegation`). Each `delegation_specifier`
 * child of a `class_declaration`, in one of three forms —
 *   - bare interface/superclass: `class Foo : Bar`
 *     `(delegation_specifier (user_type (type_identifier)))`
 *   - constructor-call superclass: `class Foo : Bar()`
 *     `(delegation_specifier (constructor_invocation (user_type (type_identifier))))`
 *   - interface delegation: `class Foo : Bar by delegate`
 *     `(delegation_specifier (explicit_delegation (user_type (type_identifier)) …))`
 *     — the delegated interface is the LEADING `user_type`; the trailing
 *     delegate expression (`by delegate`) is NOT a supertype (#1951). This is
 *     the dropped shape the registry-primary synth previously skipped, leaving
 *     `class F : Iface by d` with no IMPLEMENTS edge in worker mode.
 *
 * Kotlin uses `:` for BOTH superclass and interfaces — the EXTENDS-vs-IMPLEMENTS
 * split is decided downstream from the resolved target's symbol kind
 * (`preEmitInheritanceEdges`), so every base is emitted with the same `inherits`
 * kind here. The bare lookup name is normalized to the simple identifier
 * (`Base()` → `Base`, `Base<T>` → `Base`, `pkg.Base` → `Base`,
 * `Iface by d` → `Iface`) so V1's simple-name `findClassBindingInScope`
 * resolves it. The extracted bare name agrees with the legacy leg's
 * `normalizeSupertypeName` for every shape (verified by real-parse).
 */
function synthesizeKotlinInheritanceReferences(rootNode: SyntaxNode): CaptureMatch[] {
  const out: CaptureMatch[] = [];
  for (const classNode of descendantsOfType(rootNode, 'class_declaration')) {
    for (const child of classNode.namedChildren) {
      if (child.type !== 'delegation_specifier') continue;
      // Three wrappers, all resolving to a leading `user_type` →
      // `type_identifier`:
      //   - `(delegation_specifier (constructor_invocation (user_type …)))` for `Base()`
      //   - `(delegation_specifier (explicit_delegation (user_type …) <delegate>))`
      //     for `Iface by d` — the supertype is the FIRST `user_type`; the
      //     delegate expression that trails `by` is ignored.
      //   - `(delegation_specifier (user_type …))` for a bare interface/superclass.
      const ctor = child.namedChildren.find((n) => n.type === 'constructor_invocation');
      const delegation = child.namedChildren.find((n) => n.type === 'explicit_delegation');
      const userType =
        ctor?.namedChildren.find((n) => n.type === 'user_type') ??
        delegation?.namedChildren.find((n) => n.type === 'user_type') ??
        child.namedChildren.find((n) => n.type === 'user_type');
      if (userType === undefined) continue;
      const nameNode = kotlinUserTypeNameNode(userType);
      if (nameNode === null) continue;
      out.push({
        '@reference.inherits': nodeToCapture('@reference.inherits', child),
        '@reference.name': nodeToCapture('@reference.name', nameNode),
      });
    }
  }
  return out;
}

/**
 * The bare simple-name `type_identifier` of a `user_type`. Strips generic
 * type arguments (`Base<T>` → `Base`) and qualifier tails (`pkg.Base` → `Base`)
 * by taking the LAST direct `type_identifier` child, matching the legacy
 * `(user_type (type_identifier) @heritage.extends)` capture and V1's
 * simple-name `findClassBindingInScope` contract.
 */
function kotlinUserTypeNameNode(userType: SyntaxNode): SyntaxNode | null {
  let nameNode: SyntaxNode | null = null;
  for (const child of userType.namedChildren) {
    if (child.type === 'type_identifier') nameNode = child;
  }
  return nameNode;
}

function synthesizeKotlinLoopBindings(
  rootNode: SyntaxNode,
  returnTypes: ReadonlyMap<string, string>,
): CaptureMatch[] {
  const out: CaptureMatch[] = [];
  for (const fnNode of descendantsOfType(rootNode, 'function_declaration')) {
    const localTypes = collectKotlinLocalTypeTexts(fnNode, returnTypes);
    for (const forNode of descendantsOfType(fnNode, 'for_statement')) {
      const variable = forNode.namedChildren.find((child) => child.type === 'variable_declaration');
      const name = variable?.namedChildren.find((child) => child.type === 'simple_identifier');
      if (variable === undefined || name === undefined) continue;

      const explicitType = variable.namedChildren.find((child) => isKotlinTypeNode(child));
      const iterable = forNode.namedChildren.find(
        (child) => child.id !== variable.id && child.type !== 'control_structure_body',
      );
      const rawType =
        explicitType?.text ??
        (iterable === undefined
          ? null
          : inferKotlinIterableElementType(iterable, localTypes, returnTypes));
      if (rawType === null || rawType.trim() === '') continue;

      const anchor =
        forNode.namedChildren.find((child) => child.type === 'control_structure_body') ?? forNode;
      out.push({
        '@type-binding.annotation': nodeToCapture('@type-binding.annotation', anchor),
        '@type-binding.name': syntheticCapture('@type-binding.name', name, name.text),
        '@type-binding.type': syntheticCapture(
          '@type-binding.type',
          explicitType ?? iterable ?? name,
          normalizeKotlinType(rawType),
        ),
      });
    }
  }
  return out;
}

/**
 * Synthesize narrowed type-bindings for Kotlin smart-cast forms — issue #1758.
 *
 * For each `when (x) { is T -> body }` and `if (x is T) body`, emits a
 * `@type-binding.annotation` capture binding `x → T` anchored on the body
 * node. The capture lands in the matching `@scope.block` scope (see query.ts
 * smart-cast scopes), shadowing the outer parameter binding for calls inside
 * the body without leaking across sibling arms or to `else`.
 *
 * Only narrows when:
 *   - the `when` subject is a `simple_identifier` (not a call or field chain);
 *   - the `when_entry` condition is exactly one `type_test` (skips `!is`,
 *     compound conditions, range/`in`/value patterns);
 *   - the `if_expression` condition is a `check_expression` of the form
 *     `<simple_identifier> is <user_type>` and the then-branch is a
 *     `control_structure_body`.
 *
 * `else` arms and non-narrowing conditions emit nothing — the fall-through to
 * the outer scope's declared type is the correct semantic.
 */
function synthesizeKotlinSmartCastBindings(rootNode: SyntaxNode): CaptureMatch[] {
  const out: CaptureMatch[] = [];

  for (const whenNode of descendantsOfType(rootNode, 'when_expression')) {
    const subjectName = extractWhenSubjectIdentifier(whenNode);
    if (subjectName === null) continue;

    for (const entry of whenNode.namedChildren) {
      if (entry.type !== 'when_entry') continue;
      const narrowedType = extractIsTestTargetType(entry);
      if (narrowedType === null) continue;
      const body = entry.namedChildren.find((child) => child.type === 'control_structure_body');
      if (body === undefined) continue;
      out.push(buildNarrowedTypeBindingCapture(subjectName.node, body, narrowedType));
    }
  }

  for (const ifNode of descendantsOfType(rootNode, 'if_expression')) {
    const check = ifNode.namedChildren.find((child) => child.type === 'check_expression');
    if (check === undefined) continue;
    const subject = check.namedChildren.find((child) => child.type === 'simple_identifier');
    const typeNode = check.namedChildren.find((child) => isKotlinTypeNode(child));
    if (subject === undefined || typeNode === undefined) continue;
    // The first control_structure_body sibling is the then-branch; else
    // branches (when present) appear as the second control_structure_body
    // and are intentionally not narrowed.
    const body = ifNode.namedChildren.find((child) => child.type === 'control_structure_body');
    if (body === undefined) continue;
    out.push(buildNarrowedTypeBindingCapture(subject, body, typeNode));
  }

  return out;
}

function extractWhenSubjectIdentifier(whenNode: SyntaxNode): { node: SyntaxNode } | null {
  const subject = whenNode.namedChildren.find((child) => child.type === 'when_subject');
  if (subject === undefined) return null;
  const ident = subject.namedChildren.find((child) => child.type === 'simple_identifier');
  return ident === undefined ? null : { node: ident };
}

function extractIsTestTargetType(whenEntry: SyntaxNode): SyntaxNode | null {
  const condition = whenEntry.namedChildren.find((child) => child.type === 'when_condition');
  if (condition === undefined) return null;
  // Exactly one when_condition child must be a positive type_test.
  // Compound conditions (multiple `when_condition` siblings joined with
  // commas in some grammars) or negated `!is` are not safe to narrow.
  if (condition.namedChildCount !== 1) return null;
  const test = condition.namedChild(0);
  if (test === null || test.type !== 'type_test') return null;
  // `!is` produces a different node (`negated_type_test` in some grammars,
  // or an extra `!` child in others) — defend by checking text prefix.
  if (test.text.trim().startsWith('!')) return null;
  return test.namedChildren.find((child) => isKotlinTypeNode(child)) ?? null;
}

function buildNarrowedTypeBindingCapture(
  subject: SyntaxNode,
  bodyAnchor: SyntaxNode,
  typeNode: SyntaxNode,
): CaptureMatch {
  return {
    '@type-binding.annotation': nodeToCapture('@type-binding.annotation', bodyAnchor),
    '@type-binding.name': syntheticCapture('@type-binding.name', subject, subject.text),
    '@type-binding.type': syntheticCapture(
      '@type-binding.type',
      typeNode,
      normalizeKotlinType(typeNode.text),
    ),
    // Marker consumed by `kotlinBindingScopeFor` in simple-hooks.ts to
    // override the scope-extractor's auto-hoist. Unbraced arm bodies
    // (`is User -> obj.save()`) make the body anchor coincide with the
    // Block scope's range; without this marker the binding would hoist
    // to the enclosing function scope and lose its arm-local narrowing.
    '@type-binding.narrowed': syntheticCapture('@type-binding.narrowed', bodyAnchor, '1'),
  };
}

/**
 * Synthesize lambda-body type-bindings — issue #1757.
 *
 * For each `lambda_literal` we emit one or more `@type-binding.annotation`
 * captures anchored INSIDE the lambda body (the lambda's `statements` child
 * — or the `lambda_literal` itself when no statements child exists). The
 * `@scope.block` query rule (see query.ts) makes each `lambda_literal` a
 * Block scope, and the `@type-binding.lambda-scoped` marker forces the
 * scope-extractor to keep the binding at the innermost (lambda body) scope
 * via `kotlinBindingScopeFor`. This guarantees:
 *   - explicit parameter names (`{ user -> ... }`) bind only inside the
 *     body, NOT in the enclosing function scope;
 *   - implicit `it` is visible only inside the lambda body and shadows
 *     any same-named outer binding (`val it = "outer"; users.forEach
 *     { it.save() }` — inner `it` is the lambda parameter);
 *   - nested lambdas shadow deterministically (innermost lambda's `it`
 *     wins; outer lambda's parameters are still visible by their own
 *     names through the parent scope chain).
 *
 * Receiver-type inference is best-effort: the lambda's call-expression
 * parent is inspected; if the receiver has a known local-variable type
 * and the call's member is a well-known stdlib idiom (`forEach`/`map`/
 * `filter` → element type of the collection; `let`/`apply`/`also`/`run`/
 * `takeIf`/`takeUnless`/`use` → receiver type itself), the inferred type
 * is attached. When inference fails (chained receivers, unknown member,
 * non-stdlib idiom), we still emit the binding with a sentinel/erased
 * type so the binding's scope semantics (no leak; no `it` cross-fire) are
 * enforced — call-resolution from the body still falls through to free-
 * call fallback, which is the correct behavior when the type is unknown.
 *
 * Standard-library coverage: `forEach`, `map`, `filter`, `flatMap`,
 * `mapNotNull`, `filterNotNull`, `onEach`, `find`, `firstOrNull`,
 * `lastOrNull`, `any`, `all`, `none`, `count`, `forEachIndexed`,
 * `let`, `apply`, `also`, `run`, `takeIf`, `takeUnless`, `use`, `with`.
 *
 * Lambda-receiver typing for non-stdlib higher-order functions is a
 * follow-up; the binding-existence guarantee above is the minimum
 * acceptance criterion per the U9 plan.
 */
function synthesizeKotlinLambdaBindings(
  rootNode: SyntaxNode,
  returnTypes: ReadonlyMap<string, string>,
): CaptureMatch[] {
  const out: CaptureMatch[] = [];
  const classMembers = collectKotlinClassMembers(rootNode);

  for (const fnNode of descendantsOfType(rootNode, 'function_declaration')) {
    const localTypes = collectKotlinLocalTypeTexts(fnNode, returnTypes);
    for (const lambdaNode of descendantsOfType(fnNode, 'lambda_literal')) {
      const anchor = lambdaBodyAnchor(lambdaNode);
      if (anchor === null) continue;

      const inferredType = inferKotlinLambdaReceiverType(
        lambdaNode,
        localTypes,
        returnTypes,
        classMembers,
      );

      const params = explicitLambdaParameters(lambdaNode);
      if (params.length === 0) {
        // No explicit `(x ->)` parameter list — implicit `it` is in
        // scope inside the body. Synthesize the `it` type-binding so
        // calls like `it.save()` resolve through the typeBinding chain.
        const typeNode = inferredType?.typeNode ?? lambdaNode;
        const typeText = inferredType?.typeText ?? '';
        out.push(buildLambdaTypeBindingCapture(anchor, 'it', typeNode, typeText));
      } else {
        // Explicit parameters: `{ user -> ... }`, `{ (a, b) -> ... }`,
        // `{ key, value -> ... }`. Emit one binding per parameter.
        // For multi-arg lambdas (destructuring, `forEachIndexed { i, x
        // -> ... }`), the per-arg type inference is finer than what we
        // currently support — we bind the FIRST parameter to the
        // inferred receiver type (matches single-arg idioms) and bind
        // additional parameters with an empty/erased type, which still
        // gates leakage but won't drive call resolution for those names.
        for (let i = 0; i < params.length; i++) {
          const paramName = params[i]!.text;
          const typeNode = i === 0 ? (inferredType?.typeNode ?? params[i]!) : params[i]!;
          const typeText = i === 0 ? (inferredType?.typeText ?? '') : '';
          out.push(buildLambdaTypeBindingCapture(anchor, paramName, typeNode, typeText));
        }
      }
    }
  }
  return out;
}

/** Anchor node used for synthesized lambda-body type-bindings.
 *  Prefers the `statements` child of `lambda_literal` (always strictly
 *  inside the lambda body, so the scope-extractor's `rangesEqual` auto-
 *  hoist check fails — the binding stays in the Block scope). Falls
 *  back to the lambda_literal itself when no statements child exists
 *  (e.g. empty lambda); the `@type-binding.lambda-scoped` marker in
 *  `kotlinBindingScopeFor` then forces no-hoist explicitly. */
function lambdaBodyAnchor(lambdaNode: SyntaxNode): SyntaxNode | null {
  const statements = lambdaNode.namedChildren.find((c) => c.type === 'statements');
  return statements ?? lambdaNode;
}

/** Extract explicit lambda parameter `simple_identifier` nodes from a
 *  `lambda_literal`. Returns an empty array when no `lambda_parameters`
 *  is present (implicit `it` form). */
function explicitLambdaParameters(lambdaNode: SyntaxNode): SyntaxNode[] {
  const params = lambdaNode.namedChildren.find((c) => c.type === 'lambda_parameters');
  if (params === undefined) return [];
  const out: SyntaxNode[] = [];
  for (const child of params.namedChildren) {
    if (child.type !== 'variable_declaration') continue;
    const ident = child.namedChildren.find((c) => c.type === 'simple_identifier');
    if (ident !== undefined) out.push(ident);
  }
  return out;
}

function buildLambdaTypeBindingCapture(
  anchor: SyntaxNode,
  name: string,
  typeNode: SyntaxNode,
  typeText: string,
): CaptureMatch {
  return {
    '@type-binding.annotation': nodeToCapture('@type-binding.annotation', anchor),
    '@type-binding.name': syntheticCapture('@type-binding.name', anchor, name),
    '@type-binding.type': syntheticCapture(
      '@type-binding.type',
      typeNode,
      typeText === '' ? '' : normalizeKotlinType(typeText),
    ),
    // Marker consumed by `kotlinBindingScopeFor` (simple-hooks.ts) to
    // pin this binding inside the lambda Block scope — without it the
    // scope-extractor would auto-hoist the binding to the enclosing
    // function scope and `it` (or the lambda parameter name) would
    // leak past the closing brace.
    '@type-binding.lambda-scoped': syntheticCapture('@type-binding.lambda-scoped', anchor, '1'),
  };
}

/** Stdlib higher-order functions whose lambda parameter receives the
 *  ELEMENT type of the receiver collection (Map / Iterable element). */
const KOTLIN_ELEMENT_TYPE_LAMBDAS = new Set([
  'forEach',
  'forEachIndexed',
  'map',
  'mapNotNull',
  'mapIndexed',
  'filter',
  'filterNot',
  'filterNotNull',
  'filterIsInstance',
  'flatMap',
  'flatten',
  'onEach',
  'find',
  'findLast',
  'firstOrNull',
  'lastOrNull',
  'singleOrNull',
  'any',
  'all',
  'none',
  'count',
  'partition',
  'sortedBy',
  'sortedByDescending',
  'groupBy',
  'associate',
  'associateBy',
  'associateWith',
  'minByOrNull',
  'maxByOrNull',
  'sumOf',
  'distinctBy',
]);

/** Stdlib scope functions whose lambda receives the RECEIVER itself as
 *  `it` (or as `this` for `apply`/`run`/`with`). For the binding-
 *  existence guarantee we treat both forms the same way — `it` binds
 *  to the receiver type; `apply`/`run`/`with` callers see free calls
 *  inside the body which fall through to free-call resolution against
 *  the enclosing scope (no `this`-aware dispatch yet — follow-up). */
const KOTLIN_SCOPE_FUNCTION_LAMBDAS = new Set(['let', 'also', 'takeIf', 'takeUnless', 'use']);

/** `apply`, `run`, `with` expose the receiver as `this` rather than
 *  `it`. We still synthesize an `it` binding because the lambda may
 *  reference the receiver elsewhere — but the more common usage
 *  (`user.apply { save() }`) goes through free-call resolution on the
 *  body, not through `it`. Including these here keeps the binding
 *  scope correct without claiming we resolve `this`-form correctly. */
const KOTLIN_THIS_RECEIVER_LAMBDAS = new Set(['apply', 'run', 'with']);

/** Walk up from `lambdaNode` to the enclosing `call_expression` and
 *  infer the lambda parameter's type from the call's receiver and
 *  member name. Returns null when the inference path is not yet
 *  supported (chained receivers, unknown member, non-stdlib idiom).
 *
 *  Best-effort: a null return is harmless — `synthesizeKotlinLambda
 *  Bindings` still emits the binding with an empty type so the scope
 *  semantics (no leak, no cross-fire) are enforced; only the call-
 *  resolution path from `it.method()` may fall through to free-call
 *  fallback when the type isn't known. */
function inferKotlinLambdaReceiverType(
  lambdaNode: SyntaxNode,
  localTypes: ReadonlyMap<string, string>,
  returnTypes: ReadonlyMap<string, string>,
  classMembers: KotlinClassMembers,
): { typeText: string; typeNode: SyntaxNode } | null {
  const callExpr = findEnclosingCallExpression(lambdaNode);
  if (callExpr === null) return null;
  const callee = callExpr.namedChildren.find(
    (c) => c.type === 'navigation_expression' || c.type === 'simple_identifier',
  );
  if (callee === undefined) return null;

  if (callee.type === 'simple_identifier') {
    // `with(receiver) { ... }` — argument is the receiver. Not yet
    // wired through; defer to follow-up.
    return null;
  }

  // navigation_expression: <receiver>.<member>
  const receiver = callee.namedChild(0);
  const memberName = callee.namedChildren
    .find((c) => c.type === 'navigation_suffix')
    ?.namedChildren.find((c) => c.type === 'simple_identifier')?.text;
  if (receiver === null || memberName === undefined) return null;

  const receiverType = inferKotlinLambdaReceiverExpressionType(
    receiver,
    localTypes,
    returnTypes,
    classMembers,
  );
  if (receiverType === null) return null;

  if (KOTLIN_ELEMENT_TYPE_LAMBDAS.has(memberName)) {
    const element = kotlinContainerElementType(receiverType, 'values');
    if (element === null || element === '') return null;
    return { typeText: element, typeNode: lambdaNode };
  }

  if (
    KOTLIN_SCOPE_FUNCTION_LAMBDAS.has(memberName) ||
    KOTLIN_THIS_RECEIVER_LAMBDAS.has(memberName)
  ) {
    // Strip nullable suffix for `?.let { ... }` semantics — inside the
    // body, the receiver is non-null per Kotlin smart-cast.
    const stripped = normalizeKotlinType(receiverType);
    return { typeText: stripped, typeNode: lambdaNode };
  }

  return null;
}

/** Infer the static type of the expression that produced the lambda's
 *  enclosing call. Supports: `simple_identifier` (lookup in
 *  `localTypes`), `indexing_expression` on a Map-typed receiver, and
 *  `call_expression` whose callee return type is in `returnTypes`. */
function inferKotlinLambdaReceiverExpressionType(
  receiver: SyntaxNode,
  localTypes: ReadonlyMap<string, string>,
  returnTypes: ReadonlyMap<string, string>,
  classMembers: KotlinClassMembers,
): string | null {
  if (receiver.type === 'simple_identifier') {
    return localTypes.get(receiver.text) ?? null;
  }

  if (receiver.type === 'indexing_expression') {
    // `posts[user]` — the underlying receiver's container type tells
    // us the element/value type.
    const base = receiver.namedChild(0);
    if (base === null) return null;
    const baseType = base.type === 'simple_identifier' ? localTypes.get(base.text) : null;
    if (baseType === undefined || baseType === null) return null;
    // Indexing a Map returns the value type; indexing a List returns
    // the element type. `kotlinContainerElementType` already encodes
    // both via the 'values' tag.
    return kotlinContainerElementType(baseType, 'values');
  }

  if (receiver.type === 'navigation_expression') {
    // `users.map { ... }` chain — receiver is itself a navigation/
    // call. Tier-2 chain inference: try the navigation field/method.
    const navField = inferKotlinNavigationFieldType(receiver, localTypes, classMembers);
    if (navField !== null) return navField;
    const callee = receiver.namedChildren
      .find((c) => c.type === 'navigation_suffix')
      ?.namedChildren.find((c) => c.type === 'simple_identifier');
    if (callee !== undefined) {
      return inferKotlinNavigationCallReturnType(receiver, localTypes, classMembers);
    }
    return null;
  }

  if (receiver.type === 'call_expression') {
    const callee = receiver.namedChildren.find((c) => c.type === 'simple_identifier');
    if (callee === undefined) return null;
    return returnTypes.get(callee.text) ?? null;
  }

  return null;
}

/** Walk up from `lambdaNode` (lambda_literal) to the enclosing call:
 *  `lambda_literal → annotated_lambda → call_suffix → call_expression`
 *  for trailing lambdas, or `lambda_literal → value_argument →
 *  value_arguments → call_suffix → call_expression` for paren form.
 *  Returns null if the lambda is not inside a call. */
function findEnclosingCallExpression(lambdaNode: SyntaxNode): SyntaxNode | null {
  let current: SyntaxNode | null = lambdaNode.parent;
  while (current !== null) {
    if (current.type === 'call_expression') return current;
    // Don't cross out of the immediate call boundary — if we hit a
    // function_body or function_declaration ancestor, the lambda is
    // not call-bound.
    if (current.type === 'function_body' || current.type === 'function_declaration') {
      return null;
    }
    current = current.parent;
  }
  return null;
}

function synthesizeKotlinLocalAssignmentBindings(
  rootNode: SyntaxNode,
  returnTypes: ReadonlyMap<string, string>,
): CaptureMatch[] {
  const out: CaptureMatch[] = [];
  const classMembers = collectKotlinClassMembers(rootNode);
  for (const fnNode of descendantsOfType(rootNode, 'function_declaration')) {
    const localTypes = new Map<string, string>();
    for (const prop of descendantsOfType(fnNode, 'property_declaration')) {
      const inferred = inferKotlinPropertyType(prop, localTypes, returnTypes, classMembers);
      if (inferred === null) continue;
      localTypes.set(inferred.name.text, inferred.rawType);
      if (inferred.synthetic) {
        out.push({
          '@type-binding.annotation': nodeToCapture('@type-binding.annotation', prop),
          '@type-binding.name': syntheticCapture(
            '@type-binding.name',
            inferred.name,
            inferred.name.text,
          ),
          '@type-binding.type': syntheticCapture(
            '@type-binding.type',
            inferred.source,
            normalizeKotlinType(inferred.rawType),
          ),
        });
      }
    }
  }
  return out;
}

interface KotlinClassMembers {
  /** className → fieldName → raw type text */
  readonly fields: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** className → methodName → raw return type text */
  readonly methods: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

/**
 * Per-file class-member index — primary-constructor `val`/`var` params,
 * body property declarations, and method return types. Used by
 * `inferKotlinPropertyType` to walk single-level field and method chains
 * like `val addr = user.address` and `val city = addr.getCity()` (#1760).
 *
 * Indexes by simple class name only. Multi-class collisions inside a
 * single file will pick whichever class was visited last for that name
 * — acceptable because Kotlin forbids same-name top-level classes in
 * one file and per-file resolution is the design boundary here.
 */
function collectKotlinClassMembers(rootNode: SyntaxNode): KotlinClassMembers {
  const fields = new Map<string, Map<string, string>>();
  const methods = new Map<string, Map<string, string>>();
  for (const cls of descendantsOfType(rootNode, 'class_declaration')) {
    const className = cls.namedChildren.find((child) => child.type === 'type_identifier')?.text;
    if (className === undefined) continue;
    const fmap = fields.get(className) ?? new Map<string, string>();
    const mmap = methods.get(className) ?? new Map<string, string>();

    const primary = cls.namedChildren.find((child) => child.type === 'primary_constructor');
    if (primary !== undefined) {
      for (const param of primary.namedChildren) {
        if (param.type !== 'class_parameter') continue;
        // Constructor params are class fields ONLY when prefixed with
        // `val`/`var` (binding_pattern_kind). Plain `fn(x: Int)`-style
        // params remain locals to the constructor.
        if (param.namedChildren.find((c) => c.type === 'binding_pattern_kind') === undefined) {
          continue;
        }
        const fname = param.namedChildren.find((c) => c.type === 'simple_identifier')?.text;
        const ftype = param.namedChildren.find((c) => isKotlinTypeNode(c))?.text;
        if (fname !== undefined && ftype !== undefined) fmap.set(fname, ftype);
      }
    }

    const body = cls.namedChildren.find((child) => child.type === 'class_body');
    if (body !== undefined) {
      for (const member of body.namedChildren) {
        if (member.type === 'property_declaration') {
          const v = member.namedChildren.find((c) => c.type === 'variable_declaration');
          const fname = v?.namedChildren.find((c) => c.type === 'simple_identifier')?.text;
          const ftype = v?.namedChildren.find((c) => isKotlinTypeNode(c))?.text;
          if (fname !== undefined && ftype !== undefined) fmap.set(fname, ftype);
        } else if (member.type === 'function_declaration') {
          collectKotlinFunctionReturn(member, mmap);
        } else if (member.type === 'companion_object') {
          // Companion-object methods (`companion object { fun create() … }`)
          // are addressable via the outer class name (`Logger.create()`).
          // Register them on the outer class so chain-binding for
          // `val x = Logger.create(...)` picks up the return type (#1756).
          // The receiver-side filtering needed to prevent
          // `instance.companionMethod()` crossover is handled elsewhere.
          const compBody = member.namedChildren.find((c) => c.type === 'class_body');
          if (compBody !== undefined) {
            for (const compMember of compBody.namedChildren) {
              if (compMember.type !== 'function_declaration') continue;
              collectKotlinFunctionReturn(compMember, mmap);
            }
          }
        }
      }
    }

    fields.set(className, fmap);
    methods.set(className, mmap);
  }
  return { fields, methods };
}

function collectKotlinFunctionReturn(fnNode: SyntaxNode, target: Map<string, string>): void {
  const mname = fnNode.namedChildren.find((c) => c.type === 'simple_identifier')?.text;
  const paramsIdx = fnNode.namedChildren.findIndex((c) => c.type === 'function_value_parameters');
  const rtype =
    paramsIdx < 0
      ? undefined
      : fnNode.namedChildren.slice(paramsIdx + 1).find((c) => isKotlinTypeNode(c))?.text;
  if (mname !== undefined && rtype !== undefined) target.set(mname, rtype);
}

function collectKotlinLocalTypeTexts(
  fnNode: SyntaxNode,
  returnTypes: ReadonlyMap<string, string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const node of descendants(fnNode)) {
    if (node.type === 'parameter') {
      const name = descendantsOfType(node, 'simple_identifier')[0];
      const type = node.namedChildren.find((child) => isKotlinTypeNode(child));
      if (name !== undefined && type !== undefined) out.set(name.text, type.text);
      continue;
    }

    if (node.type === 'property_declaration') {
      const inferred = inferKotlinPropertyType(node, out, returnTypes);
      if (inferred !== null) out.set(inferred.name.text, inferred.rawType);
    }
  }
  return out;
}

function collectKotlinReturnTypeTexts(rootNode: SyntaxNode): Map<string, string> {
  const out = new Map<string, string>();
  for (const fnNode of descendantsOfType(rootNode, 'function_declaration')) {
    const name = fnNode.namedChildren.find((child) => child.type === 'simple_identifier');
    const paramsIndex = fnNode.namedChildren.findIndex(
      (child) => child.type === 'function_value_parameters',
    );
    const type =
      paramsIndex < 0
        ? undefined
        : fnNode.namedChildren.slice(paramsIndex + 1).find((child) => isKotlinTypeNode(child));
    if (name !== undefined && type !== undefined) out.set(name.text, type.text);
  }
  return out;
}

function inferKotlinPropertyType(
  prop: SyntaxNode,
  localTypes: ReadonlyMap<string, string>,
  returnTypes: ReadonlyMap<string, string>,
  classMembers?: KotlinClassMembers,
): { name: SyntaxNode; rawType: string; source: SyntaxNode; synthetic: boolean } | null {
  const variable = prop.namedChildren.find((child) => child.type === 'variable_declaration');
  const name = variable?.namedChildren.find((child) => child.type === 'simple_identifier');
  if (variable === undefined || name === undefined) return null;

  const explicitType = variable.namedChildren.find((child) => isKotlinTypeNode(child));
  if (explicitType !== undefined) {
    return { name, rawType: explicitType.text, source: explicitType, synthetic: false };
  }

  const value = prop.namedChildren.find(
    (child) => child.id !== variable.id && child.type !== 'binding_pattern_kind',
  );
  if (value?.type === 'simple_identifier') {
    const rawType = localTypes.get(value.text);
    return rawType === undefined ? null : { name, rawType, source: value, synthetic: true };
  }

  if (value?.type === 'navigation_expression') {
    // `val addr = user.address` — receiver type → field on that class (#1760).
    const chained = inferKotlinNavigationFieldType(value, localTypes, classMembers);
    if (chained === null) return null;
    return { name, rawType: chained, source: value, synthetic: true };
  }

  if (value?.type === 'call_expression') {
    const callee = value.namedChildren.find(
      (child) => child.type === 'simple_identifier' || child.type === 'navigation_expression',
    );
    if (callee === undefined) return null;
    if (callee.type === 'simple_identifier') {
      const rawType =
        returnTypes.get(callee.text) ?? (isUppercaseName(callee.text) ? callee.text : null);
      if (rawType === null) return null;
      return { name, rawType, source: callee, synthetic: true };
    }
    // `val city = addr.getCity()` — receiver type → method return on that class (#1760).
    const chained = inferKotlinNavigationCallReturnType(callee, localTypes, classMembers);
    if (chained === null) return null;
    return { name, rawType: chained, source: callee, synthetic: true };
  }

  return null;
}

/** Resolve `receiver.field` → field's declared type, where `receiver`
 *  is a simple identifier whose type is in `localTypes` and `field`
 *  is declared on that type in `classMembers.fields`. Returns null
 *  when any link in the chain is unknown — safe over-conservative. */
function inferKotlinNavigationFieldType(
  nav: SyntaxNode,
  localTypes: ReadonlyMap<string, string>,
  classMembers: KotlinClassMembers | undefined,
): string | null {
  if (classMembers === undefined) return null;
  const receiver = nav.namedChild(0);
  if (receiver === null || receiver.type !== 'simple_identifier') return null;
  const member = nav.namedChildren
    .find((c) => c.type === 'navigation_suffix')
    ?.namedChildren.find((c) => c.type === 'simple_identifier')?.text;
  if (member === undefined) return null;
  const recvType = localTypes.get(receiver.text);
  if (recvType === undefined) return null;
  return classMembers.fields.get(normalizeKotlinType(recvType))?.get(member) ?? null;
}

/** Resolve `receiver.method()` → method's declared return type. The
 *  `receiver` is a simple identifier; we try two interpretations in
 *  order:
 *
 *    1. `receiver` is a local variable whose type is in `localTypes` —
 *       look up `method` on that type's class members.
 *    2. `receiver` is itself a class name (e.g. `Logger.create("app")`,
 *       a companion-object call via the class) — look up `method` on
 *       `classMembers.methods.get(receiver.text)` directly.
 *
 *  Tier 2 supports `val logger = Logger.create(...)` patterns where the
 *  RHS is a companion-object factory: the loop variable's type is the
 *  factory's return type (#1756). */
function inferKotlinNavigationCallReturnType(
  navCallee: SyntaxNode,
  localTypes: ReadonlyMap<string, string>,
  classMembers: KotlinClassMembers | undefined,
): string | null {
  if (classMembers === undefined) return null;
  const receiver = navCallee.namedChild(0);
  if (receiver === null || receiver.type !== 'simple_identifier') return null;
  const methodName = navCallee.namedChildren
    .find((c) => c.type === 'navigation_suffix')
    ?.namedChildren.find((c) => c.type === 'simple_identifier')?.text;
  if (methodName === undefined) return null;
  const recvType = localTypes.get(receiver.text);
  if (recvType !== undefined) {
    return classMembers.methods.get(normalizeKotlinType(recvType))?.get(methodName) ?? null;
  }
  return classMembers.methods.get(receiver.text)?.get(methodName) ?? null;
}

function inferKotlinIterableElementType(
  iterable: SyntaxNode,
  localTypes: ReadonlyMap<string, string>,
  returnTypes: ReadonlyMap<string, string>,
): string | null {
  if (iterable.type === 'simple_identifier') {
    const raw = localTypes.get(iterable.text);
    return raw === undefined ? null : kotlinContainerElementType(raw, 'values');
  }

  if (iterable.type === 'navigation_expression') {
    const receiver = iterable.namedChildren[0];
    const member = iterable.namedChildren
      .find((child) => child.type === 'navigation_suffix')
      ?.namedChildren.find((child) => child.type === 'simple_identifier')?.text;
    if (receiver?.type !== 'simple_identifier') return null;
    const raw = localTypes.get(receiver.text);
    return raw === undefined ? null : kotlinContainerElementType(raw, member ?? 'values');
  }

  if (iterable.type === 'call_expression') {
    const callee = iterable.namedChildren.find((child) => child.type === 'simple_identifier');
    if (callee === undefined) return null;
    const raw = returnTypes.get(callee.text);
    if (raw !== undefined) return kotlinContainerElementType(raw, 'values');
    // Cross-file fallback (#1759): the callee's return type is unknown
    // locally because the function lives in another file. Emit the
    // callee name itself as the binding's rawName; `propagateImported
    // ReturnTypes` will chain-follow `loopvar → callee → <ElementType>`
    // once the imported module's `callee → ElementType` mirror lands at
    // module scope. If `callee` isn't actually an imported callable
    // (e.g. a local lambda or unrelated symbol), chain-follow fails
    // safely and no edge is emitted.
    return callee.text;
  }

  return null;
}

function isUppercaseName(text: string): boolean {
  return /^[A-Z]/.test(text);
}

function kotlinContainerElementType(rawType: string, member: string): string | null {
  const parsed = parseKotlinGeneric(rawType);
  if (parsed === null) return normalizeKotlinType(rawType);

  const base = parsed.base.split('.').pop() ?? parsed.base;
  if (isKotlinMapType(base)) {
    if (member === 'keys') return parsed.args[0] ?? null;
    return parsed.args[1] ?? null;
  }
  if (isKotlinIterableType(base)) return parsed.args[0] ?? null;
  return normalizeKotlinType(rawType);
}

function parseKotlinGeneric(text: string): { base: string; args: string[] } | null {
  const trimmed = text.trim().replace(/\?$/, '');
  const open = trimmed.indexOf('<');
  const close = trimmed.lastIndexOf('>');
  if (open < 0 || close < open) return null;
  return {
    base: trimmed.slice(0, open).trim(),
    args: splitTopLevelKotlinArgs(trimmed.slice(open + 1, close)),
  };
}

function splitTopLevelKotlinArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '<') depth++;
    else if (ch === '>') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out.filter((arg) => arg.length > 0);
}

function isKotlinMapType(base: string): boolean {
  return ['Map', 'MutableMap', 'HashMap', 'LinkedHashMap'].includes(base);
}

function isKotlinIterableType(base: string): boolean {
  return [
    'List',
    'MutableList',
    'ArrayList',
    'Set',
    'MutableSet',
    'Collection',
    'Iterable',
    'Sequence',
    'Array',
  ].includes(base);
}

function isKotlinTypeNode(node: SyntaxNode): boolean {
  return (
    node.type === 'user_type' || node.type === 'nullable_type' || node.type === 'function_type'
  );
}

function descendantsOfType(node: SyntaxNode, type: string): SyntaxNode[] {
  return descendants(node).filter((child) => child.type === type);
}

function descendants(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child === null) continue;
    out.push(child, ...descendants(child));
  }
  return out;
}

function shouldEmitReadMember(navNode: SyntaxNode): boolean {
  const parent = navNode.parent;
  if (parent === null) return true;
  if (parent.type === 'call_expression') return false;
  if (parent.type === 'directly_assignable_expression') return false;
  return true;
}

/** True when the given `property_declaration` has a `call_expression`
 *  value sibling (i.e. `val x: T = Foo()`). Used to suppress the
 *  explicit-annotation type-binding capture so the constructor-inferred
 *  binding wins (#1762). */
function propertyDeclHasConstructorValue(propNode: SyntaxNode): boolean {
  const variable = propNode.namedChildren.find((c) => c.type === 'variable_declaration');
  if (variable === undefined) return false;
  const value = propNode.namedChildren.find(
    (c) => c.id !== variable.id && c.type !== 'binding_pattern_kind',
  );
  return value?.type === 'call_expression';
}

function callArguments(callNode: SyntaxNode): SyntaxNode[] {
  const suffix = callNode.namedChildren.find((child) => child.type === 'call_suffix');
  if (suffix === undefined) return [];

  const valueArgs = suffix?.namedChildren.find((child) => child.type === 'value_arguments');
  const args = valueArgs?.namedChildren.filter((child) => child.type === 'value_argument') ?? [];
  const trailingLambdas = suffix.namedChildren.filter((child) => child.type === 'annotated_lambda');
  return [...args, ...trailingLambdas];
}

function inferArgType(argNode: SyntaxNode): string {
  const value = argNode.namedChild(0) ?? argNode;
  switch (value.type) {
    case 'integer_literal':
    case 'long_literal':
      return 'Int';
    case 'real_literal':
      return 'Double';
    case 'string_literal':
    case 'line_string_literal':
    case 'multi_line_string_literal':
      return 'String';
    case 'character_literal':
      return 'Char';
    case 'boolean_literal':
      return 'Boolean';
    case 'call_expression': {
      const first = value.namedChild(0);
      return first?.type === 'simple_identifier' ? first.text : '';
    }
    default:
      return '';
  }
}

function extensionFreeCallFallback(
  grouped: Record<string, Capture>,
  groupedNodes: Record<string, SyntaxNode>,
): CaptureMatch | null {
  const member = grouped['@reference.call.member'];
  const receiver = grouped['@reference.receiver'];
  const name = grouped['@reference.name'];
  if (member === undefined || receiver === undefined || name === undefined) return null;

  // The `@reference.call.member` anchor IS the `call_expression`, and the
  // `@reference.receiver` anchor IS the receiver node — both threaded from the
  // query match (no per-match root walk).
  const callNode = nodeIfType(groupedNodes['@reference.call.member'], 'call_expression');
  if (callNode === null) return null;
  const receiverNode = groupedNodes['@reference.receiver'];
  if (receiverNode === undefined || !isLiteralReceiver(receiverNode)) return null;

  const out: Record<string, Capture> = {
    '@reference.call.free': syntheticCapture('@reference.call.free', callNode, callNode.text),
    '@reference.name': syntheticCapture('@reference.name', callNode, name.text),
  };
  if (grouped['@reference.arity'] !== undefined)
    out['@reference.arity'] = grouped['@reference.arity'];
  if (grouped['@reference.parameter-types'] !== undefined) {
    out['@reference.parameter-types'] = grouped['@reference.parameter-types'];
  }
  return out;
}

function isLiteralReceiver(node: SyntaxNode): boolean {
  return [
    'integer_literal',
    'long_literal',
    'real_literal',
    'string_literal',
    'line_string_literal',
    'multi_line_string_literal',
    'character_literal',
    'boolean_literal',
  ].includes(node.type);
}
